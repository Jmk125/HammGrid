const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { streamFile } = require('../lib/streamFile');
const { annotatePdfToResponse } = require('../lib/annotatePdf');

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

router.get('/:id/download', requireAuth, (req, res) => {
  const row = db.prepare(`SELECT sv.pdf_path, sv.sheet_id, s.sheet_number FROM sheet_versions sv JOIN sheets s ON s.id = sv.sheet_id WHERE sv.id = ?`).get(req.params.id);
  if (!row || !row.pdf_path) return res.status(404).end();
  const includePublished = req.query.published === '1';
  const includePersonal = req.query.personal === '1';
  const markups = [];
  if (includePublished || includePersonal) {
    const clauses = [];
    const args = [row.sheet_id];
    if (includePublished) clauses.push(`visibility = 'published'`);
    if (includePersonal) { clauses.push(`author_id = ?`); args.push(req.session.user.id); }
    const rows = db.prepare(`SELECT type, geometry, style FROM markups WHERE sheet_id = ? AND (${clauses.join(' OR ')}) ORDER BY created_at`).all(...args);
    markups.push(...rows.map((m) => ({ ...m, geometry: JSON.parse(m.geometry), style: JSON.parse(m.style || '{}') })));
  }
  annotatePdfToResponse(res, row.pdf_path, markups, `${row.sheet_number || 'sheet'}.pdf`);
});

router.get('/:id/overlay', requireAuth, serveFile('overlay_path', 'image/webp'));

module.exports = router;
