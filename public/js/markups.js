import { getCachedMarkupsForSheet, cacheMarkup } from '/js/offline-store.js';
import { openDocPicker } from '/js/docPicker.js';
import { confirmModal, promptModal, showToast, openModal, closeModal } from '/js/shell.js';
import { getDefaultPhotoFolderId, setDefaultPhotoFolderId } from '/js/photoPinDefaultFolder.js';
import {
  queuePhoto,
  getQueuedPhotos,
  flushPhotoOutbox,
  photoBlob,
  queueMarkup,
  getQueuedMarkups,
  updateQueuedMarkup,
  deleteQueuedMarkup,
  deleteQueuedPhoto,
  localMarkupId,
} from '/js/photoOutbox.js';

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
  // Facing-direction pin: a dot with a wedge pointing "up", matching how a
  // placed photo pin renders on the sheet (see photoConePathD) before the
  // user has aimed it anywhere in particular.
  photo:
    '<svg viewBox="0 0 20 20"><path d="M10 11 L4 2 L16 2 Z" fill="currentColor" fill-opacity="0.45"/><circle cx="10" cy="11" r="2.6" fill="currentColor"/></svg>',
};

const OPEN_DOC_ICON =
  '<svg viewBox="0 0 20 20"><path d="M8 4H4v12h12v-4M11 3h6v6M17 3l-8 8" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const FOLDER_ICON =
  '<svg viewBox="0 0 20 20" class="doc-picker-icon"><path d="M2 5a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5z" fill="currentColor"/></svg>';

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

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

// Photo pin direction: degrees clockwise from "up" (0 = straight up the
// sheet), not the usual atan2-from-east-counterclockwise math convention -
// this is a facing direction a field worker reads like a compass bearing on
// the drawing, not a vector angle.
function photoAngleFromDelta(dx, dy) {
  let deg = Math.atan2(dx, -dy) * (180 / Math.PI);
  if (deg < 0) deg += 360;
  return deg;
}

function photoPoint(cx, cy, angleDeg, radius) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + radius * Math.sin(rad), y: cy - radius * Math.cos(rad) };
}

const PHOTO_PIN_RADIUS = 7;
const PHOTO_CONE_LENGTH = 22;
const PHOTO_CONE_SPREAD = 24; // degrees each side of the facing direction

// Screen-constant sizing (divide by the outer CSS zoom scale) - same
// convention as every other stroke-width/handle-radius in this file, so the
// cone reads the same physical size on screen regardless of sheet zoom.
function photoConePathD(cx, cy, direction, zoomScale) {
  const r = PHOTO_CONE_LENGTH / zoomScale;
  const p1 = photoPoint(cx, cy, direction - PHOTO_CONE_SPREAD, r);
  const p2 = photoPoint(cx, cy, direction + PHOTO_CONE_SPREAD, r);
  return `M ${cx} ${cy} L ${p1.x} ${p1.y} L ${p2.x} ${p2.y} Z`;
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
  // documentId -> its document_versions array (newest first), lazily fetched
  // the first time a photo pin's popup is opened and reused after that -
  // repopulated wholesale (not appended to) whenever a photo is added, since
  // that's a single extra request and simpler than reasoning about partial
  // cache staleness.
  const photoVersionsCache = new Map();
  // Photo outbox entries (see photoOutbox.js) for this project - photos
  // taken on a pin that haven't reached the server yet. Drives the pin's
  // amber "waiting to upload" color and the gallery's pending thumbnails.
  let queuedPhotos = [];
  const queuedPhotoUrls = new Map(); // outbox entry id -> object URL
  function queuedFor(markupId) {
    return queuedPhotos.filter((q) => q.markupId === markupId);
  }

  // A markup placed offline lives only in the outbox until it uploads (see
  // photoOutbox.js) - shown here under its negative local id, flagged
  // `pending` so edits go to the outbox entry instead of the server.
  function localMarkupFromEntry(entry) {
    return {
      ...entry.markup,
      id: localMarkupId(entry.id),
      outboxId: entry.id,
      pending: true,
      uploadError: entry.error || null,
      author_id: me.id,
      linked_document_id: null,
    };
  }

  // Every markup edit goes through here: a pending (not yet uploaded)
  // markup just has its queued entry rewritten; anything else is a normal
  // PATCH. Returns false (after a toast) if the change couldn't be saved.
  async function patchMarkup(m, fields) {
    if (m.pending && (await updateQueuedMarkup(m.outboxId, fields))) {
      Object.assign(m, fields);
      return true;
    }
    try {
      const { markup } = await api('PATCH', `/api/markups/${m.id}`, fields);
      Object.assign(m, markup);
      return true;
    } catch (err) {
      showToast(err.status ? err.message : "Can't save changes to this markup offline - only markups placed offline can be edited without a connection.", 'error');
      return false;
    }
  }
  async function refreshQueuedPhotos() {
    if (!projectId) return;
    try {
      queuedPhotos = await getQueuedPhotos(projectId);
    } catch (err) {
      queuedPhotos = [];
    }
    for (const [id, url] of queuedPhotoUrls) {
      if (!queuedPhotos.some((q) => q.id === id)) {
        URL.revokeObjectURL(url);
        queuedPhotoUrls.delete(id);
      }
    }
    // Object URLs are built up front (photoBlob is async) so the gallery
    // can render synchronously.
    for (const q of queuedPhotos) {
      if (queuedPhotoUrls.has(q.id)) continue;
      try {
        queuedPhotoUrls.set(q.id, URL.createObjectURL(await photoBlob(q)));
      } catch (err) {
        queuedPhotoUrls.set(q.id, '');
      }
    }
  }
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
    if (m.type === 'photo') {
      const size = PHOTO_PIN_RADIUS * 2;
      return { x: m.geometry.x * w - size / 2, y: m.geometry.y * h - size / 2, w: size, h: size };
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
    } else if (m.type === 'photo') {
      node = el('g');
      const cx = m.geometry.x * w;
      const cy = m.geometry.y * h;
      // Color is a STATUS indicator for this type, not the usual
      // user-chosen style swatch (m.style.color is ignored here on
      // purpose) - red until a photo is actually attached, so a batch of
      // pins dropped ahead of a job walk visibly stands out as still
      // needing photos, then flips blue once one's attached. Amber = a
      // photo was taken but is still sitting in the offline outbox.
      const photoColor = m.linked_document_id ? '#2563eb' : queuedFor(m.id).length ? '#f59e0b' : '#e11d48';
      const pinColor = m.visibility === 'published' ? darkenHex(photoColor, 0.3) : photoColor;
      const cone = el('path');
      cone.setAttribute('d', photoConePathD(cx, cy, m.geometry.direction || 0, currentZoomScale));
      cone.setAttribute('fill', pinColor);
      cone.setAttribute('fill-opacity', '0.35');
      node.appendChild(cone);
      const circle = el('circle');
      circle.setAttribute('cx', cx);
      circle.setAttribute('cy', cy);
      circle.setAttribute('r', PHOTO_PIN_RADIUS / currentZoomScale);
      circle.setAttribute('fill', pinColor);
      circle.setAttribute('stroke', '#ffffff');
      circle.setAttribute('stroke-width', 1.5 / currentZoomScale);
      node.appendChild(circle);
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
    } else if (m.type === 'photo') {
      // One handle at the cone tip, re-aiming the facing direction only -
      // position itself still moves via the ordinary body-drag (see the
      // generic x/y branch in the mousemove handlers below), which leaves
      // geometry.direction untouched since it spreads the rest of the
      // geometry object as-is.
      const cx = m.geometry.x * w;
      const cy = m.geometry.y * h;
      const tip = photoPoint(cx, cy, m.geometry.direction || 0, PHOTO_CONE_LENGTH / currentZoomScale);
      handleAt(tip.x, tip.y, (pt) => {
        const dx = pt.x - cx;
        const dy = pt.y - cy;
        if (Math.hypot(dx, dy) > 4) m.geometry.direction = photoAngleFromDelta(dx, dy);
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
  // "Hide all" toggle next to the Markup Tools header - hides only markups
  // (take-offs, search highlights etc. share this SVG and stay visible).
  // Kept for the browser tab's session so it carries across sheet-to-sheet
  // navigation, but a fresh visit always starts with markups showing.
  const HIDDEN_KEY = 'hammgrid-markups-hidden';
  let markupsHidden = (() => {
    try {
      return sessionStorage.getItem(HIDDEN_KEY) === '1';
    } catch (e) {
      return false;
    }
  })();
  const visibilityBtn = document.getElementById('markups-visibility-btn');
  const EYE_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  function updateVisibilityBtn() {
    if (!visibilityBtn) return;
    visibilityBtn.innerHTML = markupsHidden ? EYE_OFF_ICON : EYE_ICON;
    visibilityBtn.title = markupsHidden ? 'Show markups (hidden)' : 'Hide all markups';
    visibilityBtn.classList.toggle('active', markupsHidden);
  }

  function setMarkupsHidden(hidden) {
    markupsHidden = hidden;
    try {
      sessionStorage.setItem(HIDDEN_KEY, hidden ? '1' : '0');
    } catch (e) {
      // Per-tab convenience only.
    }
    if (hidden) {
      selectedId = null;
      editingId = null;
    }
    updateVisibilityBtn();
    renderAll();
  }

  if (visibilityBtn) {
    updateVisibilityBtn();
    visibilityBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setMarkupsHidden(!markupsHidden);
    });
  }

  function renderAll({ refreshPopup = true } = {}) {
    svgEl.querySelectorAll('[data-markup-id], [data-handles-for]').forEach((n) => n.remove());
    if (markupsHidden) {
      positionPopup(refreshPopup);
      return;
    }
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

    // Linking needs the markup to exist on the server - hidden until a
    // markup placed offline has uploaded.
    if (perm.canEdit && !m.pending) {
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
        await patchMarkup(m, { visibility: m.visibility === 'published' ? 'private' : 'published' });
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
        if (m.pending) {
          const photoCount = queuedFor(m.id).length;
          const ok = await confirmModal({
            title: 'Delete this markup?',
            message: photoCount
              ? `It hasn't been uploaded yet, so its ${photoCount} photo${photoCount === 1 ? '' : 's'} will be deleted from this device too.`
              : '',
            confirmLabel: 'Delete',
            danger: true,
          });
          if (!ok) return;
          await deleteQueuedMarkup(m.outboxId);
          await refreshQueuedPhotos();
          markups = markups.filter((x) => x.id !== m.id);
          selectedId = null;
          editingId = null;
          renderAll();
          return;
        }
        // A photo pin's document exists solely because of that pin (unlike
        // a flag's linked RFI, which is a shared reference someone else may
        // still need) - deleting the pin is genuinely ambiguous about
        // whether the photos should go too, so ask which one they mean
        // instead of picking a default.
        let deletePhotosToo = false;
        if (m.type === 'photo' && m.linked_document_id) {
          const choice = await confirmDeletePhotoPin();
          if (!choice) return;
          deletePhotosToo = choice === 'both';
        } else {
          const ok = await confirmModal({ title: 'Delete this markup?', confirmLabel: 'Delete', danger: true });
          if (!ok) return;
        }
        if (deletePhotosToo) {
          try {
            await api('DELETE', `/api/documents/${m.linked_document_id}`);
          } catch (err) {
            showToast(err.message || 'Could not delete the photos - deleting the pin anyway.', 'error');
          }
        }
        try {
          await api('DELETE', `/api/markups/${m.id}`);
        } catch (err) {
          showToast(err.status ? err.message : "Can't delete this markup offline - reconnect and try again.", 'error');
          return;
        }
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

    if (m.pending) {
      const note = document.createElement('div');
      note.className = 'markup-popup-doclabel';
      note.textContent = m.uploadError
        ? `Upload failed: ${m.uploadError}`
        : 'Saved on this device - uploads when back online.';
      popupEl.appendChild(note);
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
          const saved = await patchMarkup(m, {
            geometry: { ...m.geometry, description: descInput.value, comment: commentInput.value, tags },
          });
          if (!saved) return;
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
    } else if (m.type === 'photo') {
      const gallery = document.createElement('div');
      gallery.className = 'markup-popup-photo-gallery';
      popupEl.appendChild(gallery);
      renderPhotoGalleryInto(gallery, m);

      // Attaching a photo here doesn't touch the markup's own author/edit
      // fields when the pin is already linked (only the underlying
      // document gets a new version) - and even attaching the FIRST photo
      // to an empty pin is really "finishing" a document upload, not
      // editing the markup itself. Either way this follows the server's
      // own document-upload authorization (requireRole('admin','editor')
      // in documents.routes.js) rather than perm.canEdit (author-or-admin,
      // meant for the markup's own geometry/style/link fields).
      if (me.role === 'admin' || me.role === 'editor') {
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.textContent = m.linked_document_id ? 'Add photo' : 'Attach photo';
        addBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const file = await pickPhotoFile();
          if (!file) return;
          // Every photo goes into the on-device outbox first and is then
          // uploaded from there (photoOutbox.js) - online that happens
          // immediately; offline (or on WiFi that drops mid-upload) it
          // just waits on the device until there's a connection again.
          let entry;
          if (m.linked_document_id) {
            entry = { documentId: m.linked_document_id, folderId: null };
          } else if (queuedFor(m.id).length) {
            // Pin is empty on the server but already has a queued first
            // photo - that one will create the document (in the folder
            // already chosen for it); this one gets added to it.
            entry = { documentId: null, folderId: queuedFor(m.id)[0].folderId };
          } else {
            // First photo for this pin (it was placed empty - see
            // finishDrawing's photo branch) - needs a folder before the
            // document can be created at all. A cancel here just leaves
            // the pin exactly as it was: empty, still red, poppable
            // again later.
            const folderId = await pickPhotoFolder();
            if (folderId === undefined) return;
            setDefaultPhotoFolderId(projectId, folderId);
            entry = { documentId: null, folderId };
          }
          try {
            await queuePhoto({
              ...entry,
              projectId: Number(projectId),
              sheetId: sheetId ? Number(sheetId) : null,
              markupId: m.id,
              name: photoDocumentName(),
              file,
            });
          } catch (err) {
            showToast('Could not save the photo on this device: ' + (err.message || err), 'error');
            return;
          }
          await refreshQueuedPhotos();
          renderAll();
          const { remaining } = await flushPhotoOutbox();
          // flushPhotoOutbox's 'photo-outbox-change' event (handled near the
          // bottom of initMarkups) re-links/re-renders on success; only
          // the still-waiting case needs a message of its own here.
          if (remaining > 0 && queuedFor(m.id).length) {
            showToast('Photo saved on this device - it will upload automatically once you are back online.', 'info');
          }
        });
        popupEl.appendChild(addBtn);
      }
    }
  }

  function loadPhotoVersions(documentId, force) {
    if (!force && photoVersionsCache.has(documentId)) return Promise.resolve(photoVersionsCache.get(documentId));
    return api('GET', `/api/documents/${documentId}`).then(({ versions }) => {
      photoVersionsCache.set(documentId, versions);
      return versions;
    });
  }

  // Grid of every photo taken at this pin, newest first (the
  // document_versions history behind m.linked_document_id - see
  // photoOutbox.js's uploadOne for how that document grows over repeat
  // visits). Tapping a photo opens it in the in-app document viewer (new
  // tab, whose Back button closes it) - same as the popup's open-document
  // arrow, rather than the raw image file, which had no way back on iPad.
  // In edit mode each photo gets a red delete button.
  function renderPhotoGalleryInto(gallery, m, force) {
    // The popup itself is always dark (see .markup-popup), unlike the rest
    // of the app which follows the light/dark theme setting - the
    // theme-aware .muted class (used elsewhere, e.g. docPicker.js) can read
    // as near-invisible against it in light mode, so status text here uses
    // its own fixed-color class instead, matching .markup-popup-doclabel.
    const canDeletePhotos = editingId === m.id && (me.role === 'admin' || me.role === 'editor');
    // Photos still in the offline outbox show first (they're the newest),
    // straight from the on-device blob, with a "waiting to upload" badge.
    const pending = queuedFor(m.id).slice().reverse();
    const pendingNote = pending.length
      ? `<p class="markup-popup-photo-status">${pending.length} waiting to upload</p>`
      : '';

    function fill(versions, statusHtml) {
      gallery.innerHTML = '';
      for (const q of pending) {
        const url = queuedPhotoUrls.get(q.id) || '';
        const thumb = document.createElement('div');
        thumb.className = `markup-popup-photo-thumb pending${q.error ? ' failed' : ''}`;
        thumb.title = q.error ? `Upload failed: ${q.error}` : `Waiting to upload - taken ${new Date(q.queuedAt).toLocaleString()}`;
        thumb.innerHTML = `<img src="${url}" alt=""><span class="markup-popup-photo-badge">${q.error ? '!' : '&#8679;'}</span>`;
        // Only exists on this device so far - there's no document to open
        // in the viewer yet, so it opens in a full-screen overlay instead.
        thumb.addEventListener('click', (e) => {
          e.stopPropagation();
          if (url) openPhotoLightbox(url);
        });
        if (canDeletePhotos) addPhotoDeleteButton(thumb, () => deleteQueuedPhotoFromPin(m, q));
        gallery.appendChild(thumb);
      }
      for (const v of versions) {
        const thumb = document.createElement('div');
        thumb.className = 'markup-popup-photo-thumb';
        thumb.title = formatSqliteDate(v.created_at);
        thumb.innerHTML = `<img src="/api/document-versions/${v.id}/thumb" loading="lazy" alt="">`;
        thumb.querySelector('img').addEventListener('load', () => positionPopup(false));
        thumb.addEventListener('click', (e) => {
          e.stopPropagation();
          window.open(`/document-view.html?documentId=${m.linked_document_id}&versionId=${v.id}`, '_blank');
        });
        if (canDeletePhotos) addPhotoDeleteButton(thumb, () => deleteUploadedPhotoFromPin(m, v, versions.length));
        gallery.appendChild(thumb);
      }
      gallery.insertAdjacentHTML('beforeend', (statusHtml || '') + pendingNote);
      positionPopup(false);
    }

    if (!m.linked_document_id) {
      if (pending.length) fill([], '');
      else gallery.innerHTML = '<p class="markup-popup-photo-status">No photo attached yet.</p>';
      return;
    }
    gallery.innerHTML = '<p class="markup-popup-photo-status">Loading photos...</p>';
    loadPhotoVersions(m.linked_document_id, force)
      .then((versions) => {
        if (!versions.length && !pending.length) {
          gallery.innerHTML = '<p class="markup-popup-photo-status">No photos yet.</p>';
          return;
        }
        fill(versions, '');
      })
      .catch(() => {
        fill(
          [],
          `<p class="markup-popup-photo-status">${navigator.onLine ? 'Could not load photos.' : 'Offline - already-uploaded photos not shown.'}</p>`
        );
      });
  }

  function formatSqliteDate(s) {
    return s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString() : '';
  }

  function addPhotoDeleteButton(thumb, onDelete) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'markup-popup-photo-delete';
    btn.title = 'Delete this photo';
    btn.innerHTML = '&times;';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onDelete();
    });
    thumb.appendChild(btn);
  }

  async function deleteQueuedPhotoFromPin(m, q) {
    const ok = await confirmModal({
      title: 'Delete this photo?',
      message: "It hasn't been uploaded yet, so it will be deleted from this device.",
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await deleteQueuedPhoto(q.id);
    await refreshQueuedPhotos();
    renderAll();
  }

  // "Just this pin" keeps the photo as its own document in the same folder
  // (server: POST /document-versions/:id/detach); "whole project" deletes
  // the file outright. Removing the pin's last photo either way leaves the
  // pin empty (red) again.
  async function deleteUploadedPhotoFromPin(m, v, photoCount) {
    const choice = await confirmDeletePinPhoto(photoCount === 1);
    if (!choice) return;
    const documentId = m.linked_document_id;
    try {
      if (choice === 'pin') {
        const result = await api('POST', `/api/document-versions/${v.id}/detach`, {
          markup_id: m.id,
          name: `Photo - ${formatSqliteDate(v.created_at)}`,
        });
        if (result.pin_unlinked) m.linked_document_id = null;
        showToast('Photo removed from this pin - it is still in Documents.', 'success');
      } else {
        const result = await api('DELETE', `/api/document-versions/${v.id}`);
        if (result.document_deleted) m.linked_document_id = null;
        showToast('Photo deleted.', 'success');
      }
    } catch (err) {
      showToast(err.status ? err.message : 'Deleting photos needs a connection - try again once back online.', 'error');
      return;
    }
    photoVersionsCache.delete(documentId);
    if (!m.linked_document_id) cacheMarkup(projectId, m).catch(() => {});
    renderAll();
  }

  function confirmDeletePinPhoto(isLastPhoto) {
    return new Promise((resolve) => {
      const backdrop = openModal(`
        <h2>Delete this photo?</h2>
        <p class="muted">Remove it from just this pin (it stays in Documents as its own photo), or delete it from the whole project?${
          isLastPhoto ? ' This is the pin&#39;s only photo, so the pin will be left empty.' : ''
        }</p>
        <div class="modal-actions">
          <button type="button" id="pin-photo-del-cancel">Cancel</button>
          <button type="button" id="pin-photo-del-pin">Remove from this pin</button>
          <button type="button" class="danger" id="pin-photo-del-project">Delete from project</button>
        </div>
      `);
      let finished = false;
      function finish(value) {
        if (finished) return;
        finished = true;
        closeModal();
        resolve(value);
      }
      backdrop.querySelector('#pin-photo-del-cancel').addEventListener('click', () => finish(null));
      backdrop.querySelector('#pin-photo-del-pin').addEventListener('click', () => finish('pin'));
      backdrop.querySelector('#pin-photo-del-project').addEventListener('click', () => finish('project'));
    });
  }

  // Full-screen view for a photo that only exists on this device so far
  // (still in the outbox) - tap anywhere or the X to close.
  function openPhotoLightbox(url) {
    const overlay = document.createElement('div');
    overlay.className = 'photo-lightbox';
    overlay.innerHTML = `<img src="${url}" alt=""><button type="button" class="photo-lightbox-close" title="Close">&times;</button>`;
    overlay.addEventListener('click', () => overlay.remove());
    document.body.appendChild(overlay);
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
        await patchMarkup(m, { geometry: m.geometry });
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
    const body = {
      type: type === 'cloud-small' || type === 'cloud-large' ? 'cloud' : type,
      geometry,
      style,
      visibility,
    };
    let markup;
    try {
      ({ markup } = await api('POST', `${base}/markups`, body));
    } catch (err) {
      if (err.status) {
        showToast(err.message, 'error');
        return null;
      }
      // Couldn't reach the server - keep it on the device and create it
      // when the connection is back (photoOutbox.js).
      try {
        const entryId = await queueMarkup({ projectId, url: `${base}/markups`, markup: body });
        markup = localMarkupFromEntry({ id: entryId, markup: body });
      } catch (queueErr) {
        showToast('Could not save the markup on this device: ' + (queueErr.message || queueErr), 'error');
        return null;
      }
      showToast('Offline - markup saved on this device and will upload when back online.', 'info');
    }
    markups.push(markup);
    renderAll();
    return markup;
  }

  function photoDocumentName() {
    return `Photo - ${new Date().toLocaleString()}`;
  }

  // Three-way choice (not confirmModal's plain yes/no) since "delete the
  // pin" is genuinely ambiguous for a photo pin: keep the photos as
  // ordinary standalone documents in their folder, or remove them too.
  // Resolves 'pin-only', 'both', or null if cancelled.
  function confirmDeletePhotoPin() {
    return new Promise((resolve) => {
      const backdrop = openModal(`
        <h2>Delete this photo pin?</h2>
        <p class="muted">This pin has photo(s) attached. Keep them as regular documents, or delete them too?</p>
        <div class="modal-actions">
          <button type="button" id="photo-del-cancel">Cancel</button>
          <button type="button" id="photo-del-pin-only">Delete pin, keep photos</button>
          <button type="button" class="danger" id="photo-del-both">Delete pin and photos</button>
        </div>
      `);
      let resolved = false;
      function finish(value) {
        if (resolved) return;
        resolved = true;
        closeModal();
        resolve(value);
      }
      backdrop.querySelector('#photo-del-cancel').addEventListener('click', () => finish(null));
      backdrop.querySelector('#photo-del-pin-only').addEventListener('click', () => finish('pin-only'));
      backdrop.querySelector('#photo-del-both').addEventListener('click', () => finish('both'));
    });
  }

  // Native <input type="file"> picker. On iPad/iPhone Safari, accept="image/*"
  // alone already pops the "Take Photo, Photo Library, Choose File" action
  // sheet - both halves of "camera or an existing photo" from a single plain
  // input, no custom camera UI needed. Resolves the chosen File, or null if
  // the user backed out without choosing one.
  //
  // There's no reliably cross-browser 'cancel' event on a file input - most
  // browsers just never fire 'change' in that case. The window regaining
  // focus is what actually happens when the native picker sheet closes
  // either way, so a 'change' that hasn't already fired shortly after focus
  // returns is treated as a cancel.
  function pickPhotoFile() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.style.display = 'none';
      document.body.appendChild(input);
      let settled = false;
      function finish(file) {
        if (settled) return;
        settled = true;
        window.removeEventListener('focus', onFocus);
        input.remove();
        resolve(file);
      }
      function onFocus() {
        setTimeout(() => finish(null), 300);
      }
      input.addEventListener('change', () => finish(input.files[0] || null));
      window.addEventListener('focus', onFocus);
      input.click();
    });
  }

  // Small folder-navigable picker for where a NEW photo pin's first photo
  // gets saved, styled to match docPicker.js's "Link to document" modal
  // (same breadcrumb/row classes) but for choosing a destination folder
  // rather than an existing document, plus an inline "New folder" action -
  // the field-use case is often "start a fresh folder for this job walk"
  // rather than picking one that already exists.
  // Resolves the chosen folder id (null = project root), or undefined if
  // cancelled - undefined (not null) specifically so the caller can tell
  // "cancelled" apart from "root folder chosen".
  function pickPhotoFolder() {
    return new Promise((resolve) => {
      let currentFolderId = getDefaultPhotoFolderId(projectId, folders);
      const backdrop = openModal(`
        <h2>Save photo to folder</h2>
        <div id="photo-folder-body"></div>
        <div class="modal-actions">
          <button type="button" id="photo-folder-new">New folder</button>
          <button type="button" id="photo-folder-cancel">Cancel</button>
          <button class="primary" type="button" id="photo-folder-save">Save here</button>
        </div>
      `);
      const body = backdrop.querySelector('#photo-folder-body');
      let finished = false;
      function finish(value) {
        if (finished) return;
        finished = true;
        closeModal();
        resolve(value);
      }
      backdrop.querySelector('#photo-folder-cancel').addEventListener('click', () => finish(undefined));
      backdrop.querySelector('#photo-folder-save').addEventListener('click', () => finish(currentFolderId));
      backdrop.querySelector('#photo-folder-new').addEventListener('click', async () => {
        const name = await promptModal({ title: 'New folder', placeholder: 'e.g. Progress Photos' });
        if (!name) return;
        let folder;
        try {
          ({ folder } = await api('POST', `/api/projects/${projectId}/documents/folders`, {
            name,
            parent_folder_id: currentFolderId,
          }));
        } catch (err) {
          showToast(err.status ? err.message : "Can't create folders offline - pick an existing folder for now.", 'error');
          return;
        }
        folders.push(folder);
        currentFolderId = folder.id;
        render();
      });

      function render() {
        const path = [];
        let f = currentFolderId;
        while (f) {
          const folder = folders.find((x) => x.id === f);
          if (!folder) break;
          path.unshift(folder);
          f = folder.parent_folder_id;
        }
        const childFolders = folders
          .filter((x) => (x.parent_folder_id || null) === currentFolderId)
          .sort((a, b) => a.name.localeCompare(b.name));
        const breadcrumb =
          `<span class="doc-picker-crumb" data-folder="">Root</span>` +
          path.map((p) => ` / <span class="doc-picker-crumb" data-folder="${p.id}">${escapeHtml(p.name)}</span>`).join('');
        const rows =
          childFolders
            .map((fld) => `<div class="doc-picker-row folder" data-folder="${fld.id}">${FOLDER_ICON}<span>${escapeHtml(fld.name)}</span></div>`)
            .join('') || '<p class="muted" style="padding:8px 4px;">No subfolders here.</p>';
        body.innerHTML = `<div class="doc-picker-breadcrumb">${breadcrumb}</div><div class="doc-picker-list">${rows}</div>`;
        body.querySelectorAll('.doc-picker-crumb').forEach((elx) => {
          elx.addEventListener('click', () => {
            currentFolderId = elx.dataset.folder ? Number(elx.dataset.folder) : null;
            render();
          });
        });
        body.querySelectorAll('.doc-picker-row.folder').forEach((elx) => {
          elx.addEventListener('click', () => {
            currentFolderId = Number(elx.dataset.folder);
            render();
          });
        });
      }
      render();
    });
  }

  function activateTool(tool) {
    // Drawing with markups hidden would place one you can't see.
    if (tool !== 'select' && markupsHidden) {
      setMarkupsHidden(false);
      showToast('Markups shown again.', 'info');
    }
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
    { tool: 'flag', icon: TOOL_ICONS.flag, title: 'Flag (F)' },
    // Placing one uploads a photo (POST /documents), which the server
    // restricts to admin/editor (documents.routes.js) same as any other
    // document upload - a viewer could otherwise place the pin but then hit
    // a 403 on the upload it depends on, so it's left off their toolbar
    // entirely instead.
    ...(me.role === 'admin' || me.role === 'editor'
      ? [{ tool: 'photo', icon: TOOL_ICONS.photo, title: 'Photo pin - place, drag to aim, attach a photo now or later' }]
      : []),
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
    // One-shot shortcut for the Flag tool, same toggle-off-if-already-active
    // behavior as clicking its icon (see the tool-grid click handler above).
    // Frozen reference panes used to own "F" (see sheet.js's
    // setupFreezePaneTool) - moved to "P" so F could mean Flag instead,
    // since flagging is the more frequent action.
    if (e.key.toLowerCase() === 'f') {
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      activateTool(activeTool === 'flag' ? 'select' : 'flag');
    }
  });
  activateTool('select');

  // Live style edits while a markup is selected/being edited, in addition to
  // setting the default for the next newly-drawn markup.
  colorInput.addEventListener('change', async () => {
    if (!editingId) return;
    const m = findMarkup(editingId);
    if (!m) return;
    await patchMarkup(m, { style: { ...m.style, color: colorInput.value } });
    renderAll();
  });
  widthInput.addEventListener('change', async () => {
    if (!editingId) return;
    const m = findMarkup(editingId);
    if (!m) return;
    await patchMarkup(m, { style: { ...m.style, strokeWidth: Number(widthInput.value) } });
    renderAll();
  });

  svgEl.addEventListener('click', (e) => {
    if (e.target === svgEl) deselect();
  });
  // On touch, a finger landing on the bare sheet starts a one-finger pan in
  // zoomPan.js, which preventDefault()s the touchstart - so the synthetic
  // click above never fires on iPad and a selected markup's popup had no way
  // to be dismissed. Treat a touch that ends close to where it started
  // (i.e. a tap, not a pan) as that same "tap off" instead.
  const TAP_SLOP_PX = 10;
  let tapStart = null;
  svgEl.addEventListener('touchstart', (e) => {
    tapStart = e.touches.length === 1 && e.target === svgEl && activeTool === 'select'
      ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
      : null;
  });
  svgEl.addEventListener('touchmove', (e) => {
    if (!tapStart) return;
    const t = e.touches[0];
    if (e.touches.length !== 1 || Math.hypot(t.clientX - tapStart.x, t.clientY - tapStart.y) > TAP_SLOP_PX) tapStart = null;
  });
  svgEl.addEventListener('touchend', (e) => {
    if (tapStart && e.touches.length === 0) deselect();
    tapStart = null;
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

    if (activeTool === 'photo') {
      // Position locks in immediately on touch-down (unlike the drag-to-draw
      // types below, whose "start" corner can still move if the pointer
      // backs up before release) - only the facing direction is live during
      // the drag, swept in updateDrawing from this fixed origin.
      drawing = { type: 'photo', origin: pt, direction: 0 };
      previewEl = el('g');
      previewEl.classList.add('photo-pin-draft');
      // Matches the "pending" red renderMarkupEl gives every photo pin
      // before it has a photo attached (not colorInput.value - see that
      // branch's comment on why this type ignores the color swatch).
      const cone = el('path');
      cone.setAttribute('fill', '#e11d48');
      cone.setAttribute('fill-opacity', '0.4');
      previewEl.appendChild(cone);
      const circle = el('circle');
      circle.setAttribute('cx', pt.x);
      circle.setAttribute('cy', pt.y);
      circle.setAttribute('r', PHOTO_PIN_RADIUS / currentZoomScale);
      circle.setAttribute('fill', '#e11d48');
      circle.setAttribute('stroke', '#ffffff');
      circle.setAttribute('stroke-width', 1.5 / currentZoomScale);
      previewEl.appendChild(circle);
      cone.setAttribute('d', photoConePathD(pt.x, pt.y, 0, currentZoomScale));
      svgEl.appendChild(previewEl);
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
    const { type } = drawing;
    if (type === 'photo') {
      const dx = pt.x - drawing.origin.x;
      const dy = pt.y - drawing.origin.y;
      // Below the same 4px noise floor every other drag gesture in this file
      // uses - a shaky tap shouldn't visibly snap the needle to a near-random
      // direction before the user has actually moved anywhere.
      if (Math.hypot(dx, dy) > 4) drawing.direction = photoAngleFromDelta(dx, dy);
      previewEl.querySelector('path').setAttribute('d', photoConePathD(drawing.origin.x, drawing.origin.y, drawing.direction, currentZoomScale));
      return;
    }
    const { start } = drawing;
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
    const { type } = drawing;

    if (type === 'photo') {
      // Saves immediately as an empty (red/"pending") pin - same
      // create-then-let-the-popup-fill-it-in pattern as flag below, rather
      // than gating creation on picking a photo right away. That's what
      // lets pins be dropped ahead of a job walk with no photo yet: the
      // popup that opens next has an "Attach photo" button, but closing it
      // without using that button just leaves the pin sitting there red,
      // ready to be filled in later from the popup's Add/Attach photo
      // button (see renderPopupButtons' photo branch).
      const dx = pt.x - drawing.origin.x;
      const dy = pt.y - drawing.origin.y;
      const direction = Math.hypot(dx, dy) > 4 ? photoAngleFromDelta(dx, dy) : drawing.direction;
      const origin = drawing.origin;
      if (previewEl) previewEl.remove();
      drawing = null;
      const { w, h } = vbSize();
      const markup = await createMarkup('photo', { x: origin.x / w, y: origin.y / h, direction });
      activateTool('select');
      if (markup) selectMarkup(markup.id);
      return true;
    }

    const { start } = drawing;
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
      if (markup) selectMarkup(markup.id);
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
      await patchMarkup(m, { geometry: m.geometry });
      renderAll();
      return true;
    }
    if (bodyDrag) {
      const m = bodyDrag.markup;
      bodyDrag = null;
      await patchMarkup(m, { geometry: m.geometry });
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

  // Fired by photoOutbox.js after every upload attempt (this page's, or the
  // background retry timer's) - links newly-created documents onto their
  // pins and redraws, so amber pins flip blue without a reload.
  window.addEventListener('photo-outbox-change', async (e) => {
    for (const { localId, markup } of e.detail.createdMarkups || []) {
      const m = findMarkup(localId);
      if (!m) continue;
      delete m.pending;
      delete m.outboxId;
      delete m.uploadError;
      Object.assign(m, markup);
      if (selectedId === localId) selectedId = markup.id;
      if (editingId === localId) editingId = markup.id;
    }
    for (const u of e.detail.uploaded) {
      if (u.document && documents && !documents.some((d) => d.id === u.document.id)) documents.push(u.document);
      photoVersionsCache.delete(u.documentId);
      const m = u.markupId != null ? findMarkup(u.markupId) : null;
      if (m && u.linked) m.linked_document_id = u.documentId;
    }
    await refreshQueuedPhotos();
    renderAll();
  });

  return {
    async load() {
      syncViewBox();
      await refreshQueuedPhotos();
      try {
        const { markups: loaded } = await api('GET', `${base}/markups`);
        markups = loaded;
      } catch (err) {
        // Documents have no offline cache (CLAUDE.md's sync spec only
        // covers sheets) - just show nothing rather than a sheet-shaped
        // cache lookup that would never have anything for this id anyway.
        markups = sheetId ? await getCachedMarkupsForSheet(sheetId) : [];
      }
      try {
        const queued = await getQueuedMarkups(`${base}/markups`);
        markups = markups.concat(queued.map(localMarkupFromEntry));
      } catch (err) {
        // Outbox unreadable - server/cached markups still show.
      }
      renderAll();
    },
    resync() {
      syncViewBox();
      renderAll();
    },
    setZoomScale(scale) {
      // Called on every pan/zoom tick, but the only thing that depends on it
      // is the constant-on-screen stroke/handle sizing - a pure pan leaves
      // the scale untouched, and rebuilding every markup's DOM per touchmove
      // anyway was a big part of why panning felt choppy on iPad.
      if ((scale || 1) === currentZoomScale) return;
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
      if (markupsHidden) setMarkupsHidden(false);
      selectMarkup(m.id);
      return m.geometry;
    },
  };
}
