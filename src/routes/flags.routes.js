const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

// Flags live on either a sheet or a document (markups.sheet_id/document_id
// are mutually exclusive - see schema), so this project-wide list is a
// UNION ALL of both, normalized to a common `location`/`location_type`
// shape the frontend can render generically regardless of which kind a
// given flag is.
router.get('/', requireAuth, (req, res) => {
  const flags = db
    .prepare(
      `SELECT m.id, m.author_id, m.visibility, m.type, m.geometry, m.style, m.linked_document_id,
              m.created_at AS flag_created_at, m.updated_at AS flag_updated_at,
              u.name AS author_name,
              s.sheet_number AS location, 'sheet' AS location_type, s.discipline AS discipline,
              m.sheet_id AS target_sheet_id, NULL AS target_document_id
       FROM markups m
       JOIN sheets s ON s.id = m.sheet_id
       JOIN users u ON u.id = m.author_id
       WHERE m.type = 'flag' AND s.project_id = ? AND (m.visibility = 'published' OR m.author_id = ?)

       UNION ALL

       SELECT m.id, m.author_id, m.visibility, m.type, m.geometry, m.style, m.linked_document_id,
              m.created_at AS flag_created_at, m.updated_at AS flag_updated_at,
              u.name AS author_name,
              d.name AS location, 'document' AS location_type, NULL AS discipline,
              NULL AS target_sheet_id, m.document_id AS target_document_id
       FROM markups m
       JOIN documents d ON d.id = m.document_id
       JOIN users u ON u.id = m.author_id
       WHERE m.type = 'flag' AND d.project_id = ? AND (m.visibility = 'published' OR m.author_id = ?)

       ORDER BY location, flag_created_at`
    )
    .all(req.params.projectId, req.session.user.id, req.params.projectId, req.session.user.id);
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
