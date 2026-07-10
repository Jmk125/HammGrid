import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';
import { initMarkups } from '/js/markups.js';
import { getCachedAsset, getCachedSheets } from '/js/offline-store.js';
import { renderShell, openModal, closeModal, showToast, promptModal } from '/js/shell.js';
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
let canManage = false;
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
    isPanBlocked: (e) => {
      if (overlayAlignActive) return true;
      if (markupsController && markupsController.isToolActive()) return true;
      if (measureTool) return true;
      const tag = (e.target.tagName || '').toLowerCase();
      return tag !== 'svg' && tag !== 'canvas';
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

    statusEl.textContent = cachedFile ? '(from local cache)' : '';
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

const MEASURE_ICONS = {
  line: '<svg viewBox="0 0 20 20"><line x1="2" y1="18" x2="18" y2="2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="5" y1="15" x2="7" y2="17" stroke="currentColor" stroke-width="1.5"/><line x1="9" y1="11" x2="11" y2="13" stroke="currentColor" stroke-width="1.5"/><line x1="13" y1="7" x2="15" y2="9" stroke="currentColor" stroke-width="1.5"/></svg>',
  perimeter:
    '<svg viewBox="0 0 20 20"><polyline points="2,16 7,6 12,14 18,4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  area: '<svg viewBox="0 0 20 20"><polygon points="3,16 3,7 10,3 17,8 15,16" stroke="currentColor" stroke-width="2" fill="currentColor" fill-opacity="0.2"/></svg>',
};

let measureTool = null;
let measurePoints = [];
let scaleFeetPerInch = null;

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
    await renderShell({
      topbarEl: document.getElementById('topbar'),
      sidebarEl: document.getElementById('sidebar'),
      projectId,
      active: 'viewer',
      me,
      onOverlayClick: openOverlayPicker,
    });
  }

  setupDownloadButton();
  setupEditSheetButton();
  updateVersionBadge();
  setupZoomPan();
  setupOverlayAlignDrag();
  setupScaleSelect(sheet);
  setupMeasureTools();

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
      }
    },
  });

  await renderPdf(displayedVersionId);
  await markupsController.load();
})();
