const express = require('express');
const db = require('../db');
const { requireTakeoff } = require('../middleware/auth');

// Project-scoped (mounted at /api/projects/:projectId/take-off-assemblies) -
// the live, linkable assembly shown in the sheet pane. Same requireTakeoff
// gate and creator-or-non-viewer mutate rule as takeoffItems.routes.js.
const router = express.Router({ mergeParams: true });
const LABEL_FIELDS = ['area_label', 'top_label', 'bottom_label', 'left_label', 'right_label'];
const LINK_FIELDS = ['area_item_id', 'top_item_id', 'bottom_item_id', 'left_item_id', 'right_item_id'];
const DEFAULT_LABELS = ['Area', 'Head', 'Sill', 'Left Jamb', 'Right Jamb'];
// The area slot takes a box's full polygon (an area-type item); the 4 edge
// slots each take a single 2-point line segment, which is inherently a
// linear measurement - perimeter/count items aren't valid edge targets.
const REQUIRED_TYPE_BY_LINK_FIELD = {
  area_item_id: 'area',
  top_item_id: 'linear',
  bottom_item_id: 'linear',
  left_item_id: 'linear',
  right_item_id: 'linear',
};

function canMutate(assembly, user) {
  return assembly.created_by === user.id || user.role !== 'viewer';
}

// Returns { ok: true, itemId } or { ok: false, error }. null/undefined both
// mean "unlink this slot" (the default, and always valid).
function resolveLinkField(field, rawItemId, projectId) {
  if (rawItemId === undefined || rawItemId === null || rawItemId === '') return { ok: true, itemId: null };
  const item = db.prepare('SELECT id, type FROM take_off_items WHERE id = ? AND project_id = ?').get(rawItemId, projectId);
  if (!item) return { ok: false, error: `${field}: item not found in this project` };
  const requiredType = REQUIRED_TYPE_BY_LINK_FIELD[field];
  if (item.type !== requiredType) return { ok: false, error: `${field} must link to a ${requiredType} item` };
  return { ok: true, itemId: item.id };
}

router.get('/', requireTakeoff, (req, res) => {
  const assemblies = db
    .prepare('SELECT * FROM take_off_assemblies WHERE project_id = ? ORDER BY name')
    .all(req.params.projectId);
  res.json({ assemblies });
});

router.post('/', requireTakeoff, (req, res) => {
  const { name, template_id } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

  let labels = DEFAULT_LABELS;
  if (template_id) {
    const template = db.prepare('SELECT * FROM take_off_assembly_templates WHERE id = ?').get(template_id);
    if (!template) return res.status(400).json({ error: 'Assembly template not found' });
    labels = LABEL_FIELDS.map((f) => template[f]);
  }

  const result = db
    .prepare(
      `INSERT INTO take_off_assemblies (project_id, name, area_label, top_label, bottom_label, left_label, right_label, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(req.params.projectId, name.trim(), ...labels, req.session.user.id);
  const assembly = db.prepare('SELECT * FROM take_off_assemblies WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ assembly });
});

router.patch('/:id', requireTakeoff, (req, res) => {
  const assembly = db
    .prepare('SELECT * FROM take_off_assemblies WHERE id = ? AND project_id = ?')
    .get(req.params.id, req.params.projectId);
  if (!assembly) return res.status(404).json({ error: 'Not found' });
  if (!canMutate(assembly, req.session.user)) return res.status(403).json({ error: 'Forbidden' });

  const name = req.body.name !== undefined && req.body.name.trim() ? req.body.name.trim() : assembly.name;
  const labels = LABEL_FIELDS.map((field) =>
    req.body[field] !== undefined ? String(req.body[field]).trim() || assembly[field] : assembly[field]
  );

  const links = [];
  for (const field of LINK_FIELDS) {
    if (req.body[field] === undefined) {
      links.push(assembly[field]);
      continue;
    }
    const result = resolveLinkField(field, req.body[field], req.params.projectId);
    if (!result.ok) return res.status(400).json({ error: result.error });
    links.push(result.itemId);
  }

  db.prepare(
    `UPDATE take_off_assemblies SET name = ?, area_label = ?, top_label = ?, bottom_label = ?, left_label = ?, right_label = ?,
     area_item_id = ?, top_item_id = ?, bottom_item_id = ?, left_item_id = ?, right_item_id = ? WHERE id = ?`
  ).run(name, ...labels, ...links, assembly.id);
  const updated = db.prepare('SELECT * FROM take_off_assemblies WHERE id = ?').get(assembly.id);
  res.json({ assembly: updated });
});

router.delete('/:id', requireTakeoff, (req, res) => {
  const assembly = db
    .prepare('SELECT * FROM take_off_assemblies WHERE id = ? AND project_id = ?')
    .get(req.params.id, req.params.projectId);
  if (!assembly) return res.status(404).json({ error: 'Not found' });
  if (!canMutate(assembly, req.session.user)) return res.status(403).json({ error: 'Forbidden' });

  db.prepare('DELETE FROM take_off_assemblies WHERE id = ?').run(assembly.id); // never touches linked items/instances
  res.json({ ok: true });
});

module.exports = router;
