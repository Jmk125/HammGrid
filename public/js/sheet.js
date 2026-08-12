import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';
import { initMarkups } from '/js/markups.js';
import {
  getCachedAsset,
  getCachedSheets,
  updateCachedSheetMetadata,
  getCachedTakeoffItems,
  getCachedTakeoffAssemblies,
  getCachedTakeoffInstancesForSheet,
} from '/js/offline-store.js';
import { renderShell, openModal, closeModal, showToast, promptModal, confirmModal } from '/js/shell.js';
import { setupZoomPan as setupSharedZoomPan } from '/js/zoomPan.js';
import { setupAdvancedFields, wireNamePreview } from '/js/takeoffAdvancedFields.js';
import { computeTakeoffOutput, parseTakeoffProperties, resolveTakeoffName } from '/js/takeoffFormula.js';
import { openFragmentPicker } from '/js/fragmentPicker.js';

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
// Composite sheets get a higher ceiling than an ordinary uploaded sheet: the
// 6000px cap above exists because an ordinary sheet is one giant scanned
// raster page, where "large page" and "large amount of raster data" are the
// same thing. A composite isn't - compose.py already resolutions each
// fragment independently (RENDER_SCALE, capped per-fragment - see its own
// module docstring on why a shared canvas-wide budget was the wrong model),
// so the PDF page itself stays a handful of moderate embedded images
// regardless of how large the page is. Capping composites at the SAME 6000px
// as an ordinary sheet was throwing away resolution PDF.js already had to
// work with the instant the page grew past ~33in (2400pt) - which the
// default blank-canvas floor (44in/3168pt, see compositePipeline.js) already
// does - producing exactly the "sharp while editing, blurry once flattened"
// mismatch this constant fixes: editing shows each fragment's own preview
// asset at full RENDER_SCALE, and this lets the flattened page's client-side
// render reach that same RENDER_SCALE instead of silently downscaling below
// it. Still bounded, just to a size no realistic composite should exceed.
const MAX_RENDER_PX_COMPOSITE = 9000;
let currentRenderScale = RENDER_SCALE; // set per-render below; measurement math must use this, not the constant, once large sheets scale it down

const params = new URLSearchParams(window.location.search);
const projectId = params.get('projectId');
const sheetId = params.get('sheetId');
const flagIdParam = params.get('flagId');

let markupsController = null;
let currentSheet = null;
let sheetLinkLoadToken = 0;
let canManage = false;
let canTakeoff = false;
let isAdmin = false;
let magnifierLens = null; // set up by setupMagnifierLens() - see its return value
let magnifierCorner = 'bottom-left'; // from user settings, read in init()
let allVersions = [];
let displayedVersionId = null;

// ---------- Composite drawing "Edit Layout" mode ----------
// Only reachable for currentSheet.is_composite - a workspace for stitching
// crops of other sheets together (see fragmentPicker.js and the
// composite-drawings plan). While active, the markup/measure/take-off panes
// are hidden and their tools disarmed (deactivateTakeoff/clearMeasure/
// forceSelectTool, same disarm sequence armFreezePane already uses) rather
// than each tool separately checking an editLayoutMode flag - there is no
// other UI surface to re-arm them while their panes aren't shown, so that's
// sufficient without threading a guard through every existing handler.
let editLayoutMode = false;
// Every fragment mutation during a session runs with ?regenerate=0 (see
// compositeNeedsRefreshOnExit below) for instant feedback, so the SVG's
// viewBox - normally tied 1:1 to the last-flattened composite PDF's own page
// size (see syncSheetLinkLayer) - never grows mid-session; dragging a
// fragment past whatever that page size happened to be at last regenerate
// used to push it past the viewBox's own rect, which SVGs clip to by
// default, making it silently vanish instead of "growing to fit" like it
// seemed to before this deferred-regenerate design. enterEditLayoutMode
// adds the 'composite-edit-active' class (see style.css) to stop the SVG
// clipping at all for the duration of the session - genuinely unlimited
// canvas, not just a bigger fixed one - while the actual output page size
// is still auto-fit-to-content by computeCanvasSize server-side at
// finalize. Left as the plain viewBox-tied size the rest of the time so
// every constant-screen-size stroke-width (`.../scale`) calculation
// elsewhere keeps assuming 1 viewBox unit == 1 pre-zoom CSS px, which only
// holds when the SVG's own physical box matches its viewBox exactly.
let compositeFragments = [];
let selectedFragmentId = null;
let fragmentDrag = null; // {fragmentId, startPt (render-px), origPlaceX, origPlaceY (pdf-pt)}
let fragmentRotateDrag = null; // {fragmentId, centerPt (render-px), startAngle, origRotation} - dragging the selected fragment's rotate handle
let fragmentClickCycle = null; // {x, y, ids, index} - repeated clicks at the same spot cycle through overlapping fragments
// True once any fragment mutation ran with ?regenerate=0 (place, rotation,
// lock, visibility, z-order, bring-in, delete - see patchFragment/
// commitFragmentTransform/deleteFragment/openBringInFragmentFlow) - the
// underlying flattened PDF is behind what Edit Layout mode is showing live
// via each fragment's own preview <image>; exitEditLayoutMode() calls
// finalizeCompositeLayout() once so the take-off-ready PDF catches up
// before you leave, regardless of how many edits happened in between.
let compositeNeedsRefreshOnExit = false;
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

// ---------- Frozen reference panes ("press F") ----------
// Session-only scratch space - never persisted, never sent to the server.
// A pane is a screen-anchored (not sheet-anchored) snapshot of the PDF
// render, so panning/zooming the main drawing never moves it.
let freezeArmed = false;
let freezeDragStart = null;
let freezePanes = [];

function searchStorageKey() {
  return `hammgrid-sheet-search:${projectId}`;
}

// ---------- In-page tab strip ----------
// sessionStorage (not localStorage, unlike every other key in this file) -
// deliberately scoped to THIS real browser tab, so each browser tab/window
// gets its own independent set of open sheets. The list only ever grows via
// the sheet-link context menu's "open as tab" action, which is just a plain
// navigation - ensureCurrentSheetInOpenTabs() (called on every load) is what
// actually appends/relabels, so ordinary navigation elsewhere (sheet-nav
// arrows, take-off/flag "go to drawing" links) never silently adds tabs.
function openTabsKey() {
  return `hammgrid-open-tabs:${projectId}`;
}

function loadOpenTabs() {
  try {
    return JSON.parse(sessionStorage.getItem(openTabsKey())) || [];
  } catch (err) {
    return [];
  }
}

function saveOpenTabs(list) {
  sessionStorage.setItem(openTabsKey(), JSON.stringify(list));
}

function ensureCurrentSheetInOpenTabs() {
  const tabs = loadOpenTabs();
  if (tabs.length === 0) {
    saveOpenTabs([{ sheetId, label: currentSheet.sheet_number }]);
    return;
  }
  const idx = tabs.findIndex((t) => String(t.sheetId) === String(sheetId));
  if (idx !== -1) {
    tabs[idx].label = currentSheet.sheet_number;
    saveOpenTabs(tabs);
  }
  // else: current sheet isn't part of any open-tab set (ordinary
  // navigation) - leave the list untouched.
}

function renderTabStrip() {
  const strip = document.getElementById('sheet-tab-strip');
  const tabs = loadOpenTabs();
  strip.style.display = tabs.length > 1 ? 'flex' : 'none';
  strip.innerHTML = '';
  tabs.forEach((tab, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sheet-tab';
    if (String(tab.sheetId) === String(sheetId)) btn.classList.add('active');
    btn.innerHTML = `<span>${tab.label || '…'}</span>`;
    if (i > 0) {
      const closeBtn = document.createElement('span');
      closeBtn.className = 'sheet-tab-close';
      closeBtn.innerHTML = '&times;';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(i);
      });
      btn.appendChild(closeBtn);
    }
    btn.addEventListener('click', () => {
      if (String(tab.sheetId) === String(sheetId)) return;
      window.location.href = `/sheet.html?projectId=${projectId}&sheetId=${tab.sheetId}`;
    });
    strip.appendChild(btn);
  });
}

function closeTab(index) {
  const tabs = loadOpenTabs();
  const wasActive = String(tabs[index].sheetId) === String(sheetId);
  tabs.splice(index, 1);
  saveOpenTabs(tabs);
  if (wasActive) {
    const prev = tabs[Math.max(0, index - 1)];
    window.location.href = `/sheet.html?projectId=${projectId}&sheetId=${prev.sheetId}`;
  } else {
    renderTabStrip();
  }
}

// ---------- Right pane: collapse + accordion sections ----------
const PANE_WIDTH_KEY = 'hammgrid-pane-width';
const PANE_MIN_WIDTH = 260;
const PANE_MAX_WIDTH = 640;

// A saved custom width is applied as an inline style, which naturally wins
// over the fixed 360px .pane-wide class (see setupTakeoffTools) once the
// user has resized at least once - no extra bookkeeping needed to keep them
// in sync. That same inline style also wins over .collapsed's 32px rule
// though (inline beats a class selector), which is exactly what silently
// broke collapsing after a resize - see setupPaneToggle/setupPaneResize
// below for where this gets applied/cleared to keep both working together.
function applySavedPaneWidth() {
  const pane = document.getElementById('sheet-pane');
  const saved = parseInt(localStorage.getItem(PANE_WIDTH_KEY), 10);
  if (saved >= PANE_MIN_WIDTH && saved <= PANE_MAX_WIDTH) pane.style.width = `${saved}px`;
}

(function setupPaneToggle() {
  const pane = document.getElementById('sheet-pane');
  const btn = document.getElementById('pane-toggle-btn');
  const key = 'sheet-pane-collapsed';
  if (localStorage.getItem(key) === '1') pane.classList.add('collapsed');
  btn.addEventListener('click', () => {
    pane.classList.toggle('collapsed');
    localStorage.setItem(key, pane.classList.contains('collapsed') ? '1' : '0');
    if (pane.classList.contains('collapsed')) {
      // Clear the resize-drag's inline width - otherwise it keeps
      // outranking .collapsed's 32px rule and the pane never visibly
      // shrinks, even though its body still hides.
      pane.style.width = '';
    } else {
      // Expanding again - restore whatever custom width was last dragged to,
      // rather than snapping back to the default .pane-wide width.
      applySavedPaneWidth();
    }
  });
})();

// ---------- Right pane: drag-to-resize ----------
(function setupPaneResize() {
  const pane = document.getElementById('sheet-pane');
  const handle = document.getElementById('pane-resize-handle');
  const key = PANE_WIDTH_KEY;
  const MIN_WIDTH = PANE_MIN_WIDTH;
  const MAX_WIDTH = PANE_MAX_WIDTH;

  // Skip on a page load that starts collapsed - applying the saved width
  // here too would immediately override .collapsed's 32px rule the same
  // way a live toggle used to (see setupPaneToggle above).
  if (!pane.classList.contains('collapsed')) applySavedPaneWidth();

  let dragging = false;
  let startX = 0;
  let startWidth = 0;
  let currentWidth = 0;
  handle.addEventListener('mousedown', (e) => {
    if (pane.classList.contains('collapsed')) return;
    dragging = true;
    startX = e.clientX;
    startWidth = pane.getBoundingClientRect().width;
    currentWidth = startWidth;
    handle.classList.add('dragging');
    // .sheet-pane has a width transition for the collapse/expand toggle -
    // during an active drag that just makes the pane visibly lag behind the
    // cursor (and, worse, means a getBoundingClientRect() read right at
    // mouseup can catch a mid-animation value instead of the drop target).
    // Suspend it for the duration of the drag.
    pane.style.transition = 'none';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    // Handle sits on the pane's LEFT edge, so moving the mouse left (negative
    // dx) is what widens the pane.
    const dx = startX - e.clientX;
    currentWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + dx));
    pane.style.width = `${currentWidth}px`;
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    pane.style.transition = '';
    document.body.style.userSelect = '';
    // Saved from the tracked drag target, not a fresh getBoundingClientRect()
    // read - immediately after re-enabling the transition above, a layout
    // query here could still catch a value mid-animation back toward it.
    localStorage.setItem(key, String(Math.round(currentWidth)));
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
      if (freezeArmed || freezeDragStart) return true;
      if (markupsController && markupsController.isToolActive()) return true;
      if (measureTool) return true;
      // Same rule as takeoffTool below - left is reserved for point/segment/
      // marquee/brush interaction, but right-click has nothing else claiming
      // it during editing (it opens "Copy selection to new item" on a
      // release-without-drag), so it should still pan like everywhere else.
      if (editingInstance) return e.button !== 2;
      // Only block when the target is actual floating UI chrome sitting on
      // top of the canvas (version badge, take-off toolbar buttons, etc.) -
      // not the drawing surface itself. Large/non-square sheets don't fill
      // the wrap at fit-to-view zoom, so the empty letterbox margin around
      // the drawing is still the bare wrap element (e.target === wrapEl),
      // and that must stay pannable too, not just the exact svg/canvas
      // pixels - otherwise a drag started in that margin (very easy to do,
      // especially near the bottom where floating toolbars dock) silently
      // does nothing.
      // Composite Edit Layout renders every fragment as its own <image>
      // (plus a page-background <rect>, rotate-handle <circle>/<line>, etc.
      // - see renderCompositeFragmentsOverlay) sitting on top of the bare
      // svg, so hovering an actual fragment hits one of those, not 'svg'
      // itself - same tag mismatch as any other chrome. Left-click there is
      // already spoken for (select/drag/rotate the fragment, handled by
      // setupCompositeLayoutInteraction's own mousedown listener), but
      // right-click has nothing else claiming it in this mode, so it should
      // still pan like everywhere else instead of being silently dead the
      // instant the cursor is over a drawing.
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag !== 'svg' && tag !== 'canvas' && e.target !== wrapEl) return editLayoutMode ? e.button !== 2 : true;
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
      // Committed take-off geometry bakes stroke-width/radius as an absolute
      // SVG-unit value computed from the scale at render time (same
      // constant-on-screen-size trick markups.js uses via setZoomScale
      // above) - unlike markups, nothing was re-running that computation on
      // later zoom changes, so a line's on-screen thickness would drift
      // instead of staying constant. Re-render on every zoom/pan tick to
      // match.
      if (sheetTakeoffInstances.length > 0) renderTakeoffInstances();
      if (editingInstance) renderTakeoffEditOverlay();
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

// Pans/zooms in on a single rect (fractional 0..1 sheet coordinates, e.g. a
// flag's geometry) instead of fitting the whole sheet - used when arriving
// via a ?flagId= link. Pads the rect generously so the flag has surrounding
// context, same fit-to-rect math as fitToView() but scoped to a sub-rect.
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
      ${isAdmin ? '<button type="button" id="edit-sheet-delete" class="danger" style="margin-right:auto;">Delete sheet&hellip;</button>' : ''}
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
  if (isAdmin) {
    document.getElementById('edit-sheet-delete').addEventListener('click', deleteCurrentSheet);
  }
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

// Permanent - every version, markup, take-off, and (for a composite) every
// fragment goes with it. confirmModal replaces this same modal's content
// with the confirmation prompt rather than stacking a second one (see
// deleteFragment's identical pattern) - closeModal already ran by the time
// the awaited promise resolves true, so there's nothing left to close here.
async function deleteCurrentSheet() {
  const ok = await confirmModal({
    title: `Delete "${currentSheet.sheet_number}"?`,
    message: currentSheet.is_composite
      ? 'This permanently deletes this composite drawing, its fragments, and any markups or take-offs on it. The sheets it was built from are not affected. This cannot be undone.'
      : 'This permanently deletes this sheet, every version of it, and any markups, take-offs, or flags on it. This cannot be undone.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('DELETE', `/api/projects/${projectId}/sheets/${sheetId}`);
    showToast('Sheet deleted.', 'success');
    window.location.href = `/viewer.html?projectId=${projectId}`;
  } catch (err) {
    showToast(`Failed to delete: ${err.message}`, 'error');
  }
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

function setupCompositeLayoutButton() {
  if (!canManage || !currentSheet.is_composite) return;
  const editSheetBtn = document.getElementById('edit-sheet-btn');
  const downloadBtn = document.getElementById('download-sheet-btn');
  const anchor = editSheetBtn || downloadBtn;
  const row = anchor ? anchor.parentElement : document.querySelector('#topbar > .row');
  if (!row || document.getElementById('edit-layout-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'edit-layout-btn';
  btn.type = 'button';
  btn.title = 'Arrange the fragments making up this composite drawing';
  btn.textContent = 'Edit Layout';
  btn.addEventListener('click', toggleEditLayoutMode);
  if (anchor) anchor.after(btn);
  else row.prepend(btn);
}

async function toggleEditLayoutMode() {
  if (editLayoutMode) {
    await exitEditLayoutMode();
  } else {
    await enterEditLayoutMode();
  }
}

async function enterEditLayoutMode() {
  // Same disarm sequence armFreezePane already uses - stopping every other
  // tool before this one takes over the canvas.
  deactivateTakeoff();
  exitTakeoffEditMode();
  clearMeasure();
  stopMeasureTool();
  if (markupsController) markupsController.forceSelectTool();

  editLayoutMode = true;
  document.getElementById('edit-layout-btn').classList.add('active');
  document.getElementById('edit-layout-btn').textContent = 'Done Editing Layout';
  for (const id of ['section-markup', 'section-measure', 'section-takeoffs']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
  document.getElementById('section-composite').style.display = '';
  document.getElementById('markup-svg').style.cursor = 'default';
  document.getElementById('markup-svg').classList.add('composite-edit-active');

  await loadCompositeFragments();
  fitEditLayoutView();
}

// Frames the view on whatever's actually placed (fixed-origin, so this is
// just the current fragments' bounding box) - "centered" here means
// centered on the real content, not on some literal midpoint of an
// unbounded plane. Falls back to the server's blank-canvas default size
// (see compositePipeline.js) when there's nothing placed yet, so a
// brand-new composite doesn't open zoomed to an arbitrary point.
const COMPOSITE_BLANK_CANVAS_PT = { width: 3168, height: 2448 };
function fitEditLayoutView() {
  if (!zoomPan) return;
  const wrapEl = document.getElementById('zoom-wrap');
  const rect = wrapEl.getBoundingClientRect();
  if (!rect.width) return;

  let bbox;
  if (compositeFragments.length > 0) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const f of compositeFragments) {
      const rad = ((f.rotation || 0) * Math.PI) / 180;
      const bw = Math.abs(f.place_width * Math.cos(rad)) + Math.abs(f.place_height * Math.sin(rad));
      const bh = Math.abs(f.place_width * Math.sin(rad)) + Math.abs(f.place_height * Math.cos(rad));
      const cx = f.place_x + f.place_width / 2;
      const cy = f.place_y + f.place_height / 2;
      minX = Math.min(minX, cx - bw / 2);
      minY = Math.min(minY, cy - bh / 2);
      maxX = Math.max(maxX, cx + bw / 2);
      maxY = Math.max(maxY, cy + bh / 2);
    }
    bbox = { x: minX * currentRenderScale, y: minY * currentRenderScale, width: (maxX - minX) * currentRenderScale, height: (maxY - minY) * currentRenderScale };
  } else {
    bbox = { x: 0, y: 0, width: COMPOSITE_BLANK_CANVAS_PT.width * currentRenderScale, height: COMPOSITE_BLANK_CANVAS_PT.height * currentRenderScale };
  }

  const PAD = 1.15; // a little breathing room around the content, not panToRect's aggressive zoom-in padding
  const targetW = Math.max(bbox.width * PAD, 300);
  const targetH = Math.max(bbox.height * PAD, 300);
  const scale = Math.min(rect.width / targetW, rect.height / targetH);
  const cx = bbox.x + bbox.width / 2;
  const cy = bbox.y + bbox.height / 2;
  suppressInteractionFlag = true;
  zoomPan.state.scale = scale;
  zoomPan.state.x = rect.width / 2 - cx * scale;
  zoomPan.state.y = rect.height / 2 - cy * scale;
  zoomPan.apply();
  suppressInteractionFlag = false;
  userHasZoomedOrPanned = false;
}

async function exitEditLayoutMode() {
  editLayoutMode = false;
  selectedFragmentId = null;
  fragmentDrag = null;
  fragmentRotateDrag = null;
  fragmentClickCycle = null;
  const btn = document.getElementById('edit-layout-btn');
  if (btn) {
    btn.classList.remove('active');
    btn.textContent = 'Edit Layout';
  }
  for (const id of ['section-markup', 'section-measure', 'section-takeoffs']) {
    const el = document.getElementById(id);
    if (el) el.style.display = '';
  }
  const compositeSection = document.getElementById('section-composite');
  if (compositeSection) compositeSection.style.display = 'none';
  document.getElementById('markup-svg').classList.remove('composite-edit-active');
  renderCompositeFragmentsOverlay();

  // Every mutation during this session ran with ?regenerate=0 - skipping the
  // expensive re-flatten + PDF.js re-render for instant feedback (see
  // commitFragmentTransform/patchFragment/deleteFragment/
  // openBringInFragmentFlow) - so the actual viewer/take-off-facing PDF is
  // still showing whatever it was BEFORE this session started. Catch it up
  // now, exactly once, regardless of how many edits happened.
  if (compositeNeedsRefreshOnExit) {
    compositeNeedsRefreshOnExit = false;
    const statusEl = document.getElementById('pdf-status');
    const prevStatus = statusEl ? statusEl.textContent : '';
    if (statusEl) statusEl.textContent = 'Updating composite...';
    try {
      await finalizeCompositeLayout();
    } catch (err) {
      showToast(`Failed to refresh composite: ${err.message}`, 'error');
      if (statusEl) statusEl.textContent = prevStatus;
    }
  } else {
    // Nothing changed this session, so finalizeCompositeLayout (which would
    // otherwise re-render the real PDF and naturally re-fit the view) never
    // ran - fitEditLayoutView left zoomPan framing just the fragments'
    // bounding box rather than the whole page, so restore the normal
    // whole-page fit by hand.
    fitToView();
  }
}

// The one eager regenerate a whole Edit Layout session actually needs -
// every individual mutation during the session skipped this (see
// shouldRegenerate in compositeFragments.routes.js) for instant feedback, so
// nothing server-side has re-flattened the composite yet. Triggers that
// flatten, then loads and displays whatever version it produced - same
// "fetch sheet, show its current_version_id" shape as refreshCompositeSheet,
// just preceded by the regenerate call that shape assumed had already
// happened per-edit before this deferred-regenerate design.
async function finalizeCompositeLayout() {
  await api('POST', `/api/projects/${projectId}/sheets/${sheetId}/composite-fragments/regenerate`);
  await refreshCompositeSheet();
}

async function loadCompositeFragments() {
  try {
    const { fragments } = await api('GET', `/api/projects/${projectId}/sheets/${sheetId}/composite-fragments`);
    compositeFragments = fragments;
  } catch (err) {
    showToast(`Failed to load fragments: ${err.message}`, 'error');
    compositeFragments = [];
  }
  renderFragmentList();
  renderCompositeFragmentsOverlay();
}

// Re-fetches the composite sheet + its (single, ever-replaced) version after
// any fragment mutation, so allVersions/currentSheet stay in sync with the
// fresh sheet_versions row the server just created, then shows it via the
// same showVersion() path manual version-switching already uses - no new
// rendering code needed on the "display the result" side.
async function refreshCompositeSheet() {
  const { sheet, versions } = await api('GET', `/api/projects/${projectId}/sheets/${sheetId}`);
  currentSheet = sheet;
  allVersions = versions;
  await showVersion(sheet.current_version_id);
  // renderPdf (inside showVersion) may have just changed currentRenderScale
  // (a different-sized flattened page renders at a different point->pixel
  // ratio) - re-run the overlay so its rects use the current ratio, not
  // whatever was current when loadCompositeFragments last drew it.
  renderCompositeFragmentsOverlay();
}

function ensureCompositeFragmentsLayer() {
  const svg = document.getElementById('markup-svg');
  let g = svg.querySelector('#composite-fragments-layer');
  if (!g) {
    g = measureSvgNs('g');
    g.id = 'composite-fragments-layer';
    svg.appendChild(g);
  }
  return g;
}

// Fragment place_x/y/width/height are stored in the composite's own PDF-
// point space (same convention as the flattened page itself) - the render
// pixel / viewBox space getMeasureSvgPoint() and every overlay layer already
// work in is that times currentRenderScale, exactly the same relationship
// pixelsToFeet() already divides out for take-off geometry.
function fragmentRectPx(fragment) {
  return {
    x: fragment.place_x * currentRenderScale,
    y: fragment.place_y * currentRenderScale,
    width: fragment.place_width * currentRenderScale,
    height: fragment.place_height * currentRenderScale,
  };
}

function fragmentPreviewUrl(fragment) {
  return `/api/projects/${projectId}/sheets/${sheetId}/composite-fragments/${fragment.id}/preview`;
}

function normalizeRotationDegrees(deg) {
  return ((deg % 360) + 360) % 360;
}

// Screen px (compensated by zoom below) the rotate handle sits above the
// selected fragment's own top edge.
const ROTATE_HANDLE_OFFSET_PX = 30;

// Renders every visible fragment as an actual positioned/rotated <image>
// (its own full-res preview asset - see fragmentPreviewUrl), not just an
// outline - this is what makes dragging/rotating feel instant (see
// setupCompositeLayoutInteraction): the browser repositions/retransforms an
// already-loaded image on every mousemove, zero server round-trip, same
// live feel as the version-overlay comparison tool. Called on every
// mousemove during a drag/rotate, so this stays cheap - a handful of SVG
// attribute writes, no network activity.
// Mirrors compositePipeline.js's computeCanvasSize exactly (fixed origin,
// same margin/floor) so the white "page" drawn behind the fragments below
// always matches what the next flatten will actually produce - otherwise
// the overflow-visible workspace (see the composite-edit-active comment
// above) would show fragments sitting on the bare grey wrap background
// past whatever the last real flatten's page size happened to be, instead
// of looking like part of the page they're about to become.
const COMPOSITE_CANVAS_MARGIN_PT = 36;
function computeLiveCompositeCanvasSizePt() {
  let maxX = 0;
  let maxY = 0;
  for (const f of compositeFragments) {
    const rad = ((f.rotation || 0) * Math.PI) / 180;
    const bw = Math.abs(f.place_width * Math.cos(rad)) + Math.abs(f.place_height * Math.sin(rad));
    const bh = Math.abs(f.place_width * Math.sin(rad)) + Math.abs(f.place_height * Math.cos(rad));
    const cx = f.place_x + f.place_width / 2;
    const cy = f.place_y + f.place_height / 2;
    maxX = Math.max(maxX, cx + bw / 2);
    maxY = Math.max(maxY, cy + bh / 2);
  }
  return {
    width: Math.max(COMPOSITE_BLANK_CANVAS_PT.width, maxX + COMPOSITE_CANVAS_MARGIN_PT),
    height: Math.max(COMPOSITE_BLANK_CANVAS_PT.height, maxY + COMPOSITE_CANVAS_MARGIN_PT),
  };
}

function renderCompositeFragmentsOverlay() {
  const g = ensureCompositeFragmentsLayer();
  g.innerHTML = '';
  if (!editLayoutMode) return;
  const scale = zoomPan ? zoomPan.state.scale : 1;

  const pageSizePt = computeLiveCompositeCanvasSizePt();
  const pageBg = measureSvgNs('rect');
  pageBg.setAttribute('x', 0);
  pageBg.setAttribute('y', 0);
  pageBg.setAttribute('width', pageSizePt.width * currentRenderScale);
  pageBg.setAttribute('height', pageSizePt.height * currentRenderScale);
  pageBg.setAttribute('fill', '#ffffff');
  g.appendChild(pageBg);

  // Higher z_order drawn last (on top), matching compose.py's own paint
  // order - what you see selected here is what's actually on top visually.
  const sorted = [...compositeFragments].sort((a, b) => a.z_order - b.z_order);
  for (const fragment of sorted) {
    if (!fragment.visible) continue;
    const r = fragmentRectPx(fragment);
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const isSelected = fragment.id === selectedFragmentId;
    const rotation = fragment.rotation || 0;

    // One group per fragment sharing a single rotate transform - SVG's own
    // rotate(deg, cx, cy) is clockwise-positive around (cx,cy) in this
    // y-down coordinate space, exactly the convention compose.py's
    // rotate_fragment() and the drag-to-rotate math below both use, so
    // nothing needs re-deriving here.
    const group = measureSvgNs('g');
    group.setAttribute('transform', `rotate(${rotation} ${cx} ${cy})`);

    const image = measureSvgNs('image');
    image.setAttribute('x', r.x);
    image.setAttribute('y', r.y);
    image.setAttribute('width', r.width);
    image.setAttribute('height', r.height);
    // Stretch to exactly fill the place rect - the preview asset's own
    // pixel aspect ratio matches crop_width/height, which can differ
    // slightly from place_width/height after independent scale-reconcile
    // rounding; compose.py itself resizes the same way, so this matches.
    image.setAttribute('preserveAspectRatio', 'none');
    image.setAttribute('href', fragmentPreviewUrl(fragment));
    image.setAttributeNS('http://www.w3.org/1999/xlink', 'href', fragmentPreviewUrl(fragment));
    if (fragment.locked) image.style.opacity = '0.85';
    group.appendChild(image);

    const outline = measureSvgNs('rect');
    outline.setAttribute('x', r.x);
    outline.setAttribute('y', r.y);
    outline.setAttribute('width', r.width);
    outline.setAttribute('height', r.height);
    outline.setAttribute('fill', 'none');
    outline.setAttribute('stroke', isSelected ? '#2563eb' : 'rgba(37,99,235,0.4)');
    outline.setAttribute('stroke-width', (isSelected ? 2.5 : 1) / scale);
    if (fragment.locked) outline.setAttribute('stroke-dasharray', `${4 / scale} ${4 / scale}`);
    group.appendChild(outline);

    if (isSelected && !fragment.locked) {
      // Capped relative to the fragment's own on-screen height - a fixed
      // screen-px offset compensated by 1/scale alone would place the
      // handle absurdly far above (even off-canvas) at a heavily zoomed-out
      // view, e.g. right after fitToView() fits an entire multi-fragment
      // composite into the viewport at once.
      const handleOffset = Math.min(ROTATE_HANDLE_OFFSET_PX / scale, r.height * 0.4 + 10 / scale);
      const handleLine = measureSvgNs('line');
      handleLine.setAttribute('x1', cx);
      handleLine.setAttribute('y1', r.y);
      handleLine.setAttribute('x2', cx);
      handleLine.setAttribute('y2', r.y - handleOffset);
      handleLine.setAttribute('stroke', '#2563eb');
      handleLine.setAttribute('stroke-width', 1.5 / scale);
      group.appendChild(handleLine);

      const handle = measureSvgNs('circle');
      handle.setAttribute('cx', cx);
      handle.setAttribute('cy', r.y - handleOffset);
      handle.setAttribute('r', 7 / scale);
      handle.setAttribute('fill', '#2563eb');
      handle.setAttribute('stroke', '#fff');
      handle.setAttribute('stroke-width', 1.5 / scale);
      handle.style.cursor = 'grab';
      handle.dataset.role = 'rotate-handle';
      handle.dataset.fragmentId = String(fragment.id);
      group.appendChild(handle);
    }

    g.appendChild(group);
  }
}

function renderFragmentList() {
  const list = document.getElementById('fragment-list');
  if (!list) return;
  if (compositeFragments.length === 0) {
    list.innerHTML = '<p class="muted">No fragments yet - bring one in above.</p>';
    return;
  }
  const sorted = [...compositeFragments].sort((a, b) => b.z_order - a.z_order); // top-of-stack first in the list
  list.innerHTML = '';
  for (const fragment of sorted) {
    const row = document.createElement('div');
    row.className = 'takeoff-item-row fragment-row' + (fragment.id === selectedFragmentId ? ' active' : '');
    // Two lines, not one - a single row cramming the thumbnail, sheet
    // number, rotation input, and 4 icon buttons into the pane's width
    // (280px by default, sometimes dragged narrower) left the flexible
    // name span squeezed to near zero, silently ellipsis-truncating sheet
    // numbers like "A101-C" down to just "A". Splitting the controls onto
    // their own line gives the name the full row width instead.
    row.innerHTML = `
      <div class="fragment-row-top">
        <img class="fragment-thumb" src="/api/projects/${projectId}/sheets/${sheetId}/composite-fragments/${fragment.id}/thumb" alt="">
        <span class="takeoff-item-name" title="${escapeHtml(fragment.source_sheet_number)}">${escapeHtml(fragment.source_sheet_number)}</span>
      </div>
      <div class="fragment-row-controls">
        <input type="number" class="fragment-rotation-input" data-action="rotation" step="0.1" title="Rotation, degrees clockwise"
          value="${(fragment.rotation || 0).toFixed(1)}" ${fragment.locked ? 'disabled' : ''}>
        <button type="button" class="icon-btn" data-action="lock" title="${fragment.locked ? 'Unlock' : 'Lock'}">${fragment.locked ? '&#128274;' : '&#128275;'}</button>
        <button type="button" class="icon-btn" data-action="visible" title="${fragment.visible ? 'Hide' : 'Show'}">${fragment.visible ? '&#128065;' : '&#128584;'}</button>
        <button type="button" class="icon-btn" data-action="front" title="Bring to front">&#8593;</button>
        <button type="button" class="icon-btn" data-action="back" title="Send to back">&#8595;</button>
        <button type="button" class="icon-btn" data-action="delete" title="Remove fragment">&#128465;</button>
      </div>
    `;
    row.addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.closest('input')) return;
      selectFragment(fragment.id);
    });
    const rotationInput = row.querySelector('[data-action="rotation"]');
    rotationInput.addEventListener('click', (e) => e.stopPropagation());
    rotationInput.addEventListener('change', () => {
      const deg = Number(rotationInput.value);
      if (!Number.isFinite(deg)) return;
      const normalized = normalizeRotationDegrees(deg);
      fragment.rotation = normalized;
      rotationInput.value = normalized.toFixed(1);
      renderCompositeFragmentsOverlay();
      commitFragmentTransform(fragment.id, { rotation: normalized });
    });
    row.querySelector('[data-action="lock"]').addEventListener('click', () => patchFragment(fragment.id, { locked: !fragment.locked }));
    row.querySelector('[data-action="visible"]').addEventListener('click', () => patchFragment(fragment.id, { visible: !fragment.visible }));
    row.querySelector('[data-action="front"]').addEventListener('click', () => {
      const maxZ = Math.max(...compositeFragments.map((f) => f.z_order));
      patchFragment(fragment.id, { z_order: maxZ + 1 });
    });
    row.querySelector('[data-action="back"]').addEventListener('click', () => {
      const minZ = Math.min(...compositeFragments.map((f) => f.z_order));
      patchFragment(fragment.id, { z_order: minZ - 1 });
    });
    row.querySelector('[data-action="delete"]').addEventListener('click', () => deleteFragment(fragment.id));
    list.appendChild(row);
  }
}

function selectFragment(fragmentId) {
  selectedFragmentId = fragmentId;
  renderFragmentList();
  renderCompositeFragmentsOverlay();
}

// Every fragment mutation function below passes ?regenerate=0 (see
// shouldRegenerate in compositeFragments.routes.js) and sets
// compositeNeedsRefreshOnExit instead of eagerly re-flattening - Edit Layout
// mode's live SVG-image view already shows the correct result the instant
// the local compositeFragments array + a render call updates, so there's
// nothing for the user to gain by waiting on a real PDF re-render for every
// single lock toggle, reorder, bring-in, or delete. finalizeCompositeLayout
// (called once, on exit) is what actually catches the real PDF up.
async function patchFragment(fragmentId, body) {
  try {
    const { fragment } = await api(
      'PATCH',
      `/api/projects/${projectId}/sheets/${sheetId}/composite-fragments/${fragmentId}?regenerate=0`,
      body
    );
    const idx = compositeFragments.findIndex((f) => f.id === fragmentId);
    if (idx !== -1) compositeFragments[idx] = fragment;
    compositeNeedsRefreshOnExit = true;
    renderFragmentList();
    renderCompositeFragmentsOverlay();
  } catch (err) {
    showToast(`Failed to update fragment: ${err.message}`, 'error');
  }
}

// The drag/rotate-end-specific sibling of patchFragment - functionally
// identical (see the shared comment above), kept separate mainly because its
// callers already have the fragment's new place/rotation computed locally
// and don't need a full loadCompositeFragments() round-trip to know it.
async function commitFragmentTransform(fragmentId, body) {
  try {
    const { fragment } = await api(
      'PATCH',
      `/api/projects/${projectId}/sheets/${sheetId}/composite-fragments/${fragmentId}?regenerate=0`,
      body
    );
    const idx = compositeFragments.findIndex((f) => f.id === fragmentId);
    if (idx !== -1) compositeFragments[idx] = fragment;
    compositeNeedsRefreshOnExit = true;
    renderFragmentList();
    renderCompositeFragmentsOverlay();
  } catch (err) {
    showToast(`Failed to update fragment: ${err.message}`, 'error');
    await loadCompositeFragments(); // snap back to the server's last-known layout
  }
}

async function deleteFragment(fragmentId) {
  const ok = await confirmModal({
    title: 'Remove this fragment?',
    message: 'It will be removed from the composite drawing. This does not affect the source sheet it was cropped from.',
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('DELETE', `/api/projects/${projectId}/sheets/${sheetId}/composite-fragments/${fragmentId}?regenerate=0`);
    if (selectedFragmentId === fragmentId) selectedFragmentId = null;
    compositeFragments = compositeFragments.filter((f) => f.id !== fragmentId);
    compositeNeedsRefreshOnExit = true;
    renderFragmentList();
    renderCompositeFragmentsOverlay();
  } catch (err) {
    showToast(`Failed to remove fragment: ${err.message}`, 'error');
  }
}

async function openBringInFragmentFlow() {
  const result = await openFragmentPicker(projectId, currentSheet.scale_feet_per_inch);
  if (!result) return;
  // Drop the new fragment just outside whatever's already placed, along the
  // same fixed-origin/grows-only convention the canvas itself uses - the
  // user drags it into its real position afterward.
  let offsetY = 0;
  for (const f of compositeFragments) {
    offsetY = Math.max(offsetY, f.place_y + f.place_height);
  }
  result.place.x = 0;
  result.place.y = offsetY > 0 ? offsetY + 20 : 0;
  try {
    await api('POST', `/api/projects/${projectId}/sheets/${sheetId}/composite-fragments?regenerate=0`, result);
    await loadCompositeFragments(); // a brand-new fragment needs its full row (thumb/preview paths etc.) from the server, unlike the other mutations above
    compositeNeedsRefreshOnExit = true;
    showToast('Fragment brought in.', 'success');
  } catch (err) {
    showToast(`Failed to bring in fragment: ${err.message}`, 'error');
  }
}

// Click-to-select-topmost (by z_order) with click-again-to-cycle-down
// through whatever else overlaps the same point, drag-to-reposition a
// selected/unlocked fragment, and drag-the-rotate-handle to spin it around
// its own center at an arbitrary angle. Registered once at init; internally
// gated on editLayoutMode so it's inert the rest of the time (see the
// module-level comment above editLayoutMode).
function setupCompositeLayoutInteraction() {
  const svg = document.getElementById('markup-svg');

  // Inverse-rotates pdfPt back into each fragment's own unrotated local
  // space before the plain bbox test - a rotated fragment's actual visual
  // footprint isn't its axis-aligned place rect, so hit-testing against
  // that directly would miss/false-hit near rotated corners.
  function fragmentsAt(pdfPt) {
    return compositeFragments
      .filter((f) => {
        if (!f.visible) return false;
        const cx = f.place_x + f.place_width / 2;
        const cy = f.place_y + f.place_height / 2;
        const rad = ((f.rotation || 0) * Math.PI) / 180;
        const dx = pdfPt.x - cx;
        const dy = pdfPt.y - cy;
        const localX = dx * Math.cos(rad) + dy * Math.sin(rad) + cx;
        const localY = -dx * Math.sin(rad) + dy * Math.cos(rad) + cy;
        return localX >= f.place_x && localX <= f.place_x + f.place_width && localY >= f.place_y && localY <= f.place_y + f.place_height;
      })
      .sort((a, b) => b.z_order - a.z_order);
  }

  // Angle (degrees, clockwise-positive from straight up) of `pt` around
  // `centerPt`, both in render-px space - matches SVG's own rotate(deg)
  // convention exactly (see renderCompositeFragmentsOverlay's comment), so
  // this can be written straight into a fragment's rotation with no sign
  // flip anywhere in the round trip from drag to render to compose.py.
  function angleFromCenter(centerPt, pt) {
    const dx = pt.x - centerPt.x;
    const dy = pt.y - centerPt.y;
    return Math.atan2(dx, -dy) * (180 / Math.PI);
  }

  svg.addEventListener(
    'mousedown',
    (e) => {
      if (!editLayoutMode || e.button !== 0) return;

      const handleEl = e.target.closest && e.target.closest('[data-role="rotate-handle"]');
      if (handleEl) {
        const fragment = compositeFragments.find((f) => f.id === Number(handleEl.dataset.fragmentId));
        if (!fragment || fragment.locked) return;
        const r = fragmentRectPx(fragment);
        const centerPt = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        const renderPt = getMeasureSvgPoint(e);
        fragmentRotateDrag = {
          fragmentId: fragment.id,
          centerPt,
          lastAngle: angleFromCenter(centerPt, renderPt),
        };
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      const renderPt = getMeasureSvgPoint(e);
      const pdfPt = { x: renderPt.x / currentRenderScale, y: renderPt.y / currentRenderScale };
      const hits = fragmentsAt(pdfPt);

      if (hits.length === 0) {
        selectedFragmentId = null;
        fragmentClickCycle = null;
        renderFragmentList();
        renderCompositeFragmentsOverlay();
        return;
      }

      let target;
      const sameSpot =
        fragmentClickCycle && Math.hypot(fragmentClickCycle.x - pdfPt.x, fragmentClickCycle.y - pdfPt.y) < 4 / currentRenderScale;
      if (sameSpot && hits.some((f) => f.id === fragmentClickCycle.ids[fragmentClickCycle.index])) {
        fragmentClickCycle.index = (fragmentClickCycle.index + 1) % fragmentClickCycle.ids.length;
        target = hits.find((f) => f.id === fragmentClickCycle.ids[fragmentClickCycle.index]);
      } else {
        fragmentClickCycle = { x: pdfPt.x, y: pdfPt.y, ids: hits.map((f) => f.id), index: 0 };
        target = hits[0];
      }
      selectedFragmentId = target.id;
      renderFragmentList();
      renderCompositeFragmentsOverlay();

      if (target.locked) return; // selectable, just not draggable
      fragmentDrag = { fragmentId: target.id, lastPt: renderPt };
      e.preventDefault();
    },
    true
  );

  svg.addEventListener('mousemove', (e) => {
    if (!editLayoutMode) return;
    if (fragmentRotateDrag) {
      const renderPt = getMeasureSvgPoint(e);
      const angle = angleFromCenter(fragmentRotateDrag.centerPt, renderPt);
      // Incremental (from the PREVIOUS mousemove's angle, not the drag's
      // start angle) - same reasoning as the position drag above: it's what
      // lets the Shift fine-factor change moment to moment with no jump,
      // and as a side effect also makes a full-circle drag accumulate
      // correctly instead of the old raw start-to-now angle difference
      // silently wrapping at +/-180.
      let delta = angle - fragmentRotateDrag.lastAngle;
      delta = ((delta + 180) % 360 + 360) % 360 - 180; // normalize into (-180, 180]
      fragmentRotateDrag.lastAngle = angle;
      const fragment = compositeFragments.find((f) => f.id === fragmentRotateDrag.fragmentId);
      if (!fragment) return;
      const fineFactor = e.shiftKey ? 0.1 : 1; // Shift = fine adjustment, 1/10th speed
      fragment.rotation = normalizeRotationDegrees((fragment.rotation || 0) + delta * fineFactor);
      renderCompositeFragmentsOverlay();
      renderFragmentList(); // keeps the numeric rotation input live in sync while dragging
      return;
    }
    if (!fragmentDrag) return;
    const renderPt = getMeasureSvgPoint(e);
    // Incremental (from the PREVIOUS mousemove, not the drag's start point)
    // so the fine-drag factor below can change moment to moment - toggling
    // Shift mid-drag just changes how much the next bit of mouse movement
    // is worth, with no retroactive jump from rescaling the whole drag's
    // total delta the instant the key state changes.
    const dxPt = (renderPt.x - fragmentDrag.lastPt.x) / currentRenderScale;
    const dyPt = (renderPt.y - fragmentDrag.lastPt.y) / currentRenderScale;
    fragmentDrag.lastPt = renderPt;
    const fragment = compositeFragments.find((f) => f.id === fragmentDrag.fragmentId);
    if (!fragment) return;
    const fineFactor = e.shiftKey ? 0.1 : 1; // Shift = fine adjustment, 1/10th speed
    fragment.place_x = Math.max(0, fragment.place_x + dxPt * fineFactor);
    fragment.place_y = Math.max(0, fragment.place_y + dyPt * fineFactor);
    renderCompositeFragmentsOverlay();
  });

  document.addEventListener('mouseup', async () => {
    if (fragmentRotateDrag) {
      const { fragmentId } = fragmentRotateDrag;
      fragmentRotateDrag = null;
      const fragment = compositeFragments.find((f) => f.id === fragmentId);
      if (fragment) await commitFragmentTransform(fragmentId, { rotation: fragment.rotation });
      return;
    }
    if (!fragmentDrag) return;
    const { fragmentId } = fragmentDrag;
    fragmentDrag = null;
    const fragment = compositeFragments.find((f) => f.id === fragmentId);
    if (!fragment) return;
    await commitFragmentTransform(fragmentId, {
      place: { x: fragment.place_x, y: fragment.place_y, width: fragment.place_width, height: fragment.place_height },
    });
  });
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
  // Separate from currentRenderTask (which means "a NEWER render superseded
  // this one") - this means "we gave up waiting on THIS one specifically",
  // via the timeout race below. Kept distinct so an abandoned attempt that
  // does eventually resolve knows not to paint stale content over whatever
  // the timeout's own error message put on screen, without that check ALSO
  // suppressing the timeout error itself in the catch block.
  let timedOut = false;
  try {
    await Promise.race([
      renderPdfAttempt(versionId, renderToken, () => timedOut, canvas, ctx, statusEl),
      new Promise((_, reject) =>
        setTimeout(() => {
          timedOut = true;
          // A PDF.js load/render that neither resolves nor rejects (as
          // opposed to throwing, which the catch below already handled)
          // used to leave the page stuck on "Loading..." forever with no
          // way out - seen specifically on an iOS home-screen (Add to Home
          // Screen) launch, where a background rendering worker can fail
          // to start without the main thread ever hearing back at all.
          // Working theory, not confirmed - this makes the failure visible
          // and recoverable either way instead of an invisible stall.
          reject(new Error('Timed out loading the PDF after 30s.'));
        }, 30000)
      ),
    ]);
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

// Paints the pre-generated preview WebP (burst.py, generated once at
// upload/publish time) as an instant placeholder before the real PDF.js
// vector render starts. Most sheets render fast enough that this never even
// gets to paint before the real render supersedes it, but some sheets -
// seen on a civil sheet with dense hatch/dash linetypes exploded into tens
// of thousands of individual line segments by the CAD plot driver - hand
// PDF.js an operator list so long it has to time-slice execution across
// frames, which visibly paints in over several seconds ("prints" line by
// line) instead of popping in at once. Only checks the LOCAL cache (never
// fetches over the network): the point is a synchronous-ish local read that
// beats the real render to the screen, and per CLAUDE.md's offline design
// the sheets a field user is actually looking at are the ones already
// synced locally anyway - a network fetch here would just add a serial
// round trip ahead of the real PDF fetch for a sheet that has nothing to
// show locally regardless.
// Returns true if it actually painted a placeholder (canvas now holds THIS
// sheet's preview, at the preview's pixel dimensions) so the caller can
// later rescale the view onto the final render instead of blindly resetting
// it - see the comment above the rescale step in renderPdfAttempt.
async function paintCachedPreviewPlaceholder(versionId, renderToken, isTimedOut, canvas, ctx, statusEl) {
  const cachedPreview = await getCachedAsset(versionId, 'preview');
  if (!cachedPreview || isTimedOut() || currentRenderTask !== renderToken) return false;
  let previewUrl;
  try {
    previewUrl = URL.createObjectURL(cachedPreview);
    const img = await loadImage(previewUrl);
    if (isTimedOut() || currentRenderTask !== renderToken) return false; // superseded while the placeholder itself was decoding
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    ctx.drawImage(img, 0, 0);
    statusEl.textContent = 'Loading full detail...';
    userHasZoomedOrPanned = false;
    fitToView();
    return true;
  } catch {
    // Best-effort only - the real render below is what actually matters.
    return false;
  } finally {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }
}

async function renderPdfAttempt(versionId, renderToken, isTimedOut, canvas, ctx, statusEl) {
  const placeholderShown = await paintCachedPreviewPlaceholder(versionId, renderToken, isTimedOut, canvas, ctx, statusEl);
  const cachedFile = await getCachedAsset(versionId, 'pdf');
  const source = cachedFile
    ? { data: await cachedFile.arrayBuffer() }
    : { url: `/api/sheet-versions/${versionId}/pdf` };
  const loadingTask = pdfjsLib.getDocument(source);
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(1);
  if (isTimedOut() || currentRenderTask !== renderToken) return; // gave up waiting, or superseded while loading

  const unitViewport = page.getViewport({ scale: 1 });
  const longestPt = Math.max(unitViewport.width, unitViewport.height);
  const maxRenderPx = currentSheet && currentSheet.is_composite ? MAX_RENDER_PX_COMPOSITE : MAX_RENDER_PX;
  currentRenderScale = Math.min(RENDER_SCALE, maxRenderPx / longestPt);
  const viewport = page.getViewport({ scale: currentRenderScale });

  // Render into an offscreen canvas rather than the visible one. This is
  // the same canvas paintCachedPreviewPlaceholder just painted the instant
  // placeholder onto - resizing/drawing into it directly would wipe that
  // placeholder the moment rendering starts (a canvas resize clears its
  // content) and replace it with PDF.js's own slow incremental paint,
  // which is exactly the thing the placeholder exists to hide. Keeping the
  // work off the visible canvas means the placeholder stays up, unbroken,
  // until the real image is fully ready to swap in in one atomic step.
  const offscreen = document.createElement('canvas');
  offscreen.width = viewport.width;
  offscreen.height = viewport.height;
  const offscreenCtx = offscreen.getContext('2d');
  offscreenCtx.imageSmoothingEnabled = true;
  offscreenCtx.imageSmoothingQuality = 'high';
  await page.render({ canvasContext: offscreenCtx, viewport }).promise;
  if (isTimedOut() || currentRenderTask !== renderToken) return; // gave up waiting, or superseded while rendering

  // Capture the placeholder's view before resizing the canvas out from
  // under it - a canvas resize also resets its CSS layout box, and
  // zoomPan's scale/x/y are expressed against THAT box (see zoomPan.js's
  // fitToView), so swapping to a higher-res canvas without correcting for
  // it would suddenly blow the view up by the resolution ratio. Only valid
  // when a placeholder was actually painted for this sheet this pass -
  // otherwise canvas.width still reflects the previous sheet (or nothing),
  // and the ordinary reset-to-fit below is correct instead.
  const priorScale = zoomPan ? zoomPan.state.scale : null;
  const priorX = zoomPan ? zoomPan.state.x : null;
  const priorY = zoomPan ? zoomPan.state.y : null;
  const priorWidth = canvas.width;

  canvas.width = viewport.width;
  canvas.height = viewport.height;
  ctx.drawImage(offscreen, 0, 0);

  currentPdfPage = page;
  currentViewport = viewport;
  statusEl.textContent = cachedFile ? '(from local cache)' : '';
  syncSheetLinkLayer();
  loadSheetLinks(versionId);
  drawSearchHighlights(activeSearchTerm);
  if (canTakeoff) loadSheetTakeoffInstances();
  if (markupsController) markupsController.resync();

  if (placeholderShown && zoomPan && priorWidth) {
    // Same page, just a higher-resolution canvas - rescale the existing
    // transform by the resolution ratio instead of re-fitting, so whatever
    // the user was looking at (including the default fit-to-view the
    // placeholder itself set up) lands in the exact same screen position
    // rather than snapping back to centered/reset.
    const resolutionRatio = viewport.width / priorWidth;
    zoomPan.state.scale = priorScale / resolutionRatio;
    zoomPan.state.x = priorX;
    zoomPan.state.y = priorY;
    suppressInteractionFlag = true;
    zoomPan.apply();
    suppressInteractionFlag = false;
    if (markupsController) markupsController.repositionPopup();
  } else {
    userHasZoomedOrPanned = false;
    fitToView();
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
  // Keep links in the same SVG as markups/measure/take-offs so they can
  // actually receive pointer events, but always on TOP of that geometry -
  // a take-off drawn over a link used to sit above it in z-order and both
  // visually cover it and steal its clicks, even though only the hotspot
  // rects themselves have pointer-events enabled (style.css) so this can't
  // shadow clicks meant for a tool anywhere except right on top of a link.
  // appendChild moves an already-present node rather than duplicating it,
  // so re-asserting this on every render keeps it last (topmost) even as
  // other layers get created after it.
  if (svg.lastChild !== layer) svg.appendChild(layer);
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
    // Right-click opens the linked sheet in a new tab instead of navigating
    // away - same window.open(sheet.html, '_blank') pattern documents.js
    // already uses for "open sheet" links, so it's the same normal sheet
    // viewer (with its own back/forward sheet-nav buttons), just in a
    // separate tab rather than replacing this one.
    hotspot.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showSheetLinkContextMenu(e.clientX, e.clientY, link.target_sheet_id);
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

// ---------- Forward/back through the grid's filtered/searched sheet order ----------
// Distinct from shell.js's visit-history back button (browser-style "where
// I've been") - this steps through whatever order the grid was last filtered
// to, written by viewer.js's renderGrid() into localStorage.
function filteredOrderKey() {
  return `hammgrid-filtered-order:${projectId}`;
}

function setupSheetNavButtons() {
  const backBtn = document.getElementById('sheet-nav-back-btn');
  const forwardBtn = document.getElementById('sheet-nav-forward-btn');
  let order = [];
  try {
    order = JSON.parse(localStorage.getItem(filteredOrderKey())) || [];
  } catch (err) {
    order = [];
  }
  const idx = order.findIndex((id) => String(id) === String(sheetId));
  if (idx === -1) {
    backBtn.disabled = true;
    forwardBtn.disabled = true;
    return;
  }
  backBtn.disabled = idx <= 0;
  forwardBtn.disabled = idx >= order.length - 1;
  backBtn.addEventListener('click', () => {
    if (idx > 0) window.location.href = `/sheet.html?projectId=${encodeURIComponent(projectId)}&sheetId=${encodeURIComponent(order[idx - 1])}`;
  });
  forwardBtn.addEventListener('click', () => {
    if (idx < order.length - 1) window.location.href = `/sheet.html?projectId=${encodeURIComponent(projectId)}&sheetId=${encodeURIComponent(order[idx + 1])}`;
  });
}

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
let scaleZones = []; // this sheet's scale zones - {id, label, scale_feet_per_inch, x, y, width, height}
// Armed while a zone's box is mid-draw (2-click opposite-corners, same
// interaction as take-off box mode) - { zoneId, label, scaleFeetPerInch, firstCorner }.
// zoneId is null for a brand-new zone, set when redrawing an existing one's box.
let scaleZoneDraft = null;

// ---------- Take-offs (permission-gated extension of measure) ----------
let takeoffTool = null; // null | 'linear' | 'perimeter' | 'area'
let takeoffPoints = [];
let takeoffItems = []; // project-wide: {id, name, type, color, total_quantity, instance_count}
let sheetTakeoffInstances = []; // this sheet's instances, flat with item_name/item_color/item_type joined in
// Assemblies map a box take-off's 5 slots (area + top/bottom/left/right
// edges) to real take-off items - drawing one box creates one instance per
// linked slot, all ordinary rows on ordinary items (see submitAssemblyInstances).
// Purely a sheet.js authoring-time orchestrator - never touches reporting.
let takeoffAssemblies = []; // project-wide: {id, name, area_label, ..., area_item_id, top_item_id, bottom_item_id, left_item_id, right_item_id}
let activeAssemblyId = null; // armed for box placement (takeoffTool === 'assembly-box') - see activateAssembly
let selectedAssemblyId = null; // selected-but-not-armed, mirrors selectedTakeoffItemId
let takeoffAssemblyTemplatesCache = null; // fetch-once, mirrors takeoffTemplatesCache
let activeTakeoffItemId = null;
// A plain click on a pane row only selects it (highlights the row, shows the
// bottom bar with a Start button) - same as clicking a placed take-off shape
// on the drawing only enters edit mode rather than re-arming placement. It
// does NOT arm the placement tool; that's what activateTakeoffItemId means
// (via activeTakeoffItemId/takeoffTool). Double-clicking the row, or the
// row's own Activate button, or the bottom bar's Start button, arms it.
let selectedTakeoffItemId = null;
// Shift+click in the pane adds same-type items to this set alongside the
// primary (activeTakeoffItemId) - one traced shape then POSTs an identical
// instance (same geometry/quantity) to every item in the combined set. Lets
// several perimeter-derived items with different formulas/multipliers share
// one trace instead of retracing the same boundary once per item. Reset to
// empty any time activeTakeoffItemId is (re)armed fresh - see
// activateTakeoffItem, continueTakeoffInstance, subtractFromTakeoffInstance,
// deactivateTakeoff, armNewlyCreatedTakeoffItem.
let multiSelectExtraItemIds = new Set();
// Like multiSelectExtraItemIds, but for assemblies - only meaningful while
// subtractingIntoInstanceId is set (see toggleMultiSelectExtraAssembly):
// shift+click an assembly row while subtracting also places that assembly's
// linked slots using the same box the subtraction hole traces, so "carve
// this window out of the wall" and "count this window assembly" happen from
// one trace. An assembly's slots are only meaningful as real left/top/right/
// bottom edges, so this is gated on Box placement mode - same as assembly
// placement itself, which is always box-only. Reset alongside
// multiSelectExtraItemIds everywhere a placement session (re)starts fresh.
let multiSelectExtraAssemblyIds = new Set();
let lastPlacedInstanceId = null; // most recent instance posted for the active item on this sheet - used by Backspace on count items
let continuingInstanceId = null; // set by "Continue Item" - finishing the draft PATCHes this instance instead of POSTing a new one
// How many points takeoffPoints was seeded with when "Continue Item" started -
// the click-near-last-point auto-finish below must not fire until at least
// one point has been added PAST this seed, otherwise a continuation click
// landing anywhere near the original shape's endpoint (an extremely likely
// place to click, since you're extending *from* there) silently finishes the
// draft as a no-op and the next click starts an unwanted brand-new instance
// right next to the one you meant to extend.
let continuingSeedPointCount = 0;
let subtractingIntoInstanceId = null; // set by "Subtract Area" - finishing the draft appends a hole to this instance instead of POSTing/continuing
let takeoffPlacementMode = 'points'; // 'points' | 'box' - box mode is a 2-click rectangle shortcut for area placement/subtraction
let axisLockPinned = false; // when true, angle-snap is on by default and Shift temporarily *disables* it (inverted from the normal hold-to-snap)
let takeoffSearchTerm = ''; // filters the pane's item list - a job can easily have hundreds of items
let snapToPointsEnabled = false; // bottom toolbar toggle - snaps placement to nearby existing points, screen-distance based

// Per-sheet visual hide - purely a "declutter the drawing while I work"
// toggle, not a delete. Keyed by item id since the same item can appear on
// many sheets but this preference is local to the one you're looking at.
let hiddenTakeoffItemIds = new Set();
function takeoffHiddenStorageKey() {
  return `hammgrid-hidden-takeoffs:${projectId}:${sheetId}`;
}
function loadHiddenTakeoffItemIds() {
  try {
    hiddenTakeoffItemIds = new Set(JSON.parse(localStorage.getItem(takeoffHiddenStorageKey())) || []);
  } catch (err) {
    hiddenTakeoffItemIds = new Set();
  }
}
function saveHiddenTakeoffItemIds() {
  localStorage.setItem(takeoffHiddenStorageKey(), JSON.stringify([...hiddenTakeoffItemIds]));
}
function toggleHideTakeoffItem(item) {
  if (hiddenTakeoffItemIds.has(item.id)) hiddenTakeoffItemIds.delete(item.id);
  else hiddenTakeoffItemIds.add(item.id);
  saveHiddenTakeoffItemIds();
  renderTakeoffInstances();
  renderTakeoffPane();
}
// Items pinned to this sheet's pane despite having zero instances placed
// here yet - covers "I created/selected this item but haven't traced
// anything with it" (a deliberate empty item meant for a later multi-select
// take-off, or just not gotten to yet), so it doesn't vanish the moment you
// Escape/Stop out of it. Populated in renderTakeoffPane (see below)
// whenever activeTakeoffItemId is set, and persisted so it survives a
// reload too.
let sheetPinnedItemIds = new Set();
function takeoffPinnedStorageKey() {
  return `hammgrid-pinned-takeoffs:${projectId}:${sheetId}`;
}
function loadPinnedTakeoffItemIds() {
  try {
    sheetPinnedItemIds = new Set(JSON.parse(localStorage.getItem(takeoffPinnedStorageKey())) || []);
  } catch (err) {
    sheetPinnedItemIds = new Set();
  }
}
function savePinnedTakeoffItemIds() {
  localStorage.setItem(takeoffPinnedStorageKey(), JSON.stringify([...sheetPinnedItemIds]));
}

// Hide-all/unhide-all only acts on items actually visible on this sheet
// right now (mirrors the pane's own "only show items placed here" filter) -
// toggling it shouldn't reach out and hide something on a completely
// different sheet that just happens to share an item.
function toggleHideAllTakeoffs() {
  const grouped = groupTakeoffInstancesByItem();
  const onThisSheet = takeoffItems.filter(
    (i) => grouped.has(i.id) || i.id === activeTakeoffItemId || i.id === selectedTakeoffItemId || sheetPinnedItemIds.has(i.id)
  );
  const allHidden = onThisSheet.length > 0 && onThisSheet.every((i) => hiddenTakeoffItemIds.has(i.id));
  for (const item of onThisSheet) {
    if (allHidden) hiddenTakeoffItemIds.delete(item.id);
    else hiddenTakeoffItemIds.add(item.id);
  }
  saveHiddenTakeoffItemIds();
  renderTakeoffInstances();
  renderTakeoffPane();
}

// Arc placement (PlanSwift-style): press "A" mid-draft to arm arc mode, then
// the next two clicks are a point the curve passes through and the curve's
// endpoint - see arcPointsThrough(). Both flags are mutually exclusive with
// each other; only one is ever truthy at a time.
let awaitingArcThrough = false; // armed by "A" - next click sets arcThroughPoint
let arcThroughPoint = null; // set once - next click is the arc's endpoint and commits the curve

// Click-to-edit state - active only while no placement tool is armed
// (takeoffTool null). editingInstance is a local working copy of whichever
// committed instance is selected; edits apply to it live and PATCH to the
// server on drop/delete, only diverging from the server copy mid-drag.
let editingInstance = null;
let editSelectedPointIndices = new Set();
let takeoffEditDrag = null; // { startPt, moved }
let takeoffMarquee = null; // { startPt, currentPt }
let takeoffLastClickPoint = null; // { index, time } - manual double-click detection for point delete
let takeoffLastClickSegment = null; // { key, time } - manual double-click detection for inserting a point on a line

// Blender-style "C" circle-select, as an alternative to the rectangle
// marquee above - useful when the points you want aren't conveniently
// rectangular (e.g. scattered along a curve). 'box' | 'brush', chosen via
// #takeoff-edit-select-group, inside the shared #takeoff-toolbar (only shown
// while editingInstance is set - see updateTakeoffToolbar).
let takeoffEditSelectMode = 'box';
let takeoffBrushRadius = 40; // screen px, not drawing-space - divided by zoom scale at use time so it feels constant regardless of zoom
let takeoffBrushStroke = null; // { touchedAny } while the mouse button is held during a brush drag
let takeoffBrushCursorPt = null; // drawing-space point, purely for drawing the circle cursor while hovering in brush mode
// True only for the untouched "everything selected" default set on entering
// edit mode (see enterTakeoffEditMode) - lets a plain point click narrow
// that blanket default down to just the one point for a quick single-point
// drag, WITHOUT also collapsing a real multi-point selection the user
// deliberately built with box/brush and then exited select mode to use
// (that one needs to survive a click on one of its own points so the whole
// group can still be dragged together). Flips to false the moment the
// selection is touched by anything other than that initial default.
let takeoffEditDefaultSelection = true;

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

// ---------- Scale zones (multiple scales per sheet) ----------
// Purely a reference overlay - light-blue box + scale text at each corner,
// pointer-events:none (see style.css), never selectable/draggable on the
// canvas. The only way to add/edit/redraw/delete one is through the
// "Multiple scales" dropdown option (see setupScaleSelect/openScaleZonesModal) -
// this layer just displays whatever loadScaleZones() last fetched.
function ensureScaleZoneLayer() {
  const svg = document.getElementById('markup-svg');
  let g = svg.querySelector('#scale-zone-layer');
  if (!g) {
    g = measureSvgNs('g');
    g.id = 'scale-zone-layer';
    svg.appendChild(g);
  }
  return g;
}

// Reuses a STANDARD_SCALES label when the value matches one exactly (same
// tolerance as setupScaleSelect's own lookup), otherwise falls back to the
// same "Custom (1"=X')" phrasing used there.
function scaleLabelFor(feetPerInch) {
  const match = STANDARD_SCALES.find((s) => Math.abs(s.feetPerInch - feetPerInch) < 0.0001);
  return match ? match.label : `1"=${feetPerInch}'`;
}

function renderScaleZoneOverlay() {
  const layer = ensureScaleZoneLayer();
  layer.innerHTML = '';
  const scale = zoomPan ? zoomPan.state.scale : 1;
  for (const zone of scaleZones) {
    const rect = measureSvgNs('rect');
    rect.setAttribute('x', zone.x);
    rect.setAttribute('y', zone.y);
    rect.setAttribute('width', zone.width);
    rect.setAttribute('height', zone.height);
    rect.setAttribute('fill', 'rgba(56, 189, 248, 0.10)');
    rect.setAttribute('stroke', '#38bdf8');
    rect.setAttribute('stroke-width', 2 / scale);
    rect.setAttribute('stroke-dasharray', `${6 / scale} ${4 / scale}`);
    layer.appendChild(rect);

    const label = scaleLabelFor(zone.scale_feet_per_inch);
    const fontSize = 12 / scale;
    const pad = 6 / scale;
    const corners = [
      { x: zone.x + pad, y: zone.y + pad + fontSize, anchor: 'start' },
      { x: zone.x + zone.width - pad, y: zone.y + pad + fontSize, anchor: 'end' },
      { x: zone.x + pad, y: zone.y + zone.height - pad, anchor: 'start' },
      { x: zone.x + zone.width - pad, y: zone.y + zone.height - pad, anchor: 'end' },
    ];
    for (const c of corners) {
      const text = measureSvgNs('text');
      text.setAttribute('x', c.x);
      text.setAttribute('y', c.y);
      text.setAttribute('text-anchor', c.anchor);
      text.setAttribute('font-size', fontSize);
      text.setAttribute('fill', '#0369a1');
      text.setAttribute('font-weight', '600');
      text.textContent = label;
      layer.appendChild(text);
    }
  }
}

async function loadScaleZones() {
  try {
    const { zones } = await api('GET', `/api/projects/${projectId}/sheets/${sheetId}/scale-zones`);
    scaleZones = zones;
  } catch (err) {
    // Offline (or forbidden) - fall back to whatever was cached at last
    // sync (see sync.routes.js/offline-store.js), rather than emptying out
    // and silently reverting a multi-scale sheet to its single scale.
    const cachedSheets = await getCachedSheets(projectId);
    const cached = cachedSheets.find((s) => String(s.sheet_id) === String(sheetId));
    scaleZones = (cached && cached.scale_zones) || [];
  }
  renderScaleZoneOverlay();
}

function ensureScaleZoneDraftLayer() {
  const svg = document.getElementById('markup-svg');
  let g = svg.querySelector('#scale-zone-draft-layer');
  if (!g) {
    g = measureSvgNs('g');
    g.id = 'scale-zone-draft-layer';
    svg.appendChild(g);
  }
  return g;
}

function redrawScaleZoneDraft(livePt) {
  const g = ensureScaleZoneDraftLayer();
  g.innerHTML = '';
  if (!scaleZoneDraft || !scaleZoneDraft.firstCorner || !livePt) return;
  const r = rectFromCorners(scaleZoneDraft.firstCorner, livePt);
  const scale = zoomPan ? zoomPan.state.scale : 1;
  const rect = measureSvgNs('rect');
  rect.setAttribute('x', r.x);
  rect.setAttribute('y', r.y);
  rect.setAttribute('width', r.width);
  rect.setAttribute('height', r.height);
  rect.setAttribute('fill', 'rgba(56, 189, 248, 0.15)');
  rect.setAttribute('stroke', '#38bdf8');
  rect.setAttribute('stroke-width', 2 / scale);
  rect.setAttribute('stroke-dasharray', `${6 / scale} ${4 / scale}`);
  g.appendChild(rect);
}

// Disarms whatever's currently active (take-off placement/edit, measure,
// markup) before arming the box-draw - a zone box click shouldn't also drop
// a take-off point or measure vertex on the same canvas.
function armScaleZoneDraw(draft) {
  deactivateTakeoff();
  exitTakeoffEditMode();
  clearMeasure();
  stopMeasureTool();
  if (markupsController) markupsController.forceSelectTool();
  scaleZoneDraft = draft;
}

async function saveScaleZoneBox(rect) {
  const { zoneId, label, scaleFeetPerInch: zoneScale } = scaleZoneDraft;
  scaleZoneDraft = null;
  ensureScaleZoneDraftLayer().innerHTML = '';
  try {
    if (zoneId) {
      await api('PATCH', `/api/projects/${projectId}/sheets/${sheetId}/scale-zones/${zoneId}`, rect);
    } else {
      await api('POST', `/api/projects/${projectId}/sheets/${sheetId}/scale-zones`, {
        label,
        scale_feet_per_inch: zoneScale,
        ...rect,
      });
    }
    await loadScaleZones();
    syncScaleSelectDisplay();
    showToast(zoneId ? 'Zone box updated.' : `Added "${label}".`, 'success');
  } catch (err) {
    showToast(`Failed to save scale zone: ${err.message}`, 'error');
  }
  openScaleZonesModal();
}

// Gated entirely on scaleZoneDraft being armed (via openScaleZoneFormModal),
// so this never interferes with take-off/measure/markup tools - all of which
// keep working normally while a zone box isn't actively being drawn.
function setupScaleZoneDrawInteraction() {
  const svg = document.getElementById('markup-svg');

  svg.addEventListener(
    'mousedown',
    (e) => {
      if (!scaleZoneDraft || e.button !== 0) return;
      // stopImmediatePropagation (not just stopPropagation) so the take-off/
      // measure capture-phase listeners registered on this same element
      // don't also fire for this click - arming scaleZoneDraft already
      // disarms those tools (see openScaleZoneFormModal/openScaleZonesModal),
      // but this is the belt-and-suspenders guard against a stray double
      // placement if that ever isn't true.
      e.stopImmediatePropagation();
      e.preventDefault();
      const pt = getMeasureSvgPoint(e);
      if (!scaleZoneDraft.firstCorner) {
        scaleZoneDraft.firstCorner = pt;
        redrawScaleZoneDraft(pt);
        return;
      }
      saveScaleZoneBox(rectFromCorners(scaleZoneDraft.firstCorner, pt));
    },
    true
  );

  svg.addEventListener('mousemove', (e) => {
    if (!scaleZoneDraft || !scaleZoneDraft.firstCorner) return;
    redrawScaleZoneDraft(getMeasureSvgPoint(e));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && scaleZoneDraft) {
      scaleZoneDraft = null;
      ensureScaleZoneDraftLayer().innerHTML = '';
      openScaleZonesModal();
    }
  });
}

// ---------- Hold-M magnifier lens (PlanSwift-style precision aid) ----------
// Holding M shows a round lens at the cursor with a zoomed-in crop of the
// PDF canvas - lets you eyeball a tight snap point without changing the
// actual zoom/pan level. Works over the canvas regardless of which tool
// (take-off, measure, markup) is active, since precision placement is useful
// in all of them, not just take-offs.
function setupMagnifierLens() {
  const zoomWrap = document.getElementById('zoom-wrap');
  const lens = document.getElementById('magnifier-lens');
  const ctx = lens.getContext('2d');
  const SIZE = 220; // CSS px and canvas px - 1:1, matches the CSS lens size
  const ZOOM = 3;
  const CORNER_MARGIN = 16;

  lens.width = SIZE;
  lens.height = SIZE;

  let active = false;
  let lastEvent = null;
  // True while shown via the touch API below (showAtCorner) instead of the
  // M key - pins the lens to a fixed screen corner instead of following the
  // cursor, since a finger (unlike a mouse pointer) covers whatever it's
  // touching and would otherwise hide the very spot it's meant to reveal.
  let cornerMode = false;

  // Shared crop-drawing core - takes a point already in canvas-bitmap space
  // (see the comment on the old single-purpose draw(), same reasoning
  // applies here) and returns whether there was anything to draw.
  function drawCropAt(pt) {
    const pdfCanvas = document.getElementById('pdf-canvas');
    if (!pdfCanvas.width) return false; // nothing rendered yet
    const srcSize = SIZE / ZOOM;
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.drawImage(pdfCanvas, pt.x - srcSize / 2, pt.y - srcSize / 2, srcSize, srcSize, 0, 0, SIZE, SIZE);
    ctx.strokeStyle = 'rgba(225,29,72,0.85)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(SIZE / 2 - 8, SIZE / 2);
    ctx.lineTo(SIZE / 2 + 8, SIZE / 2);
    ctx.moveTo(SIZE / 2, SIZE / 2 - 8);
    ctx.lineTo(SIZE / 2, SIZE / 2 + 8);
    ctx.stroke();
    return true;
  }

  function draw() {
    if (!active || !lastEvent) return;
    // getMeasureSvgPoint's viewBox is set to the canvas's own pixel
    // dimensions (see setupZoomPan), so this is already canvas-bitmap space -
    // no extra zoom/pan math needed to know what's "under the cursor".
    const pt = getMeasureSvgPoint(lastEvent);
    if (!drawCropAt(pt)) return;
    lens.style.left = `${lastEvent.clientX - SIZE / 2}px`;
    lens.style.top = `${lastEvent.clientY - SIZE / 2}px`;
  }

  function hide() {
    if (!active) return;
    active = false;
    cornerMode = false;
    lens.style.display = 'none';
  }

  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'm' || active) return;
    // Don't hijack "m" while the user is actually typing it into a field.
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    active = true;
    cornerMode = false;
    // display only flips on once draw() has somewhere valid to put it -
    // otherwise pressing M while the mouse is over the pane, not the
    // canvas, would flash the lens at whatever position it was last left.
    if (lastEvent) lens.style.display = 'block';
    draw();
  });
  document.addEventListener('keyup', (e) => {
    if (e.key.toLowerCase() === 'm') hide();
  });
  window.addEventListener('blur', hide);

  zoomWrap.addEventListener('mousemove', (e) => {
    lastEvent = e;
    if (active && !cornerMode) {
      lens.style.display = 'block';
      draw();
    }
  });
  zoomWrap.addEventListener('mouseleave', () => {
    if (!cornerMode) hide();
  });

  // ---- Touch API ----
  // iPad has no "hold M" - take-off point drag/placement calls these
  // directly instead while a finger is down. magnifierCorner (from user
  // settings) picks which bottom corner, so it stays clear of whichever
  // hand is holding/dragging.
  function showAtCorner(pt) {
    active = true;
    cornerMode = true;
    if (!drawCropAt(pt)) return;
    lens.style.top = `${window.innerHeight - SIZE - CORNER_MARGIN}px`;
    lens.style.left =
      magnifierCorner === 'bottom-right'
        ? `${window.innerWidth - SIZE - CORNER_MARGIN}px`
        : `${CORNER_MARGIN}px`;
    lens.style.display = 'block';
  }
  function updateCorner(pt) {
    if (!active || !cornerMode) return;
    drawCropAt(pt);
  }
  function hideCorner() {
    if (cornerMode) hide();
  }

  return { showAtCorner, updateCorner, hideCorner };
}

function getMeasureSvgPoint(evt) {
  const svg = document.getElementById('markup-svg');
  const rect = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  const p = evt.changedTouches ? evt.changedTouches[0] : evt;
  return {
    x: ((p.clientX - rect.left) / rect.width) * vb.width,
    y: ((p.clientY - rect.top) / rect.height) * vb.height,
  };
}

// ---------- Frozen reference panes ("press F") ----------
// Disarms whatever's currently active first (same convention as
// armScaleZoneDraw) so a stray click doesn't also drop a take-off point or
// measure vertex on the same canvas.
function armFreezePane() {
  deactivateTakeoff();
  exitTakeoffEditMode();
  clearMeasure();
  stopMeasureTool();
  if (markupsController) markupsController.forceSelectTool();
  freezeArmed = true;
  document.getElementById('zoom-wrap').classList.add('freeze-armed');
}

function disarmFreezePane() {
  freezeArmed = false;
  freezeDragStart = null;
  document.getElementById('zoom-wrap').classList.remove('freeze-armed');
  ensureFreezeDraftLayer().innerHTML = '';
}

function ensureFreezeDraftLayer() {
  const svg = document.getElementById('markup-svg');
  let g = svg.querySelector('#freeze-draft-layer');
  if (!g) {
    g = measureSvgNs('g');
    g.id = 'freeze-draft-layer';
    svg.appendChild(g);
  }
  return g;
}

function redrawFreezeDraft(livePt) {
  const g = ensureFreezeDraftLayer();
  g.innerHTML = '';
  if (!freezeDragStart || !livePt) return;
  const r = rectFromCorners(freezeDragStart, livePt);
  const scale = zoomPan ? zoomPan.state.scale : 1;
  const rect = measureSvgNs('rect');
  rect.setAttribute('x', r.x);
  rect.setAttribute('y', r.y);
  rect.setAttribute('width', r.width);
  rect.setAttribute('height', r.height);
  rect.setAttribute('fill', 'rgba(245, 158, 11, 0.15)');
  rect.setAttribute('stroke', '#f59e0b');
  rect.setAttribute('stroke-width', 2 / scale);
  rect.setAttribute('stroke-dasharray', `${6 / scale} ${4 / scale}`);
  g.appendChild(rect);
}

let freezePaneIdCounter = 0;

// Persisted panes are stored per-project (not per-sheet) so checking "keep
// across drawings" on one sheet makes it reappear - same screen position,
// same captured image, same label/collapsed state - on every other sheet in
// this project, until explicitly closed. Stored as a plain array of {id,
// dataUrl, width, height, left, top, boxWidth, boxHeight, collapsed, label}
// in localStorage; nothing server-side, matching the rest of this feature's
// session-scratch nature (just longer-lived scratch). boxWidth/boxHeight are
// only present once the user has manually resized the pane (undefined means
// "stay shrink-to-fit around the image").
function freezePanesStorageKey() {
  return `hammgrid-frozen-panes:${projectId}`;
}

function loadPersistedFreezePanes() {
  try {
    return JSON.parse(localStorage.getItem(freezePanesStorageKey())) || [];
  } catch (err) {
    return [];
  }
}

function savePersistedFreezePanesList(list) {
  localStorage.setItem(freezePanesStorageKey(), JSON.stringify(list));
}

function savePersistedFreezePane(entry) {
  const list = loadPersistedFreezePanes().filter((p) => p.id !== entry.id);
  list.push(entry);
  savePersistedFreezePanesList(list);
}

function updatePersistedFreezePane(id, patch) {
  const list = loadPersistedFreezePanes();
  const entry = list.find((p) => p.id === id);
  if (!entry) return;
  Object.assign(entry, patch);
  savePersistedFreezePanesList(list);
}

function removePersistedFreezePane(id) {
  savePersistedFreezePanesList(loadPersistedFreezePanes().filter((p) => p.id !== id));
}

const FREEZE_PANE_MIN_WIDTH = 80;
const FREEZE_PANE_MIN_HEIGHT = 50;
const FREEZE_PANE_RESIZE_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

// Builds the floating panel shell (drag handle, label, "keep across
// drawings" checkbox, close button, resize handles) around an already-built
// content element - a live capture <canvas> for a freshly-drawn box, or an
// <img> when rehydrating a persisted pane on a different sheet. The two
// creation paths below share everything except how the image content is
// produced.
function buildFreezePaneEl({ id, contentEl, left, top, persisted, label, collapsed, boxWidth, boxHeight }) {
  const el = document.createElement('div');
  el.className = 'freeze-pane';
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  if (boxWidth) el.style.width = `${boxWidth}px`;
  if (boxHeight) el.style.height = `${boxHeight}px`;
  el.innerHTML = `
    <div class="freeze-pane-header">
      <span class="freeze-pane-drag-handle" title="Drag to move">&#9776;</span>
      <input type="text" class="freeze-pane-label" placeholder="Label...">
      <div class="freeze-pane-header-actions">
        <button type="button" class="icon-btn freeze-pane-collapse" title="Collapse">&#9650;</button>
        <label class="freeze-pane-pin" title="Keep this pane across drawings until closed">
          <input type="checkbox" class="freeze-pane-persist-checkbox">
        </label>
        <button type="button" class="icon-btn freeze-pane-close" title="Close">&#10005;</button>
      </div>
    </div>
  `;
  contentEl.classList.add('freeze-pane-canvas');
  const viewport = document.createElement('div');
  viewport.className = 'freeze-pane-viewport';
  viewport.appendChild(contentEl);
  el.appendChild(viewport);
  for (const dir of FREEZE_PANE_RESIZE_DIRS) {
    const handle = document.createElement('div');
    handle.className = `freeze-pane-resize-handle freeze-pane-resize-${dir}`;
    el.appendChild(handle);
  }

  // Zoom/pan within the pane, independent of the pane's own on-screen box
  // size (see resize handles above) - session-only, like everything else
  // about a pane's view state, so it always starts fresh at 1x/centered on
  // a freshly-built pane rather than needing to persist yet another field.
  // Never below 1x: this is a fixed-resolution snapshot, not a live view -
  // there's nothing more of it to reveal by zooming "out" past a full fit,
  // just blank padding, so 1x doubles as both the default and the floor.
  let zoomLevel = 1;
  let panX = 0;
  let panY = 0;
  const FREEZE_PANE_MIN_ZOOM = 1;
  const FREEZE_PANE_MAX_ZOOM = 8;

  function applyPaneZoom() {
    const vpRect = viewport.getBoundingClientRect();
    const minPanX = vpRect.width * (1 - zoomLevel);
    const minPanY = vpRect.height * (1 - zoomLevel);
    panX = Math.min(0, Math.max(minPanX, panX));
    panY = Math.min(0, Math.max(minPanY, panY));
    contentEl.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomLevel})`;
  }

  viewport.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      e.stopPropagation(); // don't also scroll-zoom the main sheet underneath
      const vpRect = viewport.getBoundingClientRect();
      const vx = e.clientX - vpRect.left;
      const vy = e.clientY - vpRect.top;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const newZoom = Math.min(FREEZE_PANE_MAX_ZOOM, Math.max(FREEZE_PANE_MIN_ZOOM, zoomLevel * factor));
      if (newZoom === zoomLevel) return;
      // Zoom-to-cursor: keep whatever content point is under the mouse
      // fixed on screen rather than always zooming toward the corner.
      const localX = (vx - panX) / zoomLevel;
      const localY = (vy - panY) / zoomLevel;
      zoomLevel = newZoom;
      panX = vx - localX * zoomLevel;
      panY = vy - localY * zoomLevel;
      applyPaneZoom();
    },
    { passive: false }
  );

  let paneZoomDrag = null;
  viewport.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // Always claim the click, even at the default 1x fit where there's
    // nothing to pan into yet - the pane is meant to be screen-anchored and
    // fully self-contained (see the freeze-pane module comment), and
    // without this a click on its image would otherwise bubble up and
    // start dragging the MAIN sheet underneath instead.
    e.stopPropagation();
    if (zoomLevel <= 1) return;
    paneZoomDrag = { startX: e.clientX, startY: e.clientY, origPanX: panX, origPanY: panY };
  });
  window.addEventListener('mousemove', (e) => {
    if (!paneZoomDrag) return;
    panX = paneZoomDrag.origPanX + (e.clientX - paneZoomDrag.startX);
    panY = paneZoomDrag.origPanY + (e.clientY - paneZoomDrag.startY);
    applyPaneZoom();
  });
  window.addEventListener('mouseup', () => {
    paneZoomDrag = null;
  });
  viewport.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    zoomLevel = 1;
    panX = 0;
    panY = 0;
    applyPaneZoom();
  });

  document.getElementById('zoom-wrap').appendChild(el);
  freezePanes.push({ id, el });

  const persistCheckbox = el.querySelector('.freeze-pane-persist-checkbox');
  const labelInput = el.querySelector('.freeze-pane-label');
  const collapseBtn = el.querySelector('.freeze-pane-collapse');

  labelInput.value = label || '';
  persistCheckbox.checked = !!persisted;
  persistCheckbox.addEventListener('change', () => {
    if (persistCheckbox.checked) {
      savePersistedFreezePane({
        id,
        dataUrl: contentEl.tagName === 'CANVAS' ? contentEl.toDataURL('image/png') : contentEl.src,
        width: contentEl.width || contentEl.naturalWidth,
        height: contentEl.height || contentEl.naturalHeight,
        left: el.offsetLeft,
        top: el.offsetTop,
        boxWidth: el.style.width ? el.offsetWidth : undefined,
        boxHeight: el.style.height ? el.offsetHeight : undefined,
        collapsed: el.classList.contains('freeze-pane-collapsed'),
        label: labelInput.value,
      });
    } else {
      removePersistedFreezePane(id);
    }
  });

  labelInput.addEventListener('input', () => {
    if (persistCheckbox.checked) updatePersistedFreezePane(id, { label: labelInput.value });
  });

  // Collapsing hides the content but must not leave an explicit inline
  // height (set by a prior edge/corner resize) forcing the container to
  // stay tall with nothing visible in it - stash it on the element and
  // restore on expand.
  function setCollapsed(next) {
    if (next) {
      if (el.style.height) el.dataset.expandedHeight = el.style.height;
      el.style.height = '';
    } else if (el.dataset.expandedHeight) {
      el.style.height = el.dataset.expandedHeight;
    }
    el.classList.toggle('freeze-pane-collapsed', next);
    collapseBtn.title = next ? 'Expand' : 'Collapse';
  }
  setCollapsed(!!collapsed);
  collapseBtn.addEventListener('click', () => {
    const next = !el.classList.contains('freeze-pane-collapsed');
    setCollapsed(next);
    if (persistCheckbox.checked) updatePersistedFreezePane(id, { collapsed: next });
  });

  el.querySelector('.freeze-pane-close').addEventListener('click', () => {
    el.remove();
    freezePanes = freezePanes.filter((p) => p.id !== id);
    removePersistedFreezePane(id);
  });

  const header = el.querySelector('.freeze-pane-header');
  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('.freeze-pane-close') || e.target.closest('.freeze-pane-pin') || e.target.closest('.freeze-pane-collapse') || e.target.closest('.freeze-pane-label'))
      return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const origLeft = el.offsetLeft;
    const origTop = el.offsetTop;
    function onMove(ev) {
      el.style.left = `${origLeft + (ev.clientX - startX)}px`;
      el.style.top = `${origTop + (ev.clientY - startY)}px`;
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (persistCheckbox.checked) updatePersistedFreezePane(id, { left: el.offsetLeft, top: el.offsetTop });
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  el.querySelectorAll('.freeze-pane-resize-handle').forEach((handle) => {
    const dir = FREEZE_PANE_RESIZE_DIRS.find((d) => handle.classList.contains(`freeze-pane-resize-${d}`));
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;
      const startWidth = el.offsetWidth;
      const startHeight = el.offsetHeight;
      const startLeft = el.offsetLeft;
      const startTop = el.offsetTop;
      // Locked to the captured image's own proportions - a resize always
      // scales it, never distorts it. Skipped while collapsed: there's no
      // visible image then, just a header bar, and the e/w-only handles
      // still shown in that state (see the CSS) are for widening the bar to
      // read a long label, not for resizing an image that isn't on screen.
      const headerHeight = el.querySelector('.freeze-pane-header').offsetHeight;
      const collapsed = el.classList.contains('freeze-pane-collapsed');
      const ratio = !collapsed && startHeight > headerHeight ? startWidth / (startHeight - headerHeight) : null;

      function onMove(ev) {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;

        if (ratio) {
          const widthDelta = dir.includes('e') ? dx : dir.includes('w') ? -dx : 0;
          const heightDelta = dir.includes('s') ? dy : dir.includes('n') ? -dy : 0;
          const hasH = dir.includes('e') || dir.includes('w');
          const hasV = dir.includes('n') || dir.includes('s');
          // Corner handles blend both axes (smooth diagonal drag, no
          // jarring switch between which one "wins"); edge handles just
          // use their one axis, converting it to a width-equivalent so the
          // rest of the math only has to handle one dimension.
          const effectiveWidthDelta = hasH && hasV ? (widthDelta + heightDelta * ratio) / 2 : hasH ? widthDelta : heightDelta * ratio;

          let newWidth = Math.max(FREEZE_PANE_MIN_WIDTH, startWidth + effectiveWidthDelta);
          let newHeight = newWidth / ratio + headerHeight;
          if (newHeight < FREEZE_PANE_MIN_HEIGHT) {
            newHeight = FREEZE_PANE_MIN_HEIGHT;
            newWidth = Math.max(FREEZE_PANE_MIN_WIDTH, (newHeight - headerHeight) * ratio);
            newHeight = newWidth / ratio + headerHeight;
          }

          el.style.width = `${newWidth}px`;
          el.style.height = `${newHeight}px`;
          if (dir.includes('w')) el.style.left = `${startLeft + (startWidth - newWidth)}px`;
          if (dir.includes('n')) el.style.top = `${startTop + (startHeight - newHeight)}px`;
          applyPaneZoom(); // re-clamp pan - the viewport's own size just changed under it
          return;
        }

        // Collapsed: free width-only resize, unaffected by aspect ratio.
        if (dir.includes('e')) {
          el.style.width = `${Math.max(FREEZE_PANE_MIN_WIDTH, startWidth + dx)}px`;
        }
        if (dir.includes('w')) {
          const newWidth = Math.max(FREEZE_PANE_MIN_WIDTH, startWidth - dx);
          el.style.width = `${newWidth}px`;
          el.style.left = `${startLeft + (startWidth - newWidth)}px`;
        }
      }
      function onUp() {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        if (!persistCheckbox.checked) return;
        const patch = { left: el.offsetLeft, top: el.offsetTop, boxWidth: el.offsetWidth };
        if (!el.classList.contains('freeze-pane-collapsed')) patch.boxHeight = el.offsetHeight;
        updatePersistedFreezePane(id, patch);
      }
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  });
}

function createFreezePane(rect) {
  const pdfCanvas = document.getElementById('pdf-canvas');
  const svg = document.getElementById('markup-svg');
  const scale = zoomPan ? zoomPan.state.scale : 1;
  const destW = Math.max(1, Math.round(rect.width * scale));
  const destH = Math.max(1, Math.round(rect.height * scale));

  const captureCanvas = document.createElement('canvas');
  captureCanvas.width = destW;
  captureCanvas.height = destH;
  const ctx = captureCanvas.getContext('2d');
  ctx.drawImage(pdfCanvas, rect.x, rect.y, rect.width, rect.height, 0, 0, destW, destH);

  // Convert the sheet-space rect back to a screen position for the panel's
  // initial placement - the reverse of getMeasureSvgPoint's math.
  const svgRect = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  const screenX = svgRect.left + (rect.x / vb.width) * svgRect.width;
  const screenY = svgRect.top + (rect.y / vb.height) * svgRect.height;

  buildFreezePaneEl({
    id: `${Date.now()}-${++freezePaneIdCounter}`,
    contentEl: captureCanvas,
    left: screenX,
    top: screenY,
    persisted: false,
  });
}

function restorePersistedFreezePanes() {
  for (const entry of loadPersistedFreezePanes()) {
    const img = document.createElement('img');
    img.src = entry.dataUrl;
    img.width = entry.width;
    img.height = entry.height;
    buildFreezePaneEl({
      id: entry.id,
      contentEl: img,
      left: entry.left,
      top: entry.top,
      persisted: true,
      label: entry.label,
      collapsed: entry.collapsed,
      boxWidth: entry.boxWidth,
      boxHeight: entry.boxHeight,
    });
  }
}

function setupFreezePaneTool() {
  const svg = document.getElementById('markup-svg');

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && freezeArmed) {
      disarmFreezePane();
      return;
    }
    if (e.key.toLowerCase() !== 'f' || freezeArmed) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (markupsController && markupsController.isToolActive()) return;
    if (measureTool || takeoffTool || editingInstance) return;
    armFreezePane();
  });

  svg.addEventListener(
    'mousedown',
    (e) => {
      if (!freezeArmed || e.button !== 0) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      freezeDragStart = getMeasureSvgPoint(e);
      redrawFreezeDraft(freezeDragStart);
    },
    true
  );

  svg.addEventListener('mousemove', (e) => {
    if (!freezeArmed || !freezeDragStart) return;
    redrawFreezeDraft(getMeasureSvgPoint(e));
  });

  window.addEventListener('mouseup', (e) => {
    if (!freezeArmed || !freezeDragStart) return;
    const r = rectFromCorners(freezeDragStart, getMeasureSvgPoint(e));
    disarmFreezePane();
    if (r.width > 4 && r.height > 4) createFreezePane(r);
  });
}

// Average of all vertices - simple, deterministic stand-in for "where is
// this shape" when deciding which scale zone (if any) it falls in. Good
// enough for real-world zone boxes; a shape that's deliberately split across
// a zone boundary is a corner case not worth a full polygon-clip solution.
function centroidOfPoints(points) {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function findScaleZoneAt(pt) {
  return scaleZones.find((z) => pt.x >= z.x && pt.x <= z.x + z.width && pt.y >= z.y && pt.y <= z.y + z.height);
}

// The scale that applies to a given shape - a zone's scale if its centroid
// falls inside one of this sheet's scale zones, otherwise the sheet's normal
// single scale (unchanged behavior for sheets with no zones at all, and the
// fallback for anything outside every zone on sheets that do have them).
function effectiveScaleFeetPerInch(points) {
  if (scaleZones.length === 0) return scaleFeetPerInch;
  const zone = findScaleZoneAt(centroidOfPoints(points));
  return zone ? zone.scale_feet_per_inch : scaleFeetPerInch;
}

function pixelsToFeet(pixelDist, feetPerInch) {
  const inches = pixelDist / currentRenderScale / 72;
  return inches * feetPerInch;
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
  return pixelsToFeet(total, effectiveScaleFeetPerInch(pts));
}

function polygonAreaFeet(pts) {
  let area2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % pts.length];
    area2 += p1.x * p2.y - p2.x * p1.y;
  }
  const pixelArea = Math.abs(area2) / 2;
  const feetPerPixel = (1 / currentRenderScale / 72) * effectiveScaleFeetPerInch(pts);
  return pixelArea * feetPerPixel * feetPerPixel;
}

// Net area for a take-off's outer boundary minus any subtracted holes - the
// single source of truth for an area instance's quantity everywhere it's
// computed (placement, subtraction, edit-mode drag/delete).
function netAreaFeet(points, holes) {
  const outer = polygonAreaFeet(points);
  const holesArea = (holes || []).reduce((sum, h) => sum + polygonAreaFeet(h), 0);
  return Math.max(0, outer - holesArea);
}

// Outer-boundary perimeter only (holes excluded) - a subtracted opening
// isn't a wall line, so it doesn't factor into "how much rubber base does
// this room need."
function polygonPerimeterFeet(points) {
  return polylineLengthFeet([...points, points[0]]);
}

// SVG path `d` for an area boundary with subtracted holes - one closed
// subpath per ring, rendered together with fill-rule="evenodd" so hole
// subpaths visibly punch through the outer fill.
function ringToPathSegment(ring) {
  return `M ${ring.map((p) => `${p.x},${p.y}`).join(' L ')} Z`;
}

function areaPathD(points, holes) {
  return [ringToPathSegment(points), ...(holes || []).map(ringToPathSegment)].join(' ');
}

// 4 rectangle corners (in placement order) from two opposite corners -
// backs the box-draw shortcut for area take-offs/subtractions.
function boxCorners(a, b) {
  return [
    { x: a.x, y: a.y },
    { x: b.x, y: a.y },
    { x: b.x, y: b.y },
    { x: a.x, y: b.y },
  ];
}

// {x, y, width, height} from two opposite corners, in either click order -
// the scale-zone rectangle shape (see scaleZoneDraft/setupScaleZoneDrawInteraction).
function rectFromCorners(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

// PlanSwift-style 3-point arc: `from` is the already-placed point the curve
// starts at, `through` is a point the curve passes through (picks the
// curvature/direction), `to` is where it ends. Returns the tessellated
// points from just after `from` up to (and ending exactly on) `to` - `from`
// itself is not included, since it's already the last entry in takeoffPoints.
// Degenerate/collinear input (undefined circle) falls back to a straight
// line rather than throwing.
function arcPointsThrough(from, through, to, segments = 24) {
  const ax = from.x,
    ay = from.y,
    bx = through.x,
    by = through.y,
    cx = to.x,
    cy = to.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-6) return [to];

  const aSq = ax * ax + ay * ay;
  const bSq = bx * bx + by * by;
  const cSq = cx * cx + cy * cy;
  const centerX = (aSq * (by - cy) + bSq * (cy - ay) + cSq * (ay - by)) / d;
  const centerY = (aSq * (cx - bx) + bSq * (ax - cx) + cSq * (bx - ax)) / d;
  const r = Math.hypot(ax - centerX, ay - centerY);

  const angleFrom = Math.atan2(ay - centerY, ax - centerX);
  const angleThrough = Math.atan2(by - centerY, bx - centerX);
  const angleTo = Math.atan2(cy - centerY, cx - centerX);

  // Sweep counterclockwise (increasing angle) from `from` to `to` and check
  // whether `through`'s angle falls inside that sweep - if not, the real
  // curve goes the other way around the circle (clockwise).
  const twoPi = Math.PI * 2;
  let sweepCCW = angleTo - angleFrom;
  while (sweepCCW < 0) sweepCCW += twoPi;
  let throughOffsetCCW = angleThrough - angleFrom;
  while (throughOffsetCCW < 0) throughOffsetCCW += twoPi;
  const sweep = throughOffsetCCW <= sweepCCW ? sweepCCW : sweepCCW - twoPi;

  const points = [];
  for (let i = 1; i <= segments; i++) {
    const angle = angleFrom + sweep * (i / segments);
    points.push({ x: centerX + r * Math.cos(angle), y: centerY + r * Math.sin(angle) });
  }
  points[points.length - 1] = { x: to.x, y: to.y }; // land exactly on the clicked endpoint, not the trig approximation
  return points;
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
  awaitingArcThrough = false;
  arcThroughPoint = null;
  ensureTakeoffDraftLayer().innerHTML = '';
  const liveQtyEl = document.getElementById('takeoff-item-actions-live-qty');
  if (liveQtyEl) liveQtyEl.textContent = '';
  resetLiveTakeoffItemTotals();
}

// Restores every pane row's total to its last-rendered committed value (see
// updateLiveTakeoffItemTotals) - called whenever the draft clears, so a
// stale live-preview number can't linger if a submit fails partway (the
// success path corrects it anyway via the reload's own renderTakeoffPane,
// but this covers the gap, and the error path since that one never
// re-renders at all).
function resetLiveTakeoffItemTotals() {
  document.querySelectorAll('#takeoff-items-list .takeoff-item-row').forEach((row) => {
    const item = takeoffItems.find((i) => i.id === Number(row.dataset.itemId));
    const totalEl = row.querySelector('.takeoff-item-total');
    if (item && totalEl) totalEl.textContent = formatTakeoffQuantity(item, Number(row.dataset.sheetTotal) || 0);
  });
}

// Live running total in the item's own pane row while a linear/perimeter/
// area is being traced - the row-level analog of updateLiveTakeoffQuantity's
// bottom-bar figure. Overlays the in-progress trace's effect on top of
// whatever committed total the row was last rendered with (see its
// data-sheet-total, stashed in renderTakeoffPane) via a plain textContent
// write - no re-grouping sheetTakeoffInstances and no re-rendering the list
// on every mousemove, so this stays cheap regardless of trace frequency.
function updateLiveTakeoffItemTotals(pts) {
  if (!pts || pts.length === 0 || takeoffTool === 'count' || takeoffTool === 'assembly-box') return;
  const isArea = takeoffTool === 'area';
  if (isArea && pts.length < 3) return;

  function applyLiveTotal(itemId, rawTotal) {
    const row = document.querySelector(`#takeoff-items-list .takeoff-item-row[data-item-id="${itemId}"]`);
    const totalEl = row && row.querySelector('.takeoff-item-total');
    const item = takeoffItems.find((i) => i.id === itemId);
    if (totalEl && item) totalEl.textContent = formatTakeoffQuantity(item, rawTotal);
  }

  // Subtracting a hole reduces the target instance's own net area - the
  // row's stashed total already reflects every hole finished earlier in
  // this same "stays armed for more holes" session (each one reloads
  // instances and re-renders before the next hole starts), so only this
  // one in-progress hole's area needs subtracting here.
  if (subtractingIntoInstanceId) {
    const target = sheetTakeoffInstances.find((i) => i.id === subtractingIntoInstanceId);
    const row = target && document.querySelector(`#takeoff-items-list .takeoff-item-row[data-item-id="${target.item_id}"]`);
    if (!row) return;
    const base = Number(row.dataset.sheetTotal) || 0;
    applyLiveTotal(target.item_id, Math.max(0, base - polygonAreaFeet(pts)));
    return;
  }

  // Continuing an existing instance swaps its old (already-in-base)
  // committed quantity for the extended one, rather than adding a new
  // instance's worth on top.
  if (continuingInstanceId) {
    const target = sheetTakeoffInstances.find((i) => i.id === continuingInstanceId);
    const row = target && document.querySelector(`#takeoff-items-list .takeoff-item-row[data-item-id="${target.item_id}"]`);
    if (!row) return;
    const base = Number(row.dataset.sheetTotal) || 0;
    const newQuantity = isArea ? netAreaFeet(pts, target.geometry.holes) : polylineLengthFeet(pts);
    applyLiveTotal(target.item_id, base - target.quantity + newQuantity);
    return;
  }

  // Fresh placement (possibly multi-select) - a brand-new instance's worth
  // gets added on top of every combined item's own base total.
  const newQuantity = isArea ? polygonAreaFeet(pts) : polylineLengthFeet(pts);
  const itemIds = activeTakeoffItemId ? [activeTakeoffItemId, ...multiSelectExtraItemIds] : [...multiSelectExtraItemIds];
  for (const itemId of itemIds) {
    const row = document.querySelector(`#takeoff-items-list .takeoff-item-row[data-item-id="${itemId}"]`);
    if (!row) continue;
    applyLiveTotal(itemId, (Number(row.dataset.sheetTotal) || 0) + newQuantity);
  }
}

// Live running quantity in the pane's bottom action bar (see
// takeoff-item-actions-live-qty) while a linear/perimeter/area is being
// traced - mirrors exactly what finishTakeoffInstance would compute if the
// trace stopped right now (same math, same subtract/continue branches), so
// the number never surprises you when you actually click to finish. `pts`
// is redrawTakeoff's already-computed "shape as it would commit right now"
// array - this never recomputes it.
function updateLiveTakeoffQuantity(pts) {
  const el = document.getElementById('takeoff-item-actions-live-qty');
  if (!el) return;
  const item = getActiveTakeoffItem();
  if (!pts || pts.length === 0 || !item || takeoffTool === 'count' || takeoffTool === 'assembly-box') {
    el.textContent = '';
    return;
  }
  const isArea = takeoffTool === 'area';
  if (isArea && pts.length < 3) {
    el.textContent = ''; // no enclosed area yet with fewer than 3 points
    return;
  }
  if (subtractingIntoInstanceId) {
    // The hole itself, not run through the item's output formula - a
    // formula like "takeoff * Wall_Height" describes the wall, not the
    // opening being cut out of it.
    el.textContent = `New opening: ${formatRawTakeoffQuantity('area', polygonAreaFeet(pts))}`;
    return;
  }
  if (continuingInstanceId) {
    const target = sheetTakeoffInstances.find((i) => i.id === continuingInstanceId);
    const holes = target && target.geometry.holes;
    const quantity = isArea ? netAreaFeet(pts, holes) : polylineLengthFeet(pts);
    el.textContent = formatTakeoffQuantity(item, quantity);
    return;
  }
  const quantity = isArea ? polygonAreaFeet(pts) : polylineLengthFeet(pts);
  el.textContent = formatTakeoffQuantity(item, quantity);
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

// Every point of every instance already on this sheet, plus whatever's in
// the current in-progress draft - "a point from the current or another
// take-off" per spec. Rebuilt on demand rather than cached/invalidated,
// which is simpler and fine at the point counts a single sheet realistically
// has.
function collectTakeoffSnapCandidates() {
  const points = [...takeoffPoints];
  for (const inst of sheetTakeoffInstances) {
    if (!inst.geometry) continue;
    if (inst.geometry.points) points.push(...inst.geometry.points);
    if (inst.geometry.holes) for (const hole of inst.geometry.holes) points.push(...hole);
  }
  return points;
}

// Threshold is in screen pixels (divided by zoom scale to get back to SVG
// units) rather than a fixed drawing distance, per spec - "keep that close
// relative to the view... not relative to the position on the drawing," so
// the snap radius feels the same whether zoomed in or out.
function findNearbyTakeoffSnapPoint(pt) {
  const scale = zoomPan ? zoomPan.state.scale : 1;
  const thresholdSvg = 12 / scale;
  let best = null;
  let bestDist = thresholdSvg;
  for (const cand of collectTakeoffSnapCandidates()) {
    const d = Math.hypot(cand.x - pt.x, cand.y - pt.y);
    if (d < bestDist) {
      bestDist = d;
      best = cand;
    }
  }
  return best;
}

function redrawTakeoff(livePt) {
  const g = ensureTakeoffDraftLayer();
  g.innerHTML = '';

  // Box mode: after the first corner is placed, preview the rectangle the
  // second click would generate instead of a straight diagonal line.
  const isBoxPreview =
    takeoffPlacementMode === 'box' &&
    takeoffTool === 'area' &&
    !continuingInstanceId &&
    takeoffPoints.length === 1 &&
    livePt;

  // Arc mode, second click placed (the through-point): live-preview the
  // actual curve from the last committed point, through that fixed point,
  // to wherever the cursor currently is - tessellated the same way the
  // committed arc will be, so what you see is what you get.
  const isArcPreview = arcThroughPoint && livePt;

  let linePts;
  // Only the real clicked points (plus the pending through-point) get a
  // handle dot - the dozens of tessellated points along a live arc preview
  // would otherwise repaint as a dot cloud on every mousemove frame.
  let handlePts = takeoffPoints;

  if (isArcPreview) {
    const start = takeoffPoints[takeoffPoints.length - 1];
    linePts = [...takeoffPoints, ...arcPointsThrough(start, arcThroughPoint, livePt)];
    handlePts = [...takeoffPoints, arcThroughPoint];
  } else if (isBoxPreview) {
    linePts = boxCorners(takeoffPoints[0], livePt);
  } else {
    linePts = livePt ? [...takeoffPoints, livePt] : takeoffPoints;
  }

  updateLiveTakeoffQuantity(linePts);
  updateLiveTakeoffItemTotals(linePts);
  if (linePts.length === 0) return;

  const scale = zoomPan ? zoomPan.state.scale : 1;
  const activeItem = getActiveTakeoffItem();
  const color = activeItem ? activeItem.color : '#f59e0b'; // no item yet (first placement) - neutral until named

  // PlanSwift-style live fill: an area draft (point-by-point or the box
  // shortcut) is shown filled exactly as if it were closed right now at the
  // live cursor point, not just an outlined path - matching the always-
  // visible running quantity above. Holes already cut into the instance
  // being extended (see "Continue Item") stay punched through the live fill
  // too, via the same even-odd path used for committed geometry.
  const isAreaFill = takeoffTool === 'area' && linePts.length >= 2;
  let poly;
  if (isAreaFill) {
    const target = continuingInstanceId && sheetTakeoffInstances.find((i) => i.id === continuingInstanceId);
    const holes = target && target.geometry.holes;
    if (holes && holes.length) {
      poly = measureSvgNs('path');
      poly.setAttribute('d', areaPathD(linePts, holes));
      poly.setAttribute('fill-rule', 'evenodd');
    } else {
      poly = measureSvgNs('polygon');
      poly.setAttribute('points', linePts.map((p) => `${p.x},${p.y}`).join(' '));
    }
    poly.setAttribute('fill', color);
    poly.setAttribute('fill-opacity', '0.15');
  } else {
    poly = measureSvgNs('polyline');
    poly.setAttribute('points', linePts.map((p) => `${p.x},${p.y}`).join(' '));
    poly.setAttribute('fill', 'none');
  }
  poly.setAttribute('stroke', color);
  poly.setAttribute('stroke-width', 2 / scale);
  poly.setAttribute('stroke-dasharray', `${5 / scale} ${3 / scale}`);
  g.appendChild(poly);

  for (const p of handlePts) {
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

// iPad has no right mouse button, so touch-and-hold on a placed take-off is
// the equivalent gesture for opening its context menu (Subtract Area, etc).
// Cancels if the finger moves too far (that's a drag/pan, not a long-press)
// or lifts before the hold completes. Sets takeoffLongPressSuppressClick
// briefly so the 'click' handler that normally enters edit mode doesn't also
// fire right after the menu opens.
let takeoffLongPressSuppressClick = false;
function addLongPressContextMenu(el, onLongPress) {
  const LONG_PRESS_MS = 500;
  const MOVE_TOLERANCE = 10;
  let timer = null;
  let startPt = null;
  let firedForThisTouch = false;

  function cancel() {
    if (timer) clearTimeout(timer);
    timer = null;
    startPt = null;
  }

  el.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1) {
        cancel();
        return;
      }
      firedForThisTouch = false;
      const t = e.touches[0];
      startPt = { x: t.clientX, y: t.clientY };
      timer = setTimeout(() => {
        timer = null;
        firedForThisTouch = true;
        takeoffLongPressSuppressClick = true;
        onLongPress(startPt.x, startPt.y);
      }, LONG_PRESS_MS);
    },
    { passive: true }
  );
  el.addEventListener(
    'touchmove',
    (e) => {
      if (!timer || !startPt) return;
      const t = e.touches[0];
      if (Math.hypot(t.clientX - startPt.x, t.clientY - startPt.y) > MOVE_TOLERANCE) cancel();
    },
    { passive: true }
  );
  el.addEventListener('touchend', () => {
    cancel();
    if (firedForThisTouch) setTimeout(() => (takeoffLongPressSuppressClick = false), 300);
  });
  el.addEventListener('touchcancel', cancel);
}

// Committed geometry is only clickable (to enter edit mode) while no
// placement tool is armed - #takeoff-instances-layer's pointer-events are
// toggled via the .edit-enabled class so an armed tool's placement clicks
// still pass straight through to the canvas underneath, unchanged.
function renderTakeoffInstances() {
  // The layer gets wiped and rebuilt below, so any element the tooltip is
  // currently anchored to may no longer exist afterward (e.g. its instance
  // was just deleted) - mouseleave never fires for a removed element, which
  // is what let the tooltip get stuck. Rebuilding always invalidates
  // whatever was hovered, so just hide it unconditionally.
  hideTakeoffTooltip();
  const layer = ensureTakeoffInstancesLayer();
  layer.innerHTML = '';
  layer.classList.toggle('edit-enabled', !takeoffTool);
  const scale = zoomPan ? zoomPan.state.scale : 1;
  for (const inst of sheetTakeoffInstances) {
    if (editingInstance && inst.id === editingInstance.id) continue; // drawn by the edit overlay instead
    if (hiddenTakeoffItemIds.has(inst.item_id)) continue; // per-sheet visual hide, not a delete
    const pts = inst.geometry && inst.geometry.points;
    if (!pts || pts.length === 0) continue;

    let el;
    if (inst.item_type === 'count') {
      el = drawTakeoffShapeMarker(pts[0], inst.item_shape, inst.item_color, scale);
    } else if (inst.item_type === 'area') {
      const holes = inst.geometry.holes;
      if (holes && holes.length) {
        el = measureSvgNs('path');
        el.setAttribute('d', areaPathD(pts, holes));
        el.setAttribute('fill-rule', 'evenodd');
      } else {
        el = measureSvgNs('polygon');
        el.setAttribute('points', pts.map((p) => `${p.x},${p.y}`).join(' '));
      }
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
      if (takeoffLongPressSuppressClick) return; // long-press just opened the menu - don't also enter edit mode
      e.stopPropagation();
      enterTakeoffEditMode(inst);
    });
    el.addEventListener('contextmenu', (e) => {
      if (markupsController && markupsController.isToolActive()) return;
      e.preventDefault();
      e.stopPropagation();
      hideTakeoffTooltip();
      showTakeoffContextMenu(e.clientX, e.clientY, inst);
    });
    addLongPressContextMenu(el, (x, y) => {
      if (markupsController && markupsController.isToolActive()) return;
      hideTakeoffTooltip();
      showTakeoffContextMenu(x, y, inst);
    });
    el.addEventListener('mouseenter', (e) => {
      if (markupsController && markupsController.isToolActive()) return;
      showTakeoffTooltip(inst, e);
    });
    el.addEventListener('mousemove', positionTakeoffTooltip);
    el.addEventListener('mouseleave', hideTakeoffTooltip);
    layer.appendChild(el);
  }
}

// ---------- Hover tooltip on placed take-off geometry ----------
function ensureTakeoffTooltip() {
  let el = document.getElementById('takeoff-tooltip');
  if (!el) {
    el = document.createElement('div');
    el.id = 'takeoff-tooltip';
    el.style.display = 'none';
    document.body.appendChild(el);
  }
  return el;
}

function showTakeoffTooltip(inst, e) {
  const tooltip = ensureTakeoffTooltip();
  // inst is a flat joined row (item_name/item_color/item_type/item_formula/
  // item_properties/item_output_label) rather than a real item object -
  // formatTakeoffQuantity only reads {type, formula, properties,
  // output_label}, so a minimal stand-in works without a lookup.
  const itemLike = {
    type: inst.item_type,
    formula: inst.item_formula,
    properties: inst.item_properties,
    output_label: inst.item_output_label,
  };
  const perimeterLine =
    inst.item_type === 'area' && Number.isFinite(inst.perimeter) ? `<br>Perimeter: ${inst.perimeter.toFixed(1)} ft` : '';
  tooltip.innerHTML = `<b>${escapeHtml(inst.item_name)}</b><br>${escapeHtml(formatTakeoffQuantity(itemLike, inst.quantity))}${perimeterLine}`;
  tooltip.style.display = 'block';
  positionTakeoffTooltip(e);
}

function positionTakeoffTooltip(e) {
  const tooltip = document.getElementById('takeoff-tooltip');
  if (!tooltip || tooltip.style.display === 'none') return;
  tooltip.style.left = `${e.clientX + 14}px`;
  tooltip.style.top = `${e.clientY + 14}px`;
}

function hideTakeoffTooltip() {
  const tooltip = document.getElementById('takeoff-tooltip');
  if (tooltip) tooltip.style.display = 'none';
}

// ---------- Right-click context menu on a placed take-off ----------
function hideTakeoffContextMenu() {
  document.getElementById('takeoff-context-menu')?.remove();
}

function showTakeoffContextMenu(x, y, instance) {
  hideTakeoffContextMenu();
  const menu = document.createElement('div');
  menu.id = 'takeoff-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const actions = [{ action: 'activate', label: 'Activate Item' }];
  if (instance.item_type !== 'count') actions.push({ action: 'continue', label: 'Continue Item' });
  if (instance.item_type === 'area') actions.push({ action: 'subtract', label: 'Subtract Area' });
  actions.push({ action: 'change', label: 'Change Item' });
  actions.push({ action: 'goto', label: 'Go to Item in Take-offs' });
  menu.innerHTML = actions.map((a) => `<button type="button" data-action="${a.action}">${a.label}</button>`).join('');
  document.body.appendChild(menu);

  menu.querySelector('[data-action="activate"]').addEventListener('click', () => {
    hideTakeoffContextMenu();
    const item = takeoffItems.find((i) => i.id === instance.item_id);
    if (item) activateTakeoffItem(item);
  });
  const continueBtn = menu.querySelector('[data-action="continue"]');
  if (continueBtn) {
    continueBtn.addEventListener('click', () => {
      hideTakeoffContextMenu();
      continueTakeoffInstance(instance);
    });
  }
  const subtractBtn = menu.querySelector('[data-action="subtract"]');
  if (subtractBtn) {
    subtractBtn.addEventListener('click', () => {
      hideTakeoffContextMenu();
      subtractFromTakeoffInstance(instance);
    });
  }
  menu.querySelector('[data-action="change"]').addEventListener('click', () => {
    hideTakeoffContextMenu();
    openChangeTakeoffItemModal(instance);
  });
  menu.querySelector('[data-action="goto"]').addEventListener('click', () => {
    hideTakeoffContextMenu();
    window.location.href = `/takeoffs.html?projectId=${projectId}&itemId=${instance.item_id}`;
  });

  // Dismiss on the next click anywhere, or Escape. Deferred by a tick so the
  // right-click that opened this menu doesn't immediately close it again.
  setTimeout(() => {
    document.addEventListener('click', hideTakeoffContextMenu, { once: true });
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') hideTakeoffContextMenu();
      },
      { once: true }
    );
  }, 0);
}

// Reuses #takeoff-context-menu's id/CSS and hideTakeoffContextMenu, same
// convention every other context menu in this file already follows.
function showSheetLinkContextMenu(x, y, targetSheetId) {
  hideTakeoffContextMenu();
  const menu = document.createElement('div');
  menu.id = 'takeoff-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const url = `/sheet.html?projectId=${projectId}&sheetId=${targetSheetId}`;
  menu.innerHTML = `
    <button type="button" data-action="tab">Open in new tab</button>
    <button type="button" data-action="window">Open in new window</button>
    <button type="button" data-action="intab">Open as tab within drawing view</button>
  `;
  document.body.appendChild(menu);

  menu.querySelector('[data-action="tab"]').addEventListener('click', () => {
    hideTakeoffContextMenu();
    window.open(url, '_blank');
  });
  menu.querySelector('[data-action="window"]').addEventListener('click', () => {
    hideTakeoffContextMenu();
    window.open(url, `sheet-${targetSheetId}`, 'noopener,width=1200,height=900');
  });
  menu.querySelector('[data-action="intab"]').addEventListener('click', () => {
    hideTakeoffContextMenu();
    // Ordinary navigation (sheet-nav arrows, take-off/flag "go to drawing"
    // links, etc.) must never grow the open-tabs list - only this explicit
    // action does, by appending here before the navigation actually
    // happens. The destination page's own ensureCurrentSheetInOpenTabs()
    // then just relabels this same entry once it knows its sheet_number.
    const tabs = loadOpenTabs();
    if (tabs.length === 0) tabs.push({ sheetId, label: currentSheet.sheet_number });
    if (!tabs.some((t) => String(t.sheetId) === String(targetSheetId))) {
      tabs.push({ sheetId: targetSheetId });
    }
    saveOpenTabs(tabs);
    window.location.href = url;
  });

  setTimeout(() => {
    document.addEventListener('click', hideTakeoffContextMenu, { once: true });
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') hideTakeoffContextMenu();
      },
      { once: true }
    );
  }, 0);
}

function openChangeTakeoffItemModal(instance) {
  const sameTypeItems = takeoffItems.filter((i) => i.type === instance.item_type && i.id !== instance.item_id);
  openModal(`
    <h2>Change item</h2>
    <p class="muted">Move this ${escapeHtml(instance.item_type)} take-off to a different item - the whole placed shape, not part of it.</p>
    <div class="field">
      <label>Move to an existing item</label>
      <select id="change-item-select">
        <option value="">Choose an item...</option>
        ${sameTypeItems.map((i) => `<option value="${i.id}">${escapeHtml(i.name)}</option>`).join('')}
      </select>
    </div>
    <p class="muted" style="text-align:center;">— or —</p>
    <div class="field">
      <label>Create a new item</label>
      <input id="change-item-new-name" autocomplete="off" placeholder="e.g. Tile flooring">
    </div>
    <div class="field">
      <label>Color</label>
      <input type="color" id="change-item-new-color" value="${nextTakeoffColor()}">
    </div>
    <p class="error" id="change-item-error" style="display:none;"></p>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Cancel</button>
      <button class="primary" type="button" id="modal-change">Move</button>
    </div>
  `);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-change').addEventListener('click', async () => {
    const errEl = document.getElementById('change-item-error');
    const selectedId = document.getElementById('change-item-select').value;
    const newName = document.getElementById('change-item-new-name').value.trim();
    if (!selectedId && !newName) {
      errEl.textContent = 'Pick an existing item, or enter a name to create a new one.';
      errEl.style.display = 'block';
      return;
    }
    const btn = document.getElementById('modal-change');
    btn.disabled = true;
    try {
      let targetItemId = selectedId ? Number(selectedId) : null;
      if (!targetItemId) {
        const color = document.getElementById('change-item-new-color').value;
        const originalItem = takeoffItems.find((i) => i.id === instance.item_id);
        const { item } = await api('POST', `/api/projects/${projectId}/take-off-items`, {
          name: newName,
          type: instance.item_type,
          color,
          shape: instance.item_type === 'count' ? originalItem?.shape || 'square' : undefined,
        });
        takeoffItems.push({ ...item, total_quantity: 0, instance_count: 0 });
        targetItemId = item.id;
      }
      await api('PATCH', `/api/take-off-instances/${instance.id}`, { item_id: targetItemId });
      closeModal();
      showToast('Take-off moved.', 'success');
      if (editingInstance && editingInstance.id === instance.id) exitTakeoffEditMode();
      if (activeTakeoffItemId === instance.item_id) deactivateTakeoff();
      await Promise.all([loadSheetTakeoffInstances(), loadTakeoffItems()]);
      renderTakeoffPane();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
      btn.disabled = false;
    }
  });
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
  editingInstance = {
    ...instance,
    geometry: {
      points: instance.geometry.points.map((p) => ({ ...p })),
      holes: (instance.geometry.holes || []).map((h) => h.map((p) => ({ ...p }))),
    },
  };
  // Selecting the whole shape (every point, across the outer ring and any
  // holes) on entry means a click-then-drag immediately moves the entire
  // take-off - the common case - rather than requiring a marquee-select
  // first. Clicking a single point afterward narrows the selection down to
  // just that point, same as before.
  editSelectedPointIndices = new Set(takeoffEditRings().flatMap(([ring, pts]) => pts.map((_, i) => `${ring}:${i}`)));
  takeoffEditDefaultSelection = true;
  // Box/brush select always starts OFF on a fresh entry, regardless of what
  // was armed last time - it's a deliberate tool you turn on, not a mode
  // that carries over and silently changes what an empty-space click does.
  takeoffEditSelectMode = null;
  syncTakeoffEditModeButtons();
  renderTakeoffInstances(); // hide this instance from the plain committed layer
  renderTakeoffEditOverlay();
  renderTakeoffPane(); // highlight this instance's item row (and show the box/brush-select controls), whether entered from the canvas or the pane itself
}

function exitTakeoffEditMode() {
  if (!editingInstance) return;
  editingInstance = null;
  editSelectedPointIndices = new Set();
  takeoffBrushStroke = null;
  takeoffBrushCursorPt = null;
  ensureTakeoffEditLayer().innerHTML = '';
  renderTakeoffInstances(); // show it again in the plain committed layer
  renderTakeoffPane(); // drop the pane row highlight that mirrored edit mode
}

function minTakeoffPoints(type) {
  if (type === 'area') return 3;
  if (type === 'count') return 1;
  return 2;
}

// Every editable ring on the instance being edited: the outer boundary
// tagged 'outer', plus one entry per subtracted hole tagged by its index
// (as a string, so it can live alongside 'outer' in a single Set of
// composite "ring:pointIndex" selection keys).
function takeoffEditRings() {
  if (!editingInstance) return [];
  const rings = [['outer', editingInstance.geometry.points]];
  (editingInstance.geometry.holes || []).forEach((h, i) => rings.push([String(i), h]));
  return rings;
}

// Three-way choice (not confirmModal's plain yes/no) since there's a real
// difference between "get rid of this one piece" and "get rid of the whole
// item" - both delete the instance, they just disagree on what happens to
// the now-empty item. Resolves 'cancel' | 'keep-item' | 'delete-item'.
function confirmDeleteLastTakeoffPiece(itemName) {
  return new Promise((resolve) => {
    openModal(`
      <h2>Delete the last piece of "${escapeHtml(itemName)}"?</h2>
      <p>This is the only instance of this take-off item left anywhere in the project. What would you like to do?</p>
      <div class="modal-actions" style="flex-wrap:wrap;">
        <button type="button" id="modal-cancel">Cancel</button>
        <button type="button" id="modal-keep-item" class="primary">Delete piece, keep item</button>
        <button type="button" id="modal-delete-item" class="danger">Delete piece and item</button>
      </div>
    `);
    document.getElementById('modal-cancel').addEventListener('click', () => {
      closeModal();
      resolve('cancel');
    });
    document.getElementById('modal-keep-item').addEventListener('click', () => {
      closeModal();
      resolve('keep-item');
    });
    document.getElementById('modal-delete-item').addEventListener('click', () => {
      closeModal();
      resolve('delete-item');
    });
  });
}

async function applyTakeoffEditGeometry(newPoints, newHoles) {
  if (!editingInstance) return;
  if (newPoints.length < minTakeoffPoints(editingInstance.item_type)) {
    const id = editingInstance.id;
    const item = takeoffItems.find((i) => i.id === editingInstance.item_id);
    // instance_count is project-wide (not just this sheet) - "the only piece
    // that exists" means the item is about to have zero placements anywhere,
    // not just here, which is the moment worth asking about.
    if (item && item.instance_count <= 1) {
      const choice = await confirmDeleteLastTakeoffPiece(item.name);
      if (choice === 'cancel') return; // editingInstance untouched above - edit mode just continues as if nothing happened
      exitTakeoffEditMode();
      if (choice === 'delete-item') await performDeleteTakeoffItem(item);
      else await deleteTakeoffInstance(id);
      return;
    }
    exitTakeoffEditMode();
    await deleteTakeoffInstance(id);
    return;
  }
  // A hole dropped below a valid triangle by point deletion is removed
  // outright rather than left invalid - the outer boundary/instance survives.
  const holes = (newHoles || []).filter((h) => h.length >= 3);
  const quantity =
    editingInstance.item_type === 'area'
      ? netAreaFeet(newPoints, holes)
      : editingInstance.item_type === 'count'
      ? 1
      : polylineLengthFeet(newPoints);
  const perimeter = editingInstance.item_type === 'area' ? polygonPerimeterFeet(newPoints) : null;
  editingInstance.geometry = holes.length ? { points: newPoints, holes } : { points: newPoints };
  editingInstance.quantity = quantity;
  editingInstance.perimeter = perimeter;
  editSelectedPointIndices = new Set();
  const ok = await patchTakeoffInstance(editingInstance.id, newPoints, quantity, holes, perimeter);
  if (ok) {
    renderTakeoffEditOverlay();
    renderTakeoffPane();
  }
}

function deleteTakeoffEditPoints(keys) {
  if (!editingInstance) return;
  const byRing = new Map();
  for (const key of keys) {
    const [ring, idxStr] = key.split(':');
    if (!byRing.has(ring)) byRing.set(ring, new Set());
    byRing.get(ring).add(Number(idxStr));
  }
  const outerRemove = byRing.get('outer');
  const newPoints = outerRemove
    ? editingInstance.geometry.points.filter((_, i) => !outerRemove.has(i))
    : editingInstance.geometry.points;
  const newHoles = (editingInstance.geometry.holes || []).map((hole, hi) => {
    const remove = byRing.get(String(hi));
    return remove ? hole.filter((_, i) => !remove.has(i)) : hole;
  });
  applyTakeoffEditGeometry(newPoints, newHoles);
}

// Double-clicking a line in edit mode inserts a new point there, so the
// user can drag it to reshape that stretch of the boundary. hitSegment is
// the [`${ring}:${i}`, `${ring}:${j}`] pair from hitTestTakeoffEditSegment -
// the new point always goes right after index i, which works for the
// closing segment too (i = last index, j = 0) since splicing at i+1 there
// is simply an append.
function insertTakeoffEditPoint(hitSegment, pt) {
  if (!editingInstance) return;
  const [ring, idxStr] = hitSegment[0].split(':');
  const i = Number(idxStr);
  if (ring === 'outer') {
    const points = [...editingInstance.geometry.points];
    points.splice(i + 1, 0, pt);
    applyTakeoffEditGeometry(points, editingInstance.geometry.holes);
  } else {
    const hi = Number(ring);
    const holes = (editingInstance.geometry.holes || []).map((hole, hIdx) => {
      if (hIdx !== hi) return hole;
      const newHole = [...hole];
      newHole.splice(i + 1, 0, pt);
      return newHole;
    });
    applyTakeoffEditGeometry(editingInstance.geometry.points, holes);
  }
}

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function hitTestTakeoffEditPoint(pt, radiusPx = 10) {
  if (!editingInstance) return null;
  const scale = zoomPan ? zoomPan.state.scale : 1;
  const r = radiusPx / scale;
  for (const [ring, pts] of takeoffEditRings()) {
    for (let i = 0; i < pts.length; i++) {
      if (Math.hypot(pts[i].x - pt.x, pts[i].y - pt.y) <= r) return `${ring}:${i}`;
    }
  }
  return null;
}

function hitTestTakeoffEditSegment(pt) {
  if (!editingInstance || editingInstance.item_type === 'count') return null;
  const scale = zoomPan ? zoomPan.state.scale : 1;
  const tol = 6 / scale;
  for (const [ring, pts] of takeoffEditRings()) {
    // Hole rings are always closed loops; the outer ring is closed only for
    // area take-offs (linear/perimeter outer boundaries are open polylines).
    const closed = ring !== 'outer' || editingInstance.item_type === 'area';
    const segCount = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < segCount; i++) {
      const j = (i + 1) % pts.length;
      if (distanceToSegment(pt, pts[i], pts[j]) <= tol) return [`${ring}:${i}`, `${ring}:${j}`];
    }
  }
  return null;
}

// Brush select at a point in drawing space - adds (or, with subtract=true,
// removes) every point within takeoffBrushRadius. Mutates
// editSelectedPointIndices directly and returns whether anything was within
// range, so a stroke that never actually touches a point can still fall
// back to "click empty space to exit edit mode".
function brushSelectPointsAt(pt, subtract) {
  if (!editingInstance) return false;
  const scale = zoomPan ? zoomPan.state.scale : 1;
  const r = takeoffBrushRadius / scale;
  let touched = false;
  for (const [ring, ringPts] of takeoffEditRings()) {
    ringPts.forEach((p, i) => {
      if (Math.hypot(p.x - pt.x, p.y - pt.y) <= r) {
        touched = true;
        const key = `${ring}:${i}`;
        if (subtract) editSelectedPointIndices.delete(key);
        else editSelectedPointIndices.add(key);
      }
    });
  }
  return touched;
}

function renderTakeoffEditOverlay() {
  const layer = ensureTakeoffEditLayer();
  layer.innerHTML = '';
  if (!editingInstance) return;
  const scale = zoomPan ? zoomPan.state.scale : 1;
  const pts = editingInstance.geometry.points;
  const holes = editingInstance.geometry.holes || [];
  const color = editingInstance.item_color;

  if (editingInstance.item_type === 'count') {
    layer.appendChild(drawTakeoffShapeMarker(pts[0], editingInstance.item_shape, color, scale));
  } else if (pts.length > 1) {
    let shapeEl;
    if (editingInstance.item_type === 'area' && holes.length) {
      shapeEl = measureSvgNs('path');
      shapeEl.setAttribute('d', areaPathD(pts, holes));
      shapeEl.setAttribute('fill-rule', 'evenodd');
    } else {
      shapeEl = measureSvgNs(editingInstance.item_type === 'area' ? 'polygon' : 'polyline');
      shapeEl.setAttribute('points', pts.map((p) => `${p.x},${p.y}`).join(' '));
    }
    shapeEl.setAttribute('stroke', color);
    shapeEl.setAttribute('stroke-width', 3 / scale);
    shapeEl.setAttribute('fill', editingInstance.item_type === 'area' ? color : 'none');
    shapeEl.setAttribute('fill-opacity', '0.15');
    shapeEl.id = 'takeoff-edit-shape'; // looked up by repositionTakeoffEditOverlay() - see there for why
    layer.appendChild(shapeEl);
  }

  for (const [ring, ringPts] of takeoffEditRings()) {
    ringPts.forEach((p, i) => {
      const key = `${ring}:${i}`;
      const selected = editSelectedPointIndices.has(key);
      const c = measureSvgNs('circle');
      c.setAttribute('data-key', key); // looked up by repositionTakeoffEditOverlay() - see there for why
      c.setAttribute('cx', p.x);
      c.setAttribute('cy', p.y);
      c.setAttribute('r', 7 / scale);
      // Selected points are solid green - deliberately a different hue from
      // the blue used everywhere else in edit mode (unselected point
      // outline, marquee box, brush cursor), so a selection is unambiguous
      // at a glance instead of blending into the rest of the blue chrome.
      c.setAttribute('fill', selected ? '#16a34a' : '#fff');
      c.setAttribute('stroke', selected ? '#16a34a' : '#2563eb');
      c.setAttribute('stroke-width', 2 / scale);
      layer.appendChild(c);
    });
  }

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

  // Brush cursor - drawn whenever hovering in brush mode, not just while
  // actively dragging, same as Blender's circle-select cursor following the
  // mouse before you've even clicked.
  if (takeoffEditSelectMode === 'brush' && takeoffBrushCursorPt) {
    const c = measureSvgNs('circle');
    c.setAttribute('cx', takeoffBrushCursorPt.x);
    c.setAttribute('cy', takeoffBrushCursorPt.y);
    c.setAttribute('r', takeoffBrushRadius / scale);
    c.setAttribute('fill', 'rgba(37,99,235,0.08)');
    c.setAttribute('stroke', '#2563eb');
    c.setAttribute('stroke-width', 1.5 / scale);
    layer.appendChild(c);
  }
}

// Lighter-weight alternative to renderTakeoffEditOverlay() for use WHILE a
// point drag is in progress - updates the moved circles' cx/cy and the
// outer shape's points/d attribute in place instead of clearing and
// rebuilding the whole layer. This matters specifically for touch: a real
// mouse drag never cared which DOM node was under the cursor (mousemove is
// re-targeted every event), but a touch's touchmove/touchend are pinned to
// whichever element touchstart actually landed on - if that circle gets
// removed and replaced (as the full rebuild does every frame), iOS fires
// touchcancel and the drag dies after one tiny movement. Keeping the same
// DOM nodes alive for the duration of the gesture fixes that.
function repositionTakeoffEditOverlay(movedKeys) {
  const layer = ensureTakeoffEditLayer();
  if (!editingInstance) return;
  const pts = editingInstance.geometry.points;
  const holes = editingInstance.geometry.holes || [];

  const shapeEl = layer.querySelector('#takeoff-edit-shape');
  if (shapeEl && pts.length > 1) {
    if (editingInstance.item_type === 'area' && holes.length) {
      shapeEl.setAttribute('d', areaPathD(pts, holes));
    } else {
      shapeEl.setAttribute('points', pts.map((p) => `${p.x},${p.y}`).join(' '));
    }
  }

  for (const key of movedKeys) {
    const c = layer.querySelector(`circle[data-key="${key}"]`);
    if (!c) continue;
    const [ring, idxStr] = key.split(':');
    const idx = Number(idxStr);
    const p = ring === 'outer' ? pts[idx] : holes[Number(ring)][idx];
    if (!p) continue;
    c.setAttribute('cx', p.x);
    c.setAttribute('cy', p.y);
  }
}

function setupTakeoffEditInteraction() {
  const svg = document.getElementById('markup-svg');

  // Touch mirror of the mousedown/mousemove/mouseup trio below - same body,
  // reused via these named handlers so iPad point-drag/select/marquee/brush
  // works identically to mouse instead of relying on iOS's tap-only click
  // synthesis (which never fires a drag). Gated to single-finger touches so
  // it never fights zoomPan.js's two-finger pinch/pan.
  function isPrimaryTakeoffTouch(e) {
    return !e.touches || e.touches.length === 1;
  }

  function handleTakeoffEditPointerDown(e) {
    if (!editingInstance) return;
    if (!e.touches && e.button !== 0) return;
    e.stopPropagation();
    const pt = getMeasureSvgPoint(e);
    // Touch gets a bigger hit radius than mouse - a fingertip is nowhere
    // near as precise as a cursor, and the default 10px was tuned for mouse.
    const hitPoint = hitTestTakeoffEditPoint(pt, e.touches ? 16 : 10);

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
      // A plain click narrows the selection down to just this point UNLESS
      // it's already part of a real, deliberately-built selection (box/brush,
      // even after exiting select mode) - that one needs to survive a click
      // on one of its own points so the whole group can still be dragged
      // together. The only selection that's fair game to collapse on any
      // click is the untouched "everything selected" default from entering
      // edit mode (see takeoffEditDefaultSelection) - that one's just a
      // convenience for moving the whole shape, not a selection the user
      // actually built on purpose.
      const shouldNarrow = takeoffEditDefaultSelection || !editSelectedPointIndices.has(hitPoint);
      if (shouldNarrow) {
        editSelectedPointIndices = new Set([hitPoint]);
        takeoffEditDefaultSelection = false;
        renderTakeoffEditOverlay();
      }
      // Dragging to move points is only available with no selection tool
      // armed - while box/brush is on, every mouse gesture is for building a
      // selection, never for moving it. Exit select mode (see
      // setupTakeoffEditToolbar) to drag whatever ended up selected.
      if (!takeoffEditSelectMode) {
        takeoffEditDrag = { startPt: pt, moved: false };
        // Corner magnifier only on touch - a mouse cursor doesn't cover the
        // point it's dragging, so it doesn't need the assist (M key still
        // works for mouse if wanted).
        if (e.touches) magnifierLens.showAtCorner(pt);
      }
      return;
    }

    const hitSegment = hitTestTakeoffEditSegment(pt);
    if (hitSegment) {
      const segKey = hitSegment.join('-');
      const now = Date.now();
      const isDoubleClick =
        takeoffLastClickSegment && takeoffLastClickSegment.key === segKey && now - takeoffLastClickSegment.time < 400;
      takeoffLastClickSegment = { key: segKey, time: now };
      if (isDoubleClick) {
        takeoffLastClickSegment = null;
        insertTakeoffEditPoint(hitSegment, pt);
        return;
      }
      editSelectedPointIndices = new Set(hitSegment);
      takeoffEditDefaultSelection = false;
      renderTakeoffEditOverlay();
      return;
    }

    // Empty space inside the edit svg. With a selection tool armed, box mode
    // starts a marquee and brush mode starts painting immediately (a single
    // dab still counts, same as Blender's C-select) - a plain click that
    // never grows into a drag and never touches a point (handled on mouseup
    // below) exits edit mode instead. With NEITHER tool armed (the default
    // on entering edit mode - see enterTakeoffEditMode), empty space has
    // nothing to interpret a drag as, so it just exits right away.
    if (takeoffEditSelectMode === 'brush') {
      takeoffBrushStroke = { touchedAny: brushSelectPointsAt(pt, e.shiftKey) };
      takeoffEditDefaultSelection = false;
      renderTakeoffEditOverlay();
    } else if (takeoffEditSelectMode === 'box') {
      takeoffMarquee = { startPt: pt, currentPt: null };
      editSelectedPointIndices = new Set();
      takeoffEditDefaultSelection = false;
      renderTakeoffEditOverlay();
    } else {
      exitTakeoffEditMode();
    }
  }

  function handleTakeoffEditPointerMove(e) {
    if (!editingInstance) return;
    const pt = getMeasureSvgPoint(e);
    if (takeoffEditSelectMode === 'brush') {
      takeoffBrushCursorPt = pt;
    }
    if (takeoffEditDrag) {
      const dx = pt.x - takeoffEditDrag.startPt.x;
      const dy = pt.y - takeoffEditDrag.startPt.y;
      if (dx || dy) takeoffEditDrag.moved = true;
      takeoffEditDrag.startPt = pt;
      for (const key of editSelectedPointIndices) {
        const [ring, idxStr] = key.split(':');
        const idx = Number(idxStr);
        const arr = ring === 'outer' ? editingInstance.geometry.points : editingInstance.geometry.holes[Number(ring)];
        arr[idx].x += dx;
        arr[idx].y += dy;
      }
      // Reposition, not a full rebuild - see repositionTakeoffEditOverlay's
      // comment for why rebuilding here breaks touch dragging specifically.
      repositionTakeoffEditOverlay(editSelectedPointIndices);
      if (e.touches) magnifierLens.updateCorner(pt);
    } else if (takeoffMarquee) {
      takeoffMarquee.currentPt = pt;
      renderTakeoffEditOverlay();
    } else if (takeoffBrushStroke) {
      const touched = brushSelectPointsAt(pt, e.shiftKey);
      if (touched) {
        takeoffBrushStroke.touchedAny = true;
        takeoffEditDefaultSelection = false;
      }
      renderTakeoffEditOverlay();
    } else if (takeoffEditSelectMode === 'brush') {
      renderTakeoffEditOverlay(); // just moving the hover cursor, nothing selected yet
    }
  }

  function finishTakeoffEditGesture() {
    if (takeoffBrushStroke) {
      const touchedAny = takeoffBrushStroke.touchedAny;
      takeoffBrushStroke = null;
      if (!touchedAny) exitTakeoffEditMode();
      else renderTakeoffEditOverlay();
      return;
    }
    if (takeoffEditDrag) {
      const moved = takeoffEditDrag.moved;
      takeoffEditDrag = null;
      magnifierLens.hideCorner();
      if (moved) applyTakeoffEditGeometry(editingInstance.geometry.points, editingInstance.geometry.holes);
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
        for (const [ring, ringPts] of takeoffEditRings()) {
          ringPts.forEach((p, i) => {
            if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) selected.add(`${ring}:${i}`);
          });
        }
        editSelectedPointIndices = selected;
        takeoffEditDefaultSelection = false;
        takeoffMarquee = null;
        renderTakeoffEditOverlay();
      } else {
        // No drag happened - a plain click on empty space exits edit mode.
        takeoffMarquee = null;
        exitTakeoffEditMode();
      }
    }
  }

  svg.addEventListener('mousedown', handleTakeoffEditPointerDown);
  svg.addEventListener('mousemove', handleTakeoffEditPointerMove);
  window.addEventListener('mouseup', finishTakeoffEditGesture);

  svg.addEventListener(
    'touchstart',
    (e) => {
      if (!isPrimaryTakeoffTouch(e)) return;
      // Claim the gesture immediately while editing. Without this, iOS both
      // delays committing to "this is a drag" (the "little bits, then
      // normal" stutter) AND, since preventDefault was never called,
      // synthesizes a phantom mousedown/mouseup/click ~300ms after touchend
      // at the same point - which hitTestTakeoffEditPoint sees as a second
      // tap on the same point within the double-click window, deleting it.
      if (editingInstance) e.preventDefault();
      handleTakeoffEditPointerDown(e);
    },
    { passive: false }
  );
  svg.addEventListener(
    'touchmove',
    (e) => {
      if (!isPrimaryTakeoffTouch(e)) return;
      if (takeoffEditDrag || takeoffMarquee || takeoffBrushStroke) e.preventDefault();
      handleTakeoffEditPointerMove(e);
    },
    { passive: false }
  );
  window.addEventListener('touchend', (e) => {
    if (e.touches.length > 0) return;
    finishTakeoffEditGesture();
  });

  svg.addEventListener('mouseleave', () => {
    if (takeoffEditSelectMode === 'brush' && !takeoffBrushStroke) {
      takeoffBrushCursorPt = null;
      renderTakeoffEditOverlay();
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

  // Right-click a selection (a marquee box, or the point(s)/segment already
  // selected) to spin it off into a brand-new item - e.g. tracing asphalt
  // paving, then reusing the same edge points for a "Concrete Curb" item
  // instead of retracing that same line by hand.
  svg.addEventListener('contextmenu', (e) => {
    if (!editingInstance || editSelectedPointIndices.size === 0) return;
    e.preventDefault();
    e.stopPropagation();
    showCopySelectionContextMenu(e.clientX, e.clientY);
  });
}

// ---------- Box vs. brush select mode, inside the shared #takeoff-toolbar ----------
// #takeoff-edit-select-group's own visibility (only while editingInstance is
// set - see updateTakeoffToolbar) is independent of the rest of the bar, same
// as #takeoff-item-actions-group's - box/brush is purely a selection-tool
// choice, not something meaningful outside point/segment editing.
// Keeps the Box/Brush buttons' active state and the brush-size control's
// visibility in sync with takeoffEditSelectMode - shared by entry (both
// buttons off) and the toggle click handler below.
function syncTakeoffEditModeButtons() {
  document
    .querySelectorAll('#takeoff-select-mode button')
    .forEach((b) => b.classList.toggle('active', b.dataset.mode === takeoffEditSelectMode));
  document.getElementById('takeoff-brush-size-wrap').style.display = takeoffEditSelectMode === 'brush' ? '' : 'none';
}

function setupTakeoffEditToolbar() {
  // Going straight from reviewing/selecting an already-placed shape to
  // adding another instance of the same item is handled by the shared
  // Start/Stop button in #takeoff-item-actions-group - currentBarItemId()
  // falls back to editingInstance.item_id, so that one button already covers
  // this case without a second dedicated Start button.
  const modeGroup = document.getElementById('takeoff-select-mode');
  modeGroup.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      // Clicking the already-armed tool turns selection back off rather
      // than being stuck between two mutually-exclusive buttons.
      const newMode = takeoffEditSelectMode === btn.dataset.mode ? null : btn.dataset.mode;
      const arming = newMode !== null; // null means the click just turned a tool OFF
      takeoffEditSelectMode = newMode;
      syncTakeoffEditModeButtons();
      // Arming a tool (including switching box<->brush) starts a fresh
      // selection-building session - entering edit mode's blanket
      // "everything selected" default (see enterTakeoffEditMode) needs to
      // get out of the way first, not linger and confuse what's about to be
      // selected. Turning a tool back OFF is the opposite: whatever got
      // selected while it was armed should carry over so it can be
      // click-dragged now that direct point interaction is available again -
      // that's the whole point of exiting select mode.
      if (arming) {
        editSelectedPointIndices = new Set();
        takeoffEditDefaultSelection = false;
      }
      // Switching modes mid-edit shouldn't leave a half-finished marquee/
      // brush stroke or a stale hover cursor from the other mode around.
      takeoffMarquee = null;
      takeoffBrushStroke = null;
      takeoffBrushCursorPt = null;
      renderTakeoffEditOverlay();
    });
  });

  document.getElementById('takeoff-brush-size').addEventListener('input', (e) => {
    takeoffBrushRadius = Number(e.target.value);
    renderTakeoffEditOverlay();
  });

  document.getElementById('takeoff-edit-clear-selection').addEventListener('click', () => {
    editSelectedPointIndices = new Set();
    takeoffEditDefaultSelection = false;
    renderTakeoffEditOverlay();
  });
}

// Selected points sorted back into their actual position along the shape
// (ring, then index) - NOT Set-insertion order. A single marquee or a
// single brush dab happens to add points in that order already, but a
// brush stroke that sweeps back and forth (or a dense run of arc-generated
// points) can easily touch them out of sequence, and copying in whatever
// order the Set accumulated them produced a visibly scrambled/crossed path
// instead of the same connected line.
function getSelectedEditPoints() {
  if (!editingInstance) return [];
  const ringMap = new Map(takeoffEditRings());
  return [...editSelectedPointIndices]
    .map((key) => {
      const [ring, idxStr] = key.split(':');
      return { ring, idx: Number(idxStr) };
    })
    .sort((a, b) => (a.ring === b.ring ? a.idx - b.idx : a.ring.localeCompare(b.ring)))
    .map(({ ring, idx }) => {
      const pts = ringMap.get(ring);
      return pts ? { ...pts[idx] } : null;
    })
    .filter(Boolean);
}

function showCopySelectionContextMenu(x, y) {
  hideTakeoffContextMenu();
  const menu = document.createElement('div');
  menu.id = 'takeoff-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.innerHTML = `
    <button type="button" data-action="copy-new">Copy selection to new item</button>
    <button type="button" data-action="copy-existing">Copy selection to existing item...</button>
  `;
  document.body.appendChild(menu);
  menu.querySelector('[data-action="copy-new"]').addEventListener('click', () => {
    hideTakeoffContextMenu();
    openCopySelectionModal();
  });
  menu.querySelector('[data-action="copy-existing"]').addEventListener('click', () => {
    hideTakeoffContextMenu();
    openCopySelectionToExistingModal();
  });
  setTimeout(() => {
    document.addEventListener('click', hideTakeoffContextMenu, { once: true });
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') hideTakeoffContextMenu();
      },
      { once: true }
    );
  }, 0);
}

// Creates a whole new item (+ one instance on this sheet) from the points
// currently selected in edit mode - a fast way to reuse a shape you've
// already traced for one item as the starting point for a different one,
// instead of tracing the same edge twice. Deliberately minimal (name/type/
// color only, no folder/properties/formula) - the new item can be edited
// normally afterward if it needs those.
function openCopySelectionModal() {
  const points = getSelectedEditPoints();
  if (points.length < 2) {
    showToast('Select at least 2 points to copy.', 'error');
    return;
  }
  openModal(`
    <h2>Copy selection to new item</h2>
    <p class="muted">Creates a new take-off item from these ${points.length} selected points, placed as a new instance on this sheet.</p>
    <div class="field">
      <label>Name</label>
      <input id="copy-item-name" autocomplete="off" placeholder="e.g. Concrete Curb">
    </div>
    <div class="field">
      <label>Type</label>
      <select id="copy-item-type">
        <option value="linear">linear</option>
        <option value="perimeter">perimeter</option>
        <option value="area">area</option>
      </select>
    </div>
    <div class="field">
      <label>Color</label>
      <input type="color" id="copy-item-color" value="${nextTakeoffColor()}">
    </div>
    <p class="error" id="copy-item-error" style="display:none;"></p>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Cancel</button>
      <button class="primary" type="button" id="modal-create">Create</button>
    </div>
  `);
  document.getElementById('copy-item-name').focus();
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-create').addEventListener('click', async () => {
    const name = document.getElementById('copy-item-name').value.trim();
    const type = document.getElementById('copy-item-type').value;
    const color = document.getElementById('copy-item-color').value;
    const errEl = document.getElementById('copy-item-error');
    if (!name) {
      errEl.textContent = 'Name is required.';
      errEl.style.display = 'block';
      return;
    }
    if (type === 'area' && points.length < 3) {
      errEl.textContent = 'Area needs at least 3 points.';
      errEl.style.display = 'block';
      return;
    }
    const createBtn = document.getElementById('modal-create');
    createBtn.disabled = true;
    try {
      const { item } = await api('POST', `/api/projects/${projectId}/take-off-items`, { name, type, color });
      const quantity = type === 'area' ? polygonAreaFeet(points) : polylineLengthFeet(points);
      const perimeter = type === 'area' ? polygonPerimeterFeet(points) : null;
      await api('POST', `/api/projects/${projectId}/sheets/${sheetId}/take-off-instances`, {
        item_id: item.id,
        geometry: { points },
        quantity,
        perimeter,
      });
      closeModal();
      showToast(`Created "${name}" from the selection.`, 'success');
      await Promise.all([loadTakeoffItems(), loadSheetTakeoffInstances()]);
      renderTakeoffPane();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
      createBtn.disabled = false;
    }
  });
}

// "Copy selection to existing item" - same trace as openCopySelectionModal,
// but instead of creating a new item, adds a new instance of the selected
// points onto an item that already exists in this project (e.g. tracing a
// curb line already outlined for the asphalt next to it). Excludes count
// items (a single-location marker has no use for a multi-point trace) and,
// if the selection is too short to close as a polygon, area items too - the
// same validation openCopySelectionModal applies when the type is fixed by
// the picked item instead of a dropdown.
function openCopySelectionToExistingModal() {
  const points = getSelectedEditPoints();
  if (points.length < 2) {
    showToast('Select at least 2 points to copy.', 'error');
    return;
  }
  const candidates = takeoffItems.filter((i) => i.type !== 'count' && (points.length >= 3 || i.type !== 'area'));

  openModal(`
    <h2>Copy selection to existing item</h2>
    <p class="muted">Adds a new instance from these ${points.length} selected points to an item that already exists.</p>
    <input type="text" id="copy-existing-search" placeholder="Search take-offs..." autocomplete="off" style="width:100%;">
    <div class="takeoff-template-picker-list" id="copy-existing-list"></div>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Cancel</button>
    </div>
  `);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  const searchInput = document.getElementById('copy-existing-search');
  const listEl = document.getElementById('copy-existing-list');
  searchInput.focus();

  function renderList() {
    const term = searchInput.value.trim().toLowerCase();
    const matches = term ? candidates.filter((i) => i.name.toLowerCase().includes(term)) : candidates;
    if (matches.length === 0) {
      listEl.innerHTML = `<p class="muted">${candidates.length === 0 ? 'No compatible take-off items in this project yet.' : 'No take-offs match your search.'}</p>`;
      return;
    }
    listEl.innerHTML = matches
      .map(
        (i) => `
        <button type="button" class="takeoff-template-picker-row" data-id="${i.id}">
          <span class="takeoff-color-dot" style="background:${i.color};"></span>
          <span class="takeoff-template-picker-name">${escapeHtml(i.name)}</span>
          <span class="muted">${i.type}</span>
        </button>`
      )
      .join('');
    listEl.querySelectorAll('.takeoff-template-picker-row').forEach((row) => {
      row.addEventListener('click', async () => {
        const item = candidates.find((i) => i.id === Number(row.dataset.id));
        row.disabled = true;
        try {
          const quantity = item.type === 'area' ? polygonAreaFeet(points) : polylineLengthFeet(points);
          const perimeter = item.type === 'area' ? polygonPerimeterFeet(points) : null;
          await api('POST', `/api/projects/${projectId}/sheets/${sheetId}/take-off-instances`, {
            item_id: item.id,
            geometry: { points },
            quantity,
            perimeter,
          });
          closeModal();
          showToast(`Added to "${item.name}".`, 'success');
          await Promise.all([loadTakeoffItems(), loadSheetTakeoffInstances()]);
          renderTakeoffPane();
        } catch (err) {
          showToast(`Failed to add: ${err.message}`, 'error');
          row.disabled = false;
        }
      });
    });
  }
  searchInput.addEventListener('input', renderList);
  renderList();
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

// Arms an item ready for a brand-new instance - shared by the pane's row
// click and the right-click context menu's "Activate Item".
function activateTakeoffItem(item) {
  if (!scaleFeetPerInch) {
    showToast('Set a scale first.', 'error');
    return;
  }
  // A plain click on the already-active item is still meaningful when a
  // multi-select is in effect - it drops back down to just this one item.
  if (item.id === activeTakeoffItemId && !continuingInstanceId && multiSelectExtraItemIds.size === 0) return;
  exitTakeoffEditMode();
  clearMeasure();
  stopMeasureTool();
  if (markupsController) markupsController.forceSelectTool();
  clearTakeoffDraft();
  continuingInstanceId = null;
  continuingSeedPointCount = 0;
  subtractingIntoInstanceId = null;
  takeoffTool = item.type;
  activeTakeoffItemId = item.id;
  selectedTakeoffItemId = item.id;
  multiSelectExtraItemIds = new Set();
  multiSelectExtraAssemblyIds = new Set();
  lastPlacedInstanceId = null;
  persistActiveTakeoff();
  updateTakeoffToolbar();
  renderTakeoffPane();
}

// A plain click on a pane row - selects it (highlighted row, bottom bar with
// a Start button) without arming placement, mirroring how clicking a placed
// shape on the drawing only enters edit mode rather than re-arming the tool.
function selectTakeoffItemRow(item) {
  if (item.id === selectedTakeoffItemId) return;
  selectedTakeoffItemId = item.id;
  renderTakeoffPane();
}

// Arms an assembly for box-only placement (takeoffTool === 'assembly-box') -
// mirrors activateTakeoffItem, but disarms via the same sequence
// armScaleZoneDraw already established (exit edit mode, clear measure,
// clear markup tool) since an assembly isn't a single-type placement tool.
function activateAssembly(assembly) {
  if (!scaleFeetPerInch) {
    showToast('Set a scale first.', 'error');
    return;
  }
  const hasAnyLink = ['area', 'top', 'bottom', 'left', 'right'].some((k) => assembly[`${k}_item_id`]);
  if (!hasAnyLink) {
    showToast('Link at least one item before drawing with this assembly.', 'error');
    return;
  }
  if (assembly.id === activeAssemblyId) return;
  deactivateTakeoff();
  exitTakeoffEditMode();
  clearMeasure();
  stopMeasureTool();
  if (markupsController) markupsController.forceSelectTool();
  clearTakeoffDraft();
  activeAssemblyId = assembly.id;
  selectedAssemblyId = assembly.id;
  selectedTakeoffItemId = null;
  takeoffTool = 'assembly-box';
  // Pin every linked item so it's visible (and thus highlightable, see
  // renderTakeoffPane's isAssemblyLinked) even before the first box places
  // any instances of it on this sheet - same reasoning as pinning a
  // just-armed plain item (see renderTakeoffPane).
  let pinnedChanged = false;
  for (const k of ['area', 'top', 'bottom', 'left', 'right']) {
    const itemId = assembly[`${k}_item_id`];
    if (itemId && !sheetPinnedItemIds.has(itemId)) {
      sheetPinnedItemIds.add(itemId);
      pinnedChanged = true;
    }
  }
  if (pinnedChanged) savePinnedTakeoffItemIds();
  updateTakeoffToolbar();
  renderTakeoffPane();
}

// A plain click on an assembly's pane row - selects without arming, mirrors
// selectTakeoffItemRow.
function selectAssemblyRow(assembly) {
  if (assembly.id === selectedAssemblyId) return;
  selectedTakeoffItemId = null;
  selectedAssemblyId = assembly.id;
  renderTakeoffPane();
}

// ---------- Assembly box placement (box-only, no point-to-point) ----------
let assemblyBoxFirstCorner = null; // set on the first of the 2 clicks, cleared on finish/Escape

function ensureAssemblyDraftLayer() {
  const svg = document.getElementById('markup-svg');
  let g = svg.querySelector('#assembly-draft-layer');
  if (!g) {
    g = measureSvgNs('g');
    g.id = 'assembly-draft-layer';
    svg.appendChild(g);
  }
  return g;
}

function redrawAssemblyDraft(livePt) {
  const g = ensureAssemblyDraftLayer();
  g.innerHTML = '';
  if (!assemblyBoxFirstCorner || !livePt) return;
  const r = rectFromCorners(assemblyBoxFirstCorner, livePt);
  const scale = zoomPan ? zoomPan.state.scale : 1;
  const assembly = takeoffAssemblies.find((a) => a.id === activeAssemblyId);
  const rect = measureSvgNs('rect');
  rect.setAttribute('x', r.x);
  rect.setAttribute('y', r.y);
  rect.setAttribute('width', r.width);
  rect.setAttribute('height', r.height);
  rect.setAttribute('fill', (assembly && assembly.area_item_id) ? 'rgba(37,99,235,0.12)' : 'none');
  rect.setAttribute('stroke', '#2563eb');
  rect.setAttribute('stroke-width', 2 / scale);
  rect.setAttribute('stroke-dasharray', `${5 / scale} ${3 / scale}`);
  g.appendChild(rect);
}

// Builds geometry/quantity/perimeter for each of the 5 slots exactly like
// any other take-off placement does (polygonAreaFeet/polygonPerimeterFeet
// for the area slot's 4-corner polygon, polylineLengthFeet for each edge's
// 2-point segment) - these already resolve scale zones internally, so
// nothing extra is needed here for that. Unlinked slots are simply skipped.
// left/right are always independent slots (can point at the same item,
// which just means that item gets two instances - no special-casing needed).
async function submitAssemblyInstances(assembly, box) {
  const { left, right, top, bottom } = box;
  const corners = [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
  const slots = [
    { key: 'area', itemId: assembly.area_item_id, points: corners },
    { key: 'top', itemId: assembly.top_item_id, points: [{ x: left, y: top }, { x: right, y: top }] },
    { key: 'bottom', itemId: assembly.bottom_item_id, points: [{ x: left, y: bottom }, { x: right, y: bottom }] },
    { key: 'left', itemId: assembly.left_item_id, points: [{ x: left, y: top }, { x: left, y: bottom }] },
    { key: 'right', itemId: assembly.right_item_id, points: [{ x: right, y: top }, { x: right, y: bottom }] },
  ].filter((s) => s.itemId);

  if (slots.length === 0) {
    showToast('No slots linked - nothing to place.', 'error');
    return;
  }

  try {
    await Promise.all(
      slots.map((s) => {
        const isArea = s.key === 'area';
        const quantity = isArea ? polygonAreaFeet(s.points) : polylineLengthFeet(s.points);
        const perimeter = isArea ? polygonPerimeterFeet(s.points) : null;
        return api('POST', `/api/projects/${projectId}/sheets/${sheetId}/take-off-instances`, {
          item_id: s.itemId,
          geometry: { points: s.points },
          quantity,
          perimeter,
        });
      })
    );
    await Promise.all([loadSheetTakeoffInstances(), loadTakeoffItems()]);
    renderTakeoffPane();
    showToast(`Placed on ${slots.length} item${slots.length === 1 ? '' : 's'}.`, 'success');
  } catch (err) {
    showToast(`Failed to save assembly placement: ${err.message}`, 'error');
  }
}

// Gated entirely on takeoffTool === 'assembly-box' (only ever set by
// activateAssembly), so this never interferes with the regular take-off/
// measure/markup listeners on the same element - registered once in init(),
// same pattern as setupScaleZoneDrawInteraction.
function setupAssemblyDrawInteraction() {
  const svg = document.getElementById('markup-svg');

  svg.addEventListener(
    'mousedown',
    (e) => {
      if (takeoffTool !== 'assembly-box' || !activeAssemblyId || e.button !== 0) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      const pt = getMeasureSvgPoint(e);
      if (!assemblyBoxFirstCorner) {
        assemblyBoxFirstCorner = pt;
        redrawAssemblyDraft(pt);
        return;
      }
      const box = rectFromCorners(assemblyBoxFirstCorner, pt);
      assemblyBoxFirstCorner = null;
      ensureAssemblyDraftLayer().innerHTML = '';
      const assembly = takeoffAssemblies.find((a) => a.id === activeAssemblyId);
      if (assembly) {
        submitAssemblyInstances(assembly, {
          left: box.x,
          top: box.y,
          right: box.x + box.width,
          bottom: box.y + box.height,
        });
      }
      // Stays armed - box mode is a continuous-placement tool, same as area
      // box mode elsewhere, so the next 2 clicks start the next box.
    },
    true
  );

  svg.addEventListener('mousemove', (e) => {
    if (takeoffTool !== 'assembly-box' || !assemblyBoxFirstCorner) return;
    redrawAssemblyDraft(getMeasureSvgPoint(e));
  });
  // Escape handling for an in-progress box lives in setupTakeoffInteraction's
  // existing takeoffTool Escape branch (registered earlier) - a separate
  // listener here would never get a chance to run first, since that one
  // already calls deactivateTakeoff() and clears takeoffTool before this
  // one's condition could even be checked.
}

// Shift+click in the pane - adds/removes a same-type item from the current
// placement's target set (see multiSelectExtraItemIds above). Falls back to
// a normal single activation when nothing is armed yet, since there's
// nothing to "add" to.
function toggleMultiSelectExtraItem(item) {
  if (!activeTakeoffItemId) {
    activateTakeoffItem(item);
    return;
  }
  // Subtract mode is the one exception to "no changing selection mid-trace" -
  // shift+click there is how you pick which item(s) get the same traced
  // shape added as new area while the anchor instance gets it subtracted
  // (see finishTakeoffInstance's subtractingIntoInstanceId branch).
  if (takeoffPoints.length > 0 || continuingInstanceId) {
    showToast('Finish or cancel the current trace before changing selected items.', 'error');
    return;
  }
  if (item.id === activeTakeoffItemId) return; // already the anchor item
  const anchorItem = takeoffItems.find((i) => i.id === activeTakeoffItemId);
  if (!anchorItem || item.type !== anchorItem.type) {
    showToast(`Only ${anchorItem ? anchorItem.type : 'same-type'} items can be combined in one trace.`, 'error');
    return;
  }
  if (multiSelectExtraItemIds.has(item.id)) multiSelectExtraItemIds.delete(item.id);
  else multiSelectExtraItemIds.add(item.id);
  renderTakeoffPane();
}

// Shift+click on an assembly row while subtracting an area - arms that
// assembly to also get a full box placement (all its linked slots) using the
// same box the subtraction hole traces, so a masonry-wall opening can
// simultaneously carve the hole and count a window assembly from one trace
// (see finishTakeoffInstance's subtractingIntoInstanceId branch). Gated on
// Box placement mode, since an assembly's slots only make sense as real
// left/top/right/bottom edges - a freehand polygon has no such edges.
function toggleMultiSelectExtraAssembly(assembly) {
  if (!subtractingIntoInstanceId) {
    showToast('Shift+click an assembly while subtracting an area to pair it with the same trace.', 'error');
    return;
  }
  if (takeoffPlacementMode !== 'box') {
    showToast('Switch to Box placement mode to pair an assembly with a subtraction.', 'error');
    return;
  }
  if (takeoffPoints.length > 0) {
    showToast('Finish or cancel the current trace before changing selected assemblies.', 'error');
    return;
  }
  const hasAnyLink = ['area', 'top', 'bottom', 'left', 'right'].some((k) => assembly[`${k}_item_id`]);
  if (!hasAnyLink) {
    showToast('Link at least one item before pairing this assembly.', 'error');
    return;
  }
  if (multiSelectExtraAssemblyIds.has(assembly.id)) multiSelectExtraAssemblyIds.delete(assembly.id);
  else multiSelectExtraAssemblyIds.add(assembly.id);
  renderTakeoffAssembliesList();
  // The paired-count suffix on the bottom action bar (see
  // showTakeoffItemActionsBar) lives in the items pane's own render pass,
  // not this assembly list's - refresh it too so the count shows up live.
  renderTakeoffPane();
}

// "Continue Item" from the right-click menu - re-opens an already-placed
// instance as the live draft, seeded with its existing points, so the next
// clicks extend that same shape from its last point. Finishing (see
// finishTakeoffInstance) PATCHes this instance instead of creating a new one.
function continueTakeoffInstance(instance) {
  if (!scaleFeetPerInch) {
    showToast('Set a scale first.', 'error');
    return;
  }
  exitTakeoffEditMode();
  clearMeasure();
  stopMeasureTool();
  if (markupsController) markupsController.forceSelectTool();
  takeoffTool = instance.item_type;
  activeTakeoffItemId = instance.item_id;
  multiSelectExtraItemIds = new Set();
  takeoffPoints = instance.geometry.points.map((p) => ({ ...p }));
  continuingSeedPointCount = takeoffPoints.length;
  awaitingArcThrough = false;
  arcThroughPoint = null;
  continuingInstanceId = instance.id;
  subtractingIntoInstanceId = null;
  multiSelectExtraAssemblyIds = new Set();
  lastPlacedInstanceId = null;
  persistActiveTakeoff();
  updateTakeoffToolbar();
  redrawTakeoff();
  renderTakeoffPane();
}

// "Subtract Area" from the right-click menu - arms the same area-placement
// flow as normal, but finishing (see finishTakeoffInstance) appends the
// traced points as a new hole on this instance instead of creating or
// extending an outer boundary.
function subtractFromTakeoffInstance(instance) {
  exitTakeoffEditMode();
  clearMeasure();
  stopMeasureTool();
  if (markupsController) markupsController.forceSelectTool();
  clearTakeoffDraft();
  continuingInstanceId = null;
  continuingSeedPointCount = 0;
  takeoffTool = 'area';
  activeTakeoffItemId = instance.item_id;
  multiSelectExtraItemIds = new Set();
  multiSelectExtraAssemblyIds = new Set();
  subtractingIntoInstanceId = instance.id;
  lastPlacedInstanceId = null;
  persistActiveTakeoff();
  updateTakeoffToolbar();
  renderTakeoffPane();
}

// Full disarm - Escape, the pane's Stop button, or switching to measure/
// markup all go through this. Draft points/holes/multi-select drop in one
// step, no two-tier clear like measure's points-only-vs-tool-off - but the
// item itself stays selected (see below) rather than vanishing, so Stop
// really only means "stop placing," not "forget what I was looking at."
function deactivateTakeoff() {
  if (!takeoffTool && !activeTakeoffItemId && !activeAssemblyId) return;
  // Stopping only disarms placement - the item (or assembly) stays selected
  // (bottom bar now offering Start again) rather than vanishing outright. A
  // second Escape with nothing armed is what fully clears the selection (see
  // the keydown handler in setupTakeoffInteraction).
  selectedTakeoffItemId = activeTakeoffItemId;
  selectedAssemblyId = activeAssemblyId || selectedAssemblyId;
  activeAssemblyId = null;
  takeoffTool = null;
  activeTakeoffItemId = null;
  multiSelectExtraItemIds = new Set();
  multiSelectExtraAssemblyIds = new Set();
  lastPlacedInstanceId = null;
  continuingInstanceId = null;
  continuingSeedPointCount = 0;
  subtractingIntoInstanceId = null;
  clearTakeoffDraft();
  localStorage.removeItem(takeoffStorageKey());
  document.querySelectorAll('#takeoff-tool-grid .tool-btn').forEach((b) => b.classList.remove('active'));
  hideTakeoffCrosshair();
  updateTakeoffToolbar();
  renderTakeoffPane();
}

async function submitTakeoffInstance(itemId, points, quantity, perimeter) {
  try {
    const { instance } = await api('POST', `/api/projects/${projectId}/sheets/${sheetId}/take-off-instances`, {
      item_id: itemId,
      geometry: { points },
      quantity,
      perimeter: perimeter ?? null,
    });
    lastPlacedInstanceId = instance.id;
    await Promise.all([loadSheetTakeoffInstances(), loadTakeoffItems()]);
    renderTakeoffPane();
  } catch (err) {
    showToast(`Failed to save take-off: ${err.message}`, 'error');
  }
}

// Multi-select placement (see multiSelectExtraItemIds) - the exact same
// geometry/quantity POSTed once per selected item, since raw geometry is
// identical regardless of which item's formula later converts it. Backspace
// undo only reaches the last of the batch (lastPlacedInstanceId is single-
// valued) - a known, minor limitation, not worth an array of "last placed"
// ids just for this one edge case.
async function submitTakeoffInstances(itemIds, points, quantity, perimeter) {
  try {
    const results = await Promise.all(
      itemIds.map((itemId) =>
        api('POST', `/api/projects/${projectId}/sheets/${sheetId}/take-off-instances`, {
          item_id: itemId,
          geometry: { points },
          quantity,
          perimeter: perimeter ?? null,
        })
      )
    );
    lastPlacedInstanceId = results[results.length - 1].instance.id;
    await Promise.all([loadSheetTakeoffInstances(), loadTakeoffItems()]);
    renderTakeoffPane();
    showToast(`Placed on ${itemIds.length} items.`, 'success');
  } catch (err) {
    showToast(`Failed to save take-off: ${err.message}`, 'error');
  }
}

// Shared by the point/segment editor (applyTakeoffEditGeometry) and
// "Continue Item" finishing an extended draft - both update an existing
// instance's geometry+quantity rather than creating a new row.
async function patchTakeoffInstance(id, points, quantity, holes, perimeter) {
  try {
    const geometry = holes && holes.length ? { points, holes } : { points };
    await api('PATCH', `/api/take-off-instances/${id}`, { geometry, quantity, perimeter: perimeter ?? null });
    await Promise.all([loadSheetTakeoffInstances(), loadTakeoffItems()]);
    return true;
  } catch (err) {
    showToast(`Failed to save take-off: ${err.message}`, 'error');
    return false;
  }
}

// The naming modal already ran before the tool was armed (see
// setupTakeoffTools), so activeTakeoffItemId is always set by the time a
// measurement is actually being placed - this just records the instance.
// If continuingInstanceId is set ("Continue Item" from the right-click
// menu), this extends that existing instance instead of creating a new one.
function finishTakeoffInstance() {
  const points = [...takeoffPoints];
  clearTakeoffDraft();

  // "Subtract Area" - the traced points become a new hole on the target
  // instance rather than a new instance or an extension of its outer bounds.
  // Stays armed for further holes on the same instance (a user cutting out
  // several openings at once shouldn't have to re-open the context menu
  // each time) until they explicitly Stop the item.
  if (subtractingIntoInstanceId) {
    const id = subtractingIntoInstanceId;
    const target = sheetTakeoffInstances.find((i) => i.id === id);
    if (target) {
      const holes = [...(target.geometry.holes || []), points];
      const quantity = netAreaFeet(target.geometry.points, holes);
      // The outer boundary is untouched by subtracting a hole, so its
      // perimeter doesn't change - carry the existing value through as-is.
      patchTakeoffInstance(id, target.geometry.points, quantity, holes, target.perimeter).then((ok) => {
        if (ok) renderTakeoffPane();
      });
    }
    // Shift-selected extra items (see toggleMultiSelectExtraItem) don't get
    // a hole - subtraction only makes sense against the one target instance -
    // they get the identical traced shape added as a brand-new area instance
    // instead, so "carve this opening out of A" and "count this same opening
    // as new area for B" happen from a single trace.
    if (multiSelectExtraItemIds.size > 0) {
      submitTakeoffInstances([...multiSelectExtraItemIds], points, polygonAreaFeet(points), polygonPerimeterFeet(points));
    }
    // Shift-selected extra assemblies (see toggleMultiSelectExtraAssembly) -
    // the same box gets submitted as a full assembly placement (all its
    // linked slots), so "carve this window out of the wall" and "count this
    // window assembly" happen from the same trace. Only reachable in Box
    // placement mode (enforced when the assembly was selected), so `points`
    // is always the 4 corners of a rectangle - bounding box == the traced
    // shape, not an approximation of a freehand polygon.
    if (multiSelectExtraAssemblyIds.size > 0) {
      const xs = points.map((p) => p.x);
      const ys = points.map((p) => p.y);
      const box = { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
      for (const assemblyId of multiSelectExtraAssemblyIds) {
        const assembly = takeoffAssemblies.find((a) => a.id === assemblyId);
        if (assembly) submitAssemblyInstances(assembly, box);
      }
    }
    return;
  }

  if (continuingInstanceId) {
    const id = continuingInstanceId;
    continuingInstanceId = null;
    continuingSeedPointCount = 0;
    // Preserve any existing holes when the outer boundary is extended -
    // the net area still needs to subtract them, not just the new outline.
    const target = sheetTakeoffInstances.find((i) => i.id === id);
    const holes = target && target.geometry.holes;
    const quantity = takeoffTool === 'area' ? netAreaFeet(points, holes) : polylineLengthFeet(points);
    const perimeter = takeoffTool === 'area' ? polygonPerimeterFeet(points) : null;
    patchTakeoffInstance(id, points, quantity, holes, perimeter).then((ok) => {
      if (ok) renderTakeoffPane();
    });
  } else {
    const quantity = takeoffTool === 'area' ? polygonAreaFeet(points) : polylineLengthFeet(points);
    const perimeter = takeoffTool === 'area' ? polygonPerimeterFeet(points) : null;
    if (multiSelectExtraItemIds.size > 0) {
      submitTakeoffInstances([activeTakeoffItemId, ...multiSelectExtraItemIds], points, quantity, perimeter);
    } else {
      submitTakeoffInstance(activeTakeoffItemId, points, quantity, perimeter);
    }
  }
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
      // Assembly box placement is handled entirely by its own dedicated
      // mousedown listener (setupAssemblyDrawInteraction) - takeoffTool is
      // truthy while it's armed, so without this explicit exclusion this
      // generic click handler would ALSO process the same click (it only
      // recognizes 'linear'/'perimeter'/'area'/'count', so an unrecognized
      // 'assembly-box' value falls through into the general point-tracing
      // path below, silently accumulating stray points into takeoffPoints
      // and drawing them as a connecting dashed line across every box drawn).
      if (takeoffTool === 'assembly-box') return;
      e.stopPropagation();
      let pt = getMeasureSvgPoint(e);
      let pointSnapped = false;
      if (snapToPointsEnabled) {
        const nearby = findNearbyTakeoffSnapPoint(pt);
        if (nearby) {
          pt = { x: nearby.x, y: nearby.y };
          pointSnapped = true;
        }
      }

      // Arc mode (armed by pressing "A" - see the keydown handler below):
      // the next click is a point the curve passes through, and the one
      // after that is where it ends. No angle-snap here - a curve is
      // inherently not orthogonal.
      if (awaitingArcThrough) {
        awaitingArcThrough = false;
        arcThroughPoint = pt;
        redrawTakeoff();
        return;
      }
      if (arcThroughPoint) {
        const start = takeoffPoints[takeoffPoints.length - 1];
        takeoffPoints.push(...arcPointsThrough(start, arcThroughPoint, pt));
        arcThroughPoint = null;
        redrawTakeoff();
        // A curved "linear" take-off is still just a start and an end -
        // the arc supplies both in one motion, so finish immediately,
        // same as the always-exactly-2-points case below.
        if (takeoffTool === 'linear' && !continuingInstanceId) finishTakeoffInstance();
        return;
      }

      // One click = one instance (quantity always 1) - no multi-point draft,
      // stays armed immediately for the next count.
      if (takeoffTool === 'count') {
        if (multiSelectExtraItemIds.size > 0) {
          submitTakeoffInstances([activeTakeoffItemId, ...multiSelectExtraItemIds], [pt], 1);
        } else {
          submitTakeoffInstance(activeTakeoffItemId, [pt], 1);
        }
        return;
      }

      // Shift locks the new point to 0/45/90/... relative to the last
      // placed point - nothing to snap against for the very first point.
      // axisLockPinned inverts the relationship: snap by default, Shift
      // temporarily releases it - see the bottom take-off toolbar.
      const inBoxPlacement = takeoffPlacementMode === 'box' && takeoffTool === 'area' && !continuingInstanceId;
      const wantsSnap = axisLockPinned ? !e.shiftKey : e.shiftKey;
      if (wantsSnap && takeoffPoints.length > 0 && !inBoxPlacement && !pointSnapped) {
        pt = snapToAngle(takeoffPoints[takeoffPoints.length - 1], pt);
      }

      // Box mode: 2 clicks (opposite corners) generate a rectangle instead of
      // point-by-point tracing. Only meaningful for a fresh area boundary or
      // a fresh subtraction hole - "Continue Item" always uses point-by-point,
      // since a box has no clear meaning when extending an existing shape.
      if (takeoffPlacementMode === 'box' && takeoffTool === 'area' && !continuingInstanceId) {
        if (takeoffPoints.length === 0) {
          takeoffPoints.push(pt);
          redrawTakeoff();
          return;
        }
        takeoffPoints = boxCorners(takeoffPoints[0], pt);
        finishTakeoffInstance();
        return;
      }

      // A fresh linear instance is always exactly 2 clicks; a linear
      // instance being extended via "Continue Item" already starts with 2+
      // seeded points, so it behaves like perimeter/area instead - keep
      // accumulating until the general close-to-last-point/Enter finish
      // below fires.
      if (takeoffTool === 'linear' && !continuingInstanceId) {
        takeoffPoints.push(pt);
        redrawTakeoff();
        if (takeoffPoints.length === 2) finishTakeoffInstance();
        return;
      }

      // See continuingSeedPointCount's comment - while continuing, this
      // can't fire until a point has actually been placed past the seeded
      // ones, or the very first extension click (naturally right next to
      // the original endpoint) would silently finish the draft instead of
      // extending it.
      if (takeoffPoints.length > 2 && takeoffPoints.length > continuingSeedPointCount) {
        const last = takeoffPoints[takeoffPoints.length - 1];
        const scale = zoomPan ? zoomPan.state.scale : 1;
        if (Math.hypot(pt.x - last.x, pt.y - last.y) < 6 / scale) {
          finishTakeoffInstance();
          return;
        }
      }
      takeoffPoints.push(pt);
      redrawTakeoff();
    },
    true
  );

  // Shared by the mouse preview below and the touch hold-preview further
  // down, so both show exactly the same snapped position the eventual click
  // will actually place - factored out rather than duplicated so they can't
  // drift out of sync with each other.
  function computeTakeoffPreviewPoint(pt, e) {
    let pointSnapped = false;
    if (snapToPointsEnabled) {
      const nearby = findNearbyTakeoffSnapPoint(pt);
      if (nearby) {
        pt = { x: nearby.x, y: nearby.y };
        pointSnapped = true;
      }
    }
    const inBoxPlacement = takeoffPlacementMode === 'box' && takeoffTool === 'area' && !continuingInstanceId;
    const wantsSnap = axisLockPinned ? !e.shiftKey : e.shiftKey;
    if (wantsSnap && !inBoxPlacement && !awaitingArcThrough && !arcThroughPoint && !pointSnapped) {
      pt = snapToAngle(takeoffPoints[takeoffPoints.length - 1], pt);
    }
    return pt;
  }

  svg.addEventListener('mousemove', (e) => {
    if (!takeoffTool || takeoffPoints.length === 0) return;
    const pt = computeTakeoffPreviewPoint(getMeasureSvgPoint(e), e);
    redrawTakeoff(pt);
  });

  // Touch-only precision aid: iPad has no live mousemove preview (a touch
  // doesn't generate one until it lifts), and a fingertip covers the exact
  // spot you're trying to place a point on. Holding still for TAKEOFF_HOLD_MS
  // instead of tapping immediately brings up the corner magnifier and keeps
  // it (plus the normal rubber-band preview) tracking the finger live, so
  // you can slide into position before lifting.
  //
  // Committing the point on release can't just rely on iOS's normal
  // tap->click synthesis the way a quick tap does - that synthesis is
  // suppressed once a touch has actually moved, which is exactly what
  // happens every time this feature's drag-to-adjust is used. So once the
  // hold has engaged, touchend explicitly preventDefaults (killing whatever
  // native synthesis might otherwise fire, avoiding a double-placement) and
  // dispatches its own synthetic click at the final position instead -
  // reusing the click handler above completely unchanged rather than
  // duplicating its placement logic.
  const TAKEOFF_HOLD_MS = 300;
  let takeoffHoldTimer = null;
  let takeoffHoldActive = false;

  svg.addEventListener(
    'touchstart',
    (e) => {
      takeoffHoldActive = false;
      clearTimeout(takeoffHoldTimer);
      if (!takeoffTool || takeoffTool === 'assembly-box' || e.touches.length !== 1) return;
      takeoffHoldTimer = setTimeout(() => {
        takeoffHoldActive = true;
        const pt = takeoffPoints.length > 0 ? computeTakeoffPreviewPoint(getMeasureSvgPoint(e), e) : getMeasureSvgPoint(e);
        magnifierLens.showAtCorner(pt);
        if (takeoffPoints.length > 0) redrawTakeoff(pt);
      }, TAKEOFF_HOLD_MS);
    },
    { passive: true }
  );
  svg.addEventListener(
    'touchmove',
    (e) => {
      if (!takeoffHoldActive || e.touches.length !== 1) return;
      const pt = takeoffPoints.length > 0 ? computeTakeoffPreviewPoint(getMeasureSvgPoint(e), e) : getMeasureSvgPoint(e);
      magnifierLens.updateCorner(pt);
      if (takeoffPoints.length > 0) redrawTakeoff(pt);
    },
    { passive: true }
  );
  svg.addEventListener(
    'touchend',
    (e) => {
      clearTimeout(takeoffHoldTimer);
      if (!takeoffHoldActive) return; // quick tap - untouched native click synthesis places it, same as always
      takeoffHoldActive = false;
      magnifierLens.hideCorner();
      e.preventDefault();
      const t = e.changedTouches && e.changedTouches[0];
      if (t) {
        svg.dispatchEvent(new MouseEvent('click', { clientX: t.clientX, clientY: t.clientY, bubbles: true, cancelable: true }));
      }
    },
    { passive: false }
  );
  svg.addEventListener('touchcancel', () => {
    clearTimeout(takeoffHoldTimer);
    if (takeoffHoldActive) magnifierLens.hideCorner();
    takeoffHoldActive = false;
  });

  document.addEventListener('keydown', (e) => {
    // A fresh linear take-off is always exactly 2 clicks (finished
    // automatically, see the click handler above), so Enter has nothing to
    // do there - but a linear instance being extended via "Continue Item"
    // behaves like perimeter/area (accumulates points), so Enter should
    // still finish it same as those.
    if (e.key === 'Enter' && takeoffTool && (takeoffTool !== 'linear' || continuingInstanceId) && takeoffPoints.length >= 3)
      finishTakeoffInstance();

    if ((e.key === 'a' || e.key === 'A') && takeoffTool) {
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return; // don't hijack typing elsewhere
      // Arcs need a real "from" point already placed, don't apply to count
      // (no multi-point draft to curve), and box mode already has its own
      // 2-click shortcut for the one shape it draws (a rectangle).
      if (takeoffTool === 'count') return;
      if (takeoffPlacementMode === 'box' && takeoffTool === 'area' && !continuingInstanceId) return;
      if (takeoffPoints.length === 0) return;
      e.preventDefault();
      awaitingArcThrough = true;
      arcThroughPoint = null;
      showToast('Click a point on the curve, then click where it ends.');
    }

    if (e.key === 'Escape' && takeoffTool) {
      // Back out of an in-progress arc first - Escape shouldn't nuke an
      // otherwise-fine draft just because the user changed their mind about
      // the curve. Same reasoning for an assembly box mid-draw (first corner
      // placed, second not yet clicked) - a stray first click shouldn't
      // disarm the whole assembly.
      if (awaitingArcThrough || arcThroughPoint) {
        awaitingArcThrough = false;
        arcThroughPoint = null;
        redrawTakeoff();
        return;
      }
      if (takeoffTool === 'assembly-box' && assemblyBoxFirstCorner) {
        assemblyBoxFirstCorner = null;
        ensureAssemblyDraftLayer().innerHTML = '';
        return;
      }
      deactivateTakeoff();
    } else if (e.key === 'Escape' && (selectedTakeoffItemId || selectedAssemblyId)) {
      // Nothing armed - just a pane row selected (see selectTakeoffItemRow/
      // selectAssemblyRow). Escape clears that too, same as it fully disarms
      // an active placement above, so it always means "back out completely"
      // either way.
      selectedTakeoffItemId = null;
      selectedAssemblyId = null;
      renderTakeoffPane();
    }

    if (e.key === 'Backspace' && takeoffTool) {
      // Ignore Backspace while an actual text field has focus (e.g. the
      // naming modal's name input) - it should delete text there, not undo.
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      if (arcThroughPoint) {
        arcThroughPoint = null;
        awaitingArcThrough = true; // back one step, not all the way out
        redrawTakeoff();
      } else if (awaitingArcThrough) {
        awaitingArcThrough = false;
        redrawTakeoff();
      } else if (takeoffTool === 'count') {
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

// prefill (optional, used by "From Template"): { name, color, shape,
// properties, formula, outputLabel } - pre-populates everything including
// the Advanced section, which starts expanded whenever there's anything to
// show there (existing properties/formula, or arriving from a template).
function openTakeoffNamingModal(type, onDone, prefill) {
  const isCount = type === 'count';
  let selectedShape = isCount ? (prefill && prefill.shape) || 'square' : null;
  openModal(`
    <h2>New take-off item</h2>
    <div class="field">
      <label>Name</label>
      <input id="takeoff-name" autocomplete="off" placeholder="e.g. 2x4 top plate, or [Width] x [Height] Footing">
      <div class="takeoff-name-preview muted" id="takeoff-name-preview" style="display:none;"></div>
    </div>
    <div class="field">
      <label>Color</label>
      <input type="color" id="takeoff-color" value="${prefill ? prefill.color : nextTakeoffColor()}">
    </div>
    ${
      isCount
        ? `<div class="field">
             <label>Shape</label>
             <div class="icon-tool-grid" id="takeoff-shape-grid"></div>
           </div>`
        : ''
    }
    <div id="takeoff-advanced-root"></div>
    <p class="error" id="takeoff-name-error" style="display:none;"></p>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Cancel</button>
      <button class="primary" type="button" id="modal-create">Create</button>
    </div>
  `);
  document.getElementById('takeoff-name').value = (prefill && prefill.name) || '';
  document.getElementById('takeoff-name').focus();

  const advancedRoot = document.getElementById('takeoff-advanced-root');
  const advanced = setupAdvancedFields(advancedRoot, {
    properties: prefill ? prefill.properties : [],
    formula: prefill ? prefill.formula : '',
    outputLabel: prefill ? prefill.outputLabel : '',
    expanded: !!prefill && (!!prefill.formula || (prefill.properties && prefill.properties.length > 0)),
    folders: takeoffFoldersCache || [],
    folderId: null,
    onCreateFolder: createTakeoffFolder,
  });
  wireNamePreview(document.getElementById('takeoff-name'), document.getElementById('takeoff-name-preview'), advancedRoot, advanced);

  // "Save as template" is specific to this one modal (not part of the
  // shared setupAdvancedFields component, which also backs the edit and
  // template modals where it wouldn't make sense) - appended directly into
  // the Advanced body it just rendered, rather than sitting outside it as
  // its own always-visible section.
  const advancedBody = advancedRoot.querySelector('#ta-body');
  const saveTemplateLabel = document.createElement('label');
  saveTemplateLabel.className = 'permission-option';
  saveTemplateLabel.innerHTML = `<input type="checkbox" id="takeoff-save-template"><span><b>Save as reusable template</b></span>`;
  advancedBody.appendChild(saveTemplateLabel);

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
    const rawName = document.getElementById('takeoff-name').value.trim();
    const color = document.getElementById('takeoff-color').value;
    const errEl = document.getElementById('takeoff-name-error');
    if (!rawName) {
      errEl.textContent = 'Name is required.';
      errEl.style.display = 'block';
      return;
    }
    const advancedResult = advanced.validate();
    if (!advancedResult.ok) return; // setupAdvancedFields already shows its own inline error
    const { properties, formula, outputLabel, folderId } = advanced.getValue();
    // The actual item gets [Property] placeholders resolved to real values
    // ("2 x 2.5 Footing"); a template saved alongside it keeps the literal
    // bracket syntax so it stays reusable next time with different values.
    const name = resolveTakeoffName(rawName, properties);
    const saveAsTemplate = document.getElementById('takeoff-save-template').checked;

    const createBtn = document.getElementById('modal-create');
    createBtn.disabled = true;
    try {
      const { item } = await api('POST', `/api/projects/${projectId}/take-off-items`, {
        name,
        type,
        color,
        shape: selectedShape,
        properties,
        formula: formula || null,
        output_label: outputLabel || null,
        folder_id: folderId,
      });
      if (saveAsTemplate) {
        try {
          await api('POST', '/api/take-off-templates', {
            name: rawName,
            type,
            color,
            shape: selectedShape,
            properties,
            formula: formula || null,
            output_label: outputLabel || null,
          });
        } catch (templateErr) {
          showToast(`Item created, but saving the template failed: ${templateErr.message}`, 'error');
        }
      }
      closeModal();
      onDone(item);
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
      createBtn.disabled = false;
    }
  });
}

// Edits an already-created item's name/color/properties/formula - type and
// shape are locked per item (same as takeoffs.html's edit modal always
// enforced for name/color) since every placed instance already assumes one
// unit of measure. Changing properties/formula here reflows every display
// of this item's total immediately (see computeTakeoffOutput) - no need to
// touch any already-placed geometry.
function openTakeoffEditModal(item) {
  openModal(`
    <h2>Edit take-off item</h2>
    <div class="field">
      <label>Name</label>
      <input id="takeoff-edit-name" autocomplete="off">
      <div class="takeoff-name-preview muted" id="takeoff-edit-name-preview" style="display:none;"></div>
    </div>
    <div class="field">
      <label>Color</label>
      <input type="color" id="takeoff-edit-color">
    </div>
    <div id="takeoff-edit-advanced-root"></div>
    <p class="error" id="takeoff-edit-error" style="display:none;"></p>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Cancel</button>
      <button class="primary" type="button" id="modal-save">Save</button>
    </div>
  `);
  document.getElementById('takeoff-edit-name').value = item.name;
  document.getElementById('takeoff-edit-color').value = item.color;

  const editAdvancedRoot = document.getElementById('takeoff-edit-advanced-root');
  const advanced = setupAdvancedFields(editAdvancedRoot, {
    properties: parseTakeoffProperties(item.properties),
    formula: item.formula || '',
    outputLabel: item.output_label || '',
    folders: takeoffFoldersCache || [],
    folderId: item.folder_id,
    onCreateFolder: createTakeoffFolder,
  });
  wireNamePreview(document.getElementById('takeoff-edit-name'), document.getElementById('takeoff-edit-name-preview'), editAdvancedRoot, advanced);

  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-save').addEventListener('click', async () => {
    const advancedResult = advanced.validate();
    if (!advancedResult.ok) return;
    const { properties, formula, outputLabel, folderId } = advanced.getValue();
    const saveBtn = document.getElementById('modal-save');
    saveBtn.disabled = true;
    try {
      await api('PATCH', `/api/projects/${projectId}/take-off-items/${item.id}`, {
        name: resolveTakeoffName(document.getElementById('takeoff-edit-name').value.trim(), properties),
        color: document.getElementById('takeoff-edit-color').value,
        properties,
        formula: formula || null,
        output_label: outputLabel || null,
        folder_id: folderId,
      });
      closeModal();
      showToast('Take-off item updated.', 'success');
      await loadTakeoffItems();
      renderTakeoffPane();
    } catch (err) {
      const errEl = document.getElementById('takeoff-edit-error');
      errEl.textContent = err.message;
      errEl.style.display = 'block';
      saveBtn.disabled = false;
    }
  });
}

// Shared by the 4 tool buttons and the "From Template" picker - both end
// with a freshly-POSTed item that should immediately arm for placement.
function armNewlyCreatedTakeoffItem(item, type) {
  if (!item) return; // cancelled - nothing armed
  takeoffItems.push({ ...item, total_quantity: 0, instance_count: 0 });
  takeoffTool = type;
  activeTakeoffItemId = item.id;
  multiSelectExtraItemIds = new Set();
  multiSelectExtraAssemblyIds = new Set();
  lastPlacedInstanceId = null;
  persistActiveTakeoff();
  updateTakeoffToolbar();
  renderTakeoffPane();
}

// "From Existing" - same-project items only (not cross-project), and only
// ones NOT already on this sheet (those already show in the pane per
// renderTakeoffPane's on-this-sheet filter, so relisting them here would be
// redundant). No API call needed - takeoffItems already holds the full
// project list; picking one just arms it via the same activateTakeoffItem
// used when clicking a pane row.
function openExistingItemPickerModal() {
  const grouped = groupTakeoffInstancesByItem();
  const candidates = takeoffItems.filter((i) => !grouped.has(i.id));

  openModal(`
    <h2>Continue an existing take-off</h2>
    <input type="text" id="existing-picker-search" placeholder="Search take-offs..." autocomplete="off" style="width:100%;">
    <div class="takeoff-template-picker-list" id="existing-picker-list"></div>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Cancel</button>
    </div>
  `);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  const searchInput = document.getElementById('existing-picker-search');
  const listEl = document.getElementById('existing-picker-list');
  searchInput.focus();

  function renderList() {
    const term = searchInput.value.trim().toLowerCase();
    const matches = term ? candidates.filter((i) => i.name.toLowerCase().includes(term)) : candidates;
    if (matches.length === 0) {
      listEl.innerHTML = `<p class="muted">${candidates.length === 0 ? 'Every take-off item in this project is already on this sheet.' : 'No take-offs match your search.'}</p>`;
      return;
    }
    listEl.innerHTML = matches
      .map(
        (i) => `
        <button type="button" class="takeoff-template-picker-row" data-id="${i.id}">
          <span class="takeoff-color-dot" style="background:${i.color};"></span>
          <span class="takeoff-template-picker-name">${escapeHtml(i.name)}</span>
          <span class="muted">${i.type === 'count' ? `count (${i.shape})` : i.type}</span>
        </button>`
      )
      .join('');
    listEl.querySelectorAll('.takeoff-template-picker-row').forEach((row) => {
      row.addEventListener('click', () => {
        const item = candidates.find((i) => i.id === Number(row.dataset.id));
        closeModal();
        activateTakeoffItem(item);
      });
    });
  }
  searchInput.addEventListener('input', renderList);
  renderList();
}

// "From Template" - fetches the global template library once per pane
// session, shows a search box over the list, and clicking one opens the
// exact same creation modal used by the 4 tool buttons, just pre-filled
// (name/color/shape/properties/formula/output label) with Advanced already
// expanded so the user can review/adjust property values (e.g. this
// specific wall's actual height) before creating.
// Folders - project-scoped (unlike the global template cache above), so the
// cache key is implicitly this page's own project. Refetched (not just
// appended to) after creating one so every open modal on this page picks up
// the new list next time it's opened.
let takeoffFoldersCache = null;
async function loadTakeoffFolders() {
  try {
    const { folders } = await api('GET', `/api/projects/${projectId}/take-off-folders`);
    takeoffFoldersCache = folders;
    return folders;
  } catch (err) {
    // Offline, older/unrestarted server, or forbidden - the folder picker
    // just won't have options this session. Must never throw here: this is
    // awaited from setupTakeoffTools() during page init, and an uncaught
    // rejection there aborts the rest of init() - i.e. the whole sheet
    // fails to load over a feature as minor as folder organization.
    return takeoffFoldersCache || [];
  }
}
async function createTakeoffFolder(name) {
  try {
    const { folder } = await api('POST', `/api/projects/${projectId}/take-off-folders`, { name });
    await loadTakeoffFolders();
    return folder;
  } catch (err) {
    showToast(`Failed to create folder: ${err.message}`, 'error');
    return null;
  }
}

let takeoffTemplatesCache = null;
async function openTemplatePickerModal() {
  if (!takeoffTemplatesCache) {
    try {
      const { templates } = await api('GET', '/api/take-off-templates');
      takeoffTemplatesCache = templates;
    } catch (err) {
      showToast(`Failed to load templates: ${err.message}`, 'error');
      return;
    }
  }

  openModal(`
    <h2>Start from a template</h2>
    <input type="text" id="template-picker-search" placeholder="Search templates..." autocomplete="off" style="width:100%;">
    <div class="takeoff-template-picker-list" id="template-picker-list"></div>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Cancel</button>
    </div>
  `);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  const searchInput = document.getElementById('template-picker-search');
  const listEl = document.getElementById('template-picker-list');
  searchInput.focus();

  function renderList() {
    const term = searchInput.value.trim().toLowerCase();
    const matches = term ? takeoffTemplatesCache.filter((t) => t.name.toLowerCase().includes(term)) : takeoffTemplatesCache;
    if (matches.length === 0) {
      listEl.innerHTML = `<p class="muted">${takeoffTemplatesCache.length === 0 ? 'No templates yet - create one from the Take-offs page.' : 'No templates match your search.'}</p>`;
      return;
    }
    listEl.innerHTML = matches
      .map(
        (t) => `
        <button type="button" class="takeoff-template-picker-row" data-id="${t.id}">
          <span class="takeoff-color-dot" style="background:${t.color};"></span>
          <span class="takeoff-template-picker-name">${escapeHtml(t.name)}</span>
          <span class="muted">${t.type === 'count' ? `count (${t.shape})` : t.type}</span>
        </button>`
      )
      .join('');
    listEl.querySelectorAll('.takeoff-template-picker-row').forEach((row) => {
      row.addEventListener('click', () => {
        const template = takeoffTemplatesCache.find((t) => t.id === Number(row.dataset.id));
        closeModal();
        openTakeoffNamingModal(template.type, (item) => armNewlyCreatedTakeoffItem(item, template.type), {
          name: template.name,
          color: template.color,
          shape: template.shape,
          properties: parseTakeoffProperties(template.properties),
          formula: template.formula || '',
          outputLabel: template.output_label || '',
        });
      });
    });
  }
  searchInput.addEventListener('input', renderList);
  renderList();
}

// ---------- Assembly picker (From Assembly... button) ----------
function openAssemblyPickerModal() {
  openModal(`
    <h2>From Assembly</h2>
    <div class="takeoff-template-picker-list" id="assembly-picker-list"></div>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Cancel</button>
      <button type="button" class="primary" id="assembly-picker-new-btn">+ New from template...</button>
    </div>
  `);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('assembly-picker-new-btn').addEventListener('click', () => {
    closeModal();
    openAssemblyTemplatePickerModal();
  });

  const listEl = document.getElementById('assembly-picker-list');
  if (takeoffAssemblies.length === 0) {
    listEl.innerHTML = '<p class="muted">No assemblies in this project yet - create one from a template.</p>';
    return;
  }
  listEl.innerHTML = takeoffAssemblies
    .map((a) => {
      const linkedCount = ['area', 'top', 'bottom', 'left', 'right'].filter((k) => a[`${k}_item_id`]).length;
      return `
      <button type="button" class="takeoff-template-picker-row" data-id="${a.id}">
        <span class="takeoff-template-picker-name">${escapeHtml(a.name)}</span>
        <span class="muted">${linkedCount}/5 linked</span>
      </button>`;
    })
    .join('');
  listEl.querySelectorAll('.takeoff-template-picker-row').forEach((row) => {
    row.addEventListener('click', () => {
      const assembly = takeoffAssemblies.find((a) => a.id === Number(row.dataset.id));
      closeModal();
      activateAssembly(assembly);
    });
  });
}

// "+ New from template" - fetches the global assembly-template library once
// per pane session (mirrors takeoffTemplatesCache), picking one creates a
// new project-scoped assembly (blank links) and immediately opens the links
// modal so it's ready to arm right away.
// Creates a brand-new global assembly template (name + the 5 slots' default
// labels, never linked to real items - see take_off_assembly_templates).
// Reopens the picker afterward so the new template is immediately usable.
function openAssemblyTemplateFormModal() {
  const defaults = { area: 'Area', top: 'Head', bottom: 'Sill', left: 'Left Jamb', right: 'Right Jamb' };
  openModal(`
    <h2>New assembly template</h2>
    <div class="field">
      <label>Name</label>
      <input id="assembly-template-name" autocomplete="off" placeholder="e.g. Window">
    </div>
    ${Object.entries(defaults)
      .map(
        ([key, label]) => `
      <div class="field">
        <label>${key === 'area' ? 'Area slot label' : `${key[0].toUpperCase()}${key.slice(1)} slot label`}</label>
        <input id="assembly-template-${key}-label" autocomplete="off" value="${label}">
      </div>`
      )
      .join('')}
    <p class="error" id="assembly-template-error" style="display:none;"></p>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Cancel</button>
      <button type="button" class="primary" id="modal-create">Create</button>
    </div>
  `);
  document.getElementById('assembly-template-name').focus();
  document.getElementById('modal-cancel').addEventListener('click', () => {
    closeModal();
    openAssemblyTemplatePickerModal();
  });
  document.getElementById('modal-create').addEventListener('click', async () => {
    const name = document.getElementById('assembly-template-name').value.trim();
    const errEl = document.getElementById('assembly-template-error');
    if (!name) {
      errEl.textContent = 'Name is required.';
      errEl.style.display = 'block';
      return;
    }
    const body = { name };
    for (const key of Object.keys(defaults)) {
      body[`${key}_label`] = document.getElementById(`assembly-template-${key}-label`).value.trim() || defaults[key];
    }
    const createBtn = document.getElementById('modal-create');
    createBtn.disabled = true;
    try {
      await api('POST', '/api/take-off-assembly-templates', body);
      takeoffAssemblyTemplatesCache = null; // force a refetch so the new template shows up
      closeModal();
      openAssemblyTemplatePickerModal();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
      createBtn.disabled = false;
    }
  });
}

async function openAssemblyTemplatePickerModal() {
  if (!takeoffAssemblyTemplatesCache) {
    try {
      const { templates } = await api('GET', '/api/take-off-assembly-templates');
      takeoffAssemblyTemplatesCache = templates;
    } catch (err) {
      showToast(`Failed to load assembly templates: ${err.message}`, 'error');
      return;
    }
  }

  openModal(`
    <h2>New assembly from template</h2>
    <input type="text" id="assembly-template-picker-search" placeholder="Search templates..." autocomplete="off" style="width:100%;">
    <div class="takeoff-template-picker-list" id="assembly-template-picker-list"></div>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Cancel</button>
      <button type="button" id="assembly-template-new-btn">+ New template...</button>
    </div>
  `);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('assembly-template-new-btn').addEventListener('click', () => {
    closeModal();
    openAssemblyTemplateFormModal();
  });
  const searchInput = document.getElementById('assembly-template-picker-search');
  const listEl = document.getElementById('assembly-template-picker-list');
  searchInput.focus();

  function renderList() {
    const term = searchInput.value.trim().toLowerCase();
    const matches = term
      ? takeoffAssemblyTemplatesCache.filter((t) => t.name.toLowerCase().includes(term))
      : takeoffAssemblyTemplatesCache;
    if (matches.length === 0) {
      listEl.innerHTML = `<p class="muted">${
        takeoffAssemblyTemplatesCache.length === 0
          ? 'No assembly templates yet - create one first (name + the 5 slot labels).'
          : 'No templates match your search.'
      }</p>`;
      return;
    }
    listEl.innerHTML = matches
      .map(
        (t) => `
        <button type="button" class="takeoff-template-picker-row" data-id="${t.id}">
          <span class="takeoff-template-picker-name">${escapeHtml(t.name)}</span>
          <span class="muted">${escapeHtml(`${t.area_label} / ${t.top_label} / ${t.bottom_label} / ${t.left_label} / ${t.right_label}`)}</span>
        </button>`
      )
      .join('');
    listEl.querySelectorAll('.takeoff-template-picker-row').forEach((row) => {
      row.addEventListener('click', async () => {
        const template = takeoffAssemblyTemplatesCache.find((t) => t.id === Number(row.dataset.id));
        const name = await promptModal({ title: 'Name this assembly', message: 'Name:', defaultValue: template.name, required: true });
        if (!name || !name.trim()) return;
        closeModal();
        try {
          const { assembly } = await api('POST', `/api/projects/${projectId}/take-off-assemblies`, {
            name: name.trim(),
            template_id: template.id,
          });
          await loadTakeoffAssemblies();
          openAssemblyLinksModal(assembly);
        } catch (err) {
          showToast(`Failed to create assembly: ${err.message}`, 'error');
        }
      });
    });
  }
  searchInput.addEventListener('input', renderList);
  renderList();
}

// ---------- Assembly links modal (link each of the 5 slots to an item) ----------
const ASSEMBLY_SLOTS = [
  { key: 'area', type: 'area' },
  { key: 'top', type: 'linear' },
  { key: 'bottom', type: 'linear' },
  { key: 'left', type: 'linear' },
  { key: 'right', type: 'linear' },
];

function openAssemblyLinksModal(assembly) {
  openModal(`
    <h2>${escapeHtml(assembly.name)} - links</h2>
    <p class="muted">Link each slot to a take-off item - existing or new. Unlinked slots are simply skipped when you draw a box. Left and right jambs are always independent, so pick the same item twice when they match.</p>
    <div id="assembly-links-rows"></div>
    <p class="error" id="assembly-links-error" style="display:none;"></p>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Close</button>
      <button type="button" class="primary" id="modal-save">Save</button>
    </div>
  `);
  const rowsEl = document.getElementById('assembly-links-rows');
  rowsEl.innerHTML = ASSEMBLY_SLOTS.map(
    (s) => `
    <div class="field assembly-link-row" data-slot="${s.key}">
      <label>${escapeHtml(assembly[`${s.key}_label`])}</label>
      <div class="row" style="gap:6px;">
        <select id="assembly-link-${s.key}" style="flex:1;"></select>
        <button type="button" class="icon-btn" data-action="new-item" title="Create a new ${s.type} item">+</button>
      </div>
    </div>`
  ).join('');

  function populateSelect(slotKey, itemType, selectedId) {
    const select = document.getElementById(`assembly-link-${slotKey}`);
    const candidates = takeoffItems.filter((i) => i.type === itemType);
    select.innerHTML =
      '<option value="">Unlinked</option>' +
      candidates.map((i) => `<option value="${i.id}" ${i.id === selectedId ? 'selected' : ''}>${escapeHtml(i.name)}</option>`).join('');
  }
  for (const s of ASSEMBLY_SLOTS) {
    populateSelect(s.key, s.type, assembly[`${s.key}_item_id`]);
  }

  rowsEl.querySelectorAll('[data-action="new-item"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const slotKey = btn.closest('.assembly-link-row').dataset.slot;
      const slot = ASSEMBLY_SLOTS.find((s) => s.key === slotKey);
      closeModal();
      openTakeoffNamingModal(slot.type, async (item) => {
        if (item) {
          await loadTakeoffItems();
          assembly[`${slotKey}_item_id`] = item.id;
        }
        openAssemblyLinksModal(assembly);
      });
    });
  });

  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-save').addEventListener('click', async () => {
    const body = {};
    for (const s of ASSEMBLY_SLOTS) {
      const val = document.getElementById(`assembly-link-${s.key}`).value;
      body[`${s.key}_item_id`] = val === '' ? null : Number(val);
    }
    const errEl = document.getElementById('assembly-links-error');
    const saveBtn = document.getElementById('modal-save');
    saveBtn.disabled = true;
    try {
      await api('PATCH', `/api/projects/${projectId}/take-off-assemblies/${assembly.id}`, body);
      // Relinking mid-session (while armed) only affects the *next* box
      // drawn - takeoffAssemblies is reloaded here and submitAssemblyInstances
      // always looks the assembly up fresh from that array at click time, so
      // boxes already drawn keep whatever they were placed with.
      await loadTakeoffAssemblies();
      renderTakeoffPane();
      closeModal();
      showToast('Links updated.', 'success');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
      saveBtn.disabled = false;
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

// Applies the item's output formula (if any) before formatting - see
// computeTakeoffOutput in takeoffFormula.js. Items with no formula (every
// item before this feature existed, and the common case going forward)
// format exactly as before.
function formatRawTakeoffQuantity(type, value) {
  if (type === 'area') return `${value.toLocaleString(undefined, { maximumFractionDigits: 0 })} SF`;
  if (type === 'count') return `${Math.round(value)}`;
  return `${value.toFixed(1)} ft`;
}

function formatTakeoffQuantity(item, rawValue) {
  const { value, isOutput, label } = computeTakeoffOutput(item, rawValue);
  if (isOutput) {
    const formatted = value.toLocaleString(undefined, { maximumFractionDigits: 2 });
    // The output is the headline number, but the underlying raw take-off
    // (e.g. the linear footage a wall-height multiplier was applied to) is
    // still useful to see at a glance, not just buried in an edit modal.
    const raw = formatRawTakeoffQuantity(item.type, rawValue);
    return `${label ? `${formatted} ${label}` : formatted} (${raw})`;
  }
  return formatRawTakeoffQuantity(item.type, value);
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
    // Otherwise a pinned item (see sheetPinnedItemIds) would immediately
    // reappear despite "Remove from this sheet" - being armed pins it, but
    // explicitly removing it is a clearer signal than just backing out.
    if (sheetPinnedItemIds.delete(item.id)) savePinnedTakeoffItemIds();
    await Promise.all([loadSheetTakeoffInstances(), loadTakeoffItems()]);
    renderTakeoffPane();
  } catch (err) {
    showToast(`Failed to remove: ${err.message}`, 'error');
  }
}

async function performDeleteTakeoffItem(item) {
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

async function deleteTakeoffItemFromProject(item) {
  const ok = await confirmModal({
    title: 'Delete this take-off item?',
    message: `"${item.name}" and all its placed instances across every sheet will be permanently removed.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  await performDeleteTakeoffItem(item);
}

function renderTakeoffPane() {
  // Committed geometry must stop being clickable (edit-enabled) the instant
  // a placement tool arms, not just whenever instance data next reloads -
  // renderTakeoffPane() already runs on every arm/disarm/resume transition,
  // so it's the reliable place to keep this in sync.
  const instancesLayer = document.getElementById('takeoff-instances-layer');
  if (instancesLayer) instancesLayer.classList.toggle('edit-enabled', !takeoffTool);
  document.getElementById('zoom-wrap')?.classList.toggle('takeoff-active', !!takeoffTool);
  // #markup-svg sits on top of #zoom-wrap and covers the whole canvas, and
  // markups.js sets its own inline cursor style on it (default/crosshair
  // depending on the markup tool) - an inline style always wins over the
  // .zoom-wrap.takeoff-active CSS rule for that element, so the CSS alone
  // never actually changed the visible cursor. Set it directly here instead,
  // and clear it (rather than force 'default') when idle so markups.js's own
  // management resumes normal control.
  const markupSvg = document.getElementById('markup-svg');
  if (markupSvg) markupSvg.style.cursor = takeoffTool ? 'crosshair' : '';

  document.querySelectorAll('#takeoff-tool-grid .tool-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tool === takeoffTool);
    b.disabled = (!!activeTakeoffItemId || !!activeAssemblyId) && b.dataset.tool !== takeoffTool;
  });

  // The action bar tracks activeTakeoffItemId/selectedTakeoffItemId (or the
  // assembly equivalents) directly rather than the filtered row list below -
  // a search term hiding the row shouldn't also hide the way to
  // edit/remove/delete/stop-or-start it. Armed always wins over selected,
  // and an item always wins over an assembly when somehow both are set
  // (shouldn't normally happen - activating either disarms the other).
  const activeItem = takeoffItems.find((i) => i.id === activeTakeoffItemId);
  const selectedItem = !activeItem && takeoffItems.find((i) => i.id === selectedTakeoffItemId);
  const activeAssembly = !activeItem && !selectedItem && takeoffAssemblies.find((a) => a.id === activeAssemblyId);
  const selectedAssembly =
    !activeItem && !selectedItem && !activeAssembly && takeoffAssemblies.find((a) => a.id === selectedAssemblyId);
  // Clicking an item with instances already on this sheet enters point/
  // segment edit mode instead of just selecting the row (see the row click
  // handler below) - that shouldn't cost you the Edit/Remove/Delete/Start
  // bar, it should just show it for whatever's being edited, alongside the
  // separate box/brush-select toolbar edit mode already has.
  const editingItem =
    !activeItem &&
    !selectedItem &&
    !activeAssembly &&
    !selectedAssembly &&
    editingInstance &&
    takeoffItems.find((i) => i.id === editingInstance.item_id);
  if (activeItem) showTakeoffItemActionsBar(activeItem, true);
  else if (selectedItem) showTakeoffItemActionsBar(selectedItem, false);
  else if (activeAssembly) showAssemblyActionsBar(activeAssembly, true);
  else if (selectedAssembly) showAssemblyActionsBar(selectedAssembly, false);
  else if (editingItem) showTakeoffItemActionsBar(editingItem, false);
  else hideTakeoffItemActionsBar();
  // Many call sites update renderTakeoffPane() without also calling
  // updateTakeoffToolbar() directly - folding this in here is what keeps
  // #takeoff-toolbar's own visibility (now also driven by whether there's
  // an active/selected item or assembly, not just axis-lock placement -
  // see updateTakeoffToolbar) correct everywhere, without auditing every
  // call site individually. Cheap and idempotent, safe to call redundantly.
  updateTakeoffToolbar();

  // Pin whatever just got armed so it survives Escape/Stop with zero
  // instances placed - see sheetPinnedItemIds above. An empty item created
  // (or pulled in via From Existing) specifically to be part of a later
  // multi-select take-off shouldn't disappear the moment you back out of it.
  if (activeTakeoffItemId && !sheetPinnedItemIds.has(activeTakeoffItemId)) {
    sheetPinnedItemIds.add(activeTakeoffItemId);
    savePinnedTakeoffItemIds();
  }

  // Just the total on this sheet per item - not a breakdown of every
  // individual placement (that level of detail lives in takeoffs.html's
  // per-item, per-sheet expand instead). The active item is shown by
  // highlighting its row (no separate banner above the list).
  const grouped = groupTakeoffInstancesByItem();
  const list = document.getElementById('takeoff-items-list');
  const hideAllBtn = document.getElementById('takeoff-hide-all-btn');
  list.innerHTML = '';
  if (takeoffItems.length === 0) {
    list.innerHTML = '<p class="muted">No take-off items yet - pick a tool above to create one.</p>';
    hideAllBtn.style.display = 'none';
    return;
  }
  // Only items actually placed on THIS sheet - a job can easily have
  // hundreds of items project-wide and nobody wants to scroll past every
  // one of them on every single drawing. The just-armed item stays visible
  // even before its first click lands (0 instances here yet, or even none
  // ever - see sheetPinnedItemIds), otherwise it would vanish from the list
  // the moment you create/select it and back out without placing anything.
  const onThisSheet = takeoffItems.filter(
    (i) => grouped.has(i.id) || i.id === activeTakeoffItemId || i.id === selectedTakeoffItemId || sheetPinnedItemIds.has(i.id)
  );
  // Hide-all's own state tracks every item on this sheet, not just the
  // search-filtered subset below - searching shouldn't change what "all"
  // means for the hide toggle.
  hideAllBtn.style.display = onThisSheet.length ? '' : 'none';
  const allHidden = onThisSheet.length > 0 && onThisSheet.every((i) => hiddenTakeoffItemIds.has(i.id));
  hideAllBtn.textContent = allHidden ? 'Unhide all' : 'Hide all';
  const visibleItems = takeoffSearchTerm ? onThisSheet.filter((i) => i.name.toLowerCase().includes(takeoffSearchTerm)) : onThisSheet;
  if (visibleItems.length === 0) {
    list.innerHTML = takeoffSearchTerm
      ? '<p class="muted">No take-off items match your search.</p>'
      : '<p class="muted">No take-offs on this drawing yet - pick a tool above, or use From Template / From Existing.</p>';
    return;
  }
  // While an assembly is armed, every item currently linked to one of its 5
  // slots gets the same "active" row treatment multi-select already gives
  // several rows at once - lets you see at a glance what a box will feed.
  const activeAssemblyForHighlight = activeAssemblyId && takeoffAssemblies.find((a) => a.id === activeAssemblyId);
  const activeAssemblyLinkedIds = activeAssemblyForHighlight
    ? new Set(['area', 'top', 'bottom', 'left', 'right'].map((k) => activeAssemblyForHighlight[`${k}_item_id`]).filter(Boolean))
    : null;
  for (const item of visibleItems) {
    const instances = grouped.get(item.id) || [];
    const sheetTotal = instances.reduce((sum, i) => sum + i.quantity, 0);
    const isArmed = item.id === activeTakeoffItemId;
    const isEditing = !!editingInstance && editingInstance.item_id === item.id;
    const isSelected = !isEditing && item.id === selectedTakeoffItemId;
    const isMultiSelected = multiSelectExtraItemIds.has(item.id);
    const isAssemblyLinked = !!activeAssemblyLinkedIds && activeAssemblyLinkedIds.has(item.id);
    const isHidden = hiddenTakeoffItemIds.has(item.id);
    const row = document.createElement('div');
    row.className =
      'takeoff-item-row' +
      (isArmed || isSelected || isEditing || isMultiSelected || isAssemblyLinked ? ' active' : '') +
      (isHidden ? ' takeoff-hidden-item' : '');
    // Committed total as of this render, stashed on the row so the live
    // placement loop (see updateLiveTakeoffItemTotals) can overlay an
    // in-progress delta on top of it with a plain textContent write - no
    // re-grouping sheetTakeoffInstances, no re-rendering the list, on every
    // mousemove.
    row.dataset.itemId = String(item.id);
    row.dataset.sheetTotal = String(sheetTotal);
    row.innerHTML = `
      <span class="takeoff-color-dot" style="background:${item.color};"></span>
      <span class="takeoff-item-text">
        <span class="takeoff-item-name">${escapeHtml(item.name)}</span>
        <span class="takeoff-item-total muted">${formatTakeoffQuantity(item, sheetTotal)}</span>
      </span>
      ${
        (isSelected || isEditing) && !isArmed
          ? '<button type="button" class="icon-btn takeoff-row-activate-btn" data-action="activate" title="Activate">&#9654;</button>'
          : ''
      }
      <button type="button" class="icon-btn takeoff-row-hide-btn" data-action="hide" title="${isHidden ? 'Unhide on this drawing' : 'Hide on this drawing'}">${isHidden ? '&#128584;' : '&#128065;'}</button>`;
    // A plain click behaves like clicking this item's shape on the drawing
    // itself: if it's already placed on this sheet, it enters the same
    // point/segment edit mode (points selected, the edit toolbar's Start
    // button available to arm placement - see enterTakeoffEditMode/
    // setupTakeoffEditToolbar). Nothing placed yet (or none of its
    // instances are on this sheet) falls back to just selecting the row
    // (see selectTakeoffItemRow), since there's no shape here to edit.
    // Double-click, the row's own Activate button, or the bottom bar's
    // Start button all arm placement directly either way.
    row.addEventListener('click', (e) => {
      if (e.shiftKey) {
        toggleMultiSelectExtraItem(item);
        return;
      }
      if (instances.length > 0) enterTakeoffEditMode(instances[0]);
      else selectTakeoffItemRow(item);
    });
    row.addEventListener('dblclick', () => {
      activateTakeoffItem(item);
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showTakeoffItemContextMenu(e.clientX, e.clientY, item);
    });
    row.querySelector('[data-action="activate"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      activateTakeoffItem(item);
    });
    row.querySelector('[data-action="hide"]').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleHideTakeoffItem(item);
    });
    list.appendChild(row);
  }
}

// ---------- Item-actions group, inside the shared #takeoff-toolbar ----------
// #takeoff-item-actions-group's own show/hide is independent of the rest of
// #takeoff-toolbar (axis-lock/snap/box-mode) - see updateTakeoffToolbar,
// which is what actually decides whether the bar itself is visible at all.

// isArmed distinguishes actually placing (activeTakeoffItemId) from just
// having picked the row (selectedTakeoffItemId) - see renderTakeoffPane.
// Only the Stop/Start button's label and click target change; Edit/Remove/
// Delete apply to either state exactly the same way.
function showTakeoffItemActionsBar(item, isArmed) {
  const group = document.getElementById('takeoff-item-actions-group');
  // Reset the live-quantity readout's baseline on every (re)render of this
  // group - a stale number from whatever was last being traced shouldn't
  // linger after switching items until the next mousemove happens to fire.
  document.getElementById('takeoff-item-actions-live-qty').textContent = '';
  const isMulti = isArmed && multiSelectExtraItemIds.size > 0;
  document.getElementById('takeoff-item-actions-dot').style.background = item.color;
  // Edit/Remove/Delete are single-item actions - with several items combined
  // into one trace, which one they'd apply to is ambiguous, so only Stop
  // stays available until the selection narrows back down to one. A paired
  // assembly (see multiSelectExtraAssemblyIds) doesn't add that ambiguity -
  // it always places on its own linked items, never the anchor - so it only
  // needs a name-suffix, not the same button-hiding treatment.
  const assemblySuffix =
    isArmed && multiSelectExtraAssemblyIds.size > 0
      ? ` + ${multiSelectExtraAssemblyIds.size} assembl${multiSelectExtraAssemblyIds.size === 1 ? 'y' : 'ies'} paired`
      : '';
  document.getElementById('takeoff-item-actions-name').textContent = isMulti
    ? `${multiSelectExtraItemIds.size + 1} ${item.type} items selected${assemblySuffix}`
    : `${item.name}${assemblySuffix}`;
  document.getElementById('takeoff-item-actions-edit').style.display = isMulti ? 'none' : '';
  document.getElementById('takeoff-item-actions-edit').title = 'Edit properties & formula'; // reset in case showAssemblyActionsBar last changed it
  document.getElementById('takeoff-item-actions-remove').style.display = isMulti ? 'none' : '';
  document.getElementById('takeoff-item-actions-delete').style.display = isMulti ? 'none' : '';
  document.getElementById('takeoff-item-actions-stop').textContent = isArmed ? 'Stop' : 'Start';
  group.style.display = 'flex';
}

// Assemblies reuse the exact same group DOM as an item's - just a different
// populate function, since an assembly has no color/type/sheet-removal
// concept but otherwise fits the same "name + Stop-or-Start + Edit + Delete"
// shape. Edit opens the links modal instead of the item-properties modal;
// Remove doesn't apply (assemblies aren't sheet-scoped) so it's hidden.
function showAssemblyActionsBar(assembly, isArmed) {
  const group = document.getElementById('takeoff-item-actions-group');
  document.getElementById('takeoff-item-actions-live-qty').textContent = '';
  document.getElementById('takeoff-item-actions-dot').style.background = 'var(--border)';
  const linkedCount = ['area', 'top', 'bottom', 'left', 'right'].filter((k) => assembly[`${k}_item_id`]).length;
  document.getElementById('takeoff-item-actions-name').textContent = `${assembly.name} (${linkedCount}/5 linked)`;
  document.getElementById('takeoff-item-actions-edit').style.display = '';
  document.getElementById('takeoff-item-actions-edit').title = 'Edit links';
  document.getElementById('takeoff-item-actions-remove').style.display = 'none';
  document.getElementById('takeoff-item-actions-delete').style.display = '';
  document.getElementById('takeoff-item-actions-stop').textContent = isArmed ? 'Stop' : 'Start';
  group.style.display = 'flex';
}

function hideTakeoffItemActionsBar() {
  document.getElementById('takeoff-item-actions-group').style.display = 'none';
}

// The item a click-to-edit shape is currently showing (see enterTakeoffEditMode) -
// falls back to editingInstance.item_id when there's no separately armed/
// selected item, so the bottom bar's buttons work for that case too (see
// renderTakeoffPane's editingItem branch).
function currentBarItemId() {
  return activeTakeoffItemId || selectedTakeoffItemId || (editingInstance && editingInstance.item_id) || null;
}

function setupTakeoffItemActionsBar() {
  document.getElementById('takeoff-item-actions-stop').addEventListener('click', () => {
    // Same button, two meanings depending on state (see showTakeoffItemActionsBar):
    // armed -> Stop disarms placement; selected-only -> Start arms it.
    if (activeAssemblyId) {
      deactivateTakeoff();
      return;
    }
    if (selectedAssemblyId) {
      const assembly = takeoffAssemblies.find((a) => a.id === selectedAssemblyId);
      if (assembly) activateAssembly(assembly);
      return;
    }
    if (activeTakeoffItemId) {
      deactivateTakeoff();
      return;
    }
    const item = takeoffItems.find((i) => i.id === currentBarItemId());
    if (item) activateTakeoffItem(item);
  });
  document.getElementById('takeoff-item-actions-edit').addEventListener('click', () => {
    const assembly = takeoffAssemblies.find((a) => a.id === (activeAssemblyId || selectedAssemblyId));
    if (assembly) {
      openAssemblyLinksModal(assembly);
      return;
    }
    const item = takeoffItems.find((i) => i.id === currentBarItemId());
    if (item) openTakeoffEditModal(item);
  });
  document.getElementById('takeoff-item-actions-remove').addEventListener('click', () => {
    const item = takeoffItems.find((i) => i.id === currentBarItemId());
    if (item) removeTakeoffItemFromSheet(item);
  });
  document.getElementById('takeoff-item-actions-delete').addEventListener('click', () => {
    const assembly = takeoffAssemblies.find((a) => a.id === (activeAssemblyId || selectedAssemblyId));
    if (assembly) {
      deleteAssembly(assembly);
      return;
    }
    const item = takeoffItems.find((i) => i.id === currentBarItemId());
    if (item) deleteTakeoffItemFromProject(item);
  });
}

// ---------- Right-click context menu on a pane item row ----------
// Reuses #takeoff-context-menu's id/styling (and hideTakeoffContextMenu) -
// the on-canvas geometry context menu and this one are never open at the
// same time, so sharing the element is safe.
function showTakeoffItemContextMenu(x, y, item) {
  hideTakeoffContextMenu();
  const menu = document.createElement('div');
  menu.id = 'takeoff-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const isHidden = hiddenTakeoffItemIds.has(item.id);
  const actions = [
    { action: 'edit', label: 'Edit properties & formula' },
    { action: 'hide', label: isHidden ? 'Unhide on this drawing' : 'Hide on this drawing' },
    { action: 'remove', label: 'Remove from this sheet' },
    { action: 'delete', label: 'Delete from project' },
  ];
  menu.innerHTML = actions.map((a) => `<button type="button" data-action="${a.action}">${escapeHtml(a.label)}</button>`).join('');
  document.body.appendChild(menu);
  menu.querySelector('[data-action="edit"]').addEventListener('click', () => {
    hideTakeoffContextMenu();
    openTakeoffEditModal(item);
  });
  menu.querySelector('[data-action="hide"]').addEventListener('click', () => {
    hideTakeoffContextMenu();
    toggleHideTakeoffItem(item);
  });
  menu.querySelector('[data-action="remove"]').addEventListener('click', () => {
    hideTakeoffContextMenu();
    removeTakeoffItemFromSheet(item);
  });
  menu.querySelector('[data-action="delete"]').addEventListener('click', () => {
    hideTakeoffContextMenu();
    deleteTakeoffItemFromProject(item);
  });
  setTimeout(() => {
    document.addEventListener('click', hideTakeoffContextMenu, { once: true });
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') hideTakeoffContextMenu();
      },
      { once: true }
    );
  }, 0);
}

async function loadTakeoffItems() {
  try {
    const { items } = await api('GET', `/api/projects/${projectId}/take-off-items`);
    takeoffItems = items;
  } catch (err) {
    // Offline (or genuinely forbidden, in which case this is just empty -
    // syncProject() never caches take-off data for a non-take-off user
    // either, see offline-store.js) - read whatever was cached at last
    // sync instead of leaving the pane on stale in-memory state.
    takeoffItems = await getCachedTakeoffItems(projectId);
  }
}

async function loadTakeoffAssemblies() {
  try {
    const { assemblies } = await api('GET', `/api/projects/${projectId}/take-off-assemblies`);
    takeoffAssemblies = assemblies;
  } catch (err) {
    takeoffAssemblies = await getCachedTakeoffAssemblies(projectId);
  }
  renderTakeoffAssembliesList();
}

function renderTakeoffAssembliesList() {
  const list = document.getElementById('takeoff-assemblies-list');
  if (!list) return;
  if (takeoffAssemblies.length === 0) {
    list.innerHTML = '';
    list.style.display = 'none';
    return;
  }
  list.style.display = '';
  list.innerHTML = '';
  for (const assembly of takeoffAssemblies) {
    const isArmed = assembly.id === activeAssemblyId;
    const isSelected = assembly.id === selectedAssemblyId;
    const isMultiSelected = multiSelectExtraAssemblyIds.has(assembly.id);
    const linkedCount = ['area', 'top', 'bottom', 'left', 'right'].filter((k) => assembly[`${k}_item_id`]).length;
    const row = document.createElement('div');
    row.className = 'takeoff-item-row takeoff-assembly-row' + (isArmed || isSelected || isMultiSelected ? ' active' : '');
    row.innerHTML = `
      <span class="takeoff-item-text">
        <span class="takeoff-item-name">${escapeHtml(assembly.name)}</span>
        <span class="takeoff-item-total muted">${linkedCount}/5 linked</span>
      </span>
      ${
        isSelected && !isArmed
          ? '<button type="button" class="icon-btn takeoff-row-activate-btn" data-action="activate" title="Activate">&#9654;</button>'
          : ''
      }`;
    row.addEventListener('click', (e) => {
      if (e.shiftKey) {
        toggleMultiSelectExtraAssembly(assembly);
        return;
      }
      selectAssemblyRow(assembly);
    });
    row.addEventListener('dblclick', () => activateAssembly(assembly));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showAssemblyContextMenu(e.clientX, e.clientY, assembly);
    });
    row.querySelector('[data-action="activate"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      activateAssembly(assembly);
    });
    list.appendChild(row);
  }
}

// ---------- Right-click context menu on an assembly row ----------
function showAssemblyContextMenu(x, y, assembly) {
  hideTakeoffContextMenu();
  const menu = document.createElement('div');
  menu.id = 'takeoff-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const actions = [
    { action: 'edit', label: 'Edit links' },
    { action: 'rename', label: 'Rename' },
    { action: 'delete', label: 'Delete assembly' },
  ];
  menu.innerHTML = actions.map((a) => `<button type="button" data-action="${a.action}">${escapeHtml(a.label)}</button>`).join('');
  document.body.appendChild(menu);
  menu.querySelector('[data-action="edit"]').addEventListener('click', () => {
    hideTakeoffContextMenu();
    openAssemblyLinksModal(assembly);
  });
  menu.querySelector('[data-action="rename"]').addEventListener('click', async () => {
    hideTakeoffContextMenu();
    const name = await promptModal({ title: 'Rename assembly', message: 'Name:', defaultValue: assembly.name, required: true });
    if (!name || !name.trim()) return;
    try {
      await api('PATCH', `/api/projects/${projectId}/take-off-assemblies/${assembly.id}`, { name: name.trim() });
      await loadTakeoffAssemblies();
    } catch (err) {
      showToast(`Failed to rename: ${err.message}`, 'error');
    }
  });
  menu.querySelector('[data-action="delete"]').addEventListener('click', () => {
    hideTakeoffContextMenu();
    deleteAssembly(assembly);
  });
  setTimeout(() => {
    document.addEventListener('click', hideTakeoffContextMenu, { once: true });
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') hideTakeoffContextMenu();
      },
      { once: true }
    );
  }, 0);
}

async function deleteAssembly(assembly) {
  const ok = await confirmModal({
    title: 'Delete this assembly?',
    message: `"${assembly.name}" will be removed. Items and instances it already created are not affected.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('DELETE', `/api/projects/${projectId}/take-off-assemblies/${assembly.id}`);
    if (assembly.id === activeAssemblyId) deactivateTakeoff();
    if (assembly.id === selectedAssemblyId) selectedAssemblyId = null;
    await loadTakeoffAssemblies();
    renderTakeoffPane();
    showToast(`Deleted "${assembly.name}".`, 'success');
  } catch (err) {
    showToast(`Failed to delete: ${err.message}`, 'error');
  }
}

async function loadSheetTakeoffInstances() {
  try {
    const { instances } = await api('GET', `/api/projects/${projectId}/sheets/${sheetId}/take-off-instances`);
    sheetTakeoffInstances = instances;
  } catch (err) {
    // Offline (or forbidden) - fall back to what was cached at last sync
    // (see offline-store.js's cacheTakeoffInstances/syncProject) instead of
    // rendering nothing.
    sheetTakeoffInstances = await getCachedTakeoffInstancesForSheet(sheetId);
  }
  renderTakeoffInstances();
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
      continuingInstanceId = null;
  continuingSeedPointCount = 0;
      subtractingIntoInstanceId = null;
      if (markupsController) markupsController.forceSelectTool();
      openTakeoffNamingModal(def.tool, (item) => armNewlyCreatedTakeoffItem(item, def.tool));
    });
    grid.appendChild(btn);
  }

  setupTakeoffInteraction();
  setupTakeoffCrosshair();
  setupTakeoffEditInteraction();
  setupTakeoffEditToolbar();
  setupTakeoffToolbar();
  setupTakeoffItemActionsBar();
  document.getElementById('takeoff-search').addEventListener('input', (e) => {
    takeoffSearchTerm = e.target.value.trim().toLowerCase();
    renderTakeoffPane();
  });
  document.getElementById('takeoff-hide-all-btn').addEventListener('click', toggleHideAllTakeoffs);
  document.getElementById('takeoff-from-template-btn').addEventListener('click', () => {
    if (!scaleFeetPerInch) {
      showToast('Set a scale first.', 'error');
      return;
    }
    openTemplatePickerModal();
  });
  document.getElementById('takeoff-from-existing-btn').addEventListener('click', () => {
    if (!scaleFeetPerInch) {
      showToast('Set a scale first.', 'error');
      return;
    }
    openExistingItemPickerModal();
  });
  document.getElementById('takeoff-from-assembly-btn').addEventListener('click', () => {
    if (!scaleFeetPerInch) {
      showToast('Set a scale first.', 'error');
      return;
    }
    openAssemblyPickerModal();
  });

  loadHiddenTakeoffItemIds();
  loadPinnedTakeoffItemIds();
  await loadTakeoffItems();
  await loadSheetTakeoffInstances();
  await loadTakeoffFolders();
  await loadTakeoffAssemblies();
  setupAssemblyDrawInteraction();

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
  updateTakeoffToolbar();
  renderTakeoffPane();
}

// ---------- Bottom take-off toolbar (item actions + box/point mode + axis-lock) ----------
// One shared bar rather than two stacked ones - #takeoff-item-actions-group
// (name/Stop-or-Start/Edit/Remove/Delete) used to be its own separate bar
// docked to the pane, then a separate floating bar stacked above this one;
// both were flagged as easy to lose or visually noisy on a short iPad
// viewport. Merged in per explicit request. Its own sub-visibility (see
// updateTakeoffToolbar) is independent of the axis-lock controls' - an
// armed 'count' item, or a merely-selected/being-edited item with nothing
// armed, shows the group with axis-lock/snap/box-mode hidden, since none of
// those apply outside active linear/perimeter/area placement.
function setupTakeoffToolbar() {
  const modeGroup = document.getElementById('takeoff-placement-mode');
  modeGroup.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      takeoffPlacementMode = btn.dataset.mode;
      modeGroup.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
      clearTakeoffDraft();
      // Paired assemblies (see toggleMultiSelectExtraAssembly) only make
      // sense against a rectangle - drop them the moment placement mode
      // leaves Box rather than silently reusing a freehand polygon's
      // bounding box as if it were the traced shape.
      if (takeoffPlacementMode !== 'box' && multiSelectExtraAssemblyIds.size > 0) {
        multiSelectExtraAssemblyIds = new Set();
        renderTakeoffAssembliesList();
      }
    });
  });

  const axisLockInput = document.getElementById('takeoff-axis-lock-checkbox');
  axisLockInput.addEventListener('change', () => {
    axisLockPinned = axisLockInput.checked;
    document.getElementById('takeoff-axis-lock-chip').classList.toggle('checked', axisLockPinned);
  });

  const snapPointsInput = document.getElementById('takeoff-snap-points-checkbox');
  snapPointsInput.addEventListener('change', () => {
    snapToPointsEnabled = snapPointsInput.checked;
    document.getElementById('takeoff-snap-points-chip').classList.toggle('checked', snapToPointsEnabled);
  });
}

function updateTakeoffToolbar() {
  const bar = document.getElementById('takeoff-toolbar');
  const placementActive = takeoffTool === 'linear' || takeoffTool === 'perimeter' || takeoffTool === 'area';
  // Same conditions renderTakeoffPane() resolves to an actual item/assembly
  // for showTakeoffItemActionsBar/showAssemblyActionsBar - only need "is
  // ANY of them set" here, not which one, so this stays a cheap independent
  // check rather than duplicating that resolution.
  const itemActionsRelevant = !!(
    activeTakeoffItemId ||
    selectedTakeoffItemId ||
    activeAssemblyId ||
    selectedAssemblyId ||
    (editingInstance && takeoffItems.some((i) => i.id === editingInstance.item_id))
  );
  bar.style.display = placementActive || itemActionsRelevant ? '' : 'none';
  document.getElementById('takeoff-placement-mode').style.display = takeoffTool === 'area' ? '' : 'none';
  // Axis-lock/snap only ever mean something while actively tracing a
  // line/perimeter/area - hide them (not just the whole bar) for the
  // item-actions-only cases (a merely-selected item, an armed count item,
  // editing an existing instance's points) so the bar doesn't show
  // controls that don't apply to what's actually happening.
  document.getElementById('takeoff-axis-lock-chip').style.display = placementActive ? '' : 'none';
  document.getElementById('takeoff-snap-points-chip').style.display = placementActive ? '' : 'none';
  // Box/brush point-select only means something while click-to-edit is
  // active (editingInstance set) - mutually exclusive with placementActive,
  // since the committed-instances layer that's clickable to enter edit mode
  // is itself disabled the moment a placement tool arms (see
  // renderTakeoffPane's edit-enabled toggle).
  document.getElementById('takeoff-edit-select-group').style.display = editingInstance ? 'flex' : 'none';
}

// Rebuilds the <option> list and re-syncs the selected value from current
// state - called on initial load and again any time scaleZones changes, so
// picking/leaving "Multiple scales" always reflects reality without a full
// page reload.
function syncScaleSelectDisplay() {
  const select = document.getElementById('scale-select');
  // Native <select> doesn't fire `change` when you reselect the option
  // that's already active, so re-entering the management window once
  // "Multiple scales" is already selected needs its own always-clickable
  // button rather than depending on the dropdown alone.
  document.getElementById('scale-zones-manage-btn').style.display = scaleZones.length > 0 ? '' : 'none';
  select.innerHTML =
    '<option value="">Select scale...</option>' +
    STANDARD_SCALES.map((s, i) => `<option value="${i}">${s.label}</option>`).join('') +
    '<option value="custom">Custom...</option>' +
    '<option value="multiple">Multiple scales...</option>';

  if (scaleZones.length > 0) {
    // Zones exist - the dropdown always shows "Multiple scales" regardless
    // of the base scale value underneath, since that's the mode this sheet
    // is actually in. Clicking it again (even though it's already selected)
    // reopens the management window - the only way in or further edits.
    select.value = 'multiple';
    return;
  }

  if (scaleFeetPerInch) {
    const idx = STANDARD_SCALES.findIndex((s) => Math.abs(s.feetPerInch - scaleFeetPerInch) < 0.0001);
    if (idx >= 0) {
      select.value = String(idx);
    } else {
      let opt = select.querySelector('option[value="saved"]');
      if (!opt) {
        opt = document.createElement('option');
        opt.value = 'saved';
        select.insertBefore(opt, select.querySelector('option[value="custom"]'));
      }
      opt.textContent = `Custom (1"=${scaleFeetPerInch}')`;
      select.value = 'saved';
    }
  } else {
    select.value = '';
  }
}

async function setupScaleSelect(sheet) {
  const select = document.getElementById('scale-select');
  scaleFeetPerInch = sheet.scale_feet_per_inch || null;
  await loadScaleZones();
  syncScaleSelectDisplay();

  document.getElementById('scale-zones-manage-btn').addEventListener('click', () => {
    openScaleZonesModal();
  });

  select.addEventListener('change', async () => {
    const val = select.value;

    if (val === 'multiple') {
      openScaleZonesModal();
      syncScaleSelectDisplay(); // opening the modal doesn't itself change anything - just restore the real state
      return;
    }

    // Leaving "Multiple" mode for a single concrete scale is a deliberate,
    // confirmed action (see the plan's "Leaving Multiple mode" decision) -
    // the zones aren't just dormant, they're actually deleted, since a stray
    // zone left behind with no way to see it again would be confusing.
    if (scaleZones.length > 0) {
      const ok = await confirmModal({
        title: 'Switch to a single scale?',
        message: `This sheet has ${scaleZones.length} scale zone${scaleZones.length === 1 ? '' : 's'} defined. Choosing a single scale will delete ${scaleZones.length === 1 ? 'it' : 'them'} and use this scale everywhere on the sheet.`,
        confirmLabel: 'Delete zones & switch',
        danger: true,
      });
      if (!ok) {
        syncScaleSelectDisplay();
        return;
      }
      try {
        await api('DELETE', `/api/projects/${projectId}/sheets/${sheetId}/scale-zones`);
      } catch (err) {
        showToast(`Failed to clear scale zones: ${err.message}`, 'error');
      }
      scaleZones = [];
      renderScaleZoneOverlay();
    }

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
        syncScaleSelectDisplay();
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
      // Keeps the offline cache correct immediately rather than leaving it
      // stale until the next full sync - see updateCachedSheetMetadata.
      await updateCachedSheetMetadata(projectId, { id: sheetId, scale_feet_per_inch: scaleFeetPerInch });
    } catch (err) {
      // read-only role or offline - scale still usable locally this session, just won't persist
    }
    syncScaleSelectDisplay();
  });
}

// ---------- Manage scale zones modal ----------
function openScaleZonesModal() {
  openModal(`
    <h2>Multiple scales</h2>
    <p class="muted">Draw a box around any area of this sheet plotted at a different scale (e.g. an enlarged detail). Anything measured or taken off inside a box uses that box's scale; everywhere else keeps using this sheet's normal scale (currently ${scaleFeetPerInch ? scaleLabelFor(scaleFeetPerInch) : 'not set'}).</p>
    <div class="takeoff-template-picker-list" id="scale-zone-list"></div>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Close</button>
      <button type="button" class="primary" id="scale-zone-add-btn">+ Add zone</button>
    </div>
  `);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('scale-zone-add-btn').addEventListener('click', () => {
    openScaleZoneFormModal({ zone: null });
  });

  const listEl = document.getElementById('scale-zone-list');
  if (scaleZones.length === 0) {
    listEl.innerHTML = '<p class="muted">No scale zones yet.</p>';
    return;
  }
  listEl.innerHTML = scaleZones
    .map(
      (z) => `
      <div class="takeoff-template-picker-row" data-id="${z.id}" style="cursor:default;">
        <span class="takeoff-template-picker-name">${escapeHtml(z.label)}</span>
        <span class="muted">${escapeHtml(scaleLabelFor(z.scale_feet_per_inch))}</span>
        <button type="button" class="icon-btn" data-action="edit" title="Edit label/scale">&#9998;</button>
        <button type="button" class="icon-btn" data-action="redraw" title="Redraw box">&#9634;</button>
        <button type="button" class="icon-btn" data-action="delete" title="Delete">&#128465;</button>
      </div>`
    )
    .join('');
  listEl.querySelectorAll('.takeoff-template-picker-row').forEach((row) => {
    const zone = scaleZones.find((z) => z.id === Number(row.dataset.id));
    row.querySelector('[data-action="edit"]').addEventListener('click', () => {
      openScaleZoneFormModal({ zone });
    });
    row.querySelector('[data-action="redraw"]').addEventListener('click', () => {
      closeModal();
      armScaleZoneDraw({ zoneId: zone.id, label: zone.label, scaleFeetPerInch: zone.scale_feet_per_inch, firstCorner: null });
      showToast('Click two opposite corners to redraw this zone’s box.');
    });
    row.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      const ok = await confirmModal({
        title: 'Delete this scale zone?',
        message: `"${zone.label}" will be removed - anything in that area will fall back to the sheet's normal scale.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      try {
        await api('DELETE', `/api/projects/${projectId}/sheets/${sheetId}/scale-zones/${zone.id}`);
        await loadScaleZones();
        syncScaleSelectDisplay();
        showToast(`Deleted "${zone.label}".`, 'success');
      } catch (err) {
        showToast(`Failed to delete: ${err.message}`, 'error');
      }
      openScaleZonesModal();
    });
  });
}

// Label + scale fields for a new zone (then arms the box-draw) or an
// existing one (label/scale only - redrawing the box is a separate action
// from the list row, see openScaleZonesModal).
function openScaleZoneFormModal({ zone }) {
  const isNew = !zone;
  openModal(`
    <h2>${isNew ? 'Add scale zone' : 'Edit scale zone'}</h2>
    <div class="field">
      <label>Label</label>
      <input id="scale-zone-label" autocomplete="off" placeholder="e.g. Gym Enlarged Plan" value="${zone ? escapeHtml(zone.label) : ''}">
    </div>
    <div class="field">
      <label>Scale</label>
      <select id="scale-zone-scale-select">
        <option value="">Select scale...</option>
        ${STANDARD_SCALES.map((s, i) => `<option value="${i}">${s.label}</option>`).join('')}
        <option value="custom">Custom...</option>
      </select>
    </div>
    <p class="error" id="scale-zone-error" style="display:none;"></p>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Cancel</button>
      <button type="button" class="primary" id="modal-save">${isNew ? 'Save & draw box' : 'Save'}</button>
    </div>
  `);
  const scaleSelect = document.getElementById('scale-zone-scale-select');
  let customScaleValue = null;
  if (zone) {
    const idx = STANDARD_SCALES.findIndex((s) => Math.abs(s.feetPerInch - zone.scale_feet_per_inch) < 0.0001);
    if (idx >= 0) {
      scaleSelect.value = String(idx);
    } else {
      const opt = document.createElement('option');
      opt.value = 'saved';
      opt.textContent = `Custom (1"=${zone.scale_feet_per_inch}')`;
      scaleSelect.insertBefore(opt, scaleSelect.querySelector('option[value="custom"]'));
      scaleSelect.value = 'saved';
      customScaleValue = zone.scale_feet_per_inch;
    }
  }
  scaleSelect.addEventListener('change', async () => {
    if (scaleSelect.value !== 'custom') return;
    const input = await promptModal({
      title: 'Custom scale',
      message: 'Feet represented by 1 inch on the printed sheet (e.g. 4 for 1/4"=1\'-0"):',
      required: false,
    });
    const parsed = parseFloat(input);
    if (!parsed || parsed <= 0) {
      scaleSelect.value = '';
      return;
    }
    customScaleValue = parsed;
  });

  document.getElementById('modal-cancel').addEventListener('click', () => {
    closeModal();
    openScaleZonesModal();
  });
  document.getElementById('modal-save').addEventListener('click', async () => {
    const label = document.getElementById('scale-zone-label').value.trim();
    const errEl = document.getElementById('scale-zone-error');
    const scaleVal = scaleSelect.value;
    const scaleFeetPerInchValue =
      scaleVal === 'custom' || scaleVal === 'saved' ? customScaleValue : scaleVal === '' ? null : STANDARD_SCALES[Number(scaleVal)].feetPerInch;
    if (!label) {
      errEl.textContent = 'Label is required.';
      errEl.style.display = 'block';
      return;
    }
    if (!scaleFeetPerInchValue) {
      errEl.textContent = 'Choose a scale.';
      errEl.style.display = 'block';
      return;
    }
    if (isNew) {
      closeModal();
      armScaleZoneDraw({ zoneId: null, label, scaleFeetPerInch: scaleFeetPerInchValue, firstCorner: null });
      showToast('Click two opposite corners to draw the scale zone box.');
      return;
    }
    const saveBtn = document.getElementById('modal-save');
    saveBtn.disabled = true;
    try {
      await api('PATCH', `/api/projects/${projectId}/sheets/${sheetId}/scale-zones/${zone.id}`, {
        label,
        scale_feet_per_inch: scaleFeetPerInchValue,
      });
      await loadScaleZones();
      syncScaleSelectDisplay();
      closeModal();
      openScaleZonesModal();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
      saveBtn.disabled = false;
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
      scale_feet_per_inch: cached.scale_feet_per_inch ?? null,
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
  isAdmin = me.role === 'admin';
  magnifierCorner = me.settings && me.settings.magnifierCorner === 'bottom-right' ? 'bottom-right' : 'bottom-left';

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
  document.title = `${sheet.sheet_number} — HammGrid`;
  ensureCurrentSheetInOpenTabs();
  renderTabStrip();

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
  setupCompositeLayoutButton();
  if (currentSheet.is_composite) {
    setupCompositeLayoutInteraction();
    const bringInBtn = document.getElementById('composite-bring-in-btn');
    if (bringInBtn) bringInBtn.addEventListener('click', openBringInFragmentFlow);
  }
  setupSheetNavButtons();
  updateVersionBadge();
  renderSearchTermChip();
  setupZoomPan();
  magnifierLens = setupMagnifierLens();
  setupFreezePaneTool();
  restorePersistedFreezePanes();
  setupOverlayAlignDrag();
  await setupScaleSelect(sheet);
  setupScaleZoneDrawInteraction();
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
    apiBase: `/api/sheets/${sheetId}`,
    projectId,
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
    // Lets a rect/line/arrow markup's Edit panel offer precise real-world
    // length/width entry - reuses the exact same zone-aware scale lookup
    // and currentRenderScale conversion measure/take-off geometry already
    // does (effectiveScaleFeetPerInch/pixelsToFeet), rather than a second
    // parallel implementation. Omitted entirely for document markups (see
    // document-view.js's initMarkups call) - documents have no scale.
    getScaleFeetPerInch: (renderPxPoint) => effectiveScaleFeetPerInch([renderPxPoint]),
    getRenderScale: () => currentRenderScale,
  });

  await renderPdf(displayedVersionId);
  await markupsController.load();

  if (flagIdParam) {
    const geometry = markupsController.focusMarkup(flagIdParam);
    if (geometry) {
      userHasZoomedOrPanned = true;
      panToRect(geometry.x, geometry.y, geometry.w, geometry.h);
    }
  }
})();
