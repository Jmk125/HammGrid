const express = require('express');
const fs = require('fs');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const FOLDER_TREE_CTE = `
  WITH RECURSIVE folder_tree(id) AS (
    SELECT id FROM document_folders WHERE id = ?
    UNION ALL
    SELECT f.id FROM document_folders f JOIN folder_tree t ON f.parent_folder_id = t.id
  )
`;

const router = express.Router();

router.patch('/:id', requireRole('admin', 'editor'), (req, res) => {
  const folder = db.prepare('SELECT * FROM document_folders WHERE id = ?').get(req.params.id);
  if (!folder) return res.status(404).json({ error: 'Not found' });

  const { name, parent_folder_id } = req.body;
  if (parent_folder_id !== undefined && parent_folder_id !== null) {
    if (Number(parent_folder_id) === folder.id) {
      return res.status(400).json({ error: 'A folder cannot be its own parent' });
    }
    const parent = db
      .prepare('SELECT id FROM document_folders WHERE id = ? AND project_id = ?')
      .get(parent_folder_id, folder.project_id);
    if (!parent) return res.status(400).json({ error: 'parent_folder_id not found in this project' });
  }

  db.prepare('UPDATE document_folders SET name = ?, parent_folder_id = ? WHERE id = ?').run(
    name !== undefined && name.trim() ? name.trim() : folder.name,
    parent_folder_id !== undefined ? parent_folder_id : folder.parent_folder_id,
    folder.id
  );
  const updated = db.prepare('SELECT * FROM document_folders WHERE id = ?').get(folder.id);
  res.json({ folder: updated });
});

// Total markup links across every document nested anywhere under this
// folder - lets the delete-confirmation warn with a real count beforehand
// (deleting still succeeds regardless; linked markups just get unlinked).
router.get('/:id/links', requireAuth, (req, res) => {
  const folder = db.prepare('SELECT id FROM document_folders WHERE id = ?').get(req.params.id);
  if (!folder) return res.status(404).json({ error: 'Not found' });

  const { count } = db
    .prepare(
      `${FOLDER_TREE_CTE}
       SELECT COUNT(*) AS count FROM markups m
       JOIN documents d ON d.id = m.linked_document_id
       WHERE d.folder_id IN (SELECT id FROM folder_tree)`
    )
    .get(folder.id);
  res.json({ linked_markup_count: count });
});

router.delete('/:id', requireRole('admin', 'editor'), (req, res) => {
  const folder = db.prepare('SELECT * FROM document_folders WHERE id = ?').get(req.params.id);
  if (!folder) return res.status(404).json({ error: 'Not found' });

  // Gather every file under this folder AND every nested subfolder before
  // the cascade delete removes the DB rows that point to them. Any markup
  // linking to a document in here gets unlinked (ON DELETE SET NULL), not
  // blocked - the client warns about this with the /links count above.
  const paths = db
    .prepare(
      `${FOLDER_TREE_CTE}
       SELECT dv.pdf_path FROM document_versions dv
       JOIN documents d ON d.id = dv.document_id
       WHERE d.folder_id IN (SELECT id FROM folder_tree)`
    )
    .all(folder.id);

  db.prepare('DELETE FROM document_folders WHERE id = ?').run(folder.id);
  for (const p of paths) {
    if (p.pdf_path) fs.rm(p.pdf_path, { force: true }, () => {});
  }
  res.json({ ok: true });
});

module.exports = router;
