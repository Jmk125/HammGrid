import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';
import { setupZoomPan as setupSharedZoomPan } from '/js/zoomPan.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

const params = new URLSearchParams(window.location.search);
const documentId = params.get('documentId');
const shareToken = params.get('token');
const versionId = params.get('versionId'); // optional - view a specific historical revision instead of current
// Lets the revision review table's "View" button open a not-yet-published
// staged sheet's PDF in this same viewer, instead of downloading the raw
// file and handing it to the OS's PDF viewer.
const stagedSheetId = params.get('stagedSheetId');
const RENDER_SCALE = 2.5;
// Same large-format-sheet safety cap as sheet.js's viewer - a blind
// RENDER_SCALE multiply on an E-size-and-bigger architectural/civil sheet
// (very common for staged sheets specifically, since this viewer is now
// also used for reviewing not-yet-published drawings before they're
// sheets - see MAX_RENDER_PX in sheet.js for the original bug this caused
// there: an 8640x6480px canvas that rendered painfully slowly or only
// partially. This page originally only ever served small RFI/submittal
// documents (never large-format), so it never needed this - it does now.
const MAX_RENDER_PX = 6000;

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
  const pdfUrl = shareToken
    ? `/api/share/${shareToken}/documents/${documentId}/pdf`
    : stagedSheetId
    ? `/api/staged-sheets/${stagedSheetId}/pdf`
    : versionId ? `/api/document-versions/${versionId}/pdf` : `/api/documents/${documentId}/pdf`;
  try {
    const loadingTask = pdfjsLib.getDocument({ url: pdfUrl });
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(1);
    const unitViewport = page.getViewport({ scale: 1 });
    const longestPt = Math.max(unitViewport.width, unitViewport.height);
    const renderScale = Math.min(RENDER_SCALE, MAX_RENDER_PX / longestPt);
    const viewport = page.getViewport({ scale: renderScale });
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

document.getElementById('back-btn').addEventListener('click', () => {
  window.close();
  if (!window.closed) {
    history.back();
  }
});

document.getElementById('download-doc-btn').addEventListener('click', () => {
  window.location.href = shareToken
    ? `/api/share/${shareToken}/documents/${documentId}/download`
    : versionId ? `/api/document-versions/${versionId}/download` : `/api/documents/${documentId}/download`;
});

document.getElementById('logout').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout');
  window.location.href = '/login.html';
});

(async function init() {
  if (shareToken) {
    document.getElementById('logout').style.display = 'none';
    document.getElementById('whoami').style.display = 'none';
    document.querySelector('.brand').textContent = 'HammGrid — Shared Document';
    document.getElementById('doc-label').textContent = 'Shared document';
  } else {
    const me = await requireSession();
    if (!me) return;
    document.getElementById('whoami').textContent = `${me.name} (${me.role})`;

    if (stagedSheetId) {
      // Not yet a published document/sheet - no metadata endpoint to fetch,
      // and no useful "download" action for a draft that hasn't been
      // reviewed yet. revision.js passes the sheet number it already has in
      // memory as `label` rather than this page needing its own fetch.
      const label = params.get('label');
      document.getElementById('doc-label').textContent = label ? `Staged: ${label}` : 'Staged sheet (not yet published)';
      document.getElementById('download-doc-btn').style.display = 'none';
    } else {
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
    }
  }

  setupZoomPan();
  await renderPdf();
})();
