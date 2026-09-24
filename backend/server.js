// Serveur principal — API + frontend statique.
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

require('dotenv').config();

const { db } = require('./db');
const authRoutes = require('./routes/auth');
const orderRoutes = require('./routes/orders');
const tradeRoutes = require('./routes/trades');
const coordRoutes = require('./routes/coords');
const notifRoutes = require('./routes/notifications');
const chatRoutes = require('./routes/chat');

const app = express();
// PORT invalide (0, vide, non numérique) → fallback sur 3000.
const PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// Sécurité de base (headers HTTP)
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        // 'unsafe-inline' : les boutons du dashboard utilisent des gestionnaires onclick inline.
        "script-src": ["'self'", "'unsafe-inline'"],
        "style-src": ["'self'"],
        "img-src": ["'self'", "data:"],
        "connect-src": ["'self'", "ws:", "wss:"],
        "media-src": ["'self'", "blob:"],
      },
    },
  })
);

// CORS : autorise le frontend s'il est hébergé ailleurs (Vercel/Netlify).
const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return cb(null, true);
      }
      cb(new Error('Origine non autorisée par CORS'));
    },
  })
);

app.use(express.json({ limit: '100kb' }));

// Anti brute-force sur /api/auth
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives. Réessaie dans quelques minutes.' },
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// ---------------- API ----------------
app.use('/api/auth', authRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/trades', tradeRoutes);
app.use('/api/coords', coordRoutes);
app.use('/api/notifications', notifRoutes);
app.use('/api/chat', chatRoutes);

app.get('/api/health', (req, res) => {
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  res.json({ ok: true, users, uptime: process.uptime() });
});

// ---------------- Temps réel (chat + vocal) ----------------
const server = http.createServer(app);
const realtime = require('./realtime');
realtime.attach(server);

// ---------------- Frontend statique ----------------
const PUBLIC_DIR = path.join(__dirname, '..', 'frontend');
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });
}

// ---------------- Gestion d'erreurs ----------------
app.use((req, res) => res.status(404).json({ error: 'Route inconnue.' }));
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({ error: status === 500 ? 'Erreur serveur.' : err.message });
});

server.listen(PORT, () => {
  console.log(`✔ Serveur démarré sur http://localhost:${PORT}`);
});
