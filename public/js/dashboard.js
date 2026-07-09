import { openModal, closeModal, checkPendingJobs } from '/js/shell.js';

let me;

function renderTopbar() {
  const topbar = document.getElementById('topbar');
  topbar.innerHTML = `
    <a class="brand" href="/dashboard.html">HammGrid</a>
    <div class="row">
      ${me.role === 'admin' ? '<button class="icon-btn" id="new-project-btn" type="button" title="New project">+</button>' : ''}
      <span id="whoami" class="muted"></span>
      <button id="logout" type="button">Sign out</button>
    </div>
  `;
  topbar.querySelector('#whoami').textContent = `${me.name} (${me.role})`;
  topbar.querySelector('#logout').addEventListener('click', async () => {
    await api('POST', '/api/auth/logout');
    window.location.href = '/login.html';
  });
  const newBtn = topbar.querySelector('#new-project-btn');
  if (newBtn) newBtn.addEventListener('click', openNewProjectModal);
}

function openNewProjectModal() {
  openModal(`
    <h2>New project</h2>
    <div class="field"><label>Name</label><input id="np-name" placeholder="e.g. Lincoln Elementary"></div>
    <div class="field"><label>Job number (optional)</label><input id="np-number"></div>
    <div class="field"><label>Location (optional)</label><input id="np-location" placeholder="e.g. Columbus, OH"></div>
    <div class="field"><label>Size (optional)</label><input id="np-size" placeholder="e.g. 45,000 SF"></div>
    <p class="error" id="np-error" style="display:none;"></p>
    <div class="modal-actions">
      <button type="button" id="np-cancel">Cancel</button>
      <button class="primary" type="button" id="np-create">Create</button>
    </div>
  `);
  document.getElementById('np-cancel').addEventListener('click', closeModal);
  document.getElementById('np-create').addEventListener('click', async () => {
    const name = document.getElementById('np-name').value.trim();
    if (!name) {
      const err = document.getElementById('np-error');
      err.textContent = 'Name is required.';
      err.style.display = 'block';
      return;
    }
    const { project } = await api('POST', '/api/projects', {
      name,
      number: document.getElementById('np-number').value || null,
      location: document.getElementById('np-location').value || null,
      size: document.getElementById('np-size').value || null,
    });
    closeModal();
    window.location.href = `/viewer.html?projectId=${project.id}`;
  });
}

async function loadProjects() {
  const { projects } = await api('GET', '/api/projects');
  const grid = document.getElementById('project-grid');
  grid.innerHTML = '';
  document.getElementById('empty-msg').style.display = projects.length ? 'none' : '';

  for (const p of projects) {
    const a = document.createElement('a');
    a.className = 'project-card';
    a.href = `/viewer.html?projectId=${p.id}`;
    const metaParts = [p.number, p.location, p.size].filter(Boolean).join(' &middot; ');
    a.innerHTML = `
      <div class="thumb-wrap">
        ${p.first_thumbnail_url ? `<img src="${p.first_thumbnail_url}">` : '<span class="placeholder">No drawings yet</span>'}
      </div>
      <div class="body">
        <div class="project-name">${p.name}</div>
        <div class="project-meta">${metaParts}</div>
      </div>`;
    grid.appendChild(a);
  }
}

(async function init() {
  me = await requireSession();
  if (!me) return;
  renderTopbar();
  await loadProjects();
  checkPendingJobs();
})();
