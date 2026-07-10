import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';
import { setupZoomPan } from '/js/zoomPan.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';
const params = new URLSearchParams(window.location.search);
const token = params.get('token');
const versionId = params.get('versionId');
const canvas = document.getElementById('pdf-canvas');
const svg = document.getElementById('markup-svg');
const colorInput = document.getElementById('markup-color');
let zoomPan = null;
let permissions = { allow_personal_markups: false };
let activeTool = 'select';
let drawing = null;
let preview = null;
let currentMarkups = [];

document.getElementById('back-link').href = `/share.html?token=${token}`;

function el(tag) { return document.createElementNS(SVG_NS, tag); }
function vbSize() { return { w: canvas.width, h: canvas.height }; }
function point(evt) {
  const p = evt.changedTouches ? evt.changedTouches[0] : evt;
  const rect = svg.getBoundingClientRect();
  return { x: ((p.clientX - rect.left) / rect.width) * canvas.width, y: ((p.clientY - rect.top) / rect.height) * canvas.height };
}
function normalizeRect(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}
function renderMarkup(m) {
  const { w, h } = vbSize();
  const style = m.style || {};
  let node;
  if (m.type === 'text') {
    node = el('text');
    node.setAttribute('x', m.geometry.x * w);
    node.setAttribute('y', m.geometry.y * h);
    node.setAttribute('fill', style.color || '#e11d48');
    node.setAttribute('font-size', 18 / (zoomPan ? zoomPan.state.scale : 1));
    node.textContent = m.geometry.text || '';
  } else {
    node = el(m.type === 'line' || m.type === 'arrow' ? 'line' : 'rect');
    if (m.type === 'line' || m.type === 'arrow') {
      node.setAttribute('x1', m.geometry.x1 * w); node.setAttribute('y1', m.geometry.y1 * h);
      node.setAttribute('x2', m.geometry.x2 * w); node.setAttribute('y2', m.geometry.y2 * h);
    } else {
      node.setAttribute('x', m.geometry.x * w); node.setAttribute('y', m.geometry.y * h);
      node.setAttribute('width', m.geometry.w * w); node.setAttribute('height', m.geometry.h * h);
      node.setAttribute('fill', 'none');
    }
    node.setAttribute('stroke', style.color || (m.source === 'published' ? '#b91c1c' : '#e11d48'));
    node.setAttribute('stroke-width', (style.strokeWidth || 2) / (zoomPan ? zoomPan.state.scale : 1));
  }
  node.style.pointerEvents = 'none';
  return node;
}
function renderAllMarkups() {
  svg.querySelectorAll('[data-share-markup]').forEach((n) => n.remove());
  for (const m of currentMarkups) {
    const node = renderMarkup(m);
    node.dataset.shareMarkup = '1';
    svg.appendChild(node);
  }
}
async function loadMarkups() {
  const { markups } = await api('GET', `/api/share/${token}/sheet-versions/${versionId}/markups`);
  currentMarkups = markups;
  renderAllMarkups();
}
async function createPersonalMarkup(type, geometry) {
  await api('POST', `/api/share/${token}/sheet-versions/${versionId}/markups`, {
    type,
    geometry,
    style: { color: colorInput.value, strokeWidth: 2 },
  });
  await loadMarkups();
}
function setupPersonalTools() {
  if (!permissions.allow_personal_markups) return;
  document.getElementById('share-markup-tools').style.display = '';
  document.querySelectorAll('#share-markup-tools .tool-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeTool = activeTool === btn.dataset.tool ? 'select' : btn.dataset.tool;
      document.querySelectorAll('#share-markup-tools .tool-btn').forEach((b) => b.classList.toggle('active', b.dataset.tool === activeTool));
    });
  });
  function start(evt) {
    if (activeTool === 'select' || evt.target !== svg) return;
    evt.preventDefault();
    const pt = point(evt);
    if (activeTool === 'text') {
      const text = prompt('Text:');
      activeTool = 'select';
      document.querySelectorAll('#share-markup-tools .tool-btn').forEach((b) => b.classList.remove('active'));
      if (text) createPersonalMarkup('text', { x: pt.x / canvas.width, y: pt.y / canvas.height, text });
      return;
    }
    drawing = { start: pt };
    preview = el('rect');
    preview.setAttribute('fill', 'none');
    preview.setAttribute('stroke', colorInput.value);
    preview.setAttribute('stroke-dasharray', '4 2');
    svg.appendChild(preview);
  }
  function move(evt) {
    if (!drawing) return;
    evt.preventDefault();
    const r = normalizeRect(drawing.start, point(evt));
    preview.setAttribute('x', r.x); preview.setAttribute('y', r.y); preview.setAttribute('width', r.w); preview.setAttribute('height', r.h);
  }
  async function end(evt) {
    if (!drawing) return;
    evt.preventDefault();
    const r = normalizeRect(drawing.start, point(evt));
    drawing = null;
    if (preview) preview.remove();
    preview = null;
    if (r.w < 4 || r.h < 4) return;
    await createPersonalMarkup('rect', { x: r.x / canvas.width, y: r.y / canvas.height, w: r.w / canvas.width, h: r.h / canvas.height });
  }
  svg.addEventListener('mousedown', start);
  svg.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  svg.addEventListener('touchstart', start, { passive: false });
  svg.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('touchend', end, { passive: false });
}

(async function render() {
  const statusEl = document.getElementById('pdf-status');
  statusEl.textContent = 'Loading...';
  try {
    const shareData = await api('GET', `/api/share/${token}`);
    permissions = shareData.permissions || permissions;
    const loadingTask = pdfjsLib.getDocument(`/api/share/${token}/sheet-versions/${versionId}/pdf`);
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 2 });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    svg.setAttribute('viewBox', `0 0 ${canvas.width} ${canvas.height}`);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    zoomPan = setupZoomPan({
      wrapEl: document.getElementById('zoom-wrap'),
      innerEl: document.getElementById('zoom-pan-inner'),
      isPanBlocked: () => activeTool !== 'select',
      onChange: renderAllMarkups,
    });
    zoomPan.fitToView(canvas.width, canvas.height);
    setupPersonalTools();
    await loadMarkups();
    statusEl.textContent = permissions.allow_personal_markups ? 'Personal markups enabled for this link.' : '';
  } catch (err) {
    statusEl.textContent = `Failed to render PDF: ${err.message}`;
  }
})();
