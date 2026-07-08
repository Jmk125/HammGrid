const projectId = new URLSearchParams(window.location.search).get('projectId');
document.getElementById('back-link').href = `/project.html?id=${projectId}`;

(async function load() {
  const me = await requireSession();
  if (!me) return;
  document.getElementById('whoami').textContent = `${me.name} (${me.role})`;

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

document.getElementById('logout').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout');
  window.location.href = '/login.html';
});
