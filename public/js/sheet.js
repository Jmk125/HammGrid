import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

const params = new URLSearchParams(window.location.search);
const projectId = params.get('projectId');
const sheetId = params.get('sheetId');
document.getElementById('back-link').href = `/viewer.html?projectId=${projectId}`;

async function loadShell() {
  const me = await requireSession();
  if (!me) return null;
  document.getElementById('whoami').textContent = `${me.name} (${me.role})`;
  return me;
}

async function renderPdf(versionId) {
  const statusEl = document.getElementById('pdf-status');
  statusEl.textContent = 'Loading...';
  const canvas = document.getElementById('pdf-canvas');
  try {
    const loadingTask = pdfjsLib.getDocument(`/api/sheet-versions/${versionId}/pdf`);
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 2 });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    statusEl.textContent = '';
  } catch (err) {
    statusEl.textContent = `Failed to render PDF: ${err.message}`;
  }
}

function renderVersionList(sheet, versions) {
  const list = document.getElementById('version-list');
  list.innerHTML = '';
  for (const v of versions) {
    const li = document.createElement('li');
    const isCurrent = v.id === sheet.current_version_id;
    const a = document.createElement('a');
    a.href = '#';
    a.className = isCurrent ? 'current' : '';
    a.textContent = `${v.revision_title}${isCurrent ? ' (current)' : ''}`;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      renderPdf(v.id);
    });
    li.appendChild(a);
    list.appendChild(li);
  }
}

document.getElementById('logout').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout');
  window.location.href = '/login.html';
});

(async function init() {
  const me = await loadShell();
  if (!me) return;

  const { sheet, versions } = await api('GET', `/api/projects/${projectId}/sheets/${sheetId}`);
  document.getElementById('sheet-number').textContent = sheet.sheet_number;
  const current = versions.find((v) => v.id === sheet.current_version_id);
  document.getElementById('sheet-title').textContent = current ? current.title : '';

  renderVersionList(sheet, versions);
  await renderPdf(sheet.current_version_id);
})();
