// Composite drawings' "bring in a fragment" flow: pick a source sheet +
// version, crop a region of its PDF, optionally trace freeform mask
// polygon(s) over clutter (title blocks, stamps, notes), confirm the
// scale-reconciled size, then hand the result back to the caller (sheet.js's
// Edit Layout mode), which does the actual POST + placement on the canvas.
//
// Deliberately isolated from sheet.js's own render-state machinery (which
// assumes exactly one sheet per page load) rather than repurposing it for a
// second, temporary sheet - a small duplication of well-understood PDF.js/
// coordinate math is simpler than fighting that assumption. See the
// composite-drawings plan for the full rationale.
import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';
import { openModal, closeModal, showToast } from '/js/shell.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

const RENDER_SCALE = 2.5;
const MAX_RENDER_PX = 4000; // a picker modal, not the main viewer - doesn't need sheet.js's full 6000px cap

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag) {
  return document.createElementNS(SVG_NS, tag);
}

function boxCorners(a, b) {
  return [
    { x: a.x, y: a.y },
    { x: b.x, y: a.y },
    { x: b.x, y: b.y },
    { x: a.x, y: b.y },
  ];
}

function rectFromCorners(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

function polygonAreaOf(pts) {
  let area2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % pts.length];
    area2 += p1.x * p2.y - p2.x * p1.y;
  }
  return Math.abs(area2) / 2;
}

// Opens the full flow. Resolves with
// `{ source_sheet_id, source_version_id, crop, mask_polygons, place }` ready
// to POST to the composite-fragments route, or `null` if cancelled at any
// step.
export function openFragmentPicker(projectId, compositeScaleFeetPerInch) {
  return new Promise((resolve) => {
    openSheetStep(projectId, compositeScaleFeetPerInch, resolve);
  });
}

async function openSheetStep(projectId, compositeScale, resolve) {
  let sheets;
  try {
    ({ sheets } = await api('GET', `/api/projects/${projectId}/sheets`));
  } catch (err) {
    showToast(`Failed to load sheets: ${err.message}`, 'error');
    resolve(null);
    return;
  }
  // Bringing in a composite-of-a-composite would be confusing (a fragment's
  // source is pinned to one version forever, so it's not unsafe, just
  // pointless product-wise) - this feature combines real uploaded sheets.
  const candidates = sheets.filter((s) => !s.is_composite);

  openModal(`
    <h2>Bring in fragment</h2>
    <p class="muted">Pick the sheet to crop a region from.</p>
    <input type="text" id="fp-sheet-search" class="takeoff-search-input" placeholder="Search sheets..." autocomplete="off">
    <div class="takeoff-template-picker-list" id="fp-sheet-list"></div>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Cancel</button>
    </div>
  `);
  document.getElementById('modal-cancel').addEventListener('click', () => {
    closeModal();
    resolve(null);
  });

  const listEl = document.getElementById('fp-sheet-list');
  function renderList(term) {
    const filtered = term
      ? candidates.filter(
          (s) => s.sheet_number.toLowerCase().includes(term) || (s.current_title || '').toLowerCase().includes(term)
        )
      : candidates;
    if (filtered.length === 0) {
      listEl.innerHTML = '<p class="muted">No sheets match.</p>';
      return;
    }
    listEl.innerHTML = filtered
      .map(
        (s) => `
      <button type="button" class="takeoff-template-picker-row" data-id="${s.id}">
        <span class="takeoff-template-picker-name">${escapeHtml(s.sheet_number)}</span>
        <span class="muted">${escapeHtml(s.current_title || '')}</span>
      </button>`
      )
      .join('');
    listEl.querySelectorAll('.takeoff-template-picker-row').forEach((row) => {
      row.addEventListener('click', () => {
        const sheet = candidates.find((s) => s.id === Number(row.dataset.id));
        openVersionStep(projectId, compositeScale, sheet, resolve);
      });
    });
  }
  renderList('');
  document.getElementById('fp-sheet-search').addEventListener('input', (e) => {
    renderList(e.target.value.trim().toLowerCase());
  });
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

async function openVersionStep(projectId, compositeScale, sheetSummary, resolve) {
  let sheet, versions;
  try {
    ({ sheet, versions } = await api('GET', `/api/projects/${projectId}/sheets/${sheetSummary.id}`));
  } catch (err) {
    showToast(`Failed to load sheet: ${err.message}`, 'error');
    resolve(null);
    return;
  }
  if (!sheet.scale_feet_per_inch) {
    showToast(`"${sheet.sheet_number}" has no scale set - set one before using it as a fragment source.`, 'error');
    resolve(null);
    return;
  }

  openModal(`
    <h2>${escapeHtml(sheet.sheet_number)}</h2>
    <div class="field">
      <label>Version</label>
      <select id="fp-version-select">
        ${versions
          .map(
            (v) =>
              `<option value="${v.id}"${v.id === sheet.current_version_id ? ' selected' : ''}>${escapeHtml(v.revision_title)}${v.title ? ' - ' + escapeHtml(v.title) : ''}</option>`
          )
          .join('')}
      </select>
    </div>
    <div class="modal-actions">
      <button type="button" id="modal-back">Back</button>
      <button class="primary" type="button" id="modal-next">Next: draw crop</button>
    </div>
  `);
  document.getElementById('modal-back').addEventListener('click', () => openSheetStep(projectId, compositeScale, resolve));
  document.getElementById('modal-next').addEventListener('click', () => {
    const versionId = Number(document.getElementById('fp-version-select').value);
    const version = versions.find((v) => v.id === versionId);
    openCropAndMaskStep(projectId, compositeScale, sheet, version, resolve);
  });
}

// The crop+mask step renders the chosen version's PDF once into a private
// canvas+svg pair and keeps both alive across the crop -> (optional) mask
// sub-phases, rather than tearing down and re-opening the modal between
// them.
async function openCropAndMaskStep(projectId, compositeScale, sheet, version, resolve) {
  openModal(`
    <h2 class="fragment-picker">Draw a crop box</h2>
    <p class="muted" id="fp-instructions">Click two opposite corners around the region you want to bring in.</p>
    <div class="fragment-picker-canvas-wrap">
      <canvas id="fp-canvas"></canvas>
      <svg id="fp-svg"></svg>
    </div>
    <div class="modal-actions" id="fp-crop-actions">
      <button type="button" id="modal-cancel">Cancel</button>
    </div>
  `);
  document.getElementById('modal-cancel').addEventListener('click', () => {
    closeModal();
    resolve(null);
  });

  const canvas = document.getElementById('fp-canvas');
  const svg = document.getElementById('fp-svg');
  const ctx = canvas.getContext('2d');

  let pdf, page, viewport;
  try {
    const loadingTask = pdfjsLib.getDocument({ url: `/api/sheet-versions/${version.id}/pdf` });
    pdf = await loadingTask.promise;
    page = await pdf.getPage(1);
  } catch (err) {
    showToast(`Failed to load PDF: ${err.message}`, 'error');
    closeModal();
    resolve(null);
    return;
  }
  const unitViewport = page.getViewport({ scale: 1 });
  const longestPt = Math.max(unitViewport.width, unitViewport.height);
  const renderScale = Math.min(RENDER_SCALE, MAX_RENDER_PX / longestPt);
  viewport = page.getViewport({ scale: renderScale });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: ctx, viewport }).promise;

  // The svg's viewBox is set directly in the SOURCE PDF's own point space
  // (not canvas pixels) - clicks convert straight to crop/mask coordinates
  // with no separate render-scale division needed anywhere else in this
  // step, since crop/mask are stored in point space per the composite
  // fragment contract.
  svg.setAttribute('viewBox', `0 0 ${unitViewport.width} ${unitViewport.height}`);

  function clientToPoint(evt) {
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    return {
      x: ((evt.clientX - rect.left) / rect.width) * vb.width,
      y: ((evt.clientY - rect.top) / rect.height) * vb.height,
    };
  }

  let firstCorner = null;
  let cropRect = null;
  let phase = 'crop'; // 'crop' | 'crop-done' | 'mask'
  const maskPolygons = [];
  let maskDraft = [];

  function redraw(livePt) {
    svg.innerHTML = '';
    const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width || 1;

    if (cropRect) {
      const r = svgEl('rect');
      r.setAttribute('x', cropRect.x);
      r.setAttribute('y', cropRect.y);
      r.setAttribute('width', cropRect.width);
      r.setAttribute('height', cropRect.height);
      r.setAttribute('fill', 'rgba(37,99,235,0.08)');
      r.setAttribute('stroke', '#2563eb');
      r.setAttribute('stroke-width', 2 / scale);
      r.setAttribute('stroke-dasharray', `${6 / scale} ${4 / scale}`);
      svg.appendChild(r);
    } else if (phase === 'crop' && firstCorner && livePt) {
      const r = rectFromCorners(firstCorner, livePt);
      const rect = svgEl('rect');
      rect.setAttribute('x', r.x);
      rect.setAttribute('y', r.y);
      rect.setAttribute('width', r.width);
      rect.setAttribute('height', r.height);
      rect.setAttribute('fill', 'rgba(37,99,235,0.08)');
      rect.setAttribute('stroke', '#2563eb');
      rect.setAttribute('stroke-width', 2 / scale);
      rect.setAttribute('stroke-dasharray', `${6 / scale} ${4 / scale}`);
      svg.appendChild(rect);
    }

    for (const polygon of maskPolygons) drawMaskPolygon(polygon, '#dc2626', 0.2, scale);
    if (phase === 'mask' && maskDraft.length > 0) {
      const linePts = livePt ? [...maskDraft, livePt] : maskDraft;
      drawMaskPolygon(linePts, '#dc2626', maskDraft.length >= 2 ? 0.15 : 0, scale, true);
    }
  }

  function drawMaskPolygon(pts, color, fillOpacity, scale, dashed) {
    if (pts.length < 2) return;
    const el = svgEl(pts.length >= 3 ? 'polygon' : 'polyline');
    el.setAttribute('points', pts.map((p) => `${p.x},${p.y}`).join(' '));
    el.setAttribute('stroke', color);
    el.setAttribute('stroke-width', 2 / scale);
    el.setAttribute('fill', fillOpacity ? color : 'none');
    el.setAttribute('fill-opacity', String(fillOpacity));
    if (dashed) el.setAttribute('stroke-dasharray', `${5 / scale} ${3 / scale}`);
    svg.appendChild(el);
    for (const p of pts) {
      const c = svgEl('circle');
      c.setAttribute('cx', p.x);
      c.setAttribute('cy', p.y);
      c.setAttribute('r', 4 / scale);
      c.setAttribute('fill', color);
      svg.appendChild(c);
    }
  }

  function updateInstructions() {
    const el = document.getElementById('fp-instructions');
    if (phase === 'crop') el.textContent = 'Click two opposite corners around the region you want to bring in.';
    else if (phase === 'mask')
      el.textContent = 'Click points to trace clutter to cut out (title block, stamp, notes). Click near the first point or press Enter to close it. Escape cancels the current trace.';
    else el.textContent = 'Crop set. Trace a mask to cut out clutter, or continue.';
  }

  function updateActionsBar() {
    const bar = document.getElementById('fp-crop-actions');
    if (phase === 'crop') {
      bar.innerHTML = `<button type="button" id="modal-cancel">Cancel</button>`;
    } else if (phase === 'mask') {
      bar.innerHTML = `<button type="button" id="modal-cancel">Cancel</button>`;
    } else {
      bar.innerHTML = `
        <button type="button" id="modal-cancel">Cancel</button>
        <button type="button" id="fp-redo-crop">Redraw crop</button>
        <button type="button" id="fp-trace-mask">Trace a mask</button>
        <button class="primary" type="button" id="fp-continue">Continue${maskPolygons.length ? ` (${maskPolygons.length} mask${maskPolygons.length === 1 ? '' : 's'})` : ''}</button>
      `;
      document.getElementById('fp-redo-crop').addEventListener('click', () => {
        cropRect = null;
        firstCorner = null;
        maskPolygons.length = 0;
        maskDraft = [];
        phase = 'crop';
        updateInstructions();
        updateActionsBar();
        redraw();
      });
      document.getElementById('fp-trace-mask').addEventListener('click', () => {
        phase = 'mask';
        maskDraft = [];
        updateInstructions();
        updateActionsBar();
        redraw();
      });
      document.getElementById('fp-continue').addEventListener('click', () => {
        cleanup();
        openScaleConfirmStep(projectId, compositeScale, sheet, version, cropRect, maskPolygons, resolve);
      });
    }
    document.getElementById('modal-cancel').addEventListener('click', () => {
      cleanup();
      closeModal();
      resolve(null);
    });
  }

  function finishMaskPolygon() {
    if (maskDraft.length >= 3 && polygonAreaOf(maskDraft) > 0) {
      maskPolygons.push(maskDraft);
    }
    maskDraft = [];
    phase = 'crop-done';
    updateInstructions();
    updateActionsBar();
    redraw();
  }

  function onSvgClick(e) {
    const pt = clientToPoint(e);
    if (phase === 'crop') {
      if (!firstCorner) {
        firstCorner = pt;
        redraw(pt);
        return;
      }
      cropRect = rectFromCorners(firstCorner, pt);
      firstCorner = null;
      phase = 'crop-done';
      updateInstructions();
      updateActionsBar();
      redraw();
      return;
    }
    if (phase === 'mask') {
      if (maskDraft.length >= 3) {
        const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width || 1;
        const dist = Math.hypot(pt.x - maskDraft[0].x, pt.y - maskDraft[0].y);
        if (dist < 6 / scale) {
          finishMaskPolygon();
          return;
        }
      }
      maskDraft.push(pt);
      redraw();
    }
  }

  function onSvgMove(e) {
    if (phase === 'crop' && firstCorner) redraw(clientToPoint(e));
    else if (phase === 'mask' && maskDraft.length > 0) redraw(clientToPoint(e));
  }

  function onKeydown(e) {
    if (e.key === 'Escape') {
      if (phase === 'mask') {
        if (maskDraft.length > 0) {
          maskDraft = [];
          redraw();
        } else {
          phase = 'crop-done';
          updateInstructions();
          updateActionsBar();
          redraw();
        }
      } else if (phase === 'crop' && firstCorner) {
        firstCorner = null;
        redraw();
      } else {
        cleanup();
        closeModal();
        resolve(null);
      }
    } else if (e.key === 'Enter' && phase === 'mask' && maskDraft.length >= 3) {
      finishMaskPolygon();
    } else if (e.key === 'Backspace' && phase === 'mask' && maskDraft.length > 0) {
      maskDraft.pop();
      redraw();
    }
  }

  function cleanup() {
    svg.removeEventListener('click', onSvgClick);
    svg.removeEventListener('mousemove', onSvgMove);
    document.removeEventListener('keydown', onKeydown);
  }

  svg.addEventListener('click', onSvgClick);
  svg.addEventListener('mousemove', onSvgMove);
  document.addEventListener('keydown', onKeydown);
  updateActionsBar();
}

function openScaleConfirmStep(projectId, compositeScale, sheet, version, cropRect, maskPolygons, resolve) {
  const ratio = sheet.scale_feet_per_inch / compositeScale;
  const placeWidth = cropRect.width * ratio;
  const placeHeight = cropRect.height * ratio;

  openModal(`
    <h2>Confirm size</h2>
    <p class="muted">Resized so this fragment's real-world size matches the composite's own reference scale (this drawing is at ${sheet.scale_feet_per_inch} ft/in, the composite is at ${compositeScale} ft/in).</p>
    <div class="field"><label>Width on composite (pt)</label><input type="number" id="fp-place-width" value="${placeWidth.toFixed(1)}"></div>
    <div class="field"><label>Height on composite (pt)</label><input type="number" id="fp-place-height" value="${placeHeight.toFixed(1)}"></div>
    <p class="error" id="fp-error" style="display:none;"></p>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Cancel</button>
      <button class="primary" type="button" id="fp-confirm">Bring in fragment</button>
    </div>
  `);
  document.getElementById('modal-cancel').addEventListener('click', () => {
    closeModal();
    resolve(null);
  });
  document.getElementById('fp-confirm').addEventListener('click', () => {
    const w = Number(document.getElementById('fp-place-width').value);
    const h = Number(document.getElementById('fp-place-height').value);
    const errEl = document.getElementById('fp-error');
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      errEl.textContent = 'Width and height must be positive numbers.';
      errEl.style.display = 'block';
      return;
    }
    closeModal();
    resolve({
      source_sheet_id: sheet.id,
      source_version_id: version.id,
      crop: { x: cropRect.x, y: cropRect.y, width: cropRect.width, height: cropRect.height },
      mask_polygons: maskPolygons,
      place: { x: 0, y: 0, width: w, height: h }, // caller repositions on the canvas
    });
  });
}
