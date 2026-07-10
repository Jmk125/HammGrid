import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';
import { setupZoomPan as setupSharedZoomPan } from '/js/zoomPan.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

const params = new URLSearchParams(window.location.search);
const documentId = params.get('documentId');
const versionId = params.get('versionId'); // optional - view a specific historical revision instead of current
const RENDER_SCALE = 2.5;

let zoomPan = null;

function fitToView(canvasWidth, canvasHeight) {
  zoomPan.fitToView(canvasWidth, canvasHeight);
}

function setupZoomPan() {
  zoomPan = setupSharedZoomPan({
    wrapEl: document.getElementById('zoom-wrap'),
    innerEl: document.getElementById('zoom-pan-inner'),
  });
}

async function renderPdf() {
  const statusEl = document.getElementById('pdf-status');
  statusEl.textContent = 'Loading...';
  const canvas = document.getElementById('pdf-canvas');
  const pdfUrl = versionId ? `/api/document-versions/${versionId}/pdf` : `/api/documents/${documentId}/pdf`;
  try {
    const loadingTask = pdfjsLib.getDocument({ url: pdfUrl });
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    await page.render({ canvasContext: ctx, viewport }).promise;
    statusEl.textContent = '';
    fitToView(canvas.width, canvas.height);
  } catch (err) {
    statusEl.textContent = `Failed to render document: ${err.message}`;
  }
}

document.getElementById('logout').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout');
  window.location.href = '/login.html';
});

(async function init() {
  const me = await requireSession();
  if (!me) return;
  document.getElementById('whoami').textContent = `${me.name} (${me.role})`;

  try {
    const { document: doc, versions } = await api('GET', `/api/documents/${documentId}`);
    const shownVersion = versionId ? versions.find((v) => String(v.id) === versionId) : versions[0];
    const revisionLabel = shownVersion && shownVersion.revision_name ? shownVersion.revision_name : 'Original';
    const issueDate = shownVersion && shownVersion.issue_date ? ` (${shownVersion.issue_date})` : '';
    const staleNote = versionId && versions[0] && String(versions[0].id) !== versionId ? ' — not the current version' : '';
    document.getElementById('doc-label').textContent = `${doc.name} — ${revisionLabel}${issueDate}${staleNote}`;
  } catch (err) {
    // metadata fetch failed - still try to render the PDF itself
  }

  setupZoomPan();
  await renderPdf();
})();
