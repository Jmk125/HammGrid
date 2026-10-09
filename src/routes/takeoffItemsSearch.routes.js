const express = require('express');
const db = require('../db');
const { requireTakeoff } = require('../middleware/auth');

// Cross-project search, backing the sheet pane's "From Existing" picker
// when it's pointed at "All projects" instead of one specific job (see
// sheet.js's openExistingItemPickerModal) - global like
// takeoffTemplates.routes.js, not project-scoped. Requires an actual query
// term and caps results: a firm can easily have hundreds of items per job,
// so "every take-off item on every job" with no filter is thousands of
// rows for zero benefit over just picking that job from the project
// dropdown and browsing its own list directly.
const router = express.Router();

router.get('/search', requireTakeoff, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ items: [] });
  const items = db
    .prepare(
      `SELECT ti.*, p.name AS project_name
       FROM take_off_items ti
       JOIN projects p ON p.id = ti.project_id
       WHERE ti.name LIKE ?
       ORDER BY ti.name
       LIMIT 50`
    )
    .all(`%${q}%`);
  res.json({ items });
});

module.exports = router;
