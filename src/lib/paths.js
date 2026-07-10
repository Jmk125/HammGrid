const path = require('path');

// File paths stored in the DB (pdf_path, thumb_path, preview_path,
// overlay_path) must always use forward slashes, regardless of which OS
// wrote them. CLAUDE.md's own environment notes call for possibly moving
// ingest work between the Windows dev box and the Pi it's normally served
// from - path.join()'s OS-native separator (backslash on Windows) breaks
// the moment that data is read on Linux, where backslash isn't a path
// separator at all, just a literal character in the filename. Node's fs
// APIs accept forward slashes fine on Windows too, so there's no downside
// to normalizing everywhere a path gets persisted or read back.
function toPortablePath(p) {
  return p.split(path.sep).join('/');
}

module.exports = { toPortablePath };
