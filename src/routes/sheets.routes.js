const express = require('express');
const fs = require('fs');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.get('/', requireAuth, (req, res) => {
  const { discipline, revision_id } = req.query;

  let sql = `
    SELECT s.id, s.sheet_number, s.discipline, s.current_version_id, s.is_composite,
           sv.title AS current_title, sv.revision_id AS current_revision_id,
           r.title AS current_revision_title, r.published_at AS current_published_at
    FROM sheets s
    JOIN sheet_versions sv ON sv.id = s.current_version_id
    JOIN revisions r ON r.id = sv.revision_id
    WHERE s.project_id = ?
  `;
  const args = [req.params.projectId];

  if (discipline) {
    sql += ' AND s.discipline = ?';
    args.push(discipline);
  }
  if (revision_id) {
    sql += ' AND sv.revision_id = ?';
    args.push(revision_id);
  }
  sql += ' ORDER BY s.sheet_number';

  const sheets = db.prepare(sql).all(...args);
  res.json({ sheets });
});

// Registered before /:sheetId - otherwise Express would swallow "search" as
// a :sheetId value instead of matching this route.
function buildFtsMatchExpr(rawQuery) {
  const tokens = rawQuery
    .split(/\s+/)
    .map((t) => t.replace(/[^A-Za-z0-9./]/g, '')) // strip anything outside the tokenizer's allowed chars / FTS5 syntax chars
    .filter(Boolean);
  if (tokens.length === 0) return null;
  // Quote each token (handles a leading digit or embedded '.'/'/' safely)
  // and suffix with * for prefix matching, so results feel live as the user
  // types - same instant-filter feel as the existing metadata search.
  return tokens.map((t) => `"${t}"*`).join(' AND ');
}

router.get('/search', requireAuth, (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ sheet_ids: [] });

  const matchExpr = buildFtsMatchExpr(q);
  if (!matchExpr) return res.json({ sheet_ids: [] });

  try {
    const rows = db
      .prepare(
        `SELECT s.id AS sheet_id
         FROM sheet_text_fts f
         JOIN sheets s ON s.id = f.rowid
         WHERE s.project_id = ? AND sheet_text_fts MATCH ?
         ORDER BY rank
         LIMIT 200`
      )
      .all(req.params.projectId, matchExpr);
    res.json({ sheet_ids: rows.map((r) => r.sheet_id) });
  } catch (err) {
    // A malformed MATCH expression must degrade to "no content matches"
    // rather than 500 the whole grid - client-side metadata filtering still
    // works regardless.
    console.warn('FTS search query failed', err);
    res.json({ sheet_ids: [] });
  }
});

router.get('/:sheetId', requireAuth, (req, res) => {
  const sheet = db
    .prepare('SELECT * FROM sheets WHERE id = ? AND project_id = ?')
    .get(req.params.sheetId, req.params.projectId);
  if (!sheet) return res.status(404).json({ error: 'Not found' });

  const versions = db
    .prepare(
      `SELECT sv.*, r.title AS revision_title, r.published_at
       FROM sheet_versions sv JOIN revisions r ON r.id = sv.revision_id
       WHERE sv.sheet_id = ? ORDER BY r.published_at DESC`
    )
    .all(sheet.id);

  res.json({ sheet, versions });
});

router.patch('/:sheetId', requireRole('admin', 'editor'), (req, res) => {
  const sheet = db
    .prepare('SELECT * FROM sheets WHERE id = ? AND project_id = ?')
    .get(req.params.sheetId, req.params.projectId);
  if (!sheet) return res.status(404).json({ error: 'Not found' });

  const { scale_feet_per_inch, sheet_number, discipline } = req.body;

  let nextNumber = sheet.sheet_number;
  if (sheet_number !== undefined) {
    nextNumber = String(sheet_number).trim();
    if (!nextNumber) return res.status(400).json({ error: 'Sheet number cannot be empty' });
    if (nextNumber !== sheet.sheet_number) {
      const collision = db
        .prepare('SELECT id FROM sheets WHERE project_id = ? AND sheet_number = ? AND id != ?')
        .get(req.params.projectId, nextNumber, sheet.id);
      if (collision) {
        return res.status(400).json({ error: `Sheet number "${nextNumber}" is already in use on another sheet.` });
      }
    }
  }

  db.prepare('UPDATE sheets SET sheet_number = ?, discipline = ?, scale_feet_per_inch = ? WHERE id = ?').run(
    nextNumber,
    discipline === undefined ? sheet.discipline : discipline || null,
    scale_feet_per_inch === undefined ? sheet.scale_feet_per_inch : scale_feet_per_inch,
    sheet.id
  );
  const updated = db.prepare('SELECT * FROM sheets WHERE id = ?').get(sheet.id);
  res.json({ sheet: updated });
});

// Admin-only (unlike the metadata PATCH above, which editors can also do) -
// this is permanent, unlike everything else editors touch day to day, which
// is either reversible (a draft revision) or additive (a new markup/
// take-off). Works for both an ordinary sheet and a composite (is_composite)
// - to the rest of the schema a composite is just a sheet, so there's
// nothing composite-specific here beyond the fragment cleanup below.
router.delete('/:sheetId', requireRole('admin'), (req, res) => {
  const sheet = db
    .prepare('SELECT * FROM sheets WHERE id = ? AND project_id = ?')
    .get(req.params.sheetId, req.params.projectId);
  if (!sheet) return res.status(404).json({ error: 'Not found' });

  // Blocked, not silently cascaded: composite_fragments.source_sheet_id ON
  // DELETE CASCADE means deleting a sheet that's cropped INTO some other
  // composite would quietly rip that fragment (and the visible content it
  // contributes) out of that composite with no warning - the opposite of
  // "the field always sees the current set" per CLAUDE.md's mission. Make
  // the user go clean that up first instead.
  const usedAsFragmentSource = db
    .prepare(
      `SELECT DISTINCT s.sheet_number FROM composite_fragments cf
       JOIN sheets s ON s.id = cf.composite_sheet_id
       WHERE cf.source_sheet_id = ? AND cf.composite_sheet_id != ?`
    )
    .all(sheet.id, sheet.id);
  if (usedAsFragmentSource.length > 0) {
    return res.status(409).json({
      error: `This sheet is cropped into composite drawing ${usedAsFragmentSource.map((s) => s.sheet_number).join(', ')} - remove that fragment there first.`,
    });
  }

  const versionPaths = db
    .prepare('SELECT pdf_path, thumb_path, preview_path, overlay_path FROM sheet_versions WHERE sheet_id = ?')
    .all(sheet.id);
  // Only ever this sheet's OWN fragments (composite_sheet_id = itself) by
  // the time we get here - the check above already ruled out this sheet
  // being someone ELSE's fragment source.
  const fragmentPaths = db.prepare('SELECT thumb_path, preview_path FROM composite_fragments WHERE composite_sheet_id = ?').all(sheet.id);

  db.transaction(() => {
    // sheets.current_version_id -> sheet_versions(id) has no ON DELETE
    // action of its own - see db/index.js's migration comment on the
    // identically-shaped documents.current_version_id, which hit a real FK
    // ordering deadlock on this exact pattern before being fixed to SET
    // NULL. sheets was never fixed the same way, so clear it explicitly
    // here rather than trust cascade ordering to sort it out.
    db.prepare('UPDATE sheets SET current_version_id = NULL WHERE id = ?').run(sheet.id);
    // staged_sheets.match_sheet_id likewise has no ON DELETE action - only
    // reachable if an upload review elsewhere matched a staged row against
    // this sheet before it got deleted here; normally empty by publish time.
    db.prepare('UPDATE staged_sheets SET match_sheet_id = NULL WHERE match_sheet_id = ?').run(sheet.id);
    db.prepare('DELETE FROM sheets WHERE id = ?').run(sheet.id);
  })();

  for (const v of versionPaths) {
    for (const p of [v.pdf_path, v.thumb_path, v.preview_path, v.overlay_path]) {
      if (p) fs.rm(p, { force: true }, () => {});
    }
  }
  for (const f of fragmentPaths) {
    for (const p of [f.thumb_path, f.preview_path]) {
      if (p) fs.rm(p, { force: true }, () => {});
    }
  }

  res.json({ ok: true });
});

module.exports = router;
