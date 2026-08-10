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
function handleSync(req, res) {
  const requestTime = db.prepare("SELECT datetime('now') AS now").get().now;
  const rawSince = req.method === 'POST' ? req.body.since : req.query.since;
  const hasSince = !!rawSince;
  const since = rawSince || '0000-00-00 00:00:00';
  const cachedVersionIds = new Set(
    (req.method === 'POST' && Array.isArray(req.body.cached_version_ids) ? req.body.cached_version_ids : [])
      .map((id) => Number(id))
      .filter(Number.isFinite)
  );

  const currentRows = db
    .prepare(
      `SELECT s.id, s.sheet_number, s.discipline, s.scale_feet_per_inch,
              sv.id AS version_id, sv.revision_id, sv.title, r.published_at
       FROM sheets s
       JOIN sheet_versions sv ON sv.id = s.current_version_id
       JOIN revisions r ON r.id = sv.revision_id
       WHERE s.project_id = ?
       ORDER BY r.published_at`
    )
    .all(req.params.projectId);

  // Scale (and multi-scale zones) are sheet metadata, not tied to a
  // specific version - fetched for every current sheet regardless of the
  // since/cached_version_ids filtering below, same as sheet_number/
  // discipline, so an offline device's cached scale stays correct even on
  // a sync where no new PDF actually needed downloading (e.g. someone
  // edited the scale via Project Settings without publishing a revision).
  const zonesBySheetId = new Map();
  const zoneRows = db
    .prepare(
      `SELECT sz.* FROM scale_zones sz
       JOIN sheets s ON s.id = sz.sheet_id
       WHERE s.project_id = ?`
    )
    .all(req.params.projectId);
  for (const z of zoneRows) {
    if (!zonesBySheetId.has(z.sheet_id)) zonesBySheetId.set(z.sheet_id, []);
    zonesBySheetId.get(z.sheet_id).push(z);
  }

  const sheets = currentRows.filter(
    (s) =>
      (hasSince && s.published_at > since) ||
      (cachedVersionIds.size > 0 && !cachedVersionIds.has(s.version_id)) ||
      (!hasSince && cachedVersionIds.size === 0)
  );
  const currentSheetIds = currentRows.map((s) => s.id);
  const currentSheets = currentRows.map((s) => ({
    id: s.id,
    sheet_number: s.sheet_number,
    discipline: s.discipline,
    scale_feet_per_inch: s.scale_feet_per_inch,
    scale_zones: zonesBySheetId.get(s.id) || [],
    current_version: {
      id: s.version_id,
      revision_id: s.revision_id,
      title: s.title,
    },
  }));

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
    current_sheet_ids: currentSheetIds,
    current_sheets: currentSheets,
    sheets: sheets.map((s) => ({
      id: s.id,
      sheet_number: s.sheet_number,
      discipline: s.discipline,
      scale_feet_per_inch: s.scale_feet_per_inch,
      scale_zones: zonesBySheetId.get(s.id) || [],
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
}

router.get('/', requireAuth, handleSync);
router.post('/', requireAuth, handleSync);

module.exports = router;
