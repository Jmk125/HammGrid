const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.get('/', requireRole('admin', 'editor'), (req, res) => {
  const shares = db
    .prepare(
      `SELECT sh.*, u.name AS created_by_name, r.title AS snapshot_revision_title
       FROM shares sh
       JOIN users u ON u.id = sh.created_by
       LEFT JOIN revisions r ON r.id = sh.snapshot_revision_id
       WHERE sh.project_id = ? ORDER BY sh.created_at DESC`
    )
    .all(req.params.projectId);
  res.json({ shares });
});

router.post('/', requireRole('admin', 'editor'), (req, res) => {
  const { scope, snapshot_revision_id, discipline_filter, expires_at } = req.body;
  if (!['live', 'snapshot'].includes(scope)) {
    return res.status(400).json({ error: 'scope must be live or snapshot' });
  }
  if (scope === 'snapshot' && !snapshot_revision_id) {
    return res.status(400).json({ error: 'snapshot_revision_id is required for snapshot shares' });
  }

  const token = crypto.randomBytes(24).toString('base64url');
  const result = db
    .prepare(
      `INSERT INTO shares (project_id, token, scope, snapshot_revision_id, discipline_filter, expires_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.params.projectId,
      token,
      scope,
      scope === 'snapshot' ? snapshot_revision_id : null,
      discipline_filter || null,
      expires_at || null,
      req.session.user.id
    );

  db.prepare('INSERT INTO activity_log (project_id, actor, action, detail) VALUES (?, ?, ?, ?)').run(
    req.params.projectId,
    String(req.session.user.id),
    'share_create',
    JSON.stringify({ share_id: result.lastInsertRowid, scope })
  );

  const share = db.prepare('SELECT * FROM shares WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ share });
});

router.patch('/:id/revoke', requireAuth, (req, res) => {
  const share = db.prepare('SELECT * FROM shares WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!share) return res.status(404).json({ error: 'Not found' });

  const user = req.session.user;
  if (share.created_by !== user.id && user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the creator or an admin can revoke this share' });
  }

  db.prepare('UPDATE shares SET revoked = 1 WHERE id = ?').run(share.id);
  db.prepare('INSERT INTO activity_log (project_id, actor, action, detail) VALUES (?, ?, ?, ?)').run(
    share.project_id,
    String(user.id),
    'share_revoke',
    JSON.stringify({ share_id: share.id })
  );
  res.json({ ok: true });
});

module.exports = router;
