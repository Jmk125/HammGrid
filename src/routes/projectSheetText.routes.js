const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const jobStore = require('../lib/jobStore');
const { getCurrentSheets } = require('../lib/sheetLinkScanner');
const { indexTextForSheets } = require('../lib/sheetTextIndex');

const router = express.Router({ mergeParams: true });

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
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM sheet_text_fts f JOIN sheets s ON s.id = f.rowid WHERE s.project_id = ?`
    )
    .get(project.id);
  res.json({ indexed_count: row.count });
});

router.get('/jobs/:jobId', requireAuth, (req, res) => {
  const job = jobStore.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ job });
});

router.post('/index', requireRole('admin', 'editor'), (req, res) => {
  const project = getProject(req, res);
  if (!project) return;

  const sheets = getCurrentSheets(project.id);
  if (sheets.length === 0) return res.status(400).json({ error: 'No published sheets to index' });

  const jobId = jobStore.createJob();
  jobStore.updateProgress(jobId, 0, sheets.length);
  res.status(202).json({ job_id: jobId, sheet_count: sheets.length });

  (async () => {
    try {
      const result = await indexTextForSheets({
        sourceSheets: sheets,
        onProgress: (done, total) => jobStore.updateProgress(jobId, done, total),
      });
      const job = jobStore.getJob(jobId);
      if (job) job.result = result;
      jobStore.completeJob(jobId);
    } catch (err) {
      console.error('Sheet text index failed', err);
      jobStore.failJob(jobId, err.message || 'Sheet text index failed');
    }
  })();
});

module.exports = router;
