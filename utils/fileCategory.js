const IMAGE_EXT = new Set([
  'jpg', 'jpeg', 'png', 'heic', 'heif', 'raw', 'bay', 'cap', 'cr2', 'cr3', 'crw',
  'dcs', 'dcr', 'dng', 'drf', 'erf', 'k25', 'kdc', 'mef', 'mos', 'mrw', 'nef',
  'nrw', 'orf', 'pef', 'ptx', 'r3d', 'raf', 'rw2', 'rwl', 'sr2', 'srf', 'srw',
  'x3f', '3fr', 'arw', 'iiq', 'fff', 'tif', 'tiff', 'webp', 'gif', 'bmp',
]);
const VIDEO_EXT = new Set(['mp4', 'mov', 'mkv', 'avi', 'm4v', 'webm', 'mts', 'mxf']);
const ARCHIVE_EXT = new Set(['zip', 'rar', '7z', 'tar', 'gz']);
const RAW_EXT = new Set([
  '3fr', 'arw', 'bay', 'cap', 'cr2', 'cr3', 'crw', 'dcs', 'dcr', 'dng', 'drf',
  'erf', 'fff', 'iiq', 'k25', 'kdc', 'mef', 'mos', 'mrw', 'nef', 'nrw', 'orf',
  'pef', 'ptx', 'r3d', 'raf', 'raw', 'rw2', 'rwl', 'sr2', 'srf', 'srw', 'x3f',
]);

/** Returns one of: image | video | archive | other */
function categorize(fileName = '', mimeType = '') {
  const ext = String(fileName).split('.').pop().toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (ARCHIVE_EXT.has(ext)) return 'archive';
  const mime = String(mimeType).toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (['application/zip', 'application/x-rar-compressed', 'application/x-7z-compressed'].includes(mime)) return 'archive';
  return 'other';
}

function sanitizeFileName(name) {
  return String(name)
    .replace(/[\\/\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200) || 'file';
}

function isRawImage(fileName = '') {
  return RAW_EXT.has(String(fileName).split('.').pop().toLowerCase());
}

module.exports = { categorize, sanitizeFileName, isRawImage };
