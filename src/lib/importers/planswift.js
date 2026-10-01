// PlanSwift importer: browse PlanSwift local-storage jobs under
// config.planswiftJobsDir, convert one with pyproc/planswift2hammgrid.py into
// a package folder, and import that package as a brand-new HammGrid project.
// Every PlanSwift page becomes a sheet (named from the PlanSwift page name, so
// no OCR/matching step), page scales become sheets.scale_feet_per_inch, and
// PlanSwift take-off items/shapes become take_off_items/take_off_instances
// with the same geometry. See docs/planswift-import.md for the format notes.
//
// Used by routes/imports.routes.js (New project -> Import from PlanSwift) and
// by the CLI, src/scripts/import-planswift.js.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const db = require('../../db');
const config = require('../../config');
const { toPortablePath } = require('../paths');
const { deriveDiscipline } = require('../matching');
const { runPythonWithProgress } = require('../pyRunner');
const { getSetting, setSetting } = require('../appSettings');

const CONVERT_SCRIPT = path.join(__dirname, '..', '..', '..', 'pyproc', 'planswift2hammgrid.py');
// Every page's TIFF is re-encoded into PDF + thumb + preview; a real
// 146-sheet job took ~8 minutes on the Windows box, so leave lots of room.
const CONVERT_TIMEOUT_MS = 60 * 60 * 1000;

// Must match public/js/sheet.js: take-off geometry is stored in the pixel
// space of the viewer's final render, which is PDF points * currentRenderScale
// where currentRenderScale = min(RENDER_SCALE, MAX_RENDER_PX / longestPt).
// If those constants ever change in sheet.js, change them here too.
const RENDER_SCALE = 2.5;
const MAX_RENDER_PX = 6000;

// Same defaults as routes/projects.routes.js (not exported there).
const DEFAULT_DISCIPLINE_MAP = {
  A: 'Architectural', S: 'Structural', C: 'Civil', P: 'Plumbing', M: 'Mechanical',
  H: 'Mechanical', E: 'Electrical', T: 'Technology', FP: 'Fire Protection', L: 'Landscaping',
};
const FORMAT_ID = 'hammgrid-planswift-import';
const PACKAGE_JSON = 'hammgrid-import.json';

// ---------------------------------------------------------------- browse

// The folder the job browser opens in: one saved from the import page
// (app_settings), else .env's PLANSWIFT_JOBS_DIR. Admins can also type any
// other folder on the import page for a one-off job stored elsewhere.
const DEFAULT_ROOT_SETTING = 'planswift_jobs_dir';

function defaultRoot() {
  const saved = getSetting(DEFAULT_ROOT_SETTING);
  if (saved) return { path: saved, from: 'app' };
  if (config.planswiftJobsDir) return { path: config.planswiftJobsDir, from: 'env' };
  return null;
}

// A typed folder must be an absolute path (drive or UNC) to an existing
// folder the server can see - a path on the admin's own PC won't be.
function checkFolder(dir) {
  // Explorer's "Copy as path" wraps the path in quotes.
  const d = String(dir || '').trim().replace(/^"(.*)"$/, '$1').trim();
  const fail = (msg) => Object.assign(new Error(msg), { status: 400 });
  if (!d) throw fail('Enter a folder path');
  if (!path.isAbsolute(d)) throw fail('Enter a full path, e.g. \\\\server\\share\\Jobs or D:\\PlanSwift\\Jobs');
  let stat;
  try {
    stat = fs.statSync(d);
  } catch (err) {
    throw fail(`The server can't reach ${d} (${err.code || err.message}). Check the path and that the server has access to it.`);
  }
  if (!stat.isDirectory()) throw fail(`${d} is not a folder`);
  return d;
}

// Saving an empty value clears the app setting, so .env applies again.
function setDefaultRoot(dir, userId) {
  setSetting(DEFAULT_ROOT_SETTING, dir ? checkFolder(dir) : null, userId);
  return defaultRoot();
}

// root = a folder typed on the import page, or empty for the default.
function resolveRoot(root) {
  if (root) return path.resolve(checkFolder(root));
  const def = defaultRoot();
  if (!def) throw Object.assign(new Error('No PlanSwift jobs folder is set - enter one'), { status: 400 });
  return path.resolve(def.path);
}

// Resolves a client-supplied path (relative to the root) and refuses
// anything that would land outside the root (.., absolute paths, other
// drives/shares). Returns { abs, rel } with rel in forward slashes.
function resolveInRoot(root, relPath) {
  const rootAbs = resolveRoot(root);
  const abs = path.resolve(rootAbs, relPath || '.');
  const rel = path.relative(rootAbs, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw Object.assign(new Error('Path is outside the PlanSwift jobs folder'), { status: 400 });
  }
  return { abs, rel: rel.split(path.sep).join('/'), root: rootAbs };
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function xmlText(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return XML_ENTITIES[e] ?? m;
  });
}

// Reads just the head of a folder's Data.xml (the job's own properties come
// first; the file can be large on some nodes and this runs once per folder
// over a network share). Returns null when there's no Data.xml.
function readJobInfo(dir) {
  let fd;
  try {
    fd = fs.openSync(path.join(dir, 'Data.xml'), 'r');
  } catch (err) {
    return null;
  }
  try {
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const xml = buf.toString('utf8', 0, n);
    const prop = (name) => {
      const m = new RegExp(`<Property\\b[^>]*\\bName="${name}"[^>]*?(?:/>|>([^<]*)<)`).exec(xml);
      return m && m[1] ? xmlText(m[1]).trim() : null;
    };
    const itemName = /<Item\b[^>]*\bName="([^"]*)"/.exec(xml);
    return {
      isJob: (prop('Type') || '').toLowerCase() === 'job',
      name: prop('Name') || (itemName ? xmlText(itemName[1]) : path.basename(dir)),
      description: prop('Description'),
    };
  } finally {
    fs.closeSync(fd);
  }
}

// One level of the jobs tree: job folders (Data.xml Type=Job) can be picked;
// other folders can be browsed into (jobs are sometimes grouped by year etc.).
// If the folder itself is a job (someone typed a job's own folder),
// current_job says so and it can be picked directly.
function browse(root, relPath) {
  const { abs, rel, root: rootAbs } = resolveInRoot(root, relPath);
  const self = readJobInfo(abs);
  let dirents;
  try {
    dirents = fs.readdirSync(abs, { withFileTypes: true });
  } catch (err) {
    throw Object.assign(new Error(`Can't read ${rel || 'the PlanSwift jobs folder'}: ${err.code || err.message}`), {
      status: err.code === 'ENOENT' ? 404 : 500,
    });
  }
  const entries = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const childAbs = path.join(abs, d.name);
    const info = readJobInfo(childAbs);
    let modified = null;
    try {
      modified = fs.statSync(childAbs).mtime.toISOString();
    } catch (err) {
      // unreadable folder - still list it, it'll just fail if opened
    }
    entries.push({
      name: d.name,
      path: rel ? `${rel}/${d.name}` : d.name,
      kind: info && info.isJob ? 'job' : 'folder',
      job_name: info && info.isJob ? info.name : null,
      description: info && info.isJob ? info.description : null,
      modified,
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return {
    root: rootAbs,
    path: rel,
    parent: rel ? rel.split('/').slice(0, -1).join('/') : null,
    current_job: self && self.isJob ? { path: rel, name: self.name, description: self.description } : null,
    // A job folder's own subfolders (Pages, Takeoff, ...) aren't worth browsing.
    entries: self && self.isJob ? [] : entries,
  };
}

// Validates a picked job; throws (400) unless it's a real job under the root.
function resolveJob(root, relPath) {
  const { abs, rel } = resolveInRoot(root, relPath);
  const info = readJobInfo(abs);
  if (!info || !info.isJob) {
    throw Object.assign(new Error('Not a PlanSwift job folder'), { status: 400 });
  }
  return { abs, rel, name: info.name, description: info.description };
}

// ---------------------------------------------------------------- convert

// Runs the converter into outDir. Returns the converter's summary JSON.
// Aborting signal kills the converter (cancel).
function convert({ jobDir, outDir, onProgress, signal, images }) {
  const args = ['--json', jobDir, '-o', outDir, ...(images ? ['--images', images] : [])];
  return runPythonWithProgress(CONVERT_SCRIPT, args, onProgress || (() => {}), {
    timeout: CONVERT_TIMEOUT_MS,
    signal,
  });
}

// The package JSON runs to several MB on a big job and the review table asks
// for every sheet's thumbnail, so keep the last one parsed rather than
// re-reading it per request. Callers must not mutate the result.
let lastPackage = { key: null, pkg: null };

function readPackage(pkgDir) {
  const jsonPath = path.join(pkgDir, PACKAGE_JSON);
  let stat;
  try {
    stat = fs.statSync(jsonPath);
  } catch (err) {
    throw new Error(`No ${PACKAGE_JSON} in ${pkgDir}`);
  }
  const key = `${path.resolve(jsonPath)}|${stat.mtimeMs}`;
  if (lastPackage.key === key) return lastPackage.pkg;
  const pkg = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  if (pkg.format !== FORMAT_ID) throw new Error(`Not a ${FORMAT_ID} package (format=${pkg.format})`);
  if (pkg.version > 1) throw new Error(`Package version ${pkg.version} is newer than this importer understands`);
  lastPackage = { key, pkg };
  return pkg;
}

// "5713 Bryden DD" + "Beachwood Bryden DD" -> number 5713, name "Beachwood
// Bryden DD". Falls back to the job name when there's no description.
function defaultNameAndNumber(job) {
  const m = /^(\d{3,})\b[\s\-_]*(.*)$/.exec((job.name || '').trim());
  const number = m ? m[1] : null;
  const name = (job.description || '').trim() || (m && m[2]) || job.name || 'PlanSwift import';
  return { name, number };
}

// Everything the review screen shows. Counts come from a dry-run import so
// they're exactly what Import will create (instances per counted point,
// shapes skipped on unscaled sheets, ...).
function review(pkgDir, userId) {
  const pkg = readPackage(pkgDir);
  const dry = importPackage({ pkgDir, userId, dryRun: true });
  return {
    job: pkg.job || {},
    defaults: defaultNameAndNumber(pkg.job || {}),
    sheets: pkg.sheets.map((s) => ({
      key: String(s.id),
      sheet_number: s.sheet_number,
      title: s.title || s.name,
      folder: (s.folder || []).join(' / ') || null,
      scaled: !!(s.scale && s.scale.feet_per_inch),
      scale_label: s.scale ? s.scale.label : null,
      has_pdf: !!(s.files && s.files.pdf),
      has_thumb: !!(s.files && s.files.thumb),
    })),
    stats: dry.stats,
    warnings: dry.warnings,
  };
}

// Path of a sheet's thumbnail inside the package, for the review table.
function sheetThumbPath(pkgDir, key) {
  const pkg = readPackage(pkgDir);
  const s = pkg.sheets.find((x) => String(x.id) === key);
  return s && s.files && s.files.thumb ? path.join(pkgDir, s.files.thumb) : null;
}

// ---------------------------------------------------------------- import

function renderScaleFor(sheet) {
  const longest = Math.max(sheet.width_pt, sheet.height_pt);
  return Math.min(RENDER_SCALE, MAX_RENDER_PX / longest);
}

// Same math as sheet.js polylineLengthFeet / polygonAreaFeet, done in PDF
// points (render scale cancels out): feet = pt / 72 * feetPerInch.
function lengthFeet(ptsPt, fpi, closed) {
  const seq = closed && ptsPt.length > 2 ? [...ptsPt, ptsPt[0]] : ptsPt;
  let total = 0;
  for (let i = 1; i < seq.length; i++) total += Math.hypot(seq[i][0] - seq[i - 1][0], seq[i][1] - seq[i - 1][1]);
  return (total / 72) * fpi;
}
function areaFeet(ptsPt, fpi) {
  let a2 = 0;
  for (let i = 0; i < ptsPt.length; i++) {
    const [x1, y1] = ptsPt[i];
    const [x2, y2] = ptsPt[(i + 1) % ptsPt.length];
    a2 += x1 * y2 - x2 * y1;
  }
  const k = fpi / 72;
  return (Math.abs(a2) / 2) * k * k;
}

const KIND_TO_TYPE = { area: 'area', linear: 'linear', count: 'count' };

const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const upper = (s) => String(s || '').toUpperCase();

// Fingerprint of one stored instance row. Recorded when import/refresh writes
// a row and compared later: a mismatch means somebody edited it in HammGrid.
const localHash = (sheetId, geometry, quantity, perimeter) =>
  sha(`${sheetId}|${geometry}|${quantity}|${perimeter == null ? '' : perimeter}`);

// The shapes of an item that can become instances: the first drawable kind's
// shapes only (a mixed item is imported as its first kind, as before).
function planItem(item) {
  const shapes = (item.shapes || []).filter((sh) => KIND_TO_TYPE[sh.kind] && sh.points_pt && sh.points_pt.length);
  if (!shapes.length) return null;
  const kinds = [...new Set(shapes.map((sh) => sh.kind))];
  return { type: KIND_TO_TYPE[kinds[0]], kind: kinds[0], mixed: kinds.length > 1 ? kinds : null, shapes };
}

// What an item looks like in HammGrid, plus a hash of it so a refresh can tell
// whether the PlanSwift side changed since the last import/refresh.
function itemFields(item, type, itemById) {
  const chain = [];
  let p = item.parent_id ? itemById.get(item.parent_id) : null;
  while (p) {
    chain.unshift(p.name);
    if (!p.parent_id) { chain.unshift(...(p.folder || [])); break; }
    p = itemById.get(p.parent_id);
  }
  const folderNames = item.parent_id ? chain : item.folder || [];
  const fields = {
    name: item.name || 'PlanSwift item',
    color: item.color || '#2563eb',
    properties: JSON.stringify(item.numeric_properties || []),
    folderNames,
  };
  return { ...fields, type, hash: sha(JSON.stringify([fields, type])) };
}

// One PlanSwift shape -> the instance rows HammGrid stores for it (a count
// shape becomes one row per point). Returns { rows, cutouts, hash } or
// { skip, warn } (warn = worth telling the user, not just a degenerate shape).
function shapeToRows(type, sh, sheet, hgSheetId) {
  if (!sheet || !hgSheetId) return { skip: 'a missing sheet', warn: true };
  const fpi = sheet.scale && sheet.scale.feet_per_inch;
  if (!fpi && type !== 'count') return { skip: `unscaled sheet ${sheet.sheet_number}`, warn: true };
  const k = renderScaleFor(sheet);
  const toPx = ([x, y]) => ({ x: x * k, y: y * k });
  const rows = [];
  let cutouts = 0;
  if (type === 'count') {
    // HammGrid stores one instance (quantity 1) per counted click.
    for (const p of sh.points_pt) rows.push({ geometry: JSON.stringify({ points: [toPx(p)] }), quantity: 1, perimeter: null });
  } else if (type === 'area') {
    if (sh.points_pt.length < 3) return { skip: 'a degenerate shape', warn: false };
    // Cutouts (PlanSwift Subtract Sections) -> geometry.holes, same shape
    // sheet.js writes; net area = outer - holes (netAreaFeet), perimeter =
    // outer boundary only (polygonPerimeterFeet).
    const holes = (sh.holes_pt || []).filter((h) => h && h.length >= 3);
    const quantity = Math.max(0, areaFeet(sh.points_pt, fpi) - holes.reduce((t, h) => t + areaFeet(h, fpi), 0));
    const geometry = { points: sh.points_pt.map(toPx) };
    if (holes.length) { geometry.holes = holes.map((h) => h.map(toPx)); cutouts = holes.length; }
    rows.push({ geometry: JSON.stringify(geometry), quantity, perimeter: lengthFeet(sh.points_pt, fpi, true) });
  } else {
    if (sh.points_pt.length < 2) return { skip: 'a degenerate shape', warn: false };
    rows.push({ geometry: JSON.stringify({ points: sh.points_pt.map(toPx) }), quantity: lengthFeet(sh.points_pt, fpi, false), perimeter: null });
  }
  return { rows, cutouts, sheetId: hgSheetId, hash: sha(JSON.stringify([hgSheetId, rows])) };
}

// Imports a converted package as a new, published project. Everything is
// inserted in one transaction (same end state as upload -> review ->
// publish); copied files are removed again if it fails. dryRun runs the whole
// thing and rolls back, copying nothing - used for the review counts.
// Returns { projectId, projectName, stats, warnings } (projectId null on a
// dry run). warnings includes the converter's own, prefixed "converter:".
function importPackage({ pkgDir, name, number, userId, dryRun = false }) {
  pkgDir = path.resolve(pkgDir);
  const pkg = readPackage(pkgDir);

  const user = db.prepare('SELECT id, name FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error(`No user with id ${userId}`);

  const job = pkg.job || {};
  const projectName = (name && String(name).trim()) || [job.name, job.description].filter(Boolean).join(' - ') || 'PlanSwift import';
  const projectNumber = (number && String(number).trim()) || null;
  const warnings = [];

  // Only sheets with a real PDF can become HammGrid sheets.
  const sheets = pkg.sheets.filter((s) => {
    const ok = s.files && s.files.pdf && fs.existsSync(path.join(pkgDir, s.files.pdf));
    if (!ok) warnings.push(`sheet "${s.sheet_number}" has no PDF in the package - skipped`);
    return ok && s.width_pt && s.height_pt;
  });
  const sheetByGuid = new Map(sheets.map((s) => [String(s.id).toUpperCase(), s]));

  const copied = []; // for cleanup if the transaction fails
  const copy = (src, destDir, fileName) => {
    const dest = toPortablePath(path.join(destDir, fileName));
    if (!dryRun) {
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(path.join(pkgDir, src), dest);
      copied.push(dest);
    }
    return dest;
  };

  const stats = { sheets: 0, scaled: 0, folders: 0, items: 0, instances: 0, cutouts: 0, skippedShapes: 0 };
  let projectId = null;

  const run = db.transaction(() => {
    const prefixMap = DEFAULT_DISCIPLINE_MAP;
    projectId = db
      .prepare(
        `INSERT INTO projects (name, number, discipline_prefix_map, external_source, external_path, external_synced_at)
         VALUES (?, ?, ?, 'planswift', ?, datetime('now'))`
      )
      .run(projectName, projectNumber, JSON.stringify(prefixMap), job.source_folder || null).lastInsertRowid;

    const revisionId = db
      .prepare(
        `INSERT INTO revisions (project_id, title, source, date, status, created_by, published_at)
         VALUES (?, ?, ?, date('now'), 'published', ?, datetime('now'))`
      )
      .run(projectId, 'PlanSwift import', `PlanSwift job ${job.name || ''}`.trim(), user.id).lastInsertRowid;

    // ---- sheets
    const hgSheetId = new Map(); // planswift page guid -> sheets.id
    const insSheet = db.prepare(
      'INSERT INTO sheets (project_id, sheet_number, discipline, scale_feet_per_inch, external_id, external_scale) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const insVersion = db.prepare(
      `INSERT INTO sheet_versions (sheet_id, revision_id, title, pdf_path, thumb_path, preview_path, extraction_status)
       VALUES (?, ?, ?, ?, ?, ?, 'planswift_import')`
    );
    for (const s of sheets) {
      const fpi = s.scale && s.scale.feet_per_inch ? s.scale.feet_per_inch : null;
      const sheetId = insSheet.run(projectId, s.sheet_number, deriveDiscipline(s.sheet_number, prefixMap), fpi, upper(s.id), fpi)
        .lastInsertRowid;
      const destDir = path.join(config.storageDir, 'projects', String(projectId), 'sheets', String(sheetId));
      const base = `v${revisionId}_planswift`;
      const pdf = copy(s.files.pdf, destDir, `${base}.pdf`);
      const thumb = s.files.thumb ? copy(s.files.thumb, destDir, `${base}_thumb.webp`) : null;
      const preview = s.files.preview ? copy(s.files.preview, destDir, `${base}_preview.webp`) : null;
      const versionId = insVersion.run(sheetId, revisionId, s.title || s.name, pdf, thumb, preview).lastInsertRowid;
      db.prepare('UPDATE sheets SET current_version_id = ? WHERE id = ?').run(versionId, sheetId);
      hgSheetId.set(String(s.id).toUpperCase(), sheetId);
      stats.sheets++;
      if (fpi) stats.scaled++;
    }

    // ---- take-off folders (PlanSwift folder path; nested items get a folder named after their parent)
    const folderCache = new Map();
    const insFolder = db.prepare(
      'INSERT INTO take_off_folders (project_id, name, parent_folder_id, created_by) VALUES (?, ?, ?, ?)'
    );
    const folderFor = (names) => {
      let parent = null;
      let key = '';
      for (const folderName of names) {
        key += `/${folderName}`;
        if (!folderCache.has(key)) {
          folderCache.set(key, insFolder.run(projectId, folderName, parent, user.id).lastInsertRowid);
          stats.folders++;
        }
        parent = folderCache.get(key);
      }
      return parent;
    };
    const itemById = new Map(pkg.takeoff_items.map((i) => [i.id, i]));

    // ---- items + instances
    const insItem = db.prepare(
      `INSERT INTO take_off_items (project_id, name, type, shape, color, properties, folder_id, created_by, external_id, external_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insInst = db.prepare(
      `INSERT INTO take_off_instances (item_id, sheet_id, geometry, quantity, perimeter, created_by, external_id, external_hash, local_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const item of pkg.takeoff_items) {
      const plan = planItem(item);
      if (!plan) continue;
      if (plan.mixed) warnings.push(`"${item.name}" mixes ${plan.mixed.join('/')} shapes; imported as ${plan.kind}`);
      const f = itemFields(item, plan.type, itemById);
      const itemId = insItem
        .run(projectId, f.name, plan.type, plan.type === 'count' ? 'circle' : null, f.color, f.properties,
          folderFor(f.folderNames), user.id, item.id, f.hash)
        .lastInsertRowid;
      stats.items++;

      for (const sh of plan.shapes) {
        if (sh.kind !== plan.kind) { stats.skippedShapes++; continue; }
        const sheet = sheetByGuid.get(upper(sh.sheet_id));
        const res = shapeToRows(plan.type, sh, sheet, sheet && hgSheetId.get(upper(sheet.id)));
        if (res.skip) {
          if (res.warn) warnings.push(`"${item.name}" shape on ${res.skip} - skipped`);
          stats.skippedShapes++;
          continue;
        }
        stats.cutouts += res.cutouts;
        for (const r of res.rows) {
          insInst.run(itemId, res.sheetId, r.geometry, r.quantity, r.perimeter, user.id, sh.id, res.hash,
            localHash(res.sheetId, r.geometry, r.quantity, r.perimeter));
          stats.instances++;
        }
      }
    }

    db.prepare('INSERT INTO activity_log (project_id, actor, action, detail) VALUES (?, ?, ?, ?)').run(
      projectId,
      String(user.id),
      'planswift_import',
      JSON.stringify({ source: job.source_folder || null, job: job.name || null, ...stats })
    );

    if (dryRun) throw Object.assign(new Error('dry run'), { dryRun: true });
  });

  try {
    run();
  } catch (err) {
    for (const f of copied) fs.rmSync(f, { force: true });
    if (projectId && !dryRun) {
      fs.rmSync(path.join(config.storageDir, 'projects', String(projectId)), { recursive: true, force: true });
    }
    if (!err.dryRun) throw err;
  }

  return {
    projectId: dryRun ? null : projectId,
    projectName,
    stats,
    warnings: [...(pkg.warnings || []).map((w) => `converter: ${w}`), ...warnings],
  };
}

// ---------------------------------------------------------------- refresh

// The PlanSwift job a project was imported from: projects.external_path, or
// (projects imported before links were recorded) the source path in the
// import's activity_log row. Returns null for projects not from PlanSwift.
function linkInfo(projectId) {
  const project = db.prepare('SELECT id, external_source, external_path, external_synced_at FROM projects WHERE id = ?').get(projectId);
  if (!project) return null;
  let sourcePath = project.external_source === 'planswift' ? project.external_path : null;
  let imported = project.external_source === 'planswift';
  if (!sourcePath) {
    const row = db
      .prepare("SELECT detail FROM activity_log WHERE project_id = ? AND action = 'planswift_import' ORDER BY id LIMIT 1")
      .get(projectId);
    if (row) {
      imported = true;
      try { sourcePath = JSON.parse(row.detail).source || null; } catch (err) { /* unreadable detail */ }
    }
  }
  if (!imported) return null;
  const linked = !!db.prepare('SELECT 1 FROM sheets WHERE project_id = ? AND external_id IS NOT NULL LIMIT 1').get(projectId);
  return { sourcePath, synced_at: project.external_synced_at, linked };
}

// Resolves the project's stored job path to the job folder (the converter
// input), or throws a user-facing 400/404. Uses the job's own parent folder as
// the root, so it works wherever the job lives - not only under the current
// default jobs folder (which an admin can change, and imports can be from a
// typed one-off folder).
function resolveLinkedJob(projectId) {
  const info = linkInfo(projectId);
  if (!info) throw Object.assign(new Error('This project was not imported from PlanSwift'), { status: 400 });
  if (!info.sourcePath) throw Object.assign(new Error('The PlanSwift job path for this project is unknown'), { status: 400 });
  const abs = path.resolve(info.sourcePath);
  if (!fs.existsSync(abs)) {
    throw Object.assign(new Error(`The PlanSwift job folder no longer exists: ${info.sourcePath}`), { status: 404 });
  }
  return resolveJob(path.dirname(abs), path.basename(abs));
}

// Re-reads a freshly converted package and brings the linked project in line
// with it. PlanSwift is the source of truth for things that came from it
// (matched by PlanSwift GUID); anything created in HammGrid is left alone, and
// a linked shape someone has edited in HammGrid is kept (reported as a
// conflict) instead of overwritten. Never deletes sheets or items.
//
// Projects imported before links were recorded are linked on the first run:
// sheets by sheet number, items by name + folder, shapes by identical geometry.
//
// apply=false runs everything and rolls back, so the preview is exactly what
// Apply will do. Returns { plan, warnings }.
function refreshPackage({ pkgDir, projectId, userId, apply = false }) {
  pkgDir = path.resolve(pkgDir);
  const pkg = readPackage(pkgDir);
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error(`No user with id ${userId}`);

  const warnings = [];
  const plan = {
    sheets: { linked: 0, newPages: [], missing: [], scaleChanged: 0 },
    items: { added: 0, updated: 0, linked: 0 },
    shapes: { added: 0, changed: 0, removed: 0, unchanged: 0, linked: 0, keptLocal: [], conflicts: [], skipped: 0 },
    instances: { added: 0, removed: 0 },
  };
  const srcSheets = pkg.sheets.filter((s) => s.width_pt && s.height_pt);
  const sheetByGuid = new Map(srcSheets.map((s) => [upper(s.id), s]));

  const run = db.transaction(() => {
    // ---- sheets: match by GUID, else (first refresh) by sheet number
    const hgSheets = db.prepare('SELECT id, sheet_number, scale_feet_per_inch, external_id, external_scale FROM sheets WHERE project_id = ?').all(projectId);
    const byExternal = new Map(hgSheets.filter((s) => s.external_id).map((s) => [upper(s.external_id), s]));
    const byNumber = new Map(hgSheets.filter((s) => !s.external_id).map((s) => [upper(s.sheet_number), s]));
    const hgSheetId = new Map(); // planswift page guid -> sheets.id
    const updSheet = db.prepare('UPDATE sheets SET external_id = ?, external_scale = ?, scale_feet_per_inch = ? WHERE id = ?');
    for (const s of srcSheets) {
      const guid = upper(s.id);
      let hg = byExternal.get(guid);
      let isNewLink = false;
      if (!hg) {
        hg = byNumber.get(upper(s.sheet_number));
        if (hg) { byNumber.delete(upper(s.sheet_number)); isNewLink = true; }
      }
      if (!hg) { plan.sheets.newPages.push(s.sheet_number); continue; }
      hgSheetId.set(guid, hg.id);
      const fpi = s.scale && s.scale.feet_per_inch ? s.scale.feet_per_inch : null;
      // Take the PlanSwift scale only when it changed there since the last
      // sync (or, first link, when HammGrid has none) - a scale corrected in
      // HammGrid isn't clobbered.
      const sourceChanged = hg.external_scale == null
        ? hg.scale_feet_per_inch == null && fpi != null
        : Math.abs((hg.external_scale || 0) - (fpi || 0)) > 1e-9;
      const scale = sourceChanged ? fpi : hg.scale_feet_per_inch;
      if (sourceChanged && !isNewLink) plan.sheets.scaleChanged++;
      if (isNewLink) plan.sheets.linked++;
      updSheet.run(guid, fpi, scale, hg.id);
    }
    const seen = new Set(srcSheets.map((s) => upper(s.id)));
    for (const hg of hgSheets) if (hg.external_id && !seen.has(upper(hg.external_id))) plan.sheets.missing.push(hg.sheet_number);

    // ---- folders (find-or-create by name path)
    const folders = db.prepare('SELECT id, name, parent_folder_id FROM take_off_folders WHERE project_id = ?').all(projectId);
    const insFolder = db.prepare('INSERT INTO take_off_folders (project_id, name, parent_folder_id, created_by) VALUES (?, ?, ?, ?)');
    const folderFor = (names) => {
      let parent = null;
      for (const n of names) {
        let f = folders.find((x) => x.name === n && (x.parent_folder_id || null) === parent);
        if (!f) {
          f = { id: insFolder.run(projectId, n, parent, user.id).lastInsertRowid, name: n, parent_folder_id: parent };
          folders.push(f);
        }
        parent = f.id;
      }
      return parent;
    };
    const folderPath = (id) => {
      const out = [];
      for (let f = folders.find((x) => x.id === id); f; f = folders.find((x) => x.id === f.parent_folder_id)) out.unshift(f.name);
      return out.join('/');
    };

    // ---- items: GUID, else (first refresh) name + type + folder
    const hgItems = db.prepare('SELECT * FROM take_off_items WHERE project_id = ? ORDER BY id').all(projectId);
    const itemByExternal = new Map(hgItems.filter((i) => i.external_id).map((i) => [upper(i.external_id), i]));
    const legacyItems = hgItems.filter((i) => !i.external_id);
    const hgInstances = db
      .prepare('SELECT inst.* FROM take_off_instances inst JOIN take_off_items ti ON ti.id = inst.item_id WHERE ti.project_id = ? ORDER BY inst.id')
      .all(projectId);
    const groups = new Map(); // shape guid -> instance rows
    const unlinkedByItem = new Map(); // item id -> instance rows with no link yet
    for (const r of hgInstances) {
      if (r.external_id) {
        const k = upper(r.external_id);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      } else {
        if (!unlinkedByItem.has(r.item_id)) unlinkedByItem.set(r.item_id, []);
        unlinkedByItem.get(r.item_id).push(r);
      }
    }
    const isEdited = (rows) => rows.some((r) => r.local_hash !== localHash(r.sheet_id, r.geometry, r.quantity, r.perimeter));

    const insItem = db.prepare(
      `INSERT INTO take_off_items (project_id, name, type, shape, color, properties, folder_id, created_by, external_id, external_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const updItem = db.prepare('UPDATE take_off_items SET name = ?, color = ?, properties = ?, folder_id = ?, external_hash = ? WHERE id = ?');
    const linkItem = db.prepare('UPDATE take_off_items SET external_id = ?, external_hash = ? WHERE id = ?');
    const insInst = db.prepare(
      `INSERT INTO take_off_instances (item_id, sheet_id, geometry, quantity, perimeter, created_by, external_id, external_hash, local_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const linkInst = db.prepare('UPDATE take_off_instances SET external_id = ?, external_hash = ?, local_hash = ? WHERE id = ?');
    const delInst = db.prepare('DELETE FROM take_off_instances WHERE id = ?');
    const unlinkInst = db.prepare('UPDATE take_off_instances SET external_id = NULL WHERE id = ?');

    const itemById = new Map(pkg.takeoff_items.map((i) => [i.id, i]));
    const sourceShapeIds = new Set(); // every PlanSwift shape that still exists, drawable or not
    for (const item of pkg.takeoff_items) for (const sh of item.shapes || []) sourceShapeIds.add(upper(sh.id));
    const sheetName = (id) => (hgSheets.find((s) => s.id === id) || {}).sheet_number || `#${id}`;

    for (const item of pkg.takeoff_items) {
      const ip = planItem(item);
      if (!ip) continue;
      const f = itemFields(item, ip.type, itemById);

      let hg = itemByExternal.get(upper(item.id));
      if (!hg) {
        const key = `${f.name}|${ip.type}|${f.folderNames.join('/')}`;
        const i = legacyItems.findIndex((x) => `${x.name}|${x.type}|${folderPath(x.folder_id)}` === key);
        if (i >= 0) {
          hg = legacyItems.splice(i, 1)[0];
          linkItem.run(item.id, f.hash, hg.id); // first link: record, don't overwrite
          plan.items.linked++;
        }
      } else if (hg.external_hash !== f.hash) {
        updItem.run(f.name, f.color, f.properties, folderFor(f.folderNames), f.hash, hg.id);
        plan.items.updated++;
      }
      if (!hg) {
        const id = insItem.run(projectId, f.name, ip.type, ip.type === 'count' ? 'circle' : null, f.color, f.properties,
          folderFor(f.folderNames), user.id, item.id, f.hash).lastInsertRowid;
        hg = { id };
        plan.items.added++;
      }

      for (const sh of ip.shapes) {
        if (sh.kind !== ip.kind) { plan.shapes.skipped++; continue; }
        const sheet = sheetByGuid.get(upper(sh.sheet_id));
        const sid = sheet && hgSheetId.get(upper(sheet.id));
        if (sheet && !sid) { plan.shapes.skipped++; continue; } // on a page not in this project yet
        const res = shapeToRows(ip.type, sh, sheet, sid);
        if (res.skip) {
          plan.shapes.skipped++;
          if (res.warn) warnings.push(`"${f.name}" shape on ${res.skip} - skipped`);
          continue;
        }
        const guid = upper(sh.id);
        const group = groups.get(guid);
        const add = () => {
          for (const r of res.rows) {
            insInst.run(hg.id, res.sheetId, r.geometry, r.quantity, r.perimeter, user.id, sh.id, res.hash,
              localHash(res.sheetId, r.geometry, r.quantity, r.perimeter));
          }
          plan.instances.added += res.rows.length;
        };
        if (!group) {
          // Not linked yet: the first refresh of an older import claims the
          // identical rows already there; otherwise it's a new shape.
          const pool = unlinkedByItem.get(hg.id) || [];
          const claimed = res.rows.map((r) => pool.find((p) => p.sheet_id === res.sheetId && p.geometry === r.geometry));
          if (res.rows.length && claimed.every(Boolean) && new Set(claimed).size === claimed.length) {
            for (const row of claimed) {
              pool.splice(pool.indexOf(row), 1);
              linkInst.run(sh.id, res.hash, localHash(res.sheetId, row.geometry, row.quantity, row.perimeter), row.id);
            }
            plan.shapes.linked++;
          } else {
            add();
            plan.shapes.added++;
          }
          continue;
        }
        if (group[0].external_hash === res.hash) { plan.shapes.unchanged++; continue; }
        if (isEdited(group)) {
          plan.shapes.conflicts.push({ item: f.name, sheet: sheetName(group[0].sheet_id) });
          continue;
        }
        for (const r of group) delInst.run(r.id);
        plan.instances.removed += group.length;
        add();
        plan.shapes.changed++;
      }
    }

    // ---- shapes deleted in PlanSwift
    for (const [guid, rows] of groups) {
      if (sourceShapeIds.has(guid)) continue;
      if (isEdited(rows)) {
        for (const r of rows) unlinkInst.run(r.id); // keep the edited copy as a HammGrid-owned shape
        plan.shapes.keptLocal.push({ sheet: sheetName(rows[0].sheet_id) });
      } else {
        for (const r of rows) delInst.run(r.id);
        plan.instances.removed += rows.length;
        plan.shapes.removed++;
      }
    }

    db.prepare("UPDATE projects SET external_source = 'planswift', external_synced_at = datetime('now') WHERE id = ?").run(projectId);
    db.prepare('INSERT INTO activity_log (project_id, actor, action, detail) VALUES (?, ?, ?, ?)').run(
      projectId, String(user.id), 'planswift_refresh',
      JSON.stringify({ job: (pkg.job || {}).name || null, sheets: plan.sheets, items: plan.items, shapes: plan.shapes, instances: plan.instances })
    );
    if (!apply) throw Object.assign(new Error('preview'), { preview: true });
  });

  try {
    run();
  } catch (err) {
    if (!err.preview) throw err;
  }
  return { plan, warnings: [...(pkg.warnings || []).map((w) => `converter: ${w}`), ...warnings] };
}

module.exports = {
  id: 'planswift',
  label: 'PlanSwift',
  defaultRoot,
  setDefaultRoot,
  browse,
  resolveJob,
  convert,
  review,
  sheetThumbPath,
  importPackage,
  linkInfo,
  resolveLinkedJob,
  refreshPackage,
};
