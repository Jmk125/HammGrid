// New project -> "Import from..." (dashboard). Admin only, same as creating a
// blank project. The flow, driven by public/js/import.js:
//   1. GET  /sources                          pick a source (importer registry)
//   2. GET  /sources/:source/browse?path=     browse that source's jobs
//   3. POST /sources/:source/convert {path}   queue the conversion -> import_id
//   4. GET  /:importId                        poll progress; once ready, the review data
//   5. POST /:importId/import {name, number}  create the project (one transaction)
//      DELETE /:importId                      cancel - deletes the staging folder
//      GET  /                                 unfinished imports, to resume one
// Each import stages into data/staging/imports/<importId>/ (meta.json +
// package/); see lib/importers/index.js for cleanup of abandoned ones.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { requireRole } = require('../middleware/auth');
const queue = require('../lib/queue');
const jobStore = require('../lib/jobStore');
const { streamFile } = require('../lib/streamFile');
const { getImporter, listImporters, importDir, IMPORTS_STAGING_DIR } = require('../lib/importers');

const router = express.Router();
const requireAdmin = requireRole('admin');

// importId -> AbortController for conversions still queued or running, so
// Cancel can kill the converter instead of letting it hold the (single)
// processing queue for minutes. The staging folder is removed once the
// converter has actually exited (Windows won't delete files it has open).
const running = new Map();
// Guards against a double-clicked Import creating the project twice.
const importing = new Set();

function readMeta(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  } catch (err) {
    return null;
  }
}

function writeMeta(dir, meta) {
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
}

function removeStaging(dir) {
  fs.rm(dir, { recursive: true, force: true }, (err) => {
    if (err) console.error(`Could not remove import staging ${dir}:`, err.message);
  });
}

// Loads an import's staging folder + meta, or sends the 404 itself.
function getImportOr404(req, res) {
  const dir = importDir(req.params.importId);
  const meta = dir && readMeta(dir);
  if (!meta) {
    res.status(404).json({ error: 'Import not found (it may have been cancelled or already imported)' });
    return null;
  }
  const importer = getImporter(meta.source);
  if (!importer) {
    res.status(400).json({ error: `Unknown import source "${meta.source}"` });
    return null;
  }
  return { dir, meta, importer, pkgDir: path.join(dir, 'package') };
}

function sendError(res, err, fallback) {
  if (!err.status) console.error(fallback, err);
  res.status(err.status || 500).json({ error: err.status ? err.message : `${fallback}: ${err.message}` });
}

// Staged imports that can still be resumed (a conversion takes minutes, so
// the admin may well have left the page). Newest first.
router.get('/', requireAdmin, (req, res) => {
  let names = [];
  try {
    names = fs.readdirSync(IMPORTS_STAGING_DIR);
  } catch (err) {
    // nothing staged yet
  }
  const imports = [];
  for (const name of names) {
    const dir = importDir(name);
    const meta = dir && readMeta(dir);
    if (!meta || !['converting', 'ready', 'error'].includes(meta.status)) continue;
    const importer = getImporter(meta.source);
    const job = jobStore.getJob(meta.id);
    imports.push({
      id: meta.id,
      source_label: importer ? importer.label : meta.source,
      job_name: meta.job_name,
      job_description: meta.job_description,
      status: meta.status === 'converting' && !job ? 'error' : meta.status,
      progress: job ? job.progress : null,
      created_at: meta.created_at,
    });
  }
  imports.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  res.json({ imports });
});

router.get('/sources', requireAdmin, (req, res) => {
  res.json({ sources: listImporters() });
});

router.get('/sources/:source/browse', requireAdmin, (req, res) => {
  const importer = getImporter(req.params.source);
  if (!importer) return res.status(404).json({ error: 'Unknown import source' });
  if (!importer.isConfigured()) return res.status(400).json({ error: `${importer.label} import is not configured on this server` });
  try {
    res.json(importer.browse(req.query.path || ''));
  } catch (err) {
    sendError(res, err, 'Browse failed');
  }
});

router.post('/sources/:source/convert', requireAdmin, (req, res) => {
  const importer = getImporter(req.params.source);
  if (!importer) return res.status(404).json({ error: 'Unknown import source' });
  if (!importer.isConfigured()) return res.status(400).json({ error: `${importer.label} import is not configured on this server` });

  let job;
  try {
    job = importer.resolveJob(req.body && req.body.path);
  } catch (err) {
    return sendError(res, err, 'Invalid job');
  }

  const importId = jobStore.createJob();
  const dir = importDir(importId);
  fs.mkdirSync(dir, { recursive: true });
  const meta = {
    id: importId,
    source: importer.id,
    job_path: job.rel,
    job_name: job.name,
    job_description: job.description,
    created_by: req.session.user.id,
    created_at: new Date().toISOString(),
    status: 'converting',
    error: null,
  };
  writeMeta(dir, meta);
  res.status(202).json({ import_id: importId });

  const controller = new AbortController();
  running.set(importId, controller);
  (async () => {
    try {
      await queue.enqueue(() =>
        importer.convert({
          jobDir: job.abs,
          outDir: path.join(dir, 'package'),
          onProgress: (current, total) => jobStore.updateProgress(importId, current, total),
          signal: controller.signal,
        })
      );
      writeMeta(dir, { ...meta, status: 'ready' });
      jobStore.completeJob(importId);
    } catch (err) {
      if (controller.signal.aborted) {
        jobStore.failJob(importId, 'Cancelled');
        return;
      }
      console.error('Import conversion failed', err);
      // Keep the tail of the converter's stderr - that's where the real
      // Python error is, and it's what the admin needs to see.
      const message = `Conversion failed: ${String(err.message).trim().split('\n').slice(-3).join(' ')}`;
      writeMeta(dir, { ...meta, status: 'error', error: message });
      jobStore.failJob(importId, message);
    } finally {
      running.delete(importId);
      if (controller.signal.aborted) removeStaging(dir);
    }
  })();
});

router.get('/:importId', requireAdmin, (req, res) => {
  const found = getImportOr404(req, res);
  if (!found) return;
  const { meta, importer, pkgDir } = found;
  const job = jobStore.getJob(meta.id);
  let status = meta.status;
  let error = meta.error;
  // meta says converting but this server process has no record of the job:
  // the server restarted mid-conversion.
  if (status === 'converting' && !job) {
    status = 'error';
    error = 'The conversion was interrupted (server restart). Cancel and start the import again.';
  }
  const payload = {
    import: {
      id: meta.id,
      source: meta.source,
      source_label: importer.label,
      job_path: meta.job_path,
      job_name: meta.job_name,
      job_description: meta.job_description,
      status,
      error,
      progress: job ? job.progress : null,
    },
  };
  if (status === 'ready') {
    try {
      payload.review = importer.review(pkgDir, req.session.user.id);
    } catch (err) {
      return sendError(res, err, 'Could not read the converted package');
    }
  }
  res.json(payload);
});

router.get('/:importId/sheets/:key/thumb', requireAdmin, (req, res) => {
  const found = getImportOr404(req, res);
  if (!found) return;
  let thumb;
  try {
    thumb = found.importer.sheetThumbPath(found.pkgDir, req.params.key);
  } catch (err) {
    thumb = null;
  }
  if (!thumb) return res.status(404).json({ error: 'Not found' });
  streamFile(res, thumb, 'image/webp');
});

router.delete('/:importId', requireAdmin, (req, res) => {
  const found = getImportOr404(req, res);
  if (!found) return;
  const { dir, meta } = found;
  const controller = running.get(meta.id);
  if (controller) {
    // Still queued/running - kill it; the background task removes the
    // folder once the converter has exited. Mark meta so a reload in the
    // meantime shows "cancelled" rather than the import resurrecting.
    writeMeta(dir, { ...meta, status: 'cancelled' });
    controller.abort();
    return res.json({ ok: true });
  }
  removeStaging(dir);
  res.json({ ok: true });
});

router.post('/:importId/import', requireAdmin, (req, res) => {
  const found = getImportOr404(req, res);
  if (!found) return;
  const { dir, meta, importer, pkgDir } = found;
  if (meta.status !== 'ready') return res.status(409).json({ error: 'This import is not ready yet' });
  if (importing.has(meta.id)) return res.status(409).json({ error: 'This import is already running' });

  const name = String((req.body && req.body.name) || '').trim();
  const number = String((req.body && req.body.number) || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });

  importing.add(meta.id);
  try {
    const result = importer.importPackage({ pkgDir, name, number: number || null, userId: req.session.user.id });
    // Mark it done before deleting, so a request racing the delete sees
    // "not ready" rather than importing the same package twice.
    writeMeta(dir, { ...meta, status: 'imported', project_id: result.projectId });
    removeStaging(dir);
    res.status(201).json({ project_id: result.projectId, stats: result.stats });
  } catch (err) {
    sendError(res, err, 'Import failed');
  } finally {
    importing.delete(meta.id);
  }
});

module.exports = router;
