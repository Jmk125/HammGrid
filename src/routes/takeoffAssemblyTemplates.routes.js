const express = require('express');
const db = require('../db');
const { requireTakeoff } = require('../middleware/auth');

// Global, not project-scoped (mounted at /api/take-off-assembly-templates) -
// just a name and the 5 slots' default labels, never linked to real items.
// take_off_assemblies (project-scoped, its own route file) is what actually
// gets linked/armed/placed with. Same requireTakeoff gate and
// creator-or-non-viewer mutate rule as takeoffTemplates.routes.js.
const router = express.Router();
const LABEL_FIELDS = ['area_label', 'top_label', 'bottom_label', 'left_label', 'right_label'];

function canMutate(template, user) {
  return template.created_by === user.id || user.role !== 'viewer';
}

router.get('/', requireTakeoff, (req, res) => {
  const templates = db.prepare('SELECT * FROM take_off_assembly_templates ORDER BY name').all();
  res.json({ templates });
});

router.post('/', requireTakeoff, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

  const labels = LABEL_FIELDS.map((field) => (req.body[field] ? String(req.body[field]).trim() : null)).map(
    (val, i) => val || ['Area', 'Head', 'Sill', 'Left Jamb', 'Right Jamb'][i]
  );

  const result = db
    .prepare(
      `INSERT INTO take_off_assembly_templates (name, area_label, top_label, bottom_label, left_label, right_label, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(name.trim(), ...labels, req.session.user.id);
  const template = db.prepare('SELECT * FROM take_off_assembly_templates WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ template });
});

router.patch('/:id', requireTakeoff, (req, res) => {
  const template = db.prepare('SELECT * FROM take_off_assembly_templates WHERE id = ?').get(req.params.id);
  if (!template) return res.status(404).json({ error: 'Not found' });
  if (!canMutate(template, req.session.user)) return res.status(403).json({ error: 'Forbidden' });

  const name = req.body.name !== undefined && req.body.name.trim() ? req.body.name.trim() : template.name;
  const labels = LABEL_FIELDS.map((field) =>
    req.body[field] !== undefined ? String(req.body[field]).trim() || template[field] : template[field]
  );
  db.prepare(
    `UPDATE take_off_assembly_templates SET name = ?, area_label = ?, top_label = ?, bottom_label = ?, left_label = ?, right_label = ? WHERE id = ?`
  ).run(name, ...labels, template.id);
  const updated = db.prepare('SELECT * FROM take_off_assembly_templates WHERE id = ?').get(template.id);
  res.json({ template: updated });
});

router.delete('/:id', requireTakeoff, (req, res) => {
  const template = db.prepare('SELECT * FROM take_off_assembly_templates WHERE id = ?').get(req.params.id);
  if (!template) return res.status(404).json({ error: 'Not found' });
  if (!canMutate(template, req.session.user)) return res.status(403).json({ error: 'Forbidden' });

  db.prepare('DELETE FROM take_off_assembly_templates WHERE id = ?').run(template.id);
  res.json({ ok: true });
});

module.exports = router;
