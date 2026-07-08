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
