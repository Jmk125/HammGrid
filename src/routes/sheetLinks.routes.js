const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

function parseRect(rect) {
  if (!rect || typeof rect !== 'object') return null;
  const x = Number(rect.x);
  const y = Number(rect.y);
  const w = Number(rect.w);
  const h = Number(rect.h);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

function sheetInSameProject(sheetId, projectId) {
  return db.prepare('SELECT id FROM sheets WHERE id = ? AND project_id = ?').get(sheetId, projectId);
}

router.get('/', requireAuth, (req, res) => {
  const links = db
    .prepare(
      `SELECT sl.id, sl.source_sheet_id, sl.target_sheet_id, sl.rect, sl.label,
              ts.sheet_number AS target_sheet_number, sv.title AS target_title
       FROM sheet_links sl
       JOIN sheets source ON source.id = sl.source_sheet_id
       JOIN sheets ts ON ts.id = sl.target_sheet_id
       LEFT JOIN sheet_versions sv ON sv.id = ts.current_version_id
       WHERE sl.source_sheet_id = ? AND source.project_id = ?
       ORDER BY sl.created_at, sl.id`
    )
    .all(req.params.sheetId, req.params.projectId);

  res.json({
    links: links.map((link) => ({
      ...link,
      rect: JSON.parse(link.rect),
    })),
  });
});

router.post('/', requireRole('admin', 'editor'), (req, res) => {
  const { target_sheet_id, rect, label, source_version_id = null } = req.body;
  const sourceSheetId = Number(req.params.sheetId);
  const targetSheetId = Number(target_sheet_id);
  const projectId = Number(req.params.projectId);
  const parsedRect = parseRect(rect);

  if (!parsedRect) return res.status(400).json({ error: 'rect must include numeric x, y, w, and h values' });
  if (!sheetInSameProject(sourceSheetId, projectId)) return res.status(404).json({ error: 'Source sheet not found' });
  if (!sheetInSameProject(targetSheetId, projectId)) return res.status(400).json({ error: 'Target sheet must be in the same project' });

  const result = db
    .prepare(
      `INSERT INTO sheet_links (project_id, source_sheet_id, source_version_id, target_sheet_id, rect, label, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(projectId, sourceSheetId, source_version_id, targetSheetId, JSON.stringify(parsedRect), label || null, req.session.user.id);

  const link = db.prepare('SELECT * FROM sheet_links WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ link: { ...link, rect: JSON.parse(link.rect) } });
});

router.delete('/:linkId', requireRole('admin', 'editor'), (req, res) => {
  const result = db
    .prepare(
      `DELETE FROM sheet_links
       WHERE id = ? AND project_id = ? AND source_sheet_id = ?`
    )
    .run(req.params.linkId, req.params.projectId, req.params.sheetId);
  if (result.changes === 0) return res.status(404).json({ error: 'Link not found' });
  res.json({ ok: true });
});

module.exports = router;
