const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('../config');

function annotatePdfToResponse(res, pdfPath, markups, filename) {
  if (!markups.length) {
    res.download(pdfPath, filename);
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hammgrid-annotate-'));
  const jsonPath = path.join(dir, 'markups.json');
  const outPath = path.join(dir, 'annotated.pdf');
  fs.writeFileSync(jsonPath, JSON.stringify(markups));
  const script = path.join(__dirname, '..', '..', 'pyproc', 'annotate_pdf.py');
  const result = spawnSync(config.pythonPath, [script, pdfPath, jsonPath, outPath], { encoding: 'utf8' });
  if (result.status !== 0) {
    fs.rm(dir, { recursive: true, force: true }, () => {});
    res.status(500).json({ error: 'Failed to annotate PDF', detail: result.stderr || result.stdout });
    return;
  }
  res.download(outPath, filename, () => fs.rm(dir, { recursive: true, force: true }, () => {}));
}

module.exports = { annotatePdfToResponse };
