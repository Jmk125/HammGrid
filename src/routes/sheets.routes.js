const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.get('/', requireAuth, (req, res) => {
  const { discipline, revision_id } = req.query;

  let sql = `
    SELECT s.id, s.sheet_number, s.discipline, s.current_version_id,
           sv.title AS current_title, sv.revision_id AS current_revision_id,
           r.title AS current_revision_title, r.published_at AS current_published_at
    FROM sheets s
    JOIN sheet_versions sv ON sv.id = s.current_version_id
    JOIN revisions r ON r.id = sv.revision_id
    WHERE s.project_id = ?
  `;
  const args = [req.params.projectId];

  if (discipline) {
    sql += ' AND s.discipline = ?';
    args.push(discipline);
  }
  if (revision_id) {
    sql += ' AND sv.revision_id = ?';
    args.push(revision_id);
  }
  sql += ' ORDER BY s.sheet_number';

  const sheets = db.prepare(sql).all(...args);
  res.json({ sheets });
});

router.get('/:sheetId', requireAuth, (req, res) => {
  const sheet = db
    .prepare('SELECT * FROM sheets WHERE id = ? AND project_id = ?')
    .get(req.params.sheetId, req.params.projectId);
  if (!sheet) return res.status(404).json({ error: 'Not found' });

  const versions = db
    .prepare(
      `SELECT sv.*, r.title AS revision_title, r.published_at
       FROM sheet_versions sv JOIN revisions r ON r.id = sv.revision_id
       WHERE sv.sheet_id = ? ORDER BY r.published_at DESC`
    )
    .all(sheet.id);

  res.json({ sheet, versions });
});

router.patch('/:sheetId', requireRole('admin', 'editor'), (req, res) => {
  const sheet = db
    .prepare('SELECT * FROM sheets WHERE id = ? AND project_id = ?')
    .get(req.params.sheetId, req.params.projectId);
  if (!sheet) return res.status(404).json({ error: 'Not found' });

  const { scale_feet_per_inch } = req.body;
  db.prepare('UPDATE sheets SET scale_feet_per_inch = ? WHERE id = ?').run(
    scale_feet_per_inch === undefined ? sheet.scale_feet_per_inch : scale_feet_per_inch,
    sheet.id
  );
  const updated = db.prepare('SELECT * FROM sheets WHERE id = ?').get(sheet.id);
  res.json({ sheet: updated });
});

module.exports = router;
