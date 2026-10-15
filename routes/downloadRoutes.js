const router = require('express').Router();
const downloads = require('../controllers/downloadController');

router.get('/android', downloads.androidApp);

module.exports = router;
