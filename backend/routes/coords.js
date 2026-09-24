const express = require('express');
const { db, notify } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

const DIMENSIONS = ['overworld', 'nether', 'end'];

function validateCoord(body) {
  const title = String(body.title || '').trim();
  const description = String(body.description || '').trim();
  const x = Number(body.x);
  const y = body.y === undefined || body.y === '' ? 64 : Number(body.y);
  const z = Number(body.z);
  const dimension = DIMENSIONS.includes(body.dimension) ? body.dimension : 'overworld';

  if (!title) return { error: 'Le titre est obligatoire.' };
  if (title.length > 100) return { error: 'Titre trop long (max 100).' };
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return { error: 'X, Y et Z doivent être des nombres.' };
  }
  if (!Number.isInteger(y) || y < -64 || y > 320) {
    return { error: 'Y doit être un entier entre -64 et 320.' };
  }
  if (description.length > 500) return { error: 'Description trop longue (max 500).' };

  return { value: { title, description, x, y, z, dimension } };
}

// ---------------- Coordonnées PUBLIQUES ----------------

// Liste publique (accessible même sans compte, lecture seule)
router.get('/public', (req, res) => {
  const rows = db
    .prepare(
      `SELECT p.*, u.username AS author
       FROM public_coords p JOIN users u ON u.id = p.user_id
       ORDER BY p.created_at DESC`
    )
    .all();
  res.json({ coords: rows });
});

// Publier
router.post('/public', requireAuth, (req, res) => {
  const v = validateCoord(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  const info = db
    .prepare(`INSERT INTO public_coords (user_id, title, description, x, y, z, dimension)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(req.user.id, v.value.title, v.value.description, v.value.x, v.value.y, v.value.z, v.value.dimension);

  const coord = db.prepare('SELECT * FROM public_coords WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ coord });
});

// Supprimer (l'auteur uniquement)
router.delete('/public/:id', requireAuth, (req, res) => {
  const coord = db.prepare('SELECT * FROM public_coords WHERE id = ?').get(Number(req.params.id));
  if (!coord) return res.status(404).json({ error: 'Coordonnée introuvable.' });
  if (coord.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Tu ne peux supprimer que tes publications.' });
  }
  db.prepare('DELETE FROM public_coords WHERE id = ?').run(coord.id);
  res.json({ ok: true });
});

// ---------------- Coordonnées PRIVÉES ----------------

router.get('/private', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM private_coords WHERE user_id = ? ORDER BY created_at DESC')
    .all(req.user.id);
  res.json({ coords: rows });
});

router.post('/private', requireAuth, (req, res) => {
  const v = validateCoord(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  const info = db
    .prepare(`INSERT INTO private_coords (user_id, title, description, x, y, z, dimension)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(req.user.id, v.value.title, v.value.description, v.value.x, v.value.y, v.value.z, v.value.dimension);

  const coord = db.prepare('SELECT * FROM private_coords WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ coord });
});

router.delete('/private/:id', requireAuth, (req, res) => {
  const coord = db.prepare('SELECT * FROM private_coords WHERE id = ?').get(Number(req.params.id));
  if (!coord) return res.status(404).json({ error: 'Coordonnée introuvable.' });
  if (coord.user_id !== req.user.id) {
    return res.status(403).json({ error: "Tu ne peux supprimer que tes propres coordonnées." });
  }
  db.prepare('DELETE FROM private_coords WHERE id = ?').run(coord.id);
  res.json({ ok: true });
});

module.exports = router;
