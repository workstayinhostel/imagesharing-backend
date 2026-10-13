require('dotenv').config();

const required = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'JWT_SECRET',
  'ADMIN_MASTER_KEY',
];

const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`[config] Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

module.exports = {
  port: Number(process.env.PORT) || 4000,
  clientOrigins: (process.env.CLIENT_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean),
  jwtSecret: process.env.JWT_SECRET,
  adminMasterKey: process.env.ADMIN_MASTER_KEY,
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },
  r2: {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET_NAME,
  },
  // Hard cap: 9.5 GB (decimal), safely under Cloudflare's 10 GB free tier
  storageCapBytes: Number(process.env.STORAGE_CAP_BYTES) || 9_500_000_000,
  roomTtlMs: 48 * 60 * 60 * 1000,
  partSizeBytes: 32 * 1024 * 1024, // 32 MiB multipart parts
  maxFilesPerInit: 25,
};
