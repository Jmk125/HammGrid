const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// "View Multiple" (see dashboard.js) - the same union-of-sheet-and-document
// flags query /api/projects/:projectId/flags runs (see flags.routes.js), but
// spanning several projects at once instead of one. Every row carries
// project_id/project_name since a sheet number or tag can easily collide
// across separate projects for the same district (e.g. two demo projects
// both having an "A101"), which the single-project list never has to worry
// about. Roles are global, not per-project (see schema.sql), so there's no
// extra access check beyond requireAuth - any logged-in internal user can
// already see any project.
router.get('/', requireAuth, (req, res) => {
  const ids = String(req.query.projectIds || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return res.json({ flags: [] });

  const placeholders = ids.map(() => '?').join(',');
  const flags = db
    .prepare(
      `SELECT m.id, m.author_id, m.visibility, m.type, m.geometry, m.style, m.linked_document_id,
              m.created_at AS flag_created_at, m.updated_at AS flag_updated_at,
              u.name AS author_name,
              s.sheet_number AS location, 'sheet' AS location_type, s.discipline AS discipline,
              m.sheet_id AS target_sheet_id, NULL AS target_document_id,
              p.id AS project_id, p.name AS project_name
       FROM markups m
       JOIN sheets s ON s.id = m.sheet_id
       JOIN projects p ON p.id = s.project_id
       JOIN users u ON u.id = m.author_id
       WHERE m.type = 'flag' AND s.project_id IN (${placeholders}) AND (m.visibility = 'published' OR m.author_id = ?)

       UNION ALL

       SELECT m.id, m.author_id, m.visibility, m.type, m.geometry, m.style, m.linked_document_id,
              m.created_at AS flag_created_at, m.updated_at AS flag_updated_at,
              u.name AS author_name,
              d.name AS location, 'document' AS location_type, NULL AS discipline,
              NULL AS target_sheet_id, m.document_id AS target_document_id,
              p.id AS project_id, p.name AS project_name
       FROM markups m
       JOIN documents d ON d.id = m.document_id
       JOIN projects p ON p.id = d.project_id
       JOIN users u ON u.id = m.author_id
       WHERE m.type = 'flag' AND d.project_id IN (${placeholders}) AND (m.visibility = 'published' OR m.author_id = ?)

       ORDER BY project_name, location, flag_created_at`
    )
    .all(...ids, req.session.user.id, ...ids, req.session.user.id);
  res.json({
    flags: flags.map((f) => ({
      ...f,
      created_at: f.flag_created_at,
      updated_at: f.flag_updated_at,
      geometry: JSON.parse(f.geometry),
      style: JSON.parse(f.style),
    })),
  });
});

module.exports = router;
