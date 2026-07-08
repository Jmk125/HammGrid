const projectId = new URLSearchParams(window.location.search).get('projectId');
document.getElementById('back-link').href = `/project.html?id=${projectId}`;

async function loadShell() {
  const me = await requireSession();
  if (!me) return null;
  document.getElementById('whoami').textContent = `${me.name} (${me.role})`;
  return me;
}

async function loadFilters() {
  const { project } = await api('GET', `/api/projects/${projectId}`);
  document.getElementById('project-name').textContent = project.name;

  const disciplines = [...new Set(Object.values(project.discipline_prefix_map))].sort();
  const disciplineSelect = document.getElementById('discipline-filter');
  for (const d of disciplines) {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = d;
    disciplineSelect.appendChild(opt);
  }

  const { revisions } = await api('GET', `/api/projects/${projectId}/revisions`);
  const revisionSelect = document.getElementById('revision-filter');
  for (const r of revisions.filter((r) => r.status === 'published')) {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = r.title;
    revisionSelect.appendChild(opt);
  }
}

async function loadGrid() {
  const discipline = document.getElementById('discipline-filter').value;
  const revisionId = document.getElementById('revision-filter').value;
  const qs = new URLSearchParams();
  if (discipline) qs.set('discipline', discipline);
  if (revisionId) qs.set('revision_id', revisionId);

  const { sheets } = await api('GET', `/api/projects/${projectId}/sheets?${qs}`);
  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  document.getElementById('empty-msg').style.display = sheets.length ? 'none' : '';

  for (const s of sheets) {
    const a = document.createElement('a');
    a.className = 'sheet-card';
    a.href = `/sheet.html?projectId=${projectId}&sheetId=${s.id}`;
    a.innerHTML = `
      <img src="/api/sheet-versions/${s.current_version_id}/thumb" loading="lazy">
      <div class="meta">
        <div class="sheet-number">${s.sheet_number}</div>
        <div class="sheet-title">${s.current_title || ''}</div>
      </div>`;
    grid.appendChild(a);
  }
}

document.getElementById('discipline-filter').addEventListener('change', loadGrid);
document.getElementById('revision-filter').addEventListener('change', loadGrid);

document.getElementById('logout').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout');
  window.location.href = '/login.html';
});

(async function init() {
  const me = await loadShell();
  if (!me) return;
  await loadFilters();
  await loadGrid();
})();
