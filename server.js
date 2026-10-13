const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const env = require('./config/env');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const requestLogger = require('./middleware/requestLogger');

const app = express();
app.set('trust proxy', 1); // Render/Vercel sit behind a proxy: needed for real client IPs

app.use(requestLogger);
app.use(helmet());
app.use(
  cors({
    origin(origin, cb) {
      // allow same-origin/no-origin (curl, health checks) and the configured frontends
      if (!origin || env.clientOrigins.includes(origin)) return cb(null, true);
      return cb(new Error('Origin not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
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

app.get('/health', (req, res) => res.json({ ok: true, service: 'sharify-api' }));

app.use('/api/rooms', require('./routes/roomRoutes'));
app.use('/api/upload', require('./routes/uploadRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));

app.use(notFound);
app.use(errorHandler);

app.listen(env.port, '0.0.0.0', () => {
  console.log(`[sharify] API listening on :${env.port}`);
});
