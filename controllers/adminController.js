const jwt = require('jsonwebtoken');
const supabase = require('../config/supabase');
const env = require('../config/env');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const safeCompare = require('../utils/safeCompare');
const r2Service = require('../services/r2Service');
const roomService = require('../services/roomService');
const storageGuard = require('../services/storageGuard');
const { logEvent } = require('../services/logService');

const CATEGORIES = ['image', 'video', 'archive', 'other'];
const emptyCats = () => Object.fromEntries(CATEGORIES.map((c) => [c, { count: 0, bytes: 0 }]));

/** POST /api/admin/login { key } -> 8h admin session token */
exports.login = asyncHandler(async (req, res) => {
  const { key } = req.body || {};
  if (!key || !safeCompare(key, env.adminMasterKey)) {
    throw new AppError(401, 'ADMIN_AUTH_INVALID', 'That admin key is not correct.');
  }
  await logEvent('ADMIN_LOGIN', 'Admin portal signed in.');
  res.json({ token: jwt.sign({ role: 'admin' }, env.jwtSecret, { expiresIn: '8h' }) });
});

async function loadCategoryStats() {
  const { data, error } = await supabase.from('room_category_stats').select('*');
  if (error) throw error;
  return data || [];
}

/** GET /api/admin/stats -> exact R2 usage + category totals */
exports.getStats = asyncHandler(async (req, res) => {
  const [usage, rows, roomsRes] = await Promise.all([
    r2Service.getBucketUsage(),
    loadCategoryStats(),
    supabase.from('rooms').select('id', { count: 'exact', head: true }),
  ]);
  const categories = emptyCats();
  for (const r of rows) {
    if (!categories[r.category]) continue;
    categories[r.category].count += Number(r.file_count);
    categories[r.category].bytes += Number(r.total_bytes);
  }
  res.json({
    usedBytes: usage.totalBytes,
    objectCount: usage.objectCount,
    capBytes: env.storageCapBytes,
    categories,
    activeRooms: roomsRes.count || 0,
  });
});

/** GET /api/admin/rooms -> every active room with PIN, countdown and per-category breakdown */
exports.listRooms = asyncHandler(async (req, res) => {
  const [{ data: rooms, error }, stats] = await Promise.all([
    supabase.from('rooms').select('room_code, pin, created_at, created_by_ip').order('created_at', { ascending: false }),
    loadCategoryStats(),
  ]);
  if (error) throw error;

  const byRoom = {};
  for (const s of stats) {
    byRoom[s.room_code] ||= emptyCats();
    if (byRoom[s.room_code][s.category]) {
      byRoom[s.room_code][s.category] = { count: Number(s.file_count), bytes: Number(s.total_bytes) };
    }
  }

  res.json({
    rooms: (rooms || []).map((r) => {
      const categories = byRoom[r.room_code] || emptyCats();
      const expiresAt = roomService.expiresAtFor(r.created_at);
      const totals = Object.values(categories).reduce(
        (a, c) => ({ count: a.count + c.count, bytes: a.bytes + c.bytes }),
        { count: 0, bytes: 0 }
      );
      return {
        roomCode: r.room_code,
        pin: r.pin,
        createdAt: r.created_at,
        expiresAt: expiresAt.toISOString(),
        createdByIp: r.created_by_ip,
        categories,
        totalFiles: totals.count,
        totalBytes: totals.bytes,
      };
    }),
  });
});

/** GET /api/admin/logs?limit=100 */
exports.getLogs = asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const { data, error } = await supabase
    .from('system_logs')
    .select('id, event_type, description, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  res.json({ logs: data || [] });
});

/** DELETE /api/admin/rooms/:code -> purge room metadata + all its R2 objects */
exports.deleteRoom = asyncHandler(async (req, res) => {
  const roomCode = String(req.params.code).toUpperCase();
  const result = await roomService.deleteRoomCascade(roomCode);
  await logEvent('ROOM_DELETED', `Room ${roomCode} deleted by admin (${result.deletedObjects} objects).`);
  res.json({ ok: true, ...result });
});

/** POST /api/admin/purge-all { confirm: "PURGE ALL" } -> wipe room storage, preserving the Android app */
exports.purgeAll = asyncHandler(async (req, res) => {
  if (req.body?.confirm !== 'PURGE ALL') {
    throw new AppError(400, 'CONFIRM_REQUIRED', 'Type PURGE ALL to confirm.');
  }
  const allKeys = await r2Service.listKeys(undefined);
  const appKey = 'Application/sahrify-android.apk';
  const keysToDelete = allKeys.filter((key) => key !== appKey);
  await r2Service.deleteKeys(keysToDelete);
  const abortedUploads = await r2Service.abortStaleMultipartUploads(0);
  await storageGuard.clearAll();

  const { error: fErr } = await supabase.from('room_files').delete().not('id', 'is', null);
  if (fErr) throw fErr;
  const { error: rErr } = await supabase.from('rooms').delete().not('id', 'is', null);
  if (rErr) throw rErr;

  await logEvent('PURGE_ALL', `Admin purged room storage (${keysToDelete.length} objects, Android APK preserved, ${abortedUploads} pending uploads aborted).`);
  res.json({ ok: true, deletedObjects: keysToDelete.length, preservedObjects: allKeys.length - keysToDelete.length, abortedUploads });
});
