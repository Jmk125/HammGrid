// One-time migration: flag markups used to store a single geometry.tag
// string; flags now support multiple tags via geometry.tags (array), entered
// as a comma-separated list in the UI. This rewrites existing flag geometry
// so old single-tag data isn't silently dropped by the new array-based code.
//
// Usage: npm run migrate-flag-tags
const db = require('../db');

const rows = db.prepare(`SELECT id, geometry FROM markups WHERE type = 'flag'`).all();
const update = db.prepare(`UPDATE markups SET geometry = ? WHERE id = ?`);

let migrated = 0;
for (const row of rows) {
  const geometry = JSON.parse(row.geometry);
  if ('tags' in geometry) continue;
  const tag = geometry.tag;
  delete geometry.tag;
  geometry.tags = tag ? [tag] : [];
  update.run(JSON.stringify(geometry), row.id);
  migrated += 1;
}

console.log(`Migrated ${migrated} flag(s).`);
