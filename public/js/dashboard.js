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
    <div class="field"><label>Name</label><input id="np-name" placeholder="e.g. Lincoln Elementary"></div>
    <div class="field"><label>Job number (optional)</label><input id="np-number"></div>
    <div class="field"><label>Location (optional)</label><input id="np-location" placeholder="e.g. Columbus, OH"></div>
    <div class="field"><label>Size (optional)</label><input id="np-size" placeholder="e.g. 45,000 SF"></div>
    <p class="error" id="np-error" style="display:none;"></p>
    <div class="modal-actions">
      <button type="button" id="np-cancel">Cancel</button>
      <button class="primary" type="button" id="np-create">Create</button>
    </div>
  `);
  document.getElementById('np-cancel').addEventListener('click', closeModal);
  document.getElementById('np-create').addEventListener('click', async () => {
    const name = document.getElementById('np-name').value.trim();
    if (!name) {
      const err = document.getElementById('np-error');
      err.textContent = 'Name is required.';
      err.style.display = 'block';
      return;
    }
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

function renderProjectGrid() {
  const projects = lastProjects;
  const grid = document.getElementById('project-grid');
  grid.innerHTML = '';
  const emptyMsg = document.getElementById('empty-msg');
  emptyMsg.style.display = projects.length ? 'none' : '';
  emptyMsg.textContent =
    lastOffline && projects.length === 0
      ? 'No projects cached for offline use yet - open the dashboard once while online first.'
      : 'No projects yet.';

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
        <span class="sync-pill syncing">Checking sync…</span>
      </div>`;
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
  await loadProjects();
  checkPendingJobs();
})();
