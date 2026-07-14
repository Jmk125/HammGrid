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

export async function requestPersistentStorage() {
  if (navigator.storage && navigator.storage.persist) {
    const already = await navigator.storage.persisted();
    if (!already) await navigator.storage.persist();
  }
}

export async function syncProject(projectId, { onProgress } = {}) {
  const db = await openDb();
  const cursorKey = `sync-cursor:${projectId}`;
  const cursorRow = await idbGet(db, 'meta', cursorKey);
  const since = cursorRow ? cursorRow.value : undefined;

  const qs = since ? `?since=${encodeURIComponent(since)}` : '';
  const res = await fetch(`/api/projects/${projectId}/sync${qs}`);
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

  let done = 0;
  for (const sheet of data.sheets) {
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
    if (onProgress) onProgress(done, data.sheets.length);
  }

  for (const m of data.markups) {
    await idbPut(db, 'markups', { ...m, project_id: Number(projectId) });
  }

  await idbPut(db, 'meta', { key: cursorKey, value: data.since });
  return { sheetCount: data.sheets.length, markupCount: data.markups.length, since: data.since };
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

// kind: 'pdf' | 'thumb' | 'preview'. Returns a File (Blob) or null if not cached.
export async function getCachedAsset(versionId, kind) {
  return readOpfsFile(`v${versionId}_${kind}`);
}
