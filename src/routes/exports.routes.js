const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { streamZip, streamMergedPdf } = require('../lib/exportPdfs');

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

module.exports = router;
