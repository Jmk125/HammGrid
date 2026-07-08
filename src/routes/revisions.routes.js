const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../db');
const config = require('../config');
const { requireAuth, requireRole } = require('../middleware/auth');
const { runPython } = require('../lib/pyRunner');
const queue = require('../lib/queue');
const { computeMatch, needsAttention } = require('../lib/matching');

const router = express.Router({ mergeParams: true });

const BURST_SCRIPT = path.join(__dirname, '..', '..', 'pyproc', 'burst.py');
const OCR_SCRIPT = path.join(__dirname, '..', '..', 'pyproc', 'ocr_region.py');

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

router.post('/:revisionId/upload', requireRole('admin', 'editor'), upload.array('files'), async (req, res) => {
  const revision = getRevisionOr404(req, res);
  if (!revision) return;
  if (revision.status !== 'draft') {
    return res.status(400).json({ error: 'Revision is already published' });
  }
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No PDF files uploaded' });
  }

  const maxOrderRow = db
    .prepare('SELECT COALESCE(MAX(upload_order), 0) AS maxOrder FROM staged_sheets WHERE revision_id = ?')
    .get(revision.id);
  let nextOrder = maxOrderRow.maxOrder;

  const insertStmt = db.prepare(
    `INSERT INTO staged_sheets (revision_id, upload_order, pdf_path, thumb_path, preview_path, page_width_pt, page_height_pt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const createdIds = [];
  try {
    for (const file of req.files) {
      const batchDir = path.join(
        config.storageDir,
        'staging',
        String(revision.id),
        crypto.randomUUID().slice(0, 8)
      );
      let pages;
      try {
        pages = await queue.enqueue(() => runPython(BURST_SCRIPT, [file.path, batchDir]));
      } finally {
        fs.unlink(file.path, () => {});
      }
      for (const page of pages) {
        nextOrder += 1;
        const result = insertStmt.run(
          revision.id,
          nextOrder,
          page.pdf_path,
          page.thumb_path,
          page.preview_path,
          page.page_width_pt,
          page.page_height_pt
        );
        createdIds.push(result.lastInsertRowid);
      }
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to process uploaded PDF(s)' });
  }

  res.status(201).json({ staged_sheet_ids: createdIds });
});

router.get('/:revisionId/staged', requireAuth, (req, res) => {
  const revision = getRevisionOr404(req, res);
  if (!revision) return;
  const rows = db
    .prepare('SELECT * FROM staged_sheets WHERE revision_id = ? ORDER BY upload_order')
    .all(revision.id);
  res.json({ staged_sheets: rows.map(withStagedFlags) });
});

router.post('/:revisionId/ocr', requireRole('admin', 'editor'), async (req, res) => {
  const revision = getRevisionOr404(req, res);
  if (!revision) return;
  if (revision.status !== 'draft') {
    return res.status(400).json({ error: 'Revision is already published' });
  }

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

  const project = db.prepare('SELECT discipline_prefix_map FROM projects WHERE id = ?').get(revision.project_id);
  const prefixMap = JSON.parse(project.discipline_prefix_map);

  const updateStmt = db.prepare(
    `UPDATE staged_sheets SET
       region_scope = ?, ocr_number = ?, ocr_number_confidence = ?,
       ocr_title = ?, ocr_title_confidence = ?, discipline = ?,
       match_status = ?, match_sheet_id = ?
     WHERE id = ?`
  );

  const updated = [];
  try {
    for (const id of staged_sheet_ids) {
      const staged = db.prepare('SELECT * FROM staged_sheets WHERE id = ? AND revision_id = ?').get(id, revision.id);
      if (!staged) continue;

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
      updated.push(id);
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'OCR failed', updated });
  }

  res.json({ updated });
});

router.post('/:revisionId/publish', requireRole('admin', 'editor'), (req, res) => {
  const revision = getRevisionOr404(req, res);
  if (!revision) return;
  if (revision.status !== 'draft') {
    return res.status(400).json({ error: 'Revision is already published' });
  }

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
      const destPdf = path.join(destDir, `v${revision.id}.pdf`);
      const destThumb = s.thumb_path ? path.join(destDir, `v${revision.id}_thumb.webp`) : null;
      const destPreview = s.preview_path ? path.join(destDir, `v${revision.id}_preview.webp`) : null;

      fs.renameSync(s.pdf_path, destPdf);
      if (destThumb) fs.renameSync(s.thumb_path, destThumb);
      if (destPreview) fs.renameSync(s.preview_path, destPreview);

      const versionResult = db
        .prepare(
          `INSERT INTO sheet_versions (sheet_id, revision_id, title, pdf_path, thumb_path, preview_path, ocr_confidence)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(sheetId, revision.id, title, destPdf, destThumb, destPreview, s.ocr_number_confidence);

      db.prepare('UPDATE sheets SET current_version_id = ? WHERE id = ?').run(versionResult.lastInsertRowid, sheetId);
    }

    for (const s of toDiscard) {
      for (const p of [s.pdf_path, s.thumb_path, s.preview_path]) {
        if (p) fs.rmSync(p, { force: true });
      }
    }

    db.prepare('DELETE FROM staged_sheets WHERE revision_id = ?').run(revision.id);
    db.prepare("UPDATE revisions SET status = 'published', published_at = datetime('now') WHERE id = ?").run(
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
