const path = require('path');

// Extensions the document store (RFI/submittal/photo library) accepts and
// knows how to serve with the right Content-Type. HEIC/HEIF (an iPad
// camera's default format) is deliberately not included - it has no direct
// <img>/canvas support outside Safari, so a photo saved in that format
// wouldn't display for most of the team. iPad Settings > Camera > Formats >
// "Most Compatible" saves JPEGs instead and avoids this.
const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const ALLOWED_DOCUMENT_EXTENSIONS = Object.keys(MIME_BY_EXT);

function extOf(filePath) {
  return path.extname(filePath || '').toLowerCase();
}

function mimeForPath(filePath) {
  return MIME_BY_EXT[extOf(filePath)] || 'application/octet-stream';
}

function isImagePath(filePath) {
  return mimeForPath(filePath).startsWith('image/');
}

// A browser decodes an image by its actual byte content, not its filename -
// renaming a HEIC photo (an iPhone/iPad camera's default format) to .jpg
// does not convert it, and it will fail to display no matter what extension
// or Content-Type header it's served with. Sniffing the real format from
// the first bytes lets upload reject that case immediately with a message
// that explains what actually went wrong, instead of a confusing failure
// later when someone tries to view it.
const EXPECTED_KIND_BY_EXT = { '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png', '.webp': 'webp', '.gif': 'gif', '.pdf': 'pdf' };

function sniffKind(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'GIF8') return 'gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-') return 'pdf';
  if (buf.length >= 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('ascii');
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return 'heic';
  }
  return 'unknown';
}

// Returns an error message string if the file's real content doesn't match
// its extension, or null if it's fine.
function validateFileContent(filePath) {
  const expected = EXPECTED_KIND_BY_EXT[extOf(filePath)];
  if (!expected) return null; // unrecognized extension - fileFilter already blocks this case at upload time
  const fs = require('fs');
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(16);
  fs.readSync(fd, buf, 0, 16, 0);
  fs.closeSync(fd);
  const kind = sniffKind(buf);
  if (kind === expected) return null;
  if (kind === 'heic') {
    return 'This looks like a HEIC photo (an iPhone/iPad default format) renamed to .jpg rather than actually converted - browsers can\'t display HEIC directly. Set the camera to save JPEGs instead (Settings > Camera > Formats > "Most Compatible") or convert the photo before uploading.';
  }
  return `This file's contents don't actually look like a ${extOf(filePath).slice(1).toUpperCase()} - it may be a renamed or corrupted file. Try re-exporting it and uploading again.`;
}

module.exports = { MIME_BY_EXT, ALLOWED_DOCUMENT_EXTENSIONS, extOf, mimeForPath, isImagePath, validateFileContent };
