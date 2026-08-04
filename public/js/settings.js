import { applyTheme } from '/js/shell.js';

const statusEl = document.getElementById('settings-status');
let statusTimer = null;

function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? 'var(--danger)' : '';
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusEl.textContent = '';
  }, 2000);
}

async function save(patch) {
  try {
    const { user } = await api('PUT', '/api/auth/settings', patch);
    setCachedSessionUser(user);
    applyTheme(user.settings);
    setStatus('Saved');
  } catch (err) {
    setStatus('Could not save - try again', true);
  }
}

(async function init() {
  const me = await requireSession();
  if (!me) return;
  applyTheme(me.settings);

  const settings = me.settings || {};
  const themeValue = settings.theme || 'default';
  const themeInput = document.querySelector(`input[name="theme"][value="${themeValue}"]`);
  if (themeInput) themeInput.checked = true;
  document.getElementById('dark-canvas-checkbox').checked = !!settings.darkCanvas;

  document.querySelectorAll('input[name="theme"]').forEach((input) => {
    input.addEventListener('change', () => save({ theme: input.value }));
  });
  document.getElementById('dark-canvas-checkbox').addEventListener('change', (e) => {
    save({ darkCanvas: e.target.checked });
  });
})();
