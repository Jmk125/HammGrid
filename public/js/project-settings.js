import { renderShell } from '/js/shell.js';

const projectId = new URLSearchParams(window.location.search).get('projectId');

async function loadDetails() {
  const { project } = await api('GET', `/api/projects/${projectId}`);
  document.getElementById('s-name').value = project.name || '';
  document.getElementById('s-number').value = project.number || '';
  document.getElementById('s-location').value = project.location || '';
  document.getElementById('s-size').value = project.size || '';
}

async function loadRevisions() {
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

document.getElementById('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById('save-status');
  try {
    await api('PUT', `/api/projects/${projectId}`, {
      name: document.getElementById('s-name').value,
      number: document.getElementById('s-number').value || null,
      location: document.getElementById('s-location').value || null,
      size: document.getElementById('s-size').value || null,
    });
    statusEl.textContent = 'Saved.';
  } catch (err) {
    statusEl.textContent = `Failed: ${err.message}`;
  }
});

(async function init() {
  const me = await requireSession();
  if (!me) return;
  await renderShell({
    topbarEl: document.getElementById('topbar'),
    sidebarEl: document.getElementById('sidebar'),
    projectId,
    active: 'settings',
    me,
  });
  await loadDetails();
  await loadRevisions();
})();
