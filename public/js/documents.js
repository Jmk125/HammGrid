import { renderShell } from '/js/shell.js';

const projectId = new URLSearchParams(window.location.search).get('projectId');
let currentUser = null;

async function load() {
  if (currentUser.role === 'admin' || currentUser.role === 'editor') {
    document.getElementById('new-doc-card').style.display = '';
  }

  const { documents } = await api('GET', `/api/projects/${projectId}/documents`);
  const tbody = document.querySelector('#documents-table tbody');
  tbody.innerHTML = '';
  for (const d of documents) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${d.kind.toUpperCase()}</td>
      <td>${d.number || ''}</td>
      <td>${d.title || ''}</td>
      <td>${d.date || ''}</td>
      <td>${d.status || ''}</td>
      <td><a href="/api/documents/${d.id}/pdf" target="_blank">Open PDF</a></td>`;
    tbody.appendChild(tr);
  }
}

document.getElementById('new-doc-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const formData = new FormData();
  formData.append('kind', document.getElementById('doc-kind').value);
  formData.append('number', document.getElementById('doc-number').value);
  formData.append('title', document.getElementById('doc-title').value);
  formData.append('date', document.getElementById('doc-date').value);
  formData.append('status', document.getElementById('doc-status').value);
  formData.append('file', document.getElementById('doc-file').files[0]);

  const res = await fetch(`/api/projects/${projectId}/documents`, { method: 'POST', body: formData });
  const data = await res.json();
  if (!res.ok) {
    alert(`Upload failed: ${data.error}`);
    return;
  }
  document.getElementById('new-doc-form').reset();
  load();
});

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
  await load();
})();
