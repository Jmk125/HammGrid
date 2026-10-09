import { openModal, closeModal } from '/js/shell.js';

const FOLDER_ICON =
  '<svg viewBox="0 0 20 20" class="doc-picker-icon"><path d="M2 5a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5z" fill="currentColor"/></svg>';
const FILE_ICON =
  '<svg viewBox="0 0 20 20" class="doc-picker-icon"><path d="M5 2h7l4 4v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M12 2v4h4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';

// Same remembered choice as the Documents page's List/Thumbnails switch
// (documents.js VIEW_MODE_KEY) - one per-device preference for both.
const VIEW_MODE_KEY = 'hammgrid-doc-view-mode';

function readViewMode() {
  try {
    return localStorage.getItem(VIEW_MODE_KEY) === 'grid' ? 'grid' : 'list';
  } catch (e) {
    return 'list';
  }
}

function saveViewMode(mode) {
  try {
    localStorage.setItem(VIEW_MODE_KEY, mode);
  } catch (e) {
    // Per-device convenience only.
  }
}

// Small pre-generated JPEG (src/lib/documentThumbs.js); ?v= busts the
// browser cache when a new revision replaces the file.
function thumbUrl(d) {
  return `/api/documents/${d.id}/thumb?v=${d.current_version_id || ''}`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

// Small folder-navigable picker for selecting a document, styled to match
// the app (reuses shell.js's modal) rather than a flat dropdown. Used by
// the markup "Link doc" button; documents/folders are passed in already-
// loaded (a project's full set) so no extra fetches happen per navigation.
//
// multiple: true (photo pins) swaps single-click-to-pick for checkboxes and
// an "Add N" button that calls onSelectMany(ids). disabledReason(d) returns
// a string for documents that can't be picked (shown greyed out with it as
// the tooltip), or null.
export function openDocPicker({
  documents,
  folders,
  currentId,
  allowClear = true,
  onSelect,
  multiple = false,
  onSelectMany,
  disabledReason = () => null,
  title = 'Link to document',
}) {
  let currentFolderId = null;
  const picked = new Set();
  let viewMode = readViewMode();
  if (currentId) {
    const doc = documents.find((d) => d.id === currentId);
    if (doc) currentFolderId = doc.folder_id || null;
  }

  const backdrop = openModal(`
    <div class="row" style="justify-content: space-between; align-items: center; margin-bottom: 8px;">
      <h2 style="margin: 0;">${escapeHtml(title)}</h2>
      <div class="segmented" role="group" aria-label="View">
        <button type="button" id="doc-picker-view-list" title="List view">&#9776; List</button>
        <button type="button" id="doc-picker-view-grid" title="Thumbnail view">&#9638; Thumbnails</button>
      </div>
    </div>
    <div id="doc-picker-body"></div>
    <div class="modal-actions">
      ${allowClear ? '<button type="button" id="doc-picker-clear">Clear link</button>' : ''}
      <button type="button" id="doc-picker-cancel">Cancel</button>
      ${multiple ? '<button type="button" class="primary" id="doc-picker-add" disabled>Add</button>' : ''}
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
  const addBtn = backdrop.querySelector('#doc-picker-add');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      if (!picked.size) return;
      closeModal();
      onSelectMany([...picked]);
    });
  }
  function updateAddBtn() {
    if (!addBtn) return;
    addBtn.disabled = picked.size === 0;
    addBtn.textContent = picked.size ? `Add ${picked.size}` : 'Add';
  }
  const modalEl = backdrop.querySelector('.modal');
  function setViewMode(mode) {
    viewMode = mode;
    saveViewMode(mode);
    render();
  }
  backdrop.querySelector('#doc-picker-view-list').addEventListener('click', () => setViewMode('list'));
  backdrop.querySelector('#doc-picker-view-grid').addEventListener('click', () => setViewMode('grid'));

  function render() {
    backdrop.querySelector('#doc-picker-view-list').classList.toggle('active', viewMode === 'list');
    backdrop.querySelector('#doc-picker-view-grid').classList.toggle('active', viewMode === 'grid');
    modalEl.classList.toggle('modal-wide', viewMode === 'grid');
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

    const empty = '<p class="muted" style="padding:8px 4px;">This folder is empty.</p>';
    // Multi mode: the pin's own document is already on it, so it shows as
    // checked-and-locked rather than pickable.
    function docState(d) {
      if (!multiple) return { cls: d.id === currentId ? ' current' : '', attrs: '', box: '' };
      const isCurrent = d.id === currentId;
      const reason = isCurrent ? 'Already on this pin' : disabledReason(d);
      const checked = isCurrent || picked.has(d.id);
      return {
        cls: (reason ? ' disabled' : '') + (checked ? ' picked' : ''),
        attrs: reason ? ` title="${escapeHtml(reason)}"` : '',
        box: `<input type="checkbox" class="doc-picker-check" ${checked ? 'checked' : ''} ${reason ? 'disabled' : ''} tabindex="-1">`,
      };
    }
    let listHtml;
    if (viewMode === 'grid') {
      // Photos are usually named by date, not content - big thumbnails are
      // how you actually find the right one.
      const cards = [
        ...childFolders.map(
          (fld) => `
            <div class="doc-card doc-card-folder doc-picker-row folder" data-folder="${fld.id}">
              <div class="doc-card-thumb">${FOLDER_ICON}</div>
              <div class="doc-card-name" title="${escapeHtml(fld.name)}">${escapeHtml(fld.name)}</div>
            </div>`
        ),
        ...childDocs.map((d) => {
          const st = docState(d);
          const selectedCls = multiple ? st.cls : d.id === currentId ? ' doc-selected' : '';
          return `
            <div class="doc-card doc-picker-row doc${selectedCls}" data-doc="${d.id}"${st.attrs}>
              <div class="doc-card-thumb">${d.is_image ? `<img class="doc-card-img" src="${thumbUrl(d)}" alt="" loading="lazy">` : FILE_ICON}</div>
              <div class="doc-card-name" title="${escapeHtml(d.name)}">${escapeHtml(d.name)}</div>
              ${st.box ? `<span class="doc-card-check">${st.box}</span>` : ''}
            </div>`;
        }),
      ].join('');
      listHtml = cards ? `<div class="doc-grid doc-picker-grid">${cards}</div>` : `<div class="doc-picker-list">${empty}</div>`;
    } else {
      const rows = [
        ...childFolders.map(
          (fld) =>
            `<div class="doc-picker-row folder" data-folder="${fld.id}">${FOLDER_ICON}<span>${escapeHtml(fld.name)}</span></div>`
        ),
        ...childDocs.map((d) => {
          const st = docState(d);
          return `<div class="doc-picker-row doc${st.cls}" data-doc="${d.id}"${st.attrs}>${st.box}${
            d.is_image ? `<img class="doc-picker-thumb" src="${thumbUrl(d)}" alt="" loading="lazy">` : FILE_ICON
          }<span>${escapeHtml(d.name)}</span></div>`;
        }),
      ].join('');
      listHtml = `<div class="doc-picker-list">${rows || empty}</div>`;
    }

    body.innerHTML = `<div class="doc-picker-breadcrumb">${breadcrumb}</div>${listHtml}`;
    body.querySelectorAll('img').forEach((img) => {
      img.addEventListener('error', () => {
        img.outerHTML = FILE_ICON;
      });
    });

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
      el.addEventListener('click', (e) => {
        const id = Number(el.dataset.doc);
        if (!multiple) {
          closeModal();
          onSelect(id);
          return;
        }
        // The checkbox is display-only; the whole row/card is the target.
        e.preventDefault();
        if (el.classList.contains('disabled')) return;
        if (picked.has(id)) picked.delete(id);
        else picked.add(id);
        el.classList.toggle('picked', picked.has(id));
        el.querySelector('.doc-picker-check').checked = picked.has(id);
        updateAddBtn();
      });
    });
  }

  render();
}
