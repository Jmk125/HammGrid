import { renderShell, openModal, closeModal, confirmModal, promptModal, showToast, copyToClipboard } from '/js/shell.js';

const projectId = new URLSearchParams(window.location.search).get('projectId');
let allFolders = [];
let allDocuments = [];
let newSharePermissions = { allow_personal_markups: false, allow_documents: false, document_folder_ids: [], document_ids: [] };

function escapeShareHtml(str) {
  return String(str || '').replace(/[&<>'"]/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[c]);
}

async function load() {
  const { project } = await api('GET', `/api/projects/${projectId}`);
  const disciplineSelect = document.getElementById('share-discipline');
  for (const d of [...new Set(Object.values(project.discipline_prefix_map))].sort()) {
    disciplineSelect.appendChild(new Option(d, d));
  }

  const [folderData, documentData] = await Promise.all([
    api('GET', `/api/projects/${projectId}/documents/folders`),
    api('GET', `/api/projects/${projectId}/documents`),
  ]);
  allFolders = folderData.folders || [];
  allDocuments = documentData.documents || [];

  const { revisions } = await api('GET', `/api/projects/${projectId}/revisions`);
  const revisionSelect = document.getElementById('share-revision');
  for (const r of revisions.filter((r) => r.status === 'published')) {
    revisionSelect.appendChild(new Option(r.title, r.id));
  }

  await loadShares();
}

document.getElementById('new-share-permissions').addEventListener('click', () => editPermissions(newSharePermissions, (next) => {
  newSharePermissions = next;
  updateNewPermissionsButton();
}));

document.getElementById('share-scope').addEventListener('change', (e) => {
  document.getElementById('share-revision-field').style.display = e.target.value === 'snapshot' ? '' : 'none';
});

async function updateShare(id, body) {
  await api('PATCH', `/api/projects/${projectId}/shares/${id}`, body);
  await loadShares();
}

async function loadShares() {
  const { shares } = await api('GET', `/api/projects/${projectId}/shares`);
  const tbody = document.querySelector('#shares-table tbody');
  tbody.innerHTML = '';
  document.getElementById('shares-empty-msg').style.display = shares.length ? 'none' : '';
  for (const s of shares) {
    const url = `${window.location.origin}/share.html?token=${s.token}`;
    const expired = s.expires_at && s.expires_at < new Date().toISOString();
    const status = s.revoked ? 'inactive' : expired ? 'expired' : 'active';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeShareHtml(s.name) || '<span class="muted">Unnamed</span>'}</td>
      <td>${escapeShareHtml(s.scope)}${s.snapshot_revision_title ? ` (${escapeShareHtml(s.snapshot_revision_title)})` : ''}</td>
      <td>${escapeShareHtml(s.discipline_filter) || 'All'}</td>
      <td>${escapeShareHtml(s.expires_at) || 'Never'}</td>
      <td>${escapeShareHtml(s.created_by_name)}</td>
      <td><span class="pill ${status === 'active' ? 'new' : 'suspicious'}">${status}</span></td>
      <td>${s.allow_personal_markups ? 'Personal markups' : 'View only'}${s.allow_documents ? ' + docs' : ''}</td>
      <td class="row"></td>
      <td class="row"></td>`;

    const linkCell = tr.children[7];
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'copy-link-btn';
    copyBtn.textContent = 'Copy link';
    copyBtn.addEventListener('click', async () => {
      const ok = await copyToClipboard(url);
      const original = copyBtn.textContent;
      copyBtn.textContent = ok ? 'Copied!' : 'Copy failed';
      copyBtn.classList.toggle('copied', ok);
      copyBtn.classList.toggle('danger', !ok);
      setTimeout(() => {
        copyBtn.textContent = original;
        copyBtn.classList.remove('copied', 'danger');
      }, 1500);
    });
    linkCell.appendChild(copyBtn);

    const actions = tr.lastElementChild;
    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.textContent = 'Rename';
    renameBtn.addEventListener('click', async () => {
      const nextName = await promptModal({ title: 'Rename share link', defaultValue: s.name || '', required: false });
      if (nextName === null) return;
      await updateShare(s.id, { name: nextName });
    });
    actions.appendChild(renameBtn);

    const permissionsBtn = document.createElement('button');
    permissionsBtn.type = 'button';
    permissionsBtn.textContent = 'Permissions';
    permissionsBtn.addEventListener('click', () => editPermissions(s));
    actions.appendChild(permissionsBtn);

    if (!expired) {
      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.textContent = s.revoked ? 'Set active' : 'Set inactive';
      toggleBtn.addEventListener('click', async () => {
        await updateShare(s.id, { revoked: !s.revoked });
      });
      actions.appendChild(toggleBtn);
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'danger';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', async () => {
      const ok = await confirmModal({
        title: 'Delete share link?',
        message: 'This cannot be undone. Anyone using this link will immediately lose access.',
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      await api('DELETE', `/api/projects/${projectId}/shares/${s.id}`);
      showToast('Share link deleted.', 'success');
      await loadShares();
    });
    actions.appendChild(deleteBtn);

    tbody.appendChild(tr);
  }
}

document.getElementById('new-share-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const scope = document.getElementById('share-scope').value;
  const body = {
    name: document.getElementById('share-name').value,
    scope,
    snapshot_revision_id: scope === 'snapshot' ? Number(document.getElementById('share-revision').value) : null,
    discipline_filter: document.getElementById('share-discipline').value || null,
    expires_at: document.getElementById('share-expires').value || null,
    ...newSharePermissions,
  };
  await api('POST', `/api/projects/${projectId}/shares`, body);
  showToast('Share link created - copy it from the table below.', 'success');
  document.getElementById('share-name').value = '';
  newSharePermissions = { allow_personal_markups: false, allow_documents: false, document_folder_ids: [], document_ids: [] };
  updateNewPermissionsButton();
  await loadShares();
});


function parseIds(value) {
  try { return JSON.parse(value || '[]'); } catch (e) { return []; }
}

function permissionState(source) {
  return {
    allow_personal_markups: Boolean(source.allow_personal_markups),
    allow_documents: Boolean(source.allow_documents),
    document_folder_ids: Array.isArray(source.document_folder_ids) ? source.document_folder_ids : parseIds(source.document_folder_ids),
    document_ids: Array.isArray(source.document_ids) ? source.document_ids : parseIds(source.document_ids),
  };
}

function updateNewPermissionsButton() {
  const btn = document.getElementById('new-share-permissions');
  const parts = ['Live Drawings'];
  if (newSharePermissions.allow_documents) parts.push('Documents');
  if (newSharePermissions.allow_personal_markups) parts.push('Personal Markups');
  btn.textContent = `Permissions: ${parts.join(', ')}`;
}

function renderDocumentAccessTree(state) {
  const folderIds = new Set(state.document_folder_ids || []);
  const docIds = new Set(state.document_ids || []);
  const foldersByParent = new Map();
  for (const f of allFolders) {
    const key = f.parent_folder_id || 0;
    if (!foldersByParent.has(key)) foldersByParent.set(key, []);
    foldersByParent.get(key).push(f);
  }
  const docsByFolder = new Map();
  for (const d of allDocuments) {
    const key = d.folder_id || 0;
    if (!docsByFolder.has(key)) docsByFolder.set(key, []);
    docsByFolder.get(key).push(d);
  }

  function renderDocs(folderId, depth) {
    return (docsByFolder.get(folderId) || []).map((d) => `
      <label class="permission-tree-row permission-tree-doc" style="--depth:${depth};">
        <input type="checkbox" class="perm-doc" value="${d.id}" data-doc-folder="${folderId}" ${docIds.has(d.id) ? 'checked' : ''}>
        <span class="permission-tree-icon">📄</span>
        <span class="permission-tree-label">${escapeShareHtml(d.name)}</span>
      </label>`).join('');
  }

  function renderFolders(parentId, depth) {
    return (foldersByParent.get(parentId) || []).map((f) => `
      <details class="permission-tree-folder" open data-folder-node="${f.id}">
        <summary class="permission-tree-row" style="--depth:${depth};">
          <input type="checkbox" class="perm-folder" value="${f.id}" data-parent-folder="${parentId}" ${folderIds.has(f.id) ? 'checked' : ''}>
          <span class="permission-tree-icon">📁</span>
          <span class="permission-tree-label">${escapeShareHtml(f.name)}</span>
        </summary>
        ${renderFolders(f.id, depth + 1)}
        ${renderDocs(f.id, depth + 1)}
      </details>`).join('');
  }

  const rootDocs = renderDocs(0, 0);
  const tree = `${renderFolders(0, 0)}${rootDocs}`;
  return tree || '<p class="muted">No document folders or files exist yet.</p>';
}

function setDocumentDescendants(backdrop, folderId, checked) {
  const childFolders = [...backdrop.querySelectorAll(`.perm-folder[data-parent-folder="${folderId}"]`)];
  const childDocs = [...backdrop.querySelectorAll(`.perm-doc[data-doc-folder="${folderId}"]`)];
  for (const cb of childFolders) {
    cb.checked = checked;
    setDocumentDescendants(backdrop, Number(cb.value), checked);
  }
  for (const cb of childDocs) cb.checked = checked;
}

function editPermissions(source, onSave) {
  const state = permissionState(source);
  const backdrop = openModal(`
    <div class="permission-modal">
      <h2>Share permissions</h2>
      <div class="permission-option locked"><input type="checkbox" checked disabled><span><b>Live Drawings</b><small>Always included, with all published markups visible.</small></span></div>
      <label class="permission-option"><input type="checkbox" id="edit-personal" ${state.allow_personal_markups ? 'checked' : ''}><span><b>Personal Markups</b><small>Allow this invited viewer to add private markups on shared drawings.</small></span></label>
      <label class="permission-option"><input type="checkbox" id="edit-documents" ${state.allow_documents ? 'checked' : ''}><span><b>Documents</b><small>Grant access to selected document folders or files.</small></span></label>
      <div id="document-permissions" class="permission-documents" style="${state.allow_documents ? '' : 'display:none;'}">
        <label class="permission-tree-row permission-tree-all"><input type="checkbox" id="all-docs"><span class="permission-tree-icon">🗂️</span><span class="permission-tree-label">All documents/folders</span></label>
        <div class="permission-tree">${renderDocumentAccessTree(state)}</div>
      </div>
      <div class="row"><button id="save-permissions" class="primary">Save</button><button id="cancel-permissions">Cancel</button></div>
    </div>
  `);
  backdrop.querySelector('.modal').classList.add('permission-modal-shell');
  const docsToggle = backdrop.querySelector('#edit-documents');
  docsToggle.addEventListener('change', () => {
    backdrop.querySelector('#document-permissions').style.display = docsToggle.checked ? '' : 'none';
  });
  backdrop.querySelector('#all-docs').addEventListener('change', (e) => {
    backdrop.querySelectorAll('.perm-folder,.perm-doc').forEach((cb) => { cb.checked = e.target.checked; });
  });
  backdrop.querySelectorAll('.perm-folder').forEach((cb) => {
    cb.addEventListener('change', () => setDocumentDescendants(backdrop, Number(cb.value), cb.checked));
  });
  backdrop.querySelectorAll('.permission-tree-folder summary input').forEach((input) => {
    input.addEventListener('click', (e) => e.stopPropagation());
  });
  backdrop.querySelector('#cancel-permissions').addEventListener('click', closeModal);
  backdrop.querySelector('#save-permissions').addEventListener('click', async () => {
    const next = {
      allow_personal_markups: backdrop.querySelector('#edit-personal').checked,
      allow_documents: docsToggle.checked,
      document_folder_ids: [...backdrop.querySelectorAll('.perm-folder:checked')].map((o) => Number(o.value)),
      document_ids: [...backdrop.querySelectorAll('.perm-doc:checked')].map((o) => Number(o.value)),
    };
    if (onSave) {
      onSave(next);
    } else {
      await updateShare(source.id, next);
    }
    closeModal();
  });
}

(async function init() {
  const me = await requireSession();
  if (!me) return;
  await renderShell({
    topbarEl: document.getElementById('topbar'),
    sidebarEl: document.getElementById('sidebar'),
    projectId,
    active: 'invite',
    me,
  });
  updateNewPermissionsButton();
  await load();
})();
