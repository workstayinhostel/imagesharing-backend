const jwt = require('jsonwebtoken');
const supabase = require('../config/supabase');
const env = require('../config/env');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const safeCompare = require('../utils/safeCompare');
const r2Service = require('../services/r2Service');
const roomService = require('../services/roomService');
const { logEvent } = require('../services/logService');

const SUFFIX_RE = /^[A-Za-z0-9]{1,12}$/;
const PIN_RE = /^[A-Za-z0-9]{3,10}$/; // 3-10 alphanumeric, no spaces

const normalizeCode = (raw) => {
  const code = String(raw || '').replace(/\s+/g, '').toUpperCase();
  return code.startsWith('RM') ? code : `RM${code}`;
};

function issueToken(roomCode, role, expiresAt) {
  const seconds = Math.max(60, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  return jwt.sign({ roomCode, role }, env.jwtSecret, { expiresIn: seconds });
}

const fileDto = (f) => ({
  id: f.id,
  name: f.file_name,
  size: Number(f.file_size_bytes),
  type: f.file_type,
  category: f.category,
  uploadedAt: f.uploaded_at,
});

/** POST /api/rooms/create  { suffix, pin } -> room RM<suffix>, caller becomes host */
exports.createRoom = asyncHandler(async (req, res) => {
  const { suffix, pin } = req.body || {};
  if (!SUFFIX_RE.test(String(suffix || ''))) {
    throw new AppError(400, 'INVALID_ROOM_ID', 'Room ID must be 1-12 letters or numbers (for example 99 creates RM99).');
  }
  if (!PIN_RE.test(String(pin || ''))) {
    throw new AppError(400, 'INVALID_PIN', 'PIN must be 3-10 letters or numbers with no spaces.');
  }
  const roomCode = `RM${String(suffix).toUpperCase()}`;

  // An expired-but-not-yet-cleaned room with this code frees the code immediately.
  const { data: existing, error: exErr } = await supabase
    .from('rooms')
    .select('room_code, created_at')
    .eq('room_code', roomCode)
    .maybeSingle();
  if (exErr) throw exErr;
  if (existing) {
    if (roomService.expiresAtFor(existing.created_at).getTime() > Date.now()) {
      throw new AppError(409, 'ROOM_EXISTS', `${roomCode} is already taken. Pick a different room ID.`);
    }
    await roomService.expireRoom(roomCode);
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + env.roomTtlMs);
  const { error } = await supabase.from('rooms').insert({
    room_code: roomCode,
    pin: String(pin),
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    created_by_ip: req.ip,
  });
  if (error) {
    if (error.code === '23505') throw new AppError(409, 'ROOM_EXISTS', `${roomCode} is already taken. Pick a different room ID.`);
    throw error;
  }

  await logEvent('ROOM_CREATED', `Room ${roomCode} created.`);
  res.status(201).json({
    token: issueToken(roomCode, 'host', expiresAt),
    room: { roomCode, role: 'host', createdAt: now.toISOString(), expiresAt: expiresAt.toISOString() },
  });
});

/** POST /api/rooms/join  { roomId, pin } */
exports.joinRoom = asyncHandler(async (req, res) => {
  const { roomId, pin } = req.body || {};
  if (!roomId || !pin) throw new AppError(400, 'MISSING_FIELDS', 'Enter both the room ID and the PIN.');
  const roomCode = normalizeCode(roomId);

  const { data: room, error } = await supabase
    .from('rooms')
    .select('room_code, pin, created_at')
    .eq('room_code', roomCode)
    .maybeSingle();
  if (error) throw error;

  // Same error for "no room" and "wrong PIN" so room IDs can't be probed.
  const bad = () => new AppError(401, 'INVALID_CREDENTIALS', 'Room ID or PIN is incorrect.');
  if (!room) throw bad();
  if (!safeCompare(room.pin, String(pin))) throw bad();

  const expiresAt = roomService.expiresAtFor(room.created_at);
  if (expiresAt.getTime() <= Date.now()) {
    throw new AppError(410, 'ROOM_EXPIRED', 'This room expired after 48 hours.');
  }

  await logEvent('MEMBER_JOINED', `A member joined ${roomCode}.`);
  res.json({
    token: issueToken(roomCode, 'guest', expiresAt),
    room: { roomCode, role: 'guest', createdAt: room.created_at, expiresAt: expiresAt.toISOString() },
  });
});

/** GET /api/rooms/:code/status  (public) -> does this room exist? Used by the share-link PIN modal. */
exports.roomStatus = asyncHandler(async (req, res) => {
  const roomCode = normalizeCode(req.params.code);
  const { data: room, error } = await supabase
    .from('rooms')
    .select('room_code, created_at')
    .eq('room_code', roomCode)
    .maybeSingle();
  if (error) throw error;
  const exists = !!room && roomService.expiresAtFor(room.created_at).getTime() > Date.now();
  res.json({ roomCode, exists });
});

/** GET /api/rooms/:code  (auth) -> room + files */
exports.getRoom = asyncHandler(async (req, res) => {
  const { roomCode, role, createdAt, expiresAt } = req.room;
  const { data: files, error } = await supabase
    .from('room_files')
    .select('id, file_name, file_size_bytes, file_type, category, uploaded_at')
    .eq('room_code', roomCode)
    .order('uploaded_at', { ascending: false });
  if (error) throw error;
  res.json({ room: { roomCode, role, createdAt, expiresAt }, files: (files || []).map(fileDto) });
});

/** GET /api/rooms/:code/files/:fileId/download -> short-lived presigned URL to the untouched original */
exports.getDownloadUrl = asyncHandler(async (req, res) => {
  const { data: file, error } = await supabase
    .from('room_files')
    .select('file_key, file_name')
    .eq('id', req.params.fileId)
    .eq('room_code', req.room.roomCode)
    .maybeSingle();
  if (error) throw error;
  if (!file) throw new AppError(404, 'FILE_NOT_FOUND', 'File not found.');
  const url = await r2Service.presignDownload(file.file_key, file.file_name);
  res.json({ url, fileName: file.file_name });
});

/** DELETE /api/rooms/:code/files/:fileId  (host only) */
exports.deleteFile = asyncHandler(async (req, res) => {
  if (req.room.role !== 'host') throw new AppError(403, 'HOST_ONLY', 'Only the room host can delete files.');
  const { data: file, error } = await supabase
    .from('room_files')
    .select('id, file_key, file_name')
    .eq('id', req.params.fileId)
    .eq('room_code', req.room.roomCode)
    .maybeSingle();
  if (error) throw error;
  if (!file) throw new AppError(404, 'FILE_NOT_FOUND', 'File not found.');

  await r2Service.deleteKey(file.file_key);
  const { error: dErr } = await supabase.from('room_files').delete().eq('id', file.id);
  if (dErr) throw dErr;
  await logEvent('FILE_DELETED', `File "${file.file_name}" deleted from ${req.room.roomCode}.`);
  res.json({ ok: true });
});

/** DELETE /api/rooms/:code  (host only) -> host closes their own room early */
exports.deleteRoom = asyncHandler(async (req, res) => {
  if (req.room.role !== 'host') throw new AppError(403, 'HOST_ONLY', 'Only the room host can delete the room.');
  const result = await roomService.deleteRoomCascade(req.room.roomCode);
  await logEvent(
    'ROOM_DELETED',
    `Room ${req.room.roomCode} deleted by its host (${result.deletedObjects} R2 objects and ${result.abortedMultipartUploads} incomplete uploads removed).`
  );
  res.json({ ok: true });
});
