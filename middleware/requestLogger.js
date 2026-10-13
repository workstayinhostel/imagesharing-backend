const crypto = require('crypto');
const consoleLog = require('../utils/consoleLog');

function requestLogger(req, res, next) {
  const requestId = crypto.randomUUID();
  const startedAt = process.hrtime.bigint();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  const logRequest = (event) => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const duration = `${Math.round(durationMs)}ms`;
    const disconnected = event === 'disconnected';
    const level = disconnected || res.statusCode >= 400
      ? res.statusCode >= 500 ? 'error' : 'warn'
      : 'info';
    consoleLog(level, 'http', `${req.method} ${req.path} ${disconnected ? 'disconnected' : res.statusCode} ${duration}`);
  };

  res.on('finish', () => logRequest('completed'));
  res.on('close', () => {
    if (!res.writableFinished) logRequest('disconnected');
  });

  next();
}

module.exports = requestLogger;
