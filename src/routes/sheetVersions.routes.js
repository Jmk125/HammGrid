const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { streamFile } = require('../lib/streamFile');
const { annotatePdfToResponse } = require('../lib/annotatePdf');
const { getMarkupsForDownload } = require('../lib/markupSelection');

const router = express.Router();

function serveFile(pathColumn, contentType) {
  return (req, res) => {
    const row = db.prepare(`SELECT ${pathColumn} AS p FROM sheet_versions WHERE id = ?`).get(req.params.id);
    if (!row || !row.p) return res.status(404).end();
    // A published sheet_version's files never change in place - a new
    // revision always writes a new file (v<revisionId>.*), never overwrites
    // an existing one - so these are safe to cache hard. Repeat views of the
    // same sheet (going back to it, re-opening after a version switch) then
    // load from disk instead of re-fetching over the network. `private` (not
    // `public`) since this still requires auth per CLAUDE.md's access model.
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    streamFile(res, row.p, contentType);
  };
}

router.get('/:id/thumb', requireAuth, serveFile('thumb_path', 'image/webp'));
router.get('/:id/preview', requireAuth, serveFile('preview_path', 'image/webp'));
router.get('/:id/pdf', requireAuth, serveFile('pdf_path', 'application/pdf'));

router.get('/:id/download', requireAuth, async (req, res) => {
  const row = db.prepare(`SELECT sv.pdf_path, sv.sheet_id, s.sheet_number FROM sheet_versions sv JOIN sheets s ON s.id = sv.sheet_id WHERE sv.id = ?`).get(req.params.id);
  if (!row || !row.pdf_path) return res.status(404).end();
  const markups = getMarkupsForDownload(row.sheet_id, {
    includePublished: req.query.published === '1',
    includePersonal: req.query.personal === '1',
    userId: req.session.user.id,
  });
  try {
    await annotatePdfToResponse(res, row.pdf_path, markups, `${row.sheet_number || 'sheet'}.pdf`);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to prepare download' });
  }
});

// Same download as above, but as a POST with a JSON body - used only when
// the sheet pane's take-off legend toggle is on (see sheet.js's
// openDownloadPicker/buildTakeoffExportPayload). Take-off geometry for a
// sheet with a lot of instances can easily exceed a URL's length limit, so
// that path can't just add more query params the way published/personal do.
router.post('/:id/download', requireAuth, async (req, res) => {
  const row = db.prepare(`SELECT sv.pdf_path, sv.sheet_id, s.sheet_number FROM sheet_versions sv JOIN sheets s ON s.id = sv.sheet_id WHERE sv.id = ?`).get(req.params.id);
  if (!row || !row.pdf_path) return res.status(404).end();
  const markups = getMarkupsForDownload(row.sheet_id, {
    includePublished: !!req.body.published,
    includePersonal: !!req.body.personal,
    userId: req.session.user.id,
  });
  const takeoffs = Array.isArray(req.body.takeoffs) ? req.body.takeoffs : [];
  const legend = req.body.legend && typeof req.body.legend === 'object' ? req.body.legend : null;
  try {
    await annotatePdfToResponse(res, row.pdf_path, markups, `${row.sheet_number || 'sheet'}.pdf`, { takeoffs, legend });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to prepare download' });
  }
});

router.get('/:id/overlay', requireAuth, serveFile('overlay_path', 'image/webp'));

// ---------- Saved overlay alignment (see overlay_alignments in schema.sql) ----------

function versionSheetIds(idA, idB) {
  const rows = db.prepare('SELECT id, sheet_id FROM sheet_versions WHERE id IN (?, ?)').all(idA, idB);
  const map = new Map(rows.map((r) => [r.id, r.sheet_id]));
  if (!map.has(idA) || !map.has(idB)) return null;
  return map;
}

function cleanTransform(t) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const rotation = [0, 90, 180, 270].includes(Number(t && t.rotation)) ? Number(t.rotation) : 0;
  return { tx: num(t && t.tx), ty: num(t && t.ty), rotation };
}

// GET /api/sheet-versions/:id/alignment?with=<otherVersionId>
// -> { transforms: { [versionId]: {tx, ty, rotation} } | null, exact }
// Exact version-pair match first; for two DIFFERENT sheets, falls back to the
// newest alignment saved between those same two sheets (e.g. the floor plan
// was revised since the demo plan was last lined up against it), matching
// each layer by sheet rather than version.
router.get('/:id/alignment', requireAuth, (req, res) => {
  const idA = Number(req.params.id);
  const idB = Number(req.query.with);
  const sheetOf = versionSheetIds(idA, idB);
  if (!sheetOf) return res.status(404).json({ error: 'Version not found' });
  const [vLo, vHi] = idA < idB ? [idA, idB] : [idB, idA];

  let row = db.prepare('SELECT layers FROM overlay_alignments WHERE version_lo = ? AND version_hi = ?').get(vLo, vHi);
  let exact = !!row;
  const sA = sheetOf.get(idA);
  const sB = sheetOf.get(idB);
  if (!row && sA !== sB) {
    const [sLo, sHi] = sA < sB ? [sA, sB] : [sB, sA];
    row = db
      .prepare('SELECT layers FROM overlay_alignments WHERE sheet_lo = ? AND sheet_hi = ? ORDER BY updated_at DESC, id DESC LIMIT 1')
      .get(sLo, sHi);
  }
  if (!row) return res.json({ transforms: null, exact: false });

  const layers = JSON.parse(row.layers);
  const pick = (versionId, sheetId) =>
    cleanTransform(layers.find((l) => l.version_id === versionId) || (!exact && layers.find((l) => l.sheet_id === sheetId)));
  res.json({ transforms: { [idA]: pick(idA, sA), [idB]: pick(idB, sB) }, exact });
});

// PUT /api/sheet-versions/:id/alignment?with=<otherVersionId>
// body: { transforms: { [versionId]: {tx, ty, rotation} } }
router.put('/:id/alignment', requireAuth, (req, res) => {
  const idA = Number(req.params.id);
  const idB = Number(req.query.with);
  if (idA === idB) return res.status(400).json({ error: 'Need two different versions' });
  const sheetOf = versionSheetIds(idA, idB);
  if (!sheetOf) return res.status(404).json({ error: 'Version not found' });
  const transforms = (req.body && req.body.transforms) || {};
  const layers = [idA, idB].map((vid) => ({ version_id: vid, sheet_id: sheetOf.get(vid), ...cleanTransform(transforms[vid]) }));
  const [vLo, vHi] = idA < idB ? [idA, idB] : [idB, idA];
  const [sLo, sHi] = [sheetOf.get(vLo), sheetOf.get(vHi)];
  db.prepare(
    `INSERT INTO overlay_alignments (version_lo, version_hi, sheet_lo, sheet_hi, layers, updated_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (version_lo, version_hi) DO UPDATE SET
       layers = excluded.layers, updated_by = excluded.updated_by, updated_at = datetime('now')`
  ).run(vLo, vHi, Math.min(sLo, sHi), Math.max(sLo, sHi), JSON.stringify(layers), req.session.user.id);
  res.json({ ok: true });
});

module.exports = router;
