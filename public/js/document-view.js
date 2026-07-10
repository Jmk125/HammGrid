import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

const params = new URLSearchParams(window.location.search);
const documentId = params.get('documentId');
const versionId = params.get('versionId'); // optional - view a specific historical revision instead of current
const RENDER_SCALE = 2.5;

const zoomState = { scale: 1, x: 0, y: 0 };

function applyZoomTransform() {
  document.getElementById('zoom-pan-inner').style.transform =
    `translate(${zoomState.x}px, ${zoomState.y}px) scale(${zoomState.scale})`;
}

function fitToView(canvasWidth, canvasHeight) {
  const wrap = document.getElementById('zoom-wrap');
  const rect = wrap.getBoundingClientRect();
  const fitScale = Math.min(rect.width / canvasWidth, rect.height / canvasHeight) * 0.96;
  zoomState.scale = fitScale;
  zoomState.x = (rect.width - canvasWidth * fitScale) / 2;
  zoomState.y = (rect.height - canvasHeight * fitScale) / 2;
  applyZoomTransform();
}

function setupZoomPan() {
  const wrap = document.getElementById('zoom-wrap');
  wrap.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (e.shiftKey) {
        zoomState.x -= e.deltaY;
      } else {
        const rect = wrap.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        const newScale = Math.min(6, Math.max(0.1, zoomState.scale * factor));
        zoomState.x = cx - (cx - zoomState.x) * (newScale / zoomState.scale);
        zoomState.y = cy - (cy - zoomState.y) * (newScale / zoomState.scale);
        zoomState.scale = newScale;
      }
      applyZoomTransform();
    },
    { passive: false }
  );

  let pan = null;
  wrap.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    pan = { startX: e.clientX, startY: e.clientY, origX: zoomState.x, origY: zoomState.y };
    wrap.classList.add('panning');
  });
  window.addEventListener('mousemove', (e) => {
    if (!pan) return;
    zoomState.x = pan.origX + (e.clientX - pan.startX);
    zoomState.y = pan.origY + (e.clientY - pan.startY);
    applyZoomTransform();
  });
  window.addEventListener('mouseup', () => {
    pan = null;
    wrap.classList.remove('panning');
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
