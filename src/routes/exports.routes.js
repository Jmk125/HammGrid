const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { streamZip, streamMergedPdf } = require('../lib/exportPdfs');
const { getMarkupsForDownload } = require('../lib/markupSelection');

const router = express.Router({ mergeParams: true });

function getCurrentEntries(projectId, discipline) {
  let sql = `
    SELECT s.sheet_number, sv.title, sv.pdf_path
    FROM sheets s JOIN sheet_versions sv ON sv.id = s.current_version_id
    WHERE s.project_id = ?
  `;
  const args = [projectId];
  if (discipline) {
    sql += ' AND s.discipline = ?';
    args.push(discipline);
  }
  sql += ' ORDER BY s.sheet_number';
  return db.prepare(sql).all(...args);
}

function logExport(req, action, count) {
  db.prepare('INSERT INTO activity_log (project_id, actor, action, detail) VALUES (?, ?, ?, ?)').run(
    req.params.projectId,
    String(req.session.user.id),
    action,
    JSON.stringify({ sheet_count: count, discipline: req.query.discipline || null })
  );
}

router.get('/zip', requireAuth, (req, res) => {
  const entries = getCurrentEntries(req.params.projectId, req.query.discipline);
  logExport(req, 'export_zip', entries.length);
  streamZip(res, entries);
});

router.get('/merged-pdf', requireAuth, async (req, res) => {
  const entries = getCurrentEntries(req.params.projectId, req.query.discipline);
  logExport(req, 'export_merged_pdf', entries.length);
  try {
    await streamMergedPdf(res, entries);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Export failed' });
  }
});

// User-picked subset of sheets (viewer's "Download" selection), not the full
// published set - separate from /merged-pdf above, which is always
// project-wide (optionally discipline-filtered).
router.post('/selected-merged-pdf', requireAuth, async (req, res) => {
  const sheetIds = Array.isArray(req.body.sheetIds) ? req.body.sheetIds.map(Number).filter(Number.isInteger) : [];
  if (sheetIds.length === 0) return res.status(400).json({ error: 'No sheets selected' });
  const includePublished = !!req.body.published;
  const includePersonal = !!req.body.personal;

  const placeholders = sheetIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT s.id AS sheet_id, s.sheet_number, sv.title, sv.pdf_path
       FROM sheets s JOIN sheet_versions sv ON sv.id = s.current_version_id
       WHERE s.project_id = ? AND s.id IN (${placeholders})
       ORDER BY s.sheet_number`
    )
    .all(req.params.projectId, ...sheetIds);
  if (rows.length === 0) return res.status(404).json({ error: 'No matching sheets found' });

  const entries = rows.map((row) => ({
    pdf_path: row.pdf_path,
    sheet_number: row.sheet_number,
    title: row.title,
    markups: getMarkupsForDownload(row.sheet_id, { includePublished, includePersonal, userId: req.session.user.id }),
  }));

  db.prepare('INSERT INTO activity_log (project_id, actor, action, detail) VALUES (?, ?, ?, ?)').run(
    req.params.projectId,
    String(req.session.user.id),
    'export_selected_merged_pdf',
    JSON.stringify({ sheet_count: entries.length, published: includePublished, personal: includePersonal })
  );

  try {
    await streamMergedPdf(res, entries);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Export failed' });
  }
});

module.exports = router;
