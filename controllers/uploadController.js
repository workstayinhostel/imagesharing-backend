const crypto = require('crypto');
const supabase = require('../config/supabase');
const env = require('../config/env');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { categorize, sanitizeFileName } = require('../utils/fileCategory');
const r2Service = require('../services/r2Service');
const storageGuard = require('../services/storageGuard');
const { roomPrefix } = require('../services/roomService');
const { logEvent } = require('../services/logService');
const consoleLog = require('../utils/consoleLog');

function formatLogBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(1)} ${unit}`;
}

/**
 * POST /api/upload/init
 * body: { files: [{ name, size, type }] }
 *
 * 1. Validates the batch against the 9.5 GB cap (live R2 usage + in-flight + incoming).
 *    If exceeded -> HTTP 400 STORAGE_CAP_REACHED, and NO URLs are generated.
 * 2. Starts one R2 multipart upload per file and returns presigned URLs for every part.
 *    The browser PUTs raw Blob slices straight to R2. File bytes never touch this server.
 */
exports.initUpload = asyncHandler(async (req, res) => {
  const { roomCode } = req.room;
  const files = Array.isArray(req.body?.files) ? req.body.files : [];
  if (!files.length) throw new AppError(400, 'NO_FILES', 'Choose at least one file to upload.');
  if (files.length > env.maxFilesPerInit) {
    throw new AppError(400, 'TOO_MANY_FILES', `Upload at most ${env.maxFilesPerInit} files per batch.`);
  }

  const plan = files.map((f) => {
    const size = Number(f.size);
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new AppError(400, 'INVALID_FILE', `"${f.name || 'file'}" is empty or has an invalid size.`);
    }
    const fileName = sanitizeFileName(f.name);
    return {
      key: `${roomPrefix(roomCode)}${crypto.randomUUID()}/${fileName}`,
      bytes: size,
      roomCode,
      fileName,
      fileType: String(f.type || 'application/octet-stream').slice(0, 120),
    };
  });

  // Hard cap check (throws STORAGE_CAP_REACHED) + persist reservations for these files.
  await storageGuard.checkAndReserve(plan);
  consoleLog('info', 'upload', `init ${roomCode} ${plan.length} file(s), ${formatLogBytes(plan.reduce((total, item) => total + item.bytes, 0))}`);

  const created = [];
  try {
    const uploads = [];
    for (const item of plan) {
      const uploadId = await r2Service.createMultipart(item.key, item.fileType);
      created.push({ key: item.key, uploadId });

      const partCount = Math.max(1, Math.ceil(item.bytes / env.partSizeBytes));
      const parts = await Promise.all(
        Array.from({ length: partCount }, async (_, idx) => {
          const partNumber = idx + 1;
          const start = idx * env.partSizeBytes;
          const length = Math.min(env.partSizeBytes, item.bytes - start);
          const url = await r2Service.presignPart({ key: item.key, uploadId, partNumber, length });
          return { partNumber, url, length };
        })
      );
      uploads.push({ fileName: item.fileName, key: item.key, uploadId, size: item.bytes, partCount, parts });
    }
    consoleLog('info', 'upload', `ready ${roomCode} ${uploads.length} file(s)`);
    res.json({ partSize: env.partSizeBytes, uploads });
  } catch (err) {
    // Roll back anything we started
    await Promise.all(created.map((c) => r2Service.abortMultipart(c.key, c.uploadId)));
    await Promise.all(plan.map((p) => storageGuard.release(p.key)));
    throw err;
  }
});

/**
 * POST /api/upload/complete
 * body: { key, uploadId, parts: [{ partNumber, etag }] }
 * Finalises the multipart upload, verifies the stored size, and records metadata.
 */
exports.completeUpload = asyncHandler(async (req, res) => {
  const { roomCode } = req.room;
  const { key, uploadId, parts } = req.body || {};
  if (!key || !uploadId || !Array.isArray(parts) || !parts.length) {
    throw new AppError(400, 'INVALID_REQUEST', 'Missing upload details.');
  }
  if (!String(key).startsWith(roomPrefix(roomCode))) {
    throw new AppError(403, 'KEY_MISMATCH', 'This upload does not belong to your room.');
  }

  const reservation = await storageGuard.getReservation(key);
  if (reservation && reservation.roomCode !== roomCode) {
    throw new AppError(403, 'KEY_MISMATCH', 'This upload does not belong to your room.');
  }

  consoleLog('info', 'upload', `complete ${roomCode} ${parts.length} part(s)`);
  await r2Service.completeMultipart({ key, uploadId, parts });

  // Trust R2, not the browser: read the real stored size.
  const head = await r2Service.headObject(key);
  const actualSize = Number(head.ContentLength);
  consoleLog('info', 'upload', `stored ${roomCode} ${formatLogBytes(actualSize)}`);

  const fail = async (code, message) => {
    await r2Service.deleteKey(key).catch(() => {});
    await storageGuard.release(key);
    throw new AppError(400, code, message);
  };

  if (reservation && actualSize !== reservation.bytes) {
    await fail('SIZE_MISMATCH', 'The uploaded file size did not match. Please upload it again.');
  }
  if (await storageGuard.isOverCap()) {
    await fail('STORAGE_CAP_REACHED', storageGuard.LIMIT_MESSAGE);
  }

  const fileName = sanitizeFileName(String(key).split('/').pop());
  const fileType = head.ContentType || 'application/octet-stream';
  const category = categorize(fileName, fileType);

  const { data: row, error } = await supabase
    .from('room_files')
    .insert({
      room_code: roomCode,
      file_key: key,
      file_name: fileName,
      file_size_bytes: actualSize,
      file_type: fileType,
      category,
    })
    .select('id, file_name, file_size_bytes, file_type, category, uploaded_at')
    .single();
  if (error) {
    await r2Service.deleteKey(key).catch(() => {});
    await storageGuard.release(key);
    throw error;
  }

  await storageGuard.release(key); // object is now visible in R2 listings
  await logEvent('FILE_UPLOADED', `"${fileName}" (${category}) uploaded to ${roomCode}.`);
  consoleLog('info', 'upload', `saved ${roomCode} ${category} ${formatLogBytes(actualSize)}`);
  res.status(201).json({
    file: {
      id: row.id,
      name: row.file_name,
      size: Number(row.file_size_bytes),
      type: row.file_type,
      category: row.category,
      uploadedAt: row.uploaded_at,
    },
  });
});

/** POST /api/upload/abort  body: { key, uploadId } */
exports.abortUpload = asyncHandler(async (req, res) => {
  const { key, uploadId } = req.body || {};
  if (!key || !uploadId || !String(key).startsWith(roomPrefix(req.room.roomCode))) {
    throw new AppError(400, 'INVALID_REQUEST', 'Missing upload details.');
  }
  await r2Service.abortMultipart(key, uploadId);
  await storageGuard.release(key);
  consoleLog('warn', 'upload', `aborted ${req.room.roomCode}`);
  res.json({ ok: true });
});
