// Lightweight in-memory tracker for background upload/burst jobs. Doesn't
// need to survive a server restart (an interrupted job is already a failure
// case either way), so a DB table would be overkill here - this is
// deliberately as simple as the job status polling that uses it.
const crypto = require('crypto');

const jobs = new Map();
const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

function createJob() {
  const id = crypto.randomUUID();
  jobs.set(id, { id, status: 'processing', error: null, progress: null, createdAt: Date.now() });
  return id;
}

function updateProgress(id, current, total) {
  const job = jobs.get(id);
  if (job) job.progress = { current, total };
}

function completeJob(id) {
  const job = jobs.get(id);
  if (job) job.status = 'done';
}

function failJob(id, message) {
  const job = jobs.get(id);
  if (job) {
    job.status = 'error';
    job.error = message;
  }
}

function getJob(id) {
  return jobs.get(id);
}

setInterval(() => {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}, 10 * 60 * 1000).unref();

module.exports = { createJob, updateProgress, completeJob, failJob, getJob };
