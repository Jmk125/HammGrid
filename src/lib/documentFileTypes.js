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

module.exports = { MIME_BY_EXT, ALLOWED_DOCUMENT_EXTENSIONS, extOf, mimeForPath, isImagePath };
