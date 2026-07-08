const express = require('express');
const db = require('../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.get('/', requireRole('admin'), (req, res) => {
  const rows = db
    .prepare('SELECT * FROM activity_log WHERE project_id = ? ORDER BY created_at DESC LIMIT 500')
    .all(req.params.projectId);
  res.json({
    activity: rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null })),
  });
});

module.exports = router;
