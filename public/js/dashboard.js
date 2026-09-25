import { getProjectSyncInfo, cacheProjectList, getCachedProjectList } from '/js/offline-store.js';
import { openModal, closeModal, checkPendingJobs, renderNetworkIndicator, renderUserMenu, applyTheme } from '/js/shell.js';

let me;

// "View Multiple" (see spawn of the combined-flags feature) - lets several
// related-but-separate projects (e.g. four demo packages for the same school
// district) be reviewed as one merged Flags list without actually merging
// them as projects. Purely a client-side selection; nothing persists.
let selectionMode = false;
let selectedProjectIds = new Set();
let lastProjects = [];

// Which list the grid shows. Kept in the URL (?view=archived) rather than
// state, so going into an archived project and hitting Back returns to the
// archived list instead of snapping back to Current.
let view = new URLSearchParams(window.location.search).get('view') === 'archived' ? 'archived' : 'current';

function renderTopbar() {
  applyTheme(me.settings);
  const topbar = document.getElementById('topbar');
  topbar.innerHTML = `
    <a class="brand" href="/dashboard.html">HammGrid</a>
    <div class="row topbar-actions">
      <button id="view-multiple-btn" type="button">View Multiple</button>
      ${me.role === 'admin' ? '<button id="new-project-btn" type="button">New Project</button>' : ''}
      <div id="user-menu-slot"></div>
    </div>
  `;
  renderUserMenu(topbar.querySelector('#user-menu-slot'), me);
  renderNetworkIndicator(topbar.querySelector('.topbar-actions'));
  const newBtn = topbar.querySelector('#new-project-btn');
  if (newBtn) newBtn.addEventListener('click', openNewProjectModal);
  topbar.querySelector('#view-multiple-btn').addEventListener('click', () => setSelectionMode(true));
}

function openNewProjectModal() {
  openModal(`
    <h2>New project</h2>
    <div class="segmented" id="np-mode" style="margin-bottom:14px;">
      <button type="button" data-mode="blank" class="active">Blank project</button>
      <button type="button" data-mode="import">Import from&hellip;</button>
    </div>
    <div id="np-blank">
      <div class="field"><label>Name</label><input id="np-name" placeholder="e.g. Lincoln Elementary"></div>
      <div class="field"><label>Job number (optional)</label><input id="np-number"></div>
      <div class="field"><label>Location (optional)</label><input id="np-location" placeholder="e.g. Columbus, OH"></div>
      <div class="field"><label>Size (optional)</label><input id="np-size" placeholder="e.g. 45,000 SF"></div>
    </div>
    <div id="np-import" style="display:none;">
      <div class="field">
        <label>Import from</label>
        <select id="np-source"><option value="">Loading&hellip;</option></select>
      </div>
      <p class="muted">Creates a new project with the source job's sheets and take-offs. You'll pick the job and
        review what will be imported before anything is created.</p>
    </div>
    <p class="error" id="np-error" style="display:none;"></p>
    <div class="modal-actions">
      <button type="button" id="np-cancel">Cancel</button>
      <button class="primary" type="button" id="np-create">Create</button>
    </div>
  `);
  const errEl = document.getElementById('np-error');
  const showError = (msg) => {
    errEl.textContent = msg;
    errEl.style.display = msg ? 'block' : 'none';
  };
  let mode = 'blank';
  let sourcesLoaded = false;

  async function loadSources() {
    sourcesLoaded = true;
    const select = document.getElementById('np-source');
    try {
      const { sources } = await api('GET', '/api/imports/sources');
      select.innerHTML = sources
        .map((s) => `<option value="${s.id}" ${s.configured ? '' : 'disabled'}>${s.label}${s.configured ? '' : ' (not configured)'}</option>`)
        .join('');
      const firstEnabled = sources.find((s) => s.configured);
      if (firstEnabled) select.value = firstEnabled.id;
      else showError('No import source is configured on this server.');
    } catch (err) {
      select.innerHTML = '';
      showError(`Couldn't load import sources: ${err.message}`);
    }
  }

  for (const btn of document.querySelectorAll('#np-mode button')) {
    btn.addEventListener('click', () => {
      mode = btn.dataset.mode;
      for (const b of document.querySelectorAll('#np-mode button')) b.classList.toggle('active', b === btn);
      document.getElementById('np-blank').style.display = mode === 'blank' ? '' : 'none';
      document.getElementById('np-import').style.display = mode === 'import' ? '' : 'none';
      document.getElementById('np-create').textContent = mode === 'blank' ? 'Create' : 'Continue';
      showError('');
      if (mode === 'import' && !sourcesLoaded) loadSources();
    });
  }

  document.getElementById('np-cancel').addEventListener('click', closeModal);
  document.getElementById('np-create').addEventListener('click', async () => {
    if (mode === 'import') {
      const source = document.getElementById('np-source').value;
      if (!source) return showError('Pick an import source.');
      window.location.href = `/import.html?source=${encodeURIComponent(source)}`;
      return;
    }
    const name = document.getElementById('np-name').value.trim();
    if (!name) return showError('Name is required.');
    const { project } = await api('POST', '/api/projects', {
      name,
      number: document.getElementById('np-number').value || null,
      location: document.getElementById('np-location').value || null,
      size: document.getElementById('np-size').value || null,
    });
    closeModal();
    window.location.href = `/viewer.html?projectId=${project.id}`;
  });
}

function syncLabel(info) {
  if (!navigator.onLine) return { status: 'offline', text: info.cachedSheetCount ? 'Offline · cached' : 'Offline · not synced' };
  if (info.status === 'syncing') return { status: 'syncing', text: 'Syncing…' };
  if (info.status === 'synced') return { status: 'synced', text: 'Synced' };
  if (info.status === 'needs-sync') return { status: 'needs-sync', text: 'Needs sync' };
  if (info.status === 'empty') return { status: 'empty', text: 'No drawings' };
  return { status: 'not-synced', text: 'Not synced' };
}

async function updateProjectCardSync(card, project) {
  const pill = card.querySelector('.sync-pill');
  try {
    const info = await getProjectSyncInfo(project.id, project);
    const label = syncLabel(info);
    pill.className = `sync-pill ${label.status}`;
    pill.textContent = label.text;
    pill.title = info.lastSync ? `Last synced ${info.lastSync}` : 'This device has not synced this project yet.';
  } catch (err) {
    pill.className = 'sync-pill not-synced';
    pill.textContent = 'Sync unknown';
  }
}

let lastOffline = false;

async function setProjectArchived(project, archived) {
  try {
    await api('POST', `/api/projects/${project.id}/${archived ? 'archive' : 'unarchive'}`);
  } catch (err) {
    alert(`Couldn't ${archived ? 'archive' : 'restore'} "${project.name}": ${err.message}`);
    return;
  }
  // Reload rather than patching lastProjects in place so the offline cache
  // (cacheProjectList) also picks up the new archived_at.
  await loadProjects();
}

function setView(next) {
  if (next === view) return;
  view = next;
  const url = new URL(window.location.href);
  if (view === 'archived') url.searchParams.set('view', 'archived');
  else url.searchParams.delete('view');
  window.history.replaceState(null, '', url);
  // A selection made in one list would be invisible (but still counted) in
  // the other, so start fresh.
  selectedProjectIds.clear();
  renderProjectGrid();
}

function setupViewToggle() {
  for (const btn of document.querySelectorAll('#project-view-toggle button')) {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  }
}

function renderProjectGrid() {
  const archivedCount = lastProjects.filter((p) => p.archived_at).length;
  const projects = lastProjects.filter((p) => !!p.archived_at === (view === 'archived'));
  for (const btn of document.querySelectorAll('#project-view-toggle button')) {
    const isArchivedBtn = btn.dataset.view === 'archived';
    btn.classList.toggle('active', btn.dataset.view === view);
    btn.textContent = isArchivedBtn && archivedCount ? `Archived (${archivedCount})` : isArchivedBtn ? 'Archived' : 'Current';
  }
  const grid = document.getElementById('project-grid');
  grid.innerHTML = '';
  const emptyMsg = document.getElementById('empty-msg');
  emptyMsg.style.display = projects.length ? 'none' : '';
  emptyMsg.textContent =
    lastOffline && lastProjects.length === 0
      ? 'No projects cached for offline use yet - open the dashboard once while online first.'
      : view === 'archived'
        ? 'No archived projects.'
        : 'No projects yet.';

  const archivedView = view === 'archived';
  // Admin-only (matches the server), and hidden offline / in selection mode
  // where a stray tap on it would be confusing or just fail.
  const canArchive = me.role === 'admin' && !selectionMode && !lastOffline;
  for (const p of projects) {
    const selected = selectedProjectIds.has(p.id);
    // Selection mode swaps the card from a navigating <a> to a
    // non-navigating <div>, same treatment as viewer.js's sheet cards -
    // simpler than suppressing the <a>'s default click, and avoids any
    // chance of a stray navigation on touch.
    const a = document.createElement(selectionMode ? 'div' : 'a');
    a.className = 'project-card' + (selectionMode ? ' selectable' : '') + (selected ? ' selected' : '');
    if (!selectionMode) a.href = `/viewer.html?projectId=${p.id}`;
    const metaParts = [p.number, p.location, p.size].filter(Boolean).join(' &middot; ');
    a.innerHTML = `
      ${selectionMode ? `<span class="card-checkbox"><input type="checkbox" tabindex="-1" ${selected ? 'checked' : ''}><span class="checkmark"></span></span>` : ''}
      <div class="thumb-wrap">
        ${p.first_thumbnail_url ? `<img src="${p.first_thumbnail_url}">` : '<span class="placeholder">No drawings yet</span>'}
      </div>
      <div class="body">
        <div class="project-name">${p.name}</div>
        <div class="project-meta">${metaParts}</div>
        <div class="card-footer">
          <span class="sync-pill syncing">Checking sync…</span>
          ${canArchive ? `<button type="button" class="card-archive-btn">${archivedView ? 'Make current' : 'Archive'}</button>` : ''}
        </div>
      </div>`;
    // The card is an <a> outside selection mode, so the button has to stop
    // the click from also navigating into the project.
    const archiveBtn = a.querySelector('.card-archive-btn');
    if (archiveBtn) {
      archiveBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setProjectArchived(p, !archivedView);
      });
    }
    // The thumbnail itself isn't cached (only the project list entry is -
    // see cacheProjectList) - a broken-image icon offline is uglier than
    // just falling back to the same placeholder an actually-empty project
    // already shows, so swap to that instead of leaving it broken.
    const img = a.querySelector('.thumb-wrap img');
    if (img) {
      img.addEventListener('error', () => {
        const placeholder = document.createElement('span');
        placeholder.className = 'placeholder';
        placeholder.textContent = 'No drawings yet';
        img.replaceWith(placeholder);
      });
    }
    if (selectionMode) {
      a.addEventListener('click', () => toggleProjectSelection(p.id, a));
    }
    grid.appendChild(a);
    updateProjectCardSync(a, p);
  }
  if (selectionMode) updateProjectSelectionBar();
}

async function loadProjects() {
  try {
    ({ projects: lastProjects } = await api('GET', '/api/projects'));
    await cacheProjectList(lastProjects);
    lastOffline = false;
  } catch (err) {
    // No network (or the request otherwise failed) - fall back to whatever
    // was cached the last time this succeeded online. If this device has
    // never loaded the dashboard online at all, this is just an empty
    // list - see the empty-msg wording below for why that's called out
    // separately from "you genuinely have zero projects".
    lastOffline = true;
    lastProjects = await getCachedProjectList();
  }
  renderProjectGrid();
}

function toggleProjectSelection(projectId, cardEl) {
  const nowSelected = !selectedProjectIds.has(projectId);
  if (nowSelected) selectedProjectIds.add(projectId);
  else selectedProjectIds.delete(projectId);
  cardEl.classList.toggle('selected', nowSelected);
  cardEl.querySelector('input[type="checkbox"]').checked = nowSelected;
  updateProjectSelectionBar();
}

function updateProjectSelectionBar() {
  const count = selectedProjectIds.size;
  document.getElementById('project-selection-count').textContent = count === 1 ? '1 selected' : `${count} selected`;
  document.getElementById('project-selection-view-btn').disabled = count === 0;
}

function setSelectionMode(on) {
  selectionMode = on;
  document.getElementById('project-selection-bar').style.display = on ? '' : 'none';
  if (!on) selectedProjectIds.clear();
  renderProjectGrid();
}

function setupProjectSelectionBar() {
  document.getElementById('project-selection-cancel-btn').addEventListener('click', () => setSelectionMode(false));
  document.getElementById('project-selection-view-btn').addEventListener('click', () => {
    if (selectedProjectIds.size === 0) return;
    window.location.href = `/viewer.html?projectIds=${[...selectedProjectIds].join(',')}`;
  });
}

(async function init() {
  me = await requireSession();
  if (!me) return;
  renderTopbar();
  setupProjectSelectionBar();
  setupViewToggle();
  await loadProjects();
  checkPendingJobs();
})();
