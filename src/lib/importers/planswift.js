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
function convert({ jobDir, outDir, onProgress, signal }) {
  return runPythonWithProgress(CONVERT_SCRIPT, ['--json', jobDir, '-o', outDir], onProgress || (() => {}), {
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
      .prepare('INSERT INTO projects (name, number, discipline_prefix_map) VALUES (?, ?, ?)')
      .run(projectName, projectNumber, JSON.stringify(prefixMap)).lastInsertRowid;

    const revisionId = db
      .prepare(
        `INSERT INTO revisions (project_id, title, source, date, status, created_by, published_at)
         VALUES (?, ?, ?, date('now'), 'published', ?, datetime('now'))`
      )
      .run(projectId, 'PlanSwift import', `PlanSwift job ${job.name || ''}`.trim(), user.id).lastInsertRowid;

    // ---- sheets
    const hgSheetId = new Map(); // planswift page guid -> sheets.id
    const insSheet = db.prepare(
      'INSERT INTO sheets (project_id, sheet_number, discipline, scale_feet_per_inch) VALUES (?, ?, ?, ?)'
    );
    const insVersion = db.prepare(
      `INSERT INTO sheet_versions (sheet_id, revision_id, title, pdf_path, thumb_path, preview_path, extraction_status)
       VALUES (?, ?, ?, ?, ?, ?, 'planswift_import')`
    );
    for (const s of sheets) {
      const fpi = s.scale && s.scale.feet_per_inch ? s.scale.feet_per_inch : null;
      const sheetId = insSheet.run(projectId, s.sheet_number, deriveDiscipline(s.sheet_number, prefixMap), fpi)
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
    const pathOf = (item) => {
      const chain = [];
      let p = item.parent_id ? itemById.get(item.parent_id) : null;
      while (p) {
        chain.unshift(p.name);
        if (!p.parent_id) { chain.unshift(...(p.folder || [])); break; }
        p = itemById.get(p.parent_id);
      }
      return item.parent_id ? chain : item.folder || [];
    };

    // ---- items + instances
    const insItem = db.prepare(
      `INSERT INTO take_off_items (project_id, name, type, shape, color, properties, folder_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insInst = db.prepare(
      `INSERT INTO take_off_instances (item_id, sheet_id, geometry, quantity, perimeter, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const item of pkg.takeoff_items) {
      const shapes = (item.shapes || []).filter((sh) => KIND_TO_TYPE[sh.kind] && sh.points_pt && sh.points_pt.length);
      if (!shapes.length) continue;
      const kinds = [...new Set(shapes.map((sh) => sh.kind))];
      if (kinds.length > 1) warnings.push(`"${item.name}" mixes ${kinds.join('/')} shapes; imported as ${kinds[0]}`);
      const type = KIND_TO_TYPE[kinds[0]];
      const itemId = insItem
        .run(
          projectId,
          item.name || 'PlanSwift item',
          type,
          type === 'count' ? 'circle' : null,
          item.color || '#2563eb',
          JSON.stringify(item.numeric_properties || []),
          folderFor(pathOf(item)),
          user.id
        ).lastInsertRowid;
      stats.items++;

      for (const sh of shapes) {
        if (sh.kind !== kinds[0]) { stats.skippedShapes++; continue; }
        const sheet = sheetByGuid.get(String(sh.sheet_id || '').toUpperCase());
        const sheetId = sheet && hgSheetId.get(String(sheet.id).toUpperCase());
        const fpi = sheet && sheet.scale && sheet.scale.feet_per_inch;
        if (!sheetId) { warnings.push(`"${item.name}" shape on a missing sheet - skipped`); stats.skippedShapes++; continue; }
        if (!fpi && type !== 'count') {
          warnings.push(`"${item.name}" on unscaled sheet ${sheet.sheet_number} - skipped`);
          stats.skippedShapes++;
          continue;
        }
        const k = renderScaleFor(sheet);
        const toPx = ([x, y]) => ({ x: x * k, y: y * k });
        if (type === 'count') {
          // HammGrid stores one instance (quantity 1) per counted click.
          for (const p of sh.points_pt) {
            insInst.run(itemId, sheetId, JSON.stringify({ points: [toPx(p)] }), 1, null, user.id);
            stats.instances++;
          }
        } else if (type === 'area') {
          if (sh.points_pt.length < 3) { stats.skippedShapes++; continue; }
          // Cutouts (PlanSwift Subtract Sections) -> geometry.holes, same
          // shape sheet.js writes; net area = outer - holes (netAreaFeet),
          // perimeter = outer boundary only (polygonPerimeterFeet).
          const holes = (sh.holes_pt || []).filter((h) => h && h.length >= 3);
          const qty = Math.max(0, areaFeet(sh.points_pt, fpi) - holes.reduce((t, h) => t + areaFeet(h, fpi), 0));
          const perim = lengthFeet(sh.points_pt, fpi, true);
          const geometry = { points: sh.points_pt.map(toPx) };
          if (holes.length) { geometry.holes = holes.map((h) => h.map(toPx)); stats.cutouts += holes.length; }
          insInst.run(itemId, sheetId, JSON.stringify(geometry), qty, perim, user.id);
          stats.instances++;
        } else {
          if (sh.points_pt.length < 2) { stats.skippedShapes++; continue; }
          const qty = lengthFeet(sh.points_pt, fpi, false);
          insInst.run(itemId, sheetId, JSON.stringify({ points: sh.points_pt.map(toPx) }), qty, null, user.id);
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
};
