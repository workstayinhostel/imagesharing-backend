const asyncHandler = require('../utils/asyncHandler');
const r2Service = require('../services/r2Service');

exports.androidApp = asyncHandler(async (req, res) => {
  const url = await r2Service.presignDownload(
    'Application/sharefy-android.apk',
    'sharefy-android.apk'
  );
  res.set('Cache-Control', 'no-store').redirect(302, url);
});
