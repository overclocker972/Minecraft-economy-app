const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

// Historique paginé (100 derniers messages par défaut)
router.get('/history', requireAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 300);
  const rows = db
    .prepare(
      `SELECT m.id, m.username, m.content, m.created_at, u.mc_pseudo
       FROM chat_messages m LEFT JOIN users u ON u.id = m.user_id
       ORDER BY m.id DESC LIMIT ?`
    )
    .all(limit)
    .reverse();
  res.json({ messages: rows });
});

module.exports = router;
