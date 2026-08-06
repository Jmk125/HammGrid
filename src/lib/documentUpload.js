const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runPython } = require('./pyRunner');
const { extOf, checkFileContent } = require('./documentFileTypes');

const CONVERT_SCRIPT = path.join(__dirname, '..', '..', 'pyproc', 'convert_to_jpeg.py');

// Runs after multer has already saved an upload to disk. Converts a HEIC
// photo (iPhone/iPad's default camera format) to a real JPEG regardless of
// which extension it arrived under - a mislabeled .jpg is exactly as common
// in practice as a correctly-named .heic, and neither displays in a browser
// without this. Returns the path that should actually be stored/served;
// unchanged for anything that isn't HEIC and matches its extension.
// Throws with a user-facing message for anything that should be rejected
// (a genuine mismatch, or a HEIC file the converter itself couldn't read).
async function resolveUploadedFile(savedPath) {
  const check = checkFileContent(savedPath);

  if (check.kind === 'heic') {
    const convertedPath = path.join(path.dirname(savedPath), `${crypto.randomUUID()}.jpg`);
    try {
      await runPython(CONVERT_SCRIPT, [savedPath, convertedPath]);
    } catch (err) {
      throw new Error(
        'Could not convert this HEIC photo (it may be corrupted or an unsupported variant) - try re-exporting it and uploading again.'
      );
    } finally {
      fs.unlink(savedPath, () => {});
    }
    return convertedPath;
  }

  if (!check.matches) {
    throw new Error(
      `This file's contents don't actually look like a ${extOf(savedPath).slice(1).toUpperCase()} - it may be a renamed or corrupted file. Try re-exporting it and uploading again.`
    );
  }

  return savedPath;
}

module.exports = { resolveUploadedFile };
