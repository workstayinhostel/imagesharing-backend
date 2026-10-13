const jwt = require('jsonwebtoken');
const env = require('../config/env');
const supabase = require('../config/supabase');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { expiresAtFor } = require('../services/roomService');

/**
 * Verifies the room session token, confirms the room still exists and hasn't expired,
 * and attaches req.room = { roomCode, role, createdAt, expiresAt }.
 * If the route has a :code param it must match the token's room.
 */
module.exports = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new AppError(401, 'AUTH_REQUIRED', 'Enter the room PIN to continue.');

  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch {
    throw new AppError(401, 'AUTH_INVALID', 'Your session expired. Enter the room PIN again.');
  }
  if (payload.role !== 'host' && payload.role !== 'guest') {
    throw new AppError(401, 'AUTH_INVALID', 'Invalid session.');
  }
  if (req.params.code && req.params.code.toUpperCase() !== payload.roomCode) {
    throw new AppError(403, 'ROOM_MISMATCH', 'This session belongs to a different room.');
  }

  const { data: room, error } = await supabase
    .from('rooms')
    .select('room_code, created_at')
    .eq('room_code', payload.roomCode)
    .maybeSingle();
  if (error) throw error;
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', 'This room no longer exists.');

  const expiresAt = expiresAtFor(room.created_at);
  if (expiresAt.getTime() <= Date.now()) {
    throw new AppError(410, 'ROOM_EXPIRED', 'This room expired after 48 hours and is being removed.');
  }

  req.room = {
    roomCode: room.room_code,
    role: payload.role,
    createdAt: room.created_at,
    expiresAt: expiresAt.toISOString(),
  };
  next();
});
