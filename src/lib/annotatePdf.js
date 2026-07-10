const fs = require('fs');
const os = require('os');
const path = require('path');
const { runPython } = require('./pyRunner');

const ANNOTATE_SCRIPT = path.join(__dirname, '..', '..', 'pyproc', 'annotate_pdf.py');

// Renders markups onto pdfPath and writes the result to outPath. Caller owns
// both paths' lifecycle (this only creates its own scratch dir for the
// markups JSON, cleaned up immediately after the python call).
async function annotatePdfToFile(pdfPath, markups, outPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hammgrid-annotate-'));
  const jsonPath = path.join(dir, 'markups.json');
  fs.writeFileSync(jsonPath, JSON.stringify(markups));
  try {
    await runPython(ANNOTATE_SCRIPT, [pdfPath, jsonPath, outPath]);
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}

async function annotatePdfToResponse(res, pdfPath, markups, filename) {
  if (!markups.length) {
    res.download(pdfPath, filename);
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hammgrid-annotate-'));
  const outPath = path.join(dir, 'annotated.pdf');
  try {
    await annotatePdfToFile(pdfPath, markups, outPath);
  } catch (err) {
    fs.rm(dir, { recursive: true, force: true }, () => {});
    res.status(500).json({ error: 'Failed to annotate PDF', detail: err.message });
    return;
  }
  res.download(outPath, filename, () => fs.rm(dir, { recursive: true, force: true }, () => {}));
}

module.exports = { annotatePdfToFile, annotatePdfToResponse };
