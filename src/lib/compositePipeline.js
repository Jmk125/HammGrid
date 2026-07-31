const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { toPortablePath } = require('./paths');
const { runPython } = require('./pyRunner');
const { enqueue } = require('./queue');

const COMPOSE_SCRIPT = path.join(__dirname, '..', '..', 'pyproc', 'compose.py');
const FRAGMENT_THUMB_SCRIPT = path.join(__dirname, '..', '..', 'pyproc', 'fragment_thumb.py');

const COMPOSITE_REVISION_TITLE = 'Composite Drawings';

// Lazily creates (once per project, reused thereafter) the synthetic,
// already-published revision every composite sheet's versions attach to -
// satisfies sheet_versions.revision_id's NOT NULL FK without a special-cased
// nullable column. Composites never flow through the normal upload/OCR/
// publish cycle, so nothing else ever writes into this revision; it exists
// purely so the revision filter dropdown has a natural way to isolate
// composites in the grid.
function getOrCreateCompositeRevision(projectId, userId) {
  const existing = db
    .prepare(`SELECT id FROM revisions WHERE project_id = ? AND title = ?`)
    .get(projectId, COMPOSITE_REVISION_TITLE);
  if (existing) return existing.id;
  const result = db
    .prepare(
      `INSERT INTO revisions (project_id, title, status, created_by, published_at)
       VALUES (?, ?, 'published', ?, datetime('now'))`
    )
    .run(projectId, COMPOSITE_REVISION_TITLE, userId);
  return result.lastInsertRowid;
}

// Blank-canvas default (44in x 34in @ 72pt/in) until the first fragment
// lands, and the floor every content-derived size is clamped above.
const DEFAULT_CANVAS_WIDTH_PT = 3168;
const DEFAULT_CANVAS_HEIGHT_PT = 2448;
const CANVAS_MARGIN_PT = 36;

// Auto-fit-to-content canvas sizing, fixed origin (0,0) - recomputed fresh
// from the current fragment set every flatten. A fixed origin is what keeps
// already-placed take-off geometry numerically valid across regenerates
// (existing fragments never shift in canvas-point-space just because the
// bounding box changed) - the canvas's own outer size growing or shrinking
// around that fixed origin doesn't move anything, so there's no need to also
// pin the canvas size itself to "never shrink."
function computeCanvasSize(fragments) {
  let maxX = 0;
  let maxY = 0;
  for (const f of fragments) {
    // A rotated fragment's actual visual footprint is its rotated bounding
    // box, not its unrotated place rect - use that here too, or a fragment
    // rotated near the edge would get clipped by a canvas sized only to its
    // unrotated extents.
    const rad = ((f.rotation || 0) * Math.PI) / 180;
    const bw = Math.abs(f.place_width * Math.cos(rad)) + Math.abs(f.place_height * Math.sin(rad));
    const bh = Math.abs(f.place_width * Math.sin(rad)) + Math.abs(f.place_height * Math.cos(rad));
    const centerX = f.place_x + f.place_width / 2;
    const centerY = f.place_y + f.place_height / 2;
    maxX = Math.max(maxX, centerX + bw / 2);
    maxY = Math.max(maxY, centerY + bh / 2);
  }
  return {
    width_pt: Math.max(DEFAULT_CANVAS_WIDTH_PT, maxX + CANVAS_MARGIN_PT),
    height_pt: Math.max(DEFAULT_CANVAS_HEIGHT_PT, maxY + CANVAS_MARGIN_PT),
  };
}

// Builds compose.py's manifest from this composite's current fragment rows,
// joined to each fragment's own source sheet_version for its pdf_path.
function buildManifest(compositeSheetId) {
  const fragments = db
    .prepare(
      `SELECT cf.*, sv.pdf_path AS source_pdf_path
       FROM composite_fragments cf
       JOIN sheet_versions sv ON sv.id = cf.source_version_id
       WHERE cf.composite_sheet_id = ?
       ORDER BY cf.z_order ASC`
    )
    .all(compositeSheetId);

  const canvas = computeCanvasSize(fragments);
  return {
    canvas,
    fragments: fragments.map((f) => ({
      source_pdf_path: f.source_pdf_path,
      crop: { x: f.crop_x, y: f.crop_y, width: f.crop_width, height: f.crop_height },
      mask_polygons: JSON.parse(f.mask_polygons || '[]'),
      place: { x: f.place_x, y: f.place_y, width: f.place_width, height: f.place_height },
      rotation: f.rotation || 0,
      z_order: f.z_order,
      visible: !!f.visible,
    })),
  };
}

// Re-flattens a composite sheet's fragments into a fresh PDF/thumb/preview
// and publishes it as a brand-new sheet_versions row (never overwrites an
// existing one in place - sheetVersions.routes.js serves these files with an
// `immutable` Cache-Control on exactly that assumption). Called after every
// fragment create/update/delete, and once at composite creation with zero
// fragments (a blank canvas still needs a real PDF to exist, since
// sheet_versions.pdf_path is NOT NULL).
async function regenerateComposite(sheetId, userId) {
  const sheet = db.prepare('SELECT * FROM sheets WHERE id = ? AND is_composite = 1').get(sheetId);
  if (!sheet) throw new Error('Composite sheet not found');

  const manifest = buildManifest(sheetId);

  const destDir = path.join(config.storageDir, 'projects', String(sheet.project_id), 'sheets', String(sheetId));
  fs.mkdirSync(destDir, { recursive: true });
  // Suffixed with a fresh random id every regenerate (composites have no
  // version history to preserve, so there's no "vN" to key off of like a
  // real revision publish - just needs to never collide with the file this
  // same sheet's previous version is still serving until it's deleted below).
  const suffix = crypto.randomBytes(6).toString('hex');
  const destPdf = toPortablePath(path.join(destDir, `composite_${suffix}.pdf`));
  const destThumb = toPortablePath(path.join(destDir, `composite_${suffix}_thumb.webp`));
  const destPreview = toPortablePath(path.join(destDir, `composite_${suffix}_preview.webp`));

  const manifestPath = path.join(os.tmpdir(), `composite-manifest-${sheetId}-${suffix}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  try {
    await enqueue(() => runPython(COMPOSE_SCRIPT, [manifestPath, destPdf, destThumb, destPreview], { timeout: 60000 }));
  } finally {
    fs.rm(manifestPath, { force: true }, () => {});
  }

  const revisionId = getOrCreateCompositeRevision(sheet.project_id, userId);
  const previousVersion = sheet.current_version_id
    ? db.prepare('SELECT pdf_path, thumb_path, preview_path FROM sheet_versions WHERE id = ?').get(sheet.current_version_id)
    : null;

  const newVersionId = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO sheet_versions (sheet_id, revision_id, title, pdf_path, thumb_path, preview_path)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(sheetId, revisionId, sheet.sheet_number, destPdf, destThumb, destPreview);
    db.prepare('UPDATE sheets SET current_version_id = ? WHERE id = ?').run(result.lastInsertRowid, sheetId);
    if (previousVersion) {
      db.prepare('DELETE FROM sheet_versions WHERE id = ?').run(sheet.current_version_id);
    }
    return result.lastInsertRowid;
  })();

  if (previousVersion) {
    for (const p of [previousVersion.pdf_path, previousVersion.thumb_path, previousVersion.preview_path]) {
      if (p) fs.rm(p, { force: true }, () => {});
    }
  }

  return newVersionId;
}

// Renders a fragment's small palette thumbnail AND its full-res edit-preview
// (crop + mask applied, no placement/rotation) from one Python invocation -
// generated once at bring-in time or whenever the crop/mask is re-traced,
// never on every flatten, since both are keyed to the crop/mask alone
// (placement and rotation are applied on top, not baked into either asset).
async function generateFragmentAssets(projectId, fragmentId, sourcePdfPath, crop, maskPolygons) {
  const destDir = path.join(config.storageDir, 'projects', String(projectId), 'fragment-thumbs');
  fs.mkdirSync(destDir, { recursive: true });
  const destThumb = toPortablePath(path.join(destDir, `frag_${fragmentId}_thumb.webp`));
  const destPreview = toPortablePath(path.join(destDir, `frag_${fragmentId}_preview.webp`));
  await enqueue(() =>
    runPython(
      FRAGMENT_THUMB_SCRIPT,
      [sourcePdfPath, JSON.stringify(crop), JSON.stringify(maskPolygons || []), destThumb, destPreview],
      { timeout: 30000 }
    )
  );
  return { thumbPath: destThumb, previewPath: destPreview };
}

module.exports = {
  COMPOSITE_REVISION_TITLE,
  getOrCreateCompositeRevision,
  buildManifest,
  computeCanvasSize,
  regenerateComposite,
  generateFragmentAssets,
};
