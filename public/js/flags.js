import { renderShell, confirmModal, showToast } from '/js/shell.js';

const params = new URLSearchParams(window.location.search);
const projectId = params.get('projectId');
// "View Multiple" (see dashboard.js) - a comma-separated set of project ids
// instead of a single one means this is the combined-view flavor of this
// page: flags from every listed project, merged, each still linking back
// into its own real project (see goToUrl) rather than any of this being a
// real merged project.
const combinedProjectIds = params.get('projectIds');
const combinedMode = !!combinedProjectIds;

let allFlags = [];
let searchTerm = '';
let tagFilter = '';
let sortState = { column: 'location', dir: 'asc' };
let editingFlagId = null; // id of the flag row currently in edit mode, or null

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function goToUrl(flag) {
  // The combined endpoint annotates every flag with its real project_id
  // (see flagsCombined.routes.js) - the single-project endpoint doesn't
  // bother, since there's only ever the one project this page is already
  // scoped to, so this falls back to that.
  const flagProjectId = flag.project_id || projectId;
  return flag.location_type === 'document'
    ? `/document-view.html?documentId=${flag.target_document_id}&flagId=${flag.id}`
    : `/sheet.html?projectId=${flagProjectId}&sheetId=${flag.target_sheet_id}&flagId=${flag.id}`;
}

function locationLabel(flag) {
  const icon = flag.location_type === 'document' ? '&#128196; ' : '&#128208; ';
  return icon + escapeHtml(flag.location);
}

function allTags() {
  return [...new Set(allFlags.flatMap((f) => f.geometry.tags || []))].sort();
}

function ensureTagDatalist() {
  let dl = document.getElementById('flags-tag-options');
  if (!dl) {
    dl = document.createElement('datalist');
    dl.id = 'flags-tag-options';
    document.body.appendChild(dl);
  }
  dl.innerHTML = allTags()
    .map((t) => `<option value="${escapeHtml(t)}"></option>`)
    .join('');
}

function populateTagFilter() {
  const select = document.getElementById('flags-tag-filter');
  const current = select.value;
  const tags = allTags();
  select.innerHTML = '<option value="">All</option>' + tags.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  select.value = tags.includes(current) ? current : '';
  tagFilter = select.value;
}

async function loadFlags() {
  const { flags } = combinedMode
    ? await api('GET', `/api/flags/combined?projectIds=${combinedProjectIds}`)
    : await api('GET', `/api/projects/${projectId}/flags`);
  allFlags = flags;
  populateTagFilter();
  ensureTagDatalist();
  renderTable();
}

function visibleFlags() {
  let filtered = allFlags.slice();
  if (searchTerm) {
    filtered = filtered.filter(
      (f) =>
        (f.geometry.description || '').toLowerCase().includes(searchTerm) ||
        (f.geometry.comment || '').toLowerCase().includes(searchTerm) ||
        (f.geometry.tags || []).some((t) => t.toLowerCase().includes(searchTerm)) ||
        f.location.toLowerCase().includes(searchTerm) ||
        (combinedMode && (f.project_name || '').toLowerCase().includes(searchTerm))
    );
  }
  if (tagFilter) filtered = filtered.filter((f) => (f.geometry.tags || []).includes(tagFilter));
  filtered.sort((a, b) => {
    let cmp;
    if (sortState.column === 'tag') {
      cmp = (a.geometry.tags || []).join(', ').localeCompare((b.geometry.tags || []).join(', '));
    } else if (sortState.column === 'project') {
      cmp = (a.project_name || '').localeCompare(b.project_name || '') || a.location.localeCompare(b.location, undefined, { numeric: true });
    } else {
      cmp = a.location.localeCompare(b.location, undefined, { numeric: true });
    }
    return sortState.dir === 'asc' ? cmp : -cmp;
  });
  return filtered;
}

function renderSortHeaders() {
  document.getElementById('flags-sort-drawing').innerHTML =
    sortState.column === 'location' ? `Location ${sortState.dir === 'asc' ? '&#9662;' : '&#9652;'}` : 'Location';
  document.getElementById('flags-sort-tag').innerHTML = sortState.column === 'tag' ? `Tag ${sortState.dir === 'asc' ? '&#9662;' : '&#9652;'}` : 'Tag';
  if (combinedMode) {
    document.getElementById('flags-sort-project').innerHTML =
      sortState.column === 'project' ? `Project ${sortState.dir === 'asc' ? '&#9662;' : '&#9652;'}` : 'Project';
  }
}

function renderTable() {
  const flags = visibleFlags();
  const tbody = document.querySelector('#flags-table tbody');
  tbody.innerHTML = '';
  document.getElementById('flags-empty-msg').style.display = flags.length ? 'none' : '';
  document.getElementById('flags-empty-msg').textContent = searchTerm || tagFilter ? 'No flags match your filters.' : 'No flags yet.';

  for (const flag of flags) {
    const tr = document.createElement('tr');
    const created = flag.created_at ? new Date(flag.created_at).toLocaleDateString() : '';
    const editing = editingFlagId === flag.id;
    const url = goToUrl(flag);

    if (editing) {
      tr.innerHTML = `
        ${combinedMode ? `<td>${escapeHtml(flag.project_name || '')}</td>` : ''}
        <td><a href="${url}">${locationLabel(flag)}</a></td>
        <td><input type="text" class="flags-desc-input" style="width:100%;" value="${escapeHtml(flag.geometry.description || '')}"></td>
        <td><textarea class="flags-comment-input" rows="2" style="width:100%;">${escapeHtml(flag.geometry.comment || '')}</textarea></td>
        <td><input type="text" class="flags-tag-input" list="flags-tag-options" placeholder="Tags (comma-separated)" style="width:100%;" value="${escapeHtml((flag.geometry.tags || []).join(', '))}"></td>
        <td>${escapeHtml(flag.author_name)}</td>
        <td>${created}</td>
        <td class="row" style="gap:6px;">
          <button type="button" class="flags-save-btn">Save</button>
          <button type="button" class="flags-cancel-btn">Cancel</button>
          <button type="button" class="icon-btn flags-delete-btn" title="Delete flag">&#128465;</button>
        </td>`;
      tbody.appendChild(tr);

      const descInput = tr.querySelector('.flags-desc-input');
      const commentInput = tr.querySelector('.flags-comment-input');
      const tagInput = tr.querySelector('.flags-tag-input');
      tr.querySelector('.flags-save-btn').addEventListener('click', async () => {
        const tags = [...new Set(tagInput.value.split(',').map((t) => t.trim()).filter(Boolean))];
        const { markup } = await api('PATCH', `/api/markups/${flag.id}`, {
          geometry: { ...flag.geometry, description: descInput.value, comment: commentInput.value, tags },
        });
        flag.geometry = markup.geometry;
        editingFlagId = null;
        populateTagFilter();
        ensureTagDatalist();
        renderTable();
        showToast('Flag saved.', 'success');
      });
      tr.querySelector('.flags-cancel-btn').addEventListener('click', () => {
        editingFlagId = null;
        renderTable();
      });
    } else {
      tr.innerHTML = `
        ${combinedMode ? `<td>${escapeHtml(flag.project_name || '')}</td>` : ''}
        <td><a href="${url}">${locationLabel(flag)}</a></td>
        <td>${escapeHtml(flag.geometry.description || '')}</td>
        <td>${escapeHtml(flag.geometry.comment || '')}</td>
        <td>${(flag.geometry.tags || []).map((t) => `<span class="flags-tag-chip">${escapeHtml(t)}</span>`).join(' ')}</td>
        <td>${escapeHtml(flag.author_name)}</td>
        <td>${created}</td>
        <td class="row" style="gap:6px;">
          <button type="button" class="icon-btn flags-edit-btn" title="Edit">&#9998;</button>
          <button type="button" class="icon-btn flags-delete-btn" title="Delete flag">&#128465;</button>
        </td>`;
      tbody.appendChild(tr);

      tr.querySelector('.flags-edit-btn').addEventListener('click', () => {
        editingFlagId = flag.id;
        renderTable();
      });
    }

    tr.querySelector('.flags-delete-btn').addEventListener('click', async () => {
      const ok = await confirmModal({ title: 'Delete this flag?', confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      await api('DELETE', `/api/markups/${flag.id}`);
      allFlags = allFlags.filter((f) => f.id !== flag.id);
      if (editingFlagId === flag.id) editingFlagId = null;
      populateTagFilter();
      ensureTagDatalist();
      renderTable();
    });
  }
}

function setSort(column) {
  if (sortState.column === column) sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
  else sortState = { column, dir: 'asc' };
  renderSortHeaders();
  renderTable();
}

function setupControls() {
  document.getElementById('flags-search').addEventListener('input', (e) => {
    searchTerm = e.target.value.trim().toLowerCase();
    renderTable();
  });
  document.getElementById('flags-tag-filter').addEventListener('change', (e) => {
    tagFilter = e.target.value;
    renderTable();
  });
  document.getElementById('flags-sort-drawing').addEventListener('click', () => setSort('location'));
  document.getElementById('flags-sort-tag').addEventListener('click', () => setSort('tag'));
  if (combinedMode) document.getElementById('flags-sort-project').addEventListener('click', () => setSort('project'));
  renderSortHeaders();
}

async function setupCombinedHeader() {
  document.getElementById('sidebar').style.display = 'none';
  document.getElementById('flags-sort-project').style.display = '';
  const ids = new Set(combinedProjectIds.split(',').map((s) => s.trim()));
  try {
    const { projects } = await api('GET', '/api/projects');
    const names = projects.filter((p) => ids.has(String(p.id))).map((p) => p.name);
    document.getElementById('flags-title').textContent = 'Flags — Combined view';
    document.getElementById('flags-subtitle').textContent = names.length
      ? `Every flagged item across: ${names.join(', ')}.`
      : "Every flagged item across the projects you're viewing.";
  } catch (err) {
    document.getElementById('flags-title').textContent = 'Flags — Combined view';
  }
}

(async function init() {
  const me = await requireSession();
  if (!me) return;
  // Combined mode has no single project, so none of the shell's
  // per-project sidebar links (Sheets/Documents/Revisions/...) apply here -
  // this page skips the sidebar entirely (see setupCombinedHeader) rather
  // than showing links that would 404 on a missing projectId.
  await renderShell({
    topbarEl: document.getElementById('topbar'),
    sidebarEl: combinedMode ? undefined : document.getElementById('sidebar'),
    projectId: combinedMode ? undefined : projectId,
    active: 'flags',
    me,
  });
  if (combinedMode) await setupCombinedHeader();
  setupControls();
  await loadFlags();
})();
