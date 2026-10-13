const { S3Client } = require('@aws-sdk/client-s3');
const env = require('./env');

/**
 * Cloudflare R2 is S3-compatible. Region must be "auto".
 * The two checksum options stop newer AWS SDK versions from adding CRC32
 * checksum headers that break R2 presigned uploads.
 */
const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${env.r2.accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.r2.accessKeyId,
    secretAccessKey: env.r2.secretAccessKey,
  },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

module.exports = { r2, bucket: env.r2.bucket };
