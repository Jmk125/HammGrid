import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';
import { setupZoomPan as setupSharedZoomPan } from '/js/zoomPan.js';
import { initMarkups } from '/js/markups.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

const params = new URLSearchParams(window.location.search);
const documentId = params.get('documentId');
const shareToken = params.get('token');
const versionId = params.get('versionId'); // optional - view a specific historical revision instead of current
// Lets the revision review table's "View" button open a not-yet-published
// staged sheet's PDF in this same viewer, instead of downloading the raw
// file and handing it to the OS's PDF viewer.
const stagedSheetId = params.get('stagedSheetId');
const flagIdParam = params.get('flagId');
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
let suppressInteractionFlag = false;
let userHasZoomedOrPanned = false;
let markupsController = null;
let currentPage = 1;
let numPages = 1;
let currentPdf = null;

// Markups/flags only make sense for a real, logged-in view of a saved
// document - not a contractor share-token link (those have their own
// separate, simpler share_markups system) and not a staged/not-yet-
// published sheet review (there's no saved document_id to attach to yet).
const markupsEnabled = !shareToken && !stagedSheetId;

function fitToView(canvasWidth, canvasHeight) {
  zoomPan.fitToView(canvasWidth, canvasHeight);
}

// Pans/zooms in on a single rect (fractional 0..1 page coordinates, e.g. a
// flag's geometry) instead of fitting the whole page - used when arriving
// via a ?flagId= link. Adapted directly from sheet.js's panToRect.
function panToRect(fracX, fracY, fracW, fracH) {
  const canvas = document.getElementById('pdf-canvas');
  const wrapEl = document.getElementById('zoom-wrap');
  if (!canvas.width || !zoomPan) return;
  const rect = wrapEl.getBoundingClientRect();
  if (!rect.width) return;
  const rectPxX = fracX * canvas.width;
  const rectPxY = fracY * canvas.height;
  const rectPxW = fracW * canvas.width;
  const rectPxH = fracH * canvas.height;
  const PAD = 4;
  const targetW = Math.max(rectPxW * PAD, 300);
  const targetH = Math.max(rectPxH * PAD, 300);
  const scale = Math.min(rect.width / targetW, rect.height / targetH, 4);
  const cx = rectPxX + rectPxW / 2;
  const cy = rectPxY + rectPxH / 2;
  suppressInteractionFlag = true;
  zoomPan.state.scale = scale;
  zoomPan.state.x = rect.width / 2 - cx * scale;
  zoomPan.state.y = rect.height / 2 - cy * scale;
  zoomPan.apply();
  suppressInteractionFlag = false;
}

function setupZoomPan() {
  zoomPan = setupSharedZoomPan({
    wrapEl: document.getElementById('zoom-wrap'),
    innerEl: document.getElementById('zoom-pan-inner'),
    isPanBlocked: () => !!(markupsController && markupsController.isToolActive()),
    onChange: (state) => {
      if (!suppressInteractionFlag) userHasZoomedOrPanned = true;
      if (markupsController) {
        markupsController.setZoomScale(state.scale);
        markupsController.repositionPopup();
      }
    },
  });
}

function updatePageNavBadge() {
  const badge = document.getElementById('page-nav-badge');
  if (numPages <= 1) {
    badge.style.display = 'none';
    return;
  }
  badge.style.display = '';
  document.getElementById('doc-page-label').textContent = `Page ${currentPage} / ${numPages}`;
  document.getElementById('doc-page-prev-btn').disabled = currentPage <= 1;
  document.getElementById('doc-page-next-btn').disabled = currentPage >= numPages;
}

async function renderPage() {
  const statusEl = document.getElementById('pdf-status');
  const canvas = document.getElementById('pdf-canvas');
  const page = await currentPdf.getPage(currentPage);
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
  if (markupsController) markupsController.resync();
  updatePageNavBadge();
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
    currentPdf = await loadingTask.promise;
    numPages = currentPdf.numPages;
    currentPage = 1;
    await renderPage();
    fitToView(canvas.width, canvas.height);
  } catch (err) {
    statusEl.textContent = `Failed to render document: ${err.message}`;
  }
}

async function goToPage(n) {
  if (n < 1 || n > numPages || n === currentPage) return;
  currentPage = n;
  await renderPage();
  if (markupsController) markupsController.setPage(currentPage);
  fitToView(document.getElementById('pdf-canvas').width, document.getElementById('pdf-canvas').height);
}

document.getElementById('doc-page-prev-btn').addEventListener('click', () => goToPage(currentPage - 1));
document.getElementById('doc-page-next-btn').addEventListener('click', () => goToPage(currentPage + 1));

// ---------- Right pane: collapse + resize (mirrors sheet.js's setup, kept
// self-contained here since this is a separate page/module) ----------
(function setupPaneToggle() {
  const pane = document.getElementById('sheet-pane');
  const btn = document.getElementById('pane-toggle-btn');
  const key = 'hammgrid-doc-pane-collapsed';
  if (localStorage.getItem(key) === '1') pane.classList.add('collapsed');
  btn.addEventListener('click', () => {
    pane.classList.toggle('collapsed');
    localStorage.setItem(key, pane.classList.contains('collapsed') ? '1' : '0');
  });
})();

(function setupPaneResize() {
  const pane = document.getElementById('sheet-pane');
  const handle = document.getElementById('pane-resize-handle');
  const key = 'hammgrid-doc-pane-width';
  const MIN_WIDTH = 260;
  const MAX_WIDTH = 640;
  const saved = parseInt(localStorage.getItem(key), 10);
  if (saved >= MIN_WIDTH && saved <= MAX_WIDTH) pane.style.width = `${saved}px`;
  let dragging = false;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    handle.classList.add('dragging');
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = pane.getBoundingClientRect();
    const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, rect.right - e.clientX));
    pane.style.width = `${width}px`;
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    localStorage.setItem(key, String(Math.round(pane.getBoundingClientRect().width)));
  });
})();

document.querySelectorAll('.pane-section-header').forEach((header) => {
  const section = header.closest('.pane-section');
  const collapseKey = `hammgrid-pane-section-collapsed:${header.dataset.section}`;
  if (localStorage.getItem(collapseKey) === '1') section.classList.add('collapsed');
  header.addEventListener('click', () => {
    section.classList.toggle('collapsed');
    localStorage.setItem(collapseKey, section.classList.contains('collapsed') ? '1' : '0');
  });
});

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
  let projectId = null;

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
        projectId = doc.project_id;
        const shownVersion = versionId ? versions.find((v) => String(v.id) === versionId) : versions[0];
        const revisionLabel = shownVersion && shownVersion.revision_name ? shownVersion.revision_name : 'Original';
        const issueDate = shownVersion && shownVersion.issue_date ? ` (${shownVersion.issue_date})` : '';
        const staleNote = versionId && versions[0] && String(versions[0].id) !== versionId ? ' — not the current version' : '';
        document.getElementById('doc-label').textContent = `${doc.name} — ${revisionLabel}${issueDate}${staleNote}`;
      } catch (err) {
        // metadata fetch failed - still try to render the PDF itself
      }
    }

    if (markupsEnabled) {
      document.getElementById('sheet-pane').style.display = '';
      markupsController = initMarkups({
        apiBase: `/api/documents/${documentId}`,
        projectId,
        me,
        svgEl: document.getElementById('markup-svg'),
        canvasEl: document.getElementById('pdf-canvas'),
        documents: [],
        folders: [],
        page: currentPage,
        onToolChange: () => {},
      });
    }
  }

  setupZoomPan();
  await renderPdf();

  if (markupsEnabled && markupsController) {
    await markupsController.load();
    if (flagIdParam) {
      const geometry = markupsController.focusMarkup(flagIdParam);
      if (geometry) {
        if (geometry.page && geometry.page !== currentPage) {
          await goToPage(geometry.page);
        }
        userHasZoomedOrPanned = true;
        panToRect(geometry.x, geometry.y, geometry.w, geometry.h);
      }
    }
  }
})();
