const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const roomAuth = require('../middleware/roomAuth');
const c = require('../controllers/roomController');
const image = require('../controllers/imageController');

// Brute-force protection on PIN guessing and room creation
const credentialLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Wait a minute and try again.' } },
});
const previewLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many preview requests. Wait a minute and try again.' } },
});

router.post('/create', credentialLimiter, c.createRoom);
router.post('/join', credentialLimiter, c.joinRoom);
router.get('/:code/status', c.roomStatus);

router.get('/:code', roomAuth, c.getRoom);
router.delete('/:code', roomAuth, c.deleteRoom);
router.get('/:code/files/:fileId/download', roomAuth, c.getDownloadUrl);
router.get('/:code/files/:fileId/preview', roomAuth, previewLimiter, image.preview);
router.delete('/:code/files/:fileId', roomAuth, c.deleteFile);

module.exports = router;
