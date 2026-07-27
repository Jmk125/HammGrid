const express = require('express');
const db = require('../db');
const { requireTakeoff } = require('../middleware/auth');
const { validateTakeoffProperties } = require('../lib/takeoffProperties');

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
      `SELECT ti.*, COALESCE(SUM(inst.quantity), 0) AS total_quantity, COALESCE(SUM(inst.perimeter), 0) AS total_perimeter,
              COUNT(inst.id) AS instance_count
       FROM take_off_items ti
       LEFT JOIN take_off_instances inst ON inst.item_id = ti.id
       WHERE ti.project_id = ?
       GROUP BY ti.id
       ORDER BY ti.name`
    )
    .all(req.params.projectId);
  res.json({ items });
});

// Project-wide instances grouped by sheet+item - backs takeoffs.html's "By
// Sheet" view (as opposed to the default "By Take-off" view above, which is
// grouped by item). Same underlying data, different grouping.
router.get('/by-sheet', requireTakeoff, (req, res) => {
  const rows = db
    .prepare(
      `SELECT s.id AS sheet_id, s.sheet_number, s.discipline,
              ti.id AS item_id, ti.name AS item_name, ti.color AS item_color, ti.type AS item_type, ti.shape AS item_shape,
              ti.properties AS item_properties, ti.formula AS item_formula, ti.output_label AS item_output_label,
              SUM(inst.quantity) AS quantity, SUM(inst.perimeter) AS perimeter
       FROM take_off_instances inst
       JOIN take_off_items ti ON ti.id = inst.item_id
       JOIN sheets s ON s.id = inst.sheet_id
       WHERE ti.project_id = ?
       GROUP BY s.id, ti.id
       ORDER BY s.sheet_number, ti.name`
    )
    .all(req.params.projectId);
  res.json({ rows });
});

router.get('/:itemId/breakdown', requireTakeoff, (req, res) => {
  const item = db
    .prepare('SELECT id FROM take_off_items WHERE id = ? AND project_id = ?')
    .get(req.params.itemId, req.params.projectId);
  if (!item) return res.status(404).json({ error: 'Not found' });

  const sheets = db
    .prepare(
      `SELECT s.id AS sheet_id, s.sheet_number, SUM(inst.quantity) AS quantity, SUM(inst.perimeter) AS perimeter
       FROM take_off_instances inst
       JOIN sheets s ON s.id = inst.sheet_id
       WHERE inst.item_id = ?
       GROUP BY s.id
       ORDER BY s.sheet_number`
    )
    .all(item.id);
  res.json({ sheets });
});

// Returns { ok: true, folderId } or { ok: false, error } - null/undefined
// both mean "no folder" (the default); anything else must be a real folder
// belonging to this project.
function resolveFolderId(rawFolderId, projectId) {
  if (rawFolderId === undefined || rawFolderId === null || rawFolderId === '') return { ok: true, folderId: null };
  const folder = db.prepare('SELECT id FROM take_off_folders WHERE id = ? AND project_id = ?').get(rawFolderId, projectId);
  if (!folder) return { ok: false, error: 'Folder not found in this project' };
  return { ok: true, folderId: folder.id };
}

router.post('/', requireTakeoff, (req, res) => {
  const { name, type, color, shape, properties, formula, output_label, folder_id } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  if (!TYPES.includes(type)) return res.status(400).json({ error: `type must be one of: ${TYPES.join(', ')}` });
  if (!color) return res.status(400).json({ error: 'color is required' });
  if (type === 'count' && !SHAPES.includes(shape)) {
    return res.status(400).json({ error: `shape must be one of: ${SHAPES.join(', ')} for a count item` });
  }
  const propsResult = validateTakeoffProperties(properties);
  if (!propsResult.ok) return res.status(400).json({ error: propsResult.error });
  const folderResult = resolveFolderId(folder_id, req.params.projectId);
  if (!folderResult.ok) return res.status(400).json({ error: folderResult.error });

  const result = db
    .prepare(
      `INSERT INTO take_off_items (project_id, name, type, shape, color, properties, formula, output_label, folder_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.params.projectId,
      name.trim(),
      type,
      type === 'count' ? shape : null,
      color,
      JSON.stringify(propsResult.properties),
      formula ? String(formula).trim() || null : null,
      output_label ? String(output_label).trim() || null : null,
      folderResult.folderId,
      req.session.user.id
    );

  const item = db.prepare('SELECT * FROM take_off_items WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ item: { ...item, total_quantity: 0, instance_count: 0 } });
});

router.patch('/:itemId', requireTakeoff, (req, res) => {
  const item = db
    .prepare('SELECT * FROM take_off_items WHERE id = ? AND project_id = ?')
    .get(req.params.itemId, req.params.projectId);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (!canMutate(item, req.session.user)) return res.status(403).json({ error: 'Forbidden' });

  const { name, color, properties, formula, output_label, folder_id } = req.body;
  let propsJson = item.properties;
  if (properties !== undefined) {
    const propsResult = validateTakeoffProperties(properties);
    if (!propsResult.ok) return res.status(400).json({ error: propsResult.error });
    propsJson = JSON.stringify(propsResult.properties);
  }
  let folderId = item.folder_id;
  if (folder_id !== undefined) {
    const folderResult = resolveFolderId(folder_id, req.params.projectId);
    if (!folderResult.ok) return res.status(400).json({ error: folderResult.error });
    folderId = folderResult.folderId;
  }
  db.prepare(
    'UPDATE take_off_items SET name = ?, color = ?, properties = ?, formula = ?, output_label = ?, folder_id = ? WHERE id = ?'
  ).run(
    name !== undefined && name.trim() ? name.trim() : item.name,
    color !== undefined ? color : item.color,
    propsJson,
    formula !== undefined ? String(formula).trim() || null : item.formula,
    output_label !== undefined ? String(output_label).trim() || null : item.output_label,
    folderId,
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
