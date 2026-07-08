const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });
const TYPES = ['line', 'arrow', 'cloud', 'text', 'rect'];

router.get('/', requireAuth, (req, res) => {
  const markups = db
    .prepare(
      `SELECT m.*, u.name AS author_name FROM markups m
       JOIN users u ON u.id = m.author_id
       WHERE m.sheet_id = ? AND (m.visibility = 'published' OR m.author_id = ?)
       ORDER BY m.created_at`
    )
    .all(req.params.sheetId, req.session.user.id);
  res.json({
    markups: markups.map((m) => ({ ...m, geometry: JSON.parse(m.geometry), style: JSON.parse(m.style) })),
  });
});

router.post('/', requireAuth, (req, res) => {
  const { type, geometry, style, linked_document_id, visibility } = req.body;
  if (!TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${TYPES.join(', ')}` });
  }
  if (!geometry) {
    return res.status(400).json({ error: 'geometry is required' });
  }

  // Viewers can only ever create private markups (CLAUDE.md permissions table).
  const finalVisibility = req.session.user.role === 'viewer' ? 'private' : visibility === 'published' ? 'published' : 'private';

  const result = db
    .prepare(
      `INSERT INTO markups (sheet_id, author_id, visibility, type, geometry, style, linked_document_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.params.sheetId,
      req.session.user.id,
      finalVisibility,
      type,
      JSON.stringify(geometry),
      JSON.stringify(style || {}),
      linked_document_id || null
    );

  const markup = db.prepare('SELECT * FROM markups WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ markup: { ...markup, geometry: JSON.parse(markup.geometry), style: JSON.parse(markup.style) } });
});

module.exports = router;
