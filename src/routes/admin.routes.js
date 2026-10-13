const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

function dirSize(dir) {
  let total = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else {
        try {
          total += fs.statSync(full).size;
          files += 1;
        } catch (err) {
          // file vanished mid-scan
        }
      }
    }
  }
  return { bytes: total, files };
}

// Read-only for now: where the app keeps its data. Changing it means moving
// files and rewriting the absolute paths stored in the DB, which isn't built.
router.get('/storage', requireRole('admin'), (req, res) => {
  const storageDir = path.resolve(config.storageDir);
  res.json({
    storageDir,
    storageFromEnv: !!process.env.STORAGE_DIR,
    dbPath: path.resolve(config.dbPath),
    dbFromEnv: !!process.env.DB_PATH,
    ...dirSize(storageDir),
  });
});

module.exports = router;
