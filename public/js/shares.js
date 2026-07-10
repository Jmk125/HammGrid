import { renderShell, openModal, closeModal } from '/js/shell.js';

const projectId = new URLSearchParams(window.location.search).get('projectId');
let allFolders = [];

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

  const folderData = await api('GET', `/api/projects/${projectId}/documents/folders`);
  allFolders = folderData.folders || [];
  const folderSelect = document.getElementById('share-folders');
  for (const f of allFolders) folderSelect.appendChild(new Option(f.name, f.id));

  const { revisions } = await api('GET', `/api/projects/${projectId}/revisions`);
  const revisionSelect = document.getElementById('share-revision');
  for (const r of revisions.filter((r) => r.status === 'published')) {
    revisionSelect.appendChild(new Option(r.title, r.id));
  }

  await loadShares();
}

document.getElementById('share-documents').addEventListener('change', (e) => {
  document.getElementById('share-folders').style.display = e.target.checked ? '' : 'none';
});

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
    allow_personal_markups: document.getElementById('share-personal-markups').checked,
    allow_documents: document.getElementById('share-documents').checked,
    document_folder_ids: [...document.getElementById('share-folders').selectedOptions].map((o) => Number(o.value)),
  };
  const { share } = await api('POST', `/api/projects/${projectId}/shares`, body);
  document.getElementById('new-share-result').textContent =
    `Created: ${window.location.origin}/share.html?token=${share.token}`;
  document.getElementById('share-name').value = '';
  await loadShares();
});

function folderIdsForShare(share) {
  try { return JSON.parse(share.document_folder_ids || '[]'); } catch (e) { return []; }
}

function editPermissions(share) {
  const folderIds = folderIdsForShare(share);
  const backdrop = openModal(`
    <h2>Share permissions</h2>
    <label><input type="checkbox" id="edit-personal" ${share.allow_personal_markups ? 'checked' : ''}> Allow personal markups</label>
    <label><input type="checkbox" id="edit-documents" ${share.allow_documents ? 'checked' : ''}> Allow documents</label>
    <div class="field"><label>Allowed document folders</label>
      <select id="edit-folders" multiple size="8">${allFolders.map((f) => `<option value="${f.id}" ${folderIds.includes(f.id) ? 'selected' : ''}>${escapeShareHtml(f.name)}</option>`).join('')}</select>
    </div>
    <div class="row"><button id="save-permissions" class="primary">Save</button><button id="cancel-permissions">Cancel</button></div>
  `);
  backdrop.querySelector('#cancel-permissions').addEventListener('click', closeModal);
  backdrop.querySelector('#save-permissions').addEventListener('click', async () => {
    await updateShare(share.id, {
      allow_personal_markups: backdrop.querySelector('#edit-personal').checked,
      allow_documents: backdrop.querySelector('#edit-documents').checked,
      document_folder_ids: [...backdrop.querySelector('#edit-folders').selectedOptions].map((o) => Number(o.value)),
    });
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
  await load();
})();
