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

async function loadDocuments() {
  const section = document.getElementById('documents-section');
  const list = document.getElementById('documents-list');
  const data = await api('GET', `/api/share/${token}/documents`);
  section.style.display = '';
  if (!data.documents.length) {
    list.textContent = 'No documents are available for this link.';
    return;
  }
  list.innerHTML = '';
  for (const d of data.documents) {
    const a = document.createElement('a');
    a.href = `/api/share/${token}/documents/${d.id}/pdf`;
    a.target = '_blank';
    a.textContent = d.name;
    const row = document.createElement('p');
    row.appendChild(a);
    if (d.revision_name || d.issue_date) {
      const meta = document.createElement('span');
      meta.className = 'muted';
      meta.textContent = ` — ${d.revision_name || 'Current'}${d.issue_date ? ' (' + d.issue_date + ')' : ''}`;
      row.appendChild(meta);
    }
    list.appendChild(row);
  }
}

