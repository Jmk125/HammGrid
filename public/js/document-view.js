import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';
import { setupZoomPan as setupSharedZoomPan } from '/js/zoomPan.js';
import { initMarkups } from '/js/markups.js';
import { renderUserMenu, applyTheme } from '/js/shell.js';
import { getCachedDocumentById, getCachedDocumentAsset } from '/js/offline-store.js';

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
let currentViewport = null; // set in renderPage() - needed to place search highlight rects
let currentRenderScale = null; // set in renderPage() - same

// ---------- Find-in-document text search ----------
let searchMatches = []; // [{ pageNum, item }] across the whole document, PDF.js text items
let searchIndex = -1;
let searchToken = 0; // bumped on every new search - lets an in-flight one detect it's stale and bail
const pageTextCache = new Map(); // pageNum -> textContent.items, so re-searching doesn't re-fetch

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
  const wrapEl = document.getElementById('zoom-wrap');
  // Registered before setupSharedZoomPan() below adds its own wheel
  // listener on the same element, so this one runs first and can
  // intercept: a plain vertical scroll (no ctrl/shift - see
  // wheelZoomRequiresCtrl below) that's already at the top/bottom edge of
  // the current page, with nothing left to pan, turns the page instead of
  // doing nothing - so scrolling reads through a multi-page document
  // continuously instead of stopping dead at each page's edge.
  // stopImmediatePropagation() suppresses zoomPan.js's own handler for
  // that same event; any other wheel event (mid-page pan, ctrl-zoom,
  // shift-pan) falls through untouched.
  wrapEl.addEventListener('wheel', handlePageBoundaryScroll, { passive: false });

  zoomPan = setupSharedZoomPan({
    wrapEl,
    innerEl: document.getElementById('zoom-pan-inner'),
    isPanBlocked: (e) => {
      if (markupsController && markupsController.isToolActive()) return true;
      // The page/gallery nav badges and the search bar are floating chrome
      // that sit on top of the canvas inside this same wrapEl, not the
      // drawing surface itself - without this, a touchstart landing on one
      // of their buttons still reaches this handler and (not being blocked)
      // calls preventDefault() to start a pan, which on iOS Safari also
      // silently suppresses the synthetic click the button needed to fire
      // at all. Same convention as sheet.js's isPanBlocked (its
      // "floating UI chrome" branch).
      const tag = (e.target.tagName || '').toLowerCase();
      return tag !== 'svg' && tag !== 'canvas' && e.target !== wrapEl;
    },
    wheelZoomRequiresCtrl: true,
    onChange: (state) => {
      if (!suppressInteractionFlag) userHasZoomedOrPanned = true;
      if (markupsController) {
        markupsController.setZoomScale(state.scale);
        markupsController.repositionPopup();
      }
    },
  });
}

// A fast mouse wheel or trackpad fires many discrete events per physical
// scroll gesture. Without this lock, several of those events land while
// the first triggered transition's renderPage() is still awaiting - at
// that point currentPage has already advanced (set synchronously below)
// but zoomPan.state.y hasn't been repositioned yet, so the boundary check
// still reads "at the edge" and queues another transition, letting one
// scroll gesture skip several pages. Held for the full transition,
// including the pan reposition after render.
let pageTransitionInFlight = false;

function handlePageBoundaryScroll(e) {
  if (e.ctrlKey || e.shiftKey || e.deltaY === 0 || !zoomPan) return;
  const wrapEl = document.getElementById('zoom-wrap');
  const canvas = document.getElementById('pdf-canvas');
  const wrapRect = wrapEl.getBoundingClientRect();
  const TOL = 2; // px slack for float drift (e.g. fitToView's 0.96 margin)
  const pageTop = zoomPan.state.y;
  const pageBottom = zoomPan.state.y + canvas.height * zoomPan.state.scale;
  if (e.deltaY > 0 && pageBottom <= wrapRect.height + TOL && currentPage < numPages) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!pageTransitionInFlight) goToPageByScroll(1);
  } else if (e.deltaY < 0 && pageTop >= -TOL && currentPage > 1) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!pageTransitionInFlight) goToPageByScroll(-1);
  }
}

// Like goToPage() below, but for the continuous-scroll case above:
// preserves the current zoom scale and horizontal position across the
// page change instead of resetting to fit-to-view, and lands the new page
// at the edge being scrolled into (or centered, if the whole page already
// fits the viewport) so the motion reads as continuous. goToPage()'s
// always-fit-to-view behavior is unchanged for the explicit prev/next
// buttons.
async function goToPageByScroll(direction) {
  const n = currentPage + direction;
  if (n < 1 || n > numPages) return;
  pageTransitionInFlight = true;
  try {
    const wrapEl = document.getElementById('zoom-wrap');
    const wrapRect = wrapEl.getBoundingClientRect();
    const { scale, x } = zoomPan.state;
    currentPage = n;
    await renderPage();
    if (markupsController) markupsController.setPage(currentPage);
    const canvas = document.getElementById('pdf-canvas');
    const contentH = canvas.height * scale;
    suppressInteractionFlag = true;
    zoomPan.state.scale = scale;
    zoomPan.state.x = x;
    zoomPan.state.y =
      contentH <= wrapRect.height ? (wrapRect.height - contentH) / 2 : direction > 0 ? 0 : wrapRect.height - contentH;
    zoomPan.apply();
    suppressInteractionFlag = false;
    userHasZoomedOrPanned = true;
  } finally {
    pageTransitionInFlight = false;
  }
}

// Lets a photo document cycle to the next/previous photo in the same folder
// (a "progress photos" folder is the obvious case) without going back to the
// table view each time. Reuses the folder-scoped list the documents.js table
// already fetches, filtered/sorted the same way (is_image, name order) so
// "next" here matches what "next row down" would be there. A full page
// navigation, same pattern as sheet.js's prev/next sheet buttons - simpler
// and more robust than trying to reset all the canvas/markup state in place.
async function setupGalleryNav(doc) {
  try {
    const { documents } = await api('GET', `/api/projects/${doc.project_id}/documents`);
    const images = documents
      .filter((d) => d.is_image && (d.folder_id || null) === (doc.folder_id || null))
      .sort((a, b) => a.name.localeCompare(b.name));
    const idx = images.findIndex((d) => d.id === doc.id);
    if (idx === -1 || images.length < 2) return; // this document isn't an image, or nothing else to cycle to
    document.getElementById('gallery-nav-badge').style.display = '';
    document.getElementById('doc-gallery-label').textContent = `Photo ${idx + 1} / ${images.length}`;
    const prevBtn = document.getElementById('doc-gallery-prev-btn');
    const nextBtn = document.getElementById('doc-gallery-next-btn');
    prevBtn.disabled = idx <= 0;
    nextBtn.disabled = idx >= images.length - 1;
    prevBtn.addEventListener('click', () => {
      if (idx > 0) window.location.href = `/document-view.html?documentId=${images[idx - 1].id}`;
    });
    nextBtn.addEventListener('click', () => {
      if (idx < images.length - 1) window.location.href = `/document-view.html?documentId=${images[idx + 1].id}`;
    });
  } catch (err) {
    // Gallery nav is a convenience, not critical to viewing the document.
  }
}

function updatePageNavBadge() {
  const badge = document.getElementById('page-nav-badge');
  const scrubber = document.getElementById('page-scrubber');
  if (numPages <= 1) {
    badge.style.display = 'none';
    scrubber.style.display = 'none';
    return;
  }
  badge.style.display = '';
  scrubber.style.display = '';
  document.getElementById('doc-page-label').textContent = `Page ${currentPage} / ${numPages}`;
  document.getElementById('doc-page-prev-btn').disabled = currentPage <= 1;
  document.getElementById('doc-page-next-btn').disabled = currentPage >= numPages;
  if (!pageScrubDrag) updateScrubberHandle(currentPage);
}

// Click-anywhere-to-jump / drag-to-scrub rail for a long document, an
// alternative to repeatedly clicking the prev/next page arrows above.
// pageScrubDrag is non-null for the duration of a physical drag - gates
// updatePageNavBadge's own handle repositioning above so a slow in-flight
// render doesn't visually snap the handle back under the user's still-moving
// finger/cursor before they've let go.
let pageScrubDrag = null; // { pointerId | null } - null pointerId means mouse
// Only one goToPage() render is ever in flight - see scrubToPage below for
// why (mid-drag, mousemove fires far faster than a full-res PDF page can
// render).
let scrubTargetPage = null;
let scrubRenderInFlight = false;

function updateScrubberHandle(page) {
  const track = document.getElementById('page-scrubber-track');
  const handle = document.getElementById('page-scrubber-handle');
  const frac = numPages > 1 ? (page - 1) / (numPages - 1) : 0;
  handle.style.top = `${frac * track.clientHeight}px`;
  handle.textContent = String(page);
}

function pageFromClientY(clientY) {
  const track = document.getElementById('page-scrubber-track');
  const rect = track.getBoundingClientRect();
  if (!rect.height) return currentPage;
  const frac = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
  return Math.round(frac * (numPages - 1)) + 1;
}

// Coalesces to whatever page was most recently requested rather than
// rendering every page the cursor crosses - a fast drag from page 1 to 40
// fires far more mousemoves than a full-resolution PDF render can keep up
// with, and queuing each one in order would make the view lag noticeably
// behind the handle instead of catching up to where the user actually is.
async function scrubToPage(n) {
  scrubTargetPage = Math.min(numPages, Math.max(1, n));
  if (scrubRenderInFlight) return;
  scrubRenderInFlight = true;
  try {
    while (scrubTargetPage !== null && scrubTargetPage !== currentPage) {
      const target = scrubTargetPage;
      scrubTargetPage = null;
      await goToPage(target);
    }
  } finally {
    scrubRenderInFlight = false;
  }
}

function setupPageScrubber() {
  const track = document.getElementById('page-scrubber-track');

  function pointFromEvent(e) {
    return e.touches && e.touches.length ? e.touches[0] : e;
  }

  function start(e) {
    if (e.touches && e.touches.length > 1) return;
    e.preventDefault();
    pageScrubDrag = {};
    const page = pageFromClientY(pointFromEvent(e).clientY);
    updateScrubberHandle(page);
    scrubToPage(page);
  }
  function move(e) {
    if (!pageScrubDrag) return;
    if (e.touches && e.touches.length > 1) return;
    e.preventDefault();
    const page = pageFromClientY(pointFromEvent(e).clientY);
    updateScrubberHandle(page);
    scrubToPage(page);
  }
  function end() {
    if (!pageScrubDrag) return;
    pageScrubDrag = null;
    updateScrubberHandle(currentPage);
  }

  track.addEventListener('mousedown', start);
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  track.addEventListener('touchstart', start, { passive: false });
  window.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('touchend', end);
  window.addEventListener('touchcancel', end);
}

async function renderPage() {
  const statusEl = document.getElementById('pdf-status');
  const canvas = document.getElementById('pdf-canvas');
  const page = await currentPdf.getPage(currentPage);
  const unitViewport = page.getViewport({ scale: 1 });
  const longestPt = Math.max(unitViewport.width, unitViewport.height);
  const renderScale = Math.min(RENDER_SCALE, MAX_RENDER_PX / longestPt);
  const viewport = page.getViewport({ scale: renderScale });
  currentViewport = viewport;
  currentRenderScale = renderScale;
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  await page.render({ canvasContext: ctx, viewport }).promise;
  statusEl.textContent = '';
  if (markupsController) markupsController.resync();
  updatePageNavBadge();
  renderSearchHighlights();
}

// Loads a non-PDF file (a photo, now that the document store accepts those -
// see documents.routes.js) straight into the same canvas the PDF path uses.
// Everything downstream - zoom/pan, markups, fitToView - is already just
// canvas-pixel-space math with no idea whether a PDF page or an image put
// those pixels there, so this needs zero changes anywhere else.
function renderImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.getElementById('pdf-canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0);
      currentPdf = null;
      currentViewport = null;
      currentRenderScale = null;
      numPages = 1;
      currentPage = 1;
      document.getElementById('pdf-status').textContent = '';
      if (markupsController) markupsController.resync();
      updatePageNavBadge();
      fitToView(canvas.width, canvas.height);
      resolve(true);
    };
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

// Tries a URL as a PDF first, falling back to plain image (renderImage) -
// shared by the live fetch path and the offline cached-blob path below, so
// neither has to duplicate PDF-vs-image detection.
async function renderFromUrl(url) {
  const canvas = document.getElementById('pdf-canvas');
  try {
    const loadingTask = pdfjsLib.getDocument({ url });
    currentPdf = await loadingTask.promise;
    numPages = currentPdf.numPages;
    currentPage = 1;
    await renderPage();
    fitToView(canvas.width, canvas.height);
    document.getElementById('doc-search-btn').style.display = ''; // only shown once there's a real text layer to search
    return true;
  } catch (err) {
    return renderImage(url);
  }
}

async function renderPdf() {
  const statusEl = document.getElementById('pdf-status');
  statusEl.textContent = 'Loading...';
  const fileUrl = shareToken
    ? `/api/share/${shareToken}/documents/${documentId}/pdf`
    : stagedSheetId
    ? `/api/staged-sheets/${stagedSheetId}/pdf`
    : versionId ? `/api/document-versions/${versionId}/pdf` : `/api/documents/${documentId}/pdf`;
  if (await renderFromUrl(fileUrl)) return;

  // Live fetch failed (as both a PDF and an image) - try the cached blob
  // before giving up entirely (see documents.js's cacheDocuments/
  // offline-store.js's getCachedDocumentAsset). Only meaningful for "the
  // current version of a real saved document" - share links and staged
  // (not-yet-published) sheets have no offline cache at all, and only the
  // CURRENT version's file is ever cached (same delta-sync scope sheets
  // already use), not arbitrary historical ?versionId= ones.
  if (!shareToken && !stagedSheetId && !versionId) {
    const doc = await getCachedDocumentById(documentId);
    const blob = doc && doc.current_version_id ? await getCachedDocumentAsset(doc.current_version_id) : null;
    if (blob && (await renderFromUrl(URL.createObjectURL(blob)))) return;
  }
  statusEl.textContent = navigator.onLine
    ? 'Failed to render document.'
    : "Offline, and this document isn't cached on this device yet - open it once while online first.";
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

// ---------- Find-in-document text search ----------
// PDF.js text items only, so this only ever runs for a real PDF (the search
// button stays hidden for a photo document - see renderPdf()). Searches
// every page up front rather than page-by-page as you navigate, since these
// are RFI/submittal-scale documents (a handful of pages), not the hundreds-
// of-sheets drawing sets sheet.js deals with.
function ensureSearchHighlightLayer() {
  const svg = document.getElementById('markup-svg');
  let g = svg.querySelector('#search-highlight-layer');
  if (!g) {
    g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.id = 'search-highlight-layer';
    svg.appendChild(g);
  }
  return g;
}

function clearSearchHighlights() {
  ensureSearchHighlightLayer().innerHTML = '';
}

// item.transform is unscaled PDF-point space - combining it with the
// render viewport's own transform (render scale + the PDF-bottom-up ->
// canvas-top-down y-flip) lands directly in canvas-pixel space, same idiom
// sheet.js's own drawSearchHighlights uses for its (unrelated) sheet-number
// search highlight.
function searchItemRect(item) {
  const tx = pdfjsLib.Util.transform(currentViewport.transform, item.transform);
  const w = item.width * currentRenderScale;
  const h = item.height * currentRenderScale;
  return { x: tx[4], y: tx[5] - h, w, h };
}

function renderSearchHighlights() {
  const layer = ensureSearchHighlightLayer();
  layer.innerHTML = '';
  if (!currentViewport) return;
  searchMatches.forEach((m, i) => {
    if (m.pageNum !== currentPage) return;
    const r = searchItemRect(m.item);
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', r.x);
    rect.setAttribute('y', r.y);
    rect.setAttribute('width', r.w);
    rect.setAttribute('height', r.h);
    rect.classList.add('search-highlight-rect');
    if (i === searchIndex) rect.classList.add('search-highlight-current');
    layer.appendChild(rect);
  });
}

async function getPageTextItems(pageNum) {
  if (pageTextCache.has(pageNum)) return pageTextCache.get(pageNum);
  const page = await currentPdf.getPage(pageNum);
  const textContent = await page.getTextContent();
  pageTextCache.set(pageNum, textContent.items);
  return textContent.items;
}

function setSearchCount(text) {
  document.getElementById('doc-search-count').textContent = text;
}

function setSearchNavEnabled(enabled) {
  document.getElementById('doc-search-prev-btn').disabled = !enabled;
  document.getElementById('doc-search-next-btn').disabled = !enabled;
}

async function runSearch(term) {
  const myToken = ++searchToken;
  searchMatches = [];
  searchIndex = -1;
  clearSearchHighlights();
  setSearchNavEnabled(false);

  const trimmed = term.trim();
  if (!trimmed || !currentPdf) {
    setSearchCount('');
    return;
  }
  setSearchCount('Searching…');
  const needle = trimmed.toLowerCase();
  const matches = [];
  for (let p = 1; p <= numPages; p++) {
    const items = await getPageTextItems(p);
    if (myToken !== searchToken) return; // a newer search started while this one was still indexing
    for (const item of items) {
      if (item.str && item.str.toLowerCase().includes(needle)) matches.push({ pageNum: p, item });
    }
  }
  if (myToken !== searchToken) return;

  searchMatches = matches;
  if (matches.length === 0) {
    setSearchCount('No matches');
    return;
  }
  setSearchNavEnabled(true);
  await goToSearchMatch(0);
}

async function goToSearchMatch(idx) {
  if (searchMatches.length === 0) return;
  searchIndex = ((idx % searchMatches.length) + searchMatches.length) % searchMatches.length; // wraps both directions
  const match = searchMatches[searchIndex];
  await goToPage(match.pageNum); // no-op (including no re-render) if already on that page
  renderSearchHighlights(); // goToPage() only re-renders (and re-highlights) on an actual page change
  setSearchCount(`${searchIndex + 1} / ${searchMatches.length}`);
  const canvas = document.getElementById('pdf-canvas');
  if (canvas.width) {
    const r = searchItemRect(match.item);
    userHasZoomedOrPanned = true;
    panToRect(r.x / canvas.width, r.y / canvas.height, r.w / canvas.width, r.h / canvas.height);
  }
}

(function setupDocumentSearch() {
  const bar = document.getElementById('doc-search-bar');
  const input = document.getElementById('doc-search-input');
  let debounceTimer = null;

  function closeSearch() {
    bar.style.display = 'none';
    input.value = '';
    runSearch('');
  }

  document.getElementById('doc-search-btn').addEventListener('click', () => {
    const opening = bar.style.display === 'none';
    bar.style.display = opening ? '' : 'none';
    if (opening) input.focus();
    else closeSearch();
  });
  document.getElementById('doc-search-close-btn').addEventListener('click', closeSearch);
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runSearch(input.value), 300);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (searchMatches.length === 0) {
        clearTimeout(debounceTimer);
        runSearch(input.value);
      } else {
        goToSearchMatch(searchIndex + (e.shiftKey ? -1 : 1));
      }
    } else if (e.key === 'Escape') {
      closeSearch();
    }
  });
  document.getElementById('doc-search-prev-btn').addEventListener('click', () => goToSearchMatch(searchIndex - 1));
  document.getElementById('doc-search-next-btn').addEventListener('click', () => goToSearchMatch(searchIndex + 1));
})();

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

(async function init() {
  let projectId = null;

  if (shareToken) {
    document.getElementById('user-menu-slot').style.display = 'none';
    document.querySelector('.brand').textContent = 'HammGrid — Shared Document';
    document.getElementById('doc-label').textContent = 'Shared document';
  } else {
    const me = await requireSession();
    if (!me) return;
    applyTheme(me.settings);
    renderUserMenu(document.getElementById('user-menu-slot'), me);

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
        // Only for the plain "current version" view - navigating to a sibling
        // photo would otherwise ditch the "specific historical version"
        // context of a ?versionId= link in a confusing way.
        if (!versionId) await setupGalleryNav(doc);
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
  setupPageScrubber();
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
