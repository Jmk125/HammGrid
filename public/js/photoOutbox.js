// Photo pin uploads go through a local outbox (IndexedDB, see
// offline-store.js's photo_outbox store) instead of straight to the server,
// so a photo taken on a job walk with no signal - or on trailer WiFi that
// drops mid-upload - is never lost: it's saved on the device first, then
// uploaded whenever the server is reachable again. Online, the upload is
// attempted immediately after queueing, so the only visible difference is
// when it CAN'T reach the server.
//
// No Background Sync API (unreliable/absent on iOS Safari, same reasoning as
// shell.js's pending-jobs toasts) - the outbox is flushed on page load, on
// the browser's 'online' event, when the tab becomes visible again, and on
// a slow timer while anything is still waiting. So queued photos upload the
// next time HammGrid is open with a connection, not while it's closed.
//
// Markups placed offline (kind: 'markup') go through this same outbox, so
// a pin dropped with no signal gets created on the server BEFORE the photos
// taken on it upload - entries are always processed oldest first, and a
// queued pin is always older than its photos. Until then the pin exists
// only on the device under a negative local id (-entry.id), which photo
// entries reference as their markupId; creating the pin rewrites those to
// the real id. Entry shape: { id, kind: 'markup', projectId, url, markup:
// { type, geometry, style, visibility }, createdMarkup?, error? }
//
// Photo entry shape: { id, projectId, sheetId, markupId, documentId, folderId,
// name, filename, bytes, type, queuedAt, createdDocumentId?, error? }
//
// The photo is stored as raw bytes (ArrayBuffer), NOT as the File/Blob
// itself: iOS Safari can hand back a Blob from IndexedDB that uploads
// truncated when put in a FormData (the server sees "Unexpected end of
// form"). ArrayBuffers are always stored by value, and a fresh Blob is built
// from them right before each upload. Entries queued before this change
// have a `blob` field instead - photoBlob() handles both.
//   documentId set   -> add as a new version of that (pin's) document
//   documentId null  -> first photo for an empty pin: create a document in
//                       folderId, then link the pin to it
import { addOutboxPhoto, getOutboxPhotos, putOutboxPhoto, deleteOutboxPhoto, cacheMarkup } from '/js/offline-store.js';
import { showToast } from '/js/shell.js';

const RETRY_MS = 60 * 1000;
let flushing = null;
let retryTimer = null;

export async function queuePhoto({ file, ...entry }) {
  const bytes = await file.arrayBuffer();
  return addOutboxPhoto({
    ...entry,
    filename: file.name,
    type: file.type || 'image/jpeg',
    bytes,
    documentId: entry.documentId || null,
    queuedAt: new Date().toISOString(),
  });
}

// A freshly-built Blob for this entry's photo - used both for uploading and
// for the popup's pending-thumbnail preview.
export async function photoBlob(entry) {
  if (entry.bytes) return new Blob([entry.bytes], { type: entry.type || 'image/jpeg' });
  // Pre-ArrayBuffer entry: copy the stored Blob's bytes into a new one
  // rather than uploading the IndexedDB-backed Blob directly.
  const bytes = await entry.blob.arrayBuffer();
  return new Blob([bytes], { type: entry.blob.type || 'image/jpeg' });
}

async function uploadBlob(entry) {
  let blob;
  try {
    blob = await photoBlob(entry);
  } catch (err) {
    blob = null;
  }
  if (!blob || !blob.size) {
    // Not retryable - the photo data itself is unreadable on this device.
    const err = new Error('The photo data on this device could not be read.');
    err.status = 422;
    throw err;
  }
  return blob;
}

export async function getQueuedPhotos(projectId) {
  const all = (await getOutboxPhotos()).filter((e) => e.kind !== 'markup');
  return projectId == null ? all : all.filter((e) => e.projectId === Number(projectId));
}

export function localMarkupId(entryId) {
  return -entryId;
}

// `url` is the markups collection the markup would have been POSTed to
// (e.g. /api/sheets/12/markups) - it both says where to create it and
// scopes which page shows it while it's still local.
export async function queueMarkup({ projectId, url, markup }) {
  return addOutboxPhoto({ kind: 'markup', projectId: Number(projectId), url, markup, queuedAt: new Date().toISOString() });
}

export async function getQueuedMarkups(url) {
  return (await getOutboxPhotos()).filter((e) => e.kind === 'markup' && e.url === url);
}

// Edits to a not-yet-uploaded markup (drag, re-aim, publish, flag text...)
// just rewrite what will be POSTed. Missing entry = it was uploaded in the
// meantime; the caller falls back to a normal PATCH in that case.
export async function updateQueuedMarkup(entryId, fields) {
  const entry = (await getOutboxPhotos()).find((e) => e.id === entryId);
  if (!entry || entry.createdMarkup) return false;
  entry.markup = { ...entry.markup, ...fields };
  await putOutboxPhoto(entry);
  return true;
}

// Deleting a not-yet-uploaded markup also discards any photos queued on it,
// since they were never saved anywhere else.
export async function deleteQueuedMarkup(entryId) {
  const localId = localMarkupId(entryId);
  for (const e of await getOutboxPhotos()) {
    if (e.id === entryId || e.markupId === localId) await deleteOutboxPhoto(e.id);
  }
}

// Network failure (Safari's "Load failed", Chrome's "Failed to fetch") has
// no HTTP status at all; 5xx / 401 (session lapsed while offline) / 408 /
// 429 are also "try again later", not "this entry is bad".
function isRetryable(err) {
  return !err.status || err.status >= 500 || err.status === 401 || err.status === 408 || err.status === 429;
}

async function postForm(url, fields, blob, filename) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v != null) fd.append(k, v);
  fd.append('file', blob, filename);
  const res = await fetch(url, { method: 'POST', credentials: 'same-origin', body: fd });
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    // no body
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function filenameFor(entry) {
  const ext = (entry.type || (entry.blob && entry.blob.type) || 'image/jpeg').split('/')[1] || 'jpg';
  return entry.filename || `photo-${entry.id}.${ext}`;
}

async function createDocument(entry) {
  const url = `/api/projects/${entry.projectId}/documents`;
  const fields = { name: entry.name, folder_id: entry.folderId || null };
  const blob = await uploadBlob(entry);
  try {
    return (await postForm(url, fields, blob, filenameFor(entry))).document;
  } catch (err) {
    // The chosen folder was deleted while this sat in the outbox - save to
    // the project root rather than lose the photo.
    if (err.status === 400 && entry.folderId) {
      return (await postForm(url, { ...fields, folder_id: null }, blob, filenameFor(entry))).document;
    }
    throw err;
  }
}

async function uploadOne(entry, uploaded) {
  if (entry.documentId) {
    try {
      await postForm(
        `/api/projects/${entry.projectId}/documents/${entry.documentId}/versions`,
        {},
        await uploadBlob(entry),
        filenameFor(entry)
      );
      uploaded.push({ markupId: entry.markupId, documentId: entry.documentId });
      return;
    } catch (err) {
      if (err.status !== 404) throw err;
      // The pin's document was deleted in the meantime - keep the photo as
      // a standalone document instead of dropping it.
      const doc = await createDocument({ ...entry, folderId: null });
      uploaded.push({ markupId: null, documentId: doc.id, document: doc, orphaned: true });
      return;
    }
  }

  // First photo for an empty pin. createdDocumentId is persisted between the
  // two steps so a failure on the link step retries only the link, instead
  // of uploading the photo into a second document.
  if (!entry.createdDocumentId) {
    const doc = await createDocument(entry);
    entry.createdDocumentId = doc.id;
    entry.createdDocument = doc;
    await putOutboxPhoto(entry);
  }
  const docId = entry.createdDocumentId;
  if (entry.markupId < 0) {
    // Still a local-only pin id - only possible when that pin's own creation
    // was rejected. The photo is already saved as its own document.
    uploaded.push({ markupId: null, documentId: docId, document: entry.createdDocument, orphaned: true });
    return;
  }
  try {
    const { markup } = await api('PATCH', `/api/markups/${entry.markupId}`, { linked_document_id: docId });
    await cacheMarkup(entry.projectId, markup).catch(() => {});
  } catch (err) {
    if (err.status !== 404) throw err;
    // Pin was deleted - the photo is already saved as its own document.
    uploaded.push({ markupId: null, documentId: docId, document: entry.createdDocument, orphaned: true });
    return;
  }
  uploaded.push({ markupId: entry.markupId, documentId: docId, document: entry.createdDocument, linked: true });

  // Any later photos queued for this same pin were queued while it was still
  // empty - point them at the document that now exists.
  for (const later of await getOutboxPhotos()) {
    if (later.id !== entry.id && later.markupId === entry.markupId && !later.documentId && !later.createdDocumentId) {
      later.documentId = docId;
      await putOutboxPhoto(later);
    }
  }
}

async function createQueuedMarkup(entry, createdMarkups) {
  // createdMarkup is persisted before the dependent photos are rewritten, so
  // an interruption between the two steps can't create the markup twice.
  if (!entry.createdMarkup) {
    const { markup } = await api('POST', entry.url, entry.markup);
    entry.createdMarkup = markup;
    await putOutboxPhoto(entry);
    await cacheMarkup(entry.projectId, markup).catch(() => {});
  }
  const localId = localMarkupId(entry.id);
  for (const later of await getOutboxPhotos()) {
    if (later.markupId === localId) {
      later.markupId = entry.createdMarkup.id;
      await putOutboxPhoto(later);
    }
  }
  createdMarkups.push({ localId, markup: entry.createdMarkup });
}

async function doFlush() {
  const uploaded = [];
  const createdMarkups = [];
  let failed = 0;
  let remaining = 0;
  let stoppedEarly = false;
  const entries = await getOutboxPhotos();
  for (const entry of entries) {
    if (entry.error) continue;
    // Re-read: an earlier entry in this same pass may have filled in
    // documentId (see uploadOne's "later photos" loop).
    const fresh = (await getOutboxPhotos()).find((e) => e.id === entry.id);
    if (!fresh) continue;
    try {
      if (fresh.kind === 'markup') await createQueuedMarkup(fresh, createdMarkups);
      else await uploadOne(fresh, uploaded);
      await deleteOutboxPhoto(fresh.id);
    } catch (err) {
      if (isRetryable(err)) {
        stoppedEarly = true;
        break;
      }
      // Rejected outright (e.g. 403 after a role change) - keep it on the
      // device, but stop retrying it every minute. (A photo on a pin whose
      // creation was rejected ends up here too, or as a standalone document
      // - its PATCH to the pin's negative local id 404s like a deleted pin.)
      fresh.error = err.message || 'Upload rejected';
      await putOutboxPhoto(fresh);
      failed++;
    }
  }
  remaining = (await getOutboxPhotos()).filter((e) => !e.error).length;

  if (uploaded.length || createdMarkups.length) {
    const orphaned = uploaded.filter((u) => u.orphaned).length;
    const parts = [];
    if (createdMarkups.length) parts.push(`${createdMarkups.length} offline markup${createdMarkups.length === 1 ? '' : 's'} saved`);
    if (uploaded.length) parts.push(`${uploaded.length} photo${uploaded.length === 1 ? '' : 's'} uploaded`);
    showToast(
      parts.join(', ') + '.' +
        (orphaned ? ` ${orphaned} photo${orphaned === 1 ? '' : 's'} saved as standalone documents because the pin or its document was deleted.` : ''),
      'success'
    );
  }
  if (failed) showToast(`${failed} offline item${failed === 1 ? '' : 's'} could not be uploaded and remain on this device.`, 'error');
  window.dispatchEvent(new CustomEvent('photo-outbox-change', { detail: { uploaded, createdMarkups, remaining } }));

  clearTimeout(retryTimer);
  if (remaining) retryTimer = setTimeout(() => flushPhotoOutbox(), RETRY_MS);
  return { uploaded, remaining, stoppedEarly };
}

// Safe to call from anywhere, any number of times - concurrent calls within
// a tab share one run, and Web Locks (where available) stop two open tabs
// from uploading the same entry twice.
export function flushPhotoOutbox() {
  if (flushing) return flushing;
  const run = navigator.locks
    ? navigator.locks.request('hammgrid-photo-outbox', () => doFlush())
    : doFlush();
  flushing = run
    .catch((err) => {
      console.error('Photo outbox flush failed', err);
      return { uploaded: [], remaining: -1 };
    })
    .finally(() => {
      flushing = null;
    });
  return flushing;
}

export function startPhotoOutbox() {
  // api() is a classic-script global (api.js) - pages without it (share
  // links, login) have no session to upload with anyway.
  if (typeof api !== 'function') return;
  const kick = () => {
    getOutboxPhotos()
      .then((all) => {
        if (all.some((e) => !e.error)) flushPhotoOutbox();
      })
      .catch(() => {});
  };
  window.addEventListener('online', kick);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kick();
  });
  kick();
}
