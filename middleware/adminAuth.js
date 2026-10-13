const jwt = require('jsonwebtoken');
const env = require('../config/env');
const AppError = require('../utils/AppError');

/** Verifies the admin session JWT issued by POST /api/admin/login (which checks ADMIN_MASTER_KEY). */
module.exports = function adminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(new AppError(401, 'ADMIN_AUTH_REQUIRED', 'Admin authentication required.'));
  try {
    const payload = jwt.verify(token, env.jwtSecret);
    if (payload.role !== 'admin') throw new Error('not admin');
    req.admin = true;
    next();
  } catch {
    next(new AppError(401, 'ADMIN_AUTH_INVALID', 'Admin session expired. Please sign in again.'));
  }
};
