import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

const params = new URLSearchParams(window.location.search);
const token = params.get('token');
const versionId = params.get('versionId');
document.getElementById('back-link').href = `/share.html?token=${token}`;

(async function render() {
  const statusEl = document.getElementById('pdf-status');
  statusEl.textContent = 'Loading...';
  const canvas = document.getElementById('pdf-canvas');
  try {
    const loadingTask = pdfjsLib.getDocument(`/api/share/${token}/sheet-versions/${versionId}/pdf`);
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 2 });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    statusEl.textContent = '';
  } catch (err) {
    statusEl.textContent = `Failed to render PDF: ${err.message}`;
  }
})();
