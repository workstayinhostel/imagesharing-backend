const router = require('express').Router();
const roomAuth = require('../middleware/roomAuth');
const c = require('../controllers/uploadController');

router.post('/init', roomAuth, c.initUpload);
router.post('/complete', roomAuth, c.completeUpload);
router.post('/abort', roomAuth, c.abortUpload);

module.exports = router;
