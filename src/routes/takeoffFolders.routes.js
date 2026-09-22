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

// Every descendant folder id of rootId (rootId included) - folders self-nest
// via parent_folder_id, so deleting one has to reach its whole subtree.
const SUBTREE_CTE = `WITH RECURSIVE subtree(id) AS (
  SELECT ?
  UNION ALL
  SELECT f.id FROM take_off_folders f JOIN subtree ON f.parent_folder_id = subtree.id
)`;

router.post('/', requireTakeoff, (req, res) => {
  const { name, parent_folder_id } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

  let parentId = null;
  if (parent_folder_id !== undefined && parent_folder_id !== null && parent_folder_id !== '') {
    const parent = db
      .prepare('SELECT id FROM take_off_folders WHERE id = ? AND project_id = ?')
      .get(parent_folder_id, req.params.projectId);
    if (!parent) return res.status(400).json({ error: 'Parent folder not found in this project' });
    parentId = parent.id;
  }

  const result = db
    .prepare('INSERT INTO take_off_folders (project_id, name, parent_folder_id, created_by) VALUES (?, ?, ?, ?)')
    .run(req.params.projectId, name.trim(), parentId, req.session.user.id);
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

// ?cascade=true deletes the folder's whole subtree - every nested subfolder
// and every item filed anywhere in it (plus their instances, via the
// existing item-delete cascade). Without it, the folder's direct items and
// subfolders move up one level to its parent (top level / "No Folder" for a
// top-level folder) intact, which is the more common intent.
router.delete('/:id', requireTakeoff, (req, res) => {
  const folder = db
    .prepare('SELECT * FROM take_off_folders WHERE id = ? AND project_id = ?')
    .get(req.params.id, req.params.projectId);
  if (!folder) return res.status(404).json({ error: 'Not found' });
  if (!canMutate(folder, req.session.user)) return res.status(403).json({ error: 'Forbidden' });

  db.transaction(() => {
    if (req.query.cascade === 'true') {
      db.prepare(`${SUBTREE_CTE} DELETE FROM take_off_items WHERE folder_id IN (SELECT id FROM subtree)`).run(folder.id); // cascades instances
    } else {
      db.prepare('UPDATE take_off_items SET folder_id = ? WHERE folder_id = ?').run(folder.parent_folder_id, folder.id);
      db.prepare('UPDATE take_off_folders SET parent_folder_id = ? WHERE parent_folder_id = ?').run(folder.parent_folder_id, folder.id);
    }
    // Any subfolders still attached (cascade mode) go with it via
    // parent_folder_id's ON DELETE CASCADE.
    db.prepare('DELETE FROM take_off_folders WHERE id = ?').run(folder.id);
  })();
  res.json({ ok: true });
});

module.exports = router;
