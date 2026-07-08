const projectId = new URLSearchParams(window.location.search).get('id');

async function load() {
  const me = await requireSession();
  if (!me) return;
  document.getElementById('whoami').textContent = `${me.name} (${me.role})`;
  if (me.role === 'admin' || me.role === 'editor') {
    document.getElementById('new-revision-card').style.display = '';
  }

  const { project } = await api('GET', `/api/projects/${projectId}`);
  document.getElementById('project-name').textContent = project.name;
  document.getElementById('viewer-link').href = `/viewer.html?projectId=${projectId}`;

  const { revisions } = await api('GET', `/api/projects/${projectId}/revisions`);
  const tbody = document.querySelector('#revisions-table tbody');
  tbody.innerHTML = '';
  for (const r of revisions) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><a href="/revision.html?projectId=${projectId}&revisionId=${r.id}">${r.title}</a></td>
      <td>${r.source || ''}</td>
      <td><span class="pill ${r.status}">${r.status}</span></td>
      <td>${r.created_at}</td>`;
    tbody.appendChild(tr);
  }
}

document.getElementById('logout').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout');
  window.location.href = '/login.html';
});

document.getElementById('new-revision-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { revision } = await api('POST', `/api/projects/${projectId}/revisions`, {
    title: document.getElementById('rev-title').value,
    source: document.getElementById('rev-source').value || null,
    date: document.getElementById('rev-date').value || null,
  });
  window.location.href = `/revision.html?projectId=${projectId}&revisionId=${revision.id}`;
});

load();
