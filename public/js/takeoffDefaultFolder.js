// "Last folder used" default for new take-off items. Whenever a folder gets
// assigned to a take-off (create modal, edit modal, quick-move dropdown), that
// choice is remembered and pre-selected for the next new take-off - so a run
// of items that all belong in one folder doesn't need it picked every time.
// Choosing "No folder" clears it. Per-project (folders are project-scoped) and
// per-device, in localStorage, same as the folder collapse state.
const storageKey = (projectId) => `takeoff-default-folder:${projectId}`;

// `folders` is the caller's already-loaded folder list: a remembered id that's
// no longer in it (folder deleted, or the list failed to load) reads as "No
// folder" rather than sending the server an id it will reject.
export function getDefaultTakeoffFolderId(projectId, folders) {
  try {
    const id = Number(localStorage.getItem(storageKey(projectId)));
    return id && (folders || []).some((f) => f.id === id) ? id : null;
  } catch (err) {
    return null;
  }
}

export function setDefaultTakeoffFolderId(projectId, folderId) {
  try {
    if (folderId) localStorage.setItem(storageKey(projectId), String(folderId));
    else localStorage.removeItem(storageKey(projectId));
  } catch (err) {
    // Storage blocked/full - the default just doesn't stick this time.
  }
}
