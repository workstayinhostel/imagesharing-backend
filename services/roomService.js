const supabase = require('../config/supabase');
const env = require('../config/env');
const r2Service = require('./r2Service');
const { logEvent } = require('./logService');

const roomPrefix = (roomCode) => `rooms/${roomCode}/`;

const expiresAtFor = (createdAt) => new Date(new Date(createdAt).getTime() + env.roomTtlMs);

/**
 * Cascade delete:
 *  1) abort incomplete uploads and stream-delete every object under the room prefix
 *  2) delete any legacy DB-referenced keys outside the prefix
 *  3) delete file metadata + room rows from Supabase
 */
async function deleteRoomCascade(roomCode) {
  const { data: files, error } = await supabase
    .from('room_files')
    .select('file_key, file_size_bytes')
    .eq('room_code', roomCode);
  if (error) throw new Error(`Failed to load files for ${roomCode}: ${error.message}`);

  const prefix = roomPrefix(roomCode);
  const legacyKeys = [...new Set((files || [])
    .map((file) => file.file_key)
    .filter((key) => key && !key.startsWith(prefix)))];
  const abortedMultipartUploads = await r2Service.abortMultipartUploads(prefix);
  const deletedPrefixObjects = await r2Service.deletePrefix(prefix);
  await r2Service.deleteKeys(legacyKeys);

  const { error: fErr } = await supabase.from('room_files').delete().eq('room_code', roomCode);
  if (fErr) throw new Error(`Failed to delete file rows: ${fErr.message}`);
  const { error: rErr } = await supabase.from('rooms').delete().eq('room_code', roomCode);
  if (rErr) throw new Error(`Failed to delete room row: ${rErr.message}`);

  const freedBytes = (files || []).reduce((s, f) => s + Number(f.file_size_bytes || 0), 0);
  return {
    deletedObjects: deletedPrefixObjects + legacyKeys.length,
    abortedMultipartUploads,
    freedBytes,
  };
}

/** Removes one expired room when a room operation encounters it. */
async function expireRoom(roomCode) {
  const result = await deleteRoomCascade(roomCode);
  await logEvent('ROOM_AUTO_EXPIRED', `ROOM_AUTO_EXPIRED: Room ${roomCode} deleted after 48h.`);
  return result;
}

/** Deletes rooms whose 48-hour lifetime has elapsed. Individual failures do not block other rooms. */
async function cleanupExpiredRooms() {
  const cutoff = new Date(Date.now() - env.roomTtlMs).toISOString();
  const { data: rooms, error } = await supabase
    .from('rooms')
    .select('room_code')
    .lte('created_at', cutoff);
  if (error) throw new Error(`Failed to find expired rooms: ${error.message}`);

  let deletedRooms = 0;
  let failedRooms = 0;
  for (const { room_code: roomCode } of rooms || []) {
    try {
      await expireRoom(roomCode);
      deletedRooms += 1;
    } catch (error) {
      failedRooms += 1;
      console.error(`[sharefy] Failed to clean up expired room ${roomCode}:`, error);
    }
  }

  return { deletedRooms, failedRooms };
}

module.exports = { deleteRoomCascade, expireRoom, cleanupExpiredRooms, roomPrefix, expiresAtFor };
