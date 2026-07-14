import { syncProject, getCachedSheets, getCachedAsset, getProjectSyncInfo } from '/js/offline-store.js';
import { renderShell, openModal, closeModal } from '/js/shell.js';

const projectId = new URLSearchParams(window.location.search).get('projectId');

let selectionMode = false;
let selectedIds = new Set();
let lastFiltered = [];
let currentProject = null;


function syncLabel(info) {
  if (!navigator.onLine) return { status: 'offline', text: info.cachedSheetCount ? 'Offline · cached' : 'Offline · not synced' };
  if (info.status === 'syncing') return { status: 'syncing', text: 'Syncing…' };
  if (info.status === 'synced') return { status: 'synced', text: 'Synced' };
  if (info.status === 'needs-sync') return { status: 'needs-sync', text: 'Needs sync' };
  if (info.status === 'empty') return { status: 'empty', text: 'No drawings' };
  return { status: 'not-synced', text: 'Not synced' };
}

async function updateProjectSyncPill(override) {
  const pill = document.getElementById('project-sync-pill');
  if (!pill) return;
  if (override) {
    pill.className = `sync-pill ${override.status}`;
    pill.textContent = override.text;
    return;
  }
  try {
    const info = await getProjectSyncInfo(projectId, currentProject || {});
    const label = syncLabel(info);
    pill.className = `sync-pill ${label.status}`;
    pill.textContent = label.text;
    pill.title = info.lastSync ? `Last synced ${info.lastSync}` : 'This device has not synced this project yet.';
  } catch (err) {
    pill.className = 'sync-pill not-synced';
    pill.textContent = 'Sync unknown';
  }
}

async function loadFilters() {
  const { project } = await api('GET', `/api/projects/${projectId}`);
  currentProject = project;
  document.getElementById('project-name').textContent = project.name;
  updateProjectSyncPill();

  const disciplines = [...new Set(Object.values(project.discipline_prefix_map))].sort();
  const disciplineSelect = document.getElementById('discipline-filter');
  for (const d of disciplines) {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = d;
    disciplineSelect.appendChild(opt);
  }

  const { revisions } = await api('GET', `/api/projects/${projectId}/revisions`);
  const revisionSelect = document.getElementById('revision-filter');
  for (const r of revisions.filter((r) => r.status === 'published')) {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = r.title;
    revisionSelect.appendChild(opt);
  }
}

let lastItems = [];

// discipline_prefix_map only covers the disciplines a project's admin has
// explicitly mapped a number prefix to - a one-off custom discipline typed
// in during review (e.g. "Aquatics" for a pool project) has a real
// sheets.discipline value but no prefix map entry, so it wouldn't otherwise
// appear as a filter option at all. Rebuilds the option list in sorted order
// (rather than just appending discovered ones at the end) so a custom
// discipline lands alphabetically among the mapped ones instead of always
// trailing last.
function addMissingDisciplineOptions(items) {
  const select = document.getElementById('discipline-filter');
  const known = new Set([...select.options].slice(1).map((o) => o.value)); // skip "All"
  const discovered = items.map((s) => s.discipline).filter(Boolean);
  if (discovered.every((d) => known.has(d))) return; // nothing new - avoid disturbing the current selection/options for no reason
  const all = [...new Set([...known, ...discovered])].sort();
  const currentValue = select.value;
  select.innerHTML = '';
  select.appendChild(new Option('All', ''));
  for (const d of all) select.appendChild(new Option(d, d));
  select.value = currentValue;
}

function renderGrid(items) {
  lastItems = items;
  addMissingDisciplineOptions(items);
  const discipline = document.getElementById('discipline-filter').value;
  const revisionId = document.getElementById('revision-filter').value;
  const search = document.getElementById('search-filter').value.trim().toLowerCase();
  let filtered = items;
  if (discipline) filtered = filtered.filter((s) => s.discipline === discipline);
  if (revisionId) filtered = filtered.filter((s) => String(s.revision_id) === revisionId);
  if (search) {
    filtered = filtered.filter(
      (s) => s.sheet_number.toLowerCase().includes(search) || (s.title || '').toLowerCase().includes(search)
    );
  }
  filtered.sort((a, b) => a.sheet_number.localeCompare(b.sheet_number));
  lastFiltered = filtered;

  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  document.getElementById('empty-msg').style.display = filtered.length ? 'none' : '';

  for (const s of filtered) {
    const selected = selectedIds.has(s.sheet_id);
    // Selection mode swaps the card from a navigating <a> to a non-navigating
    // <div> entirely, rather than trying to suppress the <a>'s default click
    // behavior - simpler and avoids any chance of a stray navigation on touch.
    const card = document.createElement(selectionMode ? 'div' : 'a');
    card.className = 'sheet-card' + (selectionMode ? ' selectable' : '') + (selected ? ' selected' : '');
    if (!selectionMode) card.href = `/sheet.html?projectId=${projectId}&sheetId=${s.sheet_id}`;
    card.innerHTML = `
      ${selectionMode ? `<span class="card-checkbox"><input type="checkbox" tabindex="-1" ${selected ? 'checked' : ''}><span class="checkmark"></span></span>` : ''}
      <div class="thumb-wrap"><img src="${s.thumbSrc}" loading="lazy"></div>
      <div class="meta">
        <div class="sheet-number">${s.sheet_number}</div>
        <div class="sheet-title">${s.title || ''}</div>
      </div>`;
    if (selectionMode) {
      card.addEventListener('click', () => toggleSheetSelection(s.sheet_id, card));
    }
    grid.appendChild(card);
  }
  if (selectionMode) updateSelectionBar();
}

function toggleSheetSelection(sheetId, cardEl) {
  const nowSelected = !selectedIds.has(sheetId);
  if (nowSelected) selectedIds.add(sheetId);
  else selectedIds.delete(sheetId);
  cardEl.classList.toggle('selected', nowSelected);
  cardEl.querySelector('input[type="checkbox"]').checked = nowSelected;
  updateSelectionBar();
}

function updateSelectionBar() {
  const count = selectedIds.size;
  document.getElementById('selection-count').textContent = count === 1 ? '1 selected' : `${count} selected`;
  document.getElementById('selection-download-btn').disabled = count === 0;
  const allSelected = lastFiltered.length > 0 && lastFiltered.every((s) => selectedIds.has(s.sheet_id));
  const selectAllInput = document.getElementById('select-all-checkbox');
  selectAllInput.checked = allSelected;
  document.getElementById('select-all-chip').classList.toggle('checked', allSelected);
}

function setSelectionMode(on) {
  selectionMode = on;
  document.getElementById('selection-bar').style.display = on ? '' : 'none';
  if (!on) selectedIds.clear();
  renderGrid(lastItems);
}

function setupSelectionToggleButton() {
  const whoami = document.getElementById('whoami');
  const row = whoami ? whoami.parentElement : document.querySelector('#topbar > .row:last-child');
  if (!row || document.getElementById('select-sheets-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'select-sheets-btn';
  btn.className = 'icon-btn';
  btn.type = 'button';
  btn.title = 'Download drawings';
  btn.textContent = '⬇';
  btn.addEventListener('click', () => setSelectionMode(true));
  const newRevBtn = document.getElementById('new-revision-btn');
  if (newRevBtn) newRevBtn.after(btn);
  else row.prepend(btn);
}

function setupSelectionBar() {
  const selectAllInput = document.getElementById('select-all-checkbox');
  // The native <label> wrapping this input already forwards any click inside
  // it to the input itself (including toggling `checked`), so listening for
  // the input's own 'change' event is the only wiring needed here - an extra
  // click listener on the label double-toggles it.
  selectAllInput.addEventListener('change', () => {
    if (selectAllInput.checked) lastFiltered.forEach((s) => selectedIds.add(s.sheet_id));
    else lastFiltered.forEach((s) => selectedIds.delete(s.sheet_id));
    renderGrid(lastItems);
  });
  document.getElementById('selection-cancel-btn').addEventListener('click', () => setSelectionMode(false));
  document.getElementById('selection-download-btn').addEventListener('click', () => {
    if (selectedIds.size > 0) openMergedDownloadModal([...selectedIds]);
  });
}

function openMergedDownloadModal(sheetIds) {
  const count = sheetIds.length;
  openModal(`
    <h2>Download ${count} drawing${count === 1 ? '' : 's'}</h2>
    <label class="permission-option">
      <input type="checkbox" id="dl-published" checked>
      <span><b>Published markups</b><small>Include markups any user has published to these sheets.</small></span>
    </label>
    <label class="permission-option">
      <input type="checkbox" id="dl-personal" checked>
      <span><b>My personal markups</b><small>Include your own private markups on these sheets.</small></span>
    </label>
    <p class="error" id="dl-error" style="display:none;"></p>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Cancel</button>
      <button class="primary" type="button" id="modal-ok">Download</button>
    </div>
  `);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-ok').addEventListener('click', async () => {
    const okBtn = document.getElementById('modal-ok');
    okBtn.disabled = true;
    okBtn.textContent = 'Preparing...';
    try {
      await downloadMergedSheets(sheetIds, {
        published: document.getElementById('dl-published').checked,
        personal: document.getElementById('dl-personal').checked,
      });
      closeModal();
      setSelectionMode(false);
    } catch (err) {
      const errEl = document.getElementById('dl-error');
      errEl.textContent = err.message;
      errEl.style.display = 'block';
      okBtn.disabled = false;
      okBtn.textContent = 'Download';
    }
  });
}

// Not using the shared api() helper here - it always calls res.json(), which
// would consume/choke on this endpoint's binary PDF body. A POST (not GET)
// because a large sheet selection could otherwise overflow a URL query string.
async function downloadMergedSheets(sheetIds, { published, personal }) {
  const res = await fetch(`/api/projects/${projectId}/export/selected-merged-pdf`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sheetIds, published: !!published, personal: !!personal }),
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (data && data.error) message = data.error;
    } catch (e) {
      // no JSON body on this error - keep the status-line message
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'drawings-merged.pdf';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Renders straight from IndexedDB/OPFS - no network in the path, works offline.
async function renderFromCache() {
  const cached = await getCachedSheets(projectId);
  const items = await Promise.all(
    cached.map(async (s) => {
      const thumbFile = await getCachedAsset(s.current_version_id, 'thumb');
      return {
        sheet_id: s.sheet_id,
        sheet_number: s.sheet_number,
        discipline: s.discipline,
        revision_id: s.current_revision_id,
        title: s.current_title,
        thumbSrc: thumbFile ? URL.createObjectURL(thumbFile) : `/api/sheet-versions/${s.current_version_id}/thumb`,
      };
    })
  );
  renderGrid(items);
  return items.length;
}

// Only used to bootstrap the very first view before anything has ever synced.
async function renderFromLiveApi() {
  const { sheets } = await api('GET', `/api/projects/${projectId}/sheets`);
  renderGrid(
    sheets.map((s) => ({
      sheet_id: s.id,
      sheet_number: s.sheet_number,
      discipline: s.discipline,
      revision_id: s.current_revision_id,
      title: s.current_title,
      thumbSrc: `/api/sheet-versions/${s.current_version_id}/thumb`,
    }))
  );
}

document.getElementById('discipline-filter').addEventListener('change', renderFromCache);
document.getElementById('revision-filter').addEventListener('change', renderFromCache);
// Search filters the already-loaded list client-side - no need to re-hit
// cache/API on every keystroke like the dropdowns do.
document.getElementById('search-filter').addEventListener('input', () => renderGrid(lastItems));

(async function init() {
  const me = await requireSession();
  if (!me) return;
  await renderShell({
    topbarEl: document.getElementById('topbar'),
    sidebarEl: document.getElementById('sidebar'),
    projectId,
    active: 'viewer',
    me,
  });
  setupSelectionToggleButton();
  setupSelectionBar();

  try {
    await loadFilters();
  } catch (err) {
    // offline on first-ever load with no cached project metadata - filters just stay empty
  }

  const cachedCount = await renderFromCache();
  if (cachedCount === 0) {
    try {
      await renderFromLiveApi();
    } catch (err) {
      // nothing cached and no network - genuinely nothing to show yet
    }
  }

  const statusEl = document.getElementById('sync-status');
  try {
    statusEl.textContent = 'Syncing...';
    updateProjectSyncPill({ status: 'syncing', text: 'Syncing…' });
    const result = await syncProject(projectId, {
      onProgress: (done, total) => updateProjectSyncPill({ status: 'syncing', text: `Syncing ${done}/${total}` }),
    });
    statusEl.textContent = `Synced ${result.sheetCount} sheet(s) at ${result.since}.`;
    await renderFromCache();
    await updateProjectSyncPill();
  } catch (err) {
    statusEl.textContent = 'Offline - showing last synced data.';
    await updateProjectSyncPill();
  }
})();
