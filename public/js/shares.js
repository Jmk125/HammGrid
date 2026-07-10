import { renderShell, openModal, closeModal } from '/js/shell.js';

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
  document.getElementById('share-revision').style.display = e.target.value === 'snapshot' ? '' : 'none';
});

async function updateShare(id, body) {
  await api('PATCH', `/api/projects/${projectId}/shares/${id}`, body);
  await loadShares();
}

async function loadShares() {
  const { shares } = await api('GET', `/api/projects/${projectId}/shares`);
  const tbody = document.querySelector('#shares-table tbody');
  tbody.innerHTML = '';
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
      <td><input readonly value="${escapeShareHtml(url)}" style="width:260px" onclick="this.select()"></td>
      <td class="row"></td>`;

    const actions = tr.lastElementChild;
    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.textContent = 'Rename';
    renameBtn.addEventListener('click', async () => {
      const nextName = prompt('Share link name:', s.name || '');
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
      if (!confirm('Delete this share link permanently? This cannot be undone.')) return;
      await api('DELETE', `/api/projects/${projectId}/shares/${s.id}`);
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
  const { share } = await api('POST', `/api/projects/${projectId}/shares`, body);
  document.getElementById('new-share-result').textContent =
    `Created: ${window.location.origin}/share.html?token=${share.token}`;
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
  const folderRows = allFolders.map((f) => `
    <label style="display:block; margin-left:${f.parent_folder_id ? 24 : 0}px;">
      <input type="checkbox" class="perm-folder" value="${f.id}" ${folderIds.has(f.id) ? 'checked' : ''}> 📁 ${escapeShareHtml(f.name)}
    </label>`).join('');
  const docRows = allDocuments.map((d) => `
    <label style="display:block; margin-left:32px;">
      <input type="checkbox" class="perm-doc" value="${d.id}" ${docIds.has(d.id) ? 'checked' : ''}> ${escapeShareHtml(d.name)}
    </label>`).join('');
  return folderRows + docRows;
}

function editPermissions(source, onSave) {
  const state = permissionState(source);
  const backdrop = openModal(`
    <h2>Share permissions</h2>
    <label><input type="checkbox" checked disabled> Live Drawings</label>
    <p class="muted">Shared links always include drawings and published markups.</p>
    <label><input type="checkbox" id="edit-personal" ${state.allow_personal_markups ? 'checked' : ''}> Personal Markups</label>
    <label><input type="checkbox" id="edit-documents" ${state.allow_documents ? 'checked' : ''}> Documents</label>
    <div id="document-permissions" class="card" style="margin-top:10px; ${state.allow_documents ? '' : 'display:none;'}">
      <label><input type="checkbox" id="all-docs"> All documents/folders</label>
      <div style="max-height:320px; overflow:auto; margin-top:8px;">${renderDocumentAccessTree(state)}</div>
    </div>
    <div class="row"><button id="save-permissions" class="primary">Save</button><button id="cancel-permissions">Cancel</button></div>
  `);
  const docsToggle = backdrop.querySelector('#edit-documents');
  docsToggle.addEventListener('change', () => {
    backdrop.querySelector('#document-permissions').style.display = docsToggle.checked ? '' : 'none';
  });
  backdrop.querySelector('#all-docs').addEventListener('change', (e) => {
    backdrop.querySelectorAll('.perm-folder,.perm-doc').forEach((cb) => { cb.checked = e.target.checked; });
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
