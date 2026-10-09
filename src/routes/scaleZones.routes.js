const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

function validateZoneBody(body) {
  const { label, scale_feet_per_inch, x, y, width, height } = body;
  if (typeof label !== 'string' || !label.trim()) return 'label is required';
  if (typeof scale_feet_per_inch !== 'number' || !Number.isFinite(scale_feet_per_inch) || scale_feet_per_inch <= 0) {
    return 'scale_feet_per_inch must be a positive number';
  }
  for (const [key, val] of Object.entries({ x, y, width, height })) {
    if (typeof val !== 'number' || !Number.isFinite(val)) return `${key} must be a number`;
  }
  if (width <= 0 || height <= 0) return 'width and height must be positive';
  return null;
}

// Viewers can see zone coverage same as they already see the sheet's base
// scale - this is read-only reference geometry, not a takeoff/measurement.
router.get('/', requireAuth, (req, res) => {
  const zones = db
    .prepare('SELECT * FROM scale_zones WHERE sheet_id = ? ORDER BY created_at')
    .all(req.params.sheetId);
  res.json({ zones });
});

// Same gate as PATCH /api/projects/:projectId/sheets/:sheetId, which is
// where the sheet's single scale_feet_per_inch is edited - scale zones are
// the same kind of sheet-calibration data, just one-to-many.
router.post('/', requireRole('admin', 'editor'), (req, res) => {
  const error = validateZoneBody(req.body);
  if (error) return res.status(400).json({ error });

  const sheet = db.prepare('SELECT id FROM sheets WHERE id = ? AND project_id = ?').get(req.params.sheetId, req.params.projectId);
  if (!sheet) return res.status(404).json({ error: 'Sheet not found' });

  const { label, scale_feet_per_inch, x, y, width, height } = req.body;
  const result = db
    .prepare(
      `INSERT INTO scale_zones (sheet_id, label, scale_feet_per_inch, x, y, width, height, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(sheet.id, label.trim(), scale_feet_per_inch, x, y, width, height, req.session.user.id);
  const zone = db.prepare('SELECT * FROM scale_zones WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ zone });
});

router.patch('/:id', requireRole('admin', 'editor'), (req, res) => {
  const zone = db.prepare('SELECT * FROM scale_zones WHERE id = ? AND sheet_id = ?').get(req.params.id, req.params.sheetId);
  if (!zone) return res.status(404).json({ error: 'Not found' });

  const merged = {
    label: req.body.label !== undefined ? req.body.label : zone.label,
    scale_feet_per_inch: req.body.scale_feet_per_inch !== undefined ? req.body.scale_feet_per_inch : zone.scale_feet_per_inch,
    x: req.body.x !== undefined ? req.body.x : zone.x,
    y: req.body.y !== undefined ? req.body.y : zone.y,
    width: req.body.width !== undefined ? req.body.width : zone.width,
    height: req.body.height !== undefined ? req.body.height : zone.height,
  };
  const error = validateZoneBody(merged);
  if (error) return res.status(400).json({ error });

  db.prepare(
    `UPDATE scale_zones SET label = ?, scale_feet_per_inch = ?, x = ?, y = ?, width = ?, height = ? WHERE id = ?`
  ).run(merged.label.trim(), merged.scale_feet_per_inch, merged.x, merged.y, merged.width, merged.height, zone.id);
  const updated = db.prepare('SELECT * FROM scale_zones WHERE id = ?').get(zone.id);
  res.json({ zone: updated });
});

router.delete('/:id', requireRole('admin', 'editor'), (req, res) => {
  const zone = db.prepare('SELECT * FROM scale_zones WHERE id = ? AND sheet_id = ?').get(req.params.id, req.params.sheetId);
  if (!zone) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM scale_zones WHERE id = ?').run(zone.id);
  res.json({ ok: true });
});

// Bulk-remove every zone on this sheet - used when the user picks a single
// concrete scale from the dropdown while zones exist (leaving "Multiple"
// mode is an explicit, confirmed action - see the sheet.js confirm prompt).
router.delete('/', requireRole('admin', 'editor'), (req, res) => {
  const result = db.prepare('DELETE FROM scale_zones WHERE sheet_id = ?').run(req.params.sheetId);
  res.json({ ok: true, deleted: result.changes });
});

module.exports = router;
