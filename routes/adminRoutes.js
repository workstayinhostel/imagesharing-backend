const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const adminAuth = require('../middleware/adminAuth');
const c = require('../controllers/adminController');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts. Try again later.' } },
});

router.post('/login', loginLimiter, c.login);

router.use(adminAuth);
router.get('/stats', c.getStats);
router.get('/rooms', c.listRooms);
router.get('/logs', c.getLogs);
router.delete('/rooms/:code', c.deleteRoom);
router.post('/purge-all', c.purgeAll);

module.exports = router;
