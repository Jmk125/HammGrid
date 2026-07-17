import { renderShell, openModal, closeModal, confirmModal, showToast } from '/js/shell.js';

const projectId = new URLSearchParams(window.location.search).get('projectId');

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function formatQuantity(type, value) {
  if (type === 'area') return `${value.toLocaleString(undefined, { maximumFractionDigits: 0 })} SF`;
  if (type === 'count') return `${Math.round(value)}`;
  return `${value.toFixed(1)} ft`;
}

function formatType(item) {
  return item.type === 'count' ? `count (${item.shape})` : item.type;
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
      .map(
        (s) => `
        <tr>
          <td><a href="/sheet.html?projectId=${projectId}&sheetId=${s.sheet_id}">${escapeHtml(s.sheet_number)}</a></td>
          <td>${formatQuantity(item.type, s.quantity)}</td>
        </tr>`
      )
      .join('');
    cell.innerHTML = `<table class="takeoff-breakdown-table"><thead><tr><th>Drawing</th><th>Quantity</th></tr></thead><tbody>${rows}</tbody></table>`;
  } catch (err) {
    cell.innerHTML = `<p class="error">Failed to load: ${escapeHtml(err.message)}</p>`;
  }
}

async function loadItems() {
  const { items } = await api('GET', `/api/projects/${projectId}/take-off-items`);
  const tbody = document.querySelector('#takeoff-items-table tbody');
  tbody.innerHTML = '';
  document.getElementById('takeoff-empty-msg').style.display = items.length ? 'none' : '';

  for (const item of items) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><button type="button" class="icon-btn takeoff-expand-btn" title="Show drawings">&#9656;</button></td>
      <td><span class="takeoff-color-dot" style="background:${item.color};"></span></td>
      <td>${escapeHtml(item.name)}</td>
      <td>${escapeHtml(formatType(item))}</td>
      <td>${formatQuantity(item.type, item.total_quantity)}</td>
      <td>${item.instance_count}</td>
      <td>
        <button type="button" class="icon-btn" data-action="edit" data-id="${item.id}" title="Rename / recolor">&#9998;</button>
        <button type="button" class="icon-btn" data-action="delete" data-id="${item.id}" title="Delete">&#128465;</button>
      </td>`;
    tbody.appendChild(tr);

    const breakdownRow = document.createElement('tr');
    breakdownRow.className = 'takeoff-breakdown-row';
    breakdownRow.style.display = 'none';
    breakdownRow.innerHTML = '<td colspan="7"></td>';
    tbody.appendChild(breakdownRow);

    tr.querySelector('.takeoff-expand-btn').addEventListener('click', (e) => toggleBreakdown(item, e.currentTarget, breakdownRow));
  }

  tbody.querySelectorAll('[data-action="edit"]').forEach((btn) => {
    btn.addEventListener('click', () => openEditModal(items.find((i) => i.id === Number(btn.dataset.id))));
  });
  tbody.querySelectorAll('[data-action="delete"]').forEach((btn) => {
    btn.addEventListener('click', () => deleteItem(items.find((i) => i.id === Number(btn.dataset.id))));
  });
}

function openEditModal(item) {
  openModal(`
    <h2>Edit take-off item</h2>
    <div class="field">
      <label>Name</label>
      <input id="edit-takeoff-name" autocomplete="off">
    </div>
    <div class="field">
      <label>Color</label>
      <input type="color" id="edit-takeoff-color">
    </div>
    <p class="error" id="edit-takeoff-error" style="display:none;"></p>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">Cancel</button>
      <button class="primary" type="button" id="modal-save">Save</button>
    </div>
  `);
  document.getElementById('edit-takeoff-name').value = item.name;
  document.getElementById('edit-takeoff-color').value = item.color;
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-save').addEventListener('click', async () => {
    const saveBtn = document.getElementById('modal-save');
    saveBtn.disabled = true;
    try {
      await api('PATCH', `/api/projects/${projectId}/take-off-items/${item.id}`, {
        name: document.getElementById('edit-takeoff-name').value,
        color: document.getElementById('edit-takeoff-color').value,
      });
      closeModal();
      showToast('Take-off item updated.', 'success');
      await loadItems();
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
    await loadItems();
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
  await loadItems();
})();
