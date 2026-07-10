const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

function normalizeFolderIds(ids) {
  if (!Array.isArray(ids)) return '[]';
  return JSON.stringify([...new Set(ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))]);
}

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
  const { name, scope, snapshot_revision_id, discipline_filter, expires_at, allow_personal_markups, allow_documents, document_folder_ids } = req.body;
  if (!['live', 'snapshot'].includes(scope)) {
    return res.status(400).json({ error: 'scope must be live or snapshot' });
  }
  if (scope === 'snapshot' && !snapshot_revision_id) {
    return res.status(400).json({ error: 'snapshot_revision_id is required for snapshot shares' });
  }

  const token = crypto.randomBytes(24).toString('base64url');
  const result = db
    .prepare(
      `INSERT INTO shares (project_id, token, name, scope, snapshot_revision_id, discipline_filter, expires_at, allow_personal_markups, allow_documents, document_folder_ids, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.params.projectId,
      token,
      (name || '').trim() || null,
      scope,
      scope === 'snapshot' ? snapshot_revision_id : null,
      discipline_filter || null,
      expires_at || null,
      allow_personal_markups ? 1 : 0,
      allow_documents ? 1 : 0,
      normalizeFolderIds(document_folder_ids),
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

function canManageShare(share, user) {
  return share.created_by === user.id || user.role === 'admin';
}

function logShareChange(projectId, userId, action, shareId, detail = {}) {
  db.prepare('INSERT INTO activity_log (project_id, actor, action, detail) VALUES (?, ?, ?, ?)').run(
    projectId,
    String(userId),
    action,
    JSON.stringify({ share_id: shareId, ...detail })
  );
}

router.patch('/:id', requireAuth, (req, res) => {
  const share = db.prepare('SELECT * FROM shares WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!share) return res.status(404).json({ error: 'Not found' });

  const user = req.session.user;
  if (!canManageShare(share, user)) {
    return res.status(403).json({ error: 'Only the creator or an admin can update this share' });
  }

  const hasName = Object.prototype.hasOwnProperty.call(req.body, 'name');
  const hasRevoked = Object.prototype.hasOwnProperty.call(req.body, 'revoked');
  const hasPersonalMarkups = Object.prototype.hasOwnProperty.call(req.body, 'allow_personal_markups');
  const hasDocuments = Object.prototype.hasOwnProperty.call(req.body, 'allow_documents');
  const hasDocumentFolders = Object.prototype.hasOwnProperty.call(req.body, 'document_folder_ids');
  if (!hasName && !hasRevoked && !hasPersonalMarkups && !hasDocuments && !hasDocumentFolders) {
    return res.status(400).json({ error: 'Nothing to update' });
  }
  if (hasRevoked && ![true, false, 0, 1].includes(req.body.revoked)) {
    return res.status(400).json({ error: 'revoked must be true or false' });
  }

  const nextName = hasName ? (req.body.name || '').trim() || null : share.name;
  const nextRevoked = hasRevoked ? (req.body.revoked ? 1 : 0) : share.revoked;
  const nextPersonalMarkups = hasPersonalMarkups ? (req.body.allow_personal_markups ? 1 : 0) : share.allow_personal_markups;
  const nextDocuments = hasDocuments ? (req.body.allow_documents ? 1 : 0) : share.allow_documents;
  const nextDocumentFolders = hasDocumentFolders ? normalizeFolderIds(req.body.document_folder_ids) : share.document_folder_ids;
  db.prepare('UPDATE shares SET name = ?, revoked = ?, allow_personal_markups = ?, allow_documents = ?, document_folder_ids = ? WHERE id = ?')
    .run(nextName, nextRevoked, nextPersonalMarkups, nextDocuments, nextDocumentFolders, share.id);

  const action = hasRevoked
    ? nextRevoked ? 'share_deactivate' : 'share_activate'
    : 'share_update';
  logShareChange(share.project_id, user.id, action, share.id, {
    name: nextName,
    revoked: Boolean(nextRevoked),
    allow_personal_markups: Boolean(nextPersonalMarkups),
    allow_documents: Boolean(nextDocuments),
    document_folder_ids: JSON.parse(nextDocumentFolders || '[]'),
  });

  const updated = db.prepare('SELECT * FROM shares WHERE id = ?').get(share.id);
  res.json({ share: updated });
});

router.delete('/:id', requireAuth, (req, res) => {
  const share = db.prepare('SELECT * FROM shares WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!share) return res.status(404).json({ error: 'Not found' });

  const user = req.session.user;
  if (!canManageShare(share, user)) {
    return res.status(403).json({ error: 'Only the creator or an admin can delete this share' });
  }

  db.prepare('DELETE FROM shares WHERE id = ?').run(share.id);
  logShareChange(share.project_id, user.id, 'share_delete', share.id, { name: share.name });
  res.json({ ok: true });
});

router.patch('/:id/revoke', requireAuth, (req, res) => {
  const share = db.prepare('SELECT * FROM shares WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!share) return res.status(404).json({ error: 'Not found' });

  const user = req.session.user;
  if (!canManageShare(share, user)) {
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
