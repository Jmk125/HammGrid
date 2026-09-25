// App-wide key/value settings stored in the app_settings table, for things an
// admin should be able to change from the app instead of editing .env and
// restarting (e.g. the PlanSwift jobs folder). Callers own their keys and
// decide how a DB value combines with any .env default.
const db = require('../db');

const getStmt = db.prepare('SELECT value FROM app_settings WHERE key = ?');
const upsertStmt = db.prepare(
  `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, datetime('now'))
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
);
const deleteStmt = db.prepare('DELETE FROM app_settings WHERE key = ?');

function getSetting(key) {
  const row = getStmt.get(key);
  return row ? row.value : null;
}

// null/empty value removes the setting (so any .env default applies again).
function setSetting(key, value, userId) {
  if (value == null || value === '') deleteStmt.run(key);
  else upsertStmt.run(key, String(value), userId || null);
}

module.exports = { getSetting, setSetting };
