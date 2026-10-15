// "Pin to drawing" for the document viewer: from a photo you're looking at,
// pick a drawing from a searchable list, drop a photo pin on it (tap/click,
// drag to aim - same gesture as the sheet viewer's photo tool), and land
// straight back on the photo. The pin is created already linked to this
// photo's document, so nothing else needs doing on the sheet itself.
import { openModal, closeModal, showToast } from '/js/shell.js';
import { setupZoomPan } from '/js/zoomPan.js';
import { photoAngleFromDelta, photoConePathD, PHOTO_PIN_RADIUS } from '/js/markups.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PIN_COLOR = '#2563eb'; // a pin with a photo attached renders blue (see markups.js)

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

export async function pinDocumentToDrawing({ projectId, documentId, documentName }) {
  let sheets;
  try {
    const [sheetRes, docRes] = await Promise.all([
      api('GET', `/api/projects/${projectId}/sheets`),
      api('GET', `/api/projects/${projectId}/documents`),
    ]);
    const doc = (docRes.documents || []).find((d) => d.id === Number(documentId));
    if (doc && doc.linked_sheet_count > 0) {
      showToast('This photo is already pinned to a drawing.', 'error');
      return;
    }
    sheets = sheetRes.sheets;
  } catch (err) {
    showToast(err.status ? err.message : 'Pinning needs a connection - try again once back online.', 'error');
    return;
  }
  const sheet = await pickSheet(sheets);
  if (!sheet) return;
  await placePin({ sheet, documentId, documentName });
}

function pickSheet(sheets) {
  return new Promise((resolve) => {
    const backdrop = openModal(`
      <h2>Pin to which drawing?</h2>
      <input type="text" id="pin-sheet-search" placeholder="Search sheet number or title..." autocomplete="off" style="width:100%;margin-bottom:8px;">
      <div class="doc-picker-list" id="pin-sheet-list"></div>
      <div class="modal-actions"><button type="button" id="pin-sheet-cancel">Cancel</button></div>
    `);
    const input = backdrop.querySelector('#pin-sheet-search');
    const list = backdrop.querySelector('#pin-sheet-list');
    let done = false;
    function finish(value) {
      if (done) return;
      done = true;
      closeModal();
      resolve(value);
    }

    function render() {
      const terms = input.value.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = sheets.filter((s) => {
        const hay = `${s.sheet_number} ${s.current_title || ''} ${s.discipline || ''}`.toLowerCase();
        return terms.every((t) => hay.includes(t));
      });
      list.innerHTML = matches.length
        ? matches
            .map(
              (s) => `<div class="doc-picker-row" data-id="${s.id}"><strong>${escapeHtml(s.sheet_number)}</strong>
                <span class="muted">${escapeHtml(s.current_title || '')}</span></div>`
            )
            .join('')
        : '<p class="muted" style="padding:10px;">No matching drawings.</p>';
    }
    render();
    input.addEventListener('input', render);
    // Enter picks the top match so it can be done from the keyboard.
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const first = list.querySelector('.doc-picker-row');
      if (first) finish(sheets.find((s) => String(s.id) === first.dataset.id));
    });
    list.addEventListener('click', (e) => {
      const row = e.target.closest('.doc-picker-row');
      if (row) finish(sheets.find((s) => String(s.id) === row.dataset.id));
    });
    backdrop.querySelector('#pin-sheet-cancel').addEventListener('click', () => finish(null));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) finish(null);
    });
    input.focus();
  });
}

function placePin({ sheet, documentId, documentName }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'pin-place-overlay';
    overlay.innerHTML = `
      <div class="pin-place-bar">
        <span><strong>${escapeHtml(sheet.sheet_number)}</strong> &mdash; tap where the photo was taken, drag to aim.
          <span class="muted">Pinch / scroll to zoom.</span></span>
        <button type="button" id="pin-place-cancel">Cancel</button>
      </div>
      <div class="pin-place-wrap" id="pin-place-wrap">
        <div class="pin-place-inner" id="pin-place-inner">
          <img id="pin-place-img" alt="">
          <svg id="pin-place-svg"></svg>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const wrap = overlay.querySelector('#pin-place-wrap');
    const inner = overlay.querySelector('#pin-place-inner');
    const img = overlay.querySelector('#pin-place-img');
    const svg = overlay.querySelector('#pin-place-svg');
    let zoom = null;
    let drawing = null;
    let draft = null;
    let busy = false;

    function close(result) {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(result);
    }
    function onKey(e) {
      if (e.key === 'Escape' && !busy) close(false);
    }
    document.addEventListener('keydown', onKey);
    overlay.querySelector('#pin-place-cancel').addEventListener('click', () => !busy && close(false));

    // SVG user units per screen pixel, so the pin/cone stay a constant
    // on-screen size at any zoom (same convention as markups.js).
    const unitsPerPx = () => 1 / svg.getScreenCTM().a;
    const toSvg = (e) => {
      const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
      return { x: p.x, y: p.y };
    };

    function removeDraft() {
      if (draft) draft.remove();
      draft = null;
      drawing = null;
    }

    function drawDraft() {
      const k = unitsPerPx();
      draft.querySelector('path').setAttribute('d', photoConePathD(drawing.origin.x, drawing.origin.y, drawing.direction, 1 / k));
      const c = draft.querySelector('circle');
      c.setAttribute('r', PHOTO_PIN_RADIUS * k);
      c.setAttribute('stroke-width', 1.5 * k);
    }

    svg.addEventListener('pointerdown', (e) => {
      // A second finger means the user is pinching, not placing.
      if (drawing || busy || e.button !== 0 || !e.isPrimary) return removeDraft();
      e.preventDefault();
      svg.setPointerCapture(e.pointerId);
      drawing = { origin: toSvg(e), direction: 0 };
      draft = document.createElementNS(SVG_NS, 'g');
      const cone = document.createElementNS(SVG_NS, 'path');
      cone.setAttribute('fill', PIN_COLOR);
      cone.setAttribute('fill-opacity', '0.4');
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', drawing.origin.x);
      circle.setAttribute('cy', drawing.origin.y);
      circle.setAttribute('fill', PIN_COLOR);
      circle.setAttribute('stroke', '#ffffff');
      draft.append(cone, circle);
      svg.appendChild(draft);
      drawDraft();
    });
    svg.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      const pt = toSvg(e);
      const dx = pt.x - drawing.origin.x;
      const dy = pt.y - drawing.origin.y;
      // Same 4px (screen) noise floor as the sheet viewer's photo tool.
      if (Math.hypot(dx, dy) / unitsPerPx() > 4) drawing.direction = photoAngleFromDelta(dx, dy);
      drawDraft();
    });
    svg.addEventListener('pointercancel', removeDraft);
    svg.addEventListener('pointerup', async (e) => {
      if (!drawing) return;
      const { origin, direction } = drawing;
      busy = true;
      const w = svg.viewBox.baseVal.width;
      const h = svg.viewBox.baseVal.height;
      try {
        await api('POST', `/api/sheets/${sheet.id}/markups`, {
          type: 'photo',
          geometry: { x: origin.x / w, y: origin.y / h, direction },
          style: { color: '#e11d48', strokeWidth: 2 },
          visibility: 'private',
          linked_document_id: Number(documentId),
        });
      } catch (err) {
        busy = false;
        removeDraft();
        showToast(err.status ? err.message : 'Pinning needs a connection - try again once back online.', 'error');
        return;
      }
      showToast(`Pinned ${documentName ? `"${documentName}" ` : ''}to ${sheet.sheet_number}.`, 'success');
      close(true);
    });

    img.addEventListener('load', () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      inner.style.width = `${w}px`;
      inner.style.height = `${h}px`;
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      zoom = setupZoomPan({
        wrapEl: wrap,
        innerEl: inner,
        panButton: 2, // right-drag pans on a mouse; touch uses pinch / two-finger drag
        touchPan: false,
        // Everything in here is the drawing surface, so right-drag pan is never blocked.
      });
      zoom.fitToView(w, h);
    });
    img.addEventListener('error', () => {
      showToast('Could not load that drawing.', 'error');
      close(false);
    });
    img.src = `/api/sheet-versions/${sheet.current_version_id}/preview`;
  });
}
