const express = require('express');
const db = require('../db');
const { requireTakeoff } = require('../middleware/auth');

// Project-scoped (mounted under /api/projects/:projectId/take-off-folders,
// unlike the global take-off-templates routes) - folders just organize one
// project's own Take-offs list page.
const router = express.Router({ mergeParams: true });

function canMutate(folder, user) {
  return folder.created_by === user.id || user.role !== 'viewer';
}

router.get('/', requireTakeoff, (req, res) => {
  const folders = db
    .prepare('SELECT * FROM take_off_folders WHERE project_id = ? ORDER BY name')
    .all(req.params.projectId);
  res.json({ folders });
});

router.post('/', requireTakeoff, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

  const result = db
    .prepare('INSERT INTO take_off_folders (project_id, name, created_by) VALUES (?, ?, ?)')
    .run(req.params.projectId, name.trim(), req.session.user.id);
  const folder = db.prepare('SELECT * FROM take_off_folders WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ folder });
});

router.patch('/:id', requireTakeoff, (req, res) => {
  const folder = db
    .prepare('SELECT * FROM take_off_folders WHERE id = ? AND project_id = ?')
    .get(req.params.id, req.params.projectId);
  if (!folder) return res.status(404).json({ error: 'Not found' });
  if (!canMutate(folder, req.session.user)) return res.status(403).json({ error: 'Forbidden' });

  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  db.prepare('UPDATE take_off_folders SET name = ? WHERE id = ?').run(name.trim(), folder.id);
  res.json({ folder: { ...folder, name: name.trim() } });
});

// ?cascade=true also deletes every item filed in this folder (and their
// instances, via the existing item-delete cascade) before removing the
// folder itself. Without it, the default ON DELETE SET NULL on
// take_off_items.folder_id just un-files them - they move up to "No Folder"
// intact, which is the more common intent when deleting a folder.
router.delete('/:id', requireTakeoff, (req, res) => {
  const folder = db
    .prepare('SELECT * FROM take_off_folders WHERE id = ? AND project_id = ?')
    .get(req.params.id, req.params.projectId);
  if (!folder) return res.status(404).json({ error: 'Not found' });
  if (!canMutate(folder, req.session.user)) return res.status(403).json({ error: 'Forbidden' });

  if (req.query.cascade === 'true') {
    db.prepare('DELETE FROM take_off_items WHERE folder_id = ?').run(folder.id); // cascades instances
  }
  db.prepare('DELETE FROM take_off_folders WHERE id = ?').run(folder.id); // items' folder_id auto-nulled (ON DELETE SET NULL)
  res.json({ ok: true });
});

module.exports = router;
