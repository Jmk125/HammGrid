const express = require('express');
const db = require('../db');
const { requireTakeoff } = require('../middleware/auth');

// Project-wide take-off instances (every sheet, not just one) - backs
// offline sync (offline-store.js's syncProject) so a sheet can render its
// placed take-offs with zero network in the path, the same way its PDF
// already does. Deliberately separate from takeoffInstances.routes.js
// (sheet-scoped, mounted under .../sheets/:sheetId/take-off-instances) -
// that one is used for the live pane's read/write flow and stays as-is;
// this is read-only and just the raw per-instance rows with geometry,
// unlike takeoffItems.routes.js's /by-sheet endpoint which is SUM()-
// aggregated totals for the summary table and has no geometry to render.
const router = express.Router({ mergeParams: true });

router.get('/', requireTakeoff, (req, res) => {
  const instances = db
    .prepare(
      `SELECT inst.*, ti.name AS item_name, ti.color AS item_color, ti.type AS item_type, ti.shape AS item_shape,
              ti.properties AS item_properties, ti.formula AS item_formula, ti.output_label AS item_output_label
       FROM take_off_instances inst
       JOIN take_off_items ti ON ti.id = inst.item_id
       JOIN sheets s ON s.id = inst.sheet_id
       WHERE s.project_id = ?
       ORDER BY inst.created_at`
    )
    .all(req.params.projectId);
  res.json({
    instances: instances.map((i) => ({ ...i, geometry: JSON.parse(i.geometry) })),
  });
});

module.exports = router;
