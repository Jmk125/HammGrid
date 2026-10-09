import { renderShell } from '/js/shell.js';

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

(async function init() {
  const me = await requireSession();
  if (me.role !== 'admin') {
    document.querySelector('main').innerHTML = '<h1>Admin Settings</h1><p class="error">Admin access required.</p>';
    return;
  }
  await renderShell({
    topbarEl: document.getElementById('topbar'),
    sidebarEl: document.getElementById('sidebar'),
    active: 'admin',
    me,
  });
  try {
    const s = await api('GET', '/api/admin/storage');
    document.getElementById('storage-dir').innerHTML = `<code>${escapeHtml(s.storageDir)}</code>`;
    document.getElementById('db-path').innerHTML = `<code>${escapeHtml(s.dbPath)}</code>`;
    document.getElementById('storage-size').textContent = `${formatBytes(s.bytes)} in ${s.files.toLocaleString()} files`;
    document.getElementById('storage-note').textContent = s.storageFromEnv
      ? 'Set by the STORAGE_DIR environment variable on the server.'
      : 'Using the default (data folder next to the app). Set STORAGE_DIR on the server to change it.';
  } catch (e) {
    const err = document.getElementById('error');
    err.textContent = e.message;
    err.style.display = 'block';
  }
})();
