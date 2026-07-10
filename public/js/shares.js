import { renderShell } from '/js/shell.js';

const projectId = new URLSearchParams(window.location.search).get('projectId');

function escapeHtml(str) {
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

  const { revisions } = await api('GET', `/api/projects/${projectId}/revisions`);
  const revisionSelect = document.getElementById('share-revision');
  for (const r of revisions.filter((r) => r.status === 'published')) {
    revisionSelect.appendChild(new Option(r.title, r.id));
  }

  await loadShares();
}

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
      <td>${escapeHtml(s.name) || '<span class="muted">Unnamed</span>'}</td>
      <td>${escapeHtml(s.scope)}${s.snapshot_revision_title ? ` (${escapeHtml(s.snapshot_revision_title)})` : ''}</td>
      <td>${escapeHtml(s.discipline_filter) || 'All'}</td>
      <td>${escapeHtml(s.expires_at) || 'Never'}</td>
      <td>${escapeHtml(s.created_by_name)}</td>
      <td><span class="pill ${status === 'active' ? 'new' : 'suspicious'}">${status}</span></td>
      <td><input readonly value="${escapeHtml(url)}" style="width:260px" onclick="this.select()"></td>
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
  };
  const { share } = await api('POST', `/api/projects/${projectId}/shares`, body);
  document.getElementById('new-share-result').textContent =
    `Created: ${window.location.origin}/share.html?token=${share.token}`;
  document.getElementById('share-name').value = '';
  await loadShares();
});

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
