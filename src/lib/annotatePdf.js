const fs = require('fs');
const os = require('os');
const path = require('path');
const { runPython } = require('./pyRunner');

const ANNOTATE_SCRIPT = path.join(__dirname, '..', '..', 'pyproc', 'annotate_pdf.py');

// Renders markups (and, optionally, take-off shapes + a legend box - see
// the sheet pane's take-off legend toggle) onto pdfPath and writes the
// result to outPath. Caller owns both paths' lifecycle (this only creates
// its own scratch dir for the markups JSON, cleaned up immediately after
// the python call). `extra` is passed through to annotate_pdf.py verbatim
// as extra top-level keys alongside `markups` - existing callers that never
// pass it are unaffected (the script treats missing takeoffs/legend as
// empty/absent).
async function annotatePdfToFile(pdfPath, markups, outPath, extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hammgrid-annotate-'));
  const jsonPath = path.join(dir, 'markups.json');
  fs.writeFileSync(jsonPath, JSON.stringify({ markups, ...extra }));
  try {
    await runPython(ANNOTATE_SCRIPT, [pdfPath, jsonPath, outPath]);
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}

async function annotatePdfToResponse(res, pdfPath, markups, filename, extra) {
  const hasTakeoffs = extra && Array.isArray(extra.takeoffs) && extra.takeoffs.length;
  const hasLegend = extra && extra.legend;
  if (!markups.length && !hasTakeoffs && !hasLegend) {
    res.download(pdfPath, filename);
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hammgrid-annotate-'));
  const outPath = path.join(dir, 'annotated.pdf');
  try {
    await annotatePdfToFile(pdfPath, markups, outPath, extra);
  } catch (err) {
    fs.rm(dir, { recursive: true, force: true }, () => {});
    res.status(500).json({ error: 'Failed to annotate PDF', detail: err.message });
    return;
  }
  res.download(outPath, filename, () => fs.rm(dir, { recursive: true, force: true }, () => {}));
}

module.exports = { annotatePdfToFile, annotatePdfToResponse };
