import { openModal, closeModal } from '/js/shell.js';

const FOLDER_ICON =
  '<svg viewBox="0 0 20 20" class="doc-picker-icon"><path d="M2 5a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5z" fill="currentColor"/></svg>';
const FILE_ICON =
  '<svg viewBox="0 0 20 20" class="doc-picker-icon"><path d="M5 2h7l4 4v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M12 2v4h4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

// Small folder-navigable picker for selecting a document, styled to match
// the app (reuses shell.js's modal) rather than a flat dropdown. Used by
// the markup "Link doc" button; documents/folders are passed in already-
// loaded (a project's full set) so no extra fetches happen per navigation.
export function openDocPicker({ documents, folders, currentId, allowClear = true, onSelect }) {
  let currentFolderId = null;
  if (currentId) {
    const doc = documents.find((d) => d.id === currentId);
    if (doc) currentFolderId = doc.folder_id || null;
  }

  const backdrop = openModal(`
    <h2>Link to document</h2>
    <div id="doc-picker-body"></div>
    <div class="modal-actions">
      ${allowClear ? '<button type="button" id="doc-picker-clear">Clear link</button>' : ''}
      <button type="button" id="doc-picker-cancel">Cancel</button>
    </div>
  `);
  const body = backdrop.querySelector('#doc-picker-body');
  const clearBtn = backdrop.querySelector('#doc-picker-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      closeModal();
      onSelect(null);
    });
  }
  backdrop.querySelector('#doc-picker-cancel').addEventListener('click', closeModal);

  function render() {
    const path = [];
    let f = currentFolderId;
    while (f) {
      const folder = folders.find((x) => x.id === f);
      if (!folder) break;
      path.unshift(folder);
      f = folder.parent_folder_id;
    }

    const childFolders = folders
      .filter((x) => (x.parent_folder_id || null) === currentFolderId)
      .sort((a, b) => a.name.localeCompare(b.name));
    const childDocs = documents
      .filter((x) => (x.folder_id || null) === currentFolderId)
      .sort((a, b) => a.name.localeCompare(b.name));

    const breadcrumb =
      `<span class="doc-picker-crumb" data-folder="">Root</span>` +
      path.map((p) => ` / <span class="doc-picker-crumb" data-folder="${p.id}">${escapeHtml(p.name)}</span>`).join('');

    const rows =
      [
        ...childFolders.map(
          (fld) =>
            `<div class="doc-picker-row folder" data-folder="${fld.id}">${FOLDER_ICON}<span>${escapeHtml(fld.name)}</span></div>`
        ),
        ...childDocs.map(
          (d) =>
            `<div class="doc-picker-row doc${d.id === currentId ? ' current' : ''}" data-doc="${d.id}">${FILE_ICON}<span>${escapeHtml(d.name)}</span></div>`
        ),
      ].join('') || '<p class="muted" style="padding:8px 4px;">This folder is empty.</p>';

    body.innerHTML = `<div class="doc-picker-breadcrumb">${breadcrumb}</div><div class="doc-picker-list">${rows}</div>`;

    body.querySelectorAll('.doc-picker-crumb').forEach((el) => {
      el.addEventListener('click', () => {
        currentFolderId = el.dataset.folder ? Number(el.dataset.folder) : null;
        render();
      });
    });
    body.querySelectorAll('.doc-picker-row.folder').forEach((el) => {
      el.addEventListener('click', () => {
        currentFolderId = Number(el.dataset.folder);
        render();
      });
    });
    body.querySelectorAll('.doc-picker-row.doc').forEach((el) => {
      el.addEventListener('click', () => {
        closeModal();
        onSelect(Number(el.dataset.doc));
      });
    });
  }

  render();
}
