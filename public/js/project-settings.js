import { deleteCachedProject } from '/js/offline-store.js';
import { renderShell, openModal, closeModal, showToast, trackPendingJob, getPendingJobsForProject, untrackPendingJob } from '/js/shell.js';

const params = new URLSearchParams(window.location.search);
const projectId = params.get('projectId');
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
      await deleteCachedProject(projectId);
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

async function loadSheetLinkSummary() {
  const statusEl = document.getElementById('sheet-link-scan-status');
  if (!statusEl) return;
  try {
    const { link_count } = await api('GET', `/api/projects/${projectId}/sheet-links/summary`);
    statusEl.textContent = `${link_count} active link${link_count === 1 ? '' : 's'}.`;
  } catch (err) {
    statusEl.textContent = `Unable to load link summary: ${err.message}`;
  }
}

// Tracked via shell.js's trackPendingJob() (same localStorage mechanism the
// upload flow uses) so leaving project-settings.html mid-scan and coming back
// - or even reloading - reconnects to the live progress instead of showing
// nothing, even though the scan itself keeps running server-side regardless.
async function pollSheetLinkScan(jobId) {
  const statusEl = document.getElementById('sheet-link-scan-status');
  const scanBtn = document.getElementById('scan-sheet-links-btn');
  for (;;) {
    let job;
    try {
      ({ job } = await api('GET', `/api/projects/${projectId}/sheet-links/jobs/${jobId}`));
    } catch (err) {
      untrackPendingJob(jobId); // job expired/server restarted - stop tracking it
      if (scanBtn) scanBtn.disabled = false;
      if (statusEl) statusEl.textContent = `Scan status unavailable: ${err.message}`;
      return;
    }
    if (job.status === 'processing') {
      const progress = job.progress;
      if (statusEl) statusEl.textContent = progress ? `Scanning ${progress.current} / ${progress.total} sheets...` : 'Scanning...';
      if (scanBtn) scanBtn.disabled = true;
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    untrackPendingJob(jobId);
    if (scanBtn) scanBtn.disabled = false;
    if (job.status === 'done') {
      const created = job.result ? job.result.created_links : null;
      if (statusEl) statusEl.textContent = created === null ? 'Scan complete.' : `Scan complete: ${created} link${created === 1 ? '' : 's'} found.`;
      showToast('Sheet-link scan finished.', 'success');
      await loadSheetLinkSummary();
    } else {
      if (statusEl) statusEl.textContent = `Scan failed: ${job.error || 'Unknown error'}`;
      showToast(`Sheet-link scan failed: ${job.error || 'Unknown error'}`, 'error');
    }
    return;
  }
}

function setupSheetLinkScan() {
  const card = document.getElementById('sheet-links-card');
  const scanBtn = document.getElementById('scan-sheet-links-btn');
  if (!card || !scanBtn) return;
  if (!currentUser || !['admin', 'editor'].includes(currentUser.role)) return;
  card.style.display = '';
  const trackedJob = getPendingJobsForProject(projectId).find((j) => j.kind === 'sheet-link-scan');
  if (trackedJob) {
    scanBtn.disabled = true;
    pollSheetLinkScan(trackedJob.jobId);
  }
  scanBtn.addEventListener('click', async () => {
    scanBtn.disabled = true;
    const statusEl = document.getElementById('sheet-link-scan-status');
    statusEl.textContent = 'Starting scan...';
    try {
      const { job_id } = await api('POST', `/api/projects/${projectId}/sheet-links/scan`);
      trackPendingJob({ jobId: job_id, projectId, kind: 'sheet-link-scan', label: 'Sheet-link scan' });
      await pollSheetLinkScan(job_id);
    } catch (err) {
      scanBtn.disabled = false;
      statusEl.textContent = `Scan failed: ${err.message}`;
    }
  });
  loadSheetLinkSummary();
}

async function loadSearchIndexSummary() {
  const statusEl = document.getElementById('search-index-status');
  if (!statusEl) return;
  try {
    const { indexed_count } = await api('GET', `/api/projects/${projectId}/sheet-text/summary`);
    statusEl.textContent = `${indexed_count} sheet${indexed_count === 1 ? '' : 's'} indexed.`;
  } catch (err) {
    statusEl.textContent = `Unable to load index summary: ${err.message}`;
  }
}

// Same trackPendingJob() reconnect approach as pollSheetLinkScan() above.
async function pollSearchIndexJob(jobId) {
  const statusEl = document.getElementById('search-index-status');
  const indexBtn = document.getElementById('index-search-btn');
  for (;;) {
    let job;
    try {
      ({ job } = await api('GET', `/api/projects/${projectId}/sheet-text/jobs/${jobId}`));
    } catch (err) {
      untrackPendingJob(jobId); // job expired/server restarted - stop tracking it
      if (indexBtn) indexBtn.disabled = false;
      if (statusEl) statusEl.textContent = `Index status unavailable: ${err.message}`;
      return;
    }
    if (job.status === 'processing') {
      const progress = job.progress;
      if (statusEl) statusEl.textContent = progress ? `Indexing ${progress.current} / ${progress.total} sheets...` : 'Indexing...';
      if (indexBtn) indexBtn.disabled = true;
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    untrackPendingJob(jobId);
    if (indexBtn) indexBtn.disabled = false;
    if (job.status === 'done') {
      const indexedSheets = job.result ? job.result.indexed_sheets : null;
      if (statusEl) statusEl.textContent = indexedSheets === null ? 'Index build complete.' : `Index build complete: ${indexedSheets} sheet${indexedSheets === 1 ? '' : 's'} indexed.`;
      showToast('Search index build finished.', 'success');
      await loadSearchIndexSummary();
    } else {
      if (statusEl) statusEl.textContent = `Index build failed: ${job.error || 'Unknown error'}`;
      showToast(`Search index build failed: ${job.error || 'Unknown error'}`, 'error');
    }
    return;
  }
}

function setupSearchIndex() {
  const card = document.getElementById('search-index-card');
  const indexBtn = document.getElementById('index-search-btn');
  if (!card || !indexBtn) return;
  if (!currentUser || !['admin', 'editor'].includes(currentUser.role)) return;
  card.style.display = '';
  const trackedJob = getPendingJobsForProject(projectId).find((j) => j.kind === 'search-index');
  if (trackedJob) {
    indexBtn.disabled = true;
    pollSearchIndexJob(trackedJob.jobId);
  }
  indexBtn.addEventListener('click', async () => {
    indexBtn.disabled = true;
    const statusEl = document.getElementById('search-index-status');
    statusEl.textContent = 'Starting index build...';
    try {
      const { job_id } = await api('POST', `/api/projects/${projectId}/sheet-text/index`);
      trackPendingJob({ jobId: job_id, projectId, kind: 'search-index', label: 'Search index build' });
      await pollSearchIndexJob(job_id);
    } catch (err) {
      indexBtn.disabled = false;
      statusEl.textContent = `Index build failed: ${err.message}`;
    }
  });
  loadSearchIndexSummary();
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

// ---- PlanSwift link (admin, imported projects only) --------------------------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function setupPlanswiftLink() {
  const card = document.getElementById('planswift-card');
  const infoEl = document.getElementById('planswift-info');
  const btn = document.getElementById('planswift-check-btn');
  const statusEl = document.getElementById('planswift-status');
  const resultEl = document.getElementById('planswift-result');
  let link;
  try {
    ({ linked_source: link } = await api('GET', `/api/imports/link/${projectId}`));
  } catch (err) {
    return; // not available - leave the card hidden
  }
  if (!link) return;
  card.style.display = '';
  const renderInfo = (l) => {
    infoEl.textContent = `Job: ${l.job_path || 'unknown'} · ${l.synced_at ? `last refreshed ${l.synced_at} UTC` : 'never refreshed'}`;
  };
  renderInfo(link);
  setupPlanswiftPush(link);

  let importId = null;
  const reset = () => { importId = null; btn.disabled = false; resultEl.style.display = 'none'; resultEl.innerHTML = ''; };

  const list = (items) => `<ul style="margin:4px 0 0 18px;">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
  function renderPlan({ plan, warnings }) {
    const { sheets, items, shapes } = plan;
    const changes = shapes.added + shapes.changed + shapes.removed + items.added + items.updated + sheets.scaleChanged + shapes.linked + items.linked + sheets.linked;
    const lines = [];
    if (sheets.linked || items.linked || shapes.linked) {
      lines.push(`<p><b>First refresh of this project.</b> Matched ${sheets.linked} sheets, ${items.linked} items and ${shapes.linked} shapes already here to the PlanSwift job. If "added" below is far more than you expect, something here was edited since import — cancel and check before applying.</p>`);
    }
    lines.push(`<table style="width:auto;"><tbody>
      <tr><td>Shapes added</td><td><b>${shapes.added}</b></td></tr>
      <tr><td>Shapes changed in PlanSwift</td><td><b>${shapes.changed}</b></td></tr>
      <tr><td>Shapes removed in PlanSwift</td><td><b>${shapes.removed}</b></td></tr>
      <tr><td>Shapes unchanged</td><td>${shapes.unchanged}</td></tr>
      <tr><td>Take-off items added / updated</td><td><b>${items.added}</b> / <b>${items.updated}</b></td></tr>
      <tr><td>Page scales changed</td><td><b>${sheets.scaleChanged}</b></td></tr>
    </tbody></table>`);
    if (!changes && !shapes.conflicts.length && !shapes.keptLocal.length) lines.push('<p>Already up to date.</p>');
    if (shapes.conflicts.length) {
      lines.push(`<p><b>${shapes.conflicts.length} shape(s) changed in both places</b> — your edit here is kept, PlanSwift's change is not applied:${list(shapes.conflicts.slice(0, 15).map((c) => `${c.item} on ${c.sheet}`))}${shapes.conflicts.length > 15 ? `<span class="muted">…and ${shapes.conflicts.length - 15} more</span>` : ''}</p>`);
    }
    if (shapes.keptLocal.length) {
      lines.push(`<p><b>${shapes.keptLocal.length} shape(s) deleted in PlanSwift but edited here</b> — kept as HammGrid-only shapes.</p>`);
    }
    lines.push(scaleMismatchHtml(sheets.scaleMismatch));
    if (sheets.newPages.length) {
      lines.push(`<p class="muted">${sheets.newPages.length} PlanSwift page(s) are not in this project and were not added (take-offs on them are skipped): ${esc(sheets.newPages.slice(0, 12).join(', '))}${sheets.newPages.length > 12 ? '…' : ''}</p>`);
    }
    if (sheets.missing.length) {
      lines.push(`<p class="muted">${sheets.missing.length} sheet(s) here no longer exist in PlanSwift (left alone): ${esc(sheets.missing.slice(0, 12).join(', '))}</p>`);
    }
    if (warnings.length) {
      lines.push(`<details><summary class="muted">${warnings.length} warning(s)</summary>${list(warnings.slice(0, 50))}</details>`);
    }
    lines.push('<div class="row" style="margin-top:8px;"><button class="primary" type="button" id="planswift-apply-btn">Apply changes</button><button type="button" id="planswift-cancel-btn">Cancel</button></div>');
    resultEl.innerHTML = lines.join('');
    resultEl.style.display = '';
    document.getElementById('planswift-cancel-btn').addEventListener('click', async () => {
      try { await api('DELETE', `/api/imports/${importId}`); } catch (err) { /* staging cleanup is best effort */ }
      statusEl.textContent = '';
      reset();
    });
    document.getElementById('planswift-apply-btn').addEventListener('click', async (e) => {
      e.target.disabled = true;
      statusEl.textContent = 'Applying…';
      try {
        const out = await api('POST', `/api/imports/${importId}/refresh`);
        const p = out.plan;
        showToast(`PlanSwift refresh applied: ${p.shapes.added} added, ${p.shapes.changed} changed, ${p.shapes.removed} removed.`, 'success');
        statusEl.textContent = 'Refreshed.';
        reset();
        ({ linked_source: link } = await api('GET', `/api/imports/link/${projectId}`));
        if (link) renderInfo(link);
      } catch (err) {
        statusEl.textContent = `Failed: ${err.message}`;
        e.target.disabled = false;
      }
    });
  }

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    resultEl.style.display = 'none';
    statusEl.textContent = 'Starting…';
    try {
      ({ import_id: importId } = await api('POST', '/api/imports/refresh', { project_id: Number(projectId) }));
      for (;;) {
        const data = await api('GET', `/api/imports/${importId}`);
        const imp = data.import;
        if (imp.status === 'error' || imp.status === 'cancelled') throw new Error(imp.error || 'Cancelled');
        if (imp.status === 'ready') {
          statusEl.textContent = 'Compared with PlanSwift.';
          renderPlan(data.refresh);
          return;
        }
        statusEl.textContent = imp.progress ? `Reading PlanSwift job… page ${imp.progress.current} of ${imp.progress.total}` : 'Reading PlanSwift job…';
        await new Promise((r) => setTimeout(r, 1500));
      }
    } catch (err) {
      statusEl.textContent = `Failed: ${err.message}`;
      if (importId) { try { await api('DELETE', `/api/imports/${importId}`); } catch (e) { /* best effort */ } }
      reset();
    }
  });
}

// Sheets scaled differently in HammGrid and PlanSwift (shown by refresh and push).
function scaleMismatchHtml(mismatches) {
  if (!mismatches || !mismatches.length) return '';
  const items = mismatches.slice(0, 20).map((m) => `<li>${esc(`${m.sheet}: HammGrid ${m.hammgrid}, PlanSwift ${m.planswift}`)}</li>`).join('');
  return `<p><b>${mismatches.length} sheet(s) have a different scale in HammGrid than in PlanSwift.</b> Neither side is changed, so quantities will disagree until one is corrected:<ul style="margin:4px 0 0 18px;">${items}</ul>${mismatches.length > 20 ? `<span class="muted">…and ${mismatches.length - 20} more</span>` : ''}</p>`;
}

// ---- Send HammGrid-only take-offs to the linked PlanSwift job -----------------
// Writes into the live PlanSwift job folder, so: a plan is shown first, a warning
// dialog must be confirmed, and the last push can be undone.
function setupPlanswiftPush(initialLink) {
  const card = document.getElementById('planswift-push-card');
  const btn = document.getElementById('planswift-push-check-btn');
  const undoBtn = document.getElementById('planswift-push-undo-btn');
  const statusEl = document.getElementById('planswift-push-status');
  const resultEl = document.getElementById('planswift-push-result');
  card.style.display = '';

  const showUndo = (lastPush) => { undoBtn.style.display = lastPush && lastPush.status === 'applied' ? '' : 'none'; };
  showUndo(initialLink.last_push);
  let importId = null;
  const reset = () => { importId = null; btn.disabled = false; resultEl.style.display = 'none'; resultEl.innerHTML = ''; };
  const list = (items) => `<ul style="margin:4px 0 0 18px;">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
  const lockText = (l) => `locked by ${esc(l.locked_by || 'unknown')} at ${esc(l.timestamp || 'unknown time')} (${l.age_minutes} minute(s) ago)`;

  // The warning dialog. `lock` = the job's JobLock.xml info (or null).
  function confirmDialog({ title, body, lock, action, onConfirm }) {
    const blocked = lock && lock.recent;
    openModal(`
      <h2 style="color: var(--danger);">${esc(title)}</h2>
      ${body}
      ${lock ? `<p><b>This job has a lock file</b> — ${lockText(lock)}. ${blocked ? '<b>That is very recent, so PlanSwift probably has the job open. Close it in PlanSwift and try again.</b>' : 'Lock files are often left behind, but check that nobody has the job open.'}</p>` : ''}
      <label style="display:block; margin:10px 0;"><input type="checkbox" id="push-ack"> I understand this writes directly into the live PlanSwift job, and I have confirmed that PlanSwift is closed on it.</label>
      <p class="error" id="push-modal-error" style="display:none;"></p>
      <div class="modal-actions">
        <button type="button" id="push-modal-cancel">Cancel</button>
        <button class="danger" type="button" id="push-modal-go" disabled>${esc(action)}</button>
      </div>`);
    const ack = document.getElementById('push-ack');
    const go = document.getElementById('push-modal-go');
    ack.addEventListener('change', () => { go.disabled = blocked || !ack.checked; });
    document.getElementById('push-modal-cancel').addEventListener('click', closeModal);
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        await onConfirm({ acknowledge: true, confirm_closed: true });
        closeModal();
      } catch (err) {
        const e = document.getElementById('push-modal-error');
        e.textContent = err.message;
        e.style.display = 'block';
        go.disabled = false;
      }
    });
  }

  function renderPlan(plan) {
    const lines = [];
    if (plan.problems.length) lines.push(`<p><b>Cannot send yet:</b>${list(plan.problems)}</p>`);
    const canSend = plan.instances || plan.scales_to_set;
    if (!canSend) {
      lines.push('<p>Nothing to send — every take-off and page scale in this project is already in PlanSwift (or can\'t be sent, see below).</p>');
    } else {
      lines.push(`<p>Ready to add to <b>${esc(plan.job)}</b>:</p>
        <ul style="margin:4px 0 0 18px;">
          <li><b>${plan.scales_to_set}</b> page scale(s) set on PlanSwift pages that have none</li>
          <li><b>${plan.new_items}</b> new take-off item(s), in a "From HammGrid" folder</li>
          <li><b>${plan.existing_items}</b> existing PlanSwift item(s) getting new shapes</li>
          <li><b>${plan.sections}</b> drawn shape(s) in total (${plan.instances} HammGrid take-off row(s))</li>
        </ul>`);
      if (plan.scales_to_set) lines.push(`<details style="margin-top:6px;"><summary class="muted">Show page scales</summary>${list(plan.scales.map((s) => `${s.sheet}: ${s.label}`))}${plan.scales_to_set > plan.scales.length ? '<p class="muted">…and more</p>' : ''}</details>`);
      if (plan.instances) lines.push(`<details style="margin-top:6px;"><summary class="muted">Show items</summary>${list(plan.items.map((i) => `${i.name} — ${i.type}, ${i.shapes} shape(s) on ${i.sheets.join(', ')}${i.target === 'new' ? ' (new item)' : ' (added to existing item)'}`))}${plan.new_items + plan.existing_items > plan.items.length ? '<p class="muted">…and more</p>' : ''}</details>`);
    }
    lines.push(scaleMismatchHtml(plan.scale_mismatch));
    if (plan.skipped.length) lines.push(`<p class="muted">Not sent:${list(plan.skipped.map((s) => `${s.count} take-off row(s) ${s.reason}`))}</p>`);
    if (plan.lock) lines.push(`<p class="muted">Lock file present on the job: ${lockText(plan.lock)}.</p>`);
    if (canSend) lines.push('<div class="row" style="margin-top:8px;"><button class="danger" type="button" id="planswift-push-go-btn">Write to PlanSwift…</button><button type="button" id="planswift-push-cancel-btn">Cancel</button></div>');
    else lines.push('<div class="row" style="margin-top:8px;"><button type="button" id="planswift-push-cancel-btn">Close</button></div>');
    resultEl.innerHTML = lines.join('');
    resultEl.style.display = '';
    document.getElementById('planswift-push-cancel-btn').addEventListener('click', async () => {
      try { await api('DELETE', `/api/imports/${importId}`); } catch (err) { /* best effort */ }
      statusEl.textContent = '';
      reset();
    });
    const go = document.getElementById('planswift-push-go-btn');
    if (!go) return;
    go.addEventListener('click', () => confirmDialog({
      title: 'Write into the live PlanSwift job?',
      body: `<p>This will create <b>${plan.sections}</b> new shape(s) and <b>${plan.new_items}</b> new item(s)${plan.scales_to_set ? `, and set the scale on <b>${plan.scales_to_set}</b> page(s),` : ''} directly in the PlanSwift job:</p>
        <p class="muted">${esc(plan.job_path)}</p>
        <ul style="margin:4px 0 8px 18px;">
          <li>Make sure <b>nobody has this job open in PlanSwift</b>. If they do, they won't see the changes and could overwrite them.</li>
          <li>Nothing that PlanSwift already wrote is changed or deleted. New folders are added, and pages with no scale get one; a scale already set in PlanSwift is never touched.</li>
          <li>PlanSwift users must close and reopen the job to see the new take-offs.</li>
          <li>PlanSwift recalculates quantities itself; HammGrid formulas and item properties are not sent.</li>
          <li>You can use "Undo last push" afterwards to remove exactly what was added.</li>
        </ul>`,
      lock: plan.lock,
      action: 'Write to PlanSwift',
      onConfirm: async (body) => {
        statusEl.textContent = 'Writing…';
        try {
          const out = await api('POST', `/api/imports/${importId}/push`, body);
          showToast(`Sent to PlanSwift: ${out.written.items} new item(s), ${out.written.sections} shape(s), ${out.written.scales || 0} page scale(s). Reopen the job in PlanSwift to see them.`, 'success');
          statusEl.textContent = 'Done. Close and reopen the job in PlanSwift to see the changes.';
          reset();
          showUndo({ status: 'applied' });
        } catch (err) {
          statusEl.textContent = `Failed: ${err.message}`;
          throw err;
        }
      },
    }));
  }

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    resultEl.style.display = 'none';
    statusEl.textContent = 'Starting…';
    try {
      ({ import_id: importId } = await api('POST', '/api/imports/push', { project_id: Number(projectId) }));
      for (;;) {
        const data = await api('GET', `/api/imports/${importId}`);
        const imp = data.import;
        if (imp.status === 'error' || imp.status === 'cancelled') throw new Error(imp.error || 'Cancelled');
        if (imp.status === 'ready') {
          statusEl.textContent = 'Compared with PlanSwift.';
          renderPlan(data.push.plan);
          return;
        }
        statusEl.textContent = imp.progress ? `Reading PlanSwift job… page ${imp.progress.current} of ${imp.progress.total}` : 'Reading PlanSwift job…';
        await new Promise((r) => setTimeout(r, 1500));
      }
    } catch (err) {
      statusEl.textContent = `Failed: ${err.message}`;
      if (importId) { try { await api('DELETE', `/api/imports/${importId}`); } catch (e) { /* best effort */ } }
      reset();
    }
  });

  undoBtn.addEventListener('click', () => confirmDialog({
    title: 'Undo the last push to PlanSwift?',
    body: `<p>This removes exactly the folders the last push added to the PlanSwift job, reverts any page scales it set, and unlinks them in HammGrid (the take-offs stay in HammGrid). If anyone added something inside those folders in PlanSwift since, nothing is removed.</p>`,
    lock: null,
    action: 'Undo push',
    onConfirm: async (body) => {
      const out = await api('POST', '/api/imports/push-undo', { project_id: Number(projectId), confirm_closed: true });
      showToast(`Removed ${out.undone.sections} shape(s) and ${out.undone.items} item(s) from PlanSwift${out.undone.scales ? `, and reverted ${out.undone.scales} page scale(s)` : ''}.`, 'success');
      statusEl.textContent = 'Undone.';
      showUndo({ status: 'undone' });
    },
  }));
}

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
  setupSheetLinkScan();
  setupSearchIndex();
  await loadRevisions();

  if (me.role === 'admin') {
    document.getElementById('danger-zone').style.display = '';
    document.getElementById('delete-project-btn').addEventListener('click', openDeleteConfirm);
    setupPlanswiftLink();
  }
})();
