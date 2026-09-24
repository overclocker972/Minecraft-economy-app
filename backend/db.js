// Base de données SQLite — création du schéma au premier démarrage.
// La DB est un simple fichier : parfait pour un hébergement gratuit (Render/Railway).
// SQLite est intégré à Node (node:sqlite) : aucun module natif à compiler, déploiement fiable.
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'app.db');
const db = new DatabaseSync(DB_PATH);

// WAL : meilleures performances et fiabilité.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// ---------------------------------------------------------------
// Schéma
// ---------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  mc_pseudo     TEXT    DEFAULT '',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type           TEXT    NOT NULL CHECK (type IN ('service', 'objet')),
  item_name      TEXT    DEFAULT '',
  quantity       INTEGER DEFAULT 0,
  description    TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'en_attente'
                 CHECK (status IN ('en_attente', 'acceptee', 'refusee', 'terminee', 'annulee')),
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trades (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  initiator_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  partner_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trade_type         TEXT    NOT NULL CHECK (trade_type IN ('objet_objet', 'objet_service', 'service_service')),
  initiator_offer    TEXT    NOT NULL,  -- JSON: {type:'objet', item_name, quantity} ou {type:'service', description}
  partner_offer      TEXT    NOT NULL,  -- JSON: même format
  status             TEXT    NOT NULL DEFAULT 'en_attente'
                     CHECK (status IN ('en_attente', 'accepte', 'refuse', 'termine', 'annule')),
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS public_coords (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT    NOT NULL,
  description TEXT    DEFAULT '',
  x           REAL    NOT NULL,
  y           REAL    NOT NULL DEFAULT 64,
  z           REAL    NOT NULL,
  dimension   TEXT    NOT NULL DEFAULT 'overworld'
              CHECK (dimension IN ('overworld', 'nether', 'end')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS private_coords (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT    NOT NULL,
  description TEXT    DEFAULT '',
  x           REAL    NOT NULL,
  y           REAL    NOT NULL DEFAULT 64,
  z           REAL    NOT NULL,
  dimension   TEXT    NOT NULL DEFAULT 'overworld'
              CHECK (dimension IN ('overworld', 'nether', 'end')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username   TEXT    NOT NULL DEFAULT 'Système',
  content    TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message    TEXT    NOT NULL,
  link       TEXT    DEFAULT '',
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_provider  ON orders(provider_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_client    ON orders(client_id, status);
CREATE INDEX IF NOT EXISTS idx_trades_partner   ON trades(partner_id, status);
CREATE INDEX IF NOT EXISTS idx_trades_initiator ON trades(initiator_id, status);
CREATE INDEX IF NOT EXISTS idx_notif_user       ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_pub_coords       ON public_coords(user_id);
CREATE INDEX IF NOT EXISTS idx_priv_coords      ON private_coords(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages    ON chat_messages(created_at);
`);

// Petit utilitaire de notification réutilisable partout.
function notify(userId, message, link = '') {
  db.prepare('INSERT INTO notifications (user_id, message, link) VALUES (?, ?, ?)')
    .run(userId, message, link);
}

module.exports = { db, notify, DB_PATH };
