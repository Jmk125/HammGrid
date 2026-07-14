import { renderShell, openModal, closeModal, showToast, getPendingJobsForProject, untrackPendingJob } from '/js/shell.js';

const projectId = new URLSearchParams(window.location.search).get('projectId');
let currentProject = null;
let currentUser = null;
// jobIds with an active poll loop already running, so a table rebuild
// (loadRevisions() gets called again for lots of reasons - delete, the
// polling loop's own completion, etc.) never starts a second poll for the
// same job.
const activeJobPolls = new Set();

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
    tr.dataset.revisionId = r.id;
    tr.innerHTML = `<td><a href="/revision.html?projectId=${projectId}&revisionId=${r.id}">${r.title}</a></td>
      <td>${r.source || ''}</td>
      <td class="status-cell"><span class="pill ${r.status}">${r.status}</span></td>
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
  startPendingJobPolls();
}

// Shows a live progress bar (reusing revision.js's upload-row-bar look) in
// place of the status pill for any revision that has an upload or OCR-read
// job still running, tracked in this browser via shell.js's
// trackPendingJob() - lets someone who left mid-upload come back to
// project-settings.html and see it's still going, then click through to
// resume review right where they left off (the title link already goes to
// revision.html?revisionId=...).
function startPendingJobPolls() {
  for (const job of getPendingJobsForProject(projectId)) {
    if (activeJobPolls.has(job.jobId)) continue;
    const row = document.querySelector(`#revisions-table tr[data-revision-id="${job.revisionId}"]`);
    if (!row) continue; // this job's revision isn't in the current list for some reason
    activeJobPolls.add(job.jobId);
    pollRevisionJob(job);
  }
}

async function pollRevisionJob(job) {
  for (;;) {
    const cell = document.querySelector(`#revisions-table tr[data-revision-id="${job.revisionId}"] .status-cell`);
    if (!cell) {
      activeJobPolls.delete(job.jobId);
      return;
    }
    let status;
    try {
      ({ job: status } = await api('GET', `/api/projects/${projectId}/revisions/${job.revisionId}/upload-jobs/${job.jobId}`));
    } catch (err) {
      activeJobPolls.delete(job.jobId);
      return;
    }
    if (status.status === 'processing') {
      const pct = status.progress ? Math.round((status.progress.current / status.progress.total) * 100) : 0;
      const label = status.progress ? `${status.progress.current} / ${status.progress.total}` : 'Processing...';
      cell.innerHTML = `
        <div class="row" style="gap:8px; flex-wrap:nowrap;">
          <div class="upload-row-bar" style="width:80px;"><div class="upload-row-fill" style="width:${pct}%;"></div></div>
          <span class="muted">${label}</span>
        </div>`;
    } else {
      activeJobPolls.delete(job.jobId);
      // renderShell() fires off shell.js's own one-shot checkPendingJobs()
      // without awaiting it, so it's technically possible (if narrow) for
      // that check and this poll loop to both observe the same just-
      // finished job - only toast if this poll is the one that actually
      // found it still tracked, so a finish landing in that gap doesn't
      // show the same toast twice.
      const stillTracked = getPendingJobsForProject(projectId).some((j) => j.jobId === job.jobId);
      untrackPendingJob(job.jobId);
      if (stillTracked) {
        if (status.status === 'done') showToast(`${job.label} finished processing.`, 'success');
        else if (status.status === 'error') showToast(`${job.label} failed: ${status.error}`, 'error');
      }
      await loadRevisions();
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
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
