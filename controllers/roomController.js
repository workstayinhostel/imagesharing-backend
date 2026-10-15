const jwt = require('jsonwebtoken');
const archiver = require('archiver');
const supabase = require('../config/supabase');
const env = require('../config/env');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const safeCompare = require('../utils/safeCompare');
const r2Service = require('../services/r2Service');
const roomService = require('../services/roomService');
const { logEvent } = require('../services/logService');
const consoleLog = require('../utils/consoleLog');

const SUFFIX_RE = /^[A-Za-z0-9]{1,12}$/;
const PIN_RE = /^[A-Za-z0-9]{3,10}$/; // 3-10 alphanumeric, no spaces
const ARCHIVE_TICKET_TTL_MS = 10 * 60 * 1000;
const MAX_ARCHIVE_FILES = 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ARCHIVE_FILENAME_RE = /[<>:"/\\|?*\u0000-\u001f]/g;

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

function safeArchiveFilename(name) {
  const clean = String(name || 'sharefy-files')
    .replace(ARCHIVE_FILENAME_RE, '-')
    .replace(/[. ]+$/g, '')
    .trim()
    .replace(/\.zip$/i, '')
    .trim()
    .slice(0, 120);
  return `${clean || 'sharefy-files'}.zip`;
}

function safeArchiveEntryNames(files) {
  const used = new Set();
  return files.map((file) => {
    const basename = String(file.file_name || 'file')
      .replace(/\\/g, '/')
      .split('/')
      .pop()
      .replace(ARCHIVE_FILENAME_RE, '-')
      .replace(/^\.+|[. ]+$/g, '') || 'file';
    const dot = basename.lastIndexOf('.');
    const stem = dot > 0 ? basename.slice(0, dot) : basename;
    const extension = dot > 0 ? basename.slice(dot) : '';
    let name = basename;
    let suffix = 2;
    while (used.has(name.toLowerCase())) {
      name = `${stem} (${suffix})${extension}`;
      suffix += 1;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

function archiveContentDisposition(filename) {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

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
  const { roomId, pin, hostToken } = req.body || {};
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

  let role = 'guest';
  if (typeof hostToken === 'string' && hostToken) {
    try {
      const payload = jwt.verify(hostToken, env.jwtSecret);
      if (payload.role === 'host' && payload.roomCode === roomCode) role = 'host';
    } catch {
      // An invalid or expired saved host token only prevents host restoration;
      // a correct room PIN can still join the room as a guest.
    }
  }

  const eventType = role === 'host' ? 'HOST_REJOINED' : 'MEMBER_JOINED';
  const description = `${role === 'host' ? 'The host' : 'A member'} joined ${roomCode}.`;
  await logEvent(eventType, description);
  res.json({
    token: issueToken(roomCode, role, expiresAt),
    room: { roomCode, role, createdAt: room.created_at, expiresAt: expiresAt.toISOString() },
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

/** POST /api/rooms/:code/archive-downloads -> short-lived ticket for a streamed ZIP. */
exports.createArchiveDownload = asyncHandler(async (req, res) => {
  const suppliedIds = req.body?.fileIds;
  if (!Array.isArray(suppliedIds) || suppliedIds.length === 0) {
    throw new AppError(400, 'NO_FILES', 'Choose at least one file to add to the ZIP.');
  }
  if (suppliedIds.length > MAX_ARCHIVE_FILES) {
    throw new AppError(400, 'TOO_MANY_FILES', `A ZIP can contain at most ${MAX_ARCHIVE_FILES} files.`);
  }
  if (suppliedIds.some((id) => typeof id !== 'string' || !UUID_RE.test(id))) {
    throw new AppError(400, 'INVALID_FILE_ID', 'The ZIP contains an invalid file selection.');
  }
  const fileIds = [...new Set(suppliedIds)];
  const fileName = safeArchiveFilename(req.body?.fileName);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ARCHIVE_TICKET_TTL_MS).toISOString();

  const { error: cleanupError } = await supabase
    .from('archive_downloads')
    .delete()
    .lt('expires_at', now);
  if (cleanupError) throw cleanupError;

  const { data, error } = await supabase
    .from('archive_downloads')
    .insert({ room_code: req.room.roomCode, file_ids: fileIds, file_name: fileName, expires_at: expiresAt })
    .select('id')
    .single();
  if (error) throw error;
  res.json({ ticketId: data.id });
});

/** GET /api/rooms/:code/archive-downloads/:ticketId -> one-use streamed ZIP attachment. */
exports.downloadArchive = asyncHandler(async (req, res) => {
  const { code, ticketId } = req.params;
  if (!UUID_RE.test(ticketId)) throw new AppError(404, 'ARCHIVE_NOT_FOUND', 'This ZIP download is unavailable.');
  const roomCode = String(code || '').toUpperCase();
  const now = new Date().toISOString();
  const { data: ticket, error: ticketError } = await supabase
    .from('archive_downloads')
    .select('id, room_code, file_ids, file_name, expires_at')
    .eq('id', ticketId)
    .eq('room_code', roomCode)
    .is('consumed_at', null)
    .gt('expires_at', now)
    .maybeSingle();
  if (ticketError) throw ticketError;
  if (!ticket) throw new AppError(410, 'ARCHIVE_EXPIRED', 'This ZIP download link expired or has already been used. Start the ZIP download again.');

  const { data: claimed, error: claimError } = await supabase
    .from('archive_downloads')
    .update({ consumed_at: now })
    .eq('id', ticket.id)
    .is('consumed_at', null)
    .gt('expires_at', now)
    .select('id')
    .maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) throw new AppError(410, 'ARCHIVE_EXPIRED', 'This ZIP download link expired or has already been used. Start the ZIP download again.');

  const removeTicket = async () => {
    const { error } = await supabase.from('archive_downloads').delete().eq('id', ticket.id);
    if (error) consoleLog('warn', 'archive', `could not remove ticket ${ticket.id}: ${error.message}`);
  };

  try {
    const { data: room, error: roomError } = await supabase
      .from('rooms')
      .select('created_at')
      .eq('room_code', roomCode)
      .maybeSingle();
    if (roomError) throw roomError;
    if (!room || roomService.expiresAtFor(room.created_at).getTime() <= Date.now()) {
      throw new AppError(410, 'ROOM_EXPIRED', 'This room has expired.');
    }

    const fileIds = Array.isArray(ticket.file_ids) ? ticket.file_ids : [];
    if (!fileIds.length || fileIds.length > MAX_ARCHIVE_FILES) {
      throw new AppError(400, 'INVALID_ARCHIVE', 'This ZIP selection is invalid. Start the download again.');
    }
    const { data: roomFiles, error: filesError } = await supabase
      .from('room_files')
      .select('id, file_key, file_name')
      .eq('room_code', roomCode)
      .in('id', fileIds);
    if (filesError) throw filesError;
    if (!roomFiles || roomFiles.length !== fileIds.length) {
      throw new AppError(404, 'FILE_NOT_FOUND', 'One or more selected files are no longer available.');
    }
    const filesById = new Map(roomFiles.map((file) => [file.id, file]));
    const orderedFiles = fileIds.map((id) => filesById.get(id));
    const entryNames = safeArchiveEntryNames(orderedFiles);

    const abortController = new AbortController();
    let activeBody;
    let disconnected = false;
    let streamFailed = false;
    const archive = archiver('zip', { zlib: { level: 0 } });
    const abortOnDisconnect = () => {
      if (res.writableFinished) return;
      disconnected = true;
      abortController.abort();
      activeBody?.destroy();
      archive.destroy();
    };
    const rejectArchiveError = (error) => {
      if (disconnected || streamFailed) return;
      streamFailed = true;
      consoleLog('error', 'archive', `${roomCode} ${ticket.file_name}: ${error.message}`);
      if (res.headersSent) res.destroy(error);
      else res.status(500).json({ error: { code: 'ARCHIVE_FAILED', message: 'Could not prepare this ZIP. Please try again.' } });
      abortController.abort();
      activeBody?.destroy();
    };
    archive.on('warning', rejectArchiveError);
    archive.on('error', rejectArchiveError);
    res.on('close', abortOnDisconnect);

    const appendEntry = (body, name) => new Promise((resolve, reject) => {
      const cleanup = () => {
        archive.off('entry', onEntry);
        archive.off('error', onArchiveError);
        archive.off('warning', onArchiveError);
        body.off('error', onBodyError);
      };
      const onEntry = (entry) => {
        if (entry.name !== name) return;
        cleanup();
        resolve();
      };
      const onArchiveError = (error) => {
        cleanup();
        reject(error);
      };
      const onBodyError = (error) => {
        cleanup();
        reject(error);
      };
      archive.on('entry', onEntry);
      archive.once('error', onArchiveError);
      archive.once('warning', onArchiveError);
      body.once('error', onBodyError);
      archive.append(body, { name });
    });

    try {
      const firstObject = await r2Service.getObjectStream(orderedFiles[0].file_key, abortController.signal);
      if (!firstObject.Body) throw new Error(`Storage returned no data for "${orderedFiles[0].file_name}".`);
      activeBody = firstObject.Body;

      res.status(200);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', archiveContentDisposition(ticket.file_name));
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Accel-Buffering', 'no');
      archive.pipe(res);
      await appendEntry(activeBody, entryNames[0]);

      for (let index = 1; index < orderedFiles.length; index += 1) {
        const file = orderedFiles[index];
        const object = await r2Service.getObjectStream(file.file_key, abortController.signal);
        if (!object.Body) throw new Error(`Storage returned no data for "${file.file_name}".`);
        activeBody = object.Body;
        await appendEntry(activeBody, entryNames[index]);
      }
      activeBody = null;
      await archive.finalize();
    } catch (error) {
      if (!disconnected) rejectArchiveError(error);
    } finally {
      res.off('close', abortOnDisconnect);
      await removeTicket();
    }
  } catch (error) {
    await removeTicket();
    throw error;
  }
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
