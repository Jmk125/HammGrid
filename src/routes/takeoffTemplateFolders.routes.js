const express = require('express');
const db = require('../db');
const { requireTakeoff } = require('../middleware/auth');

// Global (mounted at /api/take-off-template-folders, not under
// /api/projects/:projectId/...) - mirrors takeoffFolders.routes.js but for
// the global template library instead of one project's item list.
const router = express.Router();

function canMutate(folder, user) {
  return folder.created_by === user.id || user.role !== 'viewer';
}

router.get('/', requireTakeoff, (req, res) => {
  const folders = db.prepare('SELECT * FROM take_off_template_folders ORDER BY name').all();
  res.json({ folders });
});

router.post('/', requireTakeoff, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

  const result = db
    .prepare('INSERT INTO take_off_template_folders (name, created_by) VALUES (?, ?)')
    .run(name.trim(), req.session.user.id);
  const folder = db.prepare('SELECT * FROM take_off_template_folders WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ folder });
});

router.patch('/:id', requireTakeoff, (req, res) => {
  const folder = db.prepare('SELECT * FROM take_off_template_folders WHERE id = ?').get(req.params.id);
  if (!folder) return res.status(404).json({ error: 'Not found' });
  if (!canMutate(folder, req.session.user)) return res.status(403).json({ error: 'Forbidden' });

  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  db.prepare('UPDATE take_off_template_folders SET name = ? WHERE id = ?').run(name.trim(), folder.id);
  res.json({ folder: { ...folder, name: name.trim() } });
});

// ?cascade=true also deletes every template filed in this folder before
// removing the folder itself - see the same option on takeoffFolders.routes.js.
router.delete('/:id', requireTakeoff, (req, res) => {
  const folder = db.prepare('SELECT * FROM take_off_template_folders WHERE id = ?').get(req.params.id);
  if (!folder) return res.status(404).json({ error: 'Not found' });
  if (!canMutate(folder, req.session.user)) return res.status(403).json({ error: 'Forbidden' });

  if (req.query.cascade === 'true') {
    db.prepare('DELETE FROM take_off_templates WHERE folder_id = ?').run(folder.id);
  }
  db.prepare('DELETE FROM take_off_template_folders WHERE id = ?').run(folder.id); // templates' folder_id auto-nulled (ON DELETE SET NULL)
  res.json({ ok: true });
});

module.exports = router;
