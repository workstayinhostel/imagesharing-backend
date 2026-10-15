const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const env = require('./config/env');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const requestLogger = require('./middleware/requestLogger');
const { cleanupExpiredRooms } = require('./services/roomService');
const r2Service = require('./services/r2Service');

const app = express();
const ROOM_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const STALE_UPLOAD_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
app.set('trust proxy', 1); // Render/Vercel sit behind a proxy: needed for real client IPs

app.use(requestLogger);
app.use(helmet());
app.use(
  cors({
    origin(origin, cb) {
      // Native mobile apps and server-to-server requests may not send an Origin.
      if (!origin || env.clientOrigins.includes(origin)) return cb(null, true);
      return cb(new Error('Origin not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use(express.json({ limit: '2mb' })); // JSON only: file bytes never pass through this server
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.get('/health', (req, res) => res.json({ ok: true, service: 'sharefy-api' }));
app.get('/', (req, res) => res.status(200).json({ message: 'Sharefy is awake and running.' }));

app.use('/api/rooms', require('./routes/roomRoutes'));
app.use('/api/upload', require('./routes/uploadRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/downloads', require('./routes/downloadRoutes'));

app.use(notFound);
app.use(errorHandler);

let roomCleanupRunning = false;
async function runRoomCleanup() {
  if (roomCleanupRunning) return;
  roomCleanupRunning = true;
  try {
    const { deletedRooms, failedRooms } = await cleanupExpiredRooms();
    if (deletedRooms || failedRooms) {
      console.log(`[sharefy] Expired room cleanup: ${deletedRooms} deleted, ${failedRooms} failed.`);
    }
  } catch (error) {
    console.error('[sharefy] Expired room cleanup failed:', error);
  } finally {
    roomCleanupRunning = false;
  }
}

async function runStaleUploadCleanup() {
  try {
    const abortedUploads = await r2Service.abortStaleMultipartUploads();
    if (abortedUploads) {
      console.log(`[sharefy] Aborted ${abortedUploads} stale multipart upload(s).`);
    }
  } catch (error) {
    console.error('[sharefy] Stale multipart upload cleanup failed:', error);
  }
}

runRoomCleanup();
setInterval(runRoomCleanup, ROOM_CLEANUP_INTERVAL_MS);
runStaleUploadCleanup();
setInterval(runStaleUploadCleanup, STALE_UPLOAD_CLEANUP_INTERVAL_MS);

app.listen(env.port, '0.0.0.0', () => {
  console.log(`[sharefy] API listening on :${env.port}`);
});
