import { syncProject, getCachedSheets, getCachedAsset, getProjectSyncInfo, ensureProjectCacheFresh } from '/js/offline-store.js';
import { renderShell, openModal, closeModal } from '/js/shell.js';

const params = new URLSearchParams(window.location.search);
const projectId = params.get('projectId');
// "View Multiple" (see dashboard.js) - a comma-separated set of project ids
// instead of a single one means this is the combined-view flavor: sheets
// from every listed project, merged and view-only. Deliberately online-only
// (no offline-store caching/sync for this mode) - this is a desk/office
// review workflow across several related projects, not the field-iPad case
// the offline story exists for; each individual project's own page keeps
// full offline support unchanged.
const combinedProjectIds = params.get('projectIds');
const combinedMode = !!combinedProjectIds;
const combinedIds = combinedMode ? combinedProjectIds.split(',').map((s) => s.trim()) : [];
let combinedProjectNames = new Map(); // id (string) -> name, populated in loadCombinedFilters

let selectionMode = false;
let selectedIds = new Set();
let lastFiltered = [];
let currentProject = null;
let projectFilterValue = '';

// sheet_ids that matched the last content-search (drawing body text, not
// metadata) response, or null if no content search has resolved yet for the
// current term. Unioned into the metadata filter in renderGrid().
let contentMatchIds = null;
let searchDebounceTimer = null;

function searchStorageKey() {
  return `hammgrid-sheet-search:${projectId}`;
}

function disciplineStorageKey() {
  return `hammgrid-discipline-filter:${projectId}`;
}

function filteredOrderKey() {
  return `hammgrid-filtered-order:${projectId}`;
}


function syncLabel(info) {
  if (!navigator.onLine) return { status: 'offline', text: info.cachedSheetCount ? 'Offline · cached' : 'Offline · not synced' };
  if (info.status === 'syncing') return { status: 'syncing', text: 'Syncing…' };
  if (info.status === 'synced') return { status: 'synced', text: 'Synced' };
  if (info.status === 'needs-sync') return { status: 'needs-sync', text: 'Needs sync' };
  if (info.status === 'empty') return { status: 'empty', text: 'No drawings' };
  // The pill's title attribute is a hover tooltip - invisible on iPad's
  // touch UI, which has no hover state at all. Distinct visible text (not
  // just a tooltip) is what actually makes this reachable on the device
  // this whole offline story is built for.
  if (info.status === 'error') return { status: 'error', text: `Sync error: ${(info.state && info.state.message) || 'unknown'}` };
  return { status: 'not-synced', text: 'Not synced' };
}


function offlineShellNote() {
  if ('serviceWorker' in navigator) return '';
  return ' Offline app caching requires HTTPS or localhost; this browser cannot cache the app shell from this address.';
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
    // The last sync attempt's actual failure reason (syncProject() writes
    // it to IndexedDB's sync-state on every failure) - surfaced here so
    // it's checkable on a later page load too, not just live in
    // #sync-status the moment it happens.
    const lastErrorNote =
      info.state && info.state.status === 'error' && info.state.message ? ` (last attempt failed: ${info.state.message})` : '';
    pill.title = (info.lastSync ? `Last synced ${info.lastSync}` : 'This device has not synced this project yet.') + lastErrorNote;
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

// Combined mode's equivalent of loadFilters() - no single project name/sync
// pill, no revision filter (revisions don't merge across projects - every
// project just always shows its own current published set, same as single
// mode's default "All (current set)"), and the discipline list comes from
// whatever renderGrid() discovers in the merged sheets (see
// addMissingDisciplineOptions) rather than any one project's own
// discipline_prefix_map, since that can legitimately differ per project.
async function loadCombinedFilters() {
  document.getElementById('project-sync-pill').style.display = 'none';
  document.getElementById('revision-filter-wrap').style.display = 'none';
  document.getElementById('project-filter-wrap').style.display = '';

  const { projects } = await api('GET', '/api/projects');
  const idSet = new Set(combinedIds);
  const selected = projects.filter((p) => idSet.has(String(p.id)));
  combinedProjectNames = new Map(selected.map((p) => [String(p.id), p.name]));
  document.getElementById('project-name').textContent = selected.length
    ? `Combined view — ${selected.map((p) => p.name).join(', ')}`
    : 'Combined view';

  const projectSelect = document.getElementById('project-filter');
  for (const p of selected) {
    const opt = document.createElement('option');
    opt.value = String(p.id);
    opt.textContent = p.name;
    projectSelect.appendChild(opt);
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
  if (combinedMode && projectFilterValue) filtered = filtered.filter((s) => String(s.project_id) === projectFilterValue);
  const isMetadataMatch = (s) =>
    s.sheet_number.toLowerCase().includes(search) ||
    (s.title || '').toLowerCase().includes(search) ||
    (combinedMode && (s.project_name || '').toLowerCase().includes(search));
  if (search) {
    filtered = filtered.filter((s) => isMetadataMatch(s) || (contentMatchIds && contentMatchIds.has(s.sheet_id)));
  }
  filtered.sort((a, b) => {
    // A sheet whose own number/title names what you searched for (e.g. "Door
    // Schedule" matching the actual door schedule sheet) is almost always
    // what you're looking for, even if 20 other sheets mention the term
    // somewhere in their drawing content - surface those first.
    if (search) {
      const aMeta = isMetadataMatch(a);
      const bMeta = isMetadataMatch(b);
      if (aMeta !== bMeta) return aMeta ? -1 : 1;
    }
    return a.sheet_number.localeCompare(b.sheet_number);
  });
  lastFiltered = filtered;
  // Read by sheet.js to power the forward/back "cycle through the filtered
  // set" buttons next to the version dropdown - single-project concept only
  // (the key itself is scoped by projectId, which combined mode doesn't
  // have), so skipped there rather than writing a key nothing reads.
  if (!combinedMode) localStorage.setItem(filteredOrderKey(), JSON.stringify(filtered.map((s) => s.sheet_id)));

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
    if (!selectionMode) {
      // In combined mode, carry the origin project set along so sheet.html's
      // own "Sheets" sidebar link (see shell.js) returns to this combined
      // grid instead of just the one project this particular sheet is in.
      card.href = combinedMode
        ? `/sheet.html?projectId=${s.project_id}&sheetId=${s.sheet_id}&combinedProjectIds=${combinedProjectIds}`
        : `/sheet.html?projectId=${projectId}&sheetId=${s.sheet_id}`;
    }
    card.innerHTML = `
      ${selectionMode ? `<span class="card-checkbox"><input type="checkbox" tabindex="-1" ${selected ? 'checked' : ''}><span class="checkmark"></span></span>` : ''}
      <div class="thumb-wrap"><img src="${s.thumbSrc}" loading="lazy"></div>
      <div class="meta">
        <div class="sheet-number">${s.sheet_number}</div>
        <div class="sheet-title">${s.title || ''}</div>
        ${combinedMode ? `<div class="sheet-project-badge">${s.project_name || ''}</div>` : ''}
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

// Same scale presets sheet.js's STANDARD_SCALES offers when calibrating an
// ordinary sheet - duplicated rather than shared/exported since it's a small,
// stable, static list and this is the only other place it's needed.
const COMPOSITE_SCALE_OPTIONS = [
  { label: '1/16" = 1\'-0"', feetPerInch: 16 },
  { label: '1/8" = 1\'-0"', feetPerInch: 8 },
  { label: '3/16" = 1\'-0"', feetPerInch: 16 / 3 },
  { label: '1/4" = 1\'-0"', feetPerInch: 4 },
  { label: '3/8" = 1\'-0"', feetPerInch: 8 / 3 },
  { label: '1/2" = 1\'-0"', feetPerInch: 2 },
  { label: '3/4" = 1\'-0"', feetPerInch: 4 / 3 },
  { label: '1" = 1\'-0"', feetPerInch: 1 },
  { label: '1" = 10\'-0"', feetPerInch: 10 },
  { label: '1" = 20\'-0"', feetPerInch: 20 },
  { label: '1" = 30\'-0"', feetPerInch: 30 },
  { label: '1" = 40\'-0"', feetPerInch: 40 },
];

// "+ Composite" - a puzzle-piece-adjacent workspace for stitching crops of
// several existing sheets into one drawing dense enough to run take-offs on
// (see CLAUDE.md-adjacent composite-drawings plan). Injected next to
// #new-revision-btn the same non-invasive way setupSelectionToggleButton
// already adds "Download drawings" - shell.js itself is never touched.
function setupNewCompositeButton(me) {
  const canManage = me.role === 'admin' || me.role === 'editor';
  if (!canManage) return;
  const whoami = document.getElementById('whoami');
  const row = whoami ? whoami.parentElement : document.querySelector('#topbar > .row:last-child');
  if (!row || document.getElementById('new-composite-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'new-composite-btn';
  btn.type = 'button';
  btn.title = 'New composite drawing';
  btn.textContent = '▦ Composite';
  btn.addEventListener('click', openNewCompositeModal);
  const newRevBtn = document.getElementById('new-revision-btn');
  if (newRevBtn) newRevBtn.after(btn);
  else row.prepend(btn);
}

function openNewCompositeModal() {
  openModal(`
    <h2>New composite drawing</h2>
    <p class="muted">Stitch crops of existing sheets into one drawing you can run take-offs on - useful when the architect's overview plan is too low-detail but the useful detail is spread across several separate sheets.</p>
    <div class="field"><label>Name</label><input id="nc-name" placeholder="e.g. Composite Floor Plan"></div>
    <div class="field"><label>Tag</label><input id="nc-discipline" placeholder="Custom" value="Custom"></div>
    <div class="field">
      <label>Reference scale</label>
      <select id="nc-scale">
        ${COMPOSITE_SCALE_OPTIONS.map((s, i) => `<option value="${i}"${s.feetPerInch === 8 ? ' selected' : ''}>${s.label}</option>`).join('')}
      </select>
      <small class="muted">Every fragment you bring in gets resized to match this scale - it doesn't need to match any one source sheet.</small>
    </div>
    <p class="error" id="nc-error" style="display:none;"></p>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Cancel</button>
      <button class="primary" type="button" id="modal-create">Create</button>
    </div>
  `);
  document.getElementById('nc-name').focus();
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-create').addEventListener('click', async () => {
    const name = document.getElementById('nc-name').value.trim();
    const errEl = document.getElementById('nc-error');
    if (!name) {
      errEl.textContent = 'Name is required.';
      errEl.style.display = 'block';
      return;
    }
    const discipline = document.getElementById('nc-discipline').value.trim() || 'Custom';
    const scaleFeetPerInch = COMPOSITE_SCALE_OPTIONS[Number(document.getElementById('nc-scale').value)].feetPerInch;
    const createBtn = document.getElementById('modal-create');
    createBtn.disabled = true;
    createBtn.textContent = 'Creating...';
    try {
      const { sheet } = await api('POST', `/api/projects/${projectId}/composites`, {
        sheet_number: name,
        discipline,
        scale_feet_per_inch: scaleFeetPerInch,
      });
      closeModal();
      window.location.href = `/sheet.html?projectId=${projectId}&sheetId=${sheet.id}`;
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
      createBtn.disabled = false;
      createBtn.textContent = 'Create';
    }
  });
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

// Combined mode's data source - always live (no offline-store involvement,
// see the top-of-file note on why), one request per selected project fired
// in parallel and flattened into a single merged list, each sheet tagged
// with the project it actually belongs to.
async function renderFromCombinedLiveApi() {
  const results = await Promise.all(
    combinedIds.map((id) =>
      api('GET', `/api/projects/${id}/sheets`).then(({ sheets }) => ({ id, sheets }))
    )
  );
  const items = results.flatMap(({ id, sheets }) =>
    sheets.map((s) => ({
      sheet_id: s.id,
      sheet_number: s.sheet_number,
      discipline: s.discipline,
      revision_id: s.current_revision_id,
      title: s.current_title,
      thumbSrc: `/api/sheet-versions/${s.current_version_id}/thumb`,
      project_id: id,
      project_name: combinedProjectNames.get(id) || '',
    }))
  );
  renderGrid(items);
}

document.getElementById('project-filter').addEventListener('change', (e) => {
  projectFilterValue = e.target.value;
  renderGrid(lastItems);
});
document.getElementById('discipline-filter').addEventListener('change', () => {
  // Persisted per-project (not for combinedMode, where projectId is null) so
  // returning from a sheet - or any fresh page load - keeps the filter until
  // it's explicitly cleared back to "All", instead of resetting every visit.
  if (!combinedMode) {
    const value = document.getElementById('discipline-filter').value;
    if (value) localStorage.setItem(disciplineStorageKey(), value);
    else localStorage.removeItem(disciplineStorageKey());
  }
  if (combinedMode) renderGrid(lastItems);
  else renderFromCache();
});
document.getElementById('revision-filter').addEventListener('change', () => {
  if (combinedMode) renderGrid(lastItems); // unreachable in practice - the control is hidden in combined mode, see loadCombinedFilters
  else renderFromCache();
});
// Metadata (sheet number/title) filtering is client-side and instant - no
// need to re-hit cache/API on every keystroke like the dropdowns do. Drawing
// *content* search needs a server round-trip (full-text index), so it's
// debounced and unioned into the same filter once results land - see
// contentMatchIds above and renderGrid()'s use of it.
document.getElementById('search-filter').addEventListener('input', () => {
  const term = document.getElementById('search-filter').value.trim();
  renderGrid(lastItems); // immediate metadata-only pass

  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  if (!term) {
    contentMatchIds = null;
    localStorage.removeItem(searchStorageKey());
    return;
  }
  localStorage.setItem(searchStorageKey(), term);
  searchDebounceTimer = setTimeout(async () => {
    try {
      // Sheet ids are a global PK (not per-project), so the merged Set below
      // is safe without tagging which project each id came from.
      const idLists = combinedMode
        ? await Promise.all(
            combinedIds.map((id) =>
              api('GET', `/api/projects/${id}/sheets/search?q=${encodeURIComponent(term)}`).then((r) => r.sheet_ids)
            )
          )
        : [(await api('GET', `/api/projects/${projectId}/sheets/search?q=${encodeURIComponent(term)}`)).sheet_ids];
      // A stale response for an older keystroke shouldn't clobber a newer one.
      if (document.getElementById('search-filter').value.trim() !== term) return;
      contentMatchIds = new Set(idLists.flat());
      renderGrid(lastItems);
    } catch (err) {
      // Offline or search endpoint unavailable - the metadata-only pass
      // above already ran, so the grid still shows something useful.
    }
  }, 280);
});

// Combined mode's init - no offline cache/sync involvement at all (see the
// top-of-file note), no search-term persistence keyed by a single project,
// no per-project write actions (download-selection, composite creation).
// Just: the short combined sidebar (Sheets/Documents/Flags - see
// renderShell's combinedProjectIds branch), the merged filter set, and a
// live fetch.
async function initCombined(me) {
  document.getElementById('sync-status').style.display = 'none';
  await renderShell({
    topbarEl: document.getElementById('topbar'),
    sidebarEl: document.getElementById('sidebar'),
    projectId: undefined,
    combinedProjectIds,
    active: 'viewer',
    me,
  });
  await loadCombinedFilters();
  await renderFromCombinedLiveApi();
}

(async function init() {
  const me = await requireSession();
  if (!me) return;

  if (combinedMode) {
    await initCombined(me);
    return;
  }

  await renderShell({
    topbarEl: document.getElementById('topbar'),
    sidebarEl: document.getElementById('sidebar'),
    projectId,
    active: 'viewer',
    me,
  });
  setupSelectionToggleButton();
  setupNewCompositeButton(me);
  setupSelectionBar();

  const savedSearchTerm = localStorage.getItem(searchStorageKey());
  if (savedSearchTerm) {
    document.getElementById('search-filter').value = savedSearchTerm;
    document.getElementById('search-filter').dispatchEvent(new Event('input'));
  }

  try {
    await loadFilters();
    // Restore after loadFilters() has populated <option>s - setting .value
    // to something not yet in the list is silently ignored by the browser.
    const savedDiscipline = localStorage.getItem(disciplineStorageKey());
    if (savedDiscipline) document.getElementById('discipline-filter').value = savedDiscipline;
    await ensureProjectCacheFresh(projectId, currentProject || {});
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
    statusEl.textContent = 'Checking for updates...';
    updateProjectSyncPill({ status: 'syncing', text: 'Checking…' });
    const result = await syncProject(projectId, {
      onProgress: (done, total) => updateProjectSyncPill({ status: 'syncing', text: `Syncing ${done}/${total}` }),
    });
    // A per-sheet download failure (transient network blip, a timeout on a
    // large PDF) no longer aborts the rest of the batch - see
    // offline-store.js's syncProject - but it's still worth surfacing
    // rather than silently under-caching. It self-heals on the next sync
    // (a failed sheet is naturally retried, see that same comment), so this
    // is informational, not a hard error.
    const failedNote = result.failedSheetCount
      ? ` ${result.failedSheetCount} sheet(s) failed to download and will retry next sync.`
      : '';
    statusEl.textContent = result.sheetCount || result.markupCount
      ? `Synced ${result.sheetCount} sheet(s) and ${result.markupCount} markup update(s) at ${result.since}.${failedNote}${offlineShellNote()}`
      : `Already synced at ${result.since}.${failedNote}${offlineShellNote()}`;
    await renderFromCache();
    await updateProjectSyncPill();
  } catch (err) {
    // A thrown sync isn't necessarily an offline device - syncProject()
    // throws on a bad server response, an IndexedDB/OPFS error, etc. too,
    // and always claiming "Offline" for all of those buries the real reason
    // (which syncProject() already wrote to IndexedDB's sync-state, but
    // nothing was reading it back out - see getProjectSyncInfo/syncLabel).
    statusEl.textContent = navigator.onLine
      ? `Sync failed: ${err.message}${offlineShellNote()}`
      : `Offline - showing last synced data.${offlineShellNote()}`;
    await updateProjectSyncPill();
  }
})();
