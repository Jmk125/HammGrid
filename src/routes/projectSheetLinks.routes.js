const path = require('path');
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { runPython } = require('../lib/pyRunner');
const queue = require('../lib/queue');
const jobStore = require('../lib/jobStore');

const router = express.Router({ mergeParams: true });
const SCAN_SCRIPT = path.join(__dirname, '..', '..', 'pyproc', 'sheet_link_scan.py');
const SCAN_TIMEOUT_MS = 5 * 60 * 1000;

function getProject(req, res) {
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return null;
  }
  return project;
}

router.get('/summary', requireAuth, (req, res) => {
  const project = getProject(req, res);
  if (!project) return;
  const row = db.prepare('SELECT COUNT(*) AS count FROM sheet_links WHERE project_id = ?').get(project.id);
  res.json({ link_count: row.count });
});

router.get('/jobs/:jobId', requireAuth, (req, res) => {
  const job = jobStore.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ job });
});

router.post('/scan', requireRole('admin', 'editor'), (req, res) => {
  const project = getProject(req, res);
  if (!project) return;

  const sheets = db
    .prepare(
      `SELECT s.id, s.sheet_number, sv.pdf_path
       FROM sheets s
       JOIN sheet_versions sv ON sv.id = s.current_version_id
       WHERE s.project_id = ?
       ORDER BY s.sheet_number`
    )
    .all(project.id);

  if (sheets.length === 0) return res.status(400).json({ error: 'No published sheets to scan' });

  const jobId = jobStore.createJob();
  jobStore.updateProgress(jobId, 0, sheets.length);
  res.status(202).json({ job_id: jobId, sheet_count: sheets.length });

  (async () => {
    const targets = sheets.map((s) => ({ id: s.id, sheet_number: s.sheet_number }));
    const insert = db.prepare(
      `INSERT INTO sheet_links (project_id, source_sheet_id, target_sheet_id, rect, label, link_type, created_by)
       VALUES (?, ?, ?, ?, ?, 'auto', ?)`
    );
    const replaceAutoLinksForSheet = db.prepare(
      `DELETE FROM sheet_links WHERE project_id = ? AND source_sheet_id = ? AND link_type = 'auto'`
    );

    let done = 0;
    let created = 0;
    try {
      for (const sheet of sheets) {
        const result = await queue.enqueue(() =>
          runPython(SCAN_SCRIPT, [String(sheet.id), sheet.pdf_path, JSON.stringify(targets)], { timeout: SCAN_TIMEOUT_MS })
        );
        const links = Array.isArray(result.links) ? result.links : [];
        const tx = db.transaction(() => {
          replaceAutoLinksForSheet.run(project.id, sheet.id);
          for (const link of links) {
            insert.run(project.id, sheet.id, link.target_sheet_id, JSON.stringify(link.rect), link.label || null, req.session.user.id);
          }
        });
        tx();
        created += links.length;
        done += 1;
        jobStore.updateProgress(jobId, done, sheets.length);
      }
      const job = jobStore.getJob(jobId);
      if (job) job.result = { created_links: created, scanned_sheets: sheets.length };
      jobStore.completeJob(jobId);
    } catch (err) {
      console.error('Sheet-link scan failed', err);
      jobStore.failJob(jobId, err.message || 'Sheet-link scan failed');
    }
  })();
});

module.exports = router;
