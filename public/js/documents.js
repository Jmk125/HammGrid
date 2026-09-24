import { renderShell, openModal, closeModal, showToast, confirmModal } from '/js/shell.js';
import { getCachedDocuments, getCachedDocumentFolders, getCachedDocumentAsset } from '/js/offline-store.js';

const TRASH_ICON =
  '<svg viewBox="0 0 20 20"><path d="M4 6h12M8 6V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2m-7 0 .7 10.5A1 1 0 0 0 6.7 17h6.6a1 1 0 0 0 1-1.5L15 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Shared by non-image documents' own icon and, below, by a photo document's
// thumbnail when it can't load live AND isn't cached for offline either -
// falls back to looking like any other document row rather than a blank/
// broken image.
const GENERIC_FILE_ICON_SVG =
  '<svg viewBox="0 0 20 20" class="doc-icon"><path d="M5 2h7l4 4v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M12 2v4h4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';

const FOLDER_ICON_SVG =
  '<svg viewBox="0 0 20 20" class="doc-icon"><path d="M2 5a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5z" fill="currentColor"/></svg>';

const params = new URLSearchParams(window.location.search);
const projectId = params.get('projectId');
// "View Multiple" (see dashboard.js) - a comma-separated set of project ids
// instead of a single one means this is the combined-view flavor of this
// page: documents from every listed project, merged and view-only (no
// upload/new-folder/edit-mode/issue-revision/delete). Folders don't
// translate across projects - each project has its own folder tree, so
// combined mode skips folders entirely and just shows a flat, project-
// tagged list. Online-only, same as the combined Sheets grid (see viewer.js).
const combinedProjectIds = params.get('projectIds');
const combinedMode = !!combinedProjectIds;
const combinedIds = combinedMode ? combinedProjectIds.split(',').map((s) => s.trim()) : [];
let combinedProjectNames = new Map(); // id (string) -> name

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

// .heic/.heif accepted here too - the server converts them to a real JPEG
// on upload (see src/lib/documentUpload.js) rather than storing them as-is.
const ACCEPTED_DOC_TYPES = '.pdf,.jpg,.jpeg,.png,.webp,.gif,.heic,.heif';

function stripExt(filename) {
  return filename.replace(/\.[^.]+$/, '');
}

function formatDateTime(s) {
  if (!s) return '';
  return new Date(s.replace(' ', 'T') + 'Z').toLocaleString();
}

let loadedOffline = false;
let combinedLoadFailed = false;

async function loadAll() {
  if (combinedMode) {
    folders = [];
    try {
      const results = await Promise.all(
        combinedIds.map((id) => api('GET', `/api/projects/${id}/documents`).then((r) => ({ id, documents: r.documents })))
      );
      documents = results.flatMap(({ id, documents: docs }) =>
        docs.map((d) => ({ ...d, project_id: id, project_name: combinedProjectNames.get(id) || '' }))
      );
      combinedLoadFailed = false;
    } catch (err) {
      // Online-only mode (see top-of-file note) - no cache to fall back to.
      documents = [];
      combinedLoadFailed = true;
    }
    return;
  }
  try {
    const [f, d] = await Promise.all([
      api('GET', `/api/projects/${projectId}/documents/folders`),
      api('GET', `/api/projects/${projectId}/documents`),
    ]);
    folders = f.folders;
    documents = d.documents;
    loadedOffline = false;
  } catch (err) {
    // Offline - fall back to whatever was cached at last sync (see
    // offline-store.js's cacheDocuments/cacheDocumentFolders). Every other
    // call site of loadAll() is a post-mutation reload (create/upload/
    // delete), which can only have gotten here by having just succeeded
    // online - this fallback only really matters for the initial page load.
    folders = await getCachedDocumentFolders(projectId);
    documents = await getCachedDocuments(projectId);
    loadedOffline = true;
  }
}

function renderBreadcrumb() {
  const el = document.getElementById('breadcrumb');
  if (combinedMode) {
    const names = [...combinedProjectNames.values()];
    el.textContent = names.length ? `Documents — Combined view: ${names.join(', ')}` : 'Documents — Combined view';
    return;
  }
  const path = [];
  let f = currentFolderId;
  while (f) {
    const folder = folders.find((x) => x.id === f);
    if (!folder) break;
    path.unshift(folder);
    f = folder.parent_folder_id;
  }
  el.innerHTML =
    `<a href="#" data-folder="">Documents</a>` +
    path.map((p) => `<span class="sep">/</span><a href="#" data-folder="${p.id}">${escapeHtml(p.name)}</a>`).join('');
  el.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      setFolder(a.dataset.folder ? Number(a.dataset.folder) : null, true);
    });
    makeMoveDropTarget(a, a.dataset.folder ? Number(a.dataset.folder) : null);
  });
}

function canManage() {
  // Combined mode is view-only regardless of role - see the top-of-file note.
  return !combinedMode && (currentUser.role === 'admin' || currentUser.role === 'editor');
}

// Folders are a per-project tree that can't meaningfully merge across
// several projects, so combined mode skips them entirely and shows every
// document flat, sorted by project then name (see loadAll).
function currentChildren() {
  const childFolders = combinedMode
    ? []
    : folders.filter((f) => (f.parent_folder_id || null) === currentFolderId).sort((a, b) => a.name.localeCompare(b.name));
  const childDocs = combinedMode
    ? documents.slice().sort((a, b) => (a.project_name || '').localeCompare(b.project_name || '') || a.name.localeCompare(b.name))
    : documents.filter((d) => (d.folder_id || null) === currentFolderId).sort((a, b) => a.name.localeCompare(b.name));
  return { childFolders, childDocs };
}

// Pre-generated small JPEG (see src/lib/documentThumbs.js), not the full
// photo - a folder of phone photos would otherwise download every one at
// full size just to browse. ?v= busts the browser cache when a new
// revision replaces the file.
function thumbUrl(d) {
  return `/api/documents/${d.id}/thumb?v=${d.current_version_id || ''}`;
}

// Live URL fails offline - try the cached blob (see offline-store.js's
// cacheDocuments/getCachedDocumentAsset) before giving up to the plain
// file-icon placeholder every other (non-image) document already shows.
function wireThumbFallback(img, d) {
  img.addEventListener('error', async () => {
    const blob = d.current_version_id ? await getCachedDocumentAsset(d.current_version_id) : null;
    if (blob) {
      img.src = URL.createObjectURL(blob);
      return;
    }
    img.outerHTML = GENERIC_FILE_ICON_SVG;
  });
}

async function deleteFolder(f) {
  const { linked_markup_count } = await api('GET', `/api/document-folders/${f.id}/links`);
  const warning =
    linked_markup_count > 0
      ? ` ${linked_markup_count} markup(s) on drawings link to documents inside it - those links will be removed too.`
      : '';
  const ok = await confirmModal({
    title: `Delete folder "${f.name}"?`,
    message: `Everything inside it will be deleted too. This cannot be undone.${warning}`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  await api('DELETE', `/api/document-folders/${f.id}`);
  selected.delete(`f:${f.id}`);
  showToast(`Folder "${f.name}" deleted.`, 'success');
  await loadAll();
  render();
}

async function deleteDocument(d) {
  const warning =
    d.linked_sheet_count > 0 ? ` It's linked from markups on ${d.linked_sheet_count} sheet(s) - those links will be removed too.` : '';
  const ok = await confirmModal({
    title: `Delete "${d.name}"?`,
    message: `All its revisions will be deleted too. This cannot be undone.${warning}`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  await api('DELETE', `/api/documents/${d.id}`);
  selected.delete(`d:${d.id}`);
  showToast(`"${d.name}" deleted.`, 'success');
  await loadAll();
  render();
}

// ---------- Selection (edit mode) + move ----------
// Keys are 'd:<id>' for documents and 'f:<id>' for folders, so one Set can
// hold a mixed selection.
const selected = new Set();

function selectCheckboxHtml(key) {
  return `<input type="checkbox" class="doc-select" data-key="${key}" ${selected.has(key) ? 'checked' : ''} title="Select">`;
}

function wireSelectCheckbox(el) {
  const box = el.querySelector('.doc-select');
  if (!box) return;
  box.addEventListener('click', (e) => e.stopPropagation());
  box.addEventListener('change', () => {
    if (box.checked) selected.add(box.dataset.key);
    else selected.delete(box.dataset.key);
    el.classList.toggle('doc-selected', box.checked);
    updateSelectionUi();
  });
}

function childKeys() {
  const { childFolders, childDocs } = currentChildren();
  return [...childFolders.map((f) => `f:${f.id}`), ...childDocs.map((d) => `d:${d.id}`)];
}

function updateSelectionUi() {
  const moveBtn = document.getElementById('move-btn');
  const selectAll = document.getElementById('select-all-btn');
  moveBtn.style.display = editMode ? '' : 'none';
  selectAll.style.display = editMode ? '' : 'none';
  moveBtn.disabled = selected.size === 0;
  moveBtn.textContent = selected.size ? `Move (${selected.size})` : 'Move';
  const keys = childKeys();
  selectAll.textContent = keys.length > 0 && keys.every((k) => selected.has(k)) ? 'Select none' : 'Select all';
}

function toggleSelectAll() {
  const keys = childKeys();
  const allSelected = keys.every((k) => selected.has(k));
  for (const k of keys) {
    if (allSelected) selected.delete(k);
    else selected.add(k);
  }
  renderItems();
}

// Every folder id at or under any of the given folders - a folder can't be
// moved into itself or its own subtree (the server refuses that too).
function folderSubtreeIds(rootIds) {
  const out = new Set(rootIds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (f.parent_folder_id && out.has(f.parent_folder_id) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
    }
  }
  return out;
}

async function moveItems(keys, targetFolderId) {
  const blocked = folderSubtreeIds(keys.filter((k) => k.startsWith('f:')).map((k) => Number(k.slice(2))));
  if (targetFolderId && blocked.has(targetFolderId)) {
    showToast("A folder can't be moved into itself or one of its own subfolders.", 'error');
    return;
  }
  let moved = 0;
  let failed = 0;
  for (const key of keys) {
    const id = Number(key.slice(2));
    const isFolder = key.startsWith('f:');
    const item = isFolder ? folders.find((f) => f.id === id) : documents.find((d) => d.id === id);
    if (!item) continue;
    const currentParent = (isFolder ? item.parent_folder_id : item.folder_id) || null;
    if (currentParent === (targetFolderId || null)) continue;
    try {
      if (isFolder) await api('PATCH', `/api/document-folders/${id}`, { parent_folder_id: targetFolderId || null });
      else await api('PATCH', `/api/documents/${id}`, { folder_id: targetFolderId || null });
      moved += 1;
    } catch (err) {
      failed += 1;
    }
  }
  const target = targetFolderId ? folders.find((f) => f.id === targetFolderId) : null;
  const where = target ? `"${target.name}"` : 'Documents (top level)';
  if (failed) showToast(`Moved ${moved}, ${failed} failed${navigator.onLine ? '' : ' - moving needs a connection'}.`, 'error');
  else if (moved) showToast(`Moved ${moved} item${moved === 1 ? '' : 's'} to ${where}.`, 'success');
  for (const key of keys) selected.delete(key);
  await loadAll();
  render();
}

// Folder browser for "Move to..." - same breadcrumb + subfolder-list shape
// as the photo pin's folder picker (markups.js pickPhotoFolder).
function openMoveModal() {
  const keys = [...selected];
  if (!keys.length) return;
  const blocked = folderSubtreeIds(keys.filter((k) => k.startsWith('f:')).map((k) => Number(k.slice(2))));
  let browseId = currentFolderId && !blocked.has(currentFolderId) ? currentFolderId : null;
  const backdrop = openModal(`
    <h2>Move ${keys.length} item${keys.length === 1 ? '' : 's'} to...</h2>
    <div id="move-folder-body"></div>
    <div class="modal-actions">
      <button type="button" id="move-cancel">Cancel</button>
      <button class="primary" type="button" id="move-here">Move here</button>
    </div>
  `);
  const body = backdrop.querySelector('#move-folder-body');
  backdrop.querySelector('#move-cancel').addEventListener('click', closeModal);
  backdrop.querySelector('#move-here').addEventListener('click', async () => {
    closeModal();
    await moveItems(keys, browseId);
  });

  function renderPicker() {
    const path = [];
    let f = browseId;
    while (f) {
      const folder = folders.find((x) => x.id === f);
      if (!folder) break;
      path.unshift(folder);
      f = folder.parent_folder_id;
    }
    const children = folders
      .filter((x) => (x.parent_folder_id || null) === browseId && !blocked.has(x.id))
      .sort((a, b) => a.name.localeCompare(b.name));
    const breadcrumb =
      `<span class="doc-picker-crumb" data-folder="">Documents</span>` +
      path.map((p) => ` / <span class="doc-picker-crumb" data-folder="${p.id}">${escapeHtml(p.name)}</span>`).join('');
    const rows =
      children
        .map((fld) => `<div class="doc-picker-row folder" data-folder="${fld.id}">${FOLDER_ICON_SVG}<span>${escapeHtml(fld.name)}</span></div>`)
        .join('') || '<p class="muted" style="padding:8px 4px;">No subfolders here.</p>';
    body.innerHTML = `<div class="doc-picker-breadcrumb">${breadcrumb}</div><div class="doc-picker-list">${rows}</div>`;
    body.querySelectorAll('.doc-picker-crumb').forEach((el) => {
      el.addEventListener('click', () => {
        browseId = el.dataset.folder ? Number(el.dataset.folder) : null;
        renderPicker();
      });
    });
    body.querySelectorAll('.doc-picker-row.folder').forEach((el) => {
      el.addEventListener('click', () => {
        browseId = Number(el.dataset.folder);
        renderPicker();
      });
    });
  }
  renderPicker();
}

// Drag a document/folder onto a folder (or a breadcrumb link) to move it -
// mouse only; on iPad the checkboxes + Move button do the same job. A
// custom MIME type keeps this separate from the file-upload drop handling
// in setupDragAndDrop (which only reacts to real 'Files' drags).
const MOVE_DRAG_TYPE = 'application/x-hammgrid-doc-keys';
const finePointer = window.matchMedia && window.matchMedia('(pointer: fine)').matches;

function makeDraggable(el, key) {
  if (!canManage() || !finePointer) return;
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    const keys = selected.has(key) ? [...selected] : [key];
    e.dataTransfer.setData(MOVE_DRAG_TYPE, JSON.stringify(keys));
    e.dataTransfer.effectAllowed = 'move';
  });
}

function makeMoveDropTarget(el, folderId) {
  if (!canManage()) return;
  const isMoveDrag = (e) => Array.from(e.dataTransfer.types || []).includes(MOVE_DRAG_TYPE);
  el.addEventListener('dragover', (e) => {
    if (!isMoveDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('drag-target-folder');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drag-target-folder'));
  el.addEventListener('drop', async (e) => {
    if (!isMoveDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('drag-target-folder');
    const keys = JSON.parse(e.dataTransfer.getData(MOVE_DRAG_TYPE) || '[]').filter((k) => k !== `f:${folderId}`);
    if (keys.length) await moveItems(keys, folderId);
  });
}

// ---------- List / thumbnail views ----------
const VIEW_MODE_KEY = 'hammgrid-doc-view-mode';
let viewMode = (() => {
  try {
    return localStorage.getItem(VIEW_MODE_KEY) === 'grid' ? 'grid' : 'list';
  } catch (e) {
    return 'list';
  }
})();

function setViewMode(mode) {
  viewMode = mode;
  try {
    localStorage.setItem(VIEW_MODE_KEY, mode);
  } catch (e) {
    // Per-viewer convenience only.
  }
  renderItems();
}

function renderItems() {
  document.getElementById('view-list-btn').classList.toggle('active', viewMode === 'list');
  document.getElementById('view-grid-btn').classList.toggle('active', viewMode === 'grid');
  document.getElementById('doc-table').style.display = viewMode === 'list' ? '' : 'none';
  document.getElementById('doc-grid').style.display = viewMode === 'grid' ? '' : 'none';

  const { childFolders, childDocs } = currentChildren();
  const emptyMsg = document.getElementById('empty-msg');
  const isEmpty = childFolders.length === 0 && childDocs.length === 0;
  emptyMsg.style.display = isEmpty ? '' : 'none';
  if (isEmpty) {
    emptyMsg.textContent = combinedMode
      ? combinedLoadFailed
        ? "Couldn't load documents for one or more of these projects."
        : 'No documents in these projects yet.'
      : loadedOffline && folders.length === 0 && documents.length === 0
      ? 'No documents cached for offline use yet - open this project once while online first.'
      : 'This folder is empty. Drag & drop PDFs anywhere in this area to upload.';
  }

  if (viewMode === 'grid') renderGrid(childFolders, childDocs);
  else renderTable(childFolders, childDocs);
  updateSelectionUi();
}

function renderTable(childFolders, childDocs) {
  const manage = canManage();
  const selecting = manage && editMode;
  document.getElementById('doc-select-col').style.display = selecting ? '' : 'none';
  const tbody = document.querySelector('#doc-table tbody');
  tbody.innerHTML = '';

  for (const f of childFolders) {
    const key = `f:${f.id}`;
    const tr = document.createElement('tr');
    tr.className = 'doc-row-folder' + (selected.has(key) ? ' doc-selected' : '');
    tr.dataset.folderId = f.id;
    tr.innerHTML = `
      ${selecting ? `<td>${selectCheckboxHtml(key)}</td>` : ''}
      <td>${FOLDER_ICON_SVG}</td>
      <td class="doc-row-name"><a href="#" class="folder-link">${escapeHtml(f.name)}</a></td>
      <td></td><td></td><td></td><td></td>
      <td>${selecting ? `<button class="row-delete-icon-btn folder-delete" title="Delete folder">${TRASH_ICON}</button>` : ''}</td>
    `;
    tr.querySelector('.folder-link').addEventListener('click', (e) => {
      e.preventDefault();
      setFolder(f.id, true);
    });
    const delBtn = tr.querySelector('.folder-delete');
    if (delBtn) delBtn.addEventListener('click', () => deleteFolder(f));
    wireSelectCheckbox(tr);
    makeDraggable(tr, key);
    makeMoveDropTarget(tr, f.id);
    tbody.appendChild(tr);
  }

  for (const d of childDocs) {
    const key = `d:${d.id}`;
    const tr = document.createElement('tr');
    if (selected.has(key)) tr.className = 'doc-selected';
    // A photo gets a real (small, pre-generated) thumbnail instead of the
    // generic file icon.
    const icon = d.is_image ? `<img class="doc-icon doc-thumb" src="${thumbUrl(d)}" alt="" loading="lazy">` : GENERIC_FILE_ICON_SVG;
    tr.innerHTML = `
      ${selecting ? `<td>${selectCheckboxHtml(key)}</td>` : ''}
      <td>${icon}</td>
      ${combinedMode ? `<td>${escapeHtml(d.project_name || '')}</td>` : ''}
      <td class="doc-row-name"><a href="/document-view.html?documentId=${d.id}" target="_blank">${escapeHtml(d.name)}</a></td>
      <td>${escapeHtml(d.revision_name) || '<span class="muted">Original</span>'}</td>
      <td>${escapeHtml(d.issue_date) || ''}</td>
      <td class="muted">${formatDateTime(d.version_created_at)}</td>
      <td>${d.linked_sheet_count > 0 ? `<button class="link-btn">${d.linked_sheet_count} sheet${d.linked_sheet_count === 1 ? '' : 's'}</button>` : '<span class="muted">—</span>'}</td>
      <td class="row" style="gap:6px; flex-wrap:nowrap;">
        <button class="versions-btn">Versions</button>
        ${manage ? '<button class="issue-rev-btn">Issue revision</button>' : ''}
        ${selecting ? `<button class="row-delete-icon-btn doc-delete-btn" title="Delete document">${TRASH_ICON}</button>` : ''}
      </td>
    `;
    tr.querySelector('.versions-btn').addEventListener('click', () => openVersionsModal(d));
    const linkBtn = tr.querySelector('.link-btn');
    if (linkBtn) linkBtn.addEventListener('click', () => openLinksModal(d));
    const issueBtn = tr.querySelector('.issue-rev-btn');
    if (issueBtn) issueBtn.addEventListener('click', () => openIssueRevisionModal(d));
    const delBtn = tr.querySelector('.doc-delete-btn');
    if (delBtn) delBtn.addEventListener('click', () => deleteDocument(d));
    const thumbImg = tr.querySelector('.doc-thumb');
    if (thumbImg) wireThumbFallback(thumbImg, d);
    wireSelectCheckbox(tr);
    makeDraggable(tr, key);
    tbody.appendChild(tr);
  }
}

// Large-thumbnail view - mostly for photo folders, where the list's 32px
// thumbnail isn't enough to tell photos apart. Row-level actions (versions,
// issue revision, links) stay in the list view.
function renderGrid(childFolders, childDocs) {
  const selecting = canManage() && editMode;
  const grid = document.getElementById('doc-grid');
  grid.innerHTML = '';

  for (const f of childFolders) {
    const key = `f:${f.id}`;
    const card = document.createElement('div');
    card.className = 'doc-card doc-card-folder' + (selected.has(key) ? ' doc-selected' : '');
    card.innerHTML = `
      <a href="#" class="doc-card-thumb">${FOLDER_ICON_SVG}</a>
      <div class="doc-card-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
      ${selecting ? `<label class="doc-card-check">${selectCheckboxHtml(key)}</label>` : ''}
      ${selecting ? `<button class="row-delete-icon-btn doc-card-delete" title="Delete folder">${TRASH_ICON}</button>` : ''}
    `;
    card.querySelector('.doc-card-thumb').addEventListener('click', (e) => {
      e.preventDefault();
      setFolder(f.id, true);
    });
    const delBtn = card.querySelector('.doc-card-delete');
    if (delBtn) delBtn.addEventListener('click', () => deleteFolder(f));
    wireSelectCheckbox(card);
    makeDraggable(card, key);
    makeMoveDropTarget(card, f.id);
    grid.appendChild(card);
  }

  for (const d of childDocs) {
    const key = `d:${d.id}`;
    const card = document.createElement('div');
    card.className = 'doc-card' + (selected.has(key) ? ' doc-selected' : '');
    const media = d.is_image ? `<img class="doc-card-img" src="${thumbUrl(d)}" alt="" loading="lazy">` : GENERIC_FILE_ICON_SVG;
    card.innerHTML = `
      <a href="/document-view.html?documentId=${d.id}" target="_blank" class="doc-card-thumb">${media}</a>
      <div class="doc-card-name" title="${escapeHtml(d.name)}">${escapeHtml(d.name)}</div>
      ${combinedMode ? `<div class="doc-card-sub">${escapeHtml(d.project_name || '')}</div>` : ''}
      ${selecting ? `<label class="doc-card-check">${selectCheckboxHtml(key)}</label>` : ''}
      ${selecting ? `<button class="row-delete-icon-btn doc-card-delete" title="Delete document">${TRASH_ICON}</button>` : ''}
    `;
    const img = card.querySelector('.doc-card-img');
    if (img) wireThumbFallback(img, d);
    const delBtn = card.querySelector('.doc-card-delete');
    if (delBtn) delBtn.addEventListener('click', () => deleteDocument(d));
    wireSelectCheckbox(card);
    makeDraggable(card, key);
    grid.appendChild(card);
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
    <div class="field"><label>File</label><input id="modal-rev-file" type="file" accept="${ACCEPTED_DOC_TYPES}"></div>
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
      <div class="drop-zone-title">Drag &amp; drop PDF(s) or photo(s) here</div>
      <div>or click to browse</div>
      <input type="file" id="modal-doc-file" accept="${ACCEPTED_DOC_TYPES}" multiple style="display:none;">
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
      if (!nameInput.value) nameInput.value = stripExt(files[0].name);
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
    setSelectedFiles(acceptedFilesFrom(e.dataTransfer));
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
  renderItems();
}

document.getElementById('new-folder-btn').addEventListener('click', openNewFolderModal);
document.getElementById('upload-btn').addEventListener('click', openUploadModal);
document.getElementById('edit-mode-btn').addEventListener('click', () => {
  editMode = !editMode;
  if (!editMode) selected.clear();
  document.getElementById('edit-mode-btn').textContent = editMode ? 'Done' : 'Edit';
  document.getElementById('edit-mode-btn').classList.toggle('primary', editMode);
  renderItems();
});
document.getElementById('move-btn').addEventListener('click', openMoveModal);
document.getElementById('select-all-btn').addEventListener('click', toggleSelectAll);
document.getElementById('view-list-btn').addEventListener('click', () => setViewMode('list'));
document.getElementById('view-grid-btn').addEventListener('click', () => setViewMode('grid'));

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
    const files = acceptedFilesFrom(e.dataTransfer);
    if (files.length) await uploadFilesBulk(files, targetFolderId);
  });
}

function isFileDrag(e) {
  return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
}

const ACCEPTED_DOC_EXTENSIONS = /\.(pdf|jpe?g|png|webp|gif|heic|heif)$/i;

function acceptedFilesFrom(dataTransfer) {
  return Array.from(dataTransfer.files || []).filter(
    (f) => f.type === 'application/pdf' || f.type.startsWith('image/') || ACCEPTED_DOC_EXTENSIONS.test(f.name)
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
    const name = stripExt(file.name);
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

async function loadCombinedProjectNames() {
  const { projects } = await api('GET', '/api/projects');
  const idSet = new Set(combinedIds);
  combinedProjectNames = new Map(projects.filter((p) => idSet.has(String(p.id))).map((p) => [String(p.id), p.name]));
}

(async function init() {
  currentUser = await requireSession();
  if (!currentUser) return;

  if (combinedMode) {
    document.getElementById('doc-project-col').style.display = '';
    await renderShell({
      topbarEl: document.getElementById('topbar'),
      sidebarEl: document.getElementById('sidebar'),
      projectId: undefined,
      combinedProjectIds,
      active: 'documents',
      me: currentUser,
    });
    await loadCombinedProjectNames();
    await loadAll();
    render();
    return;
  }

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
