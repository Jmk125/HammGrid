const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../db');
const config = require('../config');
const { requireAuth, requireRole } = require('../middleware/auth');
const { runPython, runPythonWithProgress } = require('../lib/pyRunner');
const queue = require('../lib/queue');
const { computeMatch, needsAttention } = require('../lib/matching');
const jobStore = require('../lib/jobStore');
const { toPortablePath } = require('../lib/paths');

// Burst walks every page sequentially (PyMuPDF render + thumbnail + preview),
// so a large multi-hundred-page upload can legitimately take a while. This
// used to default to pyRunner's 2-minute timeout, which is exactly what was
// killing large uploads with a generic "failed to process" error - 30
// minutes is safe now that this runs in the background rather than blocking
// the request.
const BURST_TIMEOUT_MS = 30 * 60 * 1000;

const router = express.Router({ mergeParams: true });

const BURST_SCRIPT = path.join(__dirname, '..', '..', 'pyproc', 'burst.py');
const OCR_SCRIPT = path.join(__dirname, '..', '..', 'pyproc', 'ocr_region.py');
const OVERLAY_SCRIPT = path.join(__dirname, '..', '..', 'pyproc', 'overlay.py');

const uploadTmpDir = path.join(config.storageDir, 'uploads', 'tmp');
fs.mkdirSync(uploadTmpDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadTmpDir,
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.pdf`),
  }),
  fileFilter: (req, file, cb) => {
    cb(null, /\.pdf$/i.test(file.originalname));
  },
  limits: { fileSize: 1024 * 1024 * 1024 },
});

function getProjectOr404(req, res) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return null;
  }
  return project;
}

function getRevisionOr404(req, res) {
  const revision = db
    .prepare('SELECT * FROM revisions WHERE id = ? AND project_id = ?')
    .get(req.params.revisionId, req.params.projectId);
  if (!revision) {
    res.status(404).json({ error: 'Revision not found' });
    return null;
  }
  return revision;
}

function withStagedFlags(row) {
  return { ...row, needs_attention: needsAttention(row) };
}

router.get('/', requireAuth, (req, res) => {
  if (!getProjectOr404(req, res)) return;
  const revisions = db
    .prepare('SELECT * FROM revisions WHERE project_id = ? ORDER BY created_at DESC')
    .all(req.params.projectId);
  res.json({ revisions });
});

router.post('/', requireRole('admin', 'editor'), (req, res) => {
  if (!getProjectOr404(req, res)) return;
  const { title, source, date } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });

  const result = db
    .prepare('INSERT INTO revisions (project_id, title, source, date, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(req.params.projectId, title, source || null, date || null, req.session.user.id);
  const revision = db.prepare('SELECT * FROM revisions WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ revision });
});

router.get('/:revisionId', requireAuth, (req, res) => {
  const revision = getRevisionOr404(req, res);
  if (!revision) return;
  res.json({ revision });
});

// Destructive and unrecoverable (like project delete), so it requires the
// caller to echo back the revision's exact title - same defense-in-depth
// reasoning as projects.routes.js's delete route.
router.delete('/:revisionId', requireRole('admin'), (req, res) => {
  const revision = getRevisionOr404(req, res);
  if (!revision) return;

  if (req.body.confirm_name !== revision.title) {
    return res.status(400).json({ error: 'confirm_name must exactly match the revision title' });
  }

  // The DB's own FK (shares.snapshot_revision_id has no ON DELETE action)
  // would reject this anyway, but checking first keeps the operation
  // atomic and gives a real error message instead of a raw SQLite
  // constraint failure after some sheets have already been reassigned.
  const snapshotCount = db
    .prepare('SELECT COUNT(*) AS c FROM shares WHERE snapshot_revision_id = ?')
    .get(revision.id).c;
  if (snapshotCount > 0) {
    return res.status(400).json({
      error: `${snapshotCount} share link(s) snapshot this revision - delete or update them first.`,
    });
  }

  const filesToDelete = [];
  let sheetsDeleted = 0;

  const deleteTxn = db.transaction(() => {
    const versions = db
      .prepare('SELECT id, sheet_id, pdf_path, thumb_path, preview_path, overlay_path FROM sheet_versions WHERE revision_id = ?')
      .all(revision.id);

    // Any sheet whose *current* version came from this revision needs a new
    // current_version_id before this revision can be removed - reassigned to
    // its latest surviving version, or the sheet is deleted outright if this
    // revision was its only version (a sheet can't exist with zero versions).
    const affectedSheets = db
      .prepare(
        `SELECT s.id FROM sheets s
         JOIN sheet_versions sv ON sv.id = s.current_version_id
         WHERE sv.revision_id = ?`
      )
      .all(revision.id);

    const sheetsToDelete = [];
    for (const { id: sheetId } of affectedSheets) {
      const nextVersion = db
        .prepare(
          `SELECT id FROM sheet_versions WHERE sheet_id = ? AND revision_id != ? ORDER BY created_at DESC LIMIT 1`
        )
        .get(sheetId, revision.id);
      if (nextVersion) {
        db.prepare('UPDATE sheets SET current_version_id = ? WHERE id = ?').run(nextVersion.id, sheetId);
      } else {
        sheetsToDelete.push(sheetId);
      }
    }

    if (sheetsToDelete.length > 0) {
      const placeholders = sheetsToDelete.map(() => '?').join(',');
      db.prepare(`DELETE FROM sheets WHERE id IN (${placeholders})`).run(...sheetsToDelete);
      sheetsDeleted = sheetsToDelete.length;
    }

    for (const v of versions) {
      for (const p of [v.pdf_path, v.thumb_path, v.preview_path, v.overlay_path]) {
        if (p) filesToDelete.push(p);
      }
    }

    db.prepare('DELETE FROM revisions WHERE id = ?').run(revision.id);

    db.prepare('INSERT INTO activity_log (project_id, actor, action, detail) VALUES (?, ?, ?, ?)').run(
      revision.project_id,
      String(req.session.user.id),
      'revision_delete',
      JSON.stringify({
        revision_id: revision.id,
        revision_title: revision.title,
        version_count: versions.length,
        sheets_deleted: sheetsDeleted,
      })
    );
  });

  try {
    deleteTxn();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Delete failed', detail: err.message });
  }

  for (const p of filesToDelete) fs.rm(p, { force: true }, () => {});
  fs.rm(path.join(config.storageDir, 'staging', String(revision.id)), { recursive: true, force: true }, () => {});

  res.json({ ok: true, sheets_deleted: sheetsDeleted });
});

// One file per request (not batched) so the client can show real per-file
// progress and so one huge file in a batch can't stall the others. Responds
// as soon as the file is saved and hands burst off to the background -
// the client polls /upload-jobs/:jobId for completion, and the job keeps
// running server-side even if the client navigates away or disconnects.
// Uploading is allowed regardless of revision.status - a revision can be
// "modified" (more sheets added) after it's already published, not just
// while still a draft. Publishing again just processes whatever's newly
// staged; see the publish route below.
router.post('/:revisionId/upload', requireRole('admin', 'editor'), upload.single('file'), (req, res) => {
  const revision = getRevisionOr404(req, res);
  if (!revision) return;
  if (!req.file) {
    return res.status(400).json({ error: 'No PDF file uploaded' });
  }

  const jobId = jobStore.createJob();
  res.status(202).json({ job_id: jobId });

  (async () => {
    try {
      const maxOrderRow = db
        .prepare('SELECT COALESCE(MAX(upload_order), 0) AS maxOrder FROM staged_sheets WHERE revision_id = ?')
        .get(revision.id);
      let nextOrder = maxOrderRow.maxOrder;

      const batchDir = path.join(config.storageDir, 'staging', String(revision.id), crypto.randomUUID().slice(0, 8));
      const pages = await queue.enqueue(() =>
        runPythonWithProgress(
          BURST_SCRIPT,
          [req.file.path, batchDir],
          (current, total) => jobStore.updateProgress(jobId, current, total),
          { timeout: BURST_TIMEOUT_MS }
        )
      );

      const insertStmt = db.prepare(
        `INSERT INTO staged_sheets (revision_id, upload_order, pdf_path, thumb_path, preview_path, page_width_pt, page_height_pt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const page of pages) {
        nextOrder += 1;
        insertStmt.run(
          revision.id,
          nextOrder,
          toPortablePath(page.pdf_path),
          toPortablePath(page.thumb_path),
          toPortablePath(page.preview_path),
          page.page_width_pt,
          page.page_height_pt
        );
      }
      jobStore.completeJob(jobId);
    } catch (err) {
      console.error('Background upload processing failed', err);
      jobStore.failJob(jobId, 'Failed to process this PDF');
    } finally {
      fs.unlink(req.file.path, () => {});
    }
  })();
});

// Generic job-status lookup, backed by the single shared jobStore Map - not
// upload-specific despite the URL, so the read/OCR job (below) polls this
// same route too instead of needing its own. Keeping one route also means
// shell.js's cross-page "job finished" toast tracking (hardcoded to this
// path) works for read jobs without any changes there.
router.get('/:revisionId/upload-jobs/:jobId', requireAuth, (req, res) => {
  const job = jobStore.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json({ job });
});

router.get('/:revisionId/staged', requireAuth, (req, res) => {
  const revision = getRevisionOr404(req, res);
  if (!revision) return;
  const rows = db
    .prepare('SELECT * FROM staged_sheets WHERE revision_id = ? ORDER BY upload_order')
    .all(revision.id);
  res.json({ staged_sheets: rows.map(withStagedFlags) });
});

// Dry-run: reads one sheet with the current box placement and returns the
// text/confidence without touching staged_sheets, so the user can confirm the
// boxes are placed correctly before running the batch.
router.post('/:revisionId/read-preview', requireRole('admin', 'editor'), async (req, res) => {
  const revision = getRevisionOr404(req, res);
  if (!revision) return;

  const { staged_sheet_id, number_box, title_box } = req.body;
  if (!staged_sheet_id || !number_box || !title_box) {
    return res.status(400).json({ error: 'staged_sheet_id, number_box and title_box are required' });
  }

  const staged = db
    .prepare('SELECT * FROM staged_sheets WHERE id = ? AND revision_id = ?')
    .get(staged_sheet_id, revision.id);
  if (!staged) return res.status(404).json({ error: 'Staged sheet not found' });

  try {
    const result = await queue.enqueue(() =>
      runPython(OCR_SCRIPT, [
        staged.pdf_path,
        JSON.stringify(number_box),
        JSON.stringify(title_box),
        '--tesseract-cmd',
        config.tesseractPath,
      ])
    );
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Read failed' });
  }
});

// Reads run one sheet at a time through the shared queue (Pi RAM constraint),
// so a 200-sheet batch can take minutes - this is a background job (same
// pattern as upload) with incremental progress instead of one long blocking
// request, so the client can show a real progress bar rather than a spinner.
router.post('/:revisionId/ocr', requireRole('admin', 'editor'), (req, res) => {
  const revision = getRevisionOr404(req, res);
  if (!revision) return;

  const { scope, number_box, title_box, staged_sheet_ids } = req.body;
  if (!scope || !number_box || !title_box || !Array.isArray(staged_sheet_ids) || staged_sheet_ids.length === 0) {
    return res.status(400).json({ error: 'scope, number_box, title_box and staged_sheet_ids are required' });
  }

  const existingRegion = db
    .prepare('SELECT id FROM ocr_regions WHERE project_id = ? AND scope = ?')
    .get(revision.project_id, scope);
  if (existingRegion) {
    db.prepare('UPDATE ocr_regions SET number_box = ?, title_box = ? WHERE id = ?').run(
      JSON.stringify(number_box),
      JSON.stringify(title_box),
      existingRegion.id
    );
  } else {
    db.prepare('INSERT INTO ocr_regions (project_id, scope, number_box, title_box) VALUES (?, ?, ?, ?)').run(
      revision.project_id,
      scope,
      JSON.stringify(number_box),
      JSON.stringify(title_box)
    );
  }

  const jobId = jobStore.createJob();
  jobStore.updateProgress(jobId, 0, staged_sheet_ids.length);
  res.status(202).json({ job_id: jobId });

  (async () => {
    const project = db.prepare('SELECT discipline_prefix_map FROM projects WHERE id = ?').get(revision.project_id);
    const prefixMap = JSON.parse(project.discipline_prefix_map);

    const updateStmt = db.prepare(
      `UPDATE staged_sheets SET
         region_scope = ?, ocr_number = ?, ocr_number_confidence = ?,
         ocr_title = ?, ocr_title_confidence = ?, discipline = ?,
         match_status = ?, match_sheet_id = ?
       WHERE id = ?`
    );

    let done = 0;
    try {
      for (const id of staged_sheet_ids) {
        const staged = db.prepare('SELECT * FROM staged_sheets WHERE id = ? AND revision_id = ?').get(id, revision.id);
        if (staged) {
          const ocr = await queue.enqueue(() =>
            runPython(OCR_SCRIPT, [
              staged.pdf_path,
              JSON.stringify(number_box),
              JSON.stringify(title_box),
              '--tesseract-cmd',
              config.tesseractPath,
            ])
          );
          const match = computeMatch(db, revision.project_id, ocr.number_text, ocr.title_text, prefixMap);

          updateStmt.run(
            scope,
            ocr.number_text,
            ocr.number_confidence,
            ocr.title_text,
            ocr.title_confidence,
            match.discipline,
            match.match_status,
            match.match_sheet_id,
            id
          );
        }
        done += 1;
        jobStore.updateProgress(jobId, done, staged_sheet_ids.length);
      }
      jobStore.completeJob(jobId);
    } catch (err) {
      console.error('Background read job failed', err);
      jobStore.failJob(jobId, err.message || 'Read failed');
    }
  })();
});

// Not gated to draft-only - publishing an already-published revision again
// just commits whatever's newly staged since (the "modify an existing
// revision" flow), same validations apply either way.
router.post('/:revisionId/publish', requireRole('admin', 'editor'), async (req, res) => {
  const revision = getRevisionOr404(req, res);
  if (!revision) return;

  const staged = db.prepare('SELECT * FROM staged_sheets WHERE revision_id = ?').all(revision.id);
  if (staged.length === 0) {
    return res.status(400).json({ error: 'No sheets to publish' });
  }

  const pending = staged.filter((s) => s.match_status === 'pending');
  if (pending.length > 0) {
    return res.status(400).json({ error: `${pending.length} sheet(s) have not been reviewed yet` });
  }

  const suspicious = staged.filter((s) => s.match_status === 'suspicious');
  if (suspicious.length > 0) {
    return res.status(400).json({
      error: `${suspicious.length} sheet(s) flagged suspicious must be resolved before publishing`,
      suspicious_ids: suspicious.map((s) => s.id),
    });
  }

  const toPublish = staged.filter((s) => s.match_status !== 'ignored');
  const toDiscard = staged.filter((s) => s.match_status === 'ignored');

  // Pre-bake the current-vs-previous overlay for replacements (spec: pre-bake the
  // common comparison at publish time for instant load). This needs the queue's
  // async python calls, which can't run inside the synchronous db.transaction()
  // below, and must read the *old* current_version_id before publish overwrites it.
  const overlayPaths = {};
  for (const s of toPublish) {
    if (s.match_status !== 'replacement' || !s.match_sheet_id) continue;
    const oldSheet = db.prepare('SELECT current_version_id FROM sheets WHERE id = ?').get(s.match_sheet_id);
    const oldVersion = oldSheet && oldSheet.current_version_id
      ? db.prepare('SELECT pdf_path FROM sheet_versions WHERE id = ?').get(oldSheet.current_version_id)
      : null;
    if (!oldVersion) continue;

    const destDir = path.join(config.storageDir, 'projects', String(revision.project_id), 'sheets', String(s.match_sheet_id));
    fs.mkdirSync(destDir, { recursive: true });
    // Forward slashes work fine as real filesystem paths on Windows too, so
    // the portable form is used for the actual file write as well as the
    // value stored in the DB - one value, no separate "for fs" vs "for DB"
    // variants needed. Suffixed with the staged_sheet's own id (globally
    // unique, known up front) rather than just the revision id - a revision
    // can now be published into more than once (the "modify an existing
    // revision" flow), and a second round replacing the same sheet again
    // would otherwise reuse the exact same v<revisionId>_overlay.webp path,
    // silently overwriting a file an earlier sheet_versions row still points
    // at.
    const overlayDest = toPortablePath(path.join(destDir, `v${revision.id}_s${s.id}_overlay.webp`));
    try {
      await queue.enqueue(() => runPython(OVERLAY_SCRIPT, [oldVersion.pdf_path, s.pdf_path, overlayDest]));
      overlayPaths[s.id] = overlayDest;
    } catch (err) {
      console.error('Overlay generation failed for staged sheet', s.id, err);
    }
  }

  const publishTxn = db.transaction(() => {
    for (const s of toPublish) {
      const number = (s.corrected_number || s.ocr_number || '').trim();
      const title = (s.corrected_title || s.ocr_title || '').trim();

      let sheetId = s.match_sheet_id;
      if (s.match_status === 'new' || !sheetId) {
        const existing = db
          .prepare('SELECT id FROM sheets WHERE project_id = ? AND sheet_number = ?')
          .get(revision.project_id, number);
        if (existing) {
          sheetId = existing.id;
        } else {
          const result = db
            .prepare('INSERT INTO sheets (project_id, sheet_number, discipline) VALUES (?, ?, ?)')
            .run(revision.project_id, number, s.discipline);
          sheetId = result.lastInsertRowid;
        }
      } else {
        db.prepare('UPDATE sheets SET discipline = ? WHERE id = ?').run(s.discipline, sheetId);
      }

      const destDir = path.join(config.storageDir, 'projects', String(revision.project_id), 'sheets', String(sheetId));
      fs.mkdirSync(destDir, { recursive: true });
      // Same v<revisionId>_s<stagedSheetId> suffix reasoning as the overlay
      // path above - guarantees a fresh filename even when this revision has
      // already been published once before and is now being added to again.
      const destPdf = toPortablePath(path.join(destDir, `v${revision.id}_s${s.id}.pdf`));
      const destThumb = s.thumb_path ? toPortablePath(path.join(destDir, `v${revision.id}_s${s.id}_thumb.webp`)) : null;
      const destPreview = s.preview_path ? toPortablePath(path.join(destDir, `v${revision.id}_s${s.id}_preview.webp`)) : null;

      fs.renameSync(s.pdf_path, destPdf);
      if (destThumb) fs.renameSync(s.thumb_path, destThumb);
      if (destPreview) fs.renameSync(s.preview_path, destPreview);

      const versionResult = db
        .prepare(
          `INSERT INTO sheet_versions (sheet_id, revision_id, title, pdf_path, thumb_path, preview_path, overlay_path, ocr_confidence)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(sheetId, revision.id, title, destPdf, destThumb, destPreview, overlayPaths[s.id] || null, s.ocr_number_confidence);

      db.prepare('UPDATE sheets SET current_version_id = ? WHERE id = ?').run(versionResult.lastInsertRowid, sheetId);
    }

    for (const s of toDiscard) {
      for (const p of [s.pdf_path, s.thumb_path, s.preview_path]) {
        if (p) fs.rmSync(p, { force: true });
      }
    }

    db.prepare('DELETE FROM staged_sheets WHERE revision_id = ?').run(revision.id);
    // COALESCE keeps the original published_at if this revision was already
    // published before (the "modify" flow re-publishing additions) - only a
    // true first publish should set it.
    db.prepare("UPDATE revisions SET status = 'published', published_at = COALESCE(published_at, datetime('now')) WHERE id = ?").run(
      revision.id
    );
    db.prepare('INSERT INTO activity_log (project_id, actor, action, detail) VALUES (?, ?, ?, ?)').run(
      revision.project_id,
      String(req.session.user.id),
      'revision_publish',
      JSON.stringify({ revision_id: revision.id, sheet_count: toPublish.length })
    );
  });

  try {
    publishTxn();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Publish failed' });
  }

  res.json({ ok: true, published_sheets: toPublish.length });
});

module.exports = router;
