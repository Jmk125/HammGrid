import { syncProject, getCachedSheets, getCachedAsset } from '/js/offline-store.js';
import { renderShell } from '/js/shell.js';

const projectId = new URLSearchParams(window.location.search).get('projectId');

async function loadFilters() {
  const { project } = await api('GET', `/api/projects/${projectId}`);
  document.getElementById('project-name').textContent = project.name;

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

function renderGrid(items) {
  lastItems = items;
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

  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  document.getElementById('empty-msg').style.display = filtered.length ? 'none' : '';

  for (const s of filtered) {
    const a = document.createElement('a');
    a.className = 'sheet-card';
    a.href = `/sheet.html?projectId=${projectId}&sheetId=${s.sheet_id}`;
    a.innerHTML = `
      <div class="thumb-wrap"><img src="${s.thumbSrc}" loading="lazy"></div>
      <div class="meta">
        <div class="sheet-number">${s.sheet_number}</div>
        <div class="sheet-title">${s.title || ''}</div>
      </div>`;
    grid.appendChild(a);
  }
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
    const result = await syncProject(projectId);
    statusEl.textContent = `Synced ${result.sheetCount} sheet(s) at ${result.since}.`;
    await renderFromCache();
  } catch (err) {
    statusEl.textContent = 'Offline - showing last synced data.';
  }
})();
