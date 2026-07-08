const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

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
