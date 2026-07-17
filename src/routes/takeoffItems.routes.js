const express = require('express');
const db = require('../db');
const { requireTakeoff } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });
const TYPES = ['linear', 'perimeter', 'area', 'count'];
const SHAPES = ['square', 'circle', 'triangle', 'diamond'];

// created_by is the item's author, but take-off content has no private/
// published split (confirmed: shared among all takeoff-enabled users) - the
// "isAuthor || role !== 'viewer'" check below is only about who may rename/
// delete, not who may see it.
function canMutate(item, user) {
  return item.created_by === user.id || user.role !== 'viewer';
}

router.get('/', requireTakeoff, (req, res) => {
  const items = db
    .prepare(
      `SELECT ti.*, COALESCE(SUM(inst.quantity), 0) AS total_quantity, COUNT(inst.id) AS instance_count
       FROM take_off_items ti
       LEFT JOIN take_off_instances inst ON inst.item_id = ti.id
       WHERE ti.project_id = ?
       GROUP BY ti.id
       ORDER BY ti.name`
    )
    .all(req.params.projectId);
  res.json({ items });
});

router.get('/:itemId/breakdown', requireTakeoff, (req, res) => {
  const item = db
    .prepare('SELECT id FROM take_off_items WHERE id = ? AND project_id = ?')
    .get(req.params.itemId, req.params.projectId);
  if (!item) return res.status(404).json({ error: 'Not found' });

  const sheets = db
    .prepare(
      `SELECT s.id AS sheet_id, s.sheet_number, SUM(inst.quantity) AS quantity
       FROM take_off_instances inst
       JOIN sheets s ON s.id = inst.sheet_id
       WHERE inst.item_id = ?
       GROUP BY s.id
       ORDER BY s.sheet_number`
    )
    .all(item.id);
  res.json({ sheets });
});

router.post('/', requireTakeoff, (req, res) => {
  const { name, type, color, shape } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  if (!TYPES.includes(type)) return res.status(400).json({ error: `type must be one of: ${TYPES.join(', ')}` });
  if (!color) return res.status(400).json({ error: 'color is required' });
  if (type === 'count' && !SHAPES.includes(shape)) {
    return res.status(400).json({ error: `shape must be one of: ${SHAPES.join(', ')} for a count item` });
  }

  const result = db
    .prepare(`INSERT INTO take_off_items (project_id, name, type, shape, color, created_by) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(req.params.projectId, name.trim(), type, type === 'count' ? shape : null, color, req.session.user.id);

  const item = db.prepare('SELECT * FROM take_off_items WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ item: { ...item, total_quantity: 0, instance_count: 0 } });
});

router.patch('/:itemId', requireTakeoff, (req, res) => {
  const item = db
    .prepare('SELECT * FROM take_off_items WHERE id = ? AND project_id = ?')
    .get(req.params.itemId, req.params.projectId);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (!canMutate(item, req.session.user)) return res.status(403).json({ error: 'Forbidden' });

  const { name, color } = req.body;
  db.prepare('UPDATE take_off_items SET name = ?, color = ? WHERE id = ?').run(
    name !== undefined && name.trim() ? name.trim() : item.name,
    color !== undefined ? color : item.color,
    item.id
  );
  const updated = db.prepare('SELECT * FROM take_off_items WHERE id = ?').get(item.id);
  res.json({ item: updated });
});

router.delete('/:itemId', requireTakeoff, (req, res) => {
  const item = db
    .prepare('SELECT * FROM take_off_items WHERE id = ? AND project_id = ?')
    .get(req.params.itemId, req.params.projectId);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (!canMutate(item, req.session.user)) return res.status(403).json({ error: 'Forbidden' });

  db.prepare('DELETE FROM take_off_items WHERE id = ?').run(item.id); // cascades instances
  res.json({ ok: true });
});

module.exports = router;
