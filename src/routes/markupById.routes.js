const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.patch('/:id', requireAuth, (req, res) => {
  const markup = db.prepare('SELECT * FROM markups WHERE id = ?').get(req.params.id);
  if (!markup) return res.status(404).json({ error: 'Not found' });

  const user = req.session.user;
  const isAuthor = markup.author_id === user.id;
  const isAdmin = user.role === 'admin';
  const isEditor = user.role === 'editor';

  if (!isAuthor && !isAdmin && !isEditor) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { geometry, style, linked_document_id, visibility } = req.body;

  // Only the author or an admin can change the markup's actual content.
  if ((geometry !== undefined || style !== undefined || linked_document_id !== undefined) && !isAuthor && !isAdmin) {
    return res.status(403).json({ error: 'Only the author or an admin can edit this markup' });
  }

  if (visibility !== undefined) {
    if (!['private', 'published'].includes(visibility)) {
      return res.status(400).json({ error: 'visibility must be private or published' });
    }
    // Viewers can create private markups only, and can never publish - even their own.
    if (visibility === 'published' && user.role === 'viewer') {
      return res.status(403).json({ error: 'Viewers cannot publish markups' });
    }
  }

  db.prepare(
    `UPDATE markups SET
       geometry = ?,
       style = ?,
       linked_document_id = ?,
       visibility = ?,
       updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    geometry !== undefined ? JSON.stringify(geometry) : markup.geometry,
    style !== undefined ? JSON.stringify(style) : markup.style,
    linked_document_id !== undefined ? linked_document_id : markup.linked_document_id,
    visibility !== undefined ? visibility : markup.visibility,
    markup.id
  );

  const updated = db.prepare('SELECT * FROM markups WHERE id = ?').get(markup.id);
  res.json({ markup: { ...updated, geometry: JSON.parse(updated.geometry), style: JSON.parse(updated.style) } });
});

// Put several existing photos (documents) onto one photo pin at once. A
// pin's photos are all versions of a single document, so every selected
// document's versions MOVE into the pin's document and the emptied
// document is removed - the photos leave their old spot in Documents and
// live in the pin's document from then on. Same admin/editor rule as
// attaching a photo from the camera (documents.routes.js upload).
router.post('/:id/attach-documents', requireRole('admin', 'editor'), (req, res) => {
  const markup = db.prepare('SELECT * FROM markups WHERE id = ?').get(req.params.id);
  if (!markup) return res.status(404).json({ error: 'Not found' });
  if (markup.type !== 'photo') return res.status(400).json({ error: 'Only photo pins can hold several photos' });

  const projectRow = markup.sheet_id
    ? db.prepare('SELECT project_id FROM sheets WHERE id = ?').get(markup.sheet_id)
    : db.prepare('SELECT project_id FROM documents WHERE id = ?').get(markup.document_id);
  if (!projectRow) return res.status(404).json({ error: 'Not found' });

  const ids = [...new Set((Array.isArray(req.body.document_ids) ? req.body.document_ids : []).map(Number))].filter(
    (id) => Number.isInteger(id) && id !== markup.linked_document_id
  );
  if (!ids.length) return res.status(400).json({ error: 'No documents selected' });

  const docs = ids.map((id) => db.prepare('SELECT * FROM documents WHERE id = ? AND project_id = ?').get(id, projectRow.project_id));
  if (docs.some((d) => !d)) return res.status(400).json({ error: 'A selected document is not in this project' });
  // A document another markup links to (e.g. a different pin's photos, or
  // an RFI a cloud points at) can't be folded into this one without
  // breaking that other link.
  const linkedElsewhere = docs.find(
    (d) => db.prepare('SELECT 1 FROM markups WHERE linked_document_id = ? AND id != ?').get(d.id, markup.id)
  );
  if (linkedElsewhere) {
    return res.status(400).json({ error: `"${linkedElsewhere.name}" is already linked from another markup` });
  }

  db.transaction(() => {
    let targetId = markup.linked_document_id;
    let sources = docs;
    if (!targetId) {
      targetId = docs[0].id;
      sources = docs.slice(1);
    }
    for (const src of sources) {
      db.prepare('UPDATE document_versions SET document_id = ? WHERE document_id = ?').run(targetId, src.id);
      db.prepare('DELETE FROM documents WHERE id = ?').run(src.id);
    }
    const newest = db
      .prepare('SELECT id FROM document_versions WHERE document_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
      .get(targetId);
    db.prepare('UPDATE documents SET current_version_id = ? WHERE id = ?').run(newest ? newest.id : null, targetId);
    db.prepare("UPDATE markups SET linked_document_id = ?, updated_at = datetime('now') WHERE id = ?").run(targetId, markup.id);
  })();

  const updated = db.prepare('SELECT * FROM markups WHERE id = ?').get(markup.id);
  res.json({ markup: { ...updated, geometry: JSON.parse(updated.geometry), style: JSON.parse(updated.style) } });
});

router.delete('/:id', requireAuth, (req, res) => {
  const markup = db.prepare('SELECT * FROM markups WHERE id = ?').get(req.params.id);
  if (!markup) return res.status(404).json({ error: 'Not found' });

  const user = req.session.user;
  if (markup.author_id !== user.id && user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the author or an admin can delete this markup' });
  }

  db.prepare('DELETE FROM markups WHERE id = ?').run(markup.id);
  res.json({ ok: true });
});

module.exports = router;
