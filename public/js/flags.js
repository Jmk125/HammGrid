import { renderShell, confirmModal } from '/js/shell.js';

const projectId = new URLSearchParams(window.location.search).get('projectId');

let allFlags = [];
let searchTerm = '';
let tagFilter = '';
let sortState = { column: 'drawing', dir: 'asc' };
let editingFlagId = null; // id of the flag row currently in edit mode, or null

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function allTags() {
  return [...new Set(allFlags.map((f) => f.geometry.tag).filter(Boolean))].sort();
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
  const { flags } = await api('GET', `/api/projects/${projectId}/flags`);
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
        (f.geometry.tag || '').toLowerCase().includes(searchTerm) ||
        f.sheet_number.toLowerCase().includes(searchTerm)
    );
  }
  if (tagFilter) filtered = filtered.filter((f) => f.geometry.tag === tagFilter);
  filtered.sort((a, b) => {
    let cmp;
    if (sortState.column === 'tag') {
      cmp = (a.geometry.tag || '').localeCompare(b.geometry.tag || '');
    } else {
      cmp = a.sheet_number.localeCompare(b.sheet_number, undefined, { numeric: true });
    }
    return sortState.dir === 'asc' ? cmp : -cmp;
  });
  return filtered;
}

function renderSortHeaders() {
  document.getElementById('flags-sort-drawing').innerHTML =
    sortState.column === 'drawing' ? `Drawing ${sortState.dir === 'asc' ? '&#9662;' : '&#9652;'}` : 'Drawing';
  document.getElementById('flags-sort-tag').innerHTML = sortState.column === 'tag' ? `Tag ${sortState.dir === 'asc' ? '&#9662;' : '&#9652;'}` : 'Tag';
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
    const goToUrl = `/sheet.html?projectId=${projectId}&sheetId=${flag.sheet_id}&flagId=${flag.id}`;

    if (editing) {
      tr.innerHTML = `
        <td><a href="${goToUrl}">${escapeHtml(flag.sheet_number)}</a></td>
        <td><input type="text" class="flags-desc-input" style="width:100%;" value="${escapeHtml(flag.geometry.description || '')}"></td>
        <td><textarea class="flags-comment-input" rows="2" style="width:100%;">${escapeHtml(flag.geometry.comment || '')}</textarea></td>
        <td><input type="text" class="flags-tag-input" list="flags-tag-options" style="width:100%;" value="${escapeHtml(flag.geometry.tag || '')}"></td>
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
        const tag = tagInput.value.trim() || null;
        const { markup } = await api('PATCH', `/api/markups/${flag.id}`, {
          geometry: { ...flag.geometry, description: descInput.value, comment: commentInput.value, tag },
        });
        flag.geometry = markup.geometry;
        editingFlagId = null;
        populateTagFilter();
        ensureTagDatalist();
        renderTable();
      });
      tr.querySelector('.flags-cancel-btn').addEventListener('click', () => {
        editingFlagId = null;
        renderTable();
      });
    } else {
      tr.innerHTML = `
        <td><a href="${goToUrl}">${escapeHtml(flag.sheet_number)}</a></td>
        <td>${escapeHtml(flag.geometry.description || '')}</td>
        <td>${escapeHtml(flag.geometry.comment || '')}</td>
        <td>${flag.geometry.tag ? `<span class="flags-tag-chip">${escapeHtml(flag.geometry.tag)}</span>` : ''}</td>
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
  document.getElementById('flags-sort-drawing').addEventListener('click', () => setSort('drawing'));
  document.getElementById('flags-sort-tag').addEventListener('click', () => setSort('tag'));
  renderSortHeaders();
}

(async function init() {
  const me = await requireSession();
  if (!me) return;
  await renderShell({
    topbarEl: document.getElementById('topbar'),
    sidebarEl: document.getElementById('sidebar'),
    projectId,
    active: 'flags',
    me,
  });
  setupControls();
  await loadFlags();
})();
