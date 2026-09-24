const fs = require('fs');
const path = require('path');
const db = require('../db');
const { runPython } = require('./pyRunner');
const { isImagePath, mimeForPath } = require('./documentFileTypes');
const { streamFile } = require('./streamFile');

const THUMB_SCRIPT = path.join(__dirname, '..', '..', 'pyproc', 'photo_thumb.py');

// Sidecar file next to the photo itself - no schema column needed, and
// anything that deletes the photo can delete this alongside it.
function thumbPathFor(filePath) {
  return `${filePath}.thumb.jpg`;
}

// One at a time, same as the sheet ingest pipeline - a folder of photos
// uploaded in one go shouldn't spawn a Python process per photo at once.
const queue = [];
const queued = new Set();
let running = false;

function ensureThumb(filePath) {
  if (!filePath || !isImagePath(filePath) || queued.has(filePath) || fs.existsSync(thumbPathFor(filePath))) return;
  queued.add(filePath);
  queue.push(filePath);
  if (!running) drain();
}

async function drain() {
  running = true;
  while (queue.length) {
    const filePath = queue.shift();
    try {
      if (fs.existsSync(filePath)) await runPython(THUMB_SCRIPT, [filePath, thumbPathFor(filePath)]);
    } catch (err) {
      console.error(`Photo thumbnail failed for ${filePath}:`, err.message);
    }
    queued.delete(filePath);
  }
  running = false;
}

function removeThumb(filePath) {
  if (filePath) fs.rm(thumbPathFor(filePath), { force: true }, () => {});
}

function sendThumbOrOriginal(res, filePath) {
  const thumb = thumbPathFor(filePath);
  if (isImagePath(filePath) && fs.existsSync(thumb)) return streamFile(res, thumb, 'image/jpeg');
  ensureThumb(filePath);
  streamFile(res, filePath, mimeForPath(filePath));
}

// Photos uploaded before thumbnails existed - picked up once at startup.
function backfillThumbs() {
  const rows = db.prepare('SELECT pdf_path FROM document_versions').all();
  for (const { pdf_path } of rows) ensureThumb(pdf_path);
}

module.exports = { thumbPathFor, ensureThumb, removeThumb, backfillThumbs, sendThumbOrOriginal };
