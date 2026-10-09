// HammGrid -> PlanSwift: add the take-offs that exist only in HammGrid to the
// PlanSwift job a project is linked to (Project Settings -> "Send take-offs to
// PlanSwift"). This WRITES INTO THE LIVE JOB FOLDER, so it is deliberately narrow:
//
//  * It only ever CREATES new folders. It never edits or deletes anything PlanSwift
//    wrote. New items go under a "From HammGrid" folder; shapes for an item that
//    already exists in PlanSwift are added as new "Section" subfolders of it.
//  * Every new node is a clone of a real node of the same class from the same job
//    (the converter reports one per class as pkg.templates), with only name, GUIDs,
//    colour, ordering, timestamp, page and points changed - so it matches what
//    PlanSwift itself writes without us knowing its full property schema.
//  * Each file is written under a temporary name and renamed, so PlanSwift never
//    sees a half-written Data.xml.
//  * A JobLock.xml means PlanSwift may have the job open: a lock under an hour old
//    blocks the push, an older one (they are often left behind) needs an explicit
//    "PlanSwift is closed" confirmation.
//  * Everything created is recorded in data/planswift-push/<project>-<ts>.json, and
//    undo() removes exactly those folders again.
//
// Rows pushed get external_id = the new section's GUID and external_hash = PUSHED,
// which the next refresh adopts (see refreshPackage) instead of treating them as
// "changed in PlanSwift".
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = require('../../db');
const config = require('../../config');
const { readPackage, renderScaleFor, upper, localHash, PUSHED } = require('./planswift').helpers;

const HG_FOLDER = 'From HammGrid';
const MANIFEST_DIR = path.join(config.storageDir, 'planswift-push');
const RECENT_LOCK_MINUTES = 60;
// Stock PlanSwift nodes (one per class) used when the job has no node of a class to
// clone, e.g. a job with no take-offs yet. A node found in the job itself wins.
const BUNDLED_TEMPLATES_DIR = path.join(__dirname, 'planswift-templates');
const MAX_FOLDER_NAME = 20; // PlanSwift's own take-off folders are cut to 20 characters

// ---------------------------------------------------------------- small helpers

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const newGuid = () => `{${crypto.randomUUID().toUpperCase()}}`;
const num = (v) => String(Math.round(v * 1e6) / 1e6);

// PlanSwift's Time Stamp format, e.g. "2/8/2024 3:02:10 PM".
function psTimestamp(d = new Date()) {
  const h = d.getHours();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${h % 12 || 12}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${h >= 12 ? 'PM' : 'AM'}`;
}

// '#rrggbb' -> Delphi TColor (0x00BBGGRR) as a decimal string.
function tcolor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return '255';
  const n = parseInt(m[1], 16);
  return String(((n >> 16) & 0xff) | (n & 0xff00) | ((n & 0xff) << 16));
}

const escText = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (v) => escText(v).replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// Folder name for a new node: invalid characters dropped, cut to 20, made unique
// within parentDir (Area, Area1, Area2 ... like PlanSwift does).
function uniqueFolderName(parentDir, wanted) {
  const base = String(wanted || 'Item').replace(/[\\/:*?"<>|]/g, '').replace(/[\s.]+$/, '').trim().slice(0, MAX_FOLDER_NAME).trim() || 'Item';
  const taken = new Set(fs.readdirSync(parentDir).map((n) => n.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 1; ; i++) {
    const cand = `${base.slice(0, MAX_FOLDER_NAME - String(i).length)}${i}`;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
}

// ---------------------------------------------------------------- Data.xml patching (string level, so
// everything we do not touch stays byte-for-byte what PlanSwift wrote)

const ATTRS = String.raw`(?:[^>"']|"[^"]*"|'[^']*')`;
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function propRegex(name, flags = '') {
  return new RegExp(`(<Property\\b${ATTRS}*?\\bName="${reEsc(name)}"${ATTRS}*?)(?:/>|>[\\s\\S]*?</Property>)`, flags);
}

// Sets a property's text. Returns the new xml; throws if it isn't there and required.
function setProp(xml, name, value, { required = true, digitizer = false } = {}) {
  const m = propRegex(name).exec(xml);
  if (!m) {
    if (required) throw fail(`The PlanSwift template is missing the "${name}" property`, 500);
    return xml;
  }
  const text = digitizer ? escText(value).replace(/"/g, '&quot;') : escText(value);
  return xml.slice(0, m.index) + `${m[1]}>${text}</Property>` + xml.slice(m.index + m[0].length);
}

// Drops every property whose name matches (the per-page OrderIndex_{pageGUID} ones).
function removeProps(xml, namePattern) {
  const re = new RegExp(`[ \\t]*<Property\\b${ATTRS}*?\\bName="(${namePattern})"${ATTRS}*?(?:/>|>[\\s\\S]*?</Property>)[ \\t]*\\r?\\n?`, 'g');
  return xml.replace(re, '');
}

function setRootAttrs(xml, name, guid) {
  const m = /<Item\b[^>]*>/.exec(xml);
  if (!m) throw fail('The PlanSwift template is not an <Item>', 500);
  const tag = m[0].replace(/\bName="[^"]*"/, `Name="${escAttr(name)}"`).replace(/\bGUID="[^"]*"/, `GUID="${guid}"`);
  return xml.slice(0, m.index) + tag + xml.slice(m.index + m[0].length);
}

function pointsXml(points) {
  const pts = points.map((p) => `<Point X="${num(p.x)}" Y="${num(p.y)}" PointType="Normal"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Points>${pts}</Points>\n`;
}

// Cloned items must not inherit the template's descriptions or costs.
const BLANK_ON_ITEMS = ['Description', 'Item #', 'Cost Each', 'Markup %', 'Cost Code', 'Division', 'SubDivision', 'Phase', 'Location', 'Load', 'Zone'];

function itemXml(template, { name, guid, colorHex, orderIndex, shape }) {
  let xml = removeProps(template, String.raw`OrderIndex_\{[^"]*\}`);
  xml = setRootAttrs(xml, name, guid);
  xml = setProp(xml, 'Name', name);
  xml = setProp(xml, 'GUID', guid);
  xml = setProp(xml, 'Color', tcolor(colorHex), { required: false });
  xml = setProp(xml, 'OrderIndex', String(orderIndex), { required: false });
  xml = setProp(xml, 'Time Stamp', psTimestamp(), { required: false });
  xml = setProp(xml, 'Created By', 'HammGrid', { required: false });
  if (shape) xml = setProp(xml, 'Shape', shape, { required: false });
  for (const p of BLANK_ON_ITEMS) xml = setProp(xml, p, '', { required: false });
  return xml;
}

function folderXml(template, { name, guid, orderIndex }) {
  let xml = setRootAttrs(template, name, guid);
  xml = setProp(xml, 'Name', name);
  xml = setProp(xml, 'GUID', guid);
  xml = setProp(xml, 'OrderIndex', String(orderIndex), { required: false });
  return setProp(xml, 'Time Stamp', psTimestamp(), { required: false });
}

function sectionXml(template, { name, guid, pageGuid, points, orderIndex }) {
  let xml = setRootAttrs(template, name, guid);
  xml = setProp(xml, 'Name', name);
  xml = setProp(xml, 'GUID', guid);
  if (pageGuid) xml = setProp(xml, 'PageGUID', pageGuid);
  xml = setProp(xml, 'DigitizerData', pointsXml(points), { digitizer: true });
  xml = setProp(xml, 'Visible', 'True', { required: false });
  xml = setProp(xml, 'ZOrder', '0', { required: false });
  xml = setProp(xml, 'OrderIndex', String(orderIndex), { required: false });
  xml = setProp(xml, 'Time Stamp', psTimestamp(), { required: false });
  return setProp(xml, 'Created By', 'HammGrid', { required: false });
}

function readNodeGuid(dir) {
  try {
    const m = /<Item\b[^>]*\bGUID="([^"]*)"/.exec(fs.readFileSync(path.join(dir, 'Data.xml'), 'utf8').slice(0, 4096));
    return m ? m[1] : null;
  } catch (err) {
    return null;
  }
}

// Highest sibling OrderIndex under a folder (new items go last).
function maxOrderIndex(parentDir) {
  let max = -1;
  for (const d of fs.readdirSync(parentDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    try {
      const head = fs.readFileSync(path.join(parentDir, d.name, 'Data.xml'), 'utf8').slice(0, 200000);
      const m = /\bName="OrderIndex"[^>]*>(\d+)</.exec(head);
      if (m) max = Math.max(max, Number(m[1]));
    } catch (err) { /* not a node */ }
  }
  return max + 1;
}

const countSubdirs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).length;

// ---------------------------------------------------------------- lock

function readLock(jobDir) {
  const p = path.join(jobDir, 'JobLock.xml');
  let stat;
  try { stat = fs.statSync(p); } catch (err) { return null; }
  let xml = '';
  try { xml = fs.readFileSync(p, 'utf8'); } catch (err) { /* unreadable - still a lock */ }
  const attr = (n) => { const m = new RegExp(`${n}="([^"]*)"`).exec(xml); return m ? m[1] : null; };
  const ageMinutes = Math.max(0, Math.round((Date.now() - stat.mtimeMs) / 60000));
  return { locked_by: attr('locked_by'), timestamp: attr('timestamp'), age_minutes: ageMinutes, recent: ageMinutes < RECENT_LOCK_MINUTES };
}

function checkLock(jobDir, confirmClosed) {
  const lock = readLock(jobDir);
  if (!lock) return null;
  if (lock.recent) {
    throw fail(`PlanSwift looks like it has this job open (locked by ${lock.locked_by || 'someone'} ${lock.age_minutes} minute(s) ago). Close the job in PlanSwift and try again.`, 409);
  }
  if (!confirmClosed) {
    throw fail(`This job has a lock file (${lock.locked_by || 'unknown'}, ${lock.timestamp || 'unknown time'}). Confirm that PlanSwift is closed on this job to continue.`, 409);
  }
  return lock;
}

// ---------------------------------------------------------------- what would be sent

// The firm's PlanSwift convention: a PlanSwift "Linear" is a HammGrid perimeter and a
// PlanSwift "Segment" is a HammGrid linear.
const CLASS_TO_TYPE = { Area: 'area', Linear: 'perimeter', Segment: 'linear', Count: 'count' };
const TYPE_TO_CLASS = { area: 'Area', perimeter: 'Linear', linear: 'Segment', count: 'Count' };
const MIN_POINTS = { area: 3, perimeter: 2, linear: 2, count: 1 };

function bundledTemplates() {
  const out = {};
  for (const d of fs.readdirSync(BUNDLED_TEMPLATES_DIR, { withFileTypes: true })) {
    if (d.isDirectory()) out[d.name] = path.join(BUNDLED_TEMPLATES_DIR, d.name); // absolute: path.resolve(jobDir, abs) = abs
  }
  return out;
}

// Finds everything in the project that exists only in HammGrid (instances with no
// PlanSwift link) and works out where each piece would go. No files are touched.
// Returns { plan, work, jobDir }.
function collect({ pkgDir, projectId, jobDir }) {
  const pkg = readPackage(path.resolve(pkgDir));
  jobDir = path.resolve(jobDir || (pkg.job || {}).source_folder || '');
  if (!jobDir || !fs.existsSync(path.join(jobDir, 'Takeoff'))) throw fail('The PlanSwift job folder (Takeoff) was not found', 404);
  const templates = { ...bundledTemplates(), ...(pkg.templates || {}) };

  const pkgSheets = new Map(pkg.sheets.filter((s) => s.width_pt && s.height_pt && s.dpi).map((s) => [upper(s.id), s]));
  const hgSheets = new Map(db.prepare('SELECT id, sheet_number, external_id FROM sheets WHERE project_id = ?').all(projectId).map((s) => [s.id, s]));
  const pkgItems = new Map(pkg.takeoff_items.map((i) => [upper(i.id), i]));

  const rows = db
    .prepare(
      `SELECT inst.id, inst.item_id, inst.sheet_id, inst.geometry, inst.quantity, inst.perimeter,
              ti.name, ti.type, ti.color, ti.shape, ti.external_id AS item_external_id
         FROM take_off_instances inst JOIN take_off_items ti ON ti.id = inst.item_id
        WHERE ti.project_id = ? AND inst.external_id IS NULL
        ORDER BY inst.item_id, inst.sheet_id, inst.id`
    )
    .all(projectId);

  const skipped = new Map(); // reason -> instance count
  const skip = (reason, n = 1) => skipped.set(reason, (skipped.get(reason) || 0) + n);
  const problems = [];
  if (![...hgSheets.values()].some((s) => s.external_id)) {
    problems.push('No sheet in this project is linked to a PlanSwift page yet. Run "Check for changes" and apply it once under PlanSwift link first.');
  }

  // item -> { hg fields, target, shapes: [{ sheetId, pageGuid, kind, parts: [{ points, holes }], instances: [...] }] }
  const itemWork = new Map();
  const needTemplate = new Set();

  for (const r of rows) {
    const type = r.type;
    if (!TYPE_TO_CLASS[type]) { skip(`${type} take-offs are not supported`, 1); continue; }
    const sheet = hgSheets.get(r.sheet_id);
    const ps = sheet && sheet.external_id ? pkgSheets.get(upper(sheet.external_id)) : null;
    if (!ps) { skip('on a sheet that is not linked to a PlanSwift page', 1); continue; }

    let geom;
    try { geom = JSON.parse(r.geometry); } catch (err) { skip('unreadable geometry', 1); continue; }
    const k = renderScaleFor(ps);
    const toPs = (p) => ({ x: (p.x / k) * (ps.dpi / 72), y: (p.y / k) * (ps.dpi / 72) });
    const points = (geom.points || []).map(toPs);
    const holes = (geom.holes || []).map((h) => h.map(toPs)).filter((h) => h.length >= 3);
    if (points.length < MIN_POINTS[type] || points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) { skip('degenerate shape', 1); continue; }

    let w = itemWork.get(r.item_id);
    if (!w) {
      const pkgItem = r.item_external_id ? pkgItems.get(upper(r.item_external_id)) : null;
      let target = { kind: 'new', cls: TYPE_TO_CLASS[type] };
      if (pkgItem && fs.existsSync(path.join(jobDir, pkgItem.source_folder || '__none__'))) {
        const t = CLASS_TO_TYPE[pkgItem.class];
        target = { kind: 'existing', cls: pkgItem.class, rel: pkgItem.source_folder, type: t, guid: pkgItem.id };
      }
      w = { hgItemId: r.item_id, name: r.name, type, color: r.color, shape: r.shape, target, shapes: [] };
      itemWork.set(r.item_id, w);
    }
    if (w.target.kind === 'existing' && w.target.type !== type) { skip('item type differs from the PlanSwift item', 1); continue; }

    // Count points of one item on one sheet go into a single Count Section.
    let shp = type === 'count' ? w.shapes.find((s) => s.sheetId === r.sheet_id) : null;
    if (!shp) {
      shp = { sheetId: r.sheet_id, sheetNumber: sheet.sheet_number, pageGuid: ps.id, parts: [], instances: [] };
      w.shapes.push(shp);
    }
    shp.parts.push({ points, holes });
    shp.instances.push({ id: r.id, sheet_id: r.sheet_id, geometry: r.geometry, quantity: r.quantity, perimeter: r.perimeter });
  }

  // Templates: which classes the job must already contain.
  const work = [];
  let sections = 0;
  for (const w of itemWork.values()) {
    const sectionCls = `${w.target.cls} Section`;
    const needs = [sectionCls];
    if (w.target.kind === 'new') needs.push(w.target.cls);
    if (w.shapes.some((s) => s.parts.some((p) => p.holes.length))) needs.push('Area Subtract Section');
    const missing = needs.filter((c) => !templates[c]);
    if (missing.length) {
      const n = w.shapes.reduce((t, s) => t + s.instances.length, 0);
      skip(`no existing "${missing[0]}" in the PlanSwift job to copy from`, n);
      continue;
    }
    for (const c of needs) needTemplate.add(c);
    sections += w.shapes.length;
    work.push(w);
  }

  const hgFolderExists = fs.existsSync(path.join(jobDir, 'Takeoff', HG_FOLDER));
  if (work.some((w) => w.target.kind === 'new') && !hgFolderExists && !templates.Folder) {
    problems.push('The PlanSwift job has no Folder to copy from, so new items cannot be created.');
    for (let i = work.length - 1; i >= 0; i--) {
      if (work[i].target.kind === 'new') {
        skip('no folder template in the PlanSwift job', work[i].shapes.reduce((t, s) => t + s.instances.length, 0));
        sections -= work[i].shapes.length;
        work.splice(i, 1);
      }
    }
  }

  const lock = readLock(jobDir);
  const plan = {
    job: (pkg.job || {}).name || path.basename(jobDir),
    job_path: jobDir,
    lock,
    new_items: work.filter((w) => w.target.kind === 'new').length,
    existing_items: work.filter((w) => w.target.kind === 'existing').length,
    sections,
    shapes: work.reduce((t, w) => t + w.shapes.reduce((a, s) => a + s.parts.length, 0), 0),
    instances: work.reduce((t, w) => t + w.shapes.reduce((a, s) => a + s.instances.length, 0), 0),
    items: work.slice(0, 60).map((w) => ({
      name: w.name,
      type: w.type,
      target: w.target.kind,
      shapes: w.shapes.reduce((a, s) => a + s.parts.length, 0),
      sheets: [...new Set(w.shapes.map((s) => s.sheetNumber))].slice(0, 6),
    })),
    skipped: [...skipped].map(([reason, count]) => ({ reason, count })),
    problems,
  };
  return { plan, work, jobDir, templates };
}

function plan(opts) {
  return { plan: collect(opts).plan };
}

// ---------------------------------------------------------------- write

function manifestPath(projectId, id) {
  return path.join(MANIFEST_DIR, `${projectId}-${id}.json`);
}

function saveManifest(m) {
  fs.mkdirSync(MANIFEST_DIR, { recursive: true });
  fs.writeFileSync(manifestPath(m.project_id, m.id), JSON.stringify(m, null, 2));
}

function loadManifests(projectId) {
  let names = [];
  try { names = fs.readdirSync(MANIFEST_DIR); } catch (err) { return []; }
  return names
    .filter((n) => n.startsWith(`${projectId}-`) && n.endsWith('.json'))
    .map((n) => { try { return JSON.parse(fs.readFileSync(path.join(MANIFEST_DIR, n), 'utf8')); } catch (err) { return null; } })
    .filter(Boolean)
    .sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
}

function lastPush(projectId) {
  const all = loadManifests(projectId);
  const m = all[all.length - 1];
  if (!m) return null;
  return { id: m.id, at: m.started_at, status: m.status, sections: (m.links || []).length, items: (m.items || []).length };
}

// Creates one node folder (Data.xml written via a temp name, then renamed).
function createNode({ jobDir, templateRel, parentDir, wantedName, build, created, kind }) {
  const template = fs.readFileSync(path.resolve(jobDir, templateRel, 'Data.xml'), 'utf8');
  const name = uniqueFolderName(parentDir, wantedName);
  const dir = path.join(parentDir, name);
  fs.mkdirSync(dir); // not recursive: fails loudly if it somehow exists
  created.push({ path: dir, kind, guid: null });
  const guid = newGuid();
  const xml = build(template, { name, guid });
  const tmp = path.join(dir, 'Data.xml.hgtmp');
  fs.writeFileSync(tmp, xml, 'utf8');
  fs.renameSync(tmp, path.join(dir, 'Data.xml'));
  created[created.length - 1].guid = guid;
  return { dir, guid, name };
}

function apply({ pkgDir, projectId, userId, jobDir, confirmClosed }) {
  const { plan: p, work, jobDir: job, templates } = collect({ pkgDir, projectId, jobDir });
  if (p.problems.length && !work.length) throw fail(p.problems[0]);
  checkLock(job, confirmClosed);
  if (!work.length) return { plan: p, written: { items: 0, sections: 0 } };

  const manifest = {
    id: crypto.randomUUID(),
    project_id: projectId,
    user_id: userId,
    job_dir: job,
    started_at: new Date().toISOString(),
    status: 'in-progress',
    created: [],
    links: [], // { guid, instance_ids } - HammGrid rows linked to a new section
    items: [], // { hg_item_id, guid } - HammGrid items linked to a new PlanSwift item
  };
  saveManifest(manifest);
  const created = manifest.created;

  try {
    const takeoffDir = path.join(job, 'Takeoff');
    let hgFolderDir = path.join(takeoffDir, HG_FOLDER);
    if (work.some((w) => w.target.kind === 'new') && !fs.existsSync(hgFolderDir)) {
      const f = createNode({
        jobDir: job, templateRel: templates.Folder, parentDir: takeoffDir, wantedName: HG_FOLDER, created, kind: 'folder',
        build: (tpl, { name, guid }) => folderXml(tpl, { name, guid, orderIndex: maxOrderIndex(takeoffDir) }),
      });
      hgFolderDir = f.dir;
    }

    for (const w of work) {
      let itemDir;
      if (w.target.kind === 'new') {
        const item = createNode({
          jobDir: job, templateRel: templates[w.target.cls], parentDir: hgFolderDir, wantedName: w.name, created, kind: 'item',
          build: (tpl, { name, guid }) => itemXml(tpl, {
            name: w.name, guid, colorHex: w.color, orderIndex: maxOrderIndex(hgFolderDir),
            shape: w.type === 'count' ? { circle: 'Circle', square: 'Square', triangle: 'Triangle', diamond: 'Diamond' }[w.shape] || 'Circle' : null,
          }),
        });
        itemDir = item.dir;
        manifest.items.push({ hg_item_id: w.hgItemId, guid: item.guid });
      } else {
        itemDir = path.join(job, w.target.rel);
      }

      for (const shp of w.shapes) {
        const groupedCount = w.type === 'count';
        const parts = groupedCount ? [{ points: shp.parts.flatMap((x) => x.points), holes: [] }] : shp.parts;
        parts.forEach((part, i) => {
          const sec = createNode({
            jobDir: job, templateRel: templates[`${w.target.cls} Section`], parentDir: itemDir, wantedName: 'Section', created, kind: 'section',
            build: (tpl, { name, guid }) => sectionXml(tpl, { name, guid, pageGuid: shp.pageGuid, points: part.points, orderIndex: countSubdirs(itemDir) - 1 }),
          });
          for (const hole of part.holes) {
            createNode({
              jobDir: job, templateRel: templates['Area Subtract Section'], parentDir: sec.dir, wantedName: 'Subtract Section', created, kind: 'subtract',
              build: (tpl, { name, guid }) => sectionXml(tpl, { name, guid, pageGuid: null, points: hole, orderIndex: countSubdirs(sec.dir) - 1 }),
            });
          }
          const ids = groupedCount ? shp.instances.map((x) => x.id) : [shp.instances[i].id];
          manifest.links.push({ guid: sec.guid, instance_ids: ids });
        });
      }
      saveManifest(manifest);
    }
  } catch (err) {
    // Remove whatever this push created so far; PlanSwift data is untouched either way.
    for (let i = created.length - 1; i >= 0; i--) {
      try { fs.rmSync(created[i].path, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    }
    manifest.status = 'failed';
    manifest.error = err.message;
    saveManifest(manifest);
    throw err.status ? err : Object.assign(new Error(`Writing to PlanSwift failed and was rolled back: ${err.message}`), { status: 500 });
  }

  const byId = new Map();
  for (const w of work) for (const s of w.shapes) for (const inst of s.instances) byId.set(inst.id, inst);
  db.transaction(() => {
    const link = db.prepare('UPDATE take_off_instances SET external_id = ?, external_hash = ?, local_hash = ? WHERE id = ? AND external_id IS NULL');
    for (const l of manifest.links) {
      for (const id of l.instance_ids) {
        const r = byId.get(id);
        link.run(l.guid, PUSHED, localHash(r.sheet_id, r.geometry, r.quantity, r.perimeter), id);
      }
    }
    const linkItem = db.prepare('UPDATE take_off_items SET external_id = ?, external_hash = ? WHERE id = ? AND external_id IS NULL');
    for (const it of manifest.items) linkItem.run(it.guid, PUSHED, it.hg_item_id);
    db.prepare('INSERT INTO activity_log (project_id, actor, action, detail) VALUES (?, ?, ?, ?)').run(
      projectId, String(userId), 'planswift_push',
      JSON.stringify({ job: p.job, new_items: p.new_items, existing_items: p.existing_items, sections: p.sections, instances: p.instances, manifest: manifest.id })
    );
  })();
  manifest.status = 'applied';
  manifest.finished_at = new Date().toISOString();
  saveManifest(manifest);
  return { plan: p, written: { items: manifest.items.length, sections: manifest.links.length }, push_id: manifest.id };
}

// ---------------------------------------------------------------- undo

function undo({ projectId, userId, jobDir, confirmClosed }) {
  const manifest = loadManifests(projectId).reverse().find((m) => m.status === 'applied');
  if (!manifest) throw fail('There is no push to undo for this project', 404);
  const job = path.resolve(jobDir || manifest.job_dir);
  checkLock(job, confirmClosed);

  // Only remove folders we created, and only if they still hold exactly what we put there.
  const mine = new Set(manifest.created.map((c) => path.resolve(c.path)));
  for (const c of manifest.created) {
    if (!fs.existsSync(c.path)) continue;
    if (readNodeGuid(c.path) !== c.guid) throw fail(`${c.path} was changed since the push; not removing anything`, 409);
    for (const d of fs.readdirSync(c.path, { withFileTypes: true })) {
      if (d.isDirectory() && !mine.has(path.resolve(c.path, d.name)) && c.kind !== 'folder') {
        throw fail(`${path.join(c.path, d.name)} was added in PlanSwift after the push; not removing anything`, 409);
      }
    }
  }
  for (let i = manifest.created.length - 1; i >= 0; i--) {
    const c = manifest.created[i];
    if (!fs.existsSync(c.path)) continue;
    if (c.kind === 'folder') {
      // The shared "From HammGrid" folder goes only once nothing else is in it.
      const stillUsed = fs.readdirSync(c.path, { withFileTypes: true }).some((d) => d.isDirectory());
      if (!stillUsed) fs.rmSync(c.path, { recursive: true, force: true });
    } else {
      fs.rmSync(c.path, { recursive: true, force: true });
    }
  }

  db.transaction(() => {
    const clr = db.prepare('UPDATE take_off_instances SET external_id = NULL, external_hash = NULL, local_hash = NULL WHERE id = ? AND external_id = ?');
    for (const l of manifest.links) for (const id of l.instance_ids) clr.run(id, l.guid);
    const clrItem = db.prepare('UPDATE take_off_items SET external_id = NULL, external_hash = NULL WHERE id = ? AND external_id = ?');
    for (const it of manifest.items) clrItem.run(it.hg_item_id, it.guid);
    db.prepare('INSERT INTO activity_log (project_id, actor, action, detail) VALUES (?, ?, ?, ?)').run(
      projectId, String(userId), 'planswift_push_undo', JSON.stringify({ manifest: manifest.id, sections: manifest.links.length })
    );
  })();
  manifest.status = 'undone';
  manifest.undone_at = new Date().toISOString();
  saveManifest(manifest);
  return { undone: { items: manifest.items.length, sections: manifest.links.length } };
}

module.exports = { plan, apply, undo, lastPush, collect };
