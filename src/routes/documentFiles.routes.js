const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { streamFile } = require('../lib/streamFile');

const router = express.Router();

router.get('/:id', requireAuth, (req, res) => {
  const document = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!document) return res.status(404).json({ error: 'Not found' });
  res.json({ document });
});

router.get('/:id/pdf', requireAuth, (req, res) => {
  const document = db.prepare('SELECT pdf_path FROM documents WHERE id = ?').get(req.params.id);
  if (!document || !document.pdf_path) return res.status(404).end();
  streamFile(res, document.pdf_path, 'application/pdf');
});

module.exports = router;
