// Shared top bar + sidebar shell for every project-context page (viewer,
// sheet, documents, shares, activity, project-settings). Centralized here
// instead of duplicated per-page HTML so nav/branding changes happen once.

export function openModal(innerHtml) {
  closeModal();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal">${innerHtml}</div>`;
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });
  document.body.appendChild(backdrop);
  return backdrop;
}

export function closeModal() {
  document.querySelectorAll('.modal-backdrop').forEach((el) => el.remove());
}

// navigator.clipboard.writeText() needs a secure context (HTTPS, or
// localhost) and can be denied outright by browser/OS permissions - this
// app is described in CLAUDE.md as served over the office LAN / a Pi, which
// may well be plain HTTP, so the modern API is not guaranteed to work in
// production. Falls back to the old hidden-textarea + execCommand trick,
// which works without any permission grant or secure-context requirement.
export async function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      // fall through to the legacy fallback below
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (err) {
    ok = false;
  }
  textarea.remove();
  return ok;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Promise-based replacement for the native alert() dialog - a single-button
// acknowledgment (no cancel), for cases like "Published 12 sheet(s)" where a
// yes/no confirm doesn't fit but the caller still needs to wait for the user
// to dismiss it before moving on (e.g. before navigating away).
export function alertModal({ title = 'Notice', message = '', okLabel = 'OK' } = {}) {
  return new Promise((resolve) => {
    openModal(`
      <h2>${escapeHtml(title)}</h2>
      ${message ? `<p>${escapeHtml(message)}</p>` : ''}
      <div class="modal-actions">
        <button class="primary" type="button" id="modal-confirm">${escapeHtml(okLabel)}</button>
      </div>
    `);
    document.getElementById('modal-confirm').addEventListener('click', () => {
      closeModal();
      resolve();
    });
  });
}

// Promise-based replacement for the native confirm() dialog - resolves true/false,
// styled like the rest of the app instead of a jarring native browser popup.
export function confirmModal({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    openModal(`
      <h2>${escapeHtml(title)}</h2>
      ${message ? `<p>${escapeHtml(message)}</p>` : ''}
      <div class="modal-actions">
        <button type="button" id="modal-cancel">Cancel</button>
        <button type="button" id="modal-confirm" class="${danger ? 'danger' : 'primary'}">${escapeHtml(confirmLabel)}</button>
      </div>
    `);
    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      closeModal();
      resolve(value);
    };
    document.getElementById('modal-cancel').addEventListener('click', () => finish(false));
    document.getElementById('modal-confirm').addEventListener('click', () => finish(true));
  });
}

// Promise-based replacement for the native prompt() dialog - resolves the
// trimmed string, or null if cancelled.
export function promptModal({ title = 'Enter a value', message = '', placeholder = '', defaultValue = '', confirmLabel = 'OK', required = true } = {}) {
  return new Promise((resolve) => {
    openModal(`
      <h2>${escapeHtml(title)}</h2>
      ${message ? `<p class="muted">${escapeHtml(message)}</p>` : ''}
      <div class="field">
        <input id="modal-prompt-input" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(defaultValue)}">
      </div>
      <p class="error" id="modal-prompt-error" style="display:none;"></p>
      <div class="modal-actions">
        <button type="button" id="modal-cancel">Cancel</button>
        <button class="primary" type="button" id="modal-confirm">${escapeHtml(confirmLabel)}</button>
      </div>
    `);
    let resolved = false;
    const input = document.getElementById('modal-prompt-input');
    input.focus();
    input.select();
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      closeModal();
      resolve(value);
    };
    document.getElementById('modal-cancel').addEventListener('click', () => finish(null));
    function submit() {
      const value = input.value.trim();
      if (required && !value) {
        const err = document.getElementById('modal-prompt-error');
        err.textContent = 'This field is required.';
        err.style.display = 'block';
        return;
      }
      finish(value);
    }
    document.getElementById('modal-confirm').addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
  });
}

// ---------- Toasts + cross-page background job notifications ----------
// There's no push/background-sync infrastructure here (deliberately - it's
// unreliable on iOS Safari, the actual field-use target per CLAUDE.md), so
// "notify me after I navigate away" is approximated: any upload/burst job
// gets tracked in localStorage, and every page that calls renderShell() (or
// dashboard's own init) checks pending jobs once on load. If the user never
// reloads/navigates while a job finishes, they won't see a toast until they
// do - a real but honest limitation of not having true background push.
const PENDING_JOBS_KEY = 'hammgrid-pending-jobs';

export function trackPendingJob(job) {
  const jobs = JSON.parse(localStorage.getItem(PENDING_JOBS_KEY) || '[]');
  jobs.push(job);
  localStorage.setItem(PENDING_JOBS_KEY, JSON.stringify(jobs));
}

export function untrackPendingJob(jobId) {
  const jobs = JSON.parse(localStorage.getItem(PENDING_JOBS_KEY) || '[]');
  localStorage.setItem(PENDING_JOBS_KEY, JSON.stringify(jobs.filter((j) => j.jobId !== jobId)));
}

function getToastContainer() {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  return container;
}

export function showToast(message, type = 'info') {
  const container = getToastContainer();
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, 6000);
}

export async function checkPendingJobs() {
  const jobs = JSON.parse(localStorage.getItem(PENDING_JOBS_KEY) || '[]');
  for (const job of jobs) {
    try {
      const { job: status } = await api(
        'GET',
        `/api/projects/${job.projectId}/revisions/${job.revisionId}/upload-jobs/${job.jobId}`
      );
      if (status.status === 'done') {
        showToast(`${job.label} finished processing.`, 'success');
        untrackPendingJob(job.jobId);
      } else if (status.status === 'error') {
        showToast(`${job.label} failed: ${status.error}`, 'error');
        untrackPendingJob(job.jobId);
      }
    } catch (err) {
      untrackPendingJob(job.jobId); // job expired/server restarted - stop tracking it
    }
  }
}

function newRevisionModal(projectId) {
  openModal(`
    <h2>New revision</h2>
    <div class="field">
      <label>Title</label>
      <input id="modal-rev-title" placeholder="e.g. Revision 0, ASI-014">
    </div>
    <div class="field">
      <label>Source (optional)</label>
      <input id="modal-rev-source" placeholder="e.g. ASI-014">
    </div>
    <div class="field">
      <label>Date</label>
      <input id="modal-rev-date" type="date">
    </div>
    <p class="error" id="modal-error" style="display:none;"></p>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Cancel</button>
      <button class="primary" type="button" id="modal-create">Create</button>
    </div>
  `);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-create').addEventListener('click', async () => {
    const title = document.getElementById('modal-rev-title').value.trim();
    if (!title) {
      const err = document.getElementById('modal-error');
      err.textContent = 'Title is required.';
      err.style.display = 'block';
      return;
    }
    const { revision } = await api('POST', `/api/projects/${projectId}/revisions`, {
      title,
      source: document.getElementById('modal-rev-source').value || null,
      date: document.getElementById('modal-rev-date').value || null,
    });
    window.location.href = `/revision.html?projectId=${projectId}&revisionId=${revision.id}`;
  });
}

function exportModal(projectId) {
  openModal(`
    <h2>Export drawings</h2>
    <p class="muted">Downloads the current published set.</p>
    <div class="row" style="flex-direction:column; align-items:stretch;">
      <a href="/api/projects/${projectId}/export/zip"><button style="width:100%;">Download ZIP</button></a>
      <a href="/api/projects/${projectId}/export/merged-pdf"><button style="width:100%;">Download merged PDF</button></a>
    </div>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Close</button>
    </div>
  `);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
}

export async function renderShell({ topbarEl, sidebarEl, projectId, active, me, onOverlayClick }) {
  const canManage = me.role === 'admin' || me.role === 'editor';
  checkPendingJobs();

  topbarEl.innerHTML = `
    <div class="row" style="gap:6px;">
      ${sidebarEl ? '<button class="sidebar-toggle" id="sidebar-toggle-btn" type="button">&#9776;</button>' : ''}
      <a class="brand" href="/dashboard.html">HammGrid</a>
    </div>
    <div class="row">
      ${onOverlayClick ? '<button id="overlay-btn" type="button">Overlay</button>' : ''}
      ${projectId && canManage ? '<button class="primary" id="new-revision-btn" type="button">+ New Revision</button>' : ''}
      <span id="whoami" class="muted"></span>
      <button id="logout" type="button">Sign out</button>
    </div>
  `;
  topbarEl.querySelector('#whoami').textContent = `${me.name} (${me.role})`;
  topbarEl.querySelector('#logout').addEventListener('click', async () => {
    await api('POST', '/api/auth/logout');
    window.location.href = '/login.html';
  });
  const newRevBtn = topbarEl.querySelector('#new-revision-btn');
  if (newRevBtn) newRevBtn.addEventListener('click', () => newRevisionModal(projectId));
  const overlayBtn = topbarEl.querySelector('#overlay-btn');
  if (overlayBtn) overlayBtn.addEventListener('click', onOverlayClick);

  if (!sidebarEl) return;

  const items = [
    { key: 'viewer', label: 'Sheets', href: `/viewer.html?projectId=${projectId}`, show: true },
    { key: 'documents', label: 'Documents', href: `/documents.html?projectId=${projectId}`, show: true },
    { key: 'invite', label: 'Invite', href: `/shares.html?projectId=${projectId}`, show: canManage },
    { key: 'activity', label: 'Activity Log', href: `/activity.html?projectId=${projectId}`, show: me.role === 'admin' },
    { key: 'export', label: 'Export', href: '#', show: true, action: () => exportModal(projectId) },
    { key: 'settings', label: 'Project Settings', href: `/project-settings.html?projectId=${projectId}`, show: canManage },
  ];

  sidebarEl.innerHTML = `
    <nav>
      <a href="/dashboard.html">&larr; Back to projects</a>
      ${items
        .filter((i) => i.show)
        .map((i) => `<a href="${i.href}" data-key="${i.key}" class="${i.key === active ? 'active' : ''}">${i.label}</a>`)
        .join('')}
    </nav>
  `;

  const exportLink = sidebarEl.querySelector('[data-key="export"]');
  if (exportLink) {
    exportLink.addEventListener('click', (e) => {
      e.preventDefault();
      exportModal(projectId);
    });
  }

  const toggleBtn = topbarEl.querySelector('#sidebar-toggle-btn');
  if (toggleBtn) {
    const collapsedKey = 'sidebar-collapsed';
    if (localStorage.getItem(collapsedKey) === '1') sidebarEl.classList.add('collapsed');
    toggleBtn.addEventListener('click', () => {
      sidebarEl.classList.toggle('collapsed');
      localStorage.setItem(collapsedKey, sidebarEl.classList.contains('collapsed') ? '1' : '0');
    });
  }
}
