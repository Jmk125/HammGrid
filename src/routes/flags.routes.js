const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.get('/', requireAuth, (req, res) => {
  const flags = db
    .prepare(
      `SELECT m.*, s.sheet_number, s.discipline, u.name AS author_name
       FROM markups m
       JOIN sheets s ON s.id = m.sheet_id
       JOIN users u ON u.id = m.author_id
       WHERE m.type = 'flag' AND s.project_id = ? AND (m.visibility = 'published' OR m.author_id = ?)
       ORDER BY s.sheet_number, m.created_at`
    )
    .all(req.params.projectId, req.session.user.id);
  res.json({
    flags: flags.map((f) => ({ ...f, geometry: JSON.parse(f.geometry), style: JSON.parse(f.style) })),
  });
});

module.exports = router;
