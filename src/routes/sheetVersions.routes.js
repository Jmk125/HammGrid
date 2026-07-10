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

router.get('/:id/overlay', requireAuth, serveFile('overlay_path', 'image/webp'));

module.exports = router;
