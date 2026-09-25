// New project -> "Import from..." (see routes/imports.routes.js). Three steps
// on one page, keyed by the URL so a reload (or coming back later) lands on
// the right one:
//   ?source=planswift   browse that source's jobs and pick one
//   ?importId=<uuid>    conversion progress, then the review/import screen
import { renderUserMenu, renderNetworkIndicator, applyTheme, confirmModal } from '/js/shell.js';

const params = new URLSearchParams(window.location.search);
const POLL_MS = 1500;

let me;
let pollTimer = null;

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showError(msg) {
  const el = document.getElementById('import-error');
  el.textContent = msg || '';
  el.style.display = msg ? 'block' : 'none';
}

function showStep(step) {
  for (const id of ['browse-step', 'progress-step', 'review-step']) {
    document.getElementById(id).style.display = id === step ? '' : 'none';
  }
}

function renderTopbar() {
  applyTheme(me.settings);
  const topbar = document.getElementById('topbar');
  topbar.innerHTML = `
    <a class="brand" href="/dashboard.html">HammGrid</a>
    <div class="row topbar-actions">
      <div id="user-menu-slot"></div>
    </div>
  `;
  renderUserMenu(topbar.querySelector('#user-menu-slot'), me);
  renderNetworkIndicator(topbar.querySelector('.topbar-actions'));
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

// ---------- Step 1: browse ----------

let browseEntries = [];

async function loadResumable() {
  try {
    const { imports } = await api('GET', '/api/imports');
    const card = document.getElementById('resume-card');
    card.style.display = imports.length ? '' : 'none';
    document.getElementById('resume-rows').innerHTML = imports
      .map((imp) => {
        const state =
          imp.status === 'ready'
            ? '<span class="pill replacement">Ready to review</span>'
            : imp.status === 'error'
              ? '<span class="pill suspicious">Failed</span>'
              : `<span class="pill pending">Converting${imp.progress ? ` ${imp.progress.current}/${imp.progress.total}` : ''}</span>`;
        return `<tr>
          <td><strong>${escapeHtml(imp.job_name)}</strong> <span class="muted">${escapeHtml(imp.job_description || '')}</span></td>
          <td>${escapeHtml(imp.source_label)}</td>
          <td>${state}</td>
          <td style="text-align:right;"><a href="/import.html?importId=${encodeURIComponent(imp.id)}">Open</a></td>
        </tr>`;
      })
      .join('');
  } catch (err) {
    // Resuming is a convenience; browsing still works without it.
  }
}

async function browse(source, relPath) {
  showError('');
  let data;
  try {
    data = await api('GET', `/api/imports/sources/${encodeURIComponent(source)}/browse?path=${encodeURIComponent(relPath || '')}`);
  } catch (err) {
    showError(err.message);
    return;
  }
  browseEntries = data.entries;

  const crumbs = document.getElementById('browse-crumbs');
  const parts = data.path ? data.path.split('/') : [];
  crumbs.innerHTML =
    `<a href="#" data-path="">Jobs</a>` +
    parts
      .map((p, i) => ` <span class="muted">/</span> <a href="#" data-path="${escapeHtml(parts.slice(0, i + 1).join('/'))}">${escapeHtml(p)}</a>`)
      .join('');
  for (const a of crumbs.querySelectorAll('a')) {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      browse(source, a.dataset.path);
    });
  }
  document.getElementById('browse-filter').value = '';
  renderBrowseRows(source);
}

function renderBrowseRows(source) {
  const filter = document.getElementById('browse-filter').value.trim().toLowerCase();
  const rows = browseEntries.filter(
    (e) => !filter || `${e.name} ${e.job_name || ''} ${e.description || ''}`.toLowerCase().includes(filter)
  );
  const tbody = document.getElementById('browse-rows');
  tbody.innerHTML = rows
    .map(
      (e, i) => `<tr>
        <td>${e.kind === 'job' ? `<strong>${escapeHtml(e.job_name || e.name)}</strong>` : `<a href="#" data-i="${i}" class="browse-folder">&#128193; ${escapeHtml(e.name)}</a>`}</td>
        <td class="muted">${escapeHtml(e.description || '')}</td>
        <td class="muted">${formatDate(e.modified)}</td>
        <td style="text-align:right;">${e.kind === 'job' ? `<button type="button" class="primary browse-pick" data-i="${i}">Select</button>` : ''}</td>
      </tr>`
    )
    .join('');
  const empty = document.getElementById('browse-empty');
  empty.style.display = rows.length ? 'none' : '';
  empty.textContent = browseEntries.length ? 'No jobs match the filter.' : 'No job folders here.';

  for (const a of tbody.querySelectorAll('.browse-folder')) {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      browse(source, rows[Number(a.dataset.i)].path);
    });
  }
  for (const btn of tbody.querySelectorAll('.browse-pick')) {
    btn.addEventListener('click', () => startConversion(source, rows[Number(btn.dataset.i)], btn));
  }
}

async function startConversion(source, entry, btn) {
  btn.disabled = true;
  showError('');
  try {
    const { import_id } = await api('POST', `/api/imports/sources/${encodeURIComponent(source)}/convert`, { path: entry.path });
    window.history.replaceState(null, '', `/import.html?importId=${encodeURIComponent(import_id)}`);
    openImport(import_id);
  } catch (err) {
    btn.disabled = false;
    showError(err.message);
  }
}

async function initBrowse(source) {
  let sources;
  try {
    ({ sources } = await api('GET', '/api/imports/sources'));
  } catch (err) {
    showError(err.message);
    return;
  }
  const src = sources.find((s) => s.id === source);
  if (!src) return showError(`Unknown import source "${source}".`);
  document.getElementById('import-heading').textContent = `Import from ${src.label}`;
  if (!src.configured) return showError(`${src.label} import is not configured on this server.`);
  showStep('browse-step');
  document.getElementById('browse-filter').addEventListener('input', () => renderBrowseRows(source));
  loadResumable();
  await browse(source, '');
}

// ---------- Steps 2 + 3: progress, then review ----------

async function cancelImport(importId) {
  const ok = await confirmModal({
    title: 'Cancel import?',
    message: 'The converted files are deleted and no project is created.',
    confirmLabel: 'Cancel import',
    cancelLabel: 'Keep',
    danger: true,
  });
  if (!ok) return;
  clearTimeout(pollTimer);
  try {
    await api('DELETE', `/api/imports/${encodeURIComponent(importId)}`);
  } catch (err) {
    // Already gone (e.g. cleaned up) - nothing left to cancel.
  }
  window.location.href = '/dashboard.html';
}

async function openImport(importId) {
  clearTimeout(pollTimer);
  let data;
  try {
    data = await api('GET', `/api/imports/${encodeURIComponent(importId)}`);
  } catch (err) {
    showStep(null);
    showError(err.message);
    return;
  }
  const imp = data.import;
  document.getElementById('import-heading').textContent = `Import from ${imp.source_label}: ${imp.job_name}`;

  if (imp.status === 'converting') {
    showStep('progress-step');
    const p = imp.progress;
    const pct = p && p.total ? Math.round((p.current / p.total) * 100) : 0;
    document.getElementById('progress-fill').style.width = `${pct}%`;
    document.getElementById('progress-label').textContent =
      p && p.total ? `Converting page ${p.current} of ${p.total}…` : 'Waiting to start…';
    pollTimer = setTimeout(() => openImport(importId), POLL_MS);
    return;
  }
  if (imp.status === 'error' || imp.status === 'cancelled') {
    showStep('progress-step');
    document.getElementById('progress-label').textContent = imp.status === 'cancelled' ? 'This import was cancelled.' : 'Conversion failed.';
    document.getElementById('progress-fill').style.width = '0%';
    showError(imp.error || '');
    return;
  }
  renderReview(importId, imp, data.review);
}

function renderReview(importId, imp, review) {
  showStep('review-step');
  const nameEl = document.getElementById('review-name');
  const numberEl = document.getElementById('review-number');
  nameEl.value = review.defaults.name || '';
  numberEl.value = review.defaults.number || '';

  const s = review.stats;
  const stat = (value, label) => `<div class="import-stat"><div class="import-stat-value">${value}</div><div class="muted">${label}</div></div>`;
  document.getElementById('review-stats').innerHTML = [
    stat(s.sheets, `sheets (${s.scaled} scaled)`),
    stat(s.items, 'take-off items'),
    stat(s.instances, 'instances'),
    stat(s.cutouts, 'cutouts'),
    stat(s.skippedShapes, 'shapes skipped'),
  ].join('');

  const warnings = review.warnings || [];
  document.getElementById('review-warnings-card').style.display = warnings.length ? '' : 'none';
  document.getElementById('review-warnings-summary').textContent = `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`;
  document.getElementById('review-warnings').innerHTML = warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('');

  const sheets = [...review.sheets].sort((a, b) => naturalSheetCompare(a.sheet_number, b.sheet_number));
  document.getElementById('review-sheets').innerHTML = sheets
    .map(
      (sh) => `<tr>
        <td>${sh.has_thumb ? `<img class="doc-thumb" loading="lazy" src="/api/imports/${encodeURIComponent(importId)}/sheets/${encodeURIComponent(sh.key)}/thumb">` : ''}</td>
        <td><strong>${escapeHtml(sh.sheet_number)}</strong></td>
        <td>${escapeHtml(sh.title || '')}</td>
        <td class="muted">${escapeHtml(sh.folder || '')}</td>
        <td>${sh.scaled ? escapeHtml(sh.scale_label || 'Scaled') : '<span class="muted">Not scaled</span>'}${sh.has_pdf ? '' : ' <span class="pill suspicious">No image - skipped</span>'}</td>
      </tr>`
    )
    .join('');

  document.getElementById('review-cancel').onclick = () => cancelImport(importId);
  document.getElementById('review-import').onclick = async () => {
    const name = nameEl.value.trim();
    if (!name) return showError('Project name is required.');
    showError('');
    const btn = document.getElementById('review-import');
    btn.disabled = true;
    btn.textContent = 'Importing…';
    try {
      const { project_id } = await api('POST', `/api/imports/${encodeURIComponent(importId)}/import`, {
        name,
        number: numberEl.value.trim() || null,
      });
      window.location.href = `/viewer.html?projectId=${project_id}`;
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Import';
      showError(err.message);
    }
  };
}

(async function init() {
  me = await requireSession();
  if (!me) return;
  renderTopbar();
  if (me.role !== 'admin') {
    showError('Only admins can import projects.');
    return;
  }
  document.getElementById('progress-cancel').addEventListener('click', () => cancelImport(currentImportId()));
  const importId = params.get('importId');
  if (importId) openImport(importId);
  else initBrowse(params.get('source') || 'planswift');
})();

// The progress step can also be reached from the browse step without a page
// load (startConversion rewrites the URL), so read the id back from it.
function currentImportId() {
  return new URLSearchParams(window.location.search).get('importId');
}
