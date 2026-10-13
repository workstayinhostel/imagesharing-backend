const AppError = require('../utils/AppError');
const consoleLog = require('../utils/consoleLog');

function notFound(req, res, next) {
  next(new AppError(404, 'NOT_FOUND', `Route ${req.method} ${req.originalUrl} not found`));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  if (status >= 500) {
    consoleLog('error', 'api', `${req.method} ${req.path} ${err.code || 'INTERNAL_ERROR'}: ${err.message}`);
  }
  res.status(status).json({
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: status >= 500 && !err.code ? 'Something went wrong on our side. Please try again.' : err.message,
    },
  });
}

module.exports = { notFound, errorHandler };
