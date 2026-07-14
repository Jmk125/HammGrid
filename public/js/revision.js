import { renderShell, trackPendingJob, showToast, confirmModal, alertModal } from '/js/shell.js';
import { setupZoomPan as setupSharedZoomPan } from '/js/zoomPan.js';

const params = new URLSearchParams(window.location.search);
const projectId = params.get('projectId');
const revisionId = params.get('revisionId');

const NUMBER_PATTERN = /^[A-Z]{1,2}-?\d+(\.\d+)?$/i;
const CONFIDENCE_THRESHOLD = 70;

function needsAttention(s) {
  if (s.match_status === 'pending') return true;
  const number = s.corrected_number || s.ocr_number || '';
  if (!NUMBER_PATTERN.test(number.trim())) return true;
  if ((s.ocr_number_confidence ?? 0) < CONFIDENCE_THRESHOLD) return true;
  if ((s.ocr_title_confidence ?? 0) < CONFIDENCE_THRESHOLD) return true;
  return false;
}

let stagedSheets = [];
let boxes = { number_box: null, title_box: null };
let drawing = null; // {startX, startY} while dragging
let revisionTitle = '';
let lastCheckedRowIndex = null; // for shift-click range select in the review table
let revisionStatus = '';

// ---------- Accordion ----------
document.querySelectorAll('.pane-section-header').forEach((header) => {
  header.addEventListener('click', () => {
    header.closest('.pane-section').classList.toggle('collapsed');
  });
});

// ---------- Topbar label ----------
function insertRevisionLabel(revision) {
  const leftRow = document.querySelector('#topbar > .row:first-child');
  const label = document.createElement('div');
  label.className = 'sheet-label';
  label.innerHTML = `<span class="num">${revision.title}</span><span class="pill ${revision.status}">${revision.status}</span>`;
  leftRow.appendChild(label);
}

async function loadRevision() {
  const { revision } = await api('GET', `/api/projects/${projectId}/revisions/${revisionId}`);
  revisionTitle = revision.title;
  revisionStatus = revision.status;
  insertRevisionLabel(revision);
  // Upload/box-drawing/publish all stay available regardless of status -
  // sheets can be added to a revision after it's already published (the
  // "modify an existing revision" flow), not just while still a draft.
  return revision;
}

async function loadStaged() {
  const { staged_sheets } = await api('GET', `/api/projects/${projectId}/revisions/${revisionId}/staged`);
  stagedSheets = staged_sheets;
  renderStagedTable();
  renderRefSheetOptions();
}

function renderRefSheetOptions() {
  const select = document.getElementById('ref-sheet-select');
  const prev = select.value;
  select.innerHTML = '';
  for (const s of stagedSheets) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `#${s.upload_order} ${s.ocr_number || s.corrected_number || '(unread)'}`;
    select.appendChild(opt);
  }
  if (prev && stagedSheets.some((s) => String(s.id) === prev)) {
    select.value = prev;
  } else if (stagedSheets.length) {
    select.value = stagedSheets[0].id;
  }
  loadRefImage();
}

function loadRefImage() {
  const select = document.getElementById('ref-sheet-select');
  const img = document.getElementById('ref-image');
  if (!select.value) {
    img.removeAttribute('src');
    return;
  }
  img.src = `/api/staged-sheets/${select.value}/preview`;
}

document.getElementById('ref-sheet-select').addEventListener('change', () => {
  boxes = { number_box: null, title_box: null };
  loadRefImage();
});

document.getElementById('ref-image').addEventListener('load', setupCanvas);

// ---------- Zoom / pan (shared module - see zoomPan.js) ----------
let boxZoomPan = null;

function setupBoxZoomPan() {
  boxZoomPan = setupSharedZoomPan({
    wrapEl: document.getElementById('box-zoom-wrap'),
    innerEl: document.getElementById('box-zoom-pan-inner'),
    // Left-click always draws a box; panning is on the right button instead
    // of sharing the left button with drawing (that's what was causing pan
    // and box-drawing to fight each other).
    panButton: 2,
  });
}

function setupCanvas() {
  const img = document.getElementById('ref-image');
  const canvas = document.getElementById('box-canvas');
  // Size to the image's natural resolution (not clientWidth) so the CSS
  // zoom transform on the wrapper - not the browser's max-width scaling -
  // is what controls the displayed size, matching sheet.js's pattern.
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  img.style.width = w + 'px';
  img.style.height = h + 'px';
  canvas.width = w;
  canvas.height = h;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  redrawCanvas();
  boxZoomPan.fitToView(w, h);
}

function redrawCanvas(liveRect) {
  const canvas = document.getElementById('box-canvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawRect(ctx, boxes.number_box, canvas, 'red', 'number');
  drawRect(ctx, boxes.title_box, canvas, 'blue', 'title');
  if (liveRect) {
    ctx.strokeStyle = drawing.target === 'number_box' ? 'red' : 'blue';
    ctx.lineWidth = 2;
    ctx.strokeRect(liveRect.x, liveRect.y, liveRect.w, liveRect.h);
  }
}

function drawRect(ctx, box, canvas, color, label) {
  if (!box) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  const x = box.x * canvas.width;
  const y = box.y * canvas.height;
  const w = box.w * canvas.width;
  const h = box.h * canvas.height;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = color;
  ctx.font = '12px sans-serif';
  ctx.fillText(label, x + 2, y - 4 < 10 ? y + 12 : y - 4);
}

function nextDrawTarget() {
  if (!boxes.number_box) return 'number_box';
  if (!boxes.title_box) return 'title_box';
  return null;
}

// Mouse events give positions in displayed (CSS/zoomed) pixels, but the
// canvas's own drawing coordinate system is its intrinsic width/height
// (set to the image's natural resolution) - scale into that space so boxes
// land in the right spot at any zoom level.
function toCanvasCoords(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY,
  };
}

const canvas = document.getElementById('box-canvas');
canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return; // left-click draws; right-click pans (see setupBoxZoomPan)
  const target = nextDrawTarget();
  if (!target) return;
  const { x, y } = toCanvasCoords(e);
  drawing = { target, startX: x, startY: y };
});
canvas.addEventListener('mousemove', (e) => {
  if (!drawing) return;
  const { x, y } = toCanvasCoords(e);
  const liveRect = {
    x: Math.min(x, drawing.startX),
    y: Math.min(y, drawing.startY),
    w: Math.abs(x - drawing.startX),
    h: Math.abs(y - drawing.startY),
  };
  redrawCanvas(liveRect);
});
window.addEventListener('mouseup', (e) => {
  if (!drawing) return;
  const { x, y } = toCanvasCoords(e);
  const x0 = Math.min(x, drawing.startX);
  const y0 = Math.min(y, drawing.startY);
  const w = Math.abs(x - drawing.startX);
  const h = Math.abs(y - drawing.startY);
  if (w > 3 && h > 3) {
    boxes[drawing.target] = {
      x: x0 / canvas.width,
      y: y0 / canvas.height,
      w: w / canvas.width,
      h: h / canvas.height,
    };
  }
  drawing = null;
  redrawCanvas();
});

document.getElementById('clear-boxes-btn').addEventListener('click', () => {
  boxes = { number_box: null, title_box: null };
  redrawCanvas();
});

document.getElementById('preview-read-btn').addEventListener('click', async () => {
  const statusEl = document.getElementById('preview-status');
  const resultEl = document.getElementById('preview-result');
  const select = document.getElementById('ref-sheet-select');
  if (!boxes.number_box || !boxes.title_box) {
    statusEl.textContent = 'Draw both boxes first.';
    return;
  }
  if (!select.value) return;

  statusEl.textContent = 'Reading...';
  resultEl.style.display = 'none';
  document.getElementById('preview-read-btn').disabled = true;
  try {
    const result = await api('POST', `/api/projects/${projectId}/revisions/${revisionId}/read-preview`, {
      staged_sheet_id: Number(select.value),
      number_box: boxes.number_box,
      title_box: boxes.title_box,
    });
    statusEl.textContent = '';
    resultEl.style.display = 'block';
    resultEl.innerHTML = `
      <div class="pr-row"><span class="pr-label">Number</span><span class="${result.number_confidence < CONFIDENCE_THRESHOLD ? 'low-conf' : ''}">${escapeAttr(result.number_text) || '(blank)'} &mdash; ${Math.round(result.number_confidence)}%</span></div>
      <div class="pr-row"><span class="pr-label">Title</span><span class="${result.title_confidence < CONFIDENCE_THRESHOLD ? 'low-conf' : ''}">${escapeAttr(result.title_text) || '(blank)'} &mdash; ${Math.round(result.title_confidence)}%</span></div>
    `;
  } catch (err) {
    statusEl.textContent = `Preview failed: ${err.message}`;
  } finally {
    document.getElementById('preview-read-btn').disabled = false;
  }
});

function checkedIds() {
  return Array.from(document.querySelectorAll('.row-check:checked')).map((el) => Number(el.dataset.id));
}

document.getElementById('run-ocr-btn').addEventListener('click', async () => {
  const statusEl = document.getElementById('ocr-status');
  const barEl = document.getElementById('ocr-progress-bar');
  const fillEl = document.getElementById('ocr-progress-fill');
  if (!boxes.number_box || !boxes.title_box) {
    statusEl.textContent = 'Draw both boxes first.';
    return;
  }
  let ids = checkedIds();
  if (ids.length === 0) ids = stagedSheets.map((s) => s.id);

  statusEl.textContent = `Starting read of ${ids.length} sheet(s)...`;
  barEl.style.display = 'block';
  fillEl.style.width = '0%';
  document.getElementById('run-ocr-btn').disabled = true;
  try {
    const { job_id } = await api('POST', `/api/projects/${projectId}/revisions/${revisionId}/ocr`, {
      scope: document.getElementById('scope-input').value || 'default',
      number_box: boxes.number_box,
      title_box: boxes.title_box,
      staged_sheet_ids: ids,
    });
    await pollOcrJob(job_id, ids.length, statusEl, fillEl);
  } catch (err) {
    statusEl.textContent = `Read failed: ${err.message}`;
  } finally {
    document.getElementById('run-ocr-btn').disabled = false;
    barEl.style.display = 'none';
  }
});

async function pollOcrJob(jobId, total, statusEl, fillEl) {
  // Same "outlives the page" tracking as upload jobs - if the user navigates
  // away mid-batch, they still get a toast once it's actually done.
  trackPendingJob({ jobId, projectId, revisionId, label: `Reading ${total} sheet(s) in ${revisionTitle}` });

  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    let job;
    try {
      // Same generic job-status route the upload job uses - see the server
      // comment on that route for why this isn't a separate endpoint.
      ({ job } = await api('GET', `/api/projects/${projectId}/revisions/${revisionId}/upload-jobs/${jobId}`));
    } catch (err) {
      statusEl.textContent = 'Lost track of job status';
      return;
    }
    const done = job.progress ? job.progress.current : 0;
    fillEl.style.width = `${Math.round((done / total) * 100)}%`;
    statusEl.textContent = `Reading ${done} / ${total} sheet(s)...`;

    if (job.status === 'done') {
      statusEl.textContent = `Done reading ${total} sheet(s).`;
      showToast(`Finished reading ${total} sheet(s) in "${revisionTitle}".`, 'success');
      await loadStaged();
      return;
    }
    if (job.status === 'error') {
      statusEl.textContent = `Read failed: ${job.error}`;
      showToast(`Reading sheets in "${revisionTitle}" failed: ${job.error}`, 'error');
      await loadStaged();
      return;
    }
  }
}

function renderStagedTable() {
  const tbody = document.querySelector('#staged-table tbody');
  tbody.innerHTML = '';
  lastCheckedRowIndex = null; // table is being rebuilt - stale reference otherwise
  for (const s of stagedSheets) {
    const tr = document.createElement('tr');
    if (s.match_status === 'ignored') {
      tr.className = 'ignored';
    } else if (needsAttention(s)) {
      tr.className = 'needs-attention';
    }

    const td = (html) => {
      const cell = document.createElement('td');
      cell.innerHTML = html;
      return cell;
    };

    tr.appendChild(td(`<input type="checkbox" class="row-check" data-id="${s.id}">`));
    tr.appendChild(td(`<img class="thumb" src="/api/staged-sheets/${s.id}/thumb">`));
    tr.appendChild(td(`<input class="f-number" style="width:100px" value="${escapeAttr(s.corrected_number ?? s.ocr_number ?? '')}">`));
    tr.appendChild(td(`<input class="f-title" style="width:200px" value="${escapeAttr(s.corrected_title ?? s.ocr_title ?? '')}">`));
    tr.appendChild(td(`<input class="f-discipline" style="width:110px" value="${escapeAttr(s.discipline ?? '')}">`));
    tr.appendChild(td(statusSelect(s)));
    tr.appendChild(td(`<input class="f-match-sheet" type="number" style="width:70px" value="${s.match_sheet_id ?? ''}">`));
    tr.appendChild(
      td(
        `<span class="muted">#${s.ocr_number_confidence ?? '-'} / T${s.ocr_title_confidence ?? '-'}</span>`
      )
    );
    // A real <a target="_blank"> rather than a button whose click handler
    // calls window.open() - browsers treat a native link-navigation click as
    // a much more clearly "trusted" gesture than a script-triggered
    // window.open(), which some browsers' popup heuristics can require an
    // extra click to allow through (reported as "the View button needs two
    // clicks, or click the row first" - this is the fix for that class of
    // issue even though it wasn't reproducible in every environment tested).
    const viewLabel = s.corrected_number || s.ocr_number || '';
    const viewQs = new URLSearchParams({ stagedSheetId: s.id, label: viewLabel });
    tr.appendChild(td(`<a class="view-btn" href="/document-view.html?${viewQs}" target="_blank" rel="noopener">View</a>`));
    tr.appendChild(td(`<button class="danger remove-btn">Remove</button>`));

    tr.querySelector('.f-number').addEventListener('change', (e) => patchField(s.id, 'corrected_number', e.target.value));
    tr.querySelector('.f-title').addEventListener('change', (e) => patchField(s.id, 'corrected_title', e.target.value));
    tr.querySelector('.f-discipline').addEventListener('change', (e) => patchField(s.id, 'discipline', e.target.value));
    tr.querySelector('.f-match-sheet').addEventListener('change', (e) =>
      patchField(s.id, 'match_sheet_id', e.target.value ? Number(e.target.value) : null)
    );
    tr.querySelector('select.f-status').addEventListener('change', (e) => patchField(s.id, 'match_status', e.target.value));
    tr.querySelector('.remove-btn').addEventListener('click', () => removeSheet(s.id));

    tbody.appendChild(tr);
  }
  wireRowCheckboxes();
}

// Shift-click range select (like Windows Explorer/Excel): clicking a row's
// checkbox while holding Shift extends the selection from the last row that
// was clicked (not necessarily the last one checked - matches, e.g. Explorer,
// where shift-clicking an already-checked row to uncheck it also anchors a
// new range) through to the one just clicked, applying that checkbox's new
// checked state to every row in between. Wired via `click` (not `change`) so
// e.target.checked already reflects the state the click just produced, and
// range-set checkboxes are applied directly rather than relying on each of
// them firing their own `change` event (setting .checked in JS doesn't fire
// one).
function wireRowCheckboxes() {
  const checkboxes = Array.from(document.querySelectorAll('.row-check'));
  checkboxes.forEach((cb, index) => {
    cb.addEventListener('click', (e) => {
      if (e.shiftKey && lastCheckedRowIndex !== null) {
        const start = Math.min(lastCheckedRowIndex, index);
        const end = Math.max(lastCheckedRowIndex, index);
        for (let i = start; i <= end; i++) {
          checkboxes[i].checked = e.target.checked;
        }
      }
      lastCheckedRowIndex = index;
      syncRefSheetToSelection();
    });
  });
}

// When the user checks rows meaning to redraw/re-read just those sheets, jump
// the box-drawing reference image to the first checked one automatically -
// otherwise they have to hunt for it in the dropdown themselves.
function syncRefSheetToSelection() {
  const ids = checkedIds();
  if (ids.length === 0) return;
  const select = document.getElementById('ref-sheet-select');
  const firstId = String(ids[0]);
  if (select.value === firstId) return;
  if (!Array.from(select.options).some((o) => o.value === firstId)) return;
  select.value = firstId;
  boxes = { number_box: null, title_box: null };
  loadRefImage();
}

function statusSelect(s) {
  const statuses = ['pending', 'new', 'replacement', 'suspicious', 'ignored'];
  const options = statuses
    .map((st) => `<option value="${st}" ${st === s.match_status ? 'selected' : ''}>${st}</option>`)
    .join('');
  return `<select class="f-status pill ${s.match_status}">${options}</select>`;
}

function escapeAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

async function patchField(id, field, value) {
  try {
    const { staged_sheet } = await api('PATCH', `/api/staged-sheets/${id}`, { [field]: value });
    const idx = stagedSheets.findIndex((s) => s.id === id);
    if (idx >= 0) stagedSheets[idx] = staged_sheet;
    renderStagedTable();
  } catch (err) {
    showToast(`Failed to save: ${err.message}`, 'error');
    loadStaged();
  }
}

async function removeSheet(id) {
  const ok = await confirmModal({
    title: 'Remove this sheet?',
    message: 'This removes it from the batch. This cannot be undone.',
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  await api('DELETE', `/api/staged-sheets/${id}`);
  await loadStaged();
}

document.getElementById('select-all').addEventListener('change', (e) => {
  document.querySelectorAll('.row-check').forEach((el) => (el.checked = e.target.checked));
  syncRefSheetToSelection();
});

// ---------- Drag-and-drop upload with per-file progress ----------
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const uploadList = document.getElementById('upload-list');

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const files = Array.from(e.dataTransfer.files).filter(
    (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
  );
  if (files.length) handleFiles(files);
});
fileInput.addEventListener('change', () => {
  handleFiles(Array.from(fileInput.files));
  fileInput.value = '';
});

async function handleFiles(files) {
  for (const file of files) {
    await uploadOneFile(file);
  }
  await loadStaged();
}

// Only the raw byte transfer (this xhr) is actually unsafe to navigate away
// from - closing the tab or leaving the page mid-transfer aborts the
// connection outright. Once the server has the whole file and hands back a
// job_id, everything from there (burst, OCR) is a real background job that
// survives navigation (see pollJob/pollOcrJob's trackPendingJob calls) - so
// this counter is only held for that first vulnerable window, not the
// whole upload+process lifecycle.
let activeUploadTransfers = 0;
window.addEventListener('beforeunload', (e) => {
  if (activeUploadTransfers > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
});

function uploadOneFile(file) {
  return new Promise((resolve) => {
    const row = document.createElement('div');
    row.className = 'upload-row';
    row.innerHTML = `
      <div class="upload-row-name" title="${escapeAttr(file.name)}">${escapeAttr(file.name)}</div>
      <div class="upload-row-bar"><div class="upload-row-fill"></div></div>
      <div class="upload-row-status">Uploading...</div>
    `;
    uploadList.appendChild(row);
    const fill = row.querySelector('.upload-row-fill');
    const status = row.querySelector('.upload-row-status');

    const formData = new FormData();
    formData.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/projects/${projectId}/revisions/${revisionId}/upload`);
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) fill.style.width = `${(e.loaded / e.total) * 100}%`;
    });
    activeUploadTransfers += 1;
    const transferDone = () => {
      activeUploadTransfers = Math.max(0, activeUploadTransfers - 1);
    };
    xhr.addEventListener('load', async () => {
      transferDone();
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch (err) {
        // ignore
      }
      if (xhr.status !== 202) {
        status.textContent = `Failed: ${(data && data.error) || xhr.statusText}`;
        status.classList.add('error');
        resolve();
        return;
      }
      status.textContent = 'Processing...';
      await pollJob(data.job_id, status, fill, file.name);
      resolve();
    });
    xhr.addEventListener('error', () => {
      transferDone();
      status.textContent = 'Upload failed (network error)';
      status.classList.add('error');
      resolve();
    });
    xhr.send(formData);
  });
}

async function pollJob(jobId, statusEl, fillEl, fileName) {
  // Track it in case the user navigates away before this resolves - a job
  // that outlives this page still gets surfaced as a toast on whichever
  // HammGrid page the user next loads (see shell.js checkPendingJobs()), and
  // as a live progress bar on project-settings.html's revisions table (see
  // getPendingJobsForProject() there).
  trackPendingJob({ jobId, projectId, revisionId, label: `"${fileName}" in ${revisionTitle}` });
  fillEl.style.width = '0%'; // repurposed from "upload transfer %" to "pages processed %" for this phase

  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    let job;
    try {
      ({ job } = await api('GET', `/api/projects/${projectId}/revisions/${revisionId}/upload-jobs/${jobId}`));
    } catch (err) {
      statusEl.textContent = 'Lost track of job status';
      statusEl.classList.add('error');
      return;
    }
    if (job.progress) {
      const { current, total } = job.progress;
      fillEl.style.width = `${Math.round((current / total) * 100)}%`;
      statusEl.textContent = `Processing ${current} / ${total} page(s)...`;
    }
    if (job.status === 'done') {
      fillEl.style.width = '100%';
      statusEl.textContent = 'Done';
      statusEl.classList.add('done');
      showToast(`"${fileName}" finished processing.`, 'success');
      await loadStaged();
      return;
    }
    if (job.status === 'error') {
      statusEl.textContent = `Failed: ${job.error}`;
      statusEl.classList.add('error');
      showToast(`"${fileName}" failed: ${job.error}`, 'error');
      return;
    }
  }
}

document.getElementById('publish-btn').addEventListener('click', async () => {
  const errorEl = document.getElementById('publish-error');
  errorEl.style.display = 'none';
  const alreadyPublished = revisionStatus === 'published';
  const ok = await confirmModal({
    title: alreadyPublished ? 'Publish these additions?' : 'Publish this revision?',
    message: 'The field will see this set as current immediately.',
    confirmLabel: 'Publish',
  });
  if (!ok) return;
  try {
    const result = await api('POST', `/api/projects/${projectId}/revisions/${revisionId}/publish`);
    await alertModal({ title: 'Revision published', message: `Published ${result.published_sheets} sheet(s).` });
    window.location.href = `/project-settings.html?projectId=${projectId}`;
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = 'block';
  }
});

(async function init() {
  const me = await requireSession();
  if (!me) return;
  await renderShell({
    topbarEl: document.getElementById('topbar'),
    sidebarEl: document.getElementById('sidebar'),
    projectId,
    active: 'settings',
    me,
  });
  setupBoxZoomPan();
  await loadRevision();
  await loadStaged();
})();
