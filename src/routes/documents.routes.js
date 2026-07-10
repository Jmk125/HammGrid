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

// ---------- Folders ----------
router.get('/folders', requireAuth, (req, res) => {
  const folders = db
    .prepare('SELECT * FROM document_folders WHERE project_id = ? ORDER BY name')
    .all(req.params.projectId);
  res.json({ folders });
});

router.post('/folders', requireRole('admin', 'editor'), (req, res) => {
  const { name, parent_folder_id } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  if (parent_folder_id) {
    const parent = db
      .prepare('SELECT id FROM document_folders WHERE id = ? AND project_id = ?')
      .get(parent_folder_id, req.params.projectId);
    if (!parent) return res.status(400).json({ error: 'parent_folder_id not found in this project' });
  }
  const result = db
    .prepare('INSERT INTO document_folders (project_id, parent_folder_id, name) VALUES (?, ?, ?)')
    .run(req.params.projectId, parent_folder_id || null, name.trim());
  const folder = db.prepare('SELECT * FROM document_folders WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ folder });
});

// ---------- Documents ----------
// Flat list (not folder-scoped) - a project's documents are few enough that
// fetching everything at once and navigating folders client-side is simpler
// than a lazy per-folder API, and it's what the markup link-picker needs
// anyway to resolve a linked_document_id to a display name regardless of
// which folder it lives in.
router.get('/', requireAuth, (req, res) => {
  const documents = db
    .prepare(
      `SELECT d.id, d.folder_id, d.name, d.created_at,
              dv.id AS current_version_id, dv.revision_name, dv.issue_date, dv.created_at AS version_created_at,
              (SELECT COUNT(DISTINCT m.sheet_id) FROM markups m WHERE m.linked_document_id = d.id) AS linked_sheet_count
       FROM documents d
       LEFT JOIN document_versions dv ON dv.id = d.current_version_id
       WHERE d.project_id = ?
       ORDER BY d.name`
    )
    .all(req.params.projectId);
  res.json({ documents });
});

router.post('/', requireRole('admin', 'editor'), upload.single('file'), (req, res) => {
  const { name, folder_id, issue_date } = req.body;
  if (!req.file) return res.status(400).json({ error: 'A PDF file is required' });
  if (!name || !name.trim()) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'name is required' });
  }
  if (folder_id) {
    const folder = db
      .prepare('SELECT id FROM document_folders WHERE id = ? AND project_id = ?')
      .get(folder_id, req.params.projectId);
    if (!folder) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'folder_id not found in this project' });
    }
  }

  const insertTxn = db.transaction(() => {
    const docResult = db
      .prepare('INSERT INTO documents (project_id, folder_id, name) VALUES (?, ?, ?)')
      .run(req.params.projectId, folder_id || null, name.trim());
    const versionResult = db
      .prepare('INSERT INTO document_versions (document_id, issue_date, pdf_path, uploaded_by) VALUES (?, ?, ?, ?)')
      .run(docResult.lastInsertRowid, issue_date || null, toPortablePath(req.file.path), req.session.user.id);
    db.prepare('UPDATE documents SET current_version_id = ? WHERE id = ?').run(
      versionResult.lastInsertRowid,
      docResult.lastInsertRowid
    );
    return docResult.lastInsertRowid;
  });

  const document = db.prepare('SELECT * FROM documents WHERE id = ?').get(insertTxn());
  res.status(201).json({ document });
});

// Issue a revision - keeps every past version reachable (document_versions),
// only current_version_id moves, same pattern as sheets/sheet_versions.
router.post('/:id/versions', requireRole('admin', 'editor'), upload.single('file'), (req, res) => {
  const document = db
    .prepare('SELECT * FROM documents WHERE id = ? AND project_id = ?')
    .get(req.params.id, req.params.projectId);
  if (!document) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(404).json({ error: 'Not found' });
  }
  if (!req.file) return res.status(400).json({ error: 'A PDF file is required' });

  const { revision_name, issue_date } = req.body;
  const versionResult = db
    .prepare(
      `INSERT INTO document_versions (document_id, revision_name, issue_date, pdf_path, uploaded_by)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(document.id, revision_name || null, issue_date || null, toPortablePath(req.file.path), req.session.user.id);
  db.prepare('UPDATE documents SET current_version_id = ? WHERE id = ?').run(versionResult.lastInsertRowid, document.id);

  const updated = db.prepare('SELECT * FROM documents WHERE id = ?').get(document.id);
  res.status(201).json({ document: updated });
});

module.exports = router;
