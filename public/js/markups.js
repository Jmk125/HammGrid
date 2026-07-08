import { getCachedMarkupsForSheet } from '/js/offline-store.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const TYPE_LABELS = { line: 'Line', arrow: 'Arrow', rect: 'Rectangle', cloud: 'Cloud', text: 'Text' };

function el(tag) {
  return document.createElementNS(SVG_NS, tag);
}

function pointOnRectPerimeter(x, y, w, h, d) {
  if (d <= w) return { x: x + d, y };
  d -= w;
  if (d <= h) return { x: x + w, y: y + d };
  d -= h;
  if (d <= w) return { x: x + w - d, y: y + h };
  d -= w;
  return { x, y: y + h - d };
}

function cloudPath(x, y, w, h) {
  const bumpSize = Math.max(10, Math.min(w, h) / 6);
  const perimeter = 2 * (w + h);
  const bumps = Math.max(6, Math.round(perimeter / bumpSize));
  const points = [];
  for (let i = 0; i <= bumps; i++) {
    points.push(pointOnRectPerimeter(x, y, w, h, (perimeter * i) / bumps));
  }
  const cx = x + w / 2;
  const cy = y + h / 2;
  let d = `M ${points[0].x} ${points[0].y} `;
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1];
    const p1 = points[i];
    const mx = (p0.x + p1.x) / 2;
    const my = (p0.y + p1.y) / 2;
    const nx = mx - cx;
    const ny = my - cy;
    const len = Math.hypot(nx, ny) || 1;
    const ctrlX = mx + (nx / len) * (bumpSize * 0.5);
    const ctrlY = my + (ny / len) * (bumpSize * 0.5);
    d += `Q ${ctrlX} ${ctrlY} ${p1.x} ${p1.y} `;
  }
  return d + 'Z';
}

export function initMarkups({ sheetId, me, svgEl, canvasEl, documents }) {
  let activeTool = 'select';
  let markups = [];
  let drawing = null;
  let previewEl = null;

  const colorInput = document.getElementById('markup-color');
  const widthInput = document.getElementById('markup-width');
  const publishDefaultInput = document.getElementById('markup-publish-default');

  if (me.role === 'admin' || me.role === 'editor') {
    document.getElementById('publish-default-wrap').style.display = '';
  }

  function syncViewBox() {
    svgEl.setAttribute('viewBox', `0 0 ${canvasEl.width} ${canvasEl.height}`);
  }

  function vbSize() {
    const vb = svgEl.viewBox.baseVal;
    return { w: vb.width || canvasEl.width, h: vb.height || canvasEl.height };
  }

  function getSvgPoint(evt) {
    const rect = svgEl.getBoundingClientRect();
    const { w, h } = vbSize();
    return {
      x: ((evt.clientX - rect.left) / rect.width) * w,
      y: ((evt.clientY - rect.top) / rect.height) * h,
    };
  }

  function ensureArrowMarker(color) {
    const id = `arrowhead-${color.replace('#', '')}`;
    if (svgEl.querySelector(`#${id}`)) return id;
    let defs = svgEl.querySelector('defs');
    if (!defs) {
      defs = el('defs');
      svgEl.insertBefore(defs, svgEl.firstChild);
    }
    const marker = el('marker');
    marker.setAttribute('id', id);
    marker.setAttribute('markerWidth', '10');
    marker.setAttribute('markerHeight', '10');
    marker.setAttribute('refX', '8');
    marker.setAttribute('refY', '3');
    marker.setAttribute('orient', 'auto');
    const path = el('path');
    path.setAttribute('d', 'M0,0 L0,6 L9,3 z');
    path.setAttribute('fill', color);
    marker.appendChild(path);
    defs.appendChild(marker);
    return id;
  }

  function renderMarkupEl(m) {
    const { w, h } = vbSize();
    const color = (m.style && m.style.color) || '#e11d48';
    const strokeWidth = (m.style && m.style.strokeWidth) || 2;
    let node;

    if (m.type === 'line' || m.type === 'arrow') {
      node = el('line');
      node.setAttribute('x1', m.geometry.x1 * w);
      node.setAttribute('y1', m.geometry.y1 * h);
      node.setAttribute('x2', m.geometry.x2 * w);
      node.setAttribute('y2', m.geometry.y2 * h);
      node.setAttribute('stroke', color);
      node.setAttribute('stroke-width', strokeWidth);
      if (m.type === 'arrow') node.setAttribute('marker-end', `url(#${ensureArrowMarker(color)})`);
    } else if (m.type === 'rect') {
      node = el('rect');
      node.setAttribute('x', m.geometry.x * w);
      node.setAttribute('y', m.geometry.y * h);
      node.setAttribute('width', m.geometry.w * w);
      node.setAttribute('height', m.geometry.h * h);
      node.setAttribute('fill', 'none');
      node.setAttribute('stroke', color);
      node.setAttribute('stroke-width', strokeWidth);
    } else if (m.type === 'cloud') {
      node = el('path');
      node.setAttribute('d', cloudPath(m.geometry.x * w, m.geometry.y * h, m.geometry.w * w, m.geometry.h * h));
      node.setAttribute('fill', 'none');
      node.setAttribute('stroke', color);
      node.setAttribute('stroke-width', strokeWidth);
    } else if (m.type === 'text') {
      node = el('text');
      node.setAttribute('x', m.geometry.x * w);
      node.setAttribute('y', m.geometry.y * h);
      node.setAttribute('fill', color);
      node.setAttribute('font-size', (m.style && m.style.fontSize) || 20);
      node.textContent = m.geometry.text || '';
    }

    node.dataset.markupId = m.id;
    node.style.cursor = m.linked_document_id ? 'pointer' : 'default';
    if (m.visibility === 'private' && m.type !== 'text') {
      node.setAttribute('stroke-dasharray', '5 3');
    }
    node.style.opacity = m.visibility === 'private' ? '0.65' : '1';
    node.addEventListener('click', (e) => {
      e.stopPropagation();
      if (m.linked_document_id) window.open(`/api/documents/${m.linked_document_id}/pdf`, '_blank');
    });
    return node;
  }

  function renderAll() {
    svgEl.querySelectorAll('[data-markup-id]').forEach((n) => n.remove());
    for (const m of markups) svgEl.appendChild(renderMarkupEl(m));
    renderList();
  }

  function renderList() {
    const list = document.getElementById('markup-list');
    list.innerHTML = '';
    for (const m of markups) {
      const li = document.createElement('li');
      const header = document.createElement('div');
      header.innerHTML = `<span class="pill ${m.visibility}">${m.visibility}</span> ${TYPE_LABELS[m.type]} &mdash; ${m.author_name}`;
      li.appendChild(header);

      const canManage = m.author_id === me.id || me.role === 'admin';
      const canPublish = (me.role === 'editor' || me.role === 'admin') && m.visibility === 'private';

      const linkSelect = document.createElement('select');
      linkSelect.innerHTML =
        '<option value="">No linked document</option>' +
        documents
          .map(
            (d) =>
              `<option value="${d.id}" ${d.id === m.linked_document_id ? 'selected' : ''}>${d.kind.toUpperCase()} ${d.number || ''} ${d.title || ''}</option>`
          )
          .join('');
      linkSelect.disabled = !canManage;
      linkSelect.addEventListener('change', async () => {
        const { markup } = await api('PATCH', `/api/markups/${m.id}`, {
          linked_document_id: linkSelect.value ? Number(linkSelect.value) : null,
        });
        Object.assign(m, markup);
        renderAll();
      });
      li.appendChild(linkSelect);

      const actions = document.createElement('div');
      actions.className = 'row';
      if (canPublish) {
        const btn = document.createElement('button');
        btn.textContent = 'Publish';
        btn.addEventListener('click', async () => {
          const { markup } = await api('PATCH', `/api/markups/${m.id}`, { visibility: 'published' });
          Object.assign(m, markup);
          renderAll();
        });
        actions.appendChild(btn);
      }
      if (canManage) {
        const del = document.createElement('button');
        del.className = 'danger';
        del.textContent = 'Delete';
        del.addEventListener('click', async () => {
          if (!confirm('Delete this markup?')) return;
          await api('DELETE', `/api/markups/${m.id}`);
          markups = markups.filter((x) => x.id !== m.id);
          renderAll();
        });
        actions.appendChild(del);
      }
      if (actions.children.length) li.appendChild(actions);

      list.appendChild(li);
    }
  }

  async function createMarkup(type, geometry) {
    const style = { color: colorInput.value, strokeWidth: Number(widthInput.value) };
    const visibility = publishDefaultInput.checked ? 'published' : 'private';
    const { markup } = await api('POST', `/api/sheets/${sheetId}/markups`, { type, geometry, style, visibility });
    markups.push(markup);
    renderAll();
  }

  function activateTool(tool) {
    activeTool = tool;
    document.querySelectorAll('.tool-btn').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    svgEl.style.cursor = tool === 'select' ? 'default' : 'crosshair';
  }

  document.querySelectorAll('.tool-btn').forEach((btn) => {
    btn.addEventListener('click', () => activateTool(btn.dataset.tool));
  });
  activateTool('select');

  svgEl.addEventListener('mousedown', async (e) => {
    if (activeTool === 'select') return;
    const pt = getSvgPoint(e);

    if (activeTool === 'text') {
      const text = prompt('Text:');
      activateTool('select');
      if (!text) return;
      const { w, h } = vbSize();
      await createMarkup('text', { x: pt.x / w, y: pt.y / h, text });
      return;
    }

    drawing = { type: activeTool, start: pt };
    previewEl = el(activeTool === 'line' || activeTool === 'arrow' ? 'line' : activeTool === 'cloud' ? 'path' : 'rect');
    previewEl.setAttribute('stroke', colorInput.value);
    previewEl.setAttribute('stroke-width', widthInput.value);
    previewEl.setAttribute('fill', 'none');
    previewEl.setAttribute('stroke-dasharray', '4 2');
    svgEl.appendChild(previewEl);
  });

  svgEl.addEventListener('mousemove', (e) => {
    if (!drawing) return;
    const pt = getSvgPoint(e);
    const { type, start } = drawing;
    if (type === 'line' || type === 'arrow') {
      previewEl.setAttribute('x1', start.x);
      previewEl.setAttribute('y1', start.y);
      previewEl.setAttribute('x2', pt.x);
      previewEl.setAttribute('y2', pt.y);
    } else {
      const x = Math.min(pt.x, start.x);
      const y = Math.min(pt.y, start.y);
      const w = Math.abs(pt.x - start.x);
      const h = Math.abs(pt.y - start.y);
      if (type === 'cloud') {
        previewEl.setAttribute('d', cloudPath(x, y, w, h));
      } else {
        previewEl.setAttribute('x', x);
        previewEl.setAttribute('y', y);
        previewEl.setAttribute('width', w);
        previewEl.setAttribute('height', h);
      }
    }
  });

  window.addEventListener('mouseup', async (e) => {
    if (!drawing) return;
    const pt = getSvgPoint(e);
    const { type, start } = drawing;
    if (previewEl) previewEl.remove();
    drawing = null;

    const { w, h } = vbSize();
    let geometry;
    if (type === 'line' || type === 'arrow') {
      if (Math.hypot(pt.x - start.x, pt.y - start.y) < 4) {
        activateTool('select');
        return;
      }
      geometry = { x1: start.x / w, y1: start.y / h, x2: pt.x / w, y2: pt.y / h };
    } else {
      const x0 = Math.min(pt.x, start.x);
      const y0 = Math.min(pt.y, start.y);
      const bw = Math.abs(pt.x - start.x);
      const bh = Math.abs(pt.y - start.y);
      if (bw < 4 || bh < 4) {
        activateTool('select');
        return;
      }
      geometry = { x: x0 / w, y: y0 / h, w: bw / w, h: bh / h };
    }
    await createMarkup(type, geometry);
    activateTool('select');
  });

  return {
    async load() {
      syncViewBox();
      try {
        const { markups: loaded } = await api('GET', `/api/sheets/${sheetId}/markups`);
        markups = loaded;
      } catch (err) {
        // Offline: fall back to whatever markups synced during the last visit.
        markups = await getCachedMarkupsForSheet(sheetId);
      }
      renderAll();
    },
    resync() {
      syncViewBox();
      renderAll();
    },
  };
}
