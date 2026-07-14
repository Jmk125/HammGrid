const path = require('path');
const db = require('../db');
const { runPython } = require('./pyRunner');
const queue = require('./queue');

const SCAN_SCRIPT = path.join(__dirname, '..', '..', 'pyproc', 'sheet_link_scan.py');
const SCAN_TIMEOUT_MS = 5 * 60 * 1000;

function getCurrentSheets(projectId) {
  return db
    .prepare(
      `SELECT s.id, s.sheet_number, s.current_version_id, sv.pdf_path
       FROM sheets s
       JOIN sheet_versions sv ON sv.id = s.current_version_id
       WHERE s.project_id = ?
       ORDER BY s.sheet_number`
    )
    .all(projectId);
}

function replaceAutoLinksForSheet(projectId, sheet, links, userId) {
  const replace = db.transaction(() => {
    db.prepare(`DELETE FROM sheet_links WHERE project_id = ? AND source_sheet_id = ? AND link_type = 'auto'`).run(projectId, sheet.id);
    const insert = db.prepare(
      `INSERT INTO sheet_links (project_id, source_sheet_id, source_version_id, target_sheet_id, rect, label, link_type, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'auto', ?)`
    );
    for (const link of links) {
      insert.run(
        projectId,
        sheet.id,
        sheet.current_version_id,
        link.target_sheet_id,
        JSON.stringify(link.rect),
        link.label || null,
        userId
      );
    }
  });
  replace();
}

async function scanAutoLinksForSheets({ projectId, sourceSheets, userId, onProgress }) {
  const targets = getCurrentSheets(projectId).map((s) => ({ id: s.id, sheet_number: s.sheet_number }));
  let done = 0;
  let created = 0;
  for (const sheet of sourceSheets) {
    const result = await queue.enqueue(() =>
      runPython(SCAN_SCRIPT, [String(sheet.id), sheet.pdf_path, JSON.stringify(targets)], { timeout: SCAN_TIMEOUT_MS })
    );
    const links = Array.isArray(result.links) ? result.links : [];
    replaceAutoLinksForSheet(projectId, sheet, links, userId);
    created += links.length;
    done += 1;
    if (onProgress) onProgress(done, sourceSheets.length);
  }
  return { created_links: created, scanned_sheets: sourceSheets.length };
}

function deleteAutoLinksForProject(projectId) {
  db.prepare(`DELETE FROM sheet_links WHERE project_id = ? AND link_type = 'auto'`).run(projectId);
}

module.exports = {
  getCurrentSheets,
  scanAutoLinksForSheets,
  deleteAutoLinksForProject,
};
