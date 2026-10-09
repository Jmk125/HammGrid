const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const jobStore = require('../lib/jobStore');
const { getCurrentSheets, scanAutoLinksForSheets, deleteAutoLinksForProject } = require('../lib/sheetLinkScanner');

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

  const sheets = getCurrentSheets(project.id);
  if (sheets.length === 0) return res.status(400).json({ error: 'No published sheets to scan' });

  const jobId = jobStore.createJob();
  jobStore.updateProgress(jobId, 0, sheets.length);
  res.status(202).json({ job_id: jobId, sheet_count: sheets.length });

  (async () => {
    try {
      // A manual project-settings scan is authoritative for the current set:
      // clear stale auto links first, including links from sheets that were
      // deleted or replaced, then rebuild auto links from the current sheets.
      deleteAutoLinksForProject(project.id);
      const result = await scanAutoLinksForSheets({
        projectId: project.id,
        sourceSheets: sheets,
        userId: req.session.user.id,
        onProgress: (done, total) => jobStore.updateProgress(jobId, done, total),
      });
      const job = jobStore.getJob(jobId);
      if (job) job.result = result;
      jobStore.completeJob(jobId);
    } catch (err) {
      console.error('Sheet-link scan failed', err);
      jobStore.failJob(jobId, err.message || 'Sheet-link scan failed');
    }
  })();
});

module.exports = router;
