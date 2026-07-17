const express = require('express');
const db = require('../db');
const { requireTakeoff } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.get('/', requireTakeoff, (req, res) => {
  const instances = db
    .prepare(
      `SELECT inst.*, ti.name AS item_name, ti.color AS item_color, ti.type AS item_type, ti.shape AS item_shape
       FROM take_off_instances inst
       JOIN take_off_items ti ON ti.id = inst.item_id
       WHERE inst.sheet_id = ?
       ORDER BY inst.created_at`
    )
    .all(req.params.sheetId);
  res.json({
    instances: instances.map((i) => ({ ...i, geometry: JSON.parse(i.geometry) })),
  });
});

router.post('/', requireTakeoff, (req, res) => {
  const { item_id, geometry, quantity } = req.body;
  if (!geometry) return res.status(400).json({ error: 'geometry is required' });
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) {
    return res.status(400).json({ error: 'quantity must be a positive number' });
  }

  const item = db
    .prepare('SELECT id FROM take_off_items WHERE id = ? AND project_id = ?')
    .get(item_id, req.params.projectId);
  if (!item) return res.status(400).json({ error: 'Take-off item not found in this project' });

  const result = db
    .prepare(
      `INSERT INTO take_off_instances (item_id, sheet_id, geometry, quantity, created_by)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(item.id, req.params.sheetId, JSON.stringify(geometry), quantity, req.session.user.id);

  const instance = db.prepare('SELECT * FROM take_off_instances WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ instance: { ...instance, geometry: JSON.parse(instance.geometry) } });
});

// Bulk-remove every instance of one item on this sheet specifically (the
// pane's "Remove from this sheet" action) - other sheets are untouched.
// Reuses the same author-or-non-viewer trust bar as item rename/delete.
router.delete('/', requireTakeoff, (req, res) => {
  const itemId = Number(req.query.item_id);
  if (!itemId) return res.status(400).json({ error: 'item_id query param is required' });

  const item = db
    .prepare('SELECT * FROM take_off_items WHERE id = ? AND project_id = ?')
    .get(itemId, req.params.projectId);
  if (!item) return res.status(404).json({ error: 'Take-off item not found in this project' });
  if (item.created_by !== req.session.user.id && req.session.user.role === 'viewer') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const result = db
    .prepare('DELETE FROM take_off_instances WHERE item_id = ? AND sheet_id = ?')
    .run(itemId, req.params.sheetId);
  res.json({ ok: true, deleted: result.changes });
});

module.exports = router;
