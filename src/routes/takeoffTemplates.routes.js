const express = require('express');
const db = require('../db');
const { requireTakeoff } = require('../middleware/auth');
const { validateTakeoffProperties } = require('../lib/takeoffProperties');

// Global, not project-scoped (mounted at /api/take-off-templates, not under
// /api/projects/:projectId/...) - these represent a firm's standardized
// assemblies reused across every job, not one project's data. Same
// requireTakeoff gate and creator-or-non-viewer mutate rule as
// takeoffItems.routes.js, just without the project_id filter/param.
const router = express.Router();
const TYPES = ['linear', 'perimeter', 'area', 'count'];
const SHAPES = ['square', 'circle', 'triangle', 'diamond'];

function canMutate(template, user) {
  return template.created_by === user.id || user.role !== 'viewer';
}

// Returns { ok: true, folderId } or { ok: false, error } - null/undefined
// both mean "no folder" (the default).
function resolveFolderId(rawFolderId) {
  if (rawFolderId === undefined || rawFolderId === null || rawFolderId === '') return { ok: true, folderId: null };
  const folder = db.prepare('SELECT id FROM take_off_template_folders WHERE id = ?').get(rawFolderId);
  if (!folder) return { ok: false, error: 'Folder not found' };
  return { ok: true, folderId: folder.id };
}

router.get('/', requireTakeoff, (req, res) => {
  const templates = db.prepare('SELECT * FROM take_off_templates ORDER BY name').all();
  res.json({ templates });
});

router.post('/', requireTakeoff, (req, res) => {
  const { name, type, color, shape, properties, formula, output_label, folder_id } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  if (!TYPES.includes(type)) return res.status(400).json({ error: `type must be one of: ${TYPES.join(', ')}` });
  if (!color) return res.status(400).json({ error: 'color is required' });
  if (type === 'count' && !SHAPES.includes(shape)) {
    return res.status(400).json({ error: `shape must be one of: ${SHAPES.join(', ')} for a count template` });
  }
  const propsResult = validateTakeoffProperties(properties);
  if (!propsResult.ok) return res.status(400).json({ error: propsResult.error });
  const folderResult = resolveFolderId(folder_id);
  if (!folderResult.ok) return res.status(400).json({ error: folderResult.error });

  const result = db
    .prepare(
      `INSERT INTO take_off_templates (name, type, shape, color, properties, formula, output_label, folder_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
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

  const template = db.prepare('SELECT * FROM take_off_templates WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ template });
});

router.patch('/:id', requireTakeoff, (req, res) => {
  const template = db.prepare('SELECT * FROM take_off_templates WHERE id = ?').get(req.params.id);
  if (!template) return res.status(404).json({ error: 'Not found' });
  if (!canMutate(template, req.session.user)) return res.status(403).json({ error: 'Forbidden' });

  const { name, color, properties, formula, output_label, folder_id } = req.body;
  let propsJson = template.properties;
  if (properties !== undefined) {
    const propsResult = validateTakeoffProperties(properties);
    if (!propsResult.ok) return res.status(400).json({ error: propsResult.error });
    propsJson = JSON.stringify(propsResult.properties);
  }
  let folderId = template.folder_id;
  if (folder_id !== undefined) {
    const folderResult = resolveFolderId(folder_id);
    if (!folderResult.ok) return res.status(400).json({ error: folderResult.error });
    folderId = folderResult.folderId;
  }
  db.prepare(
    'UPDATE take_off_templates SET name = ?, color = ?, properties = ?, formula = ?, output_label = ?, folder_id = ? WHERE id = ?'
  ).run(
    name !== undefined && name.trim() ? name.trim() : template.name,
    color !== undefined ? color : template.color,
    propsJson,
    formula !== undefined ? String(formula).trim() || null : template.formula,
    output_label !== undefined ? String(output_label).trim() || null : template.output_label,
    folderId,
    template.id
  );
  const updated = db.prepare('SELECT * FROM take_off_templates WHERE id = ?').get(template.id);
  res.json({ template: updated });
});

router.delete('/:id', requireTakeoff, (req, res) => {
  const template = db.prepare('SELECT * FROM take_off_templates WHERE id = ?').get(req.params.id);
  if (!template) return res.status(404).json({ error: 'Not found' });
  if (!canMutate(template, req.session.user)) return res.status(403).json({ error: 'Forbidden' });

  db.prepare('DELETE FROM take_off_templates WHERE id = ?').run(template.id);
  res.json({ ok: true });
});

module.exports = router;
