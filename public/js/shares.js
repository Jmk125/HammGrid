const projectId = new URLSearchParams(window.location.search).get('projectId');
document.getElementById('back-link').href = `/project.html?id=${projectId}`;

async function load() {
  const me = await requireSession();
  if (!me) return;
  document.getElementById('whoami').textContent = `${me.name} (${me.role})`;

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

async function loadShares() {
  const { shares } = await api('GET', `/api/projects/${projectId}/shares`);
  const tbody = document.querySelector('#shares-table tbody');
  tbody.innerHTML = '';
  for (const s of shares) {
    const url = `${window.location.origin}/share.html?token=${s.token}`;
    const status = s.revoked ? 'revoked' : s.expires_at && s.expires_at < new Date().toISOString() ? 'expired' : 'active';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${s.scope}${s.snapshot_revision_title ? ` (${s.snapshot_revision_title})` : ''}</td>
      <td>${s.discipline_filter || 'All'}</td>
      <td>${s.expires_at || 'Never'}</td>
      <td>${s.created_by_name}</td>
      <td><span class="pill ${status === 'active' ? 'new' : 'suspicious'}">${status}</span></td>
      <td><input readonly value="${url}" style="width:260px" onclick="this.select()"></td>
      <td></td>`;
    if (status === 'active') {
      const btn = document.createElement('button');
      btn.className = 'danger';
      btn.textContent = 'Revoke';
      btn.addEventListener('click', async () => {
        if (!confirm('Revoke this share link? It will stop working immediately.')) return;
        await api('PATCH', `/api/projects/${projectId}/shares/${s.id}/revoke`);
        loadShares();
      });
      tr.lastElementChild.appendChild(btn);
    }
    tbody.appendChild(tr);
  }
}

document.getElementById('new-share-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const scope = document.getElementById('share-scope').value;
  const body = {
    scope,
    snapshot_revision_id: scope === 'snapshot' ? Number(document.getElementById('share-revision').value) : null,
    discipline_filter: document.getElementById('share-discipline').value || null,
    expires_at: document.getElementById('share-expires').value || null,
  };
  const { share } = await api('POST', `/api/projects/${projectId}/shares`, body);
  document.getElementById('new-share-result').textContent =
    `Created: ${window.location.origin}/share.html?token=${share.token}`;
  await loadShares();
});

document.getElementById('logout').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout');
  window.location.href = '/login.html';
});

load();
