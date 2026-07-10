const db = require('../db');

// Returns markups for a sheet matching the requested visibility scope,
// parsed (geometry/style) ready for annotate_pdf.py. Shared by the
// single-sheet download route and the multi-sheet merged-download route so
// "published and/or personal" means the same thing in both places.
function getMarkupsForDownload(sheetId, { includePublished, includePersonal, userId }) {
  if (!includePublished && !includePersonal) return [];
  const clauses = [];
  const args = [sheetId];
  if (includePublished) clauses.push(`visibility = 'published'`);
  if (includePersonal) {
    clauses.push(`author_id = ?`);
    args.push(userId);
  }
  const rows = db
    .prepare(`SELECT type, geometry, style FROM markups WHERE sheet_id = ? AND (${clauses.join(' OR ')}) ORDER BY created_at`)
    .all(...args);
  return rows.map((m) => ({ ...m, geometry: JSON.parse(m.geometry), style: JSON.parse(m.style || '{}') }));
}

module.exports = { getMarkupsForDownload };
