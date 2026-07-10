const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { streamFile } = require('../lib/streamFile');

const router = express.Router();

// Lets a specific past revision stay reachable even after a newer one has
// become current_version_id - "still have access to the original".

router.get('/:id/download', requireAuth, (req, res) => {
  const row = db.prepare(`SELECT dv.pdf_path, d.name FROM document_versions dv JOIN documents d ON d.id = dv.document_id WHERE dv.id = ?`).get(req.params.id);
  if (!row || !row.pdf_path) return res.status(404).end();
  res.download(row.pdf_path, `${row.name || 'document'}.pdf`);
});

router.get('/:id/pdf', requireAuth, (req, res) => {
  const row = db.prepare('SELECT pdf_path FROM document_versions WHERE id = ?').get(req.params.id);
  if (!row || !row.pdf_path) return res.status(404).end();
  streamFile(res, row.pdf_path, 'application/pdf');
});

module.exports = router;
