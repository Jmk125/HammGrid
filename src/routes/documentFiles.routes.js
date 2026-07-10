const express = require('express');
const fs = require('fs');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { streamFile } = require('../lib/streamFile');

const router = express.Router();

router.get('/:id', requireAuth, (req, res) => {
  const document = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!document) return res.status(404).json({ error: 'Not found' });
  const versions = db
    .prepare(
      `SELECT dv.*, u.name AS uploaded_by_name FROM document_versions dv
       LEFT JOIN users u ON u.id = dv.uploaded_by
       WHERE dv.document_id = ?
       ORDER BY dv.created_at DESC, dv.id DESC`
    )
    .all(document.id);
  res.json({ document, versions });
});

router.get('/:id/pdf', requireAuth, (req, res) => {
  const row = db
    .prepare(
      `SELECT dv.pdf_path AS p FROM documents d
       JOIN document_versions dv ON dv.id = d.current_version_id
       WHERE d.id = ?`
    )
    .get(req.params.id);
  if (!row || !row.p) return res.status(404).end();
  streamFile(res, row.p, 'application/pdf');
});

router.patch('/:id', requireRole('admin', 'editor'), (req, res) => {
  const document = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!document) return res.status(404).json({ error: 'Not found' });

  const { name, folder_id } = req.body;
  if (folder_id !== undefined && folder_id !== null) {
    const folder = db
      .prepare('SELECT id FROM document_folders WHERE id = ? AND project_id = ?')
      .get(folder_id, document.project_id);
    if (!folder) return res.status(400).json({ error: 'folder_id not found in this project' });
  }

  db.prepare('UPDATE documents SET name = ?, folder_id = ? WHERE id = ?').run(
    name !== undefined && name.trim() ? name.trim() : document.name,
    folder_id !== undefined ? folder_id : document.folder_id,
    document.id
  );
  const updated = db.prepare('SELECT * FROM documents WHERE id = ?').get(document.id);
  res.json({ document: updated });
});

router.delete('/:id', requireRole('admin', 'editor'), (req, res) => {
  const document = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!document) return res.status(404).json({ error: 'Not found' });

  // Deleting a document that's still linked from markups no longer fails -
  // markups.linked_document_id ON DELETE SET NULL clears those links
  // automatically (the client warns about this beforehand instead).
  const paths = db.prepare('SELECT pdf_path FROM document_versions WHERE document_id = ?').all(document.id);
  db.prepare('DELETE FROM documents WHERE id = ?').run(document.id);
  for (const p of paths) {
    if (p.pdf_path) fs.rm(p.pdf_path, { force: true }, () => {});
  }
  res.json({ ok: true });
});

// Which sheets have a markup linking to this document, and how many -
// lets the user jump straight to a drawing from the document's own page,
// and lets the delete-confirmation warn with a real count beforehand.
router.get('/:id/links', requireAuth, (req, res) => {
  const document = db.prepare('SELECT id FROM documents WHERE id = ?').get(req.params.id);
  if (!document) return res.status(404).json({ error: 'Not found' });

  const sheets = db
    .prepare(
      `SELECT s.id, s.sheet_number, s.discipline, s.project_id, COUNT(m.id) AS markup_count
       FROM markups m
       JOIN sheets s ON s.id = m.sheet_id
       WHERE m.linked_document_id = ?
       GROUP BY s.id
       ORDER BY s.sheet_number`
    )
    .all(document.id);
  res.json({ sheets });
});

module.exports = router;
