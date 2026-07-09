import { renderShell } from '/js/shell.js';

const projectId = new URLSearchParams(window.location.search).get('projectId');

(async function init() {
  const me = await requireSession();
  if (!me) return;
  await renderShell({
    topbarEl: document.getElementById('topbar'),
    sidebarEl: document.getElementById('sidebar'),
    projectId,
    active: 'activity',
    me,
  });

  try {
    const { activity } = await api('GET', `/api/projects/${projectId}/activity`);
    const tbody = document.querySelector('#activity-table tbody');
    tbody.innerHTML = '';
    for (const a of activity) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${a.created_at}</td>
        <td>${a.actor}</td>
        <td>${a.action}</td>
        <td class="muted">${a.detail ? JSON.stringify(a.detail) : ''}</td>`;
      tbody.appendChild(tr);
    }
  } catch (err) {
    document.getElementById('error').textContent = err.message;
    document.getElementById('error').style.display = 'block';
  }
})();
