import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';
import { initMarkups } from '/js/markups.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

const params = new URLSearchParams(window.location.search);
const projectId = params.get('projectId');
const sheetId = params.get('sheetId');
document.getElementById('back-link').href = `/viewer.html?projectId=${projectId}`;

let markupsController = null;

async function loadShell() {
  const me = await requireSession();
  if (!me) return null;
  document.getElementById('whoami').textContent = `${me.name} (${me.role})`;
  return me;
}

async function renderPdf(versionId) {
  const statusEl = document.getElementById('pdf-status');
  statusEl.textContent = 'Loading...';
  const canvas = document.getElementById('pdf-canvas');
  try {
    const loadingTask = pdfjsLib.getDocument(`/api/sheet-versions/${versionId}/pdf`);
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 2 });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    statusEl.textContent = '';
    if (markupsController) markupsController.resync();
  } catch (err) {
    statusEl.textContent = `Failed to render PDF: ${err.message}`;
  }
}

function renderVersionList(sheet, versions) {
  const list = document.getElementById('version-list');
  list.innerHTML = '';
  for (const v of versions) {
    const li = document.createElement('li');
    const isCurrent = v.id === sheet.current_version_id;
    const a = document.createElement('a');
    a.href = '#';
    a.className = isCurrent ? 'current' : '';
    a.textContent = `${v.revision_title}${isCurrent ? ' (current)' : ''}`;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      renderPdf(v.id);
    });
    li.appendChild(a);
    list.appendChild(li);
  }
}

document.getElementById('logout').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout');
  window.location.href = '/login.html';
});

// --- Version compare / overlay ---

let allVersions = [];
let currentSheet = null;
const compareState = { offsetX: 0, offsetY: 0, scale: 1, oldImg: null, newImg: null };

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('failed to load'));
    img.src = src;
  });
}

function setupCompare(sheet, versions) {
  allVersions = versions;
  currentSheet = sheet;
  const card = document.getElementById('compare-card');
  if (versions.length < 2) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';

  const oldSelect = document.getElementById('compare-old');
  const newSelect = document.getElementById('compare-new');
  oldSelect.innerHTML = '';
  newSelect.innerHTML = '';
  for (const v of versions) {
    const label = `${v.revision_title}${v.id === sheet.current_version_id ? ' (current)' : ''}`;
    oldSelect.appendChild(new Option(label, v.id));
    newSelect.appendChild(new Option(label, v.id));
  }

  const currentIndex = versions.findIndex((v) => v.id === sheet.current_version_id);
  const previous = versions[currentIndex + 1];
  newSelect.value = sheet.current_version_id;
  if (previous) oldSelect.value = previous.id;

  loadCompare();
}

async function drawPrebaked(versionId) {
  const canvas = document.getElementById('compare-canvas');
  const img = await loadImage(`/api/sheet-versions/${versionId}/overlay`);
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d').drawImage(img, 0, 0);
}

function recompositeCanvas() {
  const { oldImg, newImg, offsetX, offsetY, scale } = compareState;
  if (!oldImg || !newImg) return;
  const canvas = document.getElementById('compare-canvas');
  const width = Math.max(oldImg.naturalWidth, newImg.naturalWidth);
  const height = Math.max(oldImg.naturalHeight, newImg.naturalHeight);
  canvas.width = width;
  canvas.height = height;

  const oldCanvas = document.createElement('canvas');
  oldCanvas.width = width;
  oldCanvas.height = height;
  const oldCtx = oldCanvas.getContext('2d');
  oldCtx.fillStyle = 'white';
  oldCtx.fillRect(0, 0, width, height);
  oldCtx.drawImage(oldImg, 0, 0);

  const newCanvas = document.createElement('canvas');
  newCanvas.width = width;
  newCanvas.height = height;
  const newCtx = newCanvas.getContext('2d');
  newCtx.fillStyle = 'white';
  newCtx.fillRect(0, 0, width, height);
  newCtx.save();
  newCtx.translate(width / 2 + offsetX, height / 2 + offsetY);
  newCtx.scale(scale, scale);
  newCtx.translate(-width / 2, -height / 2);
  newCtx.drawImage(newImg, 0, 0);
  newCtx.restore();

  const oldPixels = oldCtx.getImageData(0, 0, width, height).data;
  const newPixels = newCtx.getImageData(0, 0, width, height).data;
  const out = oldCtx.createImageData(width, height);
  const outPixels = out.data;

  // Old -> red channel, new -> cyan (green+blue): unchanged=black, blank=white,
  // removed (old only)=red, added (new only)=cyan. Mirrors pyproc/overlay.py.
  for (let i = 0; i < outPixels.length; i += 4) {
    const grayOld = 0.299 * oldPixels[i] + 0.587 * oldPixels[i + 1] + 0.114 * oldPixels[i + 2];
    const grayNew = 0.299 * newPixels[i] + 0.587 * newPixels[i + 1] + 0.114 * newPixels[i + 2];
    outPixels[i] = grayNew;
    outPixels[i + 1] = grayOld;
    outPixels[i + 2] = grayOld;
    outPixels[i + 3] = 255;
  }

  canvas.getContext('2d').putImageData(out, 0, 0);
}

function resetAlignment(shouldRecomposite) {
  compareState.offsetX = 0;
  compareState.offsetY = 0;
  compareState.scale = 1;
  document.getElementById('compare-scale').value = 1;
  if (shouldRecomposite) recompositeCanvas();
}

async function loadCompare() {
  const oldId = Number(document.getElementById('compare-old').value);
  const newId = Number(document.getElementById('compare-new').value);
  const statusEl = document.getElementById('compare-status');
  compareState.oldImg = null;
  compareState.newImg = null;
  resetAlignment(false);

  if (oldId === newId) {
    statusEl.textContent = 'Pick two different versions to compare.';
    return;
  }

  const currentIndex = allVersions.findIndex((v) => v.id === currentSheet.current_version_id);
  const previous = allVersions[currentIndex + 1];
  const isDefaultPair = previous && newId === currentSheet.current_version_id && oldId === previous.id;
  const currentVersion = allVersions.find((v) => v.id === currentSheet.current_version_id);

  if (isDefaultPair && currentVersion && currentVersion.overlay_path) {
    statusEl.textContent = 'Loaded pre-baked overlay - hydrating for drag/scale...';
    try {
      await drawPrebaked(newId);
    } catch (err) {
      // fall through to the interactive load below
    }
  } else {
    statusEl.textContent = 'Loading...';
  }

  try {
    const [oldImg, newImg] = await Promise.all([
      loadImage(`/api/sheet-versions/${oldId}/preview`),
      loadImage(`/api/sheet-versions/${newId}/preview`),
    ]);
    compareState.oldImg = oldImg;
    compareState.newImg = newImg;
    recompositeCanvas();
    statusEl.textContent = '';
  } catch (err) {
    statusEl.textContent = `Failed to load: ${err.message}`;
  }
}

let dragging = null;
const compareCanvas = document.getElementById('compare-canvas');
compareCanvas.addEventListener('mousedown', (e) => {
  if (!compareState.oldImg) return;
  dragging = { startX: e.clientX, startY: e.clientY, origX: compareState.offsetX, origY: compareState.offsetY };
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  compareState.offsetX = dragging.origX + (e.clientX - dragging.startX);
  compareState.offsetY = dragging.origY + (e.clientY - dragging.startY);
  recompositeCanvas();
});
window.addEventListener('mouseup', () => {
  dragging = null;
});

document.getElementById('compare-scale').addEventListener('input', (e) => {
  compareState.scale = Number(e.target.value);
  recompositeCanvas();
});
document.getElementById('compare-old').addEventListener('change', loadCompare);
document.getElementById('compare-new').addEventListener('change', loadCompare);
document.getElementById('compare-reset').addEventListener('click', () => resetAlignment(true));

(async function init() {
  const me = await loadShell();
  if (!me) return;

  const { sheet, versions } = await api('GET', `/api/projects/${projectId}/sheets/${sheetId}`);
  document.getElementById('sheet-number').textContent = sheet.sheet_number;
  const current = versions.find((v) => v.id === sheet.current_version_id);
  document.getElementById('sheet-title').textContent = current ? current.title : '';

  renderVersionList(sheet, versions);
  setupCompare(sheet, versions);

  const { documents } = await api('GET', `/api/projects/${projectId}/documents`);
  markupsController = initMarkups({
    sheetId,
    me,
    svgEl: document.getElementById('markup-svg'),
    canvasEl: document.getElementById('pdf-canvas'),
    documents,
  });

  await renderPdf(sheet.current_version_id);
  await markupsController.load();
})();
