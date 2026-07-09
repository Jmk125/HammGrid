const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Per CLAUDE.md: A->Architectural, S->Structural, C->Civil, P->Plumbing,
// M/H->Mechanical, E->Electrical, T->Technology, FP->Fire Protection.
const DEFAULT_DISCIPLINE_MAP = {
  A: 'Architectural',
  S: 'Structural',
  C: 'Civil',
  P: 'Plumbing',
  M: 'Mechanical',
  H: 'Mechanical',
  E: 'Electrical',
  T: 'Technology',
  FP: 'Fire Protection',
};

function parseProject(project) {
  return { ...project, discipline_prefix_map: JSON.parse(project.discipline_prefix_map) };
}

const firstThumbnailStmt = db.prepare(
  `SELECT sv.id AS version_id
   FROM sheet_versions sv
   JOIN sheets s ON s.id = sv.sheet_id
   WHERE s.project_id = ?
   ORDER BY sv.id ASC LIMIT 1`
);

router.get('/', requireAuth, (req, res) => {
  const projects = db.prepare('SELECT * FROM projects ORDER BY name').all();
  res.json({
    projects: projects.map((p) => {
      const first = firstThumbnailStmt.get(p.id);
      return {
        ...parseProject(p),
        first_thumbnail_url: first ? `/api/sheet-versions/${first.version_id}/thumb` : null,
      };
    }),
  });
});

router.get('/:id', requireAuth, (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  res.json({ project: parseProject(project) });
});

router.post('/', requireRole('admin'), (req, res) => {
  const { name, number, location, size, discipline_prefix_map } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const map = JSON.stringify(discipline_prefix_map || DEFAULT_DISCIPLINE_MAP);
  const result = db
    .prepare('INSERT INTO projects (name, number, location, size, discipline_prefix_map) VALUES (?, ?, ?, ?, ?)')
    .run(name, number || null, location || null, size || null, map);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ project: parseProject(project) });
});

router.put('/:id', requireRole('admin'), (req, res) => {
  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const { name, number, location, size, discipline_prefix_map } = req.body;
  db.prepare('UPDATE projects SET name = ?, number = ?, location = ?, size = ?, discipline_prefix_map = ? WHERE id = ?').run(
    name ?? existing.name,
    number ?? existing.number,
    location ?? existing.location,
    size ?? existing.size,
    discipline_prefix_map ? JSON.stringify(discipline_prefix_map) : existing.discipline_prefix_map,
    req.params.id
  );
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  res.json({ project: parseProject(project) });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const result = db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

module.exports = router;
