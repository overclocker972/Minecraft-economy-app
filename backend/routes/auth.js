const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { signToken, requireAuth } = require('../auth');

const router = express.Router();

// ---------------- Inscription ----------------
router.post('/register', (req, res) => {
  const { username, password, mc_pseudo } = req.body || {};
  const name = String(username || '').trim();
  const pass = String(password || '');

  if (name.length < 3 || name.length > 20) {
    return res.status(400).json({ error: "Le pseudo doit faire entre 3 et 20 caractères." });
  }
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    return res.status(400).json({ error: "Le pseudo ne peut contenir que lettres, chiffres et _" });
  }
  if (pass.length < 6) {
    return res.status(400).json({ error: "Le mot de passe doit faire au moins 6 caractères." });
  }

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(name);
  if (exists) {
    return res.status(409).json({ error: 'Ce pseudo est déjà pris.' });
  }

  const hash = bcrypt.hashSync(pass, 10);
  const info = db
    .prepare('INSERT INTO users (username, password_hash, mc_pseudo) VALUES (?, ?, ?)')
    .run(name, hash, String(mc_pseudo || name).trim());

  const user = db.prepare('SELECT id, username, mc_pseudo FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ token: signToken(user), user });
});

// ---------------- Connexion ----------------
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const name = String(username || '').trim();
  const pass = String(password || '');

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(name);
  if (!user || !bcrypt.compareSync(pass, user.password_hash)) {
    return res.status(401).json({ error: 'Pseudo ou mot de passe incorrect.' });
  }

  res.json({
    token: signToken(user),
    user: { id: user.id, username: user.username, mc_pseudo: user.mc_pseudo },
  });
});

// ---------------- Profil (utilisateur connecté) ----------------
router.get('/me', requireAuth, (req, res) => {
  const user = db
    .prepare('SELECT id, username, mc_pseudo, created_at FROM users WHERE id = ?')
    .get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  res.json({ user });
});

// Liste des joueurs (pour choisir un destinataire)
router.get('/players', requireAuth, (req, res) => {
  const players = db
    .prepare('SELECT id, username, mc_pseudo FROM users ORDER BY username ASC')
    .all();
  res.json({ players });
});

module.exports = router;
