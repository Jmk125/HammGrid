const token = new URLSearchParams(window.location.search).get('token');

document.getElementById('zip-link').href = `/api/share/${token}/export/zip`;
document.getElementById('merged-link').href = `/api/share/${token}/export/merged-pdf`;

(async function load() {
  try {
    const data = await api('GET', `/api/share/${token}`);
    document.getElementById('project-name').textContent = data.project.name;
    document.getElementById('scope-info').textContent =
      `${data.scope === 'live' ? 'Always current' : 'Snapshot'} set` +
      (data.discipline_filter ? ` — ${data.discipline_filter} only` : '');

    if (data.permissions && data.permissions.allow_documents) {
      await loadDocuments();
    }
    setupShareNavigation();

    const grid = document.getElementById('grid');
    grid.innerHTML = '';
    for (const s of data.sheets) {
      const a = document.createElement('a');
      a.className = 'sheet-card';
      a.href = `/share-sheet.html?token=${token}&versionId=${s.version_id}`;
      a.innerHTML = `
        <img src="/api/share/${token}/sheet-versions/${s.version_id}/thumb" loading="lazy">
        <div class="meta">
          <div class="sheet-number">${s.sheet_number}</div>
          <div class="sheet-title">${s.title || ''}</div>
        </div>`;
      grid.appendChild(a);
    }
  } catch (err) {
    document.getElementById('error').textContent = err.message;
    document.getElementById('error').style.display = 'block';
  }
})();

function setupShareNavigation() {
  document.querySelector('[data-section="drawings"]').addEventListener('click', (e) => {
    e.preventDefault();
    showSection('drawings');
  });
}

function showSection(section) {
  document.getElementById('drawings-section').style.display = section === 'drawings' ? '' : 'none';
  document.getElementById('documents-section').style.display = section === 'documents' ? '' : 'none';
  document.getElementById('drawing-actions').style.display = section === 'drawings' ? '' : 'none';
  document.querySelectorAll('#share-sidebar a').forEach((a) => a.classList.toggle('active', a.dataset.section === section));
}

async function loadDocuments() {
  const list = document.getElementById('documents-list');
  const data = await api('GET', `/api/share/${token}/documents`);
  const nav = document.getElementById('shared-doc-nav');
  nav.style.display = '';
  nav.innerHTML = '<a href="#" data-section="documents">Documents</a>';
  nav.querySelector('a').addEventListener('click', (e) => { e.preventDefault(); showSection('documents'); });
  if (!data.documents.length) {
    list.textContent = 'No documents are available for this link.';
    return;
  }
  list.innerHTML = renderDocumentTree(data.folders || [], data.documents || []);
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);
}

function renderDocumentTree(folders, documents) {
  const foldersByParent = new Map();
  for (const f of folders) {
    const key = f.parent_folder_id || 0;
    if (!foldersByParent.has(key)) foldersByParent.set(key, []);
    foldersByParent.get(key).push(f);
  }
  const docsByFolder = new Map();
  for (const d of documents) {
    const key = d.folder_id || 0;
    if (!docsByFolder.has(key)) docsByFolder.set(key, []);
    docsByFolder.get(key).push(d);
  }
  function renderDocs(folderId, depth) {
    return (docsByFolder.get(folderId) || []).map((d) => {
      const meta = d.revision_name || d.issue_date
        ? `<span class="muted">${escapeHtml(d.revision_name || 'Current')}${d.issue_date ? ' (' + escapeHtml(d.issue_date) + ')' : ''}</span>`
        : '';
      return `<div class="shared-doc-row shared-doc-file" style="--depth:${depth};">
        <span class="shared-doc-icon">📄</span>
        <a href="/document-view.html?token=${encodeURIComponent(token)}&documentId=${d.id}" target="_blank">${escapeHtml(d.name)}</a>
        ${meta}
      </div>`;
    }).join('');
  }
  function renderFolders(parentId, depth) {
    return (foldersByParent.get(parentId) || []).map((f) => `
      <details class="shared-doc-folder" open>
        <summary class="shared-doc-row" style="--depth:${depth};"><span class="shared-doc-icon">📁</span><span>${escapeHtml(f.name)}</span></summary>
        ${renderFolders(f.id, depth + 1)}
        ${renderDocs(f.id, depth + 1)}
      </details>`).join('');
  }
  return `<div class="shared-doc-tree">${renderFolders(0, 0)}${renderDocs(0, 0)}</div>`;
}
