const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

// "since" is compared as TEXT against columns populated by SQLite's
// datetime('now') (format: 'YYYY-MM-DD HH:MM:SS', UTC). The cursor returned
// to the client MUST come from that same clock/format, not JS's
// toISOString() (different separators/precision), or string comparison
// breaks. Grabbing it via a query fixed at the start of the request means
// nothing committed after this point is silently missed - it just lands in
// the next sync instead.
router.get('/', requireAuth, (req, res) => {
  const requestTime = db.prepare("SELECT datetime('now') AS now").get().now;
  const since = req.query.since || '0000-00-00 00:00:00';

  const sheets = db
    .prepare(
      `SELECT s.id, s.sheet_number, s.discipline,
              sv.id AS version_id, sv.revision_id, sv.title, r.published_at
       FROM sheets s
       JOIN sheet_versions sv ON sv.id = s.current_version_id
       JOIN revisions r ON r.id = sv.revision_id
       WHERE s.project_id = ? AND r.published_at > ?
       ORDER BY r.published_at`
    )
    .all(req.params.projectId, since);

  const markups = db
    .prepare(
      `SELECT m.* FROM markups m
       JOIN sheets s ON s.id = m.sheet_id
       WHERE s.project_id = ?
         AND (m.visibility = 'published' OR m.author_id = ?)
         AND (m.created_at > ? OR m.updated_at > ?)`
    )
    .all(req.params.projectId, req.session.user.id, since, since);

  res.json({
    since: requestTime,
    sheets: sheets.map((s) => ({
      id: s.id,
      sheet_number: s.sheet_number,
      discipline: s.discipline,
      current_version: {
        id: s.version_id,
        revision_id: s.revision_id,
        title: s.title,
        pdf_url: `/api/sheet-versions/${s.version_id}/pdf`,
        thumb_url: `/api/sheet-versions/${s.version_id}/thumb`,
        preview_url: `/api/sheet-versions/${s.version_id}/preview`,
      },
    })),
    markups: markups.map((m) => ({ ...m, geometry: JSON.parse(m.geometry), style: JSON.parse(m.style) })),
  });
});

module.exports = router;
