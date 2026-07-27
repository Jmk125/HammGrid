import { renderShell, openModal, closeModal, confirmModal, promptModal, showToast } from '/js/shell.js';
import { setupAdvancedFields, wireNamePreview } from '/js/takeoffAdvancedFields.js';
import { computeTakeoffOutput, parseTakeoffProperties, resolveTakeoffName } from '/js/takeoffFormula.js';

const projectId = new URLSearchParams(window.location.search).get('projectId');

let allItems = [];
let bySheetRows = null; // fetched lazily on first switch to the By Sheet view, then cached
let allTemplates = null; // fetched lazily on first switch to the Templates view, then cached
let allTemplateFolders = null; // global (not project-scoped), fetched lazily alongside allTemplates
let allAssemblyTemplates = null; // global assembly-template library, fetched lazily on first switch to the Assemblies view
let allFolders = null; // project-scoped, loaded at init (used by both the By Take-off grouping and the edit modal's folder picker)
let currentView = 'by-item';
let searchTerm = '';
let disciplineFilter = ''; // only meaningful in the By Sheet view - a take-off item has no discipline of its own

// Collapsed folder-group state persists across reloads, same as the sheet
// pane's section-collapse pattern - keyed by folder id, or 'none' for the
// unfiled bucket. Item folders are per-project; template folders are global,
// so they get their own un-scoped storage key.
const itemFolderCollapseKey = `takeoff-folder-collapsed:${projectId}`;
const templateFolderCollapseKey = 'takeoff-template-folder-collapsed';
function loadCollapsedFolders(storageKey) {
  try {
    return new Set(JSON.parse(localStorage.getItem(storageKey)) || []);
  } catch (err) {
    return new Set();
  }
}
function saveCollapsedFolders(storageKey, set) {
  localStorage.setItem(storageKey, JSON.stringify([...set]));
}
let collapsedItemFolders = loadCollapsedFolders(itemFolderCollapseKey);
let collapsedTemplateFolders = loadCollapsedFolders(templateFolderCollapseKey);

// Shared two-choice delete-folder dialog: unlike confirmModal's single
// confirm button, deleting a folder needs a pick between "keep what's in
// it" (default ON DELETE SET NULL behavior) and "delete it all" (cascade).
function openDeleteFolderModal({ title, message, keepLabel, cascadeLabel, onKeep, onCascade }) {
  openModal(`
    <h2>${escapeHtml(title)}</h2>
    <p>${escapeHtml(message)}</p>
    <div class="modal-actions" style="flex-wrap:wrap;">
      <button type="button" id="modal-cancel">Cancel</button>
      <button type="button" id="modal-keep" class="primary">${escapeHtml(keepLabel)}</button>
      <button type="button" id="modal-cascade" class="danger">${escapeHtml(cascadeLabel)}</button>
    </div>
  `);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-keep').addEventListener('click', async () => {
    closeModal();
    await onKeep();
  });
  document.getElementById('modal-cascade').addEventListener('click', async () => {
    closeModal();
    await onCascade();
  });
}

async function loadFolders() {
  try {
    const { folders } = await api('GET', `/api/projects/${projectId}/take-off-folders`);
    allFolders = folders;
  } catch (err) {
    // Must never throw - this is awaited from init() before loadItems(), and
    // an uncaught rejection here would abort the rest of init(), leaving the
    // whole page blank over a feature as minor as folder organization.
    allFolders = allFolders || [];
  }
}
async function createFolder(name) {
  try {
    const { folder } = await api('POST', `/api/projects/${projectId}/take-off-folders`, { name });
    await loadFolders();
    return folder;
  } catch (err) {
    showToast(`Failed to create folder: ${err.message}`, 'error');
    return null;
  }
}

async function performFolderDelete(folderId, cascade) {
  try {
    await api('DELETE', `/api/projects/${projectId}/take-off-folders/${folderId}${cascade ? '?cascade=true' : ''}`);
    showToast(cascade ? 'Folder and its items deleted.' : 'Folder deleted.', 'success');
    await loadFolders();
    await loadItems();
  } catch (err) {
    showToast(`Failed to delete: ${err.message}`, 'error');
  }
}

async function deleteFolder(folder) {
  const count = allItems.filter((i) => i.folder_id === folder.id).length;
  if (count === 0) {
    const ok = await confirmModal({ title: `Delete "${folder.name}"?`, message: 'This folder is empty.', confirmLabel: 'Delete', danger: true });
    if (ok) await performFolderDelete(folder.id, false);
    return;
  }
  openDeleteFolderModal({
    title: `Delete "${folder.name}"?`,
    message: `This folder has ${count} take-off item${count === 1 ? '' : 's'} in it. What would you like to do?`,
    keepLabel: 'Delete folder, keep items',
    cascadeLabel: 'Delete folder and items',
    onKeep: () => performFolderDelete(folder.id, false),
    onCascade: () => performFolderDelete(folder.id, true),
  });
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

// Auto-picks a color for a new template so nobody has to open the color
// picker just to avoid every template defaulting to the same blue - golden-
// angle hue rotation (same technique sheet.js uses for new take-off items)
// stays maximally spread rather than hard-repeating, which plain
// Math.random() can't guarantee over a handful of picks.
function nextTemplateColor() {
  const hue = ((allTemplates || []).length * 137.508) % 360;
  return hslToHex(hue, 65, 45);
}

function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x) =>
    Math.round(255 * x)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

function formatQuantity(type, value) {
  if (type === 'area') return `${value.toLocaleString(undefined, { maximumFractionDigits: 0 })} SF`;
  if (type === 'count') return `${Math.round(value)}`;
  return `${value.toFixed(1)} ft`;
}

// Applies the item's output formula (if any) to rawValue before formatting -
// rawValue can be any subtotal (a whole item's project total, or just one
// sheet's worth), since every real formula is linear in the raw quantity.
// `item` just needs {type, formula, properties, output_label} - works with
// both a full item row and the flat item_* fields the by-sheet endpoint
// returns. Returns separate {output, raw} strings for their own table
// columns - raw is blank when there's no formula, since Total already *is*
// the raw take-off then and repeating it is just noise.
function outputAndRawParts(item, rawValue) {
  const { value, isOutput, label } = computeTakeoffOutput(item, rawValue);
  if (isOutput) {
    const formatted = value.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return { output: label ? `${formatted} ${label}` : formatted, raw: formatQuantity(item.type, rawValue) };
  }
  return { output: formatQuantity(item.type, value), raw: '—' };
}

function formatType(item) {
  return item.type === 'count' ? `count (${item.shape})` : item.type;
}

function unitForType(type) {
  if (type === 'area') return 'SF';
  if (type === 'count') return 'EA';
  return 'ft';
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Same computation as outputAndRawParts, but plain numbers + separate unit
// labels instead of pre-formatted "133.48 CY" strings - CSV needs numeric
// cells Excel can actually do math on, not text it has to parse first.
function outputAndRawNumeric(item, rawValue) {
  const { value, isOutput, label } = computeTakeoffOutput(item, rawValue);
  if (isOutput) {
    return { total: round2(value), totalUnit: label || '', takeoff: round2(rawValue), takeoffUnit: unitForType(item.type) };
  }
  return { total: round2(value), totalUnit: unitForType(item.type), takeoff: '', takeoffUnit: '' };
}

function csvEscape(value) {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

// Built entirely client-side (no backend endpoint) - the output formula is
// only ever evaluated in the browser (see takeoffFormula.js), and allItems
// is already loaded, so there's nothing a server round-trip would add.
// Exports whatever's currently visible (search-filtered), matching what's
// on screen.
function exportTakeoffsCsv() {
  const items = allItems.filter((i) => i.name.toLowerCase().includes(searchTerm));
  const header = ['Name', 'Type', 'Total', 'Total Unit', 'Take-off Qty', 'Take-off Unit', 'Perimeter (ft)', 'Instances'];
  const rows = items.map((item) => {
    const parts = outputAndRawNumeric(item, item.total_quantity);
    const perimeter = item.type === 'area' && item.total_perimeter ? round2(item.total_perimeter) : '';
    return [item.name, formatType(item), parts.total, parts.totalUnit, parts.takeoff, parts.takeoffUnit, perimeter, item.instance_count];
  });
  const csv = [header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'take-offs.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function toggleBreakdown(item, expandBtn, breakdownRow) {
  const isOpen = breakdownRow.style.display !== 'none';
  if (isOpen) {
    breakdownRow.style.display = 'none';
    expandBtn.textContent = '▸'; // ▸
    return;
  }
  expandBtn.textContent = '▾'; // ▾
  breakdownRow.style.display = '';
  const cell = breakdownRow.querySelector('td');
  cell.innerHTML = '<p class="muted">Loading...</p>';
  try {
    const { sheets } = await api('GET', `/api/projects/${projectId}/take-off-items/${item.id}/breakdown`);
    if (sheets.length === 0) {
      cell.innerHTML = '<p class="muted">Not placed on any sheet yet.</p>';
      return;
    }
    const rows = sheets
      .map((s) => {
        const parts = outputAndRawParts(item, s.quantity);
        const perimeter = item.type === 'area' && s.perimeter ? `${s.perimeter.toFixed(1)} ft` : '—';
        return `
        <tr>
          <td><a href="/sheet.html?projectId=${projectId}&sheetId=${s.sheet_id}">${escapeHtml(s.sheet_number)}</a></td>
          <td>${parts.output}</td>
          <td>${parts.raw}</td>
          <td>${perimeter}</td>
        </tr>`;
      })
      .join('');
    cell.innerHTML = `<table class="takeoff-breakdown-table"><thead><tr><th>Drawing</th><th>Total</th><th>Take-off Qty</th><th>Perimeter</th></tr></thead><tbody>${rows}</tbody></table>`;
  } catch (err) {
    cell.innerHTML = `<p class="error">Failed to load: ${escapeHtml(err.message)}</p>`;
  }
}

async function loadItems() {
  try {
    const { items } = await api('GET', `/api/projects/${projectId}/take-off-items`);
    allItems = items;
  } catch (err) {
    allItems = allItems || [];
  }
  renderByItemTable();
}

// Groups rows under folder headers (By Take-off view only - the By Sheet
// view already has its own structure, sheets, so folders don't apply there
// per spec). Named folders sort alphabetically; unfiled items land in a
// trailing "No Folder" bucket, which is also the only bucket shown at all
// when the project has no folders yet.
function renderByItemTable() {
  const items = allItems.filter((i) => i.name.toLowerCase().includes(searchTerm));
  const tbody = document.querySelector('#takeoff-items-table tbody');
  tbody.innerHTML = '';
  document.getElementById('takeoff-empty-msg').style.display = items.length ? 'none' : '';
  document.getElementById('takeoff-empty-msg').textContent = searchTerm
    ? 'No take-off items match your search.'
    : "No take-off items yet. Create one from a sheet's Take-offs pane.";

  const folderMap = new Map((allFolders || []).map((f) => [f.id, f]));
  const groups = new Map(); // folder id, or 'none' -> items[]
  for (const item of items) {
    const key = item.folder_id && folderMap.has(item.folder_id) ? item.folder_id : 'none';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  // Every real folder gets a header even with zero items in it right now -
  // otherwise a freshly-created folder is invisible until something happens
  // to land in it, which is exactly the "I can create a folder but never
  // see it" bug. Only the "No Folder" bucket is conditional (skipped
  // entirely when nothing's unfiled or no folders exist yet).
  const folderKeys = [...folderMap.keys()].sort((a, b) => folderMap.get(a).name.localeCompare(folderMap.get(b).name));
  const orderedKeys = groups.has('none') || folderKeys.length === 0 ? [...folderKeys, 'none'] : folderKeys;
  const showHeaders = folderKeys.length > 0;

  for (const key of orderedKeys) {
    const isCollapsed = collapsedItemFolders.has(String(key));
    if (showHeaders) {
      const folder = key === 'none' ? null : folderMap.get(key);
      const name = folder ? folder.name : 'No Folder';
      const headerRow = document.createElement('tr');
      headerRow.className = 'takeoff-folder-header-row';
      headerRow.innerHTML = `<td colspan="10"><div class="takeoff-folder-header-row-inner">
        <span class="takeoff-folder-toggle" data-key="${key}">${isCollapsed ? '▸' : '▾'} ${escapeHtml(name)}</span>
        ${folder ? `<button type="button" class="icon-btn takeoff-folder-delete-btn" data-id="${folder.id}" data-name="${escapeHtml(folder.name)}" title="Delete folder">&#128465;</button>` : ''}
      </div></td>`;
      tbody.appendChild(headerRow);
    }
    if (isCollapsed) continue;

    for (const item of groups.get(key) || []) {
      const parts = outputAndRawParts(item, item.total_quantity);
      const perimeter = item.type === 'area' && item.total_perimeter ? `${item.total_perimeter.toFixed(1)} ft` : '—';
      const folderOptions =
        '<option value="">No folder</option>' +
        (allFolders || [])
          .map((f) => `<option value="${f.id}" ${item.folder_id === f.id ? 'selected' : ''}>${escapeHtml(f.name)}</option>`)
          .join('');
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><button type="button" class="icon-btn takeoff-expand-btn" title="Show drawings">&#9656;</button></td>
        <td><span class="takeoff-color-dot" style="background:${item.color};"></span></td>
        <td>${escapeHtml(item.name)}</td>
        <td>${escapeHtml(formatType(item))}</td>
        <td><select class="takeoff-folder-select" data-id="${item.id}">${folderOptions}</select></td>
        <td>${parts.output}</td>
        <td>${parts.raw}</td>
        <td>${perimeter}</td>
        <td>${item.instance_count}</td>
        <td>
          <button type="button" class="icon-btn" data-action="edit" data-id="${item.id}" title="Rename / recolor">&#9998;</button>
          <button type="button" class="icon-btn" data-action="delete" data-id="${item.id}" title="Delete">&#128465;</button>
        </td>`;
      tbody.appendChild(tr);

      const breakdownRow = document.createElement('tr');
      breakdownRow.className = 'takeoff-breakdown-row';
      breakdownRow.style.display = 'none';
      breakdownRow.innerHTML = '<td colspan="10"></td>';
      tbody.appendChild(breakdownRow);

      tr.querySelector('.takeoff-expand-btn').addEventListener('click', (e) => {
        toggleBreakdown(item, e.currentTarget, breakdownRow);
        updateExpandAllButtonLabel();
      });
    }
  }
  updateExpandAllButtonLabel();

  tbody.querySelectorAll('[data-action="edit"]').forEach((btn) => {
    btn.addEventListener('click', () => openEditModal(items.find((i) => i.id === Number(btn.dataset.id))));
  });
  tbody.querySelectorAll('[data-action="delete"]').forEach((btn) => {
    btn.addEventListener('click', () => deleteItem(items.find((i) => i.id === Number(btn.dataset.id))));
  });
  // Quick move in/out of a folder without opening the full edit modal -
  // changing the select PATCHes immediately and re-renders (regrouping).
  tbody.querySelectorAll('.takeoff-folder-select').forEach((sel) => {
    sel.addEventListener('change', async () => {
      sel.disabled = true;
      try {
        await api('PATCH', `/api/projects/${projectId}/take-off-items/${sel.dataset.id}`, {
          folder_id: sel.value ? Number(sel.value) : null,
        });
        await loadItems();
      } catch (err) {
        showToast(`Failed to move: ${err.message}`, 'error');
        sel.disabled = false;
      }
    });
  });
  tbody.querySelectorAll('.takeoff-folder-toggle').forEach((el) => {
    el.addEventListener('click', () => {
      const key = el.dataset.key;
      if (collapsedItemFolders.has(key)) collapsedItemFolders.delete(key);
      else collapsedItemFolders.add(key);
      saveCollapsedFolders(itemFolderCollapseKey, collapsedItemFolders);
      renderByItemTable();
    });
  });
  tbody.querySelectorAll('.takeoff-folder-delete-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteFolder({ id: Number(btn.dataset.id), name: btn.dataset.name });
    });
  });
}

async function loadBySheetRows() {
  const { rows } = await api('GET', `/api/projects/${projectId}/take-off-items/by-sheet`);
  bySheetRows = rows;
  populateDisciplineFilter(rows);
}

function populateDisciplineFilter(rows) {
  const select = document.getElementById('takeoff-discipline-filter');
  const current = select.value;
  const disciplines = [...new Set(rows.map((r) => r.discipline).filter(Boolean))].sort();
  select.innerHTML = '<option value="">All</option>' + disciplines.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
  select.value = disciplines.includes(current) ? current : '';
}

// bySheetRows is flat (one row per sheet+item); grouped here into one entry
// per sheet, each holding just the items on it that match the search term -
// mirrors the By Take-off view's per-item expand/collapse, but grouped the
// other way around.
function groupRowsBySheet(rows) {
  const bySheet = new Map();
  for (const r of rows) {
    if (!r.item_name.toLowerCase().includes(searchTerm)) continue;
    if (disciplineFilter && r.discipline !== disciplineFilter) continue;
    if (!bySheet.has(r.sheet_id)) bySheet.set(r.sheet_id, { sheet_id: r.sheet_id, sheet_number: r.sheet_number, items: [] });
    bySheet.get(r.sheet_id).items.push(r);
  }
  return [...bySheet.values()].sort((a, b) => a.sheet_number.localeCompare(b.sheet_number));
}

function renderBySheetTable() {
  const groups = groupRowsBySheet(bySheetRows || []);
  const tbody = document.querySelector('#takeoff-by-sheet-table tbody');
  tbody.innerHTML = '';
  document.getElementById('takeoff-by-sheet-empty-msg').style.display = groups.length ? 'none' : '';
  document.getElementById('takeoff-by-sheet-empty-msg').textContent = searchTerm
    ? 'No take-offs match your search.'
    : 'No take-offs placed yet.';

  for (const group of groups) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><button type="button" class="icon-btn takeoff-expand-btn" title="Show take-offs">&#9656;</button></td>
      <td><a href="/sheet.html?projectId=${projectId}&sheetId=${group.sheet_id}">${escapeHtml(group.sheet_number)}</a></td>
      <td>${group.items.length}</td>`;
    tbody.appendChild(tr);

    const breakdownRow = document.createElement('tr');
    breakdownRow.className = 'takeoff-breakdown-row';
    const itemRows = group.items
      .map((i) => {
        const parts = outputAndRawParts(
          { type: i.item_type, formula: i.item_formula, properties: i.item_properties, output_label: i.item_output_label },
          i.quantity
        );
        const perimeter = i.item_type === 'area' && i.perimeter ? `${i.perimeter.toFixed(1)} ft` : '—';
        return `
        <tr>
          <td><span class="takeoff-color-dot" style="background:${i.item_color};"></span>${escapeHtml(i.item_name)}</td>
          <td>${parts.output}</td>
          <td>${parts.raw}</td>
          <td>${perimeter}</td>
        </tr>`;
      })
      .join('');
    breakdownRow.innerHTML = `<td colspan="3"><table class="takeoff-breakdown-table"><thead><tr><th>Take-off</th><th>Total</th><th>Take-off Qty</th><th>Perimeter</th></tr></thead><tbody>${itemRows}</tbody></table></td>`;
    tbody.appendChild(breakdownRow);

    const expandBtn = tr.querySelector('.takeoff-expand-btn');
    // A live search is already a "show me the match" gesture - expand
    // straight away instead of making the user click again to see it.
    const startOpen = !!searchTerm;
    breakdownRow.style.display = startOpen ? '' : 'none';
    expandBtn.textContent = startOpen ? '▾' : '▸';
    expandBtn.addEventListener('click', () => {
      const isOpen = breakdownRow.style.display !== 'none';
      breakdownRow.style.display = isOpen ? 'none' : '';
      expandBtn.textContent = isOpen ? '▸' : '▾';
      updateExpandAllButtonLabel();
    });
  }
  updateExpandAllButtonLabel();
}

// Reuses each row's own expand button rather than a separate code path -
// "expand all" is just clicking every currently-collapsed one (or every
// expanded one, to collapse), so lazy per-item fetches still go through the
// same toggleBreakdown logic.
function currentViewContainer() {
  return document.getElementById(currentView === 'by-sheet' ? 'takeoff-by-sheet-view' : 'takeoff-by-item-view');
}

function updateExpandAllButtonLabel() {
  const btns = [...currentViewContainer().querySelectorAll('.takeoff-expand-btn')];
  const anyCollapsed = btns.some((b) => b.textContent.trim() === '▸');
  const btn = document.getElementById('takeoff-expand-all-btn');
  btn.textContent = anyCollapsed ? 'Expand all' : 'Collapse all';
  btn.disabled = btns.length === 0;
}

function toggleExpandAll() {
  const btns = [...currentViewContainer().querySelectorAll('.takeoff-expand-btn')];
  const anyCollapsed = btns.some((b) => b.textContent.trim() === '▸');
  for (const b of btns) {
    const isCollapsed = b.textContent.trim() === '▸';
    if (anyCollapsed ? isCollapsed : !isCollapsed) b.click();
  }
  updateExpandAllButtonLabel();
}

async function refreshCurrentView() {
  await loadItems();
  if (currentView === 'by-sheet') {
    bySheetRows = null;
    await loadBySheetRows();
    renderBySheetTable();
  }
}

function setupViewAndSearch() {
  document.querySelectorAll('#takeoff-view-mode button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      currentView = btn.dataset.view;
      document.querySelectorAll('#takeoff-view-mode button').forEach((b) => b.classList.toggle('active', b === btn));
      document.getElementById('takeoff-by-item-view').style.display = currentView === 'by-item' ? '' : 'none';
      document.getElementById('takeoff-by-sheet-view').style.display = currentView === 'by-sheet' ? '' : 'none';
      document.getElementById('takeoff-templates-view').style.display = currentView === 'templates' ? '' : 'none';
      document.getElementById('takeoff-assembly-templates-view').style.display = currentView === 'assemblies' ? '' : 'none';
      // Discipline is a property of sheets, not take-off items, so the
      // filter only makes sense (and only shows) in the By Sheet view.
      document.getElementById('takeoff-discipline-filter-wrap').style.display = currentView === 'by-sheet' ? '' : 'none';
      // Search and expand-all operate on the item/sheet tables, not the
      // template or assembly lists (neither has a per-row expand section or
      // enough rows to usually need searching).
      const isListView = currentView === 'templates' || currentView === 'assemblies';
      document.getElementById('takeoff-search').style.display = isListView ? 'none' : '';
      document.getElementById('takeoff-expand-all-btn').style.display = isListView ? 'none' : '';
      document.getElementById('takeoff-new-template-btn').style.display = currentView === 'templates' ? '' : 'none';
      document.getElementById('takeoff-new-folder-btn').style.display = currentView === 'by-item' ? '' : 'none';
      document.getElementById('takeoff-new-template-folder-btn').style.display = currentView === 'templates' ? '' : 'none';
      document.getElementById('takeoff-new-assembly-template-btn').style.display = currentView === 'assemblies' ? '' : 'none';
      if (currentView === 'by-sheet') {
        if (!bySheetRows) await loadBySheetRows();
        renderBySheetTable();
      } else if (currentView === 'templates') {
        if (!allTemplates) await loadTemplates();
        if (!allTemplateFolders) await loadTemplateFolders();
        renderTemplatesTable();
      } else if (currentView === 'assemblies') {
        if (!allAssemblyTemplates) await loadAssemblyTemplates();
        renderAssemblyTemplatesTable();
      } else {
        renderByItemTable();
      }
    });
  });

  document.getElementById('takeoff-search').addEventListener('input', (e) => {
    searchTerm = e.target.value.trim().toLowerCase();
    if (currentView === 'by-item') renderByItemTable();
    else renderBySheetTable();
  });

  document.getElementById('takeoff-discipline-filter').addEventListener('change', (e) => {
    disciplineFilter = e.target.value;
    renderBySheetTable();
  });

  document.getElementById('takeoff-expand-all-btn').addEventListener('click', toggleExpandAll);
  document.getElementById('takeoff-export-csv-btn').addEventListener('click', exportTakeoffsCsv);
  document.getElementById('takeoff-new-template-btn').addEventListener('click', () => openTemplateModal());
  // Safe to use promptModal directly here (unlike the inline swap inside
  // setupAdvancedFields) - this button lives on the page itself, not nested
  // inside another already-open modal, so there's no parent form for
  // promptModal's own openModal() call to clobber.
  document.getElementById('takeoff-new-folder-btn').addEventListener('click', async () => {
    const name = await promptModal({ title: 'New folder', placeholder: 'e.g. Architectural', confirmLabel: 'Create' });
    if (!name) return;
    const folder = await createFolder(name.trim());
    if (folder) {
      showToast('Folder created.', 'success');
      renderByItemTable();
    }
  });
  document.getElementById('takeoff-new-template-folder-btn').addEventListener('click', async () => {
    const name = await promptModal({ title: 'New folder', placeholder: 'e.g. Steel', confirmLabel: 'Create' });
    if (!name) return;
    const folder = await createTemplateFolder(name.trim());
    if (folder) {
      showToast('Folder created.', 'success');
      renderTemplatesTable();
    }
  });
  document.getElementById('takeoff-new-assembly-template-btn').addEventListener('click', () => openAssemblyTemplateModal());
}

async function loadTemplates() {
  const { templates } = await api('GET', '/api/take-off-templates');
  allTemplates = templates;
}

async function loadTemplateFolders() {
  try {
    const { folders } = await api('GET', '/api/take-off-template-folders');
    allTemplateFolders = folders;
  } catch (err) {
    // Same rule as loadFolders() above - never throw, so a failure here
    // (e.g. a stale server pre-restart) can't take out the whole Templates
    // view switch over folder organization alone.
    allTemplateFolders = allTemplateFolders || [];
  }
}
async function createTemplateFolder(name) {
  try {
    const { folder } = await api('POST', '/api/take-off-template-folders', { name });
    await loadTemplateFolders();
    return folder;
  } catch (err) {
    showToast(`Failed to create folder: ${err.message}`, 'error');
    return null;
  }
}

function renderTemplatesTable() {
  const tbody = document.querySelector('#takeoff-templates-table tbody');
  tbody.innerHTML = '';
  const templates = allTemplates || [];
  document.getElementById('takeoff-templates-empty-msg').style.display = templates.length ? 'none' : '';

  const folderMap = new Map((allTemplateFolders || []).map((f) => [f.id, f]));
  const groups = new Map();
  for (const t of templates) {
    const key = t.folder_id && folderMap.has(t.folder_id) ? t.folder_id : 'none';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  // Same "show every folder, even empty" rule as the By Take-off view - a
  // folder you just created should be visible immediately, not only once
  // something's filed into it.
  const folderKeys = [...folderMap.keys()].sort((a, b) => folderMap.get(a).name.localeCompare(folderMap.get(b).name));
  const orderedKeys = groups.has('none') || folderKeys.length === 0 ? [...folderKeys, 'none'] : folderKeys;
  const showHeaders = folderKeys.length > 0;

  for (const key of orderedKeys) {
    const isCollapsed = collapsedTemplateFolders.has(String(key));
    if (showHeaders) {
      const folder = key === 'none' ? null : folderMap.get(key);
      const name = folder ? folder.name : 'No Folder';
      const headerRow = document.createElement('tr');
      headerRow.className = 'takeoff-folder-header-row';
      headerRow.innerHTML = `<td colspan="6"><div class="takeoff-folder-header-row-inner">
        <span class="takeoff-folder-toggle" data-key="${key}">${isCollapsed ? '▸' : '▾'} ${escapeHtml(name)}</span>
        ${folder ? `<button type="button" class="icon-btn takeoff-folder-delete-btn" data-id="${folder.id}" data-name="${escapeHtml(folder.name)}" title="Delete folder">&#128465;</button>` : ''}
      </div></td>`;
      tbody.appendChild(headerRow);
    }
    if (isCollapsed) continue;

    for (const t of groups.get(key) || []) {
      const folderOptions =
        '<option value="">No folder</option>' +
        (allTemplateFolders || [])
          .map((f) => `<option value="${f.id}" ${t.folder_id === f.id ? 'selected' : ''}>${escapeHtml(f.name)}</option>`)
          .join('');
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><span class="takeoff-color-dot" style="background:${t.color};"></span></td>
        <td>${escapeHtml(t.name)}</td>
        <td>${escapeHtml(formatType(t))}</td>
        <td><select class="takeoff-template-folder-select" data-id="${t.id}">${folderOptions}</select></td>
        <td class="muted">${t.formula ? escapeHtml(t.formula) : '—'}</td>
        <td>
          <button type="button" class="icon-btn" data-action="edit" data-id="${t.id}" title="Edit">&#9998;</button>
          <button type="button" class="icon-btn" data-action="delete" data-id="${t.id}" title="Delete">&#128465;</button>
        </td>`;
      tbody.appendChild(tr);
    }
  }
  tbody.querySelectorAll('[data-action="edit"]').forEach((btn) => {
    btn.addEventListener('click', () => openTemplateModal(templates.find((t) => t.id === Number(btn.dataset.id))));
  });
  tbody.querySelectorAll('[data-action="delete"]').forEach((btn) => {
    btn.addEventListener('click', () => deleteTemplate(templates.find((t) => t.id === Number(btn.dataset.id))));
  });
  tbody.querySelectorAll('.takeoff-template-folder-select').forEach((sel) => {
    sel.addEventListener('change', async () => {
      sel.disabled = true;
      try {
        await api('PATCH', `/api/take-off-templates/${sel.dataset.id}`, { folder_id: sel.value ? Number(sel.value) : null });
        await loadTemplates();
        renderTemplatesTable();
      } catch (err) {
        showToast(`Failed to move: ${err.message}`, 'error');
        sel.disabled = false;
      }
    });
  });
  tbody.querySelectorAll('.takeoff-folder-toggle').forEach((el) => {
    el.addEventListener('click', () => {
      const key = el.dataset.key;
      if (collapsedTemplateFolders.has(key)) collapsedTemplateFolders.delete(key);
      else collapsedTemplateFolders.add(key);
      saveCollapsedFolders(templateFolderCollapseKey, collapsedTemplateFolders);
      renderTemplatesTable();
    });
  });
  tbody.querySelectorAll('.takeoff-folder-delete-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteTemplateFolder({ id: Number(btn.dataset.id), name: btn.dataset.name });
    });
  });
}

async function performTemplateFolderDelete(folderId, cascade) {
  try {
    await api('DELETE', `/api/take-off-template-folders/${folderId}${cascade ? '?cascade=true' : ''}`);
    showToast(cascade ? 'Folder and its templates deleted.' : 'Folder deleted.', 'success');
    await loadTemplateFolders();
    await loadTemplates();
    renderTemplatesTable();
  } catch (err) {
    showToast(`Failed to delete: ${err.message}`, 'error');
  }
}

async function deleteTemplateFolder(folder) {
  const count = (allTemplates || []).filter((t) => t.folder_id === folder.id).length;
  if (count === 0) {
    const ok = await confirmModal({ title: `Delete "${folder.name}"?`, message: 'This folder is empty.', confirmLabel: 'Delete', danger: true });
    if (ok) await performTemplateFolderDelete(folder.id, false);
    return;
  }
  openDeleteFolderModal({
    title: `Delete "${folder.name}"?`,
    message: `This folder has ${count} template${count === 1 ? '' : 's'} in it. What would you like to do?`,
    keepLabel: 'Delete folder, keep templates',
    cascadeLabel: 'Delete folder and templates',
    onKeep: () => performTemplateFolderDelete(folder.id, false),
    onCascade: () => performTemplateFolderDelete(folder.id, true),
  });
}

// template is undefined for "+ New Template". Reuses the exact field set
// the item creation/edit modals use (name/color/shape/Advanced), just POSTs
// or PATCHes /take-off-templates instead of /take-off-items - a template
// has no placement/instance concept of its own.
function openTemplateModal(template) {
  const isEdit = !!template;
  const isCount = template ? template.type === 'count' : false;
  let selectedType = template ? template.type : 'linear';
  let selectedShape = template ? template.shape : 'square';

  openModal(`
    <h2>${isEdit ? 'Edit template' : 'New template'}</h2>
    <div class="field">
      <label>Name</label>
      <input id="template-name" autocomplete="off" placeholder="e.g. 8in CMU Wall">
    </div>
    <div class="field">
      <label>Type</label>
      <select id="template-type" ${isEdit ? 'disabled' : ''}>
        <option value="linear">linear</option>
        <option value="perimeter">perimeter</option>
        <option value="area">area</option>
        <option value="count">count</option>
      </select>
    </div>
    <div class="field" id="template-shape-field" style="display:${selectedType === 'count' ? '' : 'none'};">
      <label>Shape</label>
      <select id="template-shape">
        <option value="square">square</option>
        <option value="circle">circle</option>
        <option value="triangle">triangle</option>
        <option value="diamond">diamond</option>
      </select>
    </div>
    <div class="field">
      <label>Color</label>
      <input type="color" id="template-color" value="${template ? template.color : nextTemplateColor()}">
    </div>
    <div id="template-advanced-root"></div>
    <p class="error" id="template-error" style="display:none;"></p>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Cancel</button>
      <button class="primary" type="button" id="modal-save">${isEdit ? 'Save' : 'Create'}</button>
    </div>
  `);
  document.getElementById('template-name').value = template ? template.name : '';
  document.getElementById('template-name').focus();
  document.getElementById('template-type').value = selectedType;
  document.getElementById('template-shape').value = selectedShape;
  document.getElementById('template-type').addEventListener('change', (e) => {
    selectedType = e.target.value;
    document.getElementById('template-shape-field').style.display = selectedType === 'count' ? '' : 'none';
  });

  const advanced = setupAdvancedFields(document.getElementById('template-advanced-root'), {
    properties: template ? parseTakeoffProperties(template.properties) : [],
    formula: template ? template.formula || '' : '',
    outputLabel: template ? template.output_label || '' : '',
    folders: allTemplateFolders || [],
    folderId: template ? template.folder_id : null,
    onCreateFolder: createTemplateFolder,
  });

  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-save').addEventListener('click', async () => {
    const name = document.getElementById('template-name').value.trim();
    const errEl = document.getElementById('template-error');
    if (!name) {
      errEl.textContent = 'Name is required.';
      errEl.style.display = 'block';
      return;
    }
    const advancedResult = advanced.validate();
    if (!advancedResult.ok) return;
    const { properties, formula, outputLabel, folderId } = advanced.getValue();
    const saveBtn = document.getElementById('modal-save');
    saveBtn.disabled = true;
    const body = {
      name,
      type: selectedType,
      color: document.getElementById('template-color').value,
      shape: selectedType === 'count' ? document.getElementById('template-shape').value : null,
      properties,
      formula: formula || null,
      output_label: outputLabel || null,
      folder_id: folderId,
    };
    try {
      if (isEdit) {
        await api('PATCH', `/api/take-off-templates/${template.id}`, body);
      } else {
        await api('POST', '/api/take-off-templates', body);
      }
      closeModal();
      showToast(`Template ${isEdit ? 'updated' : 'created'}.`, 'success');
      allTemplates = null;
      await loadTemplates();
      renderTemplatesTable();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
      saveBtn.disabled = false;
    }
  });
}

async function deleteTemplate(template) {
  const ok = await confirmModal({
    title: 'Delete this template?',
    message: `"${template.name}" will be removed from the shared template library. Existing take-off items created from it are unaffected.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('DELETE', `/api/take-off-templates/${template.id}`);
    showToast('Template deleted.', 'success');
    allTemplates = null;
    await loadTemplates();
    renderTemplatesTable();
  } catch (err) {
    showToast(`Failed to delete: ${err.message}`, 'error');
  }
}

// ---------- Assembly templates (box take-off blueprints - see sheet.js's
// openAssemblyPickerModal, which is the only other place these were
// reachable from before this tab existed) ----------
const ASSEMBLY_SLOT_FIELDS = [
  { key: 'area', default: 'Area' },
  { key: 'top', default: 'Head' },
  { key: 'bottom', default: 'Sill' },
  { key: 'left', default: 'Left Jamb' },
  { key: 'right', default: 'Right Jamb' },
];

async function loadAssemblyTemplates() {
  const { templates } = await api('GET', '/api/take-off-assembly-templates');
  allAssemblyTemplates = templates;
}

function renderAssemblyTemplatesTable() {
  const tbody = document.querySelector('#takeoff-assembly-templates-table tbody');
  tbody.innerHTML = '';
  const templates = allAssemblyTemplates || [];
  document.getElementById('takeoff-assembly-templates-empty-msg').style.display = templates.length ? 'none' : '';

  for (const t of templates) {
    const slots = ASSEMBLY_SLOT_FIELDS.map((f) => t[`${f.key}_label`]).join(' / ');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(t.name)}</td>
      <td class="muted">${escapeHtml(slots)}</td>
      <td>
        <button type="button" class="icon-btn" data-action="edit" data-id="${t.id}" title="Edit">&#9998;</button>
        <button type="button" class="icon-btn" data-action="delete" data-id="${t.id}" title="Delete">&#128465;</button>
      </td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('[data-action="edit"]').forEach((btn) => {
    btn.addEventListener('click', () => openAssemblyTemplateModal(templates.find((t) => t.id === Number(btn.dataset.id))));
  });
  tbody.querySelectorAll('[data-action="delete"]').forEach((btn) => {
    btn.addEventListener('click', () => deleteAssemblyTemplate(templates.find((t) => t.id === Number(btn.dataset.id))));
  });
}

function openAssemblyTemplateModal(template) {
  const isEdit = !!template;
  openModal(`
    <h2>${isEdit ? 'Edit assembly template' : 'New assembly template'}</h2>
    <div class="field">
      <label>Name</label>
      <input id="assembly-template-name" autocomplete="off" placeholder="e.g. Window">
    </div>
    ${ASSEMBLY_SLOT_FIELDS.map(
      (f) => `
    <div class="field">
      <label>${f.key === 'area' ? 'Area' : f.key[0].toUpperCase() + f.key.slice(1)} slot label</label>
      <input id="assembly-template-${f.key}-label" autocomplete="off">
    </div>`
    ).join('')}
    <p class="error" id="assembly-template-error" style="display:none;"></p>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Cancel</button>
      <button class="primary" type="button" id="modal-save">${isEdit ? 'Save' : 'Create'}</button>
    </div>
  `);
  document.getElementById('assembly-template-name').value = template ? template.name : '';
  document.getElementById('assembly-template-name').focus();
  for (const f of ASSEMBLY_SLOT_FIELDS) {
    document.getElementById(`assembly-template-${f.key}-label`).value = template ? template[`${f.key}_label`] : f.default;
  }

  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-save').addEventListener('click', async () => {
    const name = document.getElementById('assembly-template-name').value.trim();
    const errEl = document.getElementById('assembly-template-error');
    if (!name) {
      errEl.textContent = 'Name is required.';
      errEl.style.display = 'block';
      return;
    }
    const body = { name };
    for (const f of ASSEMBLY_SLOT_FIELDS) {
      body[`${f.key}_label`] = document.getElementById(`assembly-template-${f.key}-label`).value.trim() || f.default;
    }
    const saveBtn = document.getElementById('modal-save');
    saveBtn.disabled = true;
    try {
      if (isEdit) {
        await api('PATCH', `/api/take-off-assembly-templates/${template.id}`, body);
      } else {
        await api('POST', '/api/take-off-assembly-templates', body);
      }
      closeModal();
      showToast(`Assembly template ${isEdit ? 'updated' : 'created'}.`, 'success');
      allAssemblyTemplates = null;
      await loadAssemblyTemplates();
      renderAssemblyTemplatesTable();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
      saveBtn.disabled = false;
    }
  });
}

async function deleteAssemblyTemplate(template) {
  const ok = await confirmModal({
    title: 'Delete this assembly template?',
    message: `"${template.name}" will be removed from the shared template library. Existing assemblies created from it are unaffected.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('DELETE', `/api/take-off-assembly-templates/${template.id}`);
    showToast('Assembly template deleted.', 'success');
    allAssemblyTemplates = null;
    await loadAssemblyTemplates();
    renderAssemblyTemplatesTable();
  } catch (err) {
    showToast(`Failed to delete: ${err.message}`, 'error');
  }
}

function openEditModal(item) {
  openModal(`
    <h2>Edit take-off item</h2>
    <div class="field">
      <label>Name</label>
      <input id="edit-takeoff-name" autocomplete="off">
      <div class="takeoff-name-preview muted" id="edit-takeoff-name-preview" style="display:none;"></div>
    </div>
    <div class="field">
      <label>Color</label>
      <input type="color" id="edit-takeoff-color">
    </div>
    <div id="edit-takeoff-advanced-root"></div>
    <p class="error" id="edit-takeoff-error" style="display:none;"></p>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Cancel</button>
      <button class="primary" type="button" id="modal-save">Save</button>
    </div>
  `);
  document.getElementById('edit-takeoff-name').value = item.name;
  document.getElementById('edit-takeoff-color').value = item.color;
  const editAdvancedRoot = document.getElementById('edit-takeoff-advanced-root');
  const advanced = setupAdvancedFields(editAdvancedRoot, {
    properties: parseTakeoffProperties(item.properties),
    formula: item.formula || '',
    outputLabel: item.output_label || '',
    folders: allFolders || [],
    folderId: item.folder_id,
    onCreateFolder: createFolder,
  });
  wireNamePreview(document.getElementById('edit-takeoff-name'), document.getElementById('edit-takeoff-name-preview'), editAdvancedRoot, advanced);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-save').addEventListener('click', async () => {
    const advancedResult = advanced.validate();
    if (!advancedResult.ok) return;
    const { properties, formula, outputLabel, folderId } = advanced.getValue();
    const saveBtn = document.getElementById('modal-save');
    saveBtn.disabled = true;
    try {
      await api('PATCH', `/api/projects/${projectId}/take-off-items/${item.id}`, {
        name: resolveTakeoffName(document.getElementById('edit-takeoff-name').value.trim(), properties),
        color: document.getElementById('edit-takeoff-color').value,
        properties,
        formula: formula || null,
        output_label: outputLabel || null,
        folder_id: folderId,
      });
      closeModal();
      showToast('Take-off item updated.', 'success');
      await refreshCurrentView();
    } catch (err) {
      const errEl = document.getElementById('edit-takeoff-error');
      errEl.textContent = err.message;
      errEl.style.display = 'block';
      saveBtn.disabled = false;
    }
  });
}

async function deleteItem(item) {
  const ok = await confirmModal({
    title: 'Delete this take-off item?',
    message: `"${item.name}" and all ${item.instance_count} placed segment(s) across every sheet will be permanently removed.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('DELETE', `/api/projects/${projectId}/take-off-items/${item.id}`);
    showToast('Take-off item deleted.', 'success');
    await refreshCurrentView();
  } catch (err) {
    showToast(`Failed to delete: ${err.message}`, 'error');
  }
}

(async function init() {
  const me = await requireSession();
  if (!me) return;
  if (me.role !== 'admin' && !me.can_takeoff) {
    window.location.href = '/dashboard.html';
    return;
  }
  await renderShell({
    topbarEl: document.getElementById('topbar'),
    sidebarEl: document.getElementById('sidebar'),
    projectId,
    active: 'takeoffs',
    me,
  });
  setupViewAndSearch();
  await loadFolders();
  await loadItems();
})();
