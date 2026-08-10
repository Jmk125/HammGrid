// Sheet/thumbnail/markup data lives here (IndexedDB for structured metadata,
// OPFS for binary PDF/WebP blobs when available, with an IndexedDB blob
// fallback for browsers/origins that do not expose OPFS) - not the HTTP cache.
// This is what lets the thumbnail grid and sheet viewer read with zero
// network in the path once synced.

const DB_NAME = 'drawing-app';
const DB_VERSION = 4;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sheets')) db.createObjectStore('sheets', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('markups')) db.createObjectStore('markups', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'name' });
      // v3: the dashboard's project list itself was never cached anywhere -
      // syncProject() only ever caches sheets/thumbnails/markups WITHIN a
      // project you've already opened, so a device that goes offline before
      // ever loading the dashboard online has no way to discover which
      // projects even exist. See cacheProjectList/getCachedProjectList.
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      // v4: take-off items/assemblies/instances were never cached either -
      // same gap as v3's project list, one level down (the pane's tools
      // silently showed nothing/stale data offline). Each row gets a
      // synthetic project_id field at write time (items/assemblies already
      // have one from the API; instances don't - sheet_id is what the
      // server row actually has) so reads/reconciliation can scope by
      // project without a second lookup, same trick the 'sheets' store
      // already uses.
      if (!db.objectStoreNames.contains('takeoff_items')) db.createObjectStore('takeoff_items', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('takeoff_assemblies')) db.createObjectStore('takeoff_assemblies', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('takeoff_instances')) db.createObjectStore('takeoff_instances', { keyPath: 'id' });
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
  if (!navigator.storage || !navigator.storage.getDirectory) return null;
  try {
    return await navigator.storage.getDirectory();
  } catch (err) {
    return null;
  }
}

async function writeAssetFile(name, blob) {
  const root = await opfsRoot();
  if (root) {
    const handle = await root.getFileHandle(name, { create: true });
    // Safari's OPFS implementation exposes getDirectory()/getFileHandle()
    // (so opfsRoot() above succeeds) but does NOT implement
    // createWritable() at all - only the synchronous access-handle API,
    // which is worker-only and a much bigger redesign than this warrants.
    // Chrome has always supported createWritable() (why this only ever
    // showed up on the iPad, never on PC) - detect it explicitly and fall
    // back to the IndexedDB blob store (below) rather than crash.
    if (typeof handle.createWritable === 'function') {
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    }
    // getFileHandle(create:true) above already created a real (empty) file
    // as a side effect, regardless of whether createWritable exists - left
    // in place, that empty file would poison every future read.
    // readAssetFile tries OPFS first and only falls through to IndexedDB on
    // an error, but an empty file IS a successful read (a valid, if
    // pointless, zero-byte File) - it would never even look at IndexedDB,
    // where the real blob is about to be written instead. Clean it up.
    await root.removeEntry(name).catch(() => {});
  }
  const db = await openDb();
  await idbPut(db, 'assets', { name, blob });
}

async function readAssetFile(name) {
  const root = await opfsRoot();
  if (root) {
    try {
      const handle = await root.getFileHandle(name);
      return await handle.getFile();
    } catch (err) {
      // Fall through to IndexedDB in case this asset was cached before OPFS was available.
    }
  }
  const db = await openDb();
  const row = await idbGet(db, 'assets', name);
  return row ? row.blob : null;
}

async function deleteAssetFile(name) {
  const root = await opfsRoot();
  if (root) {
    try {
      await root.removeEntry(name);
    } catch (err) {
      // Missing files are already clean.
    }
  }
  const db = await openDb();
  await idbDelete(db, 'assets', name);
}

async function deleteVersionAssets(versionId) {
  await Promise.all(['pdf', 'thumb', 'preview'].map((kind) => deleteAssetFile(`v${versionId}_${kind}`)));
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
    scale_feet_per_inch: sheet.scale_feet_per_inch !== undefined ? sheet.scale_feet_per_inch : existing.scale_feet_per_inch,
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
      // Scale/scale-zones are sheet metadata (not tied to the PDF version),
      // so this needs refreshing even when the sheet's current version -
      // and therefore its cached PDF - hasn't changed at all.
      scale_feet_per_inch: sheet.scale_feet_per_inch,
      scale_zones: sheet.scale_zones || [],
    });
  }
}


// Caches the dashboard's project list (id/name/number/location/size/
// first_thumbnail_url/current_sheet_count/latest_published_at - whatever
// GET /api/projects returns) so the dashboard itself has something to
// render offline, not just individual projects already opened once. A
// straight replace, not an incremental sync like sheets/markups get - this
// is "what does the dashboard look like right now", so a project deleted
// or renamed server-side should disappear/update here too the next time
// this succeeds while online, not linger as a stale duplicate.
export async function cacheProjectList(projects) {
  const db = await openDb();
  const existing = await idbGetAll(db, 'projects');
  const currentIds = new Set(projects.map((p) => p.id));
  for (const old of existing) {
    if (!currentIds.has(old.id)) await idbDelete(db, 'projects', old.id);
  }
  for (const p of projects) await idbPut(db, 'projects', p);
}

export async function getCachedProjectList() {
  const db = await openDb();
  return idbGetAll(db, 'projects');
}

// Shared by the three take-off stores below - all are "this project's
// current full list", replaced (not incrementally merged) on every sync,
// same reasoning as cacheProjectList: small lists, and a deleted/edited
// item/assembly/instance should disappear/update here too, not linger.
// scopeKey lets the same helper work for items/assemblies (already carry
// project_id from the API) and instances (only carry sheet_id - the caller
// passes a synthetic project_id per row instead, see cacheTakeoffInstances).
async function reconcileProjectScopedStore(store, projectId, rows) {
  const db = await openDb();
  const existing = await idbGetAll(db, store);
  const existingForProject = existing.filter((r) => r.project_id === Number(projectId));
  const newIds = new Set(rows.map((r) => r.id));
  for (const old of existingForProject) {
    if (!newIds.has(old.id)) await idbDelete(db, store, old.id);
  }
  for (const row of rows) await idbPut(db, store, { ...row, project_id: Number(projectId) });
}

export async function cacheTakeoffItems(projectId, items) {
  await reconcileProjectScopedStore('takeoff_items', projectId, items);
}

export async function getCachedTakeoffItems(projectId) {
  const db = await openDb();
  const all = await idbGetAll(db, 'takeoff_items');
  return all.filter((r) => r.project_id === Number(projectId));
}

export async function cacheTakeoffAssemblies(projectId, assemblies) {
  await reconcileProjectScopedStore('takeoff_assemblies', projectId, assemblies);
}

export async function getCachedTakeoffAssemblies(projectId) {
  const db = await openDb();
  const all = await idbGetAll(db, 'takeoff_assemblies');
  return all.filter((r) => r.project_id === Number(projectId));
}

// Instances don't carry project_id on the server row (only sheet_id) -
// reconcileProjectScopedStore still works, it just gets project_id attached
// per-row here (rather than it already being present, like items/
// assemblies) before being handed off, so reads can still scope by project
// without a sheets lookup.
export async function cacheTakeoffInstances(projectId, instances) {
  await reconcileProjectScopedStore('takeoff_instances', projectId, instances);
}

export async function getCachedTakeoffInstancesForSheet(sheetId) {
  const db = await openDb();
  const all = await idbGetAll(db, 'takeoff_instances');
  return all.filter((r) => r.sheet_id === Number(sheetId));
}

export async function ensureProjectCacheFresh(projectId, project = {}) {
  if (!project.created_at) return;
  const db = await openDb();
  const key = `project-created-at:${projectId}`;
  const row = await idbGet(db, 'meta', key);
  if (row && row.value && row.value !== project.created_at) {
    await deleteCachedProject(projectId);
  }
  const freshDb = await openDb();
  await putMeta(freshDb, key, project.created_at);
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
      await writeAssetFile(`v${cv.id}_pdf`, pdfBlob);
      await writeAssetFile(`v${cv.id}_thumb`, thumbBlob);
      await writeAssetFile(`v${cv.id}_preview`, previewBlob);

      await idbPut(db, 'sheets', {
        id: `${projectId}:${sheet.id}`,
        project_id: Number(projectId),
        sheet_id: sheet.id,
        sheet_number: sheet.sheet_number,
        discipline: sheet.discipline,
        current_version_id: cv.id,
        current_revision_id: cv.revision_id,
        current_title: cv.title,
        scale_feet_per_inch: sheet.scale_feet_per_inch,
        scale_zones: sheet.scale_zones || [],
      });
      done += 1;
      if (onProgress) onProgress(done, sheetsToDownload.length);
    }

    for (const m of data.markups) {
      await idbPut(db, 'markups', { ...m, project_id: Number(projectId) });
    }

    // Take-off items/assemblies/instances - separate endpoints, not part of
    // the main sync payload above (see takeoffProjectInstances.routes.js's
    // comment for why instances specifically needed a new project-wide
    // route). Wrapped in its own try/catch, deliberately isolated from the
    // rest of this function: these endpoints 403 for any user without
    // can_takeoff (view-only/non-takeoff viewers are common and expected),
    // and that must not fail the whole sync - sheets/markups already
    // succeeded above and should still count as synced.
    try {
      const [itemsRes, assembliesRes, instancesRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/take-off-items`, { credentials: 'same-origin' }),
        fetch(`/api/projects/${projectId}/take-off-assemblies`, { credentials: 'same-origin' }),
        fetch(`/api/projects/${projectId}/take-off-instances`, { credentials: 'same-origin' }),
      ]);
      if (itemsRes.ok && assembliesRes.ok && instancesRes.ok) {
        const [{ items }, { assemblies }, { instances }] = await Promise.all([
          itemsRes.json(),
          assembliesRes.json(),
          instancesRes.json(),
        ]);
        await cacheTakeoffItems(projectId, items);
        await cacheTakeoffAssemblies(projectId, assemblies);
        await cacheTakeoffInstances(projectId, instances);
      }
    } catch (err) {
      // Take-off caching is best-effort - sheets/markups syncing
      // successfully is the part that must not be undermined by this.
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
    idbDelete(db, 'meta', `project-created-at:${projectId}`),
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
  // state is overwritten on every attempt (see syncProject's try/catch), so
  // 'error' here always means the MOST RECENT attempt failed - regardless
  // of whether an earlier attempt (reflected in lastSync) ever succeeded.
  // Surfacing this distinctly (not just falling through to the generic
  // not-synced/needs-sync text below) is what actually makes a real
  // failure diagnosable from the UI instead of looking identical to
  // "just hasn't synced yet".
  else if (state && state.status === 'error') status = 'error';
  else if (currentSheetCount === 0) status = 'empty';
  else if (!lastSync || cachedSheetCount === 0) status = 'not-synced';
  else if (latestPublished && lastSync < latestPublished) status = 'needs-sync';
  else if (cachedSheetCount < currentSheetCount) status = 'needs-sync';
  else status = 'synced';
  return { status, lastSync, latestPublished, currentSheetCount, cachedSheetCount, state };
}

// kind: 'pdf' | 'thumb' | 'preview'. Returns a File (Blob) or null if not cached.
export async function getCachedAsset(versionId, kind) {
  return readAssetFile(`v${versionId}_${kind}`);
}
