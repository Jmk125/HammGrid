import { renderShell, openModal, closeModal, confirmModal, promptModal, showToast } from '/js/shell.js';

const projectId = new URLSearchParams(window.location.search).get('projectId');
const ROLES = ['admin', 'editor', 'viewer'];
let me;

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function load() {
  const { users } = await api('GET', '/api/users');
  const tbody = document.querySelector('#users-table tbody');
  tbody.innerHTML = '';
  for (const u of users) {
    const isSelf = u.id === me.id;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(u.name)}${isSelf ? ' <span class="muted">(you)</span>' : ''}</td>
      <td>${escapeHtml(u.username)}</td>
      <td></td>
      <td></td>
      <td class="muted">${escapeHtml(u.created_at)}</td>
      <td class="row"></td>`;

    const roleCell = tr.children[2];
    const roleSelect = document.createElement('select');
    for (const r of ROLES) roleSelect.appendChild(new Option(r, r, false, r === u.role));
    if (isSelf) {
      roleSelect.disabled = true;
      roleSelect.title = "You cannot change your own role.";
    }
    roleSelect.addEventListener('change', async () => {
      try {
        await api('PUT', `/api/users/${u.id}`, { role: roleSelect.value });
        showToast(`${u.name}'s role updated.`, 'success');
        await load();
      } catch (err) {
        showToast(err.message, 'error');
        roleSelect.value = u.role;
      }
    });
    roleCell.appendChild(roleSelect);

    const takeoffCell = tr.children[3];
    const takeoffCheck = document.createElement('input');
    takeoffCheck.type = 'checkbox';
    takeoffCheck.checked = u.can_takeoff;
    takeoffCheck.title = 'Can access Take-offs (admins always can)';
    takeoffCheck.disabled = u.role === 'admin';
    takeoffCheck.addEventListener('change', async () => {
      try {
        await api('PUT', `/api/users/${u.id}`, { can_takeoff: takeoffCheck.checked });
        showToast(`${u.name}'s access updated.`, 'success');
      } catch (err) {
        showToast(err.message, 'error');
        takeoffCheck.checked = !takeoffCheck.checked;
      }
    });
    takeoffCell.appendChild(takeoffCheck);

    const actions = tr.lastElementChild;
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.textContent = 'Reset password';
    resetBtn.addEventListener('click', async () => {
      const pw = await promptModal({
        title: `Reset password for ${u.name}`,
        message: 'Enter a new password. They should change it after logging in.',
        placeholder: 'New password',
      });
      if (!pw) return;
      await api('PUT', `/api/users/${u.id}`, { password: pw });
      showToast('Password reset.', 'success');
    });
    actions.appendChild(resetBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'danger';
    deleteBtn.textContent = 'Delete';
    if (isSelf) {
      deleteBtn.disabled = true;
      deleteBtn.title = 'You cannot delete your own account.';
    }
    deleteBtn.addEventListener('click', async () => {
      const ok = await confirmModal({
        title: `Delete ${u.name}?`,
        message: 'This cannot be undone. Their published markups and activity history are kept, but they will lose access immediately.',
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      await api('DELETE', `/api/users/${u.id}`);
      showToast('User deleted.', 'success');
      await load();
    });
    actions.appendChild(deleteBtn);

    tbody.appendChild(tr);
  }
}

function openAddUserModal() {
  openModal(`
    <h2>Add user</h2>
    <div class="field"><label>Name</label><input id="nu-name" placeholder="e.g. Jane Doe"></div>
    <div class="field"><label>Username</label><input id="nu-username" autocomplete="off"></div>
    <div class="field"><label>Password</label><input id="nu-password" type="password" autocomplete="new-password"></div>
    <div class="field">
      <label>Role</label>
      <select id="nu-role">
        <option value="editor">Editor</option>
        <option value="viewer">Viewer</option>
        <option value="admin">Admin</option>
      </select>
    </div>
    <label class="row" style="gap:6px;"><input type="checkbox" id="nu-takeoff"> Can access Take-offs</label>
    <p class="error" id="nu-error" style="display:none;"></p>
    <div class="modal-actions">
      <button type="button" id="nu-cancel">Cancel</button>
      <button class="primary" type="button" id="nu-create">Add user</button>
    </div>
  `);
  document.getElementById('nu-cancel').addEventListener('click', closeModal);
  document.getElementById('nu-create').addEventListener('click', async () => {
    const name = document.getElementById('nu-name').value.trim();
    const username = document.getElementById('nu-username').value.trim();
    const password = document.getElementById('nu-password').value;
    const err = document.getElementById('nu-error');
    if (!name || !username || !password) {
      err.textContent = 'Name, username, and password are required.';
      err.style.display = 'block';
      return;
    }
    try {
      await api('POST', '/api/users', {
        name,
        username,
        password,
        role: document.getElementById('nu-role').value,
        can_takeoff: document.getElementById('nu-takeoff').checked,
      });
      closeModal();
      showToast(`${name} added.`, 'success');
      await load();
    } catch (e) {
      err.textContent = e.message;
      err.style.display = 'block';
    }
  });
}

(async function init() {
  me = await requireSession();
  if (!me) return;
  if (me.role !== 'admin') {
    document.querySelector('main').innerHTML = '<h1>Users</h1><p class="error">Admin access required.</p>';
    return;
  }
  await renderShell({
    topbarEl: document.getElementById('topbar'),
    sidebarEl: document.getElementById('sidebar'),
    projectId,
    active: 'users',
    me,
  });
  document.getElementById('add-user-btn').addEventListener('click', openAddUserModal);
  try {
    await load();
  } catch (e) {
    document.getElementById('error').textContent = e.message;
    document.getElementById('error').style.display = 'block';
  }
})();
