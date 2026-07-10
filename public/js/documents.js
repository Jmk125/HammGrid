import { renderShell, openModal, closeModal, showToast } from '/js/shell.js';

const TRASH_ICON =
  '<svg viewBox="0 0 20 20"><path d="M4 6h12M8 6V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2m-7 0 .7 10.5A1 1 0 0 0 6.7 17h6.6a1 1 0 0 0 1-1.5L15 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const projectId = new URLSearchParams(window.location.search).get('projectId');
let currentUser = null;
let folders = [];
let documents = [];
let currentFolderId = folderIdFromUrl();
let editMode = false;

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
    tr.dataset.folderId = f.id;
    tr.innerHTML = `
      <td><svg viewBox="0 0 20 20" class="doc-icon"><path d="M2 5a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5z" fill="currentColor"/></svg></td>
      <td class="doc-row-name"><a href="#" class="folder-link">${escapeHtml(f.name)}</a></td>
      <td></td><td></td><td></td><td></td>
      <td>${canManage && editMode ? `<button class="row-delete-icon-btn folder-delete" title="Delete folder">${TRASH_ICON}</button>` : ''}</td>
    `;
    tr.querySelector('.folder-link').addEventListener('click', (e) => {
      e.preventDefault();
      setFolder(f.id, true);
    });
    const delBtn = tr.querySelector('.folder-delete');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        const { linked_markup_count } = await api('GET', `/api/document-folders/${f.id}/links`);
        const warning =
          linked_markup_count > 0
            ? ` ${linked_markup_count} markup(s) on drawings link to documents inside it - those links will be removed too.`
            : '';
        if (!confirm(`Delete folder "${f.name}" and everything inside it? This cannot be undone.${warning}`)) return;
        await api('DELETE', `/api/document-folders/${f.id}`);
        await loadAll();
        render();
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
      <td>${d.linked_sheet_count > 0 ? `<button class="link-btn">${d.linked_sheet_count} sheet${d.linked_sheet_count === 1 ? '' : 's'}</button>` : '<span class="muted">—</span>'}</td>
      <td class="row" style="gap:6px; flex-wrap:nowrap;">
        <button class="versions-btn">Versions</button>
        ${canManage ? '<button class="issue-rev-btn">Issue revision</button>' : ''}
        ${canManage && editMode ? `<button class="row-delete-icon-btn doc-delete-btn" title="Delete document">${TRASH_ICON}</button>` : ''}
      </td>
    `;
    tr.querySelector('.versions-btn').addEventListener('click', () => openVersionsModal(d));
    const linkBtn = tr.querySelector('.link-btn');
    if (linkBtn) linkBtn.addEventListener('click', () => openLinksModal(d));
    const issueBtn = tr.querySelector('.issue-rev-btn');
    if (issueBtn) issueBtn.addEventListener('click', () => openIssueRevisionModal(d));
    const delBtn = tr.querySelector('.doc-delete-btn');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        const warning =
          d.linked_sheet_count > 0
            ? ` It's linked from markups on ${d.linked_sheet_count} sheet(s) - those links will be removed too.`
            : '';
        if (!confirm(`Delete "${d.name}" and all its revisions? This cannot be undone.${warning}`)) return;
        await api('DELETE', `/api/documents/${d.id}`);
        await loadAll();
        render();
      });
    }
    tbody.appendChild(tr);
  }
}

async function openLinksModal(d) {
  const { sheets } = await api('GET', `/api/documents/${d.id}/links`);
  openModal(`
    <h2>${escapeHtml(d.name)} — linked drawings</h2>
    <p class="muted">Sheets with a markup linking to this document.</p>
    <div class="doc-picker-list">
      ${sheets
        .map(
          (s) => `
        <div class="doc-picker-row sheet-link-row" data-project="${s.project_id}" data-sheet="${s.id}">
          <span style="flex:1;">
            <b>${escapeHtml(s.sheet_number)}</b>
            <span class="muted">${escapeHtml(s.discipline) || ''} — ${s.markup_count} markup${s.markup_count === 1 ? '' : 's'}</span>
          </span>
        </div>`
        )
        .join('')}
    </div>
    <div class="modal-actions"><button type="button" id="modal-cancel">Close</button></div>
  `);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.querySelectorAll('.sheet-link-row').forEach((row) => {
    row.addEventListener('click', () => {
      window.open(`/sheet.html?projectId=${row.dataset.project}&sheetId=${row.dataset.sheet}`, '_blank');
    });
  });
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
    <h2>Upload document(s)</h2>
    <div class="drop-zone" id="modal-drop-zone">
      <div class="drop-zone-title">Drag &amp; drop PDF(s) here</div>
      <div>or click to browse</div>
      <input type="file" id="modal-doc-file" accept="application/pdf" multiple style="display:none;">
    </div>
    <div id="modal-single-fields" style="display:none; margin-top:12px;">
      <div class="field"><label>Name</label><input id="modal-doc-name" placeholder="e.g. RFI-042 - Beam size at gridline C"></div>
      <div class="field"><label>Issue date (optional)</label><input id="modal-doc-date" type="date"></div>
    </div>
    <p class="muted" id="modal-multi-summary" style="display:none; margin-top:8px;"></p>
    <p class="error" id="modal-error" style="display:none;"></p>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Cancel</button>
      <button class="primary" type="button" id="modal-upload" disabled>Upload</button>
    </div>
  `);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);

  const dropZone = document.getElementById('modal-drop-zone');
  const fileInput = document.getElementById('modal-doc-file');
  const nameInput = document.getElementById('modal-doc-name');
  const singleFields = document.getElementById('modal-single-fields');
  const multiSummary = document.getElementById('modal-multi-summary');
  const uploadBtn = document.getElementById('modal-upload');
  let selectedFiles = [];

  function setSelectedFiles(files) {
    selectedFiles = files;
    uploadBtn.disabled = files.length === 0;
    if (files.length === 1) {
      singleFields.style.display = '';
      multiSummary.style.display = 'none';
      if (!nameInput.value) nameInput.value = files[0].name.replace(/\.pdf$/i, '');
    } else if (files.length > 1) {
      singleFields.style.display = 'none';
      multiSummary.style.display = '';
      multiSummary.textContent = `${files.length} files selected - each will be named from its filename.`;
    } else {
      singleFields.style.display = 'none';
      multiSummary.style.display = 'none';
    }
  }

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    setSelectedFiles(pdfFilesFrom(e.dataTransfer));
  });
  fileInput.addEventListener('change', () => setSelectedFiles(Array.from(fileInput.files)));

  uploadBtn.addEventListener('click', async () => {
    const errEl = document.getElementById('modal-error');
    if (selectedFiles.length === 0) return;

    if (selectedFiles.length > 1) {
      closeModal();
      await uploadFilesBulk(selectedFiles, currentFolderId);
      return;
    }

    const name = nameInput.value.trim();
    if (!name) {
      errEl.textContent = 'Name is required.';
      errEl.style.display = 'block';
      return;
    }
    const fd = new FormData();
    fd.append('name', name);
    fd.append('issue_date', document.getElementById('modal-doc-date').value);
    if (currentFolderId) fd.append('folder_id', currentFolderId);
    fd.append('file', selectedFiles[0]);
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
document.getElementById('edit-mode-btn').addEventListener('click', () => {
  editMode = !editMode;
  document.getElementById('edit-mode-btn').textContent = editMode ? 'Done' : 'Edit';
  document.getElementById('edit-mode-btn').classList.toggle('primary', editMode);
  renderTable();
});

// ---------- Drag-and-drop upload: drop anywhere in the folder view to
// upload into the current folder, or drop directly onto a folder row to
// upload into that folder without navigating into it first. Large volumes
// are the whole point here, so this skips any per-file naming modal - each
// file is auto-named from its filename and uploaded immediately.
function setupDragAndDrop() {
  const zone = document.getElementById('doc-dropzone');
  let dragCounter = 0;

  zone.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragCounter += 1;
    zone.classList.add('drag-active');
  });
  zone.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault(); // required for drop to fire at all
    const folderRow = e.target.closest('tr.doc-row-folder');
    zone.querySelectorAll('tr.doc-row-folder.drag-target-folder').forEach((tr) => {
      if (tr !== folderRow) tr.classList.remove('drag-target-folder');
    });
    if (folderRow) folderRow.classList.add('drag-target-folder');
  });
  zone.addEventListener('dragleave', () => {
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) {
      zone.classList.remove('drag-active');
      zone.querySelectorAll('.drag-target-folder').forEach((tr) => tr.classList.remove('drag-target-folder'));
    }
  });
  zone.addEventListener('drop', async (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragCounter = 0;
    zone.classList.remove('drag-active');
    const folderRow = e.target.closest('tr.doc-row-folder');
    zone.querySelectorAll('.drag-target-folder').forEach((tr) => tr.classList.remove('drag-target-folder'));
    const targetFolderId = folderRow ? Number(folderRow.dataset.folderId) : currentFolderId;
    const files = pdfFilesFrom(e.dataTransfer);
    if (files.length) await uploadFilesBulk(files, targetFolderId);
  });
}

function isFileDrag(e) {
  return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
}

function pdfFilesFrom(dataTransfer) {
  return Array.from(dataTransfer.files || []).filter(
    (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
  );
}

let uploadPanel = null;
let uploadPanelClearTimer = null;

function ensureUploadPanel() {
  if (uploadPanelClearTimer) {
    clearTimeout(uploadPanelClearTimer);
    uploadPanelClearTimer = null;
  }
  if (!uploadPanel) {
    uploadPanel = document.createElement('div');
    uploadPanel.className = 'upload-list';
    uploadPanel.style.marginBottom = '10px';
    document.getElementById('doc-dropzone').before(uploadPanel);
  }
  return uploadPanel;
}

function uploadOneFileXhr(file, folderId, panel) {
  return new Promise((resolve) => {
    const name = file.name.replace(/\.pdf$/i, '');
    const row = document.createElement('div');
    row.className = 'upload-row';
    row.innerHTML = `
      <div class="upload-row-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
      <div class="upload-row-bar"><div class="upload-row-fill"></div></div>
      <div class="upload-row-status">Uploading...</div>
    `;
    panel.appendChild(row);
    const fill = row.querySelector('.upload-row-fill');
    const status = row.querySelector('.upload-row-status');

    const fd = new FormData();
    fd.append('name', name);
    if (folderId) fd.append('folder_id', folderId);
    fd.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/projects/${projectId}/documents`);
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) fill.style.width = `${(e.loaded / e.total) * 100}%`;
    });
    xhr.addEventListener('load', () => {
      if (xhr.status === 201) {
        fill.style.width = '100%';
        status.textContent = 'Done';
        status.classList.add('done');
        resolve(true);
      } else {
        let data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch (err) {
          // ignore
        }
        status.textContent = `Failed: ${(data && data.error) || xhr.statusText}`;
        status.classList.add('error');
        resolve(false);
      }
    });
    xhr.addEventListener('error', () => {
      status.textContent = 'Upload failed (network error)';
      status.classList.add('error');
      resolve(false);
    });
    xhr.send(fd);
  });
}

// Concurrent, not sequential - unlike sheet ingest (heavy PyMuPDF rendering,
// deliberately queued one-at-a-time), a document upload is just a file save
// plus one DB insert, so there's no reason to make a large batch wait on
// itself. The browser's own per-origin connection cap naturally throttles
// this anyway.
async function uploadFilesBulk(files, folderId) {
  const panel = ensureUploadPanel();
  const results = await Promise.all(files.map((file) => uploadOneFileXhr(file, folderId, panel)));
  await loadAll();
  render();
  const succeeded = results.filter(Boolean).length;
  showToast(
    succeeded === files.length
      ? `Uploaded ${succeeded} file(s).`
      : `Uploaded ${succeeded} of ${files.length} file(s) - see errors below.`,
    succeeded === files.length ? 'success' : 'error'
  );
  uploadPanelClearTimer = setTimeout(() => {
    if (uploadPanel) {
      uploadPanel.remove();
      uploadPanel = null;
    }
  }, 4000);
}

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
    setupDragAndDrop();
  }
  await loadAll();
  render();
})();
