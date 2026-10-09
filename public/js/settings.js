import { applyTheme } from '/js/shell.js';
import { PANE_SECTIONS, resolvePaneOrder } from '/js/paneOrder.js';

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
  const magnifierCornerValue = settings.magnifierCorner === 'bottom-right' ? 'bottom-right' : 'bottom-left';
  const magnifierCornerInput = document.querySelector(`input[name="magnifierCorner"][value="${magnifierCornerValue}"]`);
  if (magnifierCornerInput) magnifierCornerInput.checked = true;

  const canTakeoffs = me.role === 'admin' || !!me.can_takeoff;
  let paneOrder = resolvePaneOrder(settings.paneSectionOrder, canTakeoffs);
  const paneListEl = document.getElementById('pane-order-list');
  function renderPaneOrder() {
    paneListEl.innerHTML = '';
    paneOrder.forEach((id, i) => {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = PANE_SECTIONS.find((s) => s.id === id).label;
      const up = document.createElement('button');
      up.type = 'button';
      up.textContent = '▲';
      up.title = 'Move up';
      up.disabled = i === 0;
      const down = document.createElement('button');
      down.type = 'button';
      down.textContent = '▼';
      down.title = 'Move down';
      down.disabled = i === paneOrder.length - 1;
      const move = (delta) => {
        const j = i + delta;
        [paneOrder[i], paneOrder[j]] = [paneOrder[j], paneOrder[i]];
        renderPaneOrder();
        save({ paneSectionOrder: paneOrder });
      };
      up.addEventListener('click', () => move(-1));
      down.addEventListener('click', () => move(1));
      li.append(label, up, down);
      paneListEl.appendChild(li);
    });
  }
  renderPaneOrder();
  document.getElementById('pane-order-reset').addEventListener('click', () => {
    paneOrder = resolvePaneOrder(null, canTakeoffs);
    renderPaneOrder();
    save({ paneSectionOrder: paneOrder });
  });

  document.querySelectorAll('input[name="theme"]').forEach((input) => {
    input.addEventListener('change', () => save({ theme: input.value }));
  });
  document.getElementById('dark-canvas-checkbox').addEventListener('change', (e) => {
    save({ darkCanvas: e.target.checked });
  });
  document.querySelectorAll('input[name="magnifierCorner"]').forEach((input) => {
    input.addEventListener('change', () => save({ magnifierCorner: input.value }));
  });
})();
