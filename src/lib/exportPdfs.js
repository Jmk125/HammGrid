const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const { runPython } = require('./pyRunner');
const { annotatePdfToFile } = require('./annotatePdf');

const MERGE_SCRIPT = path.join(__dirname, '..', '..', 'pyproc', 'merge_pdfs.py');

// entries: [{ pdf_path, sheet_number, title, markups? }]. An entry with a
// non-empty `markups` array is annotated into a temp file before merging;
// callers that never pass `markups` (the plain project/share exports) pay
// nothing extra - the loop below just reuses pdf_path directly for them.
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
    // Sequential, not Promise.all - matches the Pi RAM-constrained,
    // one-at-a-time pyproc invocation pattern used everywhere else in this
    // codebase (queue.js, burst/OCR).
    const resolvedPaths = [];
    for (const e of entries) {
      let pdfPath = e.pdf_path;
      if (e.markups && e.markups.length) {
        const outPath = path.join(tmpDir, `annotated-${resolvedPaths.length}.pdf`);
        await annotatePdfToFile(e.pdf_path, e.markups, outPath);
        pdfPath = outPath;
      }
      resolvedPaths.push(pdfPath);
    }
    const manifest = entries.map((e, i) => ({ path: resolvedPaths[i], title: `${e.sheet_number} - ${e.title || ''}`.trim() }));
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
