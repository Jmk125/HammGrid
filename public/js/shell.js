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
export function confirmModal({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    openModal(`
      <h2>${escapeHtml(title)}</h2>
      ${message ? `<p>${escapeHtml(message)}</p>` : ''}
      <div class="modal-actions">
        <button type="button" id="modal-cancel">${escapeHtml(cancelLabel)}</button>
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



// ---------- Theme + user menu ----------
// Applied on top of the cached-user bootstrap snippet each page's <head> runs
// synchronously (before first paint, reading the same hammgrid:last-user
// localStorage key api.js already maintains) - this call just reconciles
// against whatever /api/auth/me actually returned, in case the setting
// changed on another device since the cached copy was written.
export function applyTheme(settings) {
  const theme = (settings && settings.theme) || 'default';
  document.documentElement.dataset.theme = theme;
  if (settings && settings.darkCanvas) {
    document.documentElement.dataset.canvasInvert = '1';
  } else {
    delete document.documentElement.dataset.canvasInvert;
  }
}

export function openSettingsWindow() {
  const w = 440;
  const h = 520;
  const left = Math.round(window.screenX + (window.outerWidth - w) / 2);
  const top = Math.round(window.screenY + (window.outerHeight - h) / 2);
  const win = window.open(
    '/settings.html',
    'hammgrid-settings',
    `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=yes`
  );
  if (win) win.focus();
}

const CACHED_SESSION_KEY_FOR_THEME = 'hammgrid:last-user';

export function renderUserMenu(container, me) {
  container.innerHTML = `
    <div class="user-menu" id="user-menu">
      <button type="button" id="user-menu-btn">${escapeHtml(me.name)} <span class="chevron">&#9662;</span></button>
      <div class="user-menu-dropdown" id="user-menu-dropdown" style="display:none;">
        <div class="user-menu-role">${escapeHtml(me.role)}</div>
        <button type="button" id="user-menu-settings">Settings</button>
        <button type="button" id="user-menu-logout">Sign out</button>
      </div>
    </div>
  `;
  const dropdown = container.querySelector('#user-menu-dropdown');
  container.querySelector('#user-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
  });
  document.addEventListener('click', () => {
    dropdown.style.display = 'none';
  });
  container.querySelector('#user-menu-settings').addEventListener('click', () => {
    dropdown.style.display = 'none';
    openSettingsWindow();
  });
  container.querySelector('#user-menu-logout').addEventListener('click', async () => {
    await api('POST', '/api/auth/logout');
    window.location.href = '/login.html';
  });

  // Live-apply settings saved from a settings.html popup without a reload.
  window.addEventListener('storage', (e) => {
    if (e.key !== CACHED_SESSION_KEY_FOR_THEME) return;
    try {
      const user = JSON.parse(e.newValue || 'null');
      if (user && String(user.id) === String(me.id)) applyTheme(user.settings);
    } catch (err) {
      // ignore malformed cache value
    }
  });
}

export function renderNetworkIndicator(container) {
  if (!container || container.querySelector('#network-indicator')) return;
  const indicator = document.createElement('span');
  indicator.id = 'network-indicator';
  indicator.className = 'network-indicator';
  container.prepend(indicator);

  function update() {
    const online = navigator.onLine;
    indicator.className = `network-indicator ${online ? 'online' : 'offline'}`;
    indicator.textContent = online ? '● Online' : '● Offline';
    indicator.title = online ? 'Network connection detected' : 'No network connection detected';
  }

  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

// ---------- Per-project sheet history ----------
const SHEET_HISTORY_LIMIT = 10;

function sheetHistoryKey(projectId) {
  return `hammgrid-sheet-history:${projectId}`;
}

function normalizeHistoryEntry(entry) {
  if (!entry || entry.sheetId === undefined || entry.sheetId === null) return null;
  return {
    sheetId: String(entry.sheetId),
    sheetNumber: entry.sheetNumber || 'Sheet',
    title: entry.title || '',
  };
}

function getSheetHistory(projectId) {
  try {
    const raw = JSON.parse(localStorage.getItem(sheetHistoryKey(projectId)) || '[]');
    return Array.isArray(raw) ? raw.map(normalizeHistoryEntry).filter(Boolean).slice(0, SHEET_HISTORY_LIMIT) : [];
  } catch (err) {
    return [];
  }
}

function saveSheetHistory(projectId, history) {
  localStorage.setItem(sheetHistoryKey(projectId), JSON.stringify(history.slice(0, SHEET_HISTORY_LIMIT)));
}

function recordSheetVisit(projectId, entry) {
  const normalized = normalizeHistoryEntry(entry);
  if (!projectId || !normalized) return;
  const history = getSheetHistory(projectId);
  if (history[0] && history[0].sheetId === normalized.sheetId) {
    history[0] = normalized;
    saveSheetHistory(projectId, history);
    return;
  }
  saveSheetHistory(projectId, [normalized, ...history.filter((h) => h.sheetId !== normalized.sheetId)]);
}

function rotateSheetHistoryTo(projectId, sheetId) {
  const history = getSheetHistory(projectId);
  const idx = history.findIndex((h) => h.sheetId === String(sheetId));
  if (idx <= 0) return history;
  const rotated = [...history.slice(idx), ...history.slice(0, idx)].slice(0, SHEET_HISTORY_LIMIT);
  saveSheetHistory(projectId, rotated);
  return rotated;
}

function sheetHref(projectId, sheetId) {
  return `/sheet.html?projectId=${encodeURIComponent(projectId)}&sheetId=${encodeURIComponent(sheetId)}`;
}

function renderSheetHistoryControls(topbarEl, projectId) {
  if (!projectId) return;
  const history = getSheetHistory(projectId);
  const rightRow = topbarEl.querySelector('.topbar-actions');
  if (!rightRow) return;

  const backBtn = document.createElement('button');
  backBtn.id = 'sheet-history-back-btn';
  backBtn.type = 'button';
  backBtn.title = 'Previous sheet';
  backBtn.textContent = '←';
  backBtn.disabled = history.length < 2;
  backBtn.addEventListener('click', () => {
    const latest = getSheetHistory(projectId);
    if (latest.length < 2) return;
    const target = latest[1];
    saveSheetHistory(projectId, [...latest.slice(1), latest[0]].slice(0, SHEET_HISTORY_LIMIT));
    window.location.href = sheetHref(projectId, target.sheetId);
  });

  const wrap = document.createElement('div');
  wrap.className = 'sheet-history-wrap';
  const clockBtn = document.createElement('button');
  clockBtn.id = 'sheet-history-btn';
  clockBtn.type = 'button';
  clockBtn.title = 'Recent sheets';
  clockBtn.textContent = '◷';
  wrap.appendChild(clockBtn);

  const menu = document.createElement('div');
  menu.className = 'sheet-history-menu';
  menu.style.display = 'none';
  if (history.length === 0) {
    menu.innerHTML = '<div class="sheet-history-empty">No recent sheets yet.</div>';
  } else {
    for (const [idx, item] of history.entries()) {
      const a = document.createElement('a');
      a.href = sheetHref(projectId, item.sheetId);
      a.innerHTML = `<b>${escapeHtml(item.sheetNumber)}</b>${item.title ? `<span>${escapeHtml(item.title)}</span>` : ''}`;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        rotateSheetHistoryTo(projectId, item.sheetId);
        window.location.href = a.href;
      });
      if (idx === 0) a.classList.add('current');
      menu.appendChild(a);
    }
  }
  wrap.appendChild(menu);
  clockBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  });
  document.addEventListener('click', () => {
    menu.style.display = 'none';
  });

  rightRow.prepend(wrap);
  rightRow.prepend(backBtn);
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

// For a page that wants to show *live* per-job progress (project-settings.js's
// revisions table), rather than just the one-shot "done/error" toast
// checkPendingJobs() below gives every page. Device-local by design, same as
// the rest of this tracking - there's no server-side "who's watching this
// job" broadcast, so this only ever reflects jobs started from this browser.
export function getPendingJobsForProject(projectId) {
  const jobs = JSON.parse(localStorage.getItem(PENDING_JOBS_KEY) || '[]');
  return jobs.filter((j) => String(j.projectId) === String(projectId));
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

// Job "kinds" tracked here each live under their own status route - upload/OCR
// jobs are scoped to a revision, sheet-link scans to a project. Add a case
// here (and in project-settings.js's own live-progress poll) for any new kind.
function jobStatusUrl(job) {
  if (job.kind === 'sheet-link-scan') return `/api/projects/${job.projectId}/sheet-links/jobs/${job.jobId}`;
  if (job.kind === 'search-index') return `/api/projects/${job.projectId}/sheet-text/jobs/${job.jobId}`;
  return `/api/projects/${job.projectId}/revisions/${job.revisionId}/upload-jobs/${job.jobId}`;
}

export async function checkPendingJobs() {
  const jobs = JSON.parse(localStorage.getItem(PENDING_JOBS_KEY) || '[]');
  for (const job of jobs) {
    try {
      const { job: status } = await api('GET', jobStatusUrl(job));
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

export async function renderShell({
  topbarEl,
  sidebarEl,
  projectId,
  combinedProjectIds,
  active,
  me,
  onOverlayClick,
  sheetHistoryEntry,
}) {
  const canManage = me.role === 'admin' || me.role === 'editor';
  const isCombined = !!combinedProjectIds;
  if (sheetHistoryEntry) recordSheetVisit(projectId, sheetHistoryEntry);
  checkPendingJobs();
  applyTheme(me.settings);

  topbarEl.innerHTML = `
    <div class="row" style="gap:6px;">
      ${sidebarEl ? '<button class="sidebar-toggle" id="sidebar-toggle-btn" type="button">&#9776;</button>' : ''}
      <a class="brand" href="/dashboard.html">HammGrid</a>
    </div>
    <div class="row topbar-actions">
      ${onOverlayClick ? '<button id="overlay-btn" type="button">Overlay</button>' : ''}
      ${projectId && canManage ? '<button class="primary" id="new-revision-btn" type="button">+ New Revision</button>' : ''}
      <div id="user-menu-slot"></div>
    </div>
  `;
  renderUserMenu(topbarEl.querySelector('#user-menu-slot'), me);
  renderNetworkIndicator(topbarEl.querySelector('.topbar-actions'));
  if (active === 'viewer' && projectId) renderSheetHistoryControls(topbarEl, projectId);
  const newRevBtn = topbarEl.querySelector('#new-revision-btn');
  if (newRevBtn) newRevBtn.addEventListener('click', () => newRevisionModal(projectId));
  const overlayBtn = topbarEl.querySelector('#overlay-btn');
  if (overlayBtn) overlayBtn.addEventListener('click', onOverlayClick);

  if (!sidebarEl) return;

  // "View Multiple" (see dashboard.js) - only the three read-only combined
  // views (Sheets/Documents/Flags) exist; everything else in the normal
  // per-project nav (Revisions, Invite, Settings, Take-offs, ...) is a
  // single-project write action that doesn't apply across several projects
  // at once, so combined mode gets its own much shorter item list instead of
  // filtering the single-project one down.
  const items = isCombined
    ? [
        { key: 'viewer', label: 'Sheets', href: `/viewer.html?projectIds=${combinedProjectIds}`, show: true },
        { key: 'documents', label: 'Documents', href: `/documents.html?projectIds=${combinedProjectIds}`, show: true },
        { key: 'flags', label: 'Flags', href: `/flags.html?projectIds=${combinedProjectIds}`, show: true },
      ]
    : [
        { key: 'viewer', label: 'Sheets', href: `/viewer.html?projectId=${projectId}`, show: true },
        { key: 'documents', label: 'Documents', href: `/documents.html?projectId=${projectId}`, show: true },
        { key: 'flags', label: 'Flags', href: `/flags.html?projectId=${projectId}`, show: true },
        { key: 'invite', label: 'Invite', href: `/shares.html?projectId=${projectId}`, show: canManage },
        { key: 'activity', label: 'Activity Log', href: `/activity.html?projectId=${projectId}`, show: me.role === 'admin' },
        { key: 'export', label: 'Export', href: '#', show: true, action: () => exportModal(projectId) },
        { key: 'settings', label: 'Project Settings', href: `/project-settings.html?projectId=${projectId}`, show: canManage },
        { key: 'takeoffs', label: 'Take-offs', href: `/takeoffs.html?projectId=${projectId}`, show: me.role === 'admin' || !!me.can_takeoff },
        { key: 'help', label: 'Help', href: `/help.html?projectId=${projectId}`, show: true },
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
