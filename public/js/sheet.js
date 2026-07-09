import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';
import { initMarkups } from '/js/markups.js';
import { getCachedAsset, getCachedSheets } from '/js/offline-store.js';
import { renderShell, openModal, closeModal } from '/js/shell.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

const RENDER_SCALE = 2.5; // PDF points -> canvas pixels; also used for measurement unit math

const params = new URLSearchParams(window.location.search);
const projectId = params.get('projectId');
const sheetId = params.get('sheetId');

let markupsController = null;
let currentSheet = null;
let allVersions = [];
let displayedVersionId = null;
let overlayActive = false;
let overlayLayers = { old: null, new: null, showOld: true, showNew: true };

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

// ---------- Zoom / pan ----------
const zoomState = { scale: 1, x: 0, y: 0 };

function applyZoomTransform() {
  document.getElementById('zoom-pan-inner').style.transform =
    `translate(${zoomState.x}px, ${zoomState.y}px) scale(${zoomState.scale})`;
  if (markupsController) markupsController.repositionPopup();
}

// Fits the whole rendered page inside the viewport on load / version switch,
// instead of opening at native (very zoomed-in) resolution.
function fitToView() {
  const canvas = document.getElementById('pdf-canvas');
  const wrap = document.getElementById('zoom-wrap');
  const rect = wrap.getBoundingClientRect();
  if (!canvas.width || !rect.width) return;
  const fitScale = Math.min(rect.width / canvas.width, rect.height / canvas.height) * 0.96;
  zoomState.scale = fitScale;
  zoomState.x = (rect.width - canvas.width * fitScale) / 2;
  zoomState.y = (rect.height - canvas.height * fitScale) / 2;
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
    if (markupsController && markupsController.isToolActive()) return;
    if (measureTool) return;
    const tag = e.target.tagName.toLowerCase();
    if (tag !== 'svg' && tag !== 'canvas') return;
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

// ---------- PDF rendering ----------
// Reads the PDF from OPFS if this version has been synced - no network in
// the path of viewing a sheet, per CLAUDE.md - falling back to the
// authenticated network endpoint for versions that were never synced.
async function renderPdf(versionId) {
  const statusEl = document.getElementById('pdf-status');
  statusEl.textContent = 'Loading...';
  const canvas = document.getElementById('pdf-canvas');
  try {
    const cachedFile = await getCachedAsset(versionId, 'pdf');
    const source = cachedFile
      ? { data: await cachedFile.arrayBuffer() }
      : { url: `/api/sheet-versions/${versionId}/pdf` };
    const loadingTask = pdfjsLib.getDocument(source);
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    await page.render({ canvasContext: ctx, viewport }).promise;
    statusEl.textContent = cachedFile ? '(from local cache)' : '';
    if (markupsController) markupsController.resync();
    fitToView();
  } catch (err) {
    statusEl.textContent = `Failed to render PDF: ${err.message}`;
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

// Old -> blue, new -> red, shared -> black, blank -> white. Mirrors
// pyproc/overlay.py's formula exactly (R=g_old, G=min(g_old,g_new), B=g_new).
async function computeOverlay() {
  const { old: oldId, new: newId, showOld, showNew } = overlayLayers;
  const canvas = document.getElementById('pdf-canvas');
  const statusEl = document.getElementById('pdf-status');
  statusEl.textContent = 'Loading overlay...';

  const [oldImg, newImg] = await Promise.all([
    loadImage(`/api/sheet-versions/${oldId}/preview`),
    loadImage(`/api/sheet-versions/${newId}/preview`),
  ]);

  const width = Math.max(oldImg.naturalWidth, newImg.naturalWidth);
  const height = Math.max(oldImg.naturalHeight, newImg.naturalHeight);
  canvas.width = width;
  canvas.height = height;

  function toGray(img) {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const cx = c.getContext('2d');
    cx.fillStyle = 'white';
    cx.fillRect(0, 0, width, height);
    cx.drawImage(img, 0, 0);
    return cx.getImageData(0, 0, width, height).data;
  }

  const oldPixels = showOld ? toGray(oldImg) : null;
  const newPixels = showNew ? toGray(newImg) : null;

  const ctx = canvas.getContext('2d');
  const out = ctx.createImageData(width, height);
  const outPixels = out.data;
  for (let i = 0; i < outPixels.length; i += 4) {
    const gOld = oldPixels ? 0.299 * oldPixels[i] + 0.587 * oldPixels[i + 1] + 0.114 * oldPixels[i + 2] : 255;
    const gNew = newPixels ? 0.299 * newPixels[i] + 0.587 * newPixels[i + 1] + 0.114 * newPixels[i + 2] : 255;
    if (showOld && showNew) {
      outPixels[i] = gOld;
      outPixels[i + 1] = Math.min(gOld, gNew);
      outPixels[i + 2] = gNew;
    } else if (showOld) {
      outPixels[i] = outPixels[i + 1] = outPixels[i + 2] = gOld;
    } else if (showNew) {
      outPixels[i] = outPixels[i + 1] = outPixels[i + 2] = gNew;
    } else {
      outPixels[i] = outPixels[i + 1] = outPixels[i + 2] = 255;
    }
    outPixels[i + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  statusEl.textContent = '';
  fitToView();
}

function enterOverlay(oldVersionId, newVersionId) {
  overlayActive = true;
  overlayLayers = { old: oldVersionId, new: newVersionId, showOld: true, showNew: true };
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
      <label><input type="checkbox" id="overlay-toggle-old" checked> Old (blue)</label>
      <label><input type="checkbox" id="overlay-toggle-new" checked> New (red)</label>
      <button type="button" id="overlay-exit-btn">Exit overlay</button>
    </div>
  `;
  document.getElementById('overlay-toggle-old').addEventListener('change', (e) => {
    overlayLayers.showOld = e.target.checked;
    computeOverlay();
  });
  document.getElementById('overlay-toggle-new').addEventListener('change', (e) => {
    overlayLayers.showNew = e.target.checked;
    computeOverlay();
  });
  document.getElementById('overlay-exit-btn').addEventListener('click', () => exitOverlay(true));

  computeOverlay();
}

function exitOverlay(rerender) {
  if (!overlayActive) return;
  overlayActive = false;
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
        const [oldV, newV] =
          current.published_at <= otherPublished ? [displayedVersionId, otherVersionId] : [otherVersionId, displayedVersionId];
        enterOverlay(oldV, newV);
      });
    });
  } else {
    closeModal();
    const current = allVersions.find((v) => v.id === displayedVersionId);
    const [oldV, newV] =
      current.published_at <= otherSheet.current_published_at
        ? [displayedVersionId, otherSheet.current_version_id]
        : [otherSheet.current_version_id, displayedVersionId];
    enterOverlay(oldV, newV);
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
  const inches = pixelDist / RENDER_SCALE / 72;
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
  const feetPerPixel = (1 / RENDER_SCALE / 72) * scaleFeetPerInch;
  return pixelArea * feetPerPixel * feetPerPixel;
}

function redrawMeasure(livePt) {
  const g = ensureMeasureLayer();
  g.innerHTML = '';
  const pts = livePt ? [...measurePoints, livePt] : measurePoints;
  if (pts.length === 0) return;

  const poly = measureSvgNs('polyline');
  poly.setAttribute('points', pts.map((p) => `${p.x},${p.y}`).join(' '));
  poly.setAttribute('stroke', '#f59e0b');
  poly.setAttribute('stroke-width', 2);
  poly.setAttribute('fill', 'none');
  poly.setAttribute('stroke-dasharray', '5 3');
  g.appendChild(poly);

  for (const p of pts) {
    const c = measureSvgNs('circle');
    c.setAttribute('cx', p.x);
    c.setAttribute('cy', p.y);
    c.setAttribute('r', 4);
    c.setAttribute('fill', '#f59e0b');
    g.appendChild(c);
  }
}

function stopMeasureTool() {
  measureTool = null;
  document.querySelectorAll('#measure-tool-grid .tool-btn').forEach((b) => b.classList.remove('active'));
}

function finishMeasurement() {
  const resultEl = document.getElementById('measure-result');
  if (measureTool === 'perimeter' && measurePoints.length >= 2) {
    const feet = polylineLengthFeet(measurePoints);
    resultEl.textContent = `Length: ${feet.toFixed(1)} ft (${formatFeetInches(feet)})`;
    resultEl.style.display = 'block';
  } else if (measureTool === 'area' && measurePoints.length >= 3) {
    const areaFt = polygonAreaFeet(measurePoints);
    const perimFt = polylineLengthFeet([...measurePoints, measurePoints[0]]);
    resultEl.textContent = `Area: ${areaFt.toLocaleString(undefined, { maximumFractionDigits: 0 })} SF, Perimeter: ${perimFt.toFixed(1)} ft`;
    resultEl.style.display = 'block';
    const g = ensureMeasureLayer();
    g.innerHTML = '';
    const poly = measureSvgNs('polygon');
    poly.setAttribute('points', measurePoints.map((p) => `${p.x},${p.y}`).join(' '));
    poly.setAttribute('stroke', '#f59e0b');
    poly.setAttribute('stroke-width', 2);
    poly.setAttribute('fill', '#f59e0b');
    poly.setAttribute('fill-opacity', '0.15');
    g.appendChild(poly);
  }
  stopMeasureTool();
}

function setupMeasureInteraction() {
  const svg = document.getElementById('markup-svg');
  svg.addEventListener('click', (e) => {
    if (!measureTool || e.target.id !== 'markup-svg') return;
    const pt = getMeasureSvgPoint(e);

    if (measureTool === 'line') {
      measurePoints.push(pt);
      redrawMeasure();
      if (measurePoints.length === 2) {
        const feet = polylineLengthFeet(measurePoints);
        const resultEl = document.getElementById('measure-result');
        resultEl.textContent = `Length: ${feet.toFixed(1)} ft (${formatFeetInches(feet)})`;
        resultEl.style.display = 'block';
        stopMeasureTool();
      }
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
  });

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
        alert('Set a scale first.');
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
      const input = prompt('Enter feet represented by 1 inch on the printed sheet (e.g. 4 for 1/4"=1\'-0"):');
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

  updateVersionBadge();
  setupZoomPan();
  setupScaleSelect(sheet);
  setupMeasureTools();

  let documents = [];
  if (!offlineMode) {
    try {
      ({ documents } = await api('GET', `/api/projects/${projectId}/documents`));
    } catch (err) {
      // offline - markup linking dropdown just won't have options this session
    }
  }

  markupsController = initMarkups({
    sheetId,
    me,
    svgEl: document.getElementById('markup-svg'),
    canvasEl: document.getElementById('pdf-canvas'),
    documents,
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
