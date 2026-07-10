const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { toPortablePath } = require('../lib/paths');

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

addColumnIfMissing('sheets', 'scale_feet_per_inch', 'REAL');

addColumnIfMissing('shares', 'name', 'TEXT');
addColumnIfMissing('shares', 'allow_personal_markups', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('shares', 'allow_documents', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('shares', 'document_folder_ids', "TEXT NOT NULL DEFAULT '[]'");

// documents used to be a rigid kind('rfi'|'submittal')/number/title/date/
// status/pdf_path row. It's now a folder-organized entity with versioned
// revisions (document_folders/documents/document_versions, mirroring
// sheets/sheet_versions) - CREATE TABLE IF NOT EXISTS in schema.sql only
// affects brand-new databases, so an existing documents table (old shape)
// needs an explicit one-time migration: add the new columns, fold each old
// row into an auto-created RFIs/Submittals folder plus a first
// document_versions row, then drop the old columns entirely now that
// nothing reads them.
(function migrateDocumentsToFolders() {
  const columns = db.prepare('PRAGMA table_info(documents)').all();
  if (!columns.some((c) => c.name === 'kind')) return; // already migrated or fresh install

  addColumnIfMissing('documents', 'folder_id', 'INTEGER REFERENCES document_folders(id)');
  addColumnIfMissing('documents', 'name', 'TEXT');
  addColumnIfMissing('documents', 'current_version_id', 'INTEGER REFERENCES document_versions(id) ON DELETE SET NULL');

  const oldDocs = db.prepare('SELECT * FROM documents WHERE kind IS NOT NULL').all();
  const folderCache = new Map(); // `${project_id}:${folderName}` -> folder id
  const getFolder = (projectId, folderName) => {
    const key = `${projectId}:${folderName}`;
    if (folderCache.has(key)) return folderCache.get(key);
    const existing = db
      .prepare('SELECT id FROM document_folders WHERE project_id = ? AND parent_folder_id IS NULL AND name = ?')
      .get(projectId, folderName);
    const id = existing
      ? existing.id
      : db.prepare('INSERT INTO document_folders (project_id, name) VALUES (?, ?)').run(projectId, folderName)
          .lastInsertRowid;
    folderCache.set(key, id);
    return id;
  };

  const insertVersion = db.prepare(
    `INSERT INTO document_versions (document_id, issue_date, pdf_path, created_at) VALUES (?, ?, ?, ?)`
  );
  const updateDoc = db.prepare(
    `UPDATE documents SET folder_id = ?, name = ?, current_version_id = ? WHERE id = ?`
  );

  const migrateTxn = db.transaction(() => {
    for (const d of oldDocs) {
      const folderId = getFolder(d.project_id, d.kind === 'rfi' ? 'RFIs' : 'Submittals');
      const name = [d.number, d.title].filter(Boolean).join(' - ') || `Untitled ${d.kind}`;
      const versionId = insertVersion.run(d.id, d.date, toPortablePath(d.pdf_path), d.created_at).lastInsertRowid;
      updateDoc.run(folderId, name, versionId, d.id);
    }
  });
  migrateTxn();

  for (const col of ['kind', 'number', 'title', 'date', 'status', 'pdf_path']) {
    db.exec(`ALTER TABLE documents DROP COLUMN ${col}`);
  }
  console.log(`Migrated ${oldDocs.length} document(s) into the new folder/revision model.`);
})();

// documents.current_version_id needs ON DELETE SET NULL (see schema.sql's
// comment on that column for why) - ALTER TABLE ADD COLUMN can't attach
// that action to a column that was already added without it (this exact
// database hit that: the migration above ran once before this fix existed),
// so only a full table rebuild can correct an existing column's FK action.
(function ensureDocumentsCurrentVersionSetNull() {
  const fk = db.prepare('PRAGMA foreign_key_list(documents)').all().find((f) => f.from === 'current_version_id');
  if (!fk || fk.on_delete === 'SET NULL') return; // no such column yet, or already correct

  // document_versions.document_id and markups.linked_document_id both still
  // reference documents(id), so DROP TABLE documents is itself rejected
  // under normal FK enforcement - this is SQLite's own documented procedure
  // for changing a column's constraints (https://www.sqlite.org/lang_altertable.html,
  // "Making Other Kinds Of Table Schema Changes"): disable enforcement for
  // the duration of the rebuild, verify integrity before re-enabling it.
  // PRAGMA foreign_keys can't be changed inside a transaction, hence it's
  // toggled outside the db.transaction() call below.
  db.pragma('foreign_keys = OFF');
  const rebuild = db.transaction(() => {
    db.exec(`
      CREATE TABLE documents_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        folder_id INTEGER REFERENCES document_folders(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        current_version_id INTEGER REFERENCES document_versions(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec(`
      INSERT INTO documents_new (id, project_id, folder_id, name, current_version_id, created_at)
      SELECT id, project_id, folder_id, name, current_version_id, created_at FROM documents
    `);
    db.exec('DROP TABLE documents');
    db.exec('ALTER TABLE documents_new RENAME TO documents');
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length) {
      throw new Error(`documents table rebuild left ${violations.length} dangling reference(s): ${JSON.stringify(violations)}`);
    }
  });
  rebuild();
  db.pragma('foreign_keys = ON');
  console.log('Rebuilt documents table to add ON DELETE SET NULL on current_version_id.');
})();

db.exec('CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents(folder_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_documents_current_version ON documents(current_version_id)');

// markups.linked_document_id needs the same ON DELETE SET NULL fix as
// documents.current_version_id above, and for the same reason: deleting a
// document that's still linked from a markup should just clear the link
// (warned about client-side first), not be rejected outright.
(function ensureMarkupsLinkedDocumentSetNull() {
  const fk = db.prepare('PRAGMA foreign_key_list(markups)').all().find((f) => f.from === 'linked_document_id');
  if (!fk || fk.on_delete === 'SET NULL') return;

  db.pragma('foreign_keys = OFF');
  const rebuild = db.transaction(() => {
    db.exec(`
      CREATE TABLE markups_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sheet_id INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
        author_id INTEGER NOT NULL REFERENCES users(id),
        visibility TEXT NOT NULL CHECK (visibility IN ('private', 'published')) DEFAULT 'private',
        type TEXT NOT NULL CHECK (type IN ('line', 'arrow', 'cloud', 'text', 'rect')),
        geometry TEXT NOT NULL,
        style TEXT NOT NULL DEFAULT '{}',
        linked_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec(`
      INSERT INTO markups_new (id, sheet_id, author_id, visibility, type, geometry, style, linked_document_id, created_at, updated_at)
      SELECT id, sheet_id, author_id, visibility, type, geometry, style, linked_document_id, created_at, updated_at FROM markups
    `);
    db.exec('DROP TABLE markups');
    db.exec('ALTER TABLE markups_new RENAME TO markups');
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length) {
      throw new Error(`markups table rebuild left ${violations.length} dangling reference(s): ${JSON.stringify(violations)}`);
    }
  });
  rebuild();
  db.pragma('foreign_keys = ON');
  console.log('Rebuilt markups table to add ON DELETE SET NULL on linked_document_id.');
})();

db.exec('CREATE INDEX IF NOT EXISTS idx_markups_sheet ON markups(sheet_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_markups_linked_document ON markups(linked_document_id)');

module.exports = db;
