const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { parseCsv } = require('../lib/csv');

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

// Spreadsheet import (CSV exported from the flags page). Rows are matched to
// existing flags by the ID column and have their description/comment/tags
// (and visibility) updated; rows with no ID - or one that no longer exists -
// create a new flag on the sheet/document named in Location. A spreadsheet
// has no drawing coordinates, so a new flag is dropped in the top-left
// corner of the page for the user to drag into place. Per-row permissions
// mirror PATCH /api/markups/:id: content edits need the author or an admin.
const NEW_FLAG_BOX = { x: 0.02, y: 0.02, w: 0.06, h: 0.04 };

function parseTags(raw) {
  return [...new Set(String(raw || '').split(/[,;]/).map((t) => t.trim()).filter(Boolean))];
}

router.post('/import', requireAuth, (req, res) => {
  const rows = parseCsv(req.body && req.body.csv);
  if (rows.length < 2) return res.status(400).json({ error: 'The file has no data rows.' });

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const cId = col('id');
  const cLoc = col('location');
  const cPage = col('page');
  const cDesc = col('description');
  const cComment = col('comment');
  const cTags = col('tags');
  const cVis = col('visibility');
  if (cLoc === -1 && cId === -1) {
    return res.status(400).json({ error: 'Expected a header row with at least an ID or Location column - use a file exported from this page.' });
  }

  const user = req.session.user;
  const isAdmin = user.role === 'admin';
  const projectId = Number(req.params.projectId);
  const get = (r, c) => (c === -1 ? undefined : (r[c] || '').trim());

  const findFlag = db.prepare(
    `SELECT m.* FROM markups m
     LEFT JOIN sheets s ON s.id = m.sheet_id
     LEFT JOIN documents d ON d.id = m.document_id
     WHERE m.id = ? AND m.type = 'flag' AND COALESCE(s.project_id, d.project_id) = ?
       AND (m.visibility = 'published' OR m.author_id = ?)`
  );
  const findSheet = db.prepare('SELECT id FROM sheets WHERE project_id = ? AND LOWER(sheet_number) = LOWER(?)');
  const findDoc = db.prepare('SELECT id FROM documents WHERE project_id = ? AND LOWER(name) = LOWER(?)');
  const updateFlag = db.prepare(
    "UPDATE markups SET geometry = ?, visibility = ?, updated_at = datetime('now') WHERE id = ?"
  );
  const insertSheetFlag = db.prepare(
    "INSERT INTO markups (sheet_id, author_id, visibility, type, geometry, style) VALUES (?, ?, ?, 'flag', ?, ?)"
  );
  const insertDocFlag = db.prepare(
    "INSERT INTO markups (document_id, author_id, visibility, type, geometry, style) VALUES (?, ?, ?, 'flag', ?, ?)"
  );

  const result = { created: 0, updated: 0, unchanged: 0, skipped: [] };
  const skip = (line, reason) => result.skipped.push({ row: line, reason });

  db.transaction(() => {
    rows.slice(1).forEach((r, i) => {
      const line = i + 2; // 1-based, counting the header row, matching what the spreadsheet shows
      const idRaw = get(r, cId);
      const visRaw = (get(r, cVis) || '').toLowerCase();
      if (visRaw && visRaw !== 'private' && visRaw !== 'published') return skip(line, `Visibility must be private or published (got "${visRaw}")`);
      if (visRaw === 'published' && user.role === 'viewer') return skip(line, 'Viewers cannot publish flags');

      const existing = idRaw ? findFlag.get(Number(idRaw), projectId, user.id) : null;
      if (existing) {
        const geometry = JSON.parse(existing.geometry);
        const next = { ...geometry };
        if (cDesc !== -1) next.description = get(r, cDesc);
        if (cComment !== -1) next.comment = get(r, cComment);
        if (cTags !== -1) next.tags = parseTags(r[cTags]);
        const visibility = visRaw || existing.visibility;
        const contentChanged = JSON.stringify(next) !== JSON.stringify(geometry);
        if (!contentChanged && visibility === existing.visibility) return void result.unchanged++;
        if (contentChanged && existing.author_id !== user.id && !isAdmin) {
          return skip(line, 'Only the flag’s author or an admin can edit its text');
        }
        if (!contentChanged && existing.author_id !== user.id && !isAdmin && user.role !== 'editor') {
          return skip(line, 'Not allowed to change this flag’s visibility');
        }
        updateFlag.run(JSON.stringify(next), visibility, existing.id);
        return void result.updated++;
      }

      const location = get(r, cLoc);
      if (!location) return skip(line, idRaw ? `Flag ID ${idRaw} not found and no Location given` : 'No ID or Location');
      const sheet = findSheet.get(projectId, location);
      const doc = sheet ? null : findDoc.get(projectId, location);
      if (!sheet && !doc) return skip(line, `No sheet or document named "${location}" in this project`);

      const geometry = {
        ...NEW_FLAG_BOX,
        description: get(r, cDesc) || '',
        comment: get(r, cComment) || '',
        tags: parseTags(r[cTags]),
      };
      if (doc) {
        const page = parseInt(get(r, cPage), 10);
        geometry.page = Number.isInteger(page) && page > 0 ? page : 1;
      }
      const visibility = user.role === 'viewer' ? 'private' : visRaw || 'private';
      const style = JSON.stringify({ color: '#f97316', strokeWidth: 2 });
      if (sheet) insertSheetFlag.run(sheet.id, user.id, visibility, JSON.stringify(geometry), style);
      else insertDocFlag.run(doc.id, user.id, visibility, JSON.stringify(geometry), style);
      result.created++;
    });
  })();

  res.json(result);
});

module.exports = router;
