// "Last folder used" default for new photo pins - same pattern as
// takeoffDefaultFolder.js. Whenever a photo pin is saved to a folder, that
// choice is remembered and pre-selected next time the photo tool is used, so
// a run of job-walk photos that all belong in one folder doesn't need it
// picked every time. Per-project (document_folders are project-scoped) and
// per-device, in localStorage.
const storageKey = (projectId) => `photo-pin-default-folder:${projectId}`;

// `folders` is the caller's already-loaded folder list: a remembered id that's
// no longer in it (folder deleted, or the list failed to load) reads as "No
// folder" rather than sending the server an id it will reject.
export function getDefaultPhotoFolderId(projectId, folders) {
  try {
    const id = Number(localStorage.getItem(storageKey(projectId)));
    return id && (folders || []).some((f) => f.id === id) ? id : null;
  } catch (err) {
    return null;
  }
}

export function setDefaultPhotoFolderId(projectId, folderId) {
  try {
    if (folderId) localStorage.setItem(storageKey(projectId), String(folderId));
    else localStorage.removeItem(storageKey(projectId));
  } catch (err) {
    // Storage blocked/full - the default just doesn't stick this time.
  }
}
