// Sheet/thumbnail/markup data lives here (IndexedDB for structured metadata,
// OPFS for the binary PDF/WebP blobs) - not the HTTP cache - per CLAUDE.md's
// offline requirements. This is what lets the thumbnail grid and sheet
// viewer read with zero network in the path once synced.

const DB_NAME = 'drawing-app';
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sheets')) db.createObjectStore('sheets', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('markups')) db.createObjectStore('markups', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(db, store, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGetAll(db, store) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db, store, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbDelete(db, store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function putMeta(db, key, value) {
  await idbPut(db, 'meta', { key, value });
}

async function opfsRoot() {
  return navigator.storage.getDirectory();
}

async function writeOpfsFile(name, blob) {
  const root = await opfsRoot();
  const handle = await root.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

async function readOpfsFile(name) {
  try {
    const root = await opfsRoot();
    const handle = await root.getFileHandle(name);
    return await handle.getFile();
  } catch (err) {
    return null;
  }
}

async function deleteOpfsFile(name) {
  try {
    const root = await opfsRoot();
    await root.removeEntry(name);
  } catch (err) {
    // Missing files are already clean.
  }
}

async function deleteVersionAssets(versionId) {
  await Promise.all(['pdf', 'thumb', 'preview'].map((kind) => deleteOpfsFile(`v${versionId}_${kind}`)));
}

export async function requestPersistentStorage() {
  if (navigator.storage && navigator.storage.persist) {
    const already = await navigator.storage.persisted();
    if (!already) await navigator.storage.persist();
  }
}


export async function updateCachedSheetMetadata(projectId, sheet) {
  const db = await openDb();
  const key = `${projectId}:${sheet.id || sheet.sheet_id}`;
  const existing = await idbGet(db, 'sheets', key);
  if (!existing) return;
  await idbPut(db, 'sheets', {
    ...existing,
    sheet_number: sheet.sheet_number ?? existing.sheet_number,
    discipline: sheet.discipline ?? existing.discipline,
    current_version_id: sheet.current_version_id ?? existing.current_version_id,
    current_revision_id: sheet.current_revision_id ?? existing.current_revision_id,
    current_title: sheet.current_title ?? existing.current_title,
  });
}

async function refreshCachedSheetMetadata(projectId, currentSheets) {
  if (!Array.isArray(currentSheets) || currentSheets.length === 0) return;
  const db = await openDb();
  for (const sheet of currentSheets) {
    const key = `${projectId}:${sheet.id}`;
    const existing = await idbGet(db, 'sheets', key);
    if (!existing || existing.current_version_id !== sheet.current_version.id) continue;
    await idbPut(db, 'sheets', {
      ...existing,
      sheet_number: sheet.sheet_number,
      discipline: sheet.discipline,
      current_revision_id: sheet.current_version.revision_id,
      current_title: sheet.current_version.title,
    });
  }
}

export async function syncProject(projectId, { onProgress } = {}) {
  const db = await openDb();
  const cursorKey = `sync-cursor:${projectId}`;
  const stateKey = `sync-state:${projectId}`;
  const cursorRow = await idbGet(db, 'meta', cursorKey);
  const since = cursorRow ? cursorRow.value : undefined;
  const previousSheets = await getCachedSheets(projectId);

  await putMeta(db, stateKey, { status: 'syncing', started_at: new Date().toISOString() });
  try {
    const cachedVersionIds = previousSheets.map((sheet) => sheet.current_version_id).filter(Boolean);
    const res = await fetch(`/api/projects/${projectId}/sync`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ since, cached_version_ids: cachedVersionIds }),
    });
    if (!res.ok) throw new Error(`Sync failed: ${res.status}`);
    const data = await res.json();

    // fetch() only rejects on a network-level failure - a 404/500 response
    // still resolves successfully, and .blob() on it would silently cache the
    // server's error JSON as if it were the real PDF/thumb/preview. Checking
    // res.ok here means a bad asset fails the sync loudly (surfaced as
    // "Offline - showing last synced data" client-side) instead of quietly
    // corrupting what's cached.
    function fetchBlob(url) {
      return fetch(url).then((r) => {
        if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
        return r.blob();
      });
    }

    await refreshCachedSheetMetadata(projectId, data.current_sheets);

    const previouslyCachedVersionIds = new Set(previousSheets.map((sheet) => sheet.current_version_id));
    const sheetsToDownload = data.sheets.filter((sheet) => !previouslyCachedVersionIds.has(sheet.current_version.id));

    let done = 0;
    if (onProgress && sheetsToDownload.length > 0) onProgress(done, sheetsToDownload.length);
    for (const sheet of sheetsToDownload) {
      const cv = sheet.current_version;
      const [pdfBlob, thumbBlob, previewBlob] = await Promise.all([
        fetchBlob(cv.pdf_url),
        fetchBlob(cv.thumb_url),
        fetchBlob(cv.preview_url),
      ]);
      await writeOpfsFile(`v${cv.id}_pdf`, pdfBlob);
      await writeOpfsFile(`v${cv.id}_thumb`, thumbBlob);
      await writeOpfsFile(`v${cv.id}_preview`, previewBlob);

      await idbPut(db, 'sheets', {
        id: `${projectId}:${sheet.id}`,
        project_id: Number(projectId),
        sheet_id: sheet.id,
        sheet_number: sheet.sheet_number,
        discipline: sheet.discipline,
        current_version_id: cv.id,
        current_revision_id: cv.revision_id,
        current_title: cv.title,
      });
      done += 1;
      if (onProgress) onProgress(done, sheetsToDownload.length);
    }

    for (const m of data.markups) {
      await idbPut(db, 'markups', { ...m, project_id: Number(projectId) });
    }

    const currentSheetIds = new Set((data.current_sheet_ids || []).map((id) => Number(id)));
    for (const old of previousSheets) {
      if (currentSheetIds.size > 0 && !currentSheetIds.has(Number(old.sheet_id))) {
        await deleteVersionAssets(old.current_version_id);
        await idbDelete(db, 'sheets', old.id);
      }
    }

    const currentSheets = await getCachedSheets(projectId);
    const currentVersionIds = new Set(currentSheets.map((sheet) => sheet.current_version_id));
    for (const old of previousSheets) {
      if (!currentVersionIds.has(old.current_version_id)) await deleteVersionAssets(old.current_version_id);
    }

    await putMeta(db, cursorKey, data.since);
    await putMeta(db, stateKey, { status: 'synced', last_success_at: new Date().toISOString(), since: data.since });
    return { sheetCount: sheetsToDownload.length, markupCount: data.markups.length, since: data.since };
  } catch (err) {
    await putMeta(db, stateKey, { status: 'error', last_error_at: new Date().toISOString(), message: err.message });
    throw err;
  }
}

export async function getCachedSheets(projectId) {
  const db = await openDb();
  const all = await idbGetAll(db, 'sheets');
  return all.filter((s) => s.project_id === Number(projectId));
}

export async function getCachedMarkupsForSheet(sheetId) {
  const db = await openDb();
  const all = await idbGetAll(db, 'markups');
  return all.filter((m) => m.sheet_id === Number(sheetId));
}

export async function getLastSyncTime(projectId) {
  const db = await openDb();
  const row = await idbGet(db, 'meta', `sync-cursor:${projectId}`);
  return row ? row.value : null;
}

export async function deleteCachedProject(projectId) {
  const db = await openDb();
  const [sheets, markups] = await Promise.all([getCachedSheets(projectId), getCachedMarkupsForSheetProject(projectId)]);
  const versionIds = [...new Set(sheets.map((sheet) => sheet.current_version_id).filter(Boolean))];
  await Promise.all(versionIds.map(deleteVersionAssets));
  await Promise.all(sheets.map((sheet) => idbDelete(db, 'sheets', sheet.id)));
  await Promise.all(markups.map((markup) => idbDelete(db, 'markups', markup.id)));
  await Promise.all([
    idbDelete(db, 'meta', `sync-cursor:${projectId}`),
    idbDelete(db, 'meta', `sync-state:${projectId}`),
  ]);
}

async function getCachedMarkupsForSheetProject(projectId) {
  const db = await openDb();
  const all = await idbGetAll(db, 'markups');
  return all.filter((m) => m.project_id === Number(projectId));
}

export async function getProjectSyncInfo(projectId, project = {}) {
  const db = await openDb();
  const [cursorRow, stateRow, cachedSheets] = await Promise.all([
    idbGet(db, 'meta', `sync-cursor:${projectId}`),
    idbGet(db, 'meta', `sync-state:${projectId}`),
    getCachedSheets(projectId),
  ]);
  const lastSync = cursorRow ? cursorRow.value : null;
  const latestPublished = project.latest_published_at || null;
  const currentSheetCount = Number(project.current_sheet_count || 0);
  const cachedSheetCount = cachedSheets.length;
  const state = stateRow ? stateRow.value : null;
  let status = 'not-synced';
  if (state && state.status === 'syncing') status = 'syncing';
  else if (currentSheetCount === 0) status = 'empty';
  else if (!lastSync || cachedSheetCount === 0) status = 'not-synced';
  else if (latestPublished && lastSync < latestPublished) status = 'needs-sync';
  else if (cachedSheetCount < currentSheetCount) status = 'needs-sync';
  else status = 'synced';
  return { status, lastSync, latestPublished, currentSheetCount, cachedSheetCount, state };
}

// kind: 'pdf' | 'thumb' | 'preview'. Returns a File (Blob) or null if not cached.
export async function getCachedAsset(versionId, kind) {
  return readOpfsFile(`v${versionId}_${kind}`);
}
