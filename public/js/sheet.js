import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';
import { initMarkups } from '/js/markups.js';
import { getCachedAsset, getCachedSheets } from '/js/offline-store.js';
import { renderShell, openModal, closeModal } from '/js/shell.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

const params = new URLSearchParams(window.location.search);
const projectId = params.get('projectId');
const sheetId = params.get('sheetId');
document.getElementById('back-link').href = `/viewer.html?projectId=${projectId}`;

let markupsController = null;
let currentSheet = null;
let allVersions = [];
let displayedVersionId = null;
let overlayActive = false;
let overlayLayers = { old: null, new: null, showOld: true, showNew: true };

// ---------- Right pane collapse ----------
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

// ---------- Zoom / pan ----------
const zoomState = { scale: 1, x: 0, y: 0 };

function applyZoomTransform() {
  document.getElementById('zoom-pan-inner').style.transform =
    `translate(${zoomState.x}px, ${zoomState.y}px) scale(${zoomState.scale})`;
  if (markupsController) markupsController.repositionPopup();
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
        const newScale = Math.min(6, Math.max(0.25, zoomState.scale * factor));
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

// ---------- PDF rendering ----------
// Reads the PDF from OPFS if this version has been synced - no network in
// the path of viewing a sheet, per CLAUDE.md - falling back to the
// authenticated network endpoint for versions that were never synced.
// Render scale bumped + explicit smoothing for a cleaner image under zoom.
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
    const viewport = page.getViewport({ scale: 2.5 });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    await page.render({ canvasContext: ctx, viewport }).promise;
    statusEl.textContent = cachedFile ? '(from local cache)' : '';
    if (markupsController) markupsController.resync();
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

// ---------- Version badge + watermark + history list ----------
function updateVersionBadge() {
  const v = allVersions.find((x) => x.id === displayedVersionId);
  document.getElementById('version-badge-btn').innerHTML = `${v ? v.revision_title : 'Current'} &#9662;`;

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

function renderVersionList() {
  const list = document.getElementById('version-list');
  list.innerHTML = '';
  for (const v of allVersions) {
    const li = document.createElement('li');
    const isCurrent = v.id === currentSheet.current_version_id;
    const a = document.createElement('a');
    a.href = '#';
    a.className = isCurrent ? 'current' : '';
    a.textContent = `${v.revision_title}${isCurrent ? ' (current)' : ''}`;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      showVersion(v.id);
    });
    li.appendChild(a);
    list.appendChild(li);
  }
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
}

function enterOverlay(oldVersionId, newVersionId) {
  overlayActive = true;
  overlayLayers = { old: oldVersionId, new: newVersionId, showOld: true, showNew: true };
  document.getElementById('markup-svg').style.display = 'none';

  let bar = document.getElementById('overlay-controls-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'overlay-controls-bar';
    bar.className = 'card';
    document.getElementById('sheet-title').insertAdjacentElement('afterend', bar);
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
    currentSheet = sheet;
    allVersions = versions;
    displayedVersionId = sheet.current_version_id;
    document.getElementById('sheet-number').textContent = sheet.sheet_number;
    renderVersionList();
    updateVersionBadge();
    setupZoomPan();
    markupsController = initMarkups({
      sheetId,
      me,
      svgEl: document.getElementById('markup-svg'),
      canvasEl: document.getElementById('pdf-canvas'),
      documents: [],
    });
    await renderPdf(displayedVersionId);
    await markupsController.load();
    return;
  }

  currentSheet = sheet;
  allVersions = versions;
  displayedVersionId = sheet.current_version_id;

  await renderShell({
    topbarEl: document.getElementById('topbar'),
    sidebarEl: document.getElementById('sidebar'),
    projectId,
    active: 'viewer',
    me,
    onOverlayClick: openOverlayPicker,
  });

  document.getElementById('sheet-number').textContent = sheet.sheet_number;
  const current = versions.find((v) => v.id === sheet.current_version_id);
  document.getElementById('sheet-title').textContent = current ? current.title : '';

  renderVersionList();
  updateVersionBadge();
  setupZoomPan();

  let documents = [];
  try {
    ({ documents } = await api('GET', `/api/projects/${projectId}/documents`));
  } catch (err) {
    // offline - markup linking dropdown just won't have options this session
  }

  markupsController = initMarkups({
    sheetId,
    me,
    svgEl: document.getElementById('markup-svg'),
    canvasEl: document.getElementById('pdf-canvas'),
    documents,
  });

  await renderPdf(displayedVersionId);
  await markupsController.load();
})();
