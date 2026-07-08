const db = require('../db');

// Resolves a share token to its project + a validity check, and computes the
// exact set of sheet_versions it's allowed to show - shared between the
// share-viewing routes and the export routes so access rules can't drift
// between "what you can see" and "what you can download".
function resolveShare(token) {
  const share = db.prepare('SELECT * FROM shares WHERE token = ?').get(token);
  if (!share) return { error: 'Not found', status: 404 };
  if (share.revoked) return { error: 'This link has been revoked', status: 403 };
  if (share.expires_at && share.expires_at < new Date().toISOString()) {
    return { error: 'This link has expired', status: 403 };
  }
  return { share };
}

function getShareSheets(share) {
  let rows;
  if (share.scope === 'live') {
    let sql = `
      SELECT s.id, s.sheet_number, s.discipline, sv.id AS version_id, sv.title
      FROM sheets s
      JOIN sheet_versions sv ON sv.id = s.current_version_id
      WHERE s.project_id = ?
    `;
    const args = [share.project_id];
    if (share.discipline_filter) {
      sql += ' AND s.discipline = ?';
      args.push(share.discipline_filter);
    }
    sql += ' ORDER BY s.sheet_number';
    rows = db.prepare(sql).all(...args);
  } else {
    const revision = db.prepare('SELECT published_at FROM revisions WHERE id = ?').get(share.snapshot_revision_id);
    const cutoff = revision ? revision.published_at : '0000-00-00 00:00:00';
    let sql = `
      SELECT s.id, s.sheet_number, s.discipline, sv.id AS version_id, sv.title
      FROM sheets s
      JOIN sheet_versions sv ON sv.sheet_id = s.id
      JOIN revisions r ON r.id = sv.revision_id
      WHERE s.project_id = ? AND r.published_at <= ?
        AND sv.id = (
          SELECT sv2.id FROM sheet_versions sv2
          JOIN revisions r2 ON r2.id = sv2.revision_id
          WHERE sv2.sheet_id = s.id AND r2.published_at <= ?
          ORDER BY r2.published_at DESC, sv2.id DESC
          LIMIT 1
        )
    `;
    const args = [share.project_id, cutoff, cutoff];
    if (share.discipline_filter) {
      sql += ' AND s.discipline = ?';
      args.push(share.discipline_filter);
    }
    sql += ' ORDER BY s.sheet_number';
    rows = db.prepare(sql).all(...args);
  }
  return rows;
}

function logShareActivity(share, action, detail) {
  db.prepare('INSERT INTO activity_log (project_id, actor, action, detail) VALUES (?, ?, ?, ?)').run(
    share.project_id,
    `share:${share.token}`,
    action,
    JSON.stringify(detail || {})
  );
}

module.exports = { resolveShare, getShareSheets, logShareActivity };
