import { getCachedMarkupsForSheet } from '/js/offline-store.js';
import { openDocPicker } from '/js/docPicker.js';
import { confirmModal, promptModal, showToast } from '/js/shell.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const CLOUD_BUMP_SIZE = { 'cloud-small': 14, 'cloud-large': 30 };

const TOOL_ICONS = {
  line: '<svg viewBox="0 0 20 20"><line x1="3" y1="17" x2="17" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  arrow:
    '<svg viewBox="0 0 20 20"><line x1="3" y1="17" x2="15" y2="5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M8 5 L15 5 L15 12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  rect: '<svg viewBox="0 0 20 20"><rect x="3" y="5" width="14" height="10" stroke="currentColor" stroke-width="2" fill="none"/></svg>',
  cloud:
    '<svg viewBox="0 0 20 20"><path d="M5 14c-1.7 0-3-1.3-3-3 0-1.5 1.1-2.7 2.5-3-0.1-0.3-0.1-0.6-0.1-0.9 0-1.9 1.6-3.5 3.5-3.5 1.2 0 2.3 0.6 2.9 1.6 0.4-0.2 0.9-0.3 1.4-0.3 1.7 0 3.1 1.3 3.2 3 1.5 0.3 2.6 1.6 2.6 3.1 0 1.7-1.3 3-3 3H5z" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round"/></svg>',
  text: '<svg viewBox="0 0 20 20"><text x="4" y="15" font-size="14" font-weight="700" fill="currentColor" font-family="sans-serif">T</text></svg>',
  flag: '<svg viewBox="0 0 20 20"><path d="M5 17V3h11l-3 4 3 4H5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
};

const OPEN_DOC_ICON =
  '<svg viewBox="0 0 20 20"><path d="M8 4H4v12h12v-4M11 3h6v6M17 3l-8 8" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function el(tag) {
  return document.createElementNS(SVG_NS, tag);
}

function darkenHex(hex, amount) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '#e11d48');
  if (!m) return hex;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => Math.round(parseInt(h, 16) * (1 - amount)));
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
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

// "5'-6"" - same rounded-to-the-nearest-inch display sheet.js's own
// formatFeetInches uses for measure/take-off, kept as a separate small
// copy here rather than a cross-module import since it's the only thing
// from that world this module needs.
function formatFeetInches(feetDecimal) {
  const totalInches = Math.round(feetDecimal * 12);
  const feet = Math.floor(totalInches / 12);
  const inches = totalInches % 12;
  return `${feet}'-${inches}"`;
}

// Accepts whatever a field worker is likely to actually type: "8'-6"",
// "8' 6"", "8ft 6in", plain decimal feet ("8.5"), or bare inches ("102"").
// Returns decimal feet, or null if the text doesn't parse as a length at
// all (the caller leaves the field alone rather than silently zeroing it).
function parseFeetInches(str) {
  const s = String(str || '').trim();
  if (!s) return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const feetInches = s.match(/^(-?\d+(?:\.\d+)?)\s*(?:'|ft)[\s-]*(?:(\d+(?:\.\d+)?)\s*(?:"|in)?)?$/i);
  if (feetInches) return parseFloat(feetInches[1]) + (feetInches[2] ? parseFloat(feetInches[2]) / 12 : 0);
  const inchesOnly = s.match(/^(-?\d+(?:\.\d+)?)\s*(?:"|in)$/i);
  if (inchesOnly) return parseFloat(inchesOnly[1]) / 12;
  return null;
}

// Bump size is fixed regardless of box size (small/large tool choice), so
// segments look consistent like a real revision cloud - only the bump COUNT
// varies with the drawn box's perimeter, never the bump size itself.
function cloudPath(x, y, w, h, bumpSize) {
  const perimeter = 2 * (Math.max(w, 1) + Math.max(h, 1));
  const bumps = Math.max(4, Math.round(perimeter / bumpSize));
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

export function initMarkups({
  sheetId,
  apiBase,
  projectId,
  me,
  svgEl,
  canvasEl,
  documents,
  folders,
  onToolChange,
  page,
  getScaleFeetPerInch,
  getRenderScale,
}) {
  const base = apiBase || `/api/sheets/${sheetId}`;
  // Documents aren't pre-burst one-page-per-file like sheets are, so a
  // document-scoped instance is told which page it's showing (via `page`)
  // and filters/stamps geometry.page accordingly - a sheet instance never
  // passes this and behaves exactly as before (no filtering at all).
  let currentPage = page;
  let activeTool = 'select';
  let markups = [];
  let drawing = null;
  let previewEl = null;
  let selectedId = null;
  let editingId = null;
  let handleDrag = null;
  let bodyDrag = null;
  // Zoom is a CSS transform on an ancestor div, outside the SVG's own
  // coordinate system - vector-effect="non-scaling-stroke" only cancels
  // scaling from *inside* the SVG (viewBox, <g transform>), so it can't see
  // that ancestor transform at all. Instead, stroke widths / handle radii
  // are stored as the CONSTANT SCREEN SIZE the user wants (e.g. "2" really
  // means "2px") and divided by the current zoom scale before being written
  // as SVG attribute values, so the outer CSS scale cancels back out to the
  // original constant size on screen.
  let currentZoomScale = 1;

  const colorInput = document.getElementById('markup-color');
  const widthInput = document.getElementById('markup-width');
  const publishDefaultInput = document.getElementById('markup-publish-default');
  const popupEl = document.getElementById('markup-popup');

  if (me.role === 'admin' || me.role === 'editor') {
    document.getElementById('publish-default-wrap').style.display = '';
  }

  // Tag suggestions come from every flag already placed anywhere in the
  // project (not just this sheet), so the same tag typed on one drawing
  // shows up as a suggestion on another - fetched lazily via the existing
  // project-wide flags list endpoint rather than a dedicated one.
  let flagTagsCache = null;
  let flagTagsPromise = null;
  function ensureFlagTagsLoaded() {
    if (flagTagsPromise) return flagTagsPromise;
    flagTagsPromise = (async () => {
      if (!projectId) return [];
      try {
        const { flags } = await api('GET', `/api/projects/${projectId}/flags`);
        flagTagsCache = [...new Set(flags.flatMap((f) => f.geometry.tags || []))].sort();
      } catch (err) {
        flagTagsCache = [];
      }
      return flagTagsCache;
    })();
    return flagTagsPromise;
  }
  function flagTagDatalistEl() {
    let dl = document.getElementById('flag-tag-options');
    if (!dl) {
      dl = document.createElement('datalist');
      dl.id = 'flag-tag-options';
      document.body.appendChild(dl);
    }
    return dl;
  }
  function renderFlagTagOptions() {
    flagTagDatalistEl().innerHTML = (flagTagsCache || [])
      .map((t) => `<option value="${String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></option>`)
      .join('');
  }
  ensureFlagTagsLoaded().then(renderFlagTagOptions);

  function syncViewBox() {
    svgEl.setAttribute('viewBox', `0 0 ${canvasEl.width} ${canvasEl.height}`);
  }

  function vbSize() {
    const vb = svgEl.viewBox.baseVal;
    return { w: vb.width || canvasEl.width, h: vb.height || canvasEl.height };
  }

  function getSvgPoint(evt) {
    const p = eventPoint(evt);
    const rect = svgEl.getBoundingClientRect();
    const { w, h } = vbSize();
    return {
      x: ((p.clientX - rect.left) / rect.width) * w,
      y: ((p.clientY - rect.top) / rect.height) * h,
    };
  }

  function eventPoint(evt) {
    return evt.changedTouches ? evt.changedTouches[0] : evt;
  }

  function isPrimaryTouch(evt) {
    return !evt.touches || evt.touches.length === 1;
  }

  function findMarkup(id) {
    return markups.find((m) => m.id === id);
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

  function bounds(m) {
    const { w, h } = vbSize();
    if (m.type === 'line' || m.type === 'arrow') {
      const x1 = m.geometry.x1 * w;
      const y1 = m.geometry.y1 * h;
      const x2 = m.geometry.x2 * w;
      const y2 = m.geometry.y2 * h;
      return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
    }
    if (m.type === 'text') {
      return { x: m.geometry.x * w, y: m.geometry.y * h - 16, w: 10, h: 16 };
    }
    return { x: m.geometry.x * w, y: m.geometry.y * h, w: m.geometry.w * w, h: m.geometry.h * h };
  }

  function renderMarkupEl(m) {
    const { w, h } = vbSize();
    const rawColor = (m.style && m.style.color) || '#e11d48';
    const color = m.visibility === 'published' ? darkenHex(rawColor, 0.3) : rawColor;
    const strokeWidth = ((m.style && m.style.strokeWidth) || 2) / currentZoomScale;
    let node;

    if (m.type === 'line' || m.type === 'arrow') {
      node = el('line');
      node.setAttribute('x1', m.geometry.x1 * w);
      node.setAttribute('y1', m.geometry.y1 * h);
      node.setAttribute('x2', m.geometry.x2 * w);
      node.setAttribute('y2', m.geometry.y2 * h);
      node.setAttribute('stroke', color);
      node.setAttribute('stroke-width', strokeWidth);
      node.style.pointerEvents = 'stroke';
      if (m.type === 'arrow') node.setAttribute('marker-end', `url(#${ensureArrowMarker(color)})`);
    } else if (m.type === 'rect') {
      node = el('rect');
      node.setAttribute('x', m.geometry.x * w);
      node.setAttribute('y', m.geometry.y * h);
      node.setAttribute('width', m.geometry.w * w);
      node.setAttribute('height', m.geometry.h * h);
      node.setAttribute('stroke', color);
      node.setAttribute('stroke-width', strokeWidth);
      node.setAttribute('fill', '#ffffff');
      node.setAttribute('fill-opacity', '0.001');
      node.style.pointerEvents = 'all';
    } else if (m.type === 'cloud') {
      const bumpSize = (m.style && m.style.bumpSize) || CLOUD_BUMP_SIZE['cloud-small'];
      node = el('path');
      node.setAttribute('d', cloudPath(m.geometry.x * w, m.geometry.y * h, m.geometry.w * w, m.geometry.h * h, bumpSize));
      node.setAttribute('stroke', color);
      node.setAttribute('stroke-width', strokeWidth);
      node.setAttribute('fill', '#ffffff');
      node.setAttribute('fill-opacity', '0.001');
      node.style.pointerEvents = 'all';
    } else if (m.type === 'text') {
      node = el('text');
      node.setAttribute('x', m.geometry.x * w);
      node.setAttribute('y', m.geometry.y * h);
      node.setAttribute('fill', color);
      node.setAttribute('font-size', (m.style && m.style.fontSize) || 20);
      node.textContent = m.geometry.text || '';
      node.style.pointerEvents = 'all';
    } else if (m.type === 'flag') {
      node = el('rect');
      node.setAttribute('x', m.geometry.x * w);
      node.setAttribute('y', m.geometry.y * h);
      node.setAttribute('width', m.geometry.w * w);
      node.setAttribute('height', m.geometry.h * h);
      node.setAttribute('stroke', color);
      node.setAttribute('stroke-width', strokeWidth);
      node.setAttribute('fill', color);
      node.setAttribute('fill-opacity', '0.25');
      node.style.pointerEvents = 'all';
    }

    node.dataset.markupId = m.id;
    node.style.cursor = editingId === m.id ? 'move' : 'pointer';
    node.style.opacity = m.visibility === 'published' ? '1' : '0.75';
    if (m.id === selectedId) node.classList.add('markup-selected');

    node.addEventListener('mousedown', (e) => {
      if (editingId === m.id) {
        e.stopPropagation();
        startBodyDrag(m, e);
      }
    });
    node.addEventListener('touchstart', (e) => {
      if (editingId === m.id && isPrimaryTouch(e)) {
        e.preventDefault();
        e.stopPropagation();
        startBodyDrag(m, e);
      }
    }, { passive: false });
    node.addEventListener('click', (e) => {
      e.stopPropagation();
      if (editingId === m.id) return;
      selectMarkup(m.id);
    });
    return node;
  }

  function renderHandles(m) {
    const group = el('g');
    group.dataset.handlesFor = m.id;
    const { w, h } = vbSize();

    function handleAt(px, py, onDrag) {
      const c = el('circle');
      c.setAttribute('cx', px);
      c.setAttribute('cy', py);
      c.setAttribute('r', 6 / currentZoomScale);
      c.classList.add('markup-handle');
      c.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        handleDrag = { markup: m, onDrag };
      });
      c.addEventListener('touchstart', (e) => {
        if (!isPrimaryTouch(e)) return;
        e.preventDefault();
        e.stopPropagation();
        handleDrag = { markup: m, onDrag };
      }, { passive: false });
      group.appendChild(c);
    }

    if (m.type === 'line' || m.type === 'arrow') {
      handleAt(m.geometry.x1 * w, m.geometry.y1 * h, (pt) => {
        m.geometry.x1 = pt.x / w;
        m.geometry.y1 = pt.y / h;
      });
      handleAt(m.geometry.x2 * w, m.geometry.y2 * h, (pt) => {
        m.geometry.x2 = pt.x / w;
        m.geometry.y2 = pt.y / h;
      });
    } else if (m.type === 'rect' || m.type === 'cloud' || m.type === 'flag') {
      const corners = [
        ['x', 'y'],
        ['x2', 'y'],
        ['x', 'y2'],
        ['x2', 'y2'],
      ];
      const g = m.geometry;
      const cornerPts = {
        x: g.x,
        y: g.y,
        x2: g.x + g.w,
        y2: g.y + g.h,
      };
      for (const [cxKey, cyKey] of corners) {
        handleAt(cornerPts[cxKey] * w, cornerPts[cyKey] * h, (pt) => {
          const nx = pt.x / w;
          const ny = pt.y / h;
          const fixedX = cxKey === 'x' ? g.x + g.w : g.x;
          const fixedY = cyKey === 'y' ? g.y + g.h : g.y;
          g.x = Math.min(nx, fixedX);
          g.y = Math.min(ny, fixedY);
          g.w = Math.abs(nx - fixedX);
          g.h = Math.abs(ny - fixedY);
        });
      }
    } else if (m.type === 'text') {
      handleAt(m.geometry.x * w, m.geometry.y * h, (pt) => {
        m.geometry.x = pt.x / w;
        m.geometry.y = pt.y / h;
      });
    }

    return group;
  }

  function startBodyDrag(m, evt) {
    const start = getSvgPoint(evt);
    bodyDrag = { markup: m, start, origGeometry: JSON.parse(JSON.stringify(m.geometry)) };
  }

  function visibleMarkups() {
    if (currentPage == null) return markups;
    return markups.filter((m) => (m.geometry.page || 1) === currentPage);
  }

  // refreshPopup=false is used by the zoom/pan/page-driven call sites
  // (setZoomScale, setPage) below - those need the popup repositioned to
  // follow the markup on screen, but must NOT rebuild its contents, or an
  // in-progress flag description/comment (typed but not yet saved) gets
  // silently reset to the last-saved value every time the view moves.
  function renderAll({ refreshPopup = true } = {}) {
    svgEl.querySelectorAll('[data-markup-id], [data-handles-for]').forEach((n) => n.remove());
    for (const m of visibleMarkups()) svgEl.appendChild(renderMarkupEl(m));
    if (editingId) {
      const m = findMarkup(editingId);
      if (m) svgEl.appendChild(renderHandles(m));
    }
    positionPopup(refreshPopup);
  }

  function permissions(m) {
    const isAuthor = m.author_id === me.id;
    const isAdmin = me.role === 'admin';
    const isEditor = me.role === 'editor';
    return {
      canEdit: isAuthor || isAdmin,
      canPublish: isEditor || isAdmin,
      canDelete: isAuthor || isAdmin,
    };
  }

  // Positions/shows the popup for the selected markup, rebuilding its
  // contents from m.geometry (refreshContent=true, the default) unless
  // called from a zoom/pan/page tick via renderAll({ refreshPopup: false })
  // - see that comment for why those must not touch the popup's DOM.
  function positionPopup(refreshContent = true) {
    if (!selectedId) {
      popupEl.style.display = 'none';
      return;
    }
    const m = findMarkup(selectedId);
    if (!m) {
      popupEl.style.display = 'none';
      return;
    }
    const perm = permissions(m);
    if (!perm.canEdit && !perm.canPublish && !perm.canDelete && !m.linked_document_id) {
      popupEl.style.display = 'none';
      return;
    }

    if (refreshContent) renderPopupButtons(m);
    popupEl.style.transform = 'translateX(-50%)';
    popupEl.style.display = 'flex';
    applyPopupPosition(m);
  }

  // Anchors the popup under the markup by default, but clamps it inside
  // the visible .zoom-wrap area (measuring the popup's real rendered size)
  // and flips it above the markup when there isn't room below - a flag
  // placed low on the canvas would otherwise push its own Save button off
  // screen, with no way to reach it except panning (which, before this
  // fix, would also wipe whatever had been typed - see renderAll above).
  function applyPopupPosition(m) {
    const wrapEl = svgEl.closest('.zoom-wrap');
    const wrapRect = wrapEl.getBoundingClientRect();
    const b = bounds(m);
    const { w: vbW, h: vbH } = vbSize();
    const rect = svgEl.getBoundingClientRect();
    const centerX = rect.left - wrapRect.left + ((b.x + b.w / 2) / vbW) * rect.width;
    const topY = rect.top - wrapRect.top + (b.y / vbH) * rect.height;
    const bottomY = rect.top - wrapRect.top + ((b.y + b.h) / vbH) * rect.height;

    popupEl.style.left = `${centerX}px`;
    popupEl.style.top = `${bottomY + 8}px`; // provisional - just to get a real size below
    const popRect = popupEl.getBoundingClientRect();
    const popW = popRect.width;
    const popH = popRect.height;

    const PAD = 6;
    const halfW = popW / 2;
    const minCenterX = halfW + PAD;
    const maxCenterX = Math.max(minCenterX, wrapRect.width - halfW - PAD);
    popupEl.style.left = `${Math.min(Math.max(centerX, minCenterX), maxCenterX)}px`;

    const spaceBelow = wrapRect.height - bottomY;
    const fitsBelow = popH + 8 + PAD <= spaceBelow;
    popupEl.style.top = `${fitsBelow ? bottomY + 8 : Math.max(PAD, topY - popH - 8)}px`;
  }

  function renderPopupButtons(m) {
    const perm = permissions(m);
    popupEl.innerHTML = '';
    const buttonRow = document.createElement('div');
    buttonRow.className = 'markup-popup-buttons';
    popupEl.appendChild(buttonRow);

    if (m.linked_document_id) {
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.title = 'Open linked document';
      openBtn.innerHTML = OPEN_DOC_ICON;
      openBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.open(`/document-view.html?documentId=${m.linked_document_id}`, '_blank');
      });
      buttonRow.appendChild(openBtn);
    }

    if (perm.canEdit) {
      const linkBtn = document.createElement('button');
      linkBtn.type = 'button';
      linkBtn.textContent = m.linked_document_id ? 'Change link' : 'Link doc';
      linkBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openLinkPicker(m);
      });
      buttonRow.appendChild(linkBtn);
    }

    if (perm.canPublish) {
      const pubBtn = document.createElement('button');
      pubBtn.type = 'button';
      pubBtn.textContent = m.visibility === 'published' ? 'Unpublish' : 'Publish';
      pubBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const { markup } = await api('PATCH', `/api/markups/${m.id}`, {
          visibility: m.visibility === 'published' ? 'private' : 'published',
        });
        Object.assign(m, markup);
        renderAll();
      });
      buttonRow.appendChild(pubBtn);
    }

    if (perm.canEdit) {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.textContent = editingId === m.id ? 'Done' : 'Edit';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        editingId = editingId === m.id ? null : m.id;
        if (editingId) {
          colorInput.value = (m.style && m.style.color) || '#e11d48';
          widthInput.value = (m.style && m.style.strokeWidth) || 2;
        }
        renderAll();
      });
      buttonRow.appendChild(editBtn);
    }

    if (perm.canDelete) {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmModal({ title: 'Delete this markup?', confirmLabel: 'Delete', danger: true });
        if (!ok) return;
        await api('DELETE', `/api/markups/${m.id}`);
        markups = markups.filter((x) => x.id !== m.id);
        selectedId = null;
        editingId = null;
        renderAll();
      });
      buttonRow.appendChild(delBtn);
    }

    if (editingId === m.id && perm.canEdit && (m.type === 'rect' || m.type === 'line' || m.type === 'arrow')) {
      renderDimensionFields(m);
    }

    // Shows which document is linked (e.g. "RFI-042 - Beam size...") so the
    // user doesn't have to open it just to see what it is.
    if (m.linked_document_id && documents) {
      const linked = documents.find((d) => d.id === m.linked_document_id);
      if (linked) {
        const label = document.createElement('div');
        label.className = 'markup-popup-doclabel';
        label.textContent = linked.name;
        label.title = linked.name;
        popupEl.appendChild(label);
      }
    }

    if (m.type === 'flag') {
      const descInput = document.createElement('input');
      descInput.type = 'text';
      descInput.className = 'markup-popup-flag-desc';
      descInput.placeholder = 'Description';
      descInput.value = m.geometry.description || '';
      descInput.readOnly = !perm.canEdit;
      popupEl.appendChild(descInput);

      const commentInput = document.createElement('textarea');
      commentInput.className = 'markup-popup-flag-comment';
      commentInput.placeholder = 'Comment';
      commentInput.rows = 3;
      commentInput.value = m.geometry.comment || '';
      commentInput.readOnly = !perm.canEdit;
      popupEl.appendChild(commentInput);

      const tagInput = document.createElement('input');
      tagInput.type = 'text';
      tagInput.className = 'markup-popup-flag-tag';
      tagInput.placeholder = 'Tags (comma-separated)';
      tagInput.value = (m.geometry.tags || []).join(', ');
      tagInput.setAttribute('list', 'flag-tag-options');
      tagInput.readOnly = !perm.canEdit;
      popupEl.appendChild(tagInput);
      ensureFlagTagsLoaded().then(renderFlagTagOptions);

      if (perm.canEdit) {
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const tags = [...new Set(tagInput.value.split(',').map((t) => t.trim()).filter(Boolean))];
          const { markup } = await api('PATCH', `/api/markups/${m.id}`, {
            geometry: { ...m.geometry, description: descInput.value, comment: commentInput.value, tags },
          });
          Object.assign(m, markup);
          const newTags = tags.filter((t) => !(flagTagsCache || []).includes(t));
          if (newTags.length) {
            flagTagsCache = [...(flagTagsCache || []), ...newTags].sort();
            renderFlagTagOptions();
          }
          showToast('Flag saved.', 'success');
          deselect();
        });
        popupEl.appendChild(saveBtn);
      }
    }
  }

  // Precise real-world length/width entry for a rect/line/arrow markup
  // while it's being edited - a companion to the drag-handles already
  // shown for when "type the exact number" beats eyeballing a drag (e.g.
  // clouding an 8'-0" x 10'-0" area precisely). Only offered when the host
  // page supplied a scale lookup (sheet.js does; document-view.js doesn't -
  // documents have no scale/real-world size at all) and a scale is
  // actually set at this markup's own position (zone-aware, same lookup
  // measure/take-off geometry already uses).
  function renderDimensionFields(m) {
    if (!getScaleFeetPerInch || !getRenderScale) return;
    const b = bounds(m);
    const feetPerInch = getScaleFeetPerInch({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
    if (!feetPerInch) return;

    function pxToFeet(px) {
      const inches = px / getRenderScale() / 72;
      return inches * feetPerInch;
    }
    function feetToPx(feet) {
      const inches = feet / feetPerInch;
      return inches * 72 * getRenderScale();
    }

    const { w, h } = vbSize();
    const wrap = document.createElement('div');
    wrap.className = 'markup-popup-dims';

    function addField(labelText, getFeet, setFeet) {
      const field = document.createElement('label');
      field.className = 'markup-popup-dim-field';
      const span = document.createElement('span');
      span.textContent = labelText;
      const input = document.createElement('input');
      input.type = 'text';
      input.inputMode = 'decimal';
      input.value = formatFeetInches(getFeet());
      input.addEventListener('change', async () => {
        const feet = parseFeetInches(input.value);
        if (feet === null || feet <= 0) {
          input.value = formatFeetInches(getFeet()); // unparseable/non-positive - revert rather than silently zero it
          return;
        }
        setFeet(feet);
        const { markup } = await api('PATCH', `/api/markups/${m.id}`, { geometry: m.geometry });
        Object.assign(m, markup);
        renderAll();
      });
      field.appendChild(span);
      field.appendChild(input);
      wrap.appendChild(field);
    }

    if (m.type === 'rect') {
      addField(
        'Width',
        () => pxToFeet(m.geometry.w * w),
        (feet) => {
          m.geometry.w = feetToPx(feet) / w;
        }
      );
      addField(
        'Height',
        () => pxToFeet(m.geometry.h * h),
        (feet) => {
          m.geometry.h = feetToPx(feet) / h;
        }
      );
    } else {
      // line/arrow: a single length field. Direction (and x1/y1) stay put -
      // only the vector's magnitude changes, scaled from whatever it
      // currently is to the newly-entered length.
      addField(
        'Length',
        () => {
          const dxPx = (m.geometry.x2 - m.geometry.x1) * w;
          const dyPx = (m.geometry.y2 - m.geometry.y1) * h;
          return pxToFeet(Math.hypot(dxPx, dyPx));
        },
        (feet) => {
          const dxPx = (m.geometry.x2 - m.geometry.x1) * w;
          const dyPx = (m.geometry.y2 - m.geometry.y1) * h;
          const currentLengthPx = Math.hypot(dxPx, dyPx) || 1;
          const scale = feetToPx(feet) / currentLengthPx;
          m.geometry.x2 = m.geometry.x1 + (dxPx * scale) / w;
          m.geometry.y2 = m.geometry.y1 + (dyPx * scale) / h;
        }
      );
    }

    popupEl.appendChild(wrap);
  }

  function openLinkPicker(m) {
    openDocPicker({
      documents: documents || [],
      folders: folders || [],
      currentId: m.linked_document_id,
      onSelect: async (documentId) => {
        const { markup } = await api('PATCH', `/api/markups/${m.id}`, { linked_document_id: documentId });
        Object.assign(m, markup);
        renderAll();
      },
    });
  }

  function selectMarkup(id) {
    selectedId = id;
    editingId = null;
    renderAll();
  }

  function deselect() {
    if (!selectedId && !editingId) return;
    selectedId = null;
    editingId = null;
    renderAll();
  }

  async function createMarkup(type, geometry, extraStyle) {
    if (currentPage != null) geometry.page = currentPage;
    const style = { color: colorInput.value, strokeWidth: Number(widthInput.value), ...extraStyle };
    const visibility = publishDefaultInput.checked ? 'published' : 'private';
    const { markup } = await api('POST', `${base}/markups`, {
      type: type === 'cloud-small' || type === 'cloud-large' ? 'cloud' : type,
      geometry,
      style,
      visibility,
    });
    markups.push(markup);
    renderAll();
    return markup;
  }

  function activateTool(tool) {
    activeTool = tool;
    deselect();
    document.querySelectorAll('.tool-btn').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    svgEl.style.cursor = tool === 'select' ? 'default' : 'crosshair';
    if (onToolChange) onToolChange(tool);
  }

  // Icon buttons built here (not static HTML) since the SVG markup is
  // sizeable and this module already owns all tool-related state/behavior.
  const TOOL_DEFS = [
    { tool: 'line', icon: TOOL_ICONS.line, title: 'Line' },
    { tool: 'arrow', icon: TOOL_ICONS.arrow, title: 'Arrow' },
    { tool: 'rect', icon: TOOL_ICONS.rect, title: 'Rectangle' },
    { tool: 'cloud-small', icon: TOOL_ICONS.cloud, badge: 'S', title: 'Cloud (small)' },
    { tool: 'cloud-large', icon: TOOL_ICONS.cloud, badge: 'L', title: 'Cloud (large)' },
    { tool: 'text', icon: TOOL_ICONS.text, title: 'Text' },
    { tool: 'flag', icon: TOOL_ICONS.flag, title: 'Flag' },
  ];
  const toolGrid = document.getElementById('tool-grid');
  for (const def of TOOL_DEFS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tool-btn tool-icon-btn';
    btn.dataset.tool = def.tool;
    btn.title = def.title;
    btn.innerHTML = def.icon + (def.badge ? `<span class="badge">${def.badge}</span>` : '');
    btn.addEventListener('click', () => {
      activateTool(activeTool === def.tool ? 'select' : def.tool);
    });
    toolGrid.appendChild(btn);
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') activateTool('select');
  });
  activateTool('select');

  // Live style edits while a markup is selected/being edited, in addition to
  // setting the default for the next newly-drawn markup.
  colorInput.addEventListener('change', async () => {
    if (!editingId) return;
    const m = findMarkup(editingId);
    if (!m) return;
    m.style = { ...m.style, color: colorInput.value };
    const { markup } = await api('PATCH', `/api/markups/${m.id}`, { style: m.style });
    Object.assign(m, markup);
    renderAll();
  });
  widthInput.addEventListener('change', async () => {
    if (!editingId) return;
    const m = findMarkup(editingId);
    if (!m) return;
    m.style = { ...m.style, strokeWidth: Number(widthInput.value) };
    const { markup } = await api('PATCH', `/api/markups/${m.id}`, { style: m.style });
    Object.assign(m, markup);
    renderAll();
  });

  svgEl.addEventListener('click', (e) => {
    if (e.target === svgEl) deselect();
  });

  async function startDrawing(evt) {
    if (activeTool === 'select' || evt.target !== svgEl) return;
    evt.preventDefault();
    const pt = getSvgPoint(evt);

    if (activeTool === 'text') {
      activateTool('select');
      const text = await promptModal({ title: 'Add text markup', placeholder: 'Text', required: false });
      if (!text) return;
      const { w, h } = vbSize();
      await createMarkup('text', { x: pt.x / w, y: pt.y / h, text });
      return;
    }

    drawing = { type: activeTool, start: pt };
    previewEl = el(activeTool === 'line' || activeTool === 'arrow' ? 'line' : activeTool.startsWith('cloud') ? 'path' : 'rect');
    previewEl.setAttribute('stroke', colorInput.value);
    previewEl.setAttribute('stroke-width', Number(widthInput.value) / currentZoomScale);
    previewEl.setAttribute('fill', 'none');
    previewEl.setAttribute('stroke-dasharray', '4 2');
    svgEl.appendChild(previewEl);
  }

  function updateDrawing(evt) {
    if (!drawing) return;
    evt.preventDefault();
    const pt = getSvgPoint(evt);
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
      if (type.startsWith('cloud')) {
        previewEl.setAttribute('d', cloudPath(x, y, w, h, CLOUD_BUMP_SIZE[type]));
      } else {
        previewEl.setAttribute('x', x);
        previewEl.setAttribute('y', y);
        previewEl.setAttribute('width', w);
        previewEl.setAttribute('height', h);
      }
    }
  }

  async function finishDrawing(evt) {
    if (!drawing) return false;
    evt.preventDefault();
    const pt = getSvgPoint(evt);
    const { type, start } = drawing;
    if (previewEl) previewEl.remove();
    drawing = null;

    const { w, h } = vbSize();
    let geometry;
    if (type === 'line' || type === 'arrow') {
      if (Math.hypot(pt.x - start.x, pt.y - start.y) < 4) {
        activateTool('select');
        return true;
      }
      geometry = { x1: start.x / w, y1: start.y / h, x2: pt.x / w, y2: pt.y / h };
    } else {
      const x0 = Math.min(pt.x, start.x);
      const y0 = Math.min(pt.y, start.y);
      const bw = Math.abs(pt.x - start.x);
      const bh = Math.abs(pt.y - start.y);
      if (bw < 4 || bh < 4) {
        activateTool('select');
        return true;
      }
      geometry = { x: x0 / w, y: y0 / h, w: bw / w, h: bh / h };
    }
    if (type === 'flag') {
      geometry.description = '';
      geometry.comment = '';
      geometry.tags = [];
      const markup = await createMarkup('flag', geometry, { color: '#f97316', strokeWidth: 2 });
      activateTool('select');
      selectMarkup(markup.id);
      return true;
    }
    const extraStyle = type.startsWith('cloud') ? { bumpSize: CLOUD_BUMP_SIZE[type] } : undefined;
    await createMarkup(type, geometry, extraStyle);
    activateTool('select');
    return true;
  }

  svgEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    startDrawing(e);
  });
  svgEl.addEventListener('mousemove', updateDrawing);

  svgEl.addEventListener('touchstart', (e) => {
    if (!isPrimaryTouch(e)) return;
    startDrawing(e);
  }, { passive: false });
  svgEl.addEventListener('touchmove', (e) => {
    if (!isPrimaryTouch(e)) return;
    updateDrawing(e);
  }, { passive: false });

  window.addEventListener('mousemove', (e) => {
    if (handleDrag) {
      const pt = getSvgPoint(e);
      handleDrag.onDrag(pt);
      renderAll();
    } else if (bodyDrag) {
      const pt = getSvgPoint(e);
      const { w, h } = vbSize();
      const dx = (pt.x - bodyDrag.start.x) / w;
      const dy = (pt.y - bodyDrag.start.y) / h;
      const g = bodyDrag.origGeometry;
      const m = bodyDrag.markup;
      if (m.type === 'line' || m.type === 'arrow') {
        m.geometry = { x1: g.x1 + dx, y1: g.y1 + dy, x2: g.x2 + dx, y2: g.y2 + dy };
      } else if (m.type === 'text') {
        m.geometry = { ...g, x: g.x + dx, y: g.y + dy };
      } else {
        m.geometry = { ...g, x: g.x + dx, y: g.y + dy };
      }
      renderAll();
    }
  });

  window.addEventListener('touchmove', (e) => {
    if (!isPrimaryTouch(e)) return;
    if (handleDrag || bodyDrag) e.preventDefault();
    if (handleDrag) {
      const pt = getSvgPoint(e);
      handleDrag.onDrag(pt);
      renderAll();
    } else if (bodyDrag) {
      const pt = getSvgPoint(e);
      const { w, h } = vbSize();
      const dx = (pt.x - bodyDrag.start.x) / w;
      const dy = (pt.y - bodyDrag.start.y) / h;
      const g = bodyDrag.origGeometry;
      const m = bodyDrag.markup;
      if (m.type === 'line' || m.type === 'arrow') {
        m.geometry = { x1: g.x1 + dx, y1: g.y1 + dy, x2: g.x2 + dx, y2: g.y2 + dy };
      } else if (m.type === 'text') {
        m.geometry = { ...g, x: g.x + dx, y: g.y + dy };
      } else {
        m.geometry = { ...g, x: g.x + dx, y: g.y + dy };
      }
      renderAll();
    }
  }, { passive: false });

  async function finishMarkupDrag() {
    if (handleDrag) {
      const m = handleDrag.markup;
      handleDrag = null;
      const { markup } = await api('PATCH', `/api/markups/${m.id}`, { geometry: m.geometry });
      Object.assign(m, markup);
      renderAll();
      return true;
    }
    if (bodyDrag) {
      const m = bodyDrag.markup;
      bodyDrag = null;
      const { markup } = await api('PATCH', `/api/markups/${m.id}`, { geometry: m.geometry });
      Object.assign(m, markup);
      renderAll();
      return true;
    }
    return false;
  }

  window.addEventListener('mouseup', async (e) => {
    if (await finishMarkupDrag()) return;
    await finishDrawing(e);
  });
  window.addEventListener('touchend', async (e) => {
    if (e.touches.length > 0) return;
    if (await finishMarkupDrag()) return;
    await finishDrawing(e);
  }, { passive: false });
  window.addEventListener('touchcancel', () => {
    handleDrag = null;
    bodyDrag = null;
    drawing = null;
    if (previewEl) previewEl.remove();
    previewEl = null;
  });


  return {
    async load() {
      syncViewBox();
      try {
        const { markups: loaded } = await api('GET', `${base}/markups`);
        markups = loaded;
      } catch (err) {
        // Documents have no offline cache (CLAUDE.md's sync spec only
        // covers sheets) - just show nothing rather than a sheet-shaped
        // cache lookup that would never have anything for this id anyway.
        markups = sheetId ? await getCachedMarkupsForSheet(sheetId) : [];
      }
      renderAll();
    },
    resync() {
      syncViewBox();
      renderAll();
    },
    setZoomScale(scale) {
      currentZoomScale = scale || 1;
      renderAll({ refreshPopup: false });
    },
    setPage(n) {
      currentPage = n;
      renderAll({ refreshPopup: false });
    },
    isToolActive() {
      return activeTool !== 'select';
    },
    hasSelection() {
      return !!selectedId;
    },
    repositionPopup: () => positionPopup(false),
    forceSelectTool() {
      activateTool('select');
    },
    focusMarkup(id) {
      const m = findMarkup(Number(id));
      if (!m) return null;
      selectMarkup(m.id);
      return m.geometry;
    },
  };
}
