import { renderShell } from '/js/shell.js';

const projectId = new URLSearchParams(window.location.search).get('projectId');

(async function init() {
  const me = await requireSession();
  if (!me) return;
  await renderShell({
    topbarEl: document.getElementById('topbar'),
    sidebarEl: document.getElementById('sidebar'),
    projectId,
    active: 'help',
    me,
  });
  if (me.role === 'admin' || me.can_takeoff) {
    document.getElementById('help-takeoffs').style.display = '';
  }
})();
