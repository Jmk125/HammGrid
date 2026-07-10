const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../db');
const config = require('../config');
const { requireAuth, requireRole } = require('../middleware/auth');
const { toPortablePath } = require('../lib/paths');

const router = express.Router({ mergeParams: true });
const KINDS = ['rfi', 'submittal'];

const docsDir = path.join(config.storageDir, 'documents');
fs.mkdirSync(docsDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: docsDir,
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.pdf`),
  }),
  fileFilter: (req, file, cb) => cb(null, /\.pdf$/i.test(file.originalname)),
  limits: { fileSize: 200 * 1024 * 1024 },
});

router.get('/', requireAuth, (req, res) => {
  const documents = db
    .prepare('SELECT * FROM documents WHERE project_id = ? ORDER BY date DESC, created_at DESC')
    .all(req.params.projectId);
  res.json({ documents });
});

router.post('/', requireRole('admin', 'editor'), upload.single('file'), (req, res) => {
  const { kind, number, title, date, status } = req.body;
  if (!kind || !KINDS.includes(kind)) {
    return res.status(400).json({ error: `kind must be one of: ${KINDS.join(', ')}` });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'A PDF file is required' });
  }

  const result = db
    .prepare(
      `INSERT INTO documents (project_id, kind, number, title, date, status, pdf_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(req.params.projectId, kind, number || null, title || null, date || null, status || null, toPortablePath(req.file.path));

  const document = db.prepare('SELECT * FROM documents WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ document });
});

module.exports = router;
