const express = require('express');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const { regenerateComposite } = require('../lib/compositePipeline');

const router = express.Router({ mergeParams: true });

// Creates a blank composite drawing - a real sheets row (is_composite=1) with
// a real (blank, single-page) sheet_versions row behind it, same as any
// other sheet, so the viewer grid/PDF.js/take-off tools need zero changes.
// Fragments get brought in afterward via compositeFragments.routes.js, each
// one triggering a re-flatten.
router.post('/', requireRole('admin', 'editor'), async (req, res) => {
  const { sheet_number, discipline, scale_feet_per_inch } = req.body;
  if (typeof sheet_number !== 'string' || !sheet_number.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }
  if (typeof scale_feet_per_inch !== 'number' || !Number.isFinite(scale_feet_per_inch) || scale_feet_per_inch <= 0) {
    return res.status(400).json({ error: 'scale_feet_per_inch must be a positive number' });
  }
  const name = sheet_number.trim();
  const tag = (discipline && String(discipline).trim()) || 'Custom';

  const existing = db.prepare('SELECT id FROM sheets WHERE project_id = ? AND sheet_number = ?').get(req.params.projectId, name);
  if (existing) return res.status(400).json({ error: 'A sheet with this name already exists in this project.' });

  const result = db
    .prepare(
      `INSERT INTO sheets (project_id, sheet_number, discipline, scale_feet_per_inch, is_composite)
       VALUES (?, ?, ?, ?, 1)`
    )
    .run(req.params.projectId, name, tag, scale_feet_per_inch);
  const sheetId = result.lastInsertRowid;

  try {
    await regenerateComposite(sheetId, req.session.user.id);
  } catch (err) {
    // A composite with no valid PDF behind it would be broken everywhere
    // else (thumbnail grid, viewer, offline sync) - roll back rather than
    // leave a half-created sheet around.
    db.prepare('DELETE FROM sheets WHERE id = ?').run(sheetId);
    console.error('Composite creation failed', err);
    return res.status(500).json({ error: 'Failed to create composite drawing' });
  }

  const sheet = db.prepare('SELECT * FROM sheets WHERE id = ?').get(sheetId);
  res.status(201).json({ sheet });
});

module.exports = router;
