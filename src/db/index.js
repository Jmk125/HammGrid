const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const dataDir = path.dirname(config.dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// CREATE TABLE IF NOT EXISTS doesn't add new columns to a table that already
// existed pre-migration, so new columns need an explicit ALTER TABLE here.
function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing('sheet_versions', 'overlay_path', 'TEXT');

addColumnIfMissing('markups', 'updated_at', 'TEXT');
db.exec(`UPDATE markups SET updated_at = created_at WHERE updated_at IS NULL`);

addColumnIfMissing('projects', 'location', 'TEXT');
addColumnIfMissing('projects', 'size', 'TEXT');

module.exports = db;
