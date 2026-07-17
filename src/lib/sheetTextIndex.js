const path = require('path');
const db = require('../db');
const { runPython } = require('./pyRunner');
const queue = require('./queue');

const EXTRACT_SCRIPT = path.join(__dirname, '..', '..', 'pyproc', 'sheet_text_extract.py');
const EXTRACT_TIMEOUT_MS = 2 * 60 * 1000;

async function indexTextForSheets({ sourceSheets, onProgress }) {
  let done = 0;
  let indexed = 0;
  for (const sheet of sourceSheets) {
    try {
      const result = await queue.enqueue(() =>
        runPython(EXTRACT_SCRIPT, [String(sheet.id), sheet.pdf_path], { timeout: EXTRACT_TIMEOUT_MS })
      );
      const replace = db.transaction(() => {
        db.prepare('DELETE FROM sheet_text_fts WHERE rowid = ?').run(sheet.id);
        db.prepare('INSERT INTO sheet_text_fts(rowid, body) VALUES (?, ?)').run(sheet.id, result.text || '');
      });
      replace();
      indexed += 1;
    } catch (err) {
      // One bad PDF must not abort indexing the rest of the batch.
      console.error('Text extraction failed for sheet', sheet.id, err);
    }
    done += 1;
    if (onProgress) onProgress(done, sourceSheets.length);
  }
  return { indexed_sheets: indexed, scanned_sheets: sourceSheets.length };
}

module.exports = { indexTextForSheets };
