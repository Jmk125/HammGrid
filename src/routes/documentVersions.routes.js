const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { streamFile } = require('../lib/streamFile');
const { mimeForPath } = require('../lib/documentFileTypes');
const { sendThumbOrOriginal, removeThumb } = require('../lib/documentThumbs');

const router = express.Router();

// Lets a specific past revision stay reachable even after a newer one has
// become current_version_id - "still have access to the original".

router.get('/:id/download', requireAuth, (req, res) => {
  const row = db.prepare(`SELECT dv.pdf_path, d.name FROM document_versions dv JOIN documents d ON d.id = dv.document_id WHERE dv.id = ?`).get(req.params.id);
  if (!row || !row.pdf_path) return res.status(404).end();
  res.download(row.pdf_path, `${row.name || 'document'}${path.extname(row.pdf_path)}`);
});

router.get('/:id/pdf', requireAuth, (req, res) => {
  const row = db.prepare('SELECT pdf_path FROM document_versions WHERE id = ?').get(req.params.id);
  if (!row || !row.pdf_path) return res.status(404).end();
  streamFile(res, row.pdf_path, mimeForPath(row.pdf_path));
});

router.get('/:id/thumb', requireAuth, (req, res) => {
  const row = db.prepare('SELECT pdf_path FROM document_versions WHERE id = ?').get(req.params.id);
  if (!row || !row.pdf_path) return res.status(404).end();
  sendThumbOrOriginal(res, row.pdf_path);
});

// A photo pin's photos are all versions of one document (see
// photoOutbox.js's uploadOne), so removing a single photo from a pin is a
// version-level operation, not a document one.
function loadVersion(id) {
  return db
    .prepare(
      `SELECT dv.*, d.project_id, d.folder_id, d.name AS document_name, d.current_version_id
       FROM document_versions dv JOIN documents d ON d.id = dv.document_id
       WHERE dv.id = ?`
    )
    .get(id);
}

// After a version leaves its document, current_version_id must point at
// whichever remaining version is newest (same ordering as GET /documents/:id).
function repointCurrentVersion(documentId) {
  const newest = db
    .prepare('SELECT id FROM document_versions WHERE document_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
    .get(documentId);
  db.prepare('UPDATE documents SET current_version_id = ? WHERE id = ?').run(newest ? newest.id : null, documentId);
}

// Delete one photo from the project entirely. If it was the document's last
// version the document goes too (linked markups are unlinked by
// ON DELETE SET NULL, so the pin turns back into an empty one).
router.delete('/:id', requireRole('admin', 'editor'), (req, res) => {
  const version = loadVersion(req.params.id);
  if (!version) return res.status(404).json({ error: 'Not found' });

  const remaining = db
    .prepare('SELECT COUNT(*) AS n FROM document_versions WHERE document_id = ? AND id != ?')
    .get(version.document_id, version.id).n;
  db.transaction(() => {
    if (remaining === 0) {
      // ON DELETE SET NULL clears the pin's link but not updated_at, which
      // other devices' delta sync (sync.routes.js) keys off.
      db.prepare("UPDATE markups SET updated_at = datetime('now') WHERE linked_document_id = ?").run(version.document_id);
      db.prepare('DELETE FROM documents WHERE id = ?').run(version.document_id);
    } else {
      db.prepare('DELETE FROM document_versions WHERE id = ?').run(version.id);
      repointCurrentVersion(version.document_id);
    }
  })();
  fs.rm(version.pdf_path, { force: true }, () => {});
  removeThumb(version.pdf_path);
  res.json({ ok: true, document_deleted: remaining === 0 });
});

// Take one photo off a pin but keep it in the project: it becomes its own
// standalone document in the same folder. When it's the pin's only photo
// the whole document already IS just that photo, so the pin (markup_id) is
// unlinked from it instead of moving anything.
router.post('/:id/detach', requireRole('admin', 'editor'), (req, res) => {
  const version = loadVersion(req.params.id);
  if (!version) return res.status(404).json({ error: 'Not found' });
  const { markup_id, name } = req.body || {};

  const remaining = db
    .prepare('SELECT COUNT(*) AS n FROM document_versions WHERE document_id = ? AND id != ?')
    .get(version.document_id, version.id).n;

  if (remaining === 0) {
    if (markup_id) {
      db.prepare("UPDATE markups SET linked_document_id = NULL, updated_at = datetime('now') WHERE id = ? AND linked_document_id = ?").run(
        markup_id,
        version.document_id
      );
    }
    return res.json({ document_id: version.document_id, pin_unlinked: true });
  }

  const newDocumentId = db.transaction(() => {
    const result = db
      .prepare('INSERT INTO documents (project_id, folder_id, name) VALUES (?, ?, ?)')
      .run(version.project_id, version.folder_id, (name && String(name).trim()) || version.document_name);
    db.prepare('UPDATE document_versions SET document_id = ? WHERE id = ?').run(result.lastInsertRowid, version.id);
    db.prepare('UPDATE documents SET current_version_id = ? WHERE id = ?').run(version.id, result.lastInsertRowid);
    repointCurrentVersion(version.document_id);
    return result.lastInsertRowid;
  })();
  res.json({ document_id: newDocumentId, pin_unlinked: false });
});

module.exports = router;
