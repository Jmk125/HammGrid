const express = require('express');
const fs = require('fs');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { regenerateComposite, generateFragmentAssets } = require('../lib/compositePipeline');
const { streamFile } = require('../lib/streamFile');

const router = express.Router({ mergeParams: true });

function validateRect(rect, label) {
  if (!rect || typeof rect !== 'object') return `${label} is required`;
  for (const key of ['x', 'y', 'width', 'height']) {
    if (typeof rect[key] !== 'number' || !Number.isFinite(rect[key])) return `${label}.${key} must be a number`;
  }
  if (rect.width <= 0 || rect.height <= 0) return `${label} width/height must be positive`;
  return null;
}

// {x, y} objects, same point shape as every other geometry in this app
// (take-off instances, markups) - not [x, y] pairs.
function validateMaskPolygons(maskPolygons) {
  if (maskPolygons === undefined) return null;
  if (!Array.isArray(maskPolygons)) return 'mask_polygons must be an array';
  for (const polygon of maskPolygons) {
    if (!Array.isArray(polygon) || polygon.length < 3) return 'each mask polygon needs at least 3 points';
    for (const pt of polygon) {
      if (!pt || typeof pt !== 'object' || typeof pt.x !== 'number' || typeof pt.y !== 'number') {
        return 'mask polygon points must be {x, y} objects';
      }
    }
  }
  return null;
}

function validateRotation(rotation) {
  if (rotation === undefined) return null;
  if (typeof rotation !== 'number' || !Number.isFinite(rotation)) return 'rotation must be a number';
  return null;
}

// Every mutation route below defaults to eagerly re-flattening the
// composite (regenerateComposite) so the underlying PDF/thumb stay correct
// immediately. Edit Layout mode's live SVG-image view (see sheet.js) doesn't
// actually need that mid-session - it shows the right thing instantly on
// its own - so it passes ?regenerate=0 on every mutation during an editing
// session and instead calls POST .../composite-fragments/regenerate exactly
// once, when the user finishes (see finalizeCompositeLayout in sheet.js).
// Without this, a burst of edits (several drags, a lock toggle, a bring-in)
// each queue their own full regenerate (single-concurrency, see
// src/lib/queue.js) and the user waits through all of them cumulatively.
function shouldRegenerate(req) {
  return req.query.regenerate !== '0';
}

function getCompositeSheet(req, res) {
  const sheet = db
    .prepare('SELECT * FROM sheets WHERE id = ? AND project_id = ? AND is_composite = 1')
    .get(req.params.sheetId, req.params.projectId);
  if (!sheet) {
    res.status(404).json({ error: 'Composite drawing not found' });
    return null;
  }
  return sheet;
}

// Joins in the source sheet's own sheet_number (e.g. "A101.3") - the palette
// list shows this, not the source sheet's internal numeric id, so every
// place a fragment row gets sent to the client goes through this instead of
// a bare `SELECT * FROM composite_fragments`.
function getFragmentWithSourceNumber(fragmentId) {
  return db
    .prepare(
      `SELECT cf.*, s.sheet_number AS source_sheet_number
       FROM composite_fragments cf
       JOIN sheets s ON s.id = cf.source_sheet_id
       WHERE cf.id = ?`
    )
    .get(fragmentId);
}

router.get('/', requireAuth, (req, res) => {
  const sheet = getCompositeSheet(req, res);
  if (!sheet) return;
  const fragments = db
    .prepare(
      `SELECT cf.*, s.sheet_number AS source_sheet_number
       FROM composite_fragments cf
       JOIN sheets s ON s.id = cf.source_sheet_id
       WHERE cf.composite_sheet_id = ?
       ORDER BY cf.z_order ASC`
    )
    .all(sheet.id);
  res.json({ fragments });
});

// Brings a cropped (and optionally masked) region of another sheet's PDF
// into this composite as a new fragment. `place` is expected to already be
// scale-reconciled (crop_width/height * source_scale/composite_scale) by the
// client's bring-in flow - the server trusts but doesn't recompute it, same
// as take_off_instances.quantity being precomputed client-side and never
// recomputed server-side.
router.post('/', requireRole('admin', 'editor'), async (req, res) => {
  const sheet = getCompositeSheet(req, res);
  if (!sheet) return;

  const { source_sheet_id, source_version_id, crop, mask_polygons, place, rotation } = req.body;
  const cropErr = validateRect(crop, 'crop');
  if (cropErr) return res.status(400).json({ error: cropErr });
  const placeErr = validateRect(place, 'place');
  if (placeErr) return res.status(400).json({ error: placeErr });
  const maskErr = validateMaskPolygons(mask_polygons);
  if (maskErr) return res.status(400).json({ error: maskErr });
  const rotationErr = validateRotation(rotation);
  if (rotationErr) return res.status(400).json({ error: rotationErr });

  const sourceVersion = db
    .prepare(
      `SELECT sv.* FROM sheet_versions sv
       JOIN sheets s ON s.id = sv.sheet_id
       WHERE sv.id = ? AND sv.sheet_id = ? AND s.project_id = ?`
    )
    .get(source_version_id, source_sheet_id, req.params.projectId);
  if (!sourceVersion) return res.status(400).json({ error: 'Source sheet version not found in this project' });

  const maxZ = db.prepare('SELECT MAX(z_order) AS m FROM composite_fragments WHERE composite_sheet_id = ?').get(sheet.id).m;
  const zOrder = (maxZ === null ? -1 : maxZ) + 1;

  const result = db
    .prepare(
      `INSERT INTO composite_fragments
        (composite_sheet_id, source_sheet_id, source_version_id, crop_x, crop_y, crop_width, crop_height,
         mask_polygons, place_x, place_y, place_width, place_height, rotation, z_order, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      sheet.id,
      source_sheet_id,
      source_version_id,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      JSON.stringify(mask_polygons || []),
      place.x,
      place.y,
      place.width,
      place.height,
      rotation || 0,
      zOrder,
      req.session.user.id
    );
  const fragmentId = result.lastInsertRowid;

  try {
    const { thumbPath, previewPath } = await generateFragmentAssets(req.params.projectId, fragmentId, sourceVersion.pdf_path, crop, mask_polygons);
    db.prepare('UPDATE composite_fragments SET thumb_path = ?, preview_path = ? WHERE id = ?').run(thumbPath, previewPath, fragmentId);
    if (shouldRegenerate(req)) await regenerateComposite(sheet.id, req.session.user.id);
  } catch (err) {
    db.prepare('DELETE FROM composite_fragments WHERE id = ?').run(fragmentId);
    console.error('Failed to bring in fragment', err);
    return res.status(500).json({ error: 'Failed to bring in fragment' });
  }

  const fragment = getFragmentWithSourceNumber(fragmentId);
  const updatedSheet = db.prepare('SELECT * FROM sheets WHERE id = ?').get(sheet.id);
  res.status(201).json({ fragment, sheet: updatedSheet });
});

// Fragment-palette thumbnail (crop+mask applied, no placement scaling) -
// see generateFragmentThumb; not cached "immutable" like sheet_versions'
// files since a fragment's thumb IS overwritten in place on a crop/mask edit
// (see PATCH below), unlike a published sheet_version's files.
router.get('/:fragmentId/thumb', requireAuth, async (req, res) => {
  const sheet = getCompositeSheet(req, res);
  if (!sheet) return;
  let fragment = db
    .prepare('SELECT * FROM composite_fragments WHERE id = ? AND composite_sheet_id = ?')
    .get(req.params.fragmentId, sheet.id);
  if (!fragment) return res.status(404).end();
  if (!fragment.thumb_path) {
    try {
      fragment = await ensureFragmentAssets(req.params.projectId, fragment);
    } catch (err) {
      console.error('Failed to backfill fragment thumb', err);
    }
  }
  if (!fragment.thumb_path) return res.status(404).end();
  streamFile(res, fragment.thumb_path, 'image/webp');
});

// Composites created before preview_path existed (see migration in
// src/db/index.js) have fragments with no preview asset at all - without
// this, Edit Layout's live-drag <image> (see renderCompositeFragmentsOverlay
// in sheet.js) 404s silently and the user just keeps looking at the stale
// flattened PDF underneath until the next full regenerate, which looks
// exactly like "dragging doesn't actually move anything for 30 seconds."
// Lazily generates both assets (one fragment_thumb.py call) the first time
// either is requested and persists the paths, so every request after the
// first is the normal fast path - no separate backfill migration needed.
async function ensureFragmentAssets(projectId, fragment) {
  if (fragment.preview_path && fragment.thumb_path) return fragment;
  const sourceVersion = db.prepare('SELECT pdf_path FROM sheet_versions WHERE id = ?').get(fragment.source_version_id);
  if (!sourceVersion) return fragment;
  const crop = { x: fragment.crop_x, y: fragment.crop_y, width: fragment.crop_width, height: fragment.crop_height };
  const maskPolygons = JSON.parse(fragment.mask_polygons || '[]');
  const { thumbPath, previewPath } = await generateFragmentAssets(
    projectId,
    fragment.id,
    sourceVersion.pdf_path,
    crop,
    maskPolygons
  );
  db.prepare('UPDATE composite_fragments SET thumb_path = ?, preview_path = ? WHERE id = ?').run(
    thumbPath,
    previewPath,
    fragment.id
  );
  return { ...fragment, thumb_path: thumbPath, preview_path: previewPath };
}

// Full-res RGBA edit-preview (crop+mask applied, no placement/rotation) -
// fetched once per fragment when entering Edit Layout mode so drag/rotate
// can be shown live client-side (see fetchFragmentPreviewImages in
// sheet.js) with zero server round-trip per frame. Same non-immutable
// caching reasoning as the thumb route above.
router.get('/:fragmentId/preview', requireAuth, async (req, res) => {
  const sheet = getCompositeSheet(req, res);
  if (!sheet) return;
  let fragment = db
    .prepare('SELECT * FROM composite_fragments WHERE id = ? AND composite_sheet_id = ?')
    .get(req.params.fragmentId, sheet.id);
  if (!fragment) return res.status(404).end();
  if (!fragment.preview_path) {
    try {
      fragment = await ensureFragmentAssets(req.params.projectId, fragment);
    } catch (err) {
      console.error('Failed to backfill fragment preview', err);
    }
  }
  if (!fragment.preview_path) return res.status(404).end();
  streamFile(res, fragment.preview_path, 'image/webp');
});

router.patch('/:fragmentId', requireRole('admin', 'editor'), async (req, res) => {
  const sheet = getCompositeSheet(req, res);
  if (!sheet) return;
  const fragment = db
    .prepare('SELECT * FROM composite_fragments WHERE id = ? AND composite_sheet_id = ?')
    .get(req.params.fragmentId, sheet.id);
  if (!fragment) return res.status(404).json({ error: 'Fragment not found' });

  // Locking only blocks the two things it's meant to prevent - accidental
  // repositioning or reorienting - not re-tracing a mask, re-ordering, or
  // toggling visibility, which are deliberate edits regardless of lock state.
  if (fragment.locked && (req.body.place !== undefined || req.body.rotation !== undefined)) {
    return res.status(400).json({ error: 'This fragment is locked - unlock it before moving or rotating it.' });
  }

  const updates = [];
  const values = [];

  if (req.body.place !== undefined) {
    const err = validateRect(req.body.place, 'place');
    if (err) return res.status(400).json({ error: err });
    updates.push('place_x = ?', 'place_y = ?', 'place_width = ?', 'place_height = ?');
    values.push(req.body.place.x, req.body.place.y, req.body.place.width, req.body.place.height);
  }
  if (req.body.rotation !== undefined) {
    const err = validateRotation(req.body.rotation);
    if (err) return res.status(400).json({ error: err });
    updates.push('rotation = ?');
    values.push(req.body.rotation);
  }
  if (req.body.crop !== undefined) {
    const err = validateRect(req.body.crop, 'crop');
    if (err) return res.status(400).json({ error: err });
    updates.push('crop_x = ?', 'crop_y = ?', 'crop_width = ?', 'crop_height = ?');
    values.push(req.body.crop.x, req.body.crop.y, req.body.crop.width, req.body.crop.height);
  }
  if (req.body.mask_polygons !== undefined) {
    const err = validateMaskPolygons(req.body.mask_polygons);
    if (err) return res.status(400).json({ error: err });
    updates.push('mask_polygons = ?');
    values.push(JSON.stringify(req.body.mask_polygons));
  }
  if (req.body.z_order !== undefined) {
    if (typeof req.body.z_order !== 'number') return res.status(400).json({ error: 'z_order must be a number' });
    updates.push('z_order = ?');
    values.push(req.body.z_order);
  }
  if (req.body.locked !== undefined) {
    updates.push('locked = ?');
    values.push(req.body.locked ? 1 : 0);
  }
  if (req.body.visible !== undefined) {
    updates.push('visible = ?');
    values.push(req.body.visible ? 1 : 0);
  }
  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });

  updates.push("updated_at = datetime('now')");
  db.prepare(`UPDATE composite_fragments SET ${updates.join(', ')} WHERE id = ?`).run(...values, fragment.id);

  // Crop or mask changed - the fragment's own palette thumbnail AND its
  // full-res edit-preview asset (both crop+mask, not placement/rotation)
  // need regenerating too; a placement/rotation-only change
  // (move/rotate/resize/z-order/lock/visibility) doesn't touch either.
  if (req.body.crop !== undefined || req.body.mask_polygons !== undefined) {
    const updatedFragment = db.prepare('SELECT * FROM composite_fragments WHERE id = ?').get(fragment.id);
    const sourceVersion = db.prepare('SELECT pdf_path FROM sheet_versions WHERE id = ?').get(updatedFragment.source_version_id);
    const updatedCrop = {
      x: updatedFragment.crop_x,
      y: updatedFragment.crop_y,
      width: updatedFragment.crop_width,
      height: updatedFragment.crop_height,
    };
    const updatedMaskPolygons = JSON.parse(updatedFragment.mask_polygons);
    try {
      const { thumbPath, previewPath } = await generateFragmentAssets(
        req.params.projectId,
        fragment.id,
        sourceVersion.pdf_path,
        updatedCrop,
        updatedMaskPolygons
      );
      db.prepare('UPDATE composite_fragments SET thumb_path = ?, preview_path = ? WHERE id = ?').run(thumbPath, previewPath, fragment.id);
    } catch (err) {
      console.error('Failed to regenerate fragment thumb/preview', err);
    }
  }

  if (shouldRegenerate(req)) {
    try {
      await regenerateComposite(sheet.id, req.session.user.id);
    } catch (err) {
      console.error('Failed to regenerate composite', err);
      return res.status(500).json({ error: 'Failed to update composite drawing' });
    }
  }

  const updated = getFragmentWithSourceNumber(fragment.id);
  const updatedSheet = db.prepare('SELECT * FROM sheets WHERE id = ?').get(sheet.id);
  res.json({ fragment: updated, sheet: updatedSheet });
});

router.delete('/:fragmentId', requireRole('admin', 'editor'), async (req, res) => {
  const sheet = getCompositeSheet(req, res);
  if (!sheet) return;
  const fragment = db
    .prepare('SELECT * FROM composite_fragments WHERE id = ? AND composite_sheet_id = ?')
    .get(req.params.fragmentId, sheet.id);
  if (!fragment) return res.status(404).json({ error: 'Fragment not found' });

  db.prepare('DELETE FROM composite_fragments WHERE id = ?').run(fragment.id);
  if (fragment.thumb_path) fs.rm(fragment.thumb_path, { force: true }, () => {});
  if (fragment.preview_path) fs.rm(fragment.preview_path, { force: true }, () => {});

  if (shouldRegenerate(req)) {
    try {
      await regenerateComposite(sheet.id, req.session.user.id);
    } catch (err) {
      console.error('Failed to regenerate composite after fragment delete', err);
      return res.status(500).json({ error: 'Failed to update composite drawing' });
    }
  }

  const updatedSheet = db.prepare('SELECT * FROM sheets WHERE id = ?').get(sheet.id);
  res.json({ ok: true, sheet: updatedSheet });
});

// Explicitly re-flattens the composite on demand - the counterpart to every
// mutation route above being callable with ?regenerate=0 to skip its own
// eager regenerate. sheet.js calls this exactly once, when Edit Layout mode
// is exited, to catch the real PDF up on everything that happened during
// the session.
router.post('/regenerate', requireRole('admin', 'editor'), async (req, res) => {
  const sheet = getCompositeSheet(req, res);
  if (!sheet) return;
  try {
    await regenerateComposite(sheet.id, req.session.user.id);
  } catch (err) {
    console.error('Failed to regenerate composite', err);
    return res.status(500).json({ error: 'Failed to regenerate composite drawing' });
  }
  const updatedSheet = db.prepare('SELECT * FROM sheets WHERE id = ?').get(sheet.id);
  res.json({ sheet: updatedSheet });
});

module.exports = router;
