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


function parseShareFolderIds(share) {
  try {
    return JSON.parse(share.document_folder_ids || '[]').map(Number).filter(Boolean);
  } catch (e) {
    return [];
  }
}

function getAllowedDocumentFolderIds(share) {
  if (!share.allow_documents) return [];
  const roots = parseShareFolderIds(share);
  if (!roots.length) return [];
  const seen = new Set();
  const queue = [...roots];
  const getChildren = db.prepare('SELECT id FROM document_folders WHERE parent_folder_id = ? AND project_id = ?');
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const child of getChildren.all(id, share.project_id)) queue.push(child.id);
  }
  return [...seen];
}

function getShareDocuments(share) {
  const folderIds = getAllowedDocumentFolderIds(share);
  if (!folderIds.length) return { folders: [], documents: [] };
  const placeholders = folderIds.map(() => '?').join(',');
  const folders = db
    .prepare(`SELECT * FROM document_folders WHERE project_id = ? AND id IN (${placeholders}) ORDER BY name`)
    .all(share.project_id, ...folderIds);
  const documents = db
    .prepare(
      `SELECT d.id, d.folder_id, d.name, d.created_at,
              dv.id AS current_version_id, dv.revision_name, dv.issue_date, dv.created_at AS version_created_at
       FROM documents d
       LEFT JOIN document_versions dv ON dv.id = d.current_version_id
       WHERE d.project_id = ? AND d.folder_id IN (${placeholders})
       ORDER BY d.name`
    )
    .all(share.project_id, ...folderIds);
  return { folders, documents };
}

function canAccessShareDocument(share, documentId) {
  const folderIds = getAllowedDocumentFolderIds(share);
  if (!folderIds.length) return null;
  const placeholders = folderIds.map(() => '?').join(',');
  return db
    .prepare(`SELECT * FROM documents WHERE id = ? AND project_id = ? AND folder_id IN (${placeholders})`)
    .get(documentId, share.project_id, ...folderIds);
}

function logShareActivity(share, action, detail) {
  db.prepare('INSERT INTO activity_log (project_id, actor, action, detail) VALUES (?, ?, ?, ?)').run(
    share.project_id,
    `share:${share.token}`,
    action,
    JSON.stringify(detail || {})
  );
}

module.exports = { resolveShare, getShareSheets, getShareDocuments, canAccessShareDocument, logShareActivity };
