const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const { runPython } = require('./pyRunner');

const MERGE_SCRIPT = path.join(__dirname, '..', '..', 'pyproc', 'merge_pdfs.py');

// sheetRows: [{ sheet_number, version_id, title }] with each version's pdf_path resolvable by the caller.
function streamZip(res, entries) {
  res.type('application/zip');
  res.attachment('drawings.zip');
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error('zip export failed', err);
    res.destroy(err);
  });
  archive.pipe(res);
  for (const entry of entries) {
    archive.file(entry.pdf_path, { name: `${entry.sheet_number}.pdf` });
  }
  archive.finalize();
}

async function streamMergedPdf(res, entries) {
  const tmpDir = path.join(os.tmpdir(), `drawing-export-${crypto.randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const manifestPath = path.join(tmpDir, 'manifest.json');
  const outputPath = path.join(tmpDir, 'merged.pdf');

  try {
    const manifest = entries.map((e) => ({ path: e.pdf_path, title: `${e.sheet_number} - ${e.title || ''}`.trim() }));
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    await runPython(MERGE_SCRIPT, [manifestPath, outputPath]);

    res.type('application/pdf');
    res.attachment('drawings-merged.pdf');
    const stream = fs.createReadStream(outputPath);
    // Same crash-safety concern as the other file-serving routes: an
    // unhandled stream 'error' event is an uncaught exception that takes
    // down the whole server, not just this request.
    stream.on('error', (err) => {
      console.error('merged PDF stream failed', err);
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    stream.pipe(res);
    stream.on('close', () => fs.rm(tmpDir, { recursive: true, force: true }, () => {}));
  } catch (err) {
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
    throw err;
  }
}

module.exports = { streamZip, streamMergedPdf };
