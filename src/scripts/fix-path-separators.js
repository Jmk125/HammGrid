// One-time repair for a database copied between machines with different
// path separators (e.g. dev on Windows, served from the Pi on Linux).
// pdf_path/thumb_path/preview_path/overlay_path were stored with whatever
// separator the WRITING machine's OS uses - a Windows-written backslash
// path isn't a path at all on Linux, just one filename containing literal
// backslash characters, so every file lookup 404s (or crashes the server -
// see the streamFile.js fix) even though the file plainly exists on disk.
//
// This rewrites every path column to forward slashes. It's a plain literal
// backslash replace, not path.sep-based, so it does the right thing no
// matter which platform you run it on - run this on whichever machine has
// the good data before/after moving the data/ folder or app.db file.
//
// Usage: npm run fix-path-separators
const db = require('../db');

const TABLES = [
  { table: 'sheet_versions', columns: ['pdf_path', 'thumb_path', 'preview_path', 'overlay_path'] },
  { table: 'staged_sheets', columns: ['pdf_path', 'thumb_path', 'preview_path'] },
  { table: 'documents', columns: ['pdf_path'] },
];

let totalFixed = 0;
for (const { table, columns } of TABLES) {
  for (const column of columns) {
    const rows = db.prepare(`SELECT id, ${column} AS p FROM ${table}`).all();
    const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`);
    for (const row of rows) {
      if (!row.p || !row.p.includes('\\')) continue;
      update.run(row.p.replace(/\\/g, '/'), row.id);
      totalFixed += 1;
    }
  }
}

console.log(`Fixed ${totalFixed} path value(s).`);
