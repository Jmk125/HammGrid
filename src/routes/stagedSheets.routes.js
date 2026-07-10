const express = require('express');
const fs = require('fs');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { deriveDiscipline } = require('../lib/matching');
const { streamFile } = require('../lib/streamFile');

const router = express.Router();
const MATCH_STATUSES = ['pending', 'new', 'replacement', 'suspicious', 'ignored'];

function getStagedOr404(req, res) {
  const staged = db.prepare('SELECT * FROM staged_sheets WHERE id = ?').get(req.params.id);
  if (!staged) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  return staged;
}

function serveFile(pathColumn, contentType) {
  return (req, res) => {
    const row = db.prepare(`SELECT ${pathColumn} AS p FROM staged_sheets WHERE id = ?`).get(req.params.id);
    if (!row || !row.p) return res.status(404).end();
    streamFile(res, row.p, contentType);
  };
}

router.get('/:id/thumb', requireAuth, serveFile('thumb_path', 'image/webp'));
router.get('/:id/preview', requireAuth, serveFile('preview_path', 'image/webp'));
router.get('/:id/pdf', requireAuth, serveFile('pdf_path', 'application/pdf'));

router.patch('/:id', requireRole('admin', 'editor'), (req, res) => {
  const staged = getStagedOr404(req, res);
  if (!staged) return;
  const revision = db.prepare('SELECT status FROM revisions WHERE id = ?').get(staged.revision_id);
  if (revision.status !== 'draft') {
    return res.status(400).json({ error: 'Revision is already published' });
  }

  const { corrected_number, corrected_title, discipline, match_status, match_sheet_id } = req.body;
  if (match_status !== undefined && !MATCH_STATUSES.includes(match_status)) {
    return res.status(400).json({ error: `match_status must be one of: ${MATCH_STATUSES.join(', ')}` });
  }

  const next = {
    corrected_number: corrected_number !== undefined ? corrected_number : staged.corrected_number,
    corrected_title: corrected_title !== undefined ? corrected_title : staged.corrected_title,
    discipline: discipline !== undefined ? discipline : staged.discipline,
    match_status: match_status !== undefined ? match_status : staged.match_status,
    match_sheet_id: match_sheet_id !== undefined ? match_sheet_id : staged.match_sheet_id,
  };

  // If the number changed but discipline wasn't explicitly given, re-derive it
  // rather than leaving the stale (or null) discipline from the prior number.
  if (corrected_number !== undefined && discipline === undefined) {
    const revision = db.prepare('SELECT project_id FROM revisions WHERE id = ?').get(staged.revision_id);
    const project = db.prepare('SELECT discipline_prefix_map FROM projects WHERE id = ?').get(revision.project_id);
    next.discipline = deriveDiscipline(next.corrected_number, JSON.parse(project.discipline_prefix_map));
  }

  if (next.match_status === 'new' || next.match_status === 'ignored') {
    next.match_sheet_id = null;
  } else if (next.match_status !== 'pending' && !next.match_sheet_id) {
    return res.status(400).json({ error: 'match_sheet_id is required for replacement/suspicious status' });
  }

  db.prepare(
    `UPDATE staged_sheets SET corrected_number = ?, corrected_title = ?, discipline = ?, match_status = ?, match_sheet_id = ? WHERE id = ?`
  ).run(next.corrected_number, next.corrected_title, next.discipline, next.match_status, next.match_sheet_id, staged.id);

  const updated = db.prepare('SELECT * FROM staged_sheets WHERE id = ?').get(staged.id);
  res.json({ staged_sheet: updated });
});

router.delete('/:id', requireRole('admin', 'editor'), (req, res) => {
  const staged = getStagedOr404(req, res);
  if (!staged) return;
  const revision = db.prepare('SELECT status FROM revisions WHERE id = ?').get(staged.revision_id);
  if (revision.status !== 'draft') {
    return res.status(400).json({ error: 'Revision is already published' });
  }

  db.prepare('DELETE FROM staged_sheets WHERE id = ?').run(staged.id);
  for (const p of [staged.pdf_path, staged.thumb_path, staged.preview_path]) {
    if (p) fs.rm(p, { force: true }, () => {});
  }
  res.json({ ok: true });
});

module.exports = router;
