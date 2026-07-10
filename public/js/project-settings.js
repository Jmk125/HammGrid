import { renderShell, openModal, closeModal, showToast } from '/js/shell.js';

const projectId = new URLSearchParams(window.location.search).get('projectId');
let currentProject = null;
let currentUser = null;

async function loadDetails() {
  const { project } = await api('GET', `/api/projects/${projectId}`);
  currentProject = project;
  document.getElementById('s-name').value = project.name || '';
  document.getElementById('s-number').value = project.number || '';
  document.getElementById('s-location').value = project.location || '';
  document.getElementById('s-size').value = project.size || '';
}

function openDeleteConfirm() {
  openModal(`
    <h2 style="color: var(--danger);">Delete "${currentProject.name}"?</h2>
    <p>This permanently deletes all sheets, revisions, markups, documents, and share links for this project. This cannot be undone.</p>
    <div class="field">
      <label>Type the project name to confirm</label>
      <input id="delete-confirm-input" autocomplete="off">
    </div>
    <p class="error" id="delete-error" style="display:none;"></p>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Cancel</button>
      <button class="danger" type="button" id="modal-confirm-delete" disabled>Delete project</button>
    </div>
  `);
  const input = document.getElementById('delete-confirm-input');
  const confirmBtn = document.getElementById('modal-confirm-delete');
  input.addEventListener('input', () => {
    confirmBtn.disabled = input.value !== currentProject.name;
  });
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    try {
      await api('DELETE', `/api/projects/${projectId}`, { confirm_name: input.value });
      window.location.href = '/dashboard.html';
    } catch (err) {
      const errEl = document.getElementById('delete-error');
      errEl.textContent = err.message;
      errEl.style.display = 'block';
      confirmBtn.disabled = false;
    }
  });
}

function openDeleteRevisionConfirm(revision) {
  openModal(`
    <h2 style="color: var(--danger);">Delete "${revision.title}"?</h2>
    <p>This permanently deletes every drawing this revision published (or reassigns them back to their prior version, if one exists). This cannot be undone.</p>
    <div class="field">
      <label>Type the revision title to confirm</label>
      <input id="delete-rev-confirm-input" autocomplete="off">
    </div>
    <p class="error" id="delete-rev-error" style="display:none;"></p>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Cancel</button>
      <button class="danger" type="button" id="modal-confirm-delete-rev" disabled>Delete revision</button>
    </div>
  `);
  const input = document.getElementById('delete-rev-confirm-input');
  const confirmBtn = document.getElementById('modal-confirm-delete-rev');
  input.addEventListener('input', () => {
    confirmBtn.disabled = input.value !== revision.title;
  });
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    try {
      await api('DELETE', `/api/projects/${projectId}/revisions/${revision.id}`, { confirm_name: input.value });
      closeModal();
      showToast(`Revision "${revision.title}" deleted.`, 'success');
      await loadRevisions();
    } catch (err) {
      const errEl = document.getElementById('delete-rev-error');
      errEl.textContent = err.message;
      errEl.style.display = 'block';
      confirmBtn.disabled = false;
    }
  });
}

async function loadRevisions() {
  const { revisions } = await api('GET', `/api/projects/${projectId}/revisions`);
  const canManage = currentUser && (currentUser.role === 'admin' || currentUser.role === 'editor');
  const isAdmin = currentUser && currentUser.role === 'admin';
  const tbody = document.querySelector('#revisions-table tbody');
  tbody.innerHTML = '';
  for (const r of revisions) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><a href="/revision.html?projectId=${projectId}&revisionId=${r.id}">${r.title}</a></td>
      <td>${r.source || ''}</td>
      <td><span class="pill ${r.status}">${r.status}</span></td>
      <td>${r.created_at}</td>
      <td class="row"></td>`;

    const actions = tr.lastElementChild;
    if (canManage) {
      const modifyBtn = document.createElement('button');
      modifyBtn.type = 'button';
      modifyBtn.textContent = 'Modify';
      modifyBtn.addEventListener('click', () => {
        window.location.href = `/revision.html?projectId=${projectId}&revisionId=${r.id}`;
      });
      actions.appendChild(modifyBtn);
    }
    if (isAdmin) {
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'danger';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', () => openDeleteRevisionConfirm(r));
      actions.appendChild(deleteBtn);
    }

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
  currentUser = me;
  await renderShell({
    topbarEl: document.getElementById('topbar'),
    sidebarEl: document.getElementById('sidebar'),
    projectId,
    active: 'settings',
    me,
  });
  await loadDetails();
  await loadRevisions();

  if (me.role === 'admin') {
    document.getElementById('danger-zone').style.display = '';
    document.getElementById('delete-project-btn').addEventListener('click', openDeleteConfirm);
  }
})();
