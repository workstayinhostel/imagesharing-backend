const env = require('../config/env');
const AppError = require('../utils/AppError');
const r2Service = require('./r2Service');
const supabase = require('../config/supabase');

const LIMIT_MESSAGE =
  'Storage cap reached (9.5 GB maximum). Delete older files or rooms before uploading more.';

/**
 * R2 provides observed bucket usage; a Supabase RPC atomically includes committed
 * file rows and active reservations so concurrent API instances cannot overbook.
 */
async function checkAndReserve(items) {
  const usage = await r2Service.getBucketUsage();
  const { data: reserved, error } = await supabase.rpc('reserve_upload_storage', {
    p_files: items.map((item) => ({
      upload_key: item.key,
      room_code: item.roomCode,
      bytes: item.bytes,
    })),
    p_observed_usage: usage.totalBytes,
    p_capacity_bytes: env.storageCapBytes,
    p_expires_at: new Date(Date.now() + env.roomTtlMs).toISOString(),
  });
  if (error?.code === 'PGRST202') {
    throw new AppError(
      500,
      'STORAGE_GUARD_NOT_CONFIGURED',
      'Storage protection is not installed in the database. Apply the current schema.sql in Supabase and reload the schema cache.'
    );
  }
  if (error) throw error;
  if (!reserved) throw new AppError(400, 'STORAGE_CAP_REACHED', LIMIT_MESSAGE);
}

async function getReservation(key) {
  const { data, error } = await supabase
    .from('upload_reservations')
    .select('room_code, bytes')
    .eq('upload_key', key)
    .maybeSingle();
  if (error) throw error;
  return data ? { roomCode: data.room_code, bytes: Number(data.bytes) } : null;
}

async function release(key) {
  const { error } = await supabase.from('upload_reservations').delete().eq('upload_key', key);
  if (error) throw error;
}

async function clearAll() {
  const { error } = await supabase.from('upload_reservations').delete().not('upload_key', 'is', null);
  if (error) throw error;
}

/** Post-hoc safety net, used when a reservation was lost (e.g. server restart mid-upload). */
async function isOverCap() {
  const { totalBytes } = await r2Service.getBucketUsage();
  return totalBytes > env.storageCapBytes;
}

module.exports = { checkAndReserve, getReservation, release, clearAll, isOverCap, LIMIT_MESSAGE };
