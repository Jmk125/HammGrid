const express = require('express');
const db = require('../db');
const { requireTakeoff } = require('../middleware/auth');

const router = express.Router();

router.patch('/:id', requireTakeoff, (req, res) => {
  const instance = db.prepare('SELECT * FROM take_off_instances WHERE id = ?').get(req.params.id);
  if (!instance) return res.status(404).json({ error: 'Not found' });

  const user = req.session.user;
  if (instance.created_by !== user.id && user.role === 'viewer') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { geometry, quantity, item_id, perimeter } = req.body;
  const hasGeometryUpdate = geometry !== undefined || quantity !== undefined;
  if (hasGeometryUpdate) {
    if (!geometry) return res.status(400).json({ error: 'geometry is required' });
    if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ error: 'quantity must be a positive number' });
    }
  }
  if (perimeter !== undefined && perimeter !== null && (typeof perimeter !== 'number' || !Number.isFinite(perimeter))) {
    return res.status(400).json({ error: 'perimeter must be a number if provided' });
  }

  // "Change Item" - move this instance to a different item, whole-shape only
  // (no partial/split support). The target must be the same take-off type,
  // since a stored quantity's unit (ft vs SF vs a plain count) depends on it.
  let targetItemId = instance.item_id;
  if (item_id !== undefined && Number(item_id) !== instance.item_id) {
    const currentItem = db.prepare('SELECT * FROM take_off_items WHERE id = ?').get(instance.item_id);
    const newItem = db
      .prepare('SELECT * FROM take_off_items WHERE id = ? AND project_id = ?')
      .get(item_id, currentItem.project_id);
    if (!newItem) return res.status(400).json({ error: 'Target item not found in this project' });
    if (newItem.type !== currentItem.type) {
      return res.status(400).json({ error: 'Target item must be the same take-off type' });
    }
    targetItemId = newItem.id;
  }

  db.prepare('UPDATE take_off_instances SET geometry = ?, quantity = ?, perimeter = ?, item_id = ? WHERE id = ?').run(
    hasGeometryUpdate ? JSON.stringify(geometry) : instance.geometry,
    hasGeometryUpdate ? quantity : instance.quantity,
    perimeter !== undefined ? perimeter : instance.perimeter,
    targetItemId,
    instance.id
  );
  const updated = db.prepare('SELECT * FROM take_off_instances WHERE id = ?').get(instance.id);
  res.json({ instance: { ...updated, geometry: JSON.parse(updated.geometry) } });
});

router.delete('/:id', requireTakeoff, (req, res) => {
  const instance = db.prepare('SELECT * FROM take_off_instances WHERE id = ?').get(req.params.id);
  if (!instance) return res.status(404).json({ error: 'Not found' });

  const user = req.session.user;
  if (instance.created_by !== user.id && user.role === 'viewer') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  db.prepare('DELETE FROM take_off_instances WHERE id = ?').run(instance.id);
  res.json({ ok: true });
});

module.exports = router;
