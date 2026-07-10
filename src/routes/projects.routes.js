const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('../config');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Per CLAUDE.md: A->Architectural, S->Structural, C->Civil, P->Plumbing,
// M/H->Mechanical, E->Electrical, T->Technology, FP->Fire Protection.
// L->Landscaping added per field usage (2026-07) - not in the original spec
// list but is an editable-per-project map anyway, so this is just a better
// default, same as any other entry here.
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
  L: 'Landscaping',
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

// Destructive and unrecoverable, so it requires the caller to echo back the
// project's exact name (defense in depth - the UI also makes the user type
// it, but a stray/buggy API call shouldn't be able to wipe a project by id
// alone).
router.delete('/:id', requireRole('admin'), (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });

  if (req.body.confirm_name !== project.name) {
    return res.status(400).json({ error: 'confirm_name must exactly match the project name' });
  }

  // Documents live in a flat, non-project-scoped folder, so their file paths
  // have to be collected before the cascade delete removes the DB rows that
  // point to them. Revision ids are needed for the same reason (staging
  // directories are keyed by revision_id, not project_id). Document files
  // now live on document_versions (each revision), not documents itself.
  const documentPaths = db
    .prepare(
      `SELECT dv.pdf_path FROM document_versions dv
       JOIN documents d ON d.id = dv.document_id
       WHERE d.project_id = ?`
    )
    .all(project.id)
    .map((d) => d.pdf_path)
    .filter(Boolean);
  const revisionIds = db.prepare('SELECT id FROM revisions WHERE project_id = ?').all(project.id).map((r) => r.id);

  db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);

  db.prepare('INSERT INTO activity_log (project_id, actor, action, detail) VALUES (?, ?, ?, ?)').run(
    null,
    String(req.session.user.id),
    'project_delete',
    JSON.stringify({ project_id: project.id, project_name: project.name })
  );

  const projectDir = path.join(config.storageDir, 'projects', String(project.id));
  fs.rm(projectDir, { recursive: true, force: true }, () => {});
  for (const revId of revisionIds) {
    fs.rm(path.join(config.storageDir, 'staging', String(revId)), { recursive: true, force: true }, () => {});
  }
  for (const docPath of documentPaths) {
    fs.rm(docPath, { force: true }, () => {});
  }

  res.json({ ok: true });
});

module.exports = router;
