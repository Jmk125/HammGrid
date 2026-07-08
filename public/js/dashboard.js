let me;

async function load() {
  me = await requireSession();
  if (!me) return;
  document.getElementById('whoami').textContent = `${me.name} (${me.role})`;
  if (me.role === 'admin') {
    document.getElementById('new-project-card').style.display = '';
  }

  const { projects } = await api('GET', '/api/projects');
  const tbody = document.querySelector('#projects-table tbody');
  tbody.innerHTML = '';
  for (const p of projects) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><a href="/project.html?id=${p.id}">${p.name}</a></td><td>${p.number || ''}</td><td>${p.created_at}</td>`;
    tbody.appendChild(tr);
  }
}

document.getElementById('logout').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout');
  window.location.href = '/login.html';
});

document.getElementById('new-project-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('POST', '/api/projects', {
    name: document.getElementById('project-name').value,
    number: document.getElementById('project-number').value || null,
  });
  document.getElementById('project-name').value = '';
  document.getElementById('project-number').value = '';
  load();
});

load();
