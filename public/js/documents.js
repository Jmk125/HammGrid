import { renderShell, openModal, closeModal, showToast } from '/js/shell.js';

const projectId = new URLSearchParams(window.location.search).get('projectId');
let currentUser = null;
let folders = [];
let documents = [];
let currentFolderId = folderIdFromUrl();

function folderIdFromUrl() {
  const v = new URLSearchParams(window.location.search).get('folderId');
  return v ? Number(v) : null;
}

function setFolder(folderId, push) {
  currentFolderId = folderId;
  const url = new URL(window.location.href);
  if (folderId) url.searchParams.set('folderId', folderId);
  else url.searchParams.delete('folderId');
  if (push) history.pushState({ folderId }, '', url);
  render();
}

window.addEventListener('popstate', () => {
  currentFolderId = folderIdFromUrl();
  render();
});

function escapeHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function formatDateTime(s) {
  if (!s) return '';
  return new Date(s.replace(' ', 'T') + 'Z').toLocaleString();
}

async function loadAll() {
  const [f, d] = await Promise.all([
    api('GET', `/api/projects/${projectId}/documents/folders`),
    api('GET', `/api/projects/${projectId}/documents`),
  ]);
  folders = f.folders;
  documents = d.documents;
}

function renderBreadcrumb() {
  const path = [];
  let f = currentFolderId;
  while (f) {
    const folder = folders.find((x) => x.id === f);
    if (!folder) break;
    path.unshift(folder);
    f = folder.parent_folder_id;
  }
  const el = document.getElementById('breadcrumb');
  el.innerHTML =
    `<a href="#" data-folder="">Documents</a>` +
    path.map((p) => `<span class="sep">/</span><a href="#" data-folder="${p.id}">${escapeHtml(p.name)}</a>`).join('');
  el.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      setFolder(a.dataset.folder ? Number(a.dataset.folder) : null, true);
    });
  });
}

function renderTable() {
  const canManage = currentUser.role === 'admin' || currentUser.role === 'editor';
  const tbody = document.querySelector('#doc-table tbody');
  tbody.innerHTML = '';

  const childFolders = folders
    .filter((f) => (f.parent_folder_id || null) === currentFolderId)
    .sort((a, b) => a.name.localeCompare(b.name));
  const childDocs = documents
    .filter((d) => (d.folder_id || null) === currentFolderId)
    .sort((a, b) => a.name.localeCompare(b.name));

  document.getElementById('empty-msg').style.display = childFolders.length || childDocs.length ? 'none' : '';

  for (const f of childFolders) {
    const tr = document.createElement('tr');
    tr.className = 'doc-row-folder';
    tr.innerHTML = `
      <td><svg viewBox="0 0 20 20" class="doc-icon"><path d="M2 5a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5z" fill="currentColor"/></svg></td>
      <td class="doc-row-name"><a href="#" class="folder-link">${escapeHtml(f.name)}</a></td>
      <td></td><td></td><td></td>
      <td>${canManage ? '<button class="danger folder-delete">Delete</button>' : ''}</td>
    `;
    tr.querySelector('.folder-link').addEventListener('click', (e) => {
      e.preventDefault();
      setFolder(f.id, true);
    });
    const delBtn = tr.querySelector('.folder-delete');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        if (!confirm(`Delete folder "${f.name}" and everything inside it? This cannot be undone.`)) return;
        try {
          await api('DELETE', `/api/document-folders/${f.id}`);
          await loadAll();
          render();
        } catch (err) {
          alert(err.message);
        }
      });
    }
    tbody.appendChild(tr);
  }

  for (const d of childDocs) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><svg viewBox="0 0 20 20" class="doc-icon"><path d="M5 2h7l4 4v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M12 2v4h4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg></td>
      <td class="doc-row-name"><a href="/document-view.html?documentId=${d.id}" target="_blank">${escapeHtml(d.name)}</a></td>
      <td>${escapeHtml(d.revision_name) || '<span class="muted">Original</span>'}</td>
      <td>${escapeHtml(d.issue_date) || ''}</td>
      <td class="muted">${formatDateTime(d.version_created_at)}</td>
      <td class="row" style="gap:6px; flex-wrap:nowrap;">
        <button class="versions-btn">Versions</button>
        ${canManage ? '<button class="issue-rev-btn">Issue revision</button>' : ''}
        ${canManage ? '<button class="danger doc-delete-btn">Delete</button>' : ''}
      </td>
    `;
    tr.querySelector('.versions-btn').addEventListener('click', () => openVersionsModal(d));
    const issueBtn = tr.querySelector('.issue-rev-btn');
    if (issueBtn) issueBtn.addEventListener('click', () => openIssueRevisionModal(d));
    const delBtn = tr.querySelector('.doc-delete-btn');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        if (!confirm(`Delete "${d.name}" and all its revisions? This cannot be undone.`)) return;
        try {
          await api('DELETE', `/api/documents/${d.id}`);
          await loadAll();
          render();
        } catch (err) {
          alert(err.message);
        }
      });
    }
    tbody.appendChild(tr);
  }
}

async function openVersionsModal(d) {
  const { versions } = await api('GET', `/api/documents/${d.id}`);
  openModal(`
    <h2>${escapeHtml(d.name)} — versions</h2>
    <div class="doc-picker-list">
      ${versions
        .map(
          (v) => `
        <div class="doc-picker-row" style="cursor:default;">
          <span style="flex:1;">
            <b>${escapeHtml(v.revision_name) || 'Original'}</b>
            <span class="muted">${v.issue_date ? ' — issued ' + escapeHtml(v.issue_date) : ''}${v.uploaded_by_name ? ' — uploaded by ' + escapeHtml(v.uploaded_by_name) : ''} — ${formatDateTime(v.created_at)}</span>
          </span>
          <a href="/api/document-versions/${v.id}/pdf" target="_blank">View</a>
        </div>`
        )
        .join('')}
    </div>
    <div class="modal-actions"><button type="button" id="modal-cancel">Close</button></div>
  `);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
}

function openIssueRevisionModal(d) {
  openModal(`
    <h2>Issue revision — ${escapeHtml(d.name)}</h2>
    <div class="field"><label>Revision name</label><input id="modal-rev-name" placeholder="e.g. Rev A, Issued for Construction"></div>
    <div class="field"><label>Issue date</label><input id="modal-rev-date" type="date"></div>
    <div class="field"><label>File</label><input id="modal-rev-file" type="file" accept="application/pdf"></div>
    <p class="error" id="modal-error" style="display:none;"></p>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Cancel</button>
      <button class="primary" type="button" id="modal-issue">Issue</button>
    </div>
  `);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-issue').addEventListener('click', async () => {
    const file = document.getElementById('modal-rev-file').files[0];
    const errEl = document.getElementById('modal-error');
    if (!file) {
      errEl.textContent = 'A file is required.';
      errEl.style.display = 'block';
      return;
    }
    const fd = new FormData();
    fd.append('revision_name', document.getElementById('modal-rev-name').value);
    fd.append('issue_date', document.getElementById('modal-rev-date').value);
    fd.append('file', file);
    const res = await fetch(`/api/projects/${projectId}/documents/${d.id}/versions`, { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error;
      errEl.style.display = 'block';
      return;
    }
    closeModal();
    showToast(`New revision issued for "${d.name}".`, 'success');
    await loadAll();
    render();
  });
}

function openNewFolderModal() {
  openModal(`
    <h2>New folder</h2>
    <div class="field"><label>Name</label><input id="modal-folder-name" placeholder="e.g. Submittals, Progress Photos"></div>
    <p class="error" id="modal-error" style="display:none;"></p>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Cancel</button>
      <button class="primary" type="button" id="modal-create">Create</button>
    </div>
  `);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-create').addEventListener('click', async () => {
    const name = document.getElementById('modal-folder-name').value.trim();
    const errEl = document.getElementById('modal-error');
    if (!name) {
      errEl.textContent = 'Name is required.';
      errEl.style.display = 'block';
      return;
    }
    await api('POST', `/api/projects/${projectId}/documents/folders`, {
      name,
      parent_folder_id: currentFolderId,
    });
    closeModal();
    await loadAll();
    render();
  });
}

function openUploadModal() {
  openModal(`
    <h2>Upload document</h2>
    <div class="field"><label>Name</label><input id="modal-doc-name" placeholder="e.g. RFI-042 - Beam size at gridline C"></div>
    <div class="field"><label>Issue date (optional)</label><input id="modal-doc-date" type="date"></div>
    <div class="field"><label>File</label><input id="modal-doc-file" type="file" accept="application/pdf"></div>
    <p class="error" id="modal-error" style="display:none;"></p>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Cancel</button>
      <button class="primary" type="button" id="modal-upload">Upload</button>
    </div>
  `);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  const fileInput = document.getElementById('modal-doc-file');
  const nameInput = document.getElementById('modal-doc-name');
  fileInput.addEventListener('change', () => {
    if (!nameInput.value && fileInput.files[0]) {
      nameInput.value = fileInput.files[0].name.replace(/\.pdf$/i, '');
    }
  });
  document.getElementById('modal-upload').addEventListener('click', async () => {
    const file = fileInput.files[0];
    const errEl = document.getElementById('modal-error');
    const name = nameInput.value.trim();
    if (!file || !name) {
      errEl.textContent = 'Name and file are both required.';
      errEl.style.display = 'block';
      return;
    }
    const fd = new FormData();
    fd.append('name', name);
    fd.append('issue_date', document.getElementById('modal-doc-date').value);
    if (currentFolderId) fd.append('folder_id', currentFolderId);
    fd.append('file', file);
    const res = await fetch(`/api/projects/${projectId}/documents`, { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error;
      errEl.style.display = 'block';
      return;
    }
    closeModal();
    showToast(`"${name}" uploaded.`, 'success');
    await loadAll();
    render();
  });
}

function render() {
  renderBreadcrumb();
  renderTable();
}

document.getElementById('new-folder-btn').addEventListener('click', openNewFolderModal);
document.getElementById('upload-btn').addEventListener('click', openUploadModal);

(async function init() {
  currentUser = await requireSession();
  if (!currentUser) return;
  await renderShell({
    topbarEl: document.getElementById('topbar'),
    sidebarEl: document.getElementById('sidebar'),
    projectId,
    active: 'documents',
    me: currentUser,
  });
  if (currentUser.role === 'admin' || currentUser.role === 'editor') {
    document.getElementById('doc-actions').style.display = '';
  }
  await loadAll();
  render();
})();
