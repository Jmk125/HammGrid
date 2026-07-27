// Shared "Advanced" properties + output-formula UI, embedded in three
// places: the sheet-view item creation modal, its edit modal, and the
// Templates tab's template modal (see sheet.js/takeoffs.js). Renders into a
// caller-provided placeholder <div> and returns { getValue, validate } for
// the caller to pull final state from on submit.
import { evaluateFormula, slugifyPropertyName, RESERVED_VARIABLE_NAME, resolveTakeoffName } from '/js/takeoffFormula.js';

// Live "Preview: 2 x 2.5 Footing" hint below a Name field that contains
// "[Property]" placeholders - purely informational, doesn't touch the input
// itself. The actual resolution into a real name happens once, at submit
// time, in the caller (see resolveTakeoffName usage in sheet.js/takeoffs.js).
export function wireNamePreview(nameInput, previewEl, advancedContainerEl, advanced) {
  function update() {
    if (/\[[^\]]+\]/.test(nameInput.value)) {
      const { properties } = advanced.getValue();
      previewEl.textContent = `Preview: ${resolveTakeoffName(nameInput.value, properties)}`;
      previewEl.style.display = '';
    } else {
      previewEl.style.display = 'none';
    }
  }
  nameInput.addEventListener('input', update);
  advancedContainerEl.addEventListener('input', update);
  update();
}

export function setupAdvancedFields(containerEl, initial = {}) {
  const initialProperties = (initial.properties || []).map((p) => ({ name: p.name || '', value: p.value ?? '' }));
  let expanded = initial.expanded !== undefined ? initial.expanded : initialProperties.length > 0 || !!initial.formula;
  // Folder UI is opt-in - only the sheet-view/takeoffs.html item modals pass
  // `folders` (project-scoped organization); the global Templates modal
  // doesn't, since a folder is project-specific and a template isn't.
  const hasFolders = Array.isArray(initial.folders);
  const NEW_FOLDER_VALUE = '__new__';

  containerEl.innerHTML = `
    <button type="button" class="takeoff-advanced-toggle" id="ta-toggle">${expanded ? '▾' : '▸'} Advanced</button>
    <div class="takeoff-advanced-body" id="ta-body" style="display:${expanded ? '' : 'none'};">
      ${
        hasFolders
          ? `<div class="field">
               <label>Folder</label>
               <select id="ta-folder"></select>
               <div class="row" id="ta-folder-new-row" style="display:none; margin-top:4px;">
                 <input type="text" id="ta-folder-new-name" placeholder="New folder name" autocomplete="off" style="flex:1;">
                 <button type="button" id="ta-folder-new-add">Add</button>
                 <button type="button" id="ta-folder-new-cancel">Cancel</button>
               </div>
             </div>`
          : ''
      }
      <div class="field">
        <label>Properties</label>
        <div id="ta-property-rows"></div>
        <button type="button" class="takeoff-advanced-add-btn" id="ta-add-property">+ Add property</button>
      </div>
      <div class="field">
        <label>Output formula</label>
        <input type="text" id="ta-formula" placeholder="e.g. takeoff * Wall_Height" autocomplete="off">
        <div class="takeoff-formula-hint" id="ta-hint"></div>
        <div class="takeoff-formula-chips" id="ta-chips"></div>
      </div>
      <div class="field">
        <label>Output label</label>
        <input type="text" id="ta-output-label" placeholder="e.g. SF, CY, EA" autocomplete="off">
      </div>
      <p class="error" id="ta-error" style="display:none;"></p>
    </div>
  `;

  const toggleBtn = containerEl.querySelector('#ta-toggle');
  const body = containerEl.querySelector('#ta-body');
  const rowsEl = containerEl.querySelector('#ta-property-rows');
  const addBtn = containerEl.querySelector('#ta-add-property');
  const formulaInput = containerEl.querySelector('#ta-formula');
  const hintEl = containerEl.querySelector('#ta-hint');
  const chipsEl = containerEl.querySelector('#ta-chips');
  const outputLabelInput = containerEl.querySelector('#ta-output-label');
  const errorEl = containerEl.querySelector('#ta-error');

  formulaInput.value = initial.formula || '';
  outputLabelInput.value = initial.outputLabel || '';

  let folders = hasFolders ? [...initial.folders] : [];
  const folderSelect = hasFolders ? containerEl.querySelector('#ta-folder') : null;
  function renderFolderOptions(selectedId) {
    if (!folderSelect) return;
    folderSelect.innerHTML =
      '<option value="">No folder</option>' +
      folders.map((f) => `<option value="${f.id}">${f.name}</option>`).join('') +
      `<option value="${NEW_FOLDER_VALUE}">+ New folder...</option>`;
    folderSelect.value = selectedId ? String(selectedId) : '';
  }
  if (hasFolders) {
    renderFolderOptions(initial.folderId);
    folderSelect.dataset.prev = initial.folderId ? String(initial.folderId) : '';
    const newRow = containerEl.querySelector('#ta-folder-new-row');
    const newNameInput = containerEl.querySelector('#ta-folder-new-name');
    // An inline swap, not a nested promptModal() - promptModal opens its own
    // modal-backdrop, and openModal() always calls closeModal() first (see
    // shell.js), which would silently wipe out this entire item-creation
    // form (name, properties, everything typed so far) the instant a second
    // modal opened on top of it.
    folderSelect.addEventListener('change', () => {
      if (folderSelect.value !== NEW_FOLDER_VALUE) {
        folderSelect.dataset.prev = folderSelect.value;
        return;
      }
      folderSelect.style.display = 'none';
      newRow.style.display = 'flex';
      newNameInput.value = '';
      newNameInput.focus();
    });
    containerEl.querySelector('#ta-folder-new-cancel').addEventListener('click', () => {
      newRow.style.display = 'none';
      folderSelect.style.display = '';
      renderFolderOptions(folderSelect.dataset.prev);
    });
    containerEl.querySelector('#ta-folder-new-add').addEventListener('click', async () => {
      const name = newNameInput.value.trim();
      if (!name) return;
      const addBtn2 = containerEl.querySelector('#ta-folder-new-add');
      addBtn2.disabled = true;
      try {
        const created = initial.onCreateFolder ? await initial.onCreateFolder(name) : null;
        if (created) {
          folders.push(created);
          folderSelect.dataset.prev = String(created.id);
        }
        newRow.style.display = 'none';
        folderSelect.style.display = '';
        renderFolderOptions(created ? created.id : folderSelect.dataset.prev);
      } finally {
        addBtn2.disabled = false;
      }
    });
  }

  toggleBtn.addEventListener('click', () => {
    expanded = !expanded;
    body.style.display = expanded ? '' : 'none';
    toggleBtn.textContent = `${expanded ? '▾' : '▸'} Advanced`;
  });

  function currentVariableNames() {
    const names = [RESERVED_VARIABLE_NAME];
    for (const row of rowsEl.querySelectorAll('.takeoff-property-row')) {
      const nameVal = row.querySelector('.takeoff-property-name').value.trim();
      if (nameVal) names.push(slugifyPropertyName(nameVal));
    }
    return names;
  }

  function insertAtCursor(text) {
    const start = formulaInput.selectionStart ?? formulaInput.value.length;
    const end = formulaInput.selectionEnd ?? formulaInput.value.length;
    formulaInput.value = formulaInput.value.slice(0, start) + text + formulaInput.value.slice(end);
    const caret = start + text.length;
    formulaInput.focus();
    formulaInput.setSelectionRange(caret, caret);
  }

  function refreshChipsAndHint() {
    const names = currentVariableNames();
    hintEl.textContent = `Available: ${names.join(', ')}`;
    chipsEl.innerHTML = '';
    for (const name of names) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'takeoff-formula-chip';
      chip.textContent = name;
      chip.addEventListener('click', () => insertAtCursor(name));
      chipsEl.appendChild(chip);
    }
  }

  function addPropertyRow(name = '', value = '') {
    const row = document.createElement('div');
    row.className = 'takeoff-property-row';
    row.innerHTML = `
      <input type="text" class="takeoff-property-name" placeholder="Property name (e.g. Wall Height)" autocomplete="off">
      <input type="number" class="takeoff-property-value" placeholder="Value" step="any">
      <button type="button" class="icon-btn takeoff-property-remove" title="Remove property">&#128465;</button>
    `;
    const nameInput = row.querySelector('.takeoff-property-name');
    const valueInput = row.querySelector('.takeoff-property-value');
    nameInput.value = name;
    valueInput.value = value;
    nameInput.addEventListener('input', refreshChipsAndHint);
    row.querySelector('.takeoff-property-remove').addEventListener('click', () => {
      row.remove();
      refreshChipsAndHint();
    });
    rowsEl.appendChild(row);
  }

  for (const p of initialProperties) addPropertyRow(p.name, p.value);
  addBtn.addEventListener('click', () => {
    addPropertyRow();
    refreshChipsAndHint();
  });
  refreshChipsAndHint();

  function readRawProperties() {
    return [...rowsEl.querySelectorAll('.takeoff-property-row')]
      .map((row) => ({
        name: row.querySelector('.takeoff-property-name').value.trim(),
        value: row.querySelector('.takeoff-property-value').value,
      }))
      .filter((p) => p.name || p.value !== '');
  }

  function getValue() {
    return {
      properties: readRawProperties().map((p) => ({ name: p.name, value: Number(p.value) || 0 })),
      formula: formulaInput.value.trim(),
      outputLabel: outputLabelInput.value.trim(),
      folderId: hasFolders ? (folderSelect.value ? Number(folderSelect.value) : null) : undefined,
    };
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.style.display = message ? 'block' : 'none';
    if (message && !expanded) {
      expanded = true;
      body.style.display = '';
      toggleBtn.textContent = '▾ Advanced';
    }
  }

  function validate() {
    const { properties: props, formula } = getValue();
    for (const p of props) {
      if (!p.name) return fail('Every property needs a name.');
      if (!Number.isFinite(p.value)) return fail(`"${p.name}" needs a numeric value.`);
    }
    const slugs = props.map((p) => slugifyPropertyName(p.name));
    if (slugs.some((s) => s === RESERVED_VARIABLE_NAME)) {
      return fail(`A property can't be named "${RESERVED_VARIABLE_NAME}" - that name is reserved for the raw take-off quantity.`);
    }
    const dupe = slugs.find((s, i) => slugs.indexOf(s) !== i);
    if (dupe) return fail(`Property names must be unique ("${dupe}" is used more than once).`);
    if (formula) {
      const variables = { [RESERVED_VARIABLE_NAME]: 1 };
      props.forEach((p, i) => {
        variables[slugs[i]] = p.value;
      });
      const result = evaluateFormula(formula, variables);
      if (!result.ok) return fail(`Formula error: ${result.error}`);
    }
    showError('');
    return { ok: true };

    function fail(message) {
      showError(message);
      return { ok: false, error: message };
    }
  }

  return { getValue, validate };
}
