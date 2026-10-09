const path = require('path');
const fs = require('fs');

// Extensions the document store (RFI/submittal/photo library) accepts and
// knows how to serve with the right Content-Type. HEIC/HEIF (an iPad
// camera's default format) is accepted at upload but never actually stored
// or served as-is - documentUpload.js converts it to a real JPEG first,
// since browsers have no direct <img>/canvas support for it regardless of
// what extension or Content-Type it's served with.
const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heic',
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

// A browser (or this sniffer) decodes/recognizes a file by its actual byte
// content, not its filename - renaming a HEIC photo to .jpg doesn't convert
// it. Used two ways: EXPECTED_KIND_BY_EXT + sniffKind together catch a
// genuine mismatch (wrong/corrupted file), and sniffKind alone flags HEIC
// content for conversion (documentUpload.js) regardless of which extension
// it arrived under - a mislabeled .jpg is exactly as common in practice as
// a correctly-named .heic.
const EXPECTED_KIND_BY_EXT = {
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.png': 'png',
  '.webp': 'webp',
  '.gif': 'gif',
  '.pdf': 'pdf',
  '.heic': 'heic',
  '.heif': 'heic',
};

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

function readMagicBytes(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(16);
  fs.readSync(fd, buf, 0, 16, 0);
  fs.closeSync(fd);
  return buf;
}

// { kind, expected, matches } - matches is true when the sniffed content
// agrees with what the extension claims (or the extension is unrecognized,
// which fileFilter already blocks at upload time regardless).
function checkFileContent(filePath) {
  const expected = EXPECTED_KIND_BY_EXT[extOf(filePath)];
  const kind = sniffKind(readMagicBytes(filePath));
  return { kind, expected, matches: !expected || kind === expected };
}

module.exports = {
  MIME_BY_EXT,
  ALLOWED_DOCUMENT_EXTENSIONS,
  extOf,
  mimeForPath,
  isImagePath,
  sniffKind,
  checkFileContent,
};
