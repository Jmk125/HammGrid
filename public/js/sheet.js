import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';
import { initMarkups } from '/js/markups.js';
import { getCachedAsset, getCachedSheets, updateCachedSheetMetadata } from '/js/offline-store.js';
import { renderShell, openModal, closeModal, showToast, promptModal, confirmModal } from '/js/shell.js';
import { setupZoomPan as setupSharedZoomPan } from '/js/zoomPan.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

const RENDER_SCALE = 2.5; // PDF points -> canvas pixels, for normal-sized sheets
// Large-format sheets (ARCH E1/E and bigger, common for full-building or
// civil/site plans) would otherwise render at 8000-16000+ px per side at
// RENDER_SCALE - a canvas that large is exactly the kind of thing that
// silently fails (blank canvas, or only partially painted) on memory-
// constrained browsers, especially iPad Safari, which is the actual
// field-use target per CLAUDE.md. Cap the longest side instead of always
// multiplying blindly, same pattern already used server-side for OCR
// rendering (see pyproc/ocr_region.py) after that exact failure mode hit a
// large sheet there too.
const MAX_RENDER_PX = 6000;
let currentRenderScale = RENDER_SCALE; // set per-render below; measurement math must use this, not the constant, once large sheets scale it down

const params = new URLSearchParams(window.location.search);
const projectId = params.get('projectId');
const sheetId = params.get('sheetId');

let markupsController = null;
let currentSheet = null;
let sheetLinkLoadToken = 0;
let canManage = false;
let canTakeoff = false;
let allVersions = [];
let displayedVersionId = null;
let overlayActive = false;
let overlayLayers = { a: null, b: null, showA: true, showB: true };
// Cached <img> elements so drag-align/rotate only re-composites pixels
// instead of re-fetching both preview images from the network every frame.
let overlayImages = { a: null, b: null };
let overlayTransform = { a: { tx: 0, ty: 0, rotation: 0 }, b: { tx: 0, ty: 0, rotation: 0 } };
let overlayAlignActive = false;
let overlayAlignTarget = 'b';
let overlayDrag = null;
let overlayRecomputeQueued = false;
let currentRenderTask = null;
let userHasZoomedOrPanned = false;
// Set at the end of every successful render, so the search-highlight step
// (and any other future feature needing the raw pdf.js page/viewport) can
// re-derive positions without re-rendering.
let currentPdfPage = null;
let currentViewport = null;
let activeSearchTerm = localStorage.getItem(searchStorageKey()) || '';

function searchStorageKey() {
  return `hammgrid-sheet-search:${projectId}`;
}

// ---------- Right pane: collapse + accordion sections ----------
(function setupPaneToggle() {
  const pane = document.getElementById('sheet-pane');
  const btn = document.getElementById('pane-toggle-btn');
  const key = 'sheet-pane-collapsed';
  if (localStorage.getItem(key) === '1') pane.classList.add('collapsed');
  btn.addEventListener('click', () => {
    pane.classList.toggle('collapsed');
    localStorage.setItem(key, pane.classList.contains('collapsed') ? '1' : '0');
  });
})();

document.querySelectorAll('.pane-section-header').forEach((header) => {
  header.addEventListener('click', () => {
    header.closest('.pane-section').classList.toggle('collapsed');
  });
});

// ---------- Zoom / pan (shared module - see zoomPan.js) ----------
let zoomPan = null;
let suppressInteractionFlag = false;

function setupZoomPan() {
  const wrapEl = document.getElementById('zoom-wrap');
  zoomPan = setupSharedZoomPan({
    wrapEl,
    innerEl: document.getElementById('zoom-pan-inner'),
    // Left or right both pan when idle; a take-off tool reserves left for
    // placing points and pans on right only; measure/markup fully block
    // panning (unchanged) since neither tool has a spare button to pan with.
    isButtonAllowed: (e) => e.button === 0 || e.button === 2,
    isPanBlocked: (e) => {
      if (overlayAlignActive) return true;
      if (markupsController && markupsController.isToolActive()) return true;
      if (measureTool) return true;
      if (editingInstance) return true;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag !== 'svg' && tag !== 'canvas') return true;
      if (takeoffTool) return e.button !== 2;
      return false;
    },
    onChange: (state) => {
      if (!suppressInteractionFlag) userHasZoomedOrPanned = true;
      if (markupsController) {
        markupsController.setZoomScale(state.scale);
        markupsController.repositionPopup();
      }
      // Measurement's own overlay (points/lines already placed) also needs
      // its stroke width / marker radius recomputed for the new scale - a
      // scroll-zoom mid-measurement is possible even though drag-pan is
      // blocked while a measure tool is active.
      if (measureTool && measurePoints.length > 0) redrawMeasure();
      if (takeoffTool && takeoffPoints.length > 0) redrawTakeoff();
    },
  });

  // The initial fitToView() (in renderPdf) runs as soon as the page render
  // resolves, but the wrap's actual on-screen size can still change after
  // that - late-loading webfonts, the right pane's collapsed state applying
  // from localStorage, etc. Re-fit whenever the wrap's size changes, but
  // only until the user has actually touched zoom/pan themselves, so this
  // never fights a deliberate manual zoom.
  const resizeObserver = new ResizeObserver(() => {
    if (userHasZoomedOrPanned) return;
    const canvas = document.getElementById('pdf-canvas');
    if (canvas.width > 0) fitToView();
  });
  resizeObserver.observe(wrapEl);
}

// Fits the whole rendered page inside the viewport on load / version switch,
// instead of opening at native (very zoomed-in) resolution.
function fitToView() {
  const canvas = document.getElementById('pdf-canvas');
  suppressInteractionFlag = true;
  zoomPan.fitToView(canvas.width, canvas.height);
  suppressInteractionFlag = false;
  if (markupsController) markupsController.repositionPopup();
}

// ---------- Topbar sheet label ----------
function insertSheetLabel(sheet, title) {
  let label = document.querySelector('.sheet-label');
  if (!label) {
    label = document.createElement('div');
    label.className = 'sheet-label';
    label.innerHTML = '<span class="num"></span><span class="title"></span>';
    document.querySelector('#topbar > .row:first-child').appendChild(label);
  }
  label.querySelector('.num').textContent = sheet.sheet_number;
  label.querySelector('.title').textContent = title || '';
}

// Shows the active drawing-search term (carried over from viewer.js's grid
// search, persisted in localStorage) with an explicit way to clear it - the
// highlight otherwise has no other affordance to turn off.
function renderSearchTermChip() {
  const existing = document.getElementById('search-term-chip');
  if (existing) existing.remove();
  if (!activeSearchTerm) return;
  const row = document.querySelector('#topbar > .row:first-child');
  if (!row) return;
  const chip = document.createElement('span');
  chip.id = 'search-term-chip';
  chip.className = 'search-term-chip';
  chip.innerHTML = `Search: "${escapeHtml(activeSearchTerm)}" <button type="button" id="clear-search-chip-btn">&times;</button>`;
  row.appendChild(chip);
  document.getElementById('clear-search-chip-btn').addEventListener('click', () => {
    activeSearchTerm = '';
    localStorage.removeItem(searchStorageKey());
    clearSearchHighlights();
    renderSearchTermChip();
  });
}


function openDownloadPicker() {
  openModal(`
    <h2>Download drawing</h2>
    <label class="permission-option">
      <input type="checkbox" id="dl-published" checked>
      <span><b>Published markups</b><small>Include markups any user has published to this sheet.</small></span>
    </label>
    <label class="permission-option">
      <input type="checkbox" id="dl-personal" checked>
      <span><b>My personal markups</b><small>Include your own private markups on this sheet.</small></span>
    </label>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Cancel</button>
      <button class="primary" type="button" id="modal-ok">Download</button>
    </div>
  `);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-ok').addEventListener('click', () => {
    const includePublished = document.getElementById('dl-published').checked;
    const includePersonal = document.getElementById('dl-personal').checked;
    const qs = new URLSearchParams({ published: includePublished ? '1' : '0', personal: includePersonal ? '1' : '0' });
    window.location.href = `/api/sheet-versions/${displayedVersionId}/download?${qs}`;
    closeModal();
  });
}

function setupDownloadButton() {
  const overlayBtn = document.getElementById('overlay-btn');
  const row = overlayBtn ? overlayBtn.parentElement : document.querySelector('#topbar > .row');
  if (!row || document.getElementById('download-sheet-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'download-sheet-btn';
  btn.className = 'icon-btn';
  btn.type = 'button';
  btn.title = 'Download drawing';
  btn.textContent = '⬇';
  btn.addEventListener('click', openDownloadPicker);
  if (overlayBtn) overlayBtn.after(btn);
  else row.prepend(btn);
}

function openEditSheetModal() {
  openModal(`
    <h2>Edit sheet</h2>
    <div class="field">
      <label>Sheet number</label>
      <input id="edit-sheet-number" autocomplete="off">
    </div>
    <div class="field">
      <label>Discipline</label>
      <input id="edit-sheet-discipline" placeholder="e.g. Architectural" autocomplete="off">
    </div>
    <p class="error" id="edit-sheet-error" style="display:none;"></p>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Cancel</button>
      <button class="primary" type="button" id="modal-save">Save</button>
    </div>
  `);
  // Set via JS rather than interpolated into the template - sheet numbers
  // are OCR/user-entered free text, and setting .value sidesteps any
  // attribute-escaping concern entirely.
  document.getElementById('edit-sheet-number').value = currentSheet.sheet_number;
  document.getElementById('edit-sheet-discipline').value = currentSheet.discipline || '';
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-save').addEventListener('click', async () => {
    const saveBtn = document.getElementById('modal-save');
    saveBtn.disabled = true;
    try {
      const { sheet } = await api('PATCH', `/api/projects/${projectId}/sheets/${sheetId}`, {
        sheet_number: document.getElementById('edit-sheet-number').value,
        discipline: document.getElementById('edit-sheet-discipline').value.trim(),
      });
      currentSheet.sheet_number = sheet.sheet_number;
      currentSheet.discipline = sheet.discipline;
      await updateCachedSheetMetadata(projectId, sheet);
      const titleEl = document.querySelector('.sheet-label .title');
      insertSheetLabel(currentSheet, titleEl ? titleEl.textContent : '');
      closeModal();
      showToast('Sheet updated.', 'success');
    } catch (err) {
      const errEl = document.getElementById('edit-sheet-error');
      errEl.textContent = err.message;
      errEl.style.display = 'block';
      saveBtn.disabled = false;
    }
  });
}

function setupEditSheetButton() {
  if (!canManage) return;
  const downloadBtn = document.getElementById('download-sheet-btn');
  const row = downloadBtn ? downloadBtn.parentElement : document.querySelector('#topbar > .row');
  if (!row || document.getElementById('edit-sheet-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'edit-sheet-btn';
  btn.className = 'icon-btn';
  btn.type = 'button';
  btn.title = 'Edit sheet';
  btn.textContent = '✎';
  btn.addEventListener('click', openEditSheetModal);
  if (downloadBtn) downloadBtn.after(btn);
  else row.prepend(btn);
}

// ---------- PDF rendering ----------
// Reads the PDF from OPFS if this version has been synced - no network in
// the path of viewing a sheet, per CLAUDE.md - falling back to the
// authenticated network endpoint for versions that were never synced.
async function renderPdf(versionId) {
  exitTakeoffEditMode(); // avoid a stale edit session surviving a version switch
  const statusEl = document.getElementById('pdf-status');
  statusEl.textContent = 'Loading...';
  const canvas = document.getElementById('pdf-canvas');
  const ctx = canvas.getContext('2d');
  // Renders can take a while on complex large-format sheets - if the user
  // switches versions again before this one finishes, the old render task
  // must not paint over the new one. renderToken makes any in-flight render
  // check "is this still the version we're supposed to be showing?" before
  // touching the canvas or status text.
  const renderToken = Symbol();
  currentRenderTask = renderToken;
  try {
    const cachedFile = await getCachedAsset(versionId, 'pdf');
    const source = cachedFile
      ? { data: await cachedFile.arrayBuffer() }
      : { url: `/api/sheet-versions/${versionId}/pdf` };
    const loadingTask = pdfjsLib.getDocument(source);
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(1);
    if (currentRenderTask !== renderToken) return; // superseded while loading

    const unitViewport = page.getViewport({ scale: 1 });
    const longestPt = Math.max(unitViewport.width, unitViewport.height);
    currentRenderScale = Math.min(RENDER_SCALE, MAX_RENDER_PX / longestPt);
    const viewport = page.getViewport({ scale: currentRenderScale });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    await page.render({ canvasContext: ctx, viewport }).promise;
    if (currentRenderTask !== renderToken) return; // superseded while rendering

    currentPdfPage = page;
    currentViewport = viewport;
    statusEl.textContent = cachedFile ? '(from local cache)' : '';
    syncSheetLinkLayer();
    loadSheetLinks(versionId);
    drawSearchHighlights(activeSearchTerm);
    if (canTakeoff) loadSheetTakeoffInstances();
    if (markupsController) markupsController.resync();
    userHasZoomedOrPanned = false;
    fitToView();
  } catch (err) {
    if (currentRenderTask !== renderToken) return; // a newer render already took over
    // Clear rather than leave whatever partially painted before the failure -
    // a blank canvas plus a visible error is much less confusing than a
    // handful of stray lines that look like a rendering glitch.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    statusEl.innerHTML = `Failed to render PDF: ${escapeHtml(err.message)} <button type="button" id="pdf-retry-btn">Retry</button>`;
    document.getElementById('pdf-retry-btn').addEventListener('click', () => renderPdf(versionId));
  }
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function syncSheetLinkLayer() {
  const canvas = document.getElementById('pdf-canvas');
  const svg = document.getElementById('markup-svg');
  if (!svg) return;
  svg.setAttribute('viewBox', `0 0 ${canvas.width} ${canvas.height}`);
}

function ensureSheetLinkLayer() {
  const svg = document.getElementById('markup-svg');
  if (!svg) return null;
  let layer = svg.querySelector('#sheet-link-layer');
  if (!layer) {
    layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    layer.id = 'sheet-link-layer';
  }
  // Keep links in the same SVG as markups so they can actually receive
  // pointer events, but always underneath markup/measure geometry.
  if (svg.firstChild !== layer) svg.insertBefore(layer, svg.firstChild);
  return layer;
}

function renderSheetLinks(links, token) {
  if (token !== sheetLinkLoadToken) return;
  const layer = ensureSheetLinkLayer();
  const canvas = document.getElementById('pdf-canvas');
  if (!layer || !canvas.width || !canvas.height) return;
  layer.innerHTML = '';
  syncSheetLinkLayer();

  for (const link of links) {
    const rect = link.rect || {};
    const x = Number(rect.x) * canvas.width;
    const y = Number(rect.y) * canvas.height;
    const w = Number(rect.w) * canvas.width;
    const h = Number(rect.h) * canvas.height;
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;

    const hotspot = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    hotspot.classList.add('sheet-link-hotspot');
    hotspot.setAttribute('x', x);
    hotspot.setAttribute('y', y);
    hotspot.setAttribute('width', w);
    hotspot.setAttribute('height', h);
    hotspot.setAttribute('rx', Math.min(8, Math.max(2, Math.min(w, h) * 0.08)));
    hotspot.setAttribute(
      'aria-label',
      `Open ${link.target_sheet_number || 'linked sheet'}${link.target_title ? ` - ${link.target_title}` : ''}`
    );
    hotspot.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.location.href = `/sheet.html?projectId=${projectId}&sheetId=${link.target_sheet_id}`;
    });
    layer.appendChild(hotspot);
  }
}

async function loadSheetLinks(versionId) {
  const token = ++sheetLinkLoadToken;
  const layer = ensureSheetLinkLayer();
  if (layer) layer.innerHTML = '';
  try {
    // Scope auto-links to the version actually on screen - see the matching
    // comment in sheetLinks.routes.js for why this can't just default to
    // "current" here.
    const qs = versionId ? `?versionId=${encodeURIComponent(versionId)}` : '';
    const { links } = await api('GET', `/api/projects/${projectId}/sheets/${sheetId}/links${qs}`);
    renderSheetLinks(links, token);
  } catch (err) {
    // Links are helpful navigation sugar, not a blocker for opening a drawing.
    // Keep failures out of the critical render path so sheets stay fast.
    console.warn('Failed to load sheet links', err);
  }
}

async function showVersion(versionId) {
  displayedVersionId = versionId;
  exitOverlay(false);
  await renderPdf(versionId);
  updateVersionBadge();
}

// ---------- Version badge + watermark ----------
function updateVersionBadge() {
  const v = allVersions.find((x) => x.id === displayedVersionId);
  document.getElementById('version-badge-btn').innerHTML = `${v ? v.revision_title : 'Current'} &#9662;`;
  insertSheetLabel(currentSheet, v ? v.title : '');

  const dropdown = document.getElementById('version-dropdown');
  dropdown.innerHTML = '';
  for (const ver of allVersions) {
    const a = document.createElement('a');
    a.href = '#';
    const isCurrent = ver.id === currentSheet.current_version_id;
    a.className = ver.id === displayedVersionId ? 'current' : '';
    a.textContent = `${ver.revision_title}${isCurrent ? ' (current)' : ''}`;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      dropdown.style.display = 'none';
      showVersion(ver.id);
    });
    dropdown.appendChild(a);
  }

  document.getElementById('stale-watermark').style.display =
    displayedVersionId !== currentSheet.current_version_id ? 'block' : 'none';
}

document.getElementById('version-badge-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const dropdown = document.getElementById('version-dropdown');
  dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
});
document.addEventListener('click', () => {
  document.getElementById('version-dropdown').style.display = 'none';
});

// ---------- Overlay (replaces the main canvas view in place) ----------
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('failed to load image'));
    img.src = src;
  });
}

// Fetched once per enterOverlay() call, not on every recompute - align-drag
// and rotate need to re-composite many times per second, and re-fetching two
// preview images from the network on every mousemove would make dragging
// feel laggy for no benefit (the images themselves never change mid-session).
async function loadOverlayImages() {
  const [imgA, imgB] = await Promise.all([
    loadImage(`/api/sheet-versions/${overlayLayers.a}/preview`),
    loadImage(`/api/sheet-versions/${overlayLayers.b}/preview`),
  ]);
  overlayImages = { a: imgA, b: imgB };
}

// A -> blue, B -> red, shared -> black, blank -> white. Mirrors
// pyproc/overlay.py's formula exactly (R=gA, G=min(gA,gB), B=gB).
// `fit` re-fits the zoom/pan to the composite - only wanted right after
// entering overlay or toggling A/B visibility, NOT during align-drag or
// rotate, which must preserve whatever zoom/pan the user has dialed in while
// lining things up.
function computeOverlay({ fit = false } = {}) {
  const { showA, showB } = overlayLayers;
  const canvas = document.getElementById('pdf-canvas');
  const imgA = overlayImages.a;
  const imgB = overlayImages.b;
  if (!imgA || !imgB) return;

  const width = Math.max(imgA.naturalWidth, imgB.naturalWidth);
  const height = Math.max(imgA.naturalHeight, imgB.naturalHeight);
  canvas.width = width;
  canvas.height = height;

  // Draws the image centered on the composite canvas, offset by the layer's
  // drag (tx,ty) and rotated about its own center - identical to the old
  // draw-at-(0,0) behavior when both previews are the same size (the common
  // case), since centering then coincides with top-left anchoring.
  function toGray(img, transform) {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const cx = c.getContext('2d');
    cx.fillStyle = 'white';
    cx.fillRect(0, 0, width, height);
    cx.save();
    cx.translate(width / 2 + transform.tx, height / 2 + transform.ty);
    cx.rotate((transform.rotation * Math.PI) / 180);
    cx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    cx.restore();
    return cx.getImageData(0, 0, width, height).data;
  }

  const aPixels = showA ? toGray(imgA, overlayTransform.a) : null;
  const bPixels = showB ? toGray(imgB, overlayTransform.b) : null;

  const ctx = canvas.getContext('2d');
  const out = ctx.createImageData(width, height);
  const outPixels = out.data;
  for (let i = 0; i < outPixels.length; i += 4) {
    const gA = aPixels ? 0.299 * aPixels[i] + 0.587 * aPixels[i + 1] + 0.114 * aPixels[i + 2] : 255;
    const gB = bPixels ? 0.299 * bPixels[i] + 0.587 * bPixels[i + 1] + 0.114 * bPixels[i + 2] : 255;
    if (showA && showB) {
      outPixels[i] = gA;
      outPixels[i + 1] = Math.min(gA, gB);
      outPixels[i + 2] = gB;
    } else if (showA) {
      outPixels[i] = outPixels[i + 1] = outPixels[i + 2] = gA;
    } else if (showB) {
      outPixels[i] = outPixels[i + 1] = outPixels[i + 2] = gB;
    } else {
      outPixels[i] = outPixels[i + 1] = outPixels[i + 2] = 255;
    }
    outPixels[i + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  document.getElementById('pdf-status').textContent = '';
  if (fit) fitToView();
}

// Drag-align and rotate can fire many times a second (mousemove, or a user
// rapid-clicking rotation angles) - a full-resolution pixel composite on
// every single event would visibly lag, so recomputes are coalesced to at
// most one per animation frame.
function scheduleOverlayRecompute() {
  if (overlayRecomputeQueued) return;
  overlayRecomputeQueued = true;
  requestAnimationFrame(() => {
    overlayRecomputeQueued = false;
    computeOverlay();
  });
}

function setupOverlayAlignDrag() {
  const wrapEl = document.getElementById('zoom-wrap');
  wrapEl.addEventListener('mousedown', (e) => {
    if (!overlayActive || !overlayAlignActive) return;
    e.preventDefault();
    const t = overlayTransform[overlayAlignTarget];
    overlayDrag = { startX: e.clientX, startY: e.clientY, origTx: t.tx, origTy: t.ty };
  });
  window.addEventListener('mousemove', (e) => {
    if (!overlayDrag) return;
    e.preventDefault();
    const scale = zoomPan ? zoomPan.state.scale : 1;
    const t = overlayTransform[overlayAlignTarget];
    t.tx = overlayDrag.origTx + (e.clientX - overlayDrag.startX) / scale;
    t.ty = overlayDrag.origTy + (e.clientY - overlayDrag.startY) / scale;
    scheduleOverlayRecompute();
  });
  window.addEventListener('mouseup', () => {
    overlayDrag = null;
  });
}

function syncOverlayRotateGroup() {
  const rotation = overlayTransform[overlayAlignTarget].rotation;
  document.querySelectorAll('#overlay-rotate-group button').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.rotation) === rotation);
  });
}

function wireOverlayControls() {
  const aChip = document.getElementById('overlay-toggle-a-chip');
  const bChip = document.getElementById('overlay-toggle-b-chip');
  document.getElementById('overlay-toggle-a').addEventListener('change', (e) => {
    overlayLayers.showA = e.target.checked;
    aChip.classList.toggle('checked', e.target.checked);
    computeOverlay({ fit: true });
  });
  document.getElementById('overlay-toggle-b').addEventListener('change', (e) => {
    overlayLayers.showB = e.target.checked;
    bChip.classList.toggle('checked', e.target.checked);
    computeOverlay({ fit: true });
  });

  const targetGroup = document.getElementById('overlay-target-group');
  targetGroup.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      overlayAlignTarget = btn.dataset.target;
      targetGroup.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
      syncOverlayRotateGroup();
    });
  });

  const rotateGroup = document.getElementById('overlay-rotate-group');
  rotateGroup.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      overlayTransform[overlayAlignTarget].rotation = Number(btn.dataset.rotation);
      rotateGroup.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
      computeOverlay();
    });
  });

  const alignBtn = document.getElementById('overlay-align-btn');
  alignBtn.addEventListener('click', () => {
    overlayAlignActive = !overlayAlignActive;
    alignBtn.classList.toggle('active', overlayAlignActive);
    document.getElementById('zoom-wrap').classList.toggle('align-active', overlayAlignActive);
  });

  document.getElementById('overlay-reset-btn').addEventListener('click', () => {
    overlayTransform[overlayAlignTarget] = { tx: 0, ty: 0, rotation: 0 };
    syncOverlayRotateGroup();
    computeOverlay();
  });

  document.getElementById('overlay-exit-btn').addEventListener('click', () => exitOverlay(true));
}

async function enterOverlay(aVersionId, bVersionId) {
  overlayActive = true;
  overlayLayers = { a: aVersionId, b: bVersionId, showA: true, showB: true };
  overlayTransform = { a: { tx: 0, ty: 0, rotation: 0 }, b: { tx: 0, ty: 0, rotation: 0 } };
  overlayAlignTarget = 'b';
  overlayAlignActive = false;
  document.getElementById('markup-svg').style.display = 'none';
  clearMeasure();

  let bar = document.getElementById('overlay-controls-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'overlay-controls-bar';
    bar.className = 'card';
    bar.style.margin = '10px 12px 0';
    document.querySelector('.sheet-canvas-area').insertBefore(bar, document.getElementById('zoom-wrap'));
  }
  bar.innerHTML = `
    <div class="overlay-controls">
      <div class="overlay-controls-group">
        <label class="chip-toggle checked" id="overlay-toggle-a-chip"><input type="checkbox" id="overlay-toggle-a" checked><span class="dot"></span>A (blue)</label>
        <label class="chip-toggle checked" id="overlay-toggle-b-chip"><input type="checkbox" id="overlay-toggle-b" checked><span class="dot"></span>B (red)</label>
      </div>
      <div class="overlay-controls-group">
        <span class="overlay-controls-label">Adjusting</span>
        <div class="segmented" id="overlay-target-group">
          <button type="button" data-target="a">A</button>
          <button type="button" data-target="b" class="active">B</button>
        </div>
      </div>
      <div class="overlay-controls-group">
        <button type="button" id="overlay-align-btn" title="Drag the drawing to align it">Align</button>
        <div class="segmented" id="overlay-rotate-group">
          <button type="button" data-rotation="0" class="active">0&deg;</button>
          <button type="button" data-rotation="90">90&deg;</button>
          <button type="button" data-rotation="180">180&deg;</button>
          <button type="button" data-rotation="270">270&deg;</button>
        </div>
        <button type="button" id="overlay-reset-btn">Reset</button>
      </div>
      <button type="button" id="overlay-exit-btn">Exit overlay</button>
    </div>
  `;
  wireOverlayControls();

  const statusEl = document.getElementById('pdf-status');
  statusEl.textContent = 'Loading overlay...';
  await loadOverlayImages();
  computeOverlay({ fit: true });
}

function exitOverlay(rerender) {
  if (!overlayActive) return;
  overlayActive = false;
  overlayAlignActive = false;
  overlayDrag = null;
  document.getElementById('zoom-wrap').classList.remove('align-active');
  document.getElementById('markup-svg').style.display = '';
  const bar = document.getElementById('overlay-controls-bar');
  if (bar) bar.remove();
  if (rerender) renderPdf(displayedVersionId);
}

async function openOverlayPicker() {
  const { sheets } = await api('GET', `/api/projects/${projectId}/sheets`);

  openModal(`
    <h2>Overlay drawing</h2>
    <input type="text" id="overlay-search" placeholder="Search sheet number or title...">
    <div class="overlay-picker-list" id="overlay-picker-list" style="margin-top:10px;"></div>
    <div class="modal-actions"><button type="button" id="modal-cancel">Cancel</button></div>
  `);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);

  function renderList(filter) {
    const listEl = document.getElementById('overlay-picker-list');
    listEl.innerHTML = '';
    const grouped = {};
    for (const s of sheets) {
      const hay = `${s.sheet_number} ${s.current_title || ''}`.toLowerCase();
      if (filter && !hay.includes(filter.toLowerCase())) continue;
      const disc = s.discipline || 'Unspecified';
      (grouped[disc] = grouped[disc] || []).push(s);
    }
    for (const disc of Object.keys(grouped).sort()) {
      const label = document.createElement('div');
      label.className = 'overlay-picker-group-label';
      label.textContent = disc;
      listEl.appendChild(label);
      for (const s of grouped[disc]) {
        const item = document.createElement('div');
        item.className = 'overlay-picker-item';
        item.textContent = `${s.sheet_number} - ${s.current_title || ''}`;
        item.addEventListener('click', () => pickOverlayTarget(s));
        listEl.appendChild(item);
      }
    }
  }
  renderList('');
  document.getElementById('overlay-search').addEventListener('input', (e) => renderList(e.target.value));
}

async function pickOverlayTarget(otherSheet) {
  if (otherSheet.id === Number(sheetId)) {
    openModal(`
      <h2>Overlay against which version?</h2>
      <div class="overlay-picker-list">
        ${allVersions
          .filter((v) => v.id !== displayedVersionId)
          .map(
            (v) =>
              `<div class="overlay-picker-item" data-version-id="${v.id}" data-published="${v.published_at}">${v.revision_title}</div>`
          )
          .join('')}
      </div>
      <div class="modal-actions"><button type="button" id="modal-cancel">Cancel</button></div>
    `);
    document.getElementById('modal-cancel').addEventListener('click', closeModal);
    document.querySelectorAll('.overlay-picker-item[data-version-id]').forEach((elm) => {
      elm.addEventListener('click', () => {
        const otherVersionId = Number(elm.dataset.versionId);
        const otherPublished = elm.dataset.published;
        const current = allVersions.find((v) => v.id === displayedVersionId);
        closeModal();
        const [aV, bV] =
          current.published_at <= otherPublished ? [displayedVersionId, otherVersionId] : [otherVersionId, displayedVersionId];
        enterOverlay(aV, bV);
      });
    });
  } else {
    closeModal();
    const current = allVersions.find((v) => v.id === displayedVersionId);
    const [aV, bV] =
      current.published_at <= otherSheet.current_published_at
        ? [displayedVersionId, otherSheet.current_version_id]
        : [otherSheet.current_version_id, displayedVersionId];
    enterOverlay(aV, bV);
  }
}

// ---------- Measure ----------
const STANDARD_SCALES = [
  { label: '1/16" = 1\'-0"', feetPerInch: 16 },
  { label: '1/8" = 1\'-0"', feetPerInch: 8 },
  { label: '3/16" = 1\'-0"', feetPerInch: 16 / 3 },
  { label: '1/4" = 1\'-0"', feetPerInch: 4 },
  { label: '3/8" = 1\'-0"', feetPerInch: 8 / 3 },
  { label: '1/2" = 1\'-0"', feetPerInch: 2 },
  { label: '3/4" = 1\'-0"', feetPerInch: 4 / 3 },
  { label: '1" = 1\'-0"', feetPerInch: 1 },
  { label: '1 1/2" = 1\'-0"', feetPerInch: 2 / 3 },
  { label: '3" = 1\'-0"', feetPerInch: 1 / 3 },
  { label: '1" = 10\'-0"', feetPerInch: 10 },
  { label: '1" = 20\'-0"', feetPerInch: 20 },
  { label: '1" = 30\'-0"', feetPerInch: 30 },
  { label: '1" = 40\'-0"', feetPerInch: 40 },
  { label: '1" = 50\'-0"', feetPerInch: 50 },
  { label: '1" = 60\'-0"', feetPerInch: 60 },
  { label: '1" = 100\'-0"', feetPerInch: 100 },
];

const TAKEOFF_COUNT_ICON =
  '<svg viewBox="0 0 20 20"><circle cx="5" cy="10" r="2.5" fill="currentColor"/><circle cx="13" cy="10" r="2.5" fill="currentColor"/><circle cx="17" cy="5" r="2" fill="currentColor" fill-opacity="0.5"/></svg>';

// Marker glyphs drawn at each count-item click, and shown as the shape
// picker in the naming modal - same viewBox/currentColor convention as
// MEASURE_ICONS so they can share button styling.
const TAKEOFF_SHAPE_ICONS = {
  square: '<svg viewBox="0 0 20 20"><rect x="3" y="3" width="14" height="14" fill="currentColor"/></svg>',
  circle: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7" fill="currentColor"/></svg>',
  triangle: '<svg viewBox="0 0 20 20"><polygon points="10,2 18,17 2,17" fill="currentColor"/></svg>',
  diamond: '<svg viewBox="0 0 20 20"><polygon points="10,2 18,10 10,18 2,10" fill="currentColor"/></svg>',
};

const MEASURE_ICONS = {
  line: '<svg viewBox="0 0 20 20"><line x1="2" y1="18" x2="18" y2="2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="5" y1="15" x2="7" y2="17" stroke="currentColor" stroke-width="1.5"/><line x1="9" y1="11" x2="11" y2="13" stroke="currentColor" stroke-width="1.5"/><line x1="13" y1="7" x2="15" y2="9" stroke="currentColor" stroke-width="1.5"/></svg>',
  perimeter:
    '<svg viewBox="0 0 20 20"><polyline points="2,16 7,6 12,14 18,4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  area: '<svg viewBox="0 0 20 20"><polygon points="3,16 3,7 10,3 17,8 15,16" stroke="currentColor" stroke-width="2" fill="currentColor" fill-opacity="0.2"/></svg>',
};

let measureTool = null;
let measurePoints = [];
let scaleFeetPerInch = null;

// ---------- Take-offs (permission-gated extension of measure) ----------
let takeoffTool = null; // null | 'linear' | 'perimeter' | 'area'
let takeoffPoints = [];
let takeoffItems = []; // project-wide: {id, name, type, color, total_quantity, instance_count}
let sheetTakeoffInstances = []; // this sheet's instances, flat with item_name/item_color/item_type joined in
let activeTakeoffItemId = null;
let lastPlacedInstanceId = null; // most recent instance posted for the active item on this sheet - used by Backspace on count items

// Click-to-edit state - active only while no placement tool is armed
// (takeoffTool null). editingInstance is a local working copy of whichever
// committed instance is selected; edits apply to it live and PATCH to the
// server on drop/delete, only diverging from the server copy mid-drag.
let editingInstance = null;
let editSelectedPointIndices = new Set();
let takeoffEditDrag = null; // { startPt, moved }
let takeoffMarquee = null; // { startPt, currentPt }
let takeoffLastClickPoint = null; // { index, time } - manual double-click detection for point delete

function takeoffStorageKey() {
  return `hammgrid-active-takeoff:${projectId}`;
}

function measureSvgNs(tag) {
  return document.createElementNS('http://www.w3.org/2000/svg', tag);
}

function ensureMeasureLayer() {
  const svg = document.getElementById('markup-svg');
  let g = svg.querySelector('#measure-layer');
  if (!g) {
    g = measureSvgNs('g');
    g.id = 'measure-layer';
    svg.appendChild(g);
  }
  return g;
}

function clearMeasure() {
  measurePoints = [];
  ensureMeasureLayer().innerHTML = '';
  document.getElementById('measure-result').style.display = 'none';
}

// ---------- Drawing-content search highlight (from viewer.js's grid search) ----------
function ensureSearchHighlightLayer() {
  const svg = document.getElementById('markup-svg');
  let g = svg.querySelector('#search-highlight-layer');
  if (!g) {
    g = measureSvgNs('g');
    g.id = 'search-highlight-layer';
    svg.appendChild(g);
  }
  return g;
}

function clearSearchHighlights() {
  ensureSearchHighlightLayer().innerHTML = '';
}

function drawSearchHighlights(term) {
  const layer = ensureSearchHighlightLayer();
  layer.innerHTML = '';
  if (!term || !currentPdfPage || !currentViewport) return;

  const needle = term.toLowerCase();
  currentPdfPage
    .getTextContent()
    .then((textContent) => {
      if (term !== activeSearchTerm) return; // a newer search term/render already took over
      for (const item of textContent.items) {
        if (!item.str || !item.str.toLowerCase().includes(needle)) continue;
        // item.transform is in unscaled PDF-point space (same space as
        // page.getViewport({scale:1})) - combine it with the render
        // viewport's own transform (which already encodes the render scale
        // AND the PDF-bottom-up -> canvas-top-down y-flip) to land directly
        // in canvas-pixel space. This is the standard pdf.js idiom for
        // positioning text-layer items; everything else in this file already
        // works in canvas-pixel space so there's no existing helper for it.
        const tx = pdfjsLib.Util.transform(currentViewport.transform, item.transform);
        const w = item.width * currentRenderScale;
        const h = item.height * currentRenderScale;
        const x = tx[4];
        const y = tx[5] - h; // tx[4],tx[5] is the text baseline's left point - shift up by height for the top-left corner

        const rect = measureSvgNs('rect');
        rect.setAttribute('x', x);
        rect.setAttribute('y', y);
        rect.setAttribute('width', w);
        rect.setAttribute('height', h);
        rect.classList.add('search-highlight-rect');
        layer.appendChild(rect);
      }
    })
    .catch((err) => console.warn('Search highlight extraction failed', err));
}

function getMeasureSvgPoint(evt) {
  const svg = document.getElementById('markup-svg');
  const rect = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  return {
    x: ((evt.clientX - rect.left) / rect.width) * vb.width,
    y: ((evt.clientY - rect.top) / rect.height) * vb.height,
  };
}

function pixelsToFeet(pixelDist) {
  const inches = pixelDist / currentRenderScale / 72;
  return inches * scaleFeetPerInch;
}

function formatFeetInches(feetDecimal) {
  const totalInches = Math.round(feetDecimal * 12);
  const feet = Math.floor(totalInches / 12);
  const inches = totalInches % 12;
  return `${feet}'-${inches}"`;
}

function polylineLengthFeet(pts) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return pixelsToFeet(total);
}

function polygonAreaFeet(pts) {
  let area2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % pts.length];
    area2 += p1.x * p2.y - p2.x * p1.y;
  }
  const pixelArea = Math.abs(area2) / 2;
  const feetPerPixel = (1 / currentRenderScale / 72) * scaleFeetPerInch;
  return pixelArea * feetPerPixel * feetPerPixel;
}

function redrawMeasure(livePt) {
  const g = ensureMeasureLayer();
  g.innerHTML = '';
  const pts = livePt ? [...measurePoints, livePt] : measurePoints;
  if (pts.length === 0) {
    updateLiveResult(pts);
    return;
  }

  // Zoom is a CSS transform on an ancestor div, outside the SVG's own
  // coordinate system, so vector-effect="non-scaling-stroke" can't see it -
  // divide by the current scale instead, same technique as markups.js, so
  // these stay a constant size on screen regardless of zoom.
  const scale = zoomPan ? zoomPan.state.scale : 1;

  const poly = measureSvgNs('polyline');
  poly.setAttribute('points', pts.map((p) => `${p.x},${p.y}`).join(' '));
  poly.setAttribute('stroke', '#f59e0b');
  poly.setAttribute('stroke-width', 2 / scale);
  poly.setAttribute('fill', 'none');
  poly.setAttribute('stroke-dasharray', `${5 / scale} ${3 / scale}`);
  g.appendChild(poly);

  for (const p of pts) {
    const c = measureSvgNs('circle');
    c.setAttribute('cx', p.x);
    c.setAttribute('cy', p.y);
    c.setAttribute('r', 4 / scale);
    c.setAttribute('fill', '#f59e0b');
    g.appendChild(c);
  }
  updateLiveResult(pts);
}

// Single source of truth for the result box - called on every point placed
// AND on every mousemove while measuring, so the number visibly updates as
// the user moves the mouse, not just once at the very end.
function updateLiveResult(pts) {
  const resultEl = document.getElementById('measure-result');
  if (measureTool === 'line' || measureTool === 'perimeter') {
    if (pts.length < 2) {
      resultEl.style.display = 'none';
      return;
    }
    const feet = measureTool === 'line' ? polylineLengthFeet(pts.slice(0, 2)) : polylineLengthFeet(pts);
    resultEl.textContent = `Length: ${feet.toFixed(1)} ft (${formatFeetInches(feet)})`;
    resultEl.style.display = 'block';
  } else if (measureTool === 'area') {
    if (pts.length < 3) {
      resultEl.style.display = 'none';
      return;
    }
    const areaFt = polygonAreaFeet(pts);
    const perimFt = polylineLengthFeet([...pts, pts[0]]);
    resultEl.textContent = `Area: ${areaFt.toLocaleString(undefined, { maximumFractionDigits: 0 })} SF, Perimeter: ${perimFt.toFixed(1)} ft`;
    resultEl.style.display = 'block';
  } else {
    resultEl.style.display = 'none';
  }
}

function stopMeasureTool() {
  measureTool = null;
  document.querySelectorAll('#measure-tool-grid .tool-btn').forEach((b) => b.classList.remove('active'));
}

function finishMeasurement() {
  if (measureTool === 'perimeter' && measurePoints.length >= 2) {
    updateLiveResult(measurePoints);
  } else if (measureTool === 'area' && measurePoints.length >= 3) {
    updateLiveResult(measurePoints);
    const g = ensureMeasureLayer();
    g.innerHTML = '';
    const poly = measureSvgNs('polygon');
    poly.setAttribute('points', measurePoints.map((p) => `${p.x},${p.y}`).join(' '));
    poly.setAttribute('stroke', '#f59e0b');
    poly.setAttribute('stroke-width', 2 / (zoomPan ? zoomPan.state.scale : 1));
    poly.setAttribute('fill', '#f59e0b');
    poly.setAttribute('fill-opacity', '0.15');
    g.appendChild(poly);
  }
  stopMeasureTool();
}

function setupMeasureInteraction() {
  const svg = document.getElementById('markup-svg');
  // Capture phase + unconditional on target: an existing markup (even an
  // invisible fill-opacity:0.001 hit-area) sits on top of the drawing and
  // calls stopPropagation() on its own click handler, which was silently
  // swallowing every measurement click that happened to land on or near one
  // - including the just-placed point marker itself. Capturing here means
  // this runs before any per-markup listener ever gets the event.
  svg.addEventListener(
    'click',
    (e) => {
      if (!measureTool) return;
      e.stopPropagation();
      const pt = getMeasureSvgPoint(e);

      if (measureTool === 'line') {
        measurePoints.push(pt);
        redrawMeasure();
        if (measurePoints.length === 2) stopMeasureTool();
        return;
      }

      if (measurePoints.length > 2) {
        const last = measurePoints[measurePoints.length - 1];
        if (Math.hypot(pt.x - last.x, pt.y - last.y) < 6) {
          finishMeasurement();
          return;
        }
      }
      measurePoints.push(pt);
      redrawMeasure();
    },
    true
  );

  svg.addEventListener('mousemove', (e) => {
    if (!measureTool || measurePoints.length === 0) return;
    redrawMeasure(getMeasureSvgPoint(e));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && measureTool && measureTool !== 'line') finishMeasurement();
    if (e.key === 'Escape' && measureTool) {
      clearMeasure();
      stopMeasureTool();
    }
  });
}

function setupMeasureTools() {
  const grid = document.getElementById('measure-tool-grid');
  const defs = [
    { tool: 'line', title: 'Line measurement' },
    { tool: 'perimeter', title: 'Perimeter (polyline)' },
    { tool: 'area', title: 'Area (polygon)' },
  ];
  for (const def of defs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tool-btn tool-icon-btn';
    btn.dataset.tool = def.tool;
    btn.title = def.title;
    btn.innerHTML = MEASURE_ICONS[def.tool];
    btn.addEventListener('click', () => {
      if (overlayActive) return;
      if (!scaleFeetPerInch) {
        showToast('Set a scale first.', 'error');
        return;
      }
      const turningOn = measureTool !== def.tool;
      clearMeasure();
      deactivateTakeoff();
      if (markupsController) markupsController.forceSelectTool();
      measureTool = turningOn ? def.tool : null;
      grid.querySelectorAll('.tool-btn').forEach((b) => b.classList.toggle('active', b.dataset.tool === measureTool));
    });
    grid.appendChild(btn);
  }

  document.getElementById('measure-clear-btn').addEventListener('click', () => {
    clearMeasure();
    stopMeasureTool();
  });

  setupMeasureInteraction();
}

// ---------- Take-off tools ----------
// Layered on the measure tool's math/interaction pattern, but each placed
// measurement belongs to a named/colored project-level item that accumulates
// a running total, and the tool stays armed across placements (and across
// sheet navigation, via localStorage) instead of ending after one shot.

function ensureTakeoffDraftLayer() {
  const svg = document.getElementById('markup-svg');
  let g = svg.querySelector('#takeoff-draft-layer');
  if (!g) {
    g = measureSvgNs('g');
    g.id = 'takeoff-draft-layer';
    svg.appendChild(g);
  }
  return g;
}

function ensureTakeoffInstancesLayer() {
  const svg = document.getElementById('markup-svg');
  let g = svg.querySelector('#takeoff-instances-layer');
  if (!g) {
    g = measureSvgNs('g');
    g.id = 'takeoff-instances-layer';
    svg.appendChild(g);
  }
  return g;
}

function clearTakeoffDraft() {
  takeoffPoints = [];
  ensureTakeoffDraftLayer().innerHTML = '';
}

function getActiveTakeoffItem() {
  return takeoffItems.find((i) => i.id === activeTakeoffItemId) || null;
}

// Locks `to` onto the nearest 45deg increment (horizontal/vertical/diagonal)
// measured from `from`, at the same distance `to` was actually placed at.
function snapToAngle(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return { ...to };
  const step = Math.PI / 4;
  const snappedAngle = Math.round(Math.atan2(dy, dx) / step) * step;
  return {
    x: from.x + Math.cos(snappedAngle) * dist,
    y: from.y + Math.sin(snappedAngle) * dist,
  };
}

function redrawTakeoff(livePt) {
  const g = ensureTakeoffDraftLayer();
  g.innerHTML = '';
  const pts = livePt ? [...takeoffPoints, livePt] : takeoffPoints;
  if (pts.length === 0) return;

  const scale = zoomPan ? zoomPan.state.scale : 1;
  const activeItem = getActiveTakeoffItem();
  const color = activeItem ? activeItem.color : '#f59e0b'; // no item yet (first placement) - neutral until named

  const poly = measureSvgNs('polyline');
  poly.setAttribute('points', pts.map((p) => `${p.x},${p.y}`).join(' '));
  poly.setAttribute('stroke', color);
  poly.setAttribute('stroke-width', 2 / scale);
  poly.setAttribute('fill', 'none');
  poly.setAttribute('stroke-dasharray', `${5 / scale} ${3 / scale}`);
  g.appendChild(poly);

  for (const p of pts) {
    const c = measureSvgNs('circle');
    c.setAttribute('cx', p.x);
    c.setAttribute('cy', p.y);
    c.setAttribute('r', 4 / scale);
    c.setAttribute('fill', color);
    g.appendChild(c);
  }
}

// Renders this sheet's already-saved instances, colored per their own item -
// purely visual (pointer-events:none via CSS), no click-to-select/delete on
// the canvas itself. Deleting a segment happens only through the pane list,
// the same way clicking placed measure geometry was never made interactive
// either (avoids reintroducing the click-swallowing problem the measure
// tool's capture-phase listener already has to work around for markups).
// Marker size is constant on-screen (divided by zoom scale), matching the
// point-handle convention already used by redrawTakeoff/redrawMeasure.
function drawTakeoffShapeMarker(point, shape, color, scale) {
  const size = 8 / scale;
  let el;
  if (shape === 'circle') {
    el = measureSvgNs('circle');
    el.setAttribute('cx', point.x);
    el.setAttribute('cy', point.y);
    el.setAttribute('r', size);
  } else if (shape === 'triangle') {
    el = measureSvgNs('polygon');
    el.setAttribute(
      'points',
      `${point.x},${point.y - size} ${point.x + size},${point.y + size} ${point.x - size},${point.y + size}`
    );
  } else if (shape === 'diamond') {
    el = measureSvgNs('polygon');
    el.setAttribute(
      'points',
      `${point.x},${point.y - size} ${point.x + size},${point.y} ${point.x},${point.y + size} ${point.x - size},${point.y}`
    );
  } else {
    el = measureSvgNs('rect');
    el.setAttribute('x', point.x - size);
    el.setAttribute('y', point.y - size);
    el.setAttribute('width', size * 2);
    el.setAttribute('height', size * 2);
  }
  el.setAttribute('fill', color);
  return el;
}

// Committed geometry is only clickable (to enter edit mode) while no
// placement tool is armed - #takeoff-instances-layer's pointer-events are
// toggled via the .edit-enabled class so an armed tool's placement clicks
// still pass straight through to the canvas underneath, unchanged.
function renderTakeoffInstances() {
  const layer = ensureTakeoffInstancesLayer();
  layer.innerHTML = '';
  layer.classList.toggle('edit-enabled', !takeoffTool);
  const scale = zoomPan ? zoomPan.state.scale : 1;
  for (const inst of sheetTakeoffInstances) {
    if (editingInstance && inst.id === editingInstance.id) continue; // drawn by the edit overlay instead
    const pts = inst.geometry && inst.geometry.points;
    if (!pts || pts.length === 0) continue;

    let el;
    if (inst.item_type === 'count') {
      el = drawTakeoffShapeMarker(pts[0], inst.item_shape, inst.item_color, scale);
    } else if (inst.item_type === 'area') {
      el = measureSvgNs('polygon');
      el.setAttribute('points', pts.map((p) => `${p.x},${p.y}`).join(' '));
      el.setAttribute('stroke', inst.item_color);
      el.setAttribute('stroke-width', 2 / scale);
      el.setAttribute('fill', inst.item_color);
      el.setAttribute('fill-opacity', '0.15');
    } else {
      el = measureSvgNs('polyline');
      el.setAttribute('points', pts.map((p) => `${p.x},${p.y}`).join(' '));
      el.setAttribute('stroke', inst.item_color);
      el.setAttribute('stroke-width', 3 / scale);
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke-linecap', 'round');
      el.setAttribute('stroke-linejoin', 'round');
    }
    el.style.cursor = 'pointer';
    el.addEventListener('click', (e) => {
      // .edit-enabled only tracks takeoffTool (updated at arm/disarm time,
      // see renderTakeoffPane), not markup tool state, which can change
      // independently mid-session - check fresh here so an active markup
      // draw tool still wins over entering take-off edit mode.
      if (markupsController && markupsController.isToolActive()) return;
      e.stopPropagation();
      enterTakeoffEditMode(inst);
    });
    layer.appendChild(el);
  }
}

// ---------- Click-to-edit committed take-off geometry ----------
// Only reachable when idle (no placement tool armed - see renderTakeoffInstances's
// .edit-enabled toggle). Points/segments are the same underlying array of
// {x,y} points geometry has always used - "deleting a segment" just deletes
// its two endpoint points, and removing any point (start/middle/end) via a
// plain array filter is already the correct reconnect behavior, since the
// shape is drawn as a connected line through whatever points remain.

function ensureTakeoffEditLayer() {
  const svg = document.getElementById('markup-svg');
  let g = svg.querySelector('#takeoff-edit-layer');
  if (!g) {
    g = measureSvgNs('g');
    g.id = 'takeoff-edit-layer';
    svg.appendChild(g);
  }
  return g;
}

function enterTakeoffEditMode(instance) {
  if (editingInstance && editingInstance.id === instance.id) return;
  // Deep-ish copy of geometry so live drag edits don't mutate the shared
  // sheetTakeoffInstances array until they're actually persisted.
  editingInstance = { ...instance, geometry: { points: instance.geometry.points.map((p) => ({ ...p })) } };
  editSelectedPointIndices = new Set();
  renderTakeoffInstances(); // hide this instance from the plain committed layer
  renderTakeoffEditOverlay();
}

function exitTakeoffEditMode() {
  if (!editingInstance) return;
  editingInstance = null;
  editSelectedPointIndices = new Set();
  ensureTakeoffEditLayer().innerHTML = '';
  renderTakeoffInstances(); // show it again in the plain committed layer
}

function minTakeoffPoints(type) {
  if (type === 'area') return 3;
  if (type === 'count') return 1;
  return 2;
}

async function applyTakeoffEditGeometry(newPoints) {
  if (!editingInstance) return;
  if (newPoints.length < minTakeoffPoints(editingInstance.item_type)) {
    const id = editingInstance.id;
    exitTakeoffEditMode();
    await deleteTakeoffInstance(id);
    return;
  }
  const quantity =
    editingInstance.item_type === 'area'
      ? polygonAreaFeet(newPoints)
      : editingInstance.item_type === 'count'
      ? 1
      : polylineLengthFeet(newPoints);
  editingInstance.geometry = { points: newPoints };
  editingInstance.quantity = quantity;
  editSelectedPointIndices = new Set();
  try {
    await api('PATCH', `/api/take-off-instances/${editingInstance.id}`, { geometry: { points: newPoints }, quantity });
    await Promise.all([loadSheetTakeoffInstances(), loadTakeoffItems()]);
    renderTakeoffEditOverlay();
    renderTakeoffPane();
  } catch (err) {
    showToast(`Failed to save edit: ${err.message}`, 'error');
  }
}

function deleteTakeoffEditPoints(indices) {
  if (!editingInstance) return;
  const toRemove = new Set(indices);
  applyTakeoffEditGeometry(editingInstance.geometry.points.filter((_, i) => !toRemove.has(i)));
}

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function hitTestTakeoffEditPoint(pt) {
  if (!editingInstance) return null;
  const scale = zoomPan ? zoomPan.state.scale : 1;
  const r = 10 / scale;
  const pts = editingInstance.geometry.points;
  for (let i = 0; i < pts.length; i++) {
    if (Math.hypot(pts[i].x - pt.x, pts[i].y - pt.y) <= r) return i;
  }
  return null;
}

function hitTestTakeoffEditSegment(pt) {
  if (!editingInstance || editingInstance.item_type === 'count') return null;
  const pts = editingInstance.geometry.points;
  const closed = editingInstance.item_type === 'area';
  const scale = zoomPan ? zoomPan.state.scale : 1;
  const tol = 6 / scale;
  const segCount = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segCount; i++) {
    const j = (i + 1) % pts.length;
    if (distanceToSegment(pt, pts[i], pts[j]) <= tol) return [i, j];
  }
  return null;
}

function renderTakeoffEditOverlay() {
  const layer = ensureTakeoffEditLayer();
  layer.innerHTML = '';
  if (!editingInstance) return;
  const scale = zoomPan ? zoomPan.state.scale : 1;
  const pts = editingInstance.geometry.points;
  const color = editingInstance.item_color;

  if (editingInstance.item_type === 'count') {
    layer.appendChild(drawTakeoffShapeMarker(pts[0], editingInstance.item_shape, color, scale));
  } else if (pts.length > 1) {
    const shapeEl = measureSvgNs(editingInstance.item_type === 'area' ? 'polygon' : 'polyline');
    shapeEl.setAttribute('points', pts.map((p) => `${p.x},${p.y}`).join(' '));
    shapeEl.setAttribute('stroke', color);
    shapeEl.setAttribute('stroke-width', 3 / scale);
    shapeEl.setAttribute('fill', editingInstance.item_type === 'area' ? color : 'none');
    shapeEl.setAttribute('fill-opacity', '0.15');
    layer.appendChild(shapeEl);
  }

  pts.forEach((p, i) => {
    const selected = editSelectedPointIndices.has(i);
    const c = measureSvgNs('circle');
    c.setAttribute('cx', p.x);
    c.setAttribute('cy', p.y);
    c.setAttribute('r', 7 / scale);
    c.setAttribute('fill', selected ? '#2563eb' : '#fff');
    c.setAttribute('stroke', '#2563eb');
    c.setAttribute('stroke-width', 2 / scale);
    layer.appendChild(c);
  });

  if (takeoffMarquee && takeoffMarquee.currentPt) {
    const { startPt, currentPt } = takeoffMarquee;
    const rect = measureSvgNs('rect');
    rect.setAttribute('x', Math.min(startPt.x, currentPt.x));
    rect.setAttribute('y', Math.min(startPt.y, currentPt.y));
    rect.setAttribute('width', Math.abs(currentPt.x - startPt.x));
    rect.setAttribute('height', Math.abs(currentPt.y - startPt.y));
    rect.setAttribute('fill', 'rgba(37,99,235,0.15)');
    rect.setAttribute('stroke', '#2563eb');
    rect.setAttribute('stroke-width', 1 / scale);
    rect.setAttribute('stroke-dasharray', `${4 / scale} ${3 / scale}`);
    layer.appendChild(rect);
  }
}

function setupTakeoffEditInteraction() {
  const svg = document.getElementById('markup-svg');

  svg.addEventListener('mousedown', (e) => {
    if (!editingInstance || e.button !== 0) return;
    e.stopPropagation();
    const pt = getMeasureSvgPoint(e);
    const hitPoint = hitTestTakeoffEditPoint(pt);

    if (hitPoint !== null) {
      const now = Date.now();
      const isDoubleClick =
        takeoffLastClickPoint && takeoffLastClickPoint.index === hitPoint && now - takeoffLastClickPoint.time < 400;
      takeoffLastClickPoint = { index: hitPoint, time: now };
      if (isDoubleClick) {
        takeoffLastClickPoint = null;
        deleteTakeoffEditPoints([hitPoint]);
        return;
      }
      if (!editSelectedPointIndices.has(hitPoint)) {
        editSelectedPointIndices = new Set([hitPoint]);
        renderTakeoffEditOverlay();
      }
      takeoffEditDrag = { startPt: pt, moved: false };
      return;
    }

    const hitSegment = hitTestTakeoffEditSegment(pt);
    if (hitSegment) {
      editSelectedPointIndices = new Set(hitSegment);
      renderTakeoffEditOverlay();
      return;
    }

    // Empty space inside the edit svg - start a marquee selection rather
    // than exiting immediately, so a drag-to-select gesture works; a plain
    // click with no drag (handled on mouseup below) exits edit mode instead.
    takeoffMarquee = { startPt: pt, currentPt: null };
    editSelectedPointIndices = new Set();
    renderTakeoffEditOverlay();
  });

  svg.addEventListener('mousemove', (e) => {
    if (!editingInstance) return;
    const pt = getMeasureSvgPoint(e);
    if (takeoffEditDrag) {
      const dx = pt.x - takeoffEditDrag.startPt.x;
      const dy = pt.y - takeoffEditDrag.startPt.y;
      if (dx || dy) takeoffEditDrag.moved = true;
      takeoffEditDrag.startPt = pt;
      for (const i of editSelectedPointIndices) {
        editingInstance.geometry.points[i].x += dx;
        editingInstance.geometry.points[i].y += dy;
      }
      renderTakeoffEditOverlay();
    } else if (takeoffMarquee) {
      takeoffMarquee.currentPt = pt;
      renderTakeoffEditOverlay();
    }
  });

  window.addEventListener('mouseup', () => {
    if (takeoffEditDrag) {
      const moved = takeoffEditDrag.moved;
      takeoffEditDrag = null;
      if (moved) applyTakeoffEditGeometry(editingInstance.geometry.points);
      return;
    }
    if (takeoffMarquee) {
      const { startPt, currentPt } = takeoffMarquee;
      // A few pixels of tolerance so a near-stationary click (real mice and
      // touch both jitter slightly) still counts as "click to exit" rather
      // than starting a technically-non-empty but practically-useless marquee.
      const scale = zoomPan ? zoomPan.state.scale : 1;
      const draggedEnough = currentPt && Math.hypot(currentPt.x - startPt.x, currentPt.y - startPt.y) > 3 / scale;
      if (draggedEnough && editingInstance) {
        const x0 = Math.min(startPt.x, currentPt.x);
        const x1 = Math.max(startPt.x, currentPt.x);
        const y0 = Math.min(startPt.y, currentPt.y);
        const y1 = Math.max(startPt.y, currentPt.y);
        const selected = new Set();
        editingInstance.geometry.points.forEach((p, i) => {
          if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) selected.add(i);
        });
        editSelectedPointIndices = selected;
        takeoffMarquee = null;
        renderTakeoffEditOverlay();
      } else {
        // No drag happened - a plain click on empty space exits edit mode.
        takeoffMarquee = null;
        exitTakeoffEditMode();
      }
    }
  });

  document.addEventListener('keydown', (e) => {
    if (!editingInstance) return;
    if (e.key === 'Escape') {
      exitTakeoffEditMode();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && editSelectedPointIndices.size > 0) {
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      deleteTakeoffEditPoints([...editSelectedPointIndices]);
    }
  });
}

function setupTakeoffCrosshair() {
  const wrap = document.getElementById('zoom-wrap');
  const vLine = document.getElementById('takeoff-crosshair-v');
  const hLine = document.getElementById('takeoff-crosshair-h');
  wrap.addEventListener('mousemove', (e) => {
    if (!takeoffTool) {
      hideTakeoffCrosshair();
      return;
    }
    const rect = wrap.getBoundingClientRect();
    vLine.style.left = `${e.clientX - rect.left}px`;
    hLine.style.top = `${e.clientY - rect.top}px`;
    vLine.style.display = '';
    hLine.style.display = '';
  });
  wrap.addEventListener('mouseleave', hideTakeoffCrosshair);
}

function hideTakeoffCrosshair() {
  document.getElementById('takeoff-crosshair-v').style.display = 'none';
  document.getElementById('takeoff-crosshair-h').style.display = 'none';
}

function persistActiveTakeoff() {
  if (activeTakeoffItemId) {
    localStorage.setItem(takeoffStorageKey(), JSON.stringify({ itemId: activeTakeoffItemId }));
  } else {
    localStorage.removeItem(takeoffStorageKey());
  }
}

// Full disarm - Escape, the pane's Stop button, or switching to measure/
// markup all go through this. Unlike measure, there's no two-tier clear
// (points-only vs. tool-off); take-off drops everything in one step per spec.
function deactivateTakeoff() {
  if (!takeoffTool && !activeTakeoffItemId) return;
  takeoffTool = null;
  activeTakeoffItemId = null;
  lastPlacedInstanceId = null;
  clearTakeoffDraft();
  localStorage.removeItem(takeoffStorageKey());
  document.querySelectorAll('#takeoff-tool-grid .tool-btn').forEach((b) => b.classList.remove('active'));
  hideTakeoffCrosshair();
  renderTakeoffPane();
}

async function submitTakeoffInstance(itemId, points, quantity) {
  try {
    const { instance } = await api('POST', `/api/projects/${projectId}/sheets/${sheetId}/take-off-instances`, {
      item_id: itemId,
      geometry: { points },
      quantity,
    });
    lastPlacedInstanceId = instance.id;
    await Promise.all([loadSheetTakeoffInstances(), loadTakeoffItems()]);
    renderTakeoffPane();
  } catch (err) {
    showToast(`Failed to save take-off: ${err.message}`, 'error');
  }
}

// The naming modal already ran before the tool was armed (see
// setupTakeoffTools), so activeTakeoffItemId is always set by the time a
// measurement is actually being placed - this just records the instance.
function finishTakeoffInstance() {
  const points = [...takeoffPoints];
  const quantity = takeoffTool === 'area' ? polygonAreaFeet(points) : polylineLengthFeet(points);
  clearTakeoffDraft();
  submitTakeoffInstance(activeTakeoffItemId, points, quantity);
}

async function undoLastTakeoffPlacement() {
  if (!lastPlacedInstanceId) return;
  const id = lastPlacedInstanceId;
  lastPlacedInstanceId = null;
  await deleteTakeoffInstance(id);
}

function setupTakeoffInteraction() {
  const svg = document.getElementById('markup-svg');
  // Capture phase, same reasoning as measure's listener - an existing markup
  // hit-area would otherwise swallow the click via stopPropagation() first.
  svg.addEventListener(
    'click',
    (e) => {
      if (!takeoffTool) return;
      e.stopPropagation();
      let pt = getMeasureSvgPoint(e);

      // One click = one instance (quantity always 1) - no multi-point draft,
      // stays armed immediately for the next count.
      if (takeoffTool === 'count') {
        submitTakeoffInstance(activeTakeoffItemId, [pt], 1);
        return;
      }

      // Shift locks the new point to 0/45/90/... relative to the last
      // placed point - nothing to snap against for the very first point.
      if (e.shiftKey && takeoffPoints.length > 0) {
        pt = snapToAngle(takeoffPoints[takeoffPoints.length - 1], pt);
      }

      if (takeoffTool === 'linear') {
        takeoffPoints.push(pt);
        redrawTakeoff();
        if (takeoffPoints.length === 2) finishTakeoffInstance();
        return;
      }

      if (takeoffPoints.length > 2) {
        const last = takeoffPoints[takeoffPoints.length - 1];
        if (Math.hypot(pt.x - last.x, pt.y - last.y) < 6) {
          finishTakeoffInstance();
          return;
        }
      }
      takeoffPoints.push(pt);
      redrawTakeoff();
    },
    true
  );

  svg.addEventListener('mousemove', (e) => {
    if (!takeoffTool || takeoffPoints.length === 0) return;
    let pt = getMeasureSvgPoint(e);
    if (e.shiftKey) pt = snapToAngle(takeoffPoints[takeoffPoints.length - 1], pt);
    redrawTakeoff(pt);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && takeoffTool && takeoffTool !== 'linear' && takeoffPoints.length >= 3) finishTakeoffInstance();
    if (e.key === 'Escape' && takeoffTool) deactivateTakeoff();
    if (e.key === 'Backspace' && takeoffTool) {
      // Ignore Backspace while an actual text field has focus (e.g. the
      // naming modal's name input) - it should delete text there, not undo.
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      if (takeoffTool === 'count') {
        undoLastTakeoffPlacement(); // no draft points to pop - undo the last submitted count instance instead
      } else if (takeoffPoints.length > 0) {
        takeoffPoints.pop();
        redrawTakeoff();
      }
    }
  });
}

function nextTakeoffColor() {
  // Golden-angle hue rotation, not a fixed palette - stays maximally spread
  // (never hard-repeats) at "50 or more" items, where a ~20-color fixed
  // palette would start visibly reusing colors.
  const hue = (takeoffItems.length * 137.508) % 360;
  return hslToHex(hue, 65, 45);
}

function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x) =>
    Math.round(255 * x)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

function openTakeoffNamingModal(type, onDone) {
  const isCount = type === 'count';
  let selectedShape = isCount ? 'square' : null;
  openModal(`
    <h2>New take-off item</h2>
    <div class="field">
      <label>Name</label>
      <input id="takeoff-name" autocomplete="off" placeholder="e.g. 2x4 top plate">
    </div>
    <div class="field">
      <label>Color</label>
      <input type="color" id="takeoff-color" value="${nextTakeoffColor()}">
    </div>
    ${
      isCount
        ? `<div class="field">
             <label>Shape</label>
             <div class="icon-tool-grid" id="takeoff-shape-grid"></div>
           </div>`
        : ''
    }
    <p class="error" id="takeoff-name-error" style="display:none;"></p>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Cancel</button>
      <button class="primary" type="button" id="modal-create">Create</button>
    </div>
  `);
  document.getElementById('takeoff-name').focus();

  if (isCount) {
    const shapeGrid = document.getElementById('takeoff-shape-grid');
    for (const shape of Object.keys(TAKEOFF_SHAPE_ICONS)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tool-btn tool-icon-btn' + (shape === selectedShape ? ' active' : '');
      btn.title = shape;
      btn.innerHTML = TAKEOFF_SHAPE_ICONS[shape];
      btn.addEventListener('click', () => {
        selectedShape = shape;
        shapeGrid.querySelectorAll('.tool-btn').forEach((b) => b.classList.toggle('active', b.title === shape));
      });
      shapeGrid.appendChild(btn);
    }
  }

  document.getElementById('modal-cancel').addEventListener('click', () => {
    closeModal();
    onDone(null);
  });
  document.getElementById('modal-create').addEventListener('click', async () => {
    const name = document.getElementById('takeoff-name').value.trim();
    const color = document.getElementById('takeoff-color').value;
    const errEl = document.getElementById('takeoff-name-error');
    if (!name) {
      errEl.textContent = 'Name is required.';
      errEl.style.display = 'block';
      return;
    }
    const createBtn = document.getElementById('modal-create');
    createBtn.disabled = true;
    try {
      const { item } = await api('POST', `/api/projects/${projectId}/take-off-items`, {
        name,
        type,
        color,
        shape: selectedShape,
      });
      closeModal();
      onDone(item);
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
      createBtn.disabled = false;
    }
  });
}

function groupTakeoffInstancesByItem() {
  const map = new Map();
  for (const inst of sheetTakeoffInstances) {
    if (!map.has(inst.item_id)) map.set(inst.item_id, []);
    map.get(inst.item_id).push(inst);
  }
  return map;
}

function formatTakeoffQuantity(type, value) {
  if (type === 'area') return `${value.toLocaleString(undefined, { maximumFractionDigits: 0 })} SF`;
  if (type === 'count') return `${Math.round(value)}`;
  return `${value.toFixed(1)} ft`;
}

async function deleteTakeoffInstance(id) {
  try {
    await api('DELETE', `/api/take-off-instances/${id}`);
    await Promise.all([loadSheetTakeoffInstances(), loadTakeoffItems()]);
    renderTakeoffPane();
  } catch (err) {
    showToast(`Failed to delete: ${err.message}`, 'error');
  }
}

async function removeTakeoffItemFromSheet(item) {
  const ok = await confirmModal({
    title: 'Remove from this sheet?',
    message: `All placed instances of "${item.name}" on this sheet will be removed. Other sheets are unaffected.`,
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('DELETE', `/api/projects/${projectId}/sheets/${sheetId}/take-off-instances?item_id=${item.id}`);
    if (item.id === activeTakeoffItemId) deactivateTakeoff();
    await Promise.all([loadSheetTakeoffInstances(), loadTakeoffItems()]);
    renderTakeoffPane();
  } catch (err) {
    showToast(`Failed to remove: ${err.message}`, 'error');
  }
}

async function deleteTakeoffItemFromProject(item) {
  const ok = await confirmModal({
    title: 'Delete this take-off item?',
    message: `"${item.name}" and all its placed instances across every sheet will be permanently removed.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('DELETE', `/api/projects/${projectId}/take-off-items/${item.id}`);
    if (item.id === activeTakeoffItemId) deactivateTakeoff();
    takeoffItems = takeoffItems.filter((i) => i.id !== item.id);
    await loadSheetTakeoffInstances();
    renderTakeoffPane();
  } catch (err) {
    showToast(`Failed to delete: ${err.message}`, 'error');
  }
}

function renderTakeoffPane() {
  // Committed geometry must stop being clickable (edit-enabled) the instant
  // a placement tool arms, not just whenever instance data next reloads -
  // renderTakeoffPane() already runs on every arm/disarm/resume transition,
  // so it's the reliable place to keep this in sync.
  const instancesLayer = document.getElementById('takeoff-instances-layer');
  if (instancesLayer) instancesLayer.classList.toggle('edit-enabled', !takeoffTool);

  document.querySelectorAll('#takeoff-tool-grid .tool-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tool === takeoffTool);
    b.disabled = !!activeTakeoffItemId && b.dataset.tool !== takeoffTool;
  });

  // Just the total on this sheet per item - not a breakdown of every
  // individual placement (that level of detail lives in takeoffs.html's
  // per-item, per-sheet expand instead). The active item is shown by
  // highlighting its row (no separate banner above the list).
  const grouped = groupTakeoffInstancesByItem();
  const list = document.getElementById('takeoff-items-list');
  list.innerHTML = '';
  if (takeoffItems.length === 0) {
    list.innerHTML = '<p class="muted">No take-off items yet - pick a tool above to create one.</p>';
    return;
  }
  for (const item of takeoffItems) {
    const instances = grouped.get(item.id) || [];
    const sheetTotal = instances.reduce((sum, i) => sum + i.quantity, 0);
    const isActive = item.id === activeTakeoffItemId;
    const row = document.createElement('div');
    row.className = 'takeoff-item-row' + (isActive ? ' active' : '');
    row.innerHTML = `
      <span class="takeoff-color-dot" style="background:${item.color};"></span>
      <span class="takeoff-item-name">${escapeHtml(item.name)}</span>
      <span class="takeoff-item-total muted">${formatTakeoffQuantity(item.type, sheetTotal)} on this sheet</span>
      ${isActive ? '<button type="button" class="takeoff-row-stop-btn">Stop</button>' : ''}
      <button type="button" class="icon-btn takeoff-row-action" data-action="sheet" title="Remove from this sheet">&#8722;</button>
      <button type="button" class="icon-btn takeoff-row-action" data-action="project" title="Delete from project">&#128465;</button>`;
    row.addEventListener('click', () => {
      if (!scaleFeetPerInch) {
        showToast('Set a scale first.', 'error');
        return;
      }
      if (item.id === activeTakeoffItemId) return;
      exitTakeoffEditMode();
      clearMeasure();
      stopMeasureTool();
      if (markupsController) markupsController.forceSelectTool();
      clearTakeoffDraft();
      takeoffTool = item.type;
      activeTakeoffItemId = item.id;
      lastPlacedInstanceId = null;
      persistActiveTakeoff();
      renderTakeoffPane();
    });
    if (isActive) {
      row.querySelector('.takeoff-row-stop-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        deactivateTakeoff();
      });
    }
    row.querySelector('[data-action="sheet"]').addEventListener('click', (e) => {
      e.stopPropagation();
      removeTakeoffItemFromSheet(item);
    });
    row.querySelector('[data-action="project"]').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteTakeoffItemFromProject(item);
    });
    list.appendChild(row);
  }
}

async function loadTakeoffItems() {
  try {
    const { items } = await api('GET', `/api/projects/${projectId}/take-off-items`);
    takeoffItems = items;
  } catch (err) {
    // offline or forbidden - pane keeps showing whatever it already had
  }
}

async function loadSheetTakeoffInstances() {
  try {
    const { instances } = await api('GET', `/api/projects/${projectId}/sheets/${sheetId}/take-off-instances`);
    sheetTakeoffInstances = instances;
    renderTakeoffInstances();
  } catch (err) {
    // offline - no instances shown this session
  }
}

async function setupTakeoffTools() {
  document.getElementById('section-takeoffs').style.display = '';
  document.getElementById('sheet-pane').classList.add('pane-wide');
  const grid = document.getElementById('takeoff-tool-grid');
  const defs = [
    { tool: 'linear', title: 'Linear take-off' },
    { tool: 'perimeter', title: 'Perimeter take-off' },
    { tool: 'area', title: 'Area take-off' },
    { tool: 'count', title: 'Count take-off' },
  ];
  for (const def of defs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tool-btn tool-icon-btn';
    btn.dataset.tool = def.tool;
    btn.title = def.title;
    btn.innerHTML = def.tool === 'count' ? TAKEOFF_COUNT_ICON : MEASURE_ICONS[def.tool === 'linear' ? 'line' : def.tool];
    btn.addEventListener('click', () => {
      if (overlayActive) return;
      if (btn.disabled) return;
      if (!scaleFeetPerInch) {
        showToast('Set a scale first.', 'error');
        return;
      }
      // Clicking the already-armed tool turns it off. Otherwise this always
      // starts a brand-new item - resuming an existing one happens by
      // clicking its row in the pane list instead - so name/color are
      // collected up front, before any geometry is placed, not after.
      if (takeoffTool === def.tool && activeTakeoffItemId) {
        deactivateTakeoff();
        return;
      }
      exitTakeoffEditMode();
      clearTakeoffDraft();
      clearMeasure();
      stopMeasureTool();
      if (markupsController) markupsController.forceSelectTool();
      openTakeoffNamingModal(def.tool, (item) => {
        if (!item) return; // cancelled - nothing armed
        takeoffItems.push({ ...item, total_quantity: 0, instance_count: 0 });
        takeoffTool = def.tool;
        activeTakeoffItemId = item.id;
        lastPlacedInstanceId = null;
        persistActiveTakeoff();
        renderTakeoffPane();
      });
    });
    grid.appendChild(btn);
  }

  setupTakeoffInteraction();
  setupTakeoffCrosshair();
  setupTakeoffEditInteraction();

  await loadTakeoffItems();
  await loadSheetTakeoffInstances();

  // Resume an item left armed on a previous sheet, if it still exists.
  try {
    const saved = JSON.parse(localStorage.getItem(takeoffStorageKey()) || 'null');
    if (saved && saved.itemId) {
      const item = takeoffItems.find((i) => i.id === saved.itemId);
      if (item) {
        takeoffTool = item.type;
        activeTakeoffItemId = item.id;
      } else {
        localStorage.removeItem(takeoffStorageKey());
      }
    }
  } catch (err) {
    localStorage.removeItem(takeoffStorageKey());
  }
  renderTakeoffPane();
}

function setupScaleSelect(sheet) {
  const select = document.getElementById('scale-select');
  select.innerHTML =
    '<option value="">Select scale...</option>' +
    STANDARD_SCALES.map((s, i) => `<option value="${i}">${s.label}</option>`).join('') +
    '<option value="custom">Custom...</option>';

  scaleFeetPerInch = sheet.scale_feet_per_inch || null;
  if (scaleFeetPerInch) {
    const idx = STANDARD_SCALES.findIndex((s) => Math.abs(s.feetPerInch - scaleFeetPerInch) < 0.0001);
    if (idx >= 0) {
      select.value = String(idx);
    } else {
      const opt = document.createElement('option');
      opt.value = 'saved';
      opt.textContent = `Custom (1"=${scaleFeetPerInch}')`;
      select.insertBefore(opt, select.lastElementChild);
      select.value = 'saved';
    }
  }

  select.addEventListener('change', async () => {
    const val = select.value;
    if (val === '') {
      scaleFeetPerInch = null;
    } else if (val === 'custom') {
      const input = await promptModal({
        title: 'Custom scale',
        message: 'Feet represented by 1 inch on the printed sheet (e.g. 4 for 1/4"=1\'-0"):',
        required: false,
      });
      const parsed = parseFloat(input);
      if (!parsed || parsed <= 0) {
        select.value = '';
        return;
      }
      scaleFeetPerInch = parsed;
    } else if (val === 'saved') {
      // keep existing scaleFeetPerInch
    } else {
      scaleFeetPerInch = STANDARD_SCALES[Number(val)].feetPerInch;
    }
    try {
      await api('PATCH', `/api/projects/${projectId}/sheets/${sheetId}`, { scale_feet_per_inch: scaleFeetPerInch });
    } catch (err) {
      // read-only role or offline - scale still usable locally this session, just won't persist
    }
  });
}

// ---------- Offline fallback ----------
async function loadSheetOffline() {
  const cachedSheets = await getCachedSheets(projectId);
  const cached = cachedSheets.find((s) => String(s.sheet_id) === String(sheetId));
  if (!cached) return null;
  return {
    sheet: {
      id: cached.sheet_id,
      sheet_number: cached.sheet_number,
      discipline: cached.discipline,
      current_version_id: cached.current_version_id,
      scale_feet_per_inch: null,
    },
    versions: [
      {
        id: cached.current_version_id,
        revision_id: cached.current_revision_id,
        revision_title: 'Current (offline)',
        title: cached.current_title,
        published_at: '',
      },
    ],
  };
}

(async function init() {
  const me = await requireSession();
  if (!me) return;
  canManage = me.role === 'admin' || me.role === 'editor';
  canTakeoff = me.role === 'admin' || !!me.can_takeoff;

  let sheet;
  let versions;
  let offlineMode = false;
  try {
    ({ sheet, versions } = await api('GET', `/api/projects/${projectId}/sheets/${sheetId}`));
  } catch (err) {
    const offline = await loadSheetOffline();
    await renderShell({
      topbarEl: document.getElementById('topbar'),
      sidebarEl: document.getElementById('sidebar'),
      projectId,
      active: 'viewer',
      me,
    });
    if (!offline) {
      document.getElementById('pdf-status').textContent = 'Offline, and this sheet has never been synced to this device.';
      return;
    }
    ({ sheet, versions } = offline);
    offlineMode = true;
  }

  currentSheet = sheet;
  allVersions = versions;
  displayedVersionId = sheet.current_version_id;

  if (!offlineMode) {
    const currentVersion = versions.find((v) => v.id === sheet.current_version_id) || versions[0];
    await renderShell({
      topbarEl: document.getElementById('topbar'),
      sidebarEl: document.getElementById('sidebar'),
      projectId,
      active: 'viewer',
      me,
      onOverlayClick: openOverlayPicker,
      sheetHistoryEntry: {
        sheetId,
        sheetNumber: sheet.sheet_number,
        title: currentVersion ? currentVersion.title : '',
      },
    });
  }

  setupDownloadButton();
  setupEditSheetButton();
  updateVersionBadge();
  renderSearchTermChip();
  setupZoomPan();
  setupOverlayAlignDrag();
  setupScaleSelect(sheet);
  setupMeasureTools();
  if (canTakeoff) await setupTakeoffTools();

  let documents = [];
  let folders = [];
  if (!offlineMode) {
    try {
      [{ documents }, { folders }] = await Promise.all([
        api('GET', `/api/projects/${projectId}/documents`),
        api('GET', `/api/projects/${projectId}/documents/folders`),
      ]);
    } catch (err) {
      // offline - markup link picker just won't have options this session
    }
  }

  markupsController = initMarkups({
    sheetId,
    me,
    svgEl: document.getElementById('markup-svg'),
    canvasEl: document.getElementById('pdf-canvas'),
    documents,
    folders,
    onToolChange: (tool) => {
      if (tool !== 'select') {
        clearMeasure();
        stopMeasureTool();
        deactivateTakeoff();
      }
    },
  });

  await renderPdf(displayedVersionId);
  await markupsController.load();
})();
