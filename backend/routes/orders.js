const express = require('express');
const { db, notify } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

// ---------------- Créer une commande ----------------
router.post('/', (req, res) => {
  const { provider_id, type, item_name, quantity, description } = req.body || {};
  const clientId = req.user.id;
  const providerId = Number(provider_id);

  if (!Number.isInteger(providerId)) {
    return res.status(400).json({ error: 'Destinataire invalide.' });
  }
  if (providerId === clientId) {
    return res.status(400).json({ error: "Tu ne peux pas te commander à toi-même." });
  }
  const provider = db.prepare('SELECT id FROM users WHERE id = ?').get(providerId);
  if (!provider) {
    return res.status(404).json({ error: 'Ce joueur n\'existe pas.' });
  }
  if (!['service', 'objet'].includes(type)) {
    return res.status(400).json({ error: 'Type invalide : "service" ou "objet".' });
  }
  const desc = String(description || '').trim();
  if (!desc) {
    return res.status(400).json({ error: 'La description est obligatoire.' });
  }
  if (type === 'objet') {
    const name = String(item_name || '').trim();
    const qty = Number(quantity);
    if (!name) return res.status(400).json({ error: "Le nom de l'objet est obligatoire." });
    if (!Number.isInteger(qty) || qty < 1 || qty > 100000) {
      return res.status(400).json({ error: 'Quantité invalide (1 à 100000).' });
    }
  }

  const descFinal = type === 'objet' && String(item_name || '').trim()
    ? `${String(item_name).trim()} ×${Number(quantity)} — ${desc}`
    : desc;

  const info = db
    .prepare(`INSERT INTO orders (client_id, provider_id, type, item_name, quantity, description)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(
      clientId,
      providerId,
      type,
      type === 'objet' ? String(item_name).trim() : '',
      type === 'objet' ? Number(quantity) : 0,
      descFinal
    );

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(info.lastInsertRowid);
  notify(providerId, `${req.user.username} t'a envoyé une commande (#${order.id}).`, '/dashboard?tab=orders');

  res.status(201).json({ order });
});

// ---------------- Mes commandes (reçues + envoyées) ----------------
router.get('/mine', (req, res) => {
  const uid = req.user.id;

  const rows = db
    .prepare(
      `SELECT o.*, cu.username AS client_name, pu.username AS provider_name
       FROM orders o
       JOIN users cu ON cu.id = o.client_id
       JOIN users pu ON pu.id = o.provider_id
       WHERE o.client_id = ? OR o.provider_id = ?
       ORDER BY
         CASE o.status WHEN 'en_attente' THEN 0 WHEN 'acceptee' THEN 1 ELSE 2 END,
         o.created_at DESC`
    )
    .all(uid, uid);

  const received = rows.filter((o) => o.provider_id === uid);
  const sent = rows.filter((o) => o.client_id === uid);

  res.json({ received, sent });
});

// ---------------- Accepter / Refuser ----------------
function decide(req, res, newStatus) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Commande introuvable.' });
  if (order.provider_id !== req.user.id) {
    return res.status(403).json({ error: "Seul le destinataire peut répondre à cette commande." });
  }
  if (order.status !== 'en_attente') {
    return res.status(400).json({ error: `Cette commande est déjà ${order.status.replace('_', ' ')}.` });
  }

  db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(newStatus, order.id);
  notify(order.client_id, `${req.user.username} a ${newStatus === 'acceptee' ? 'accepté' : 'refusé'} ta commande #${order.id}.`, '/dashboard?tab=orders');
  res.json({ ok: true, status: newStatus });
}

router.post('/:id/accept', (req, res) => decide(req, res, 'acceptee'));
router.post('/:id/refuse', (req, res) => decide(req, res, 'refusee'));

// ---------------- Marquer comme terminée ----------------
router.post('/:id/complete', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Commande introuvable.' });
  if (order.provider_id !== req.user.id) {
    return res.status(403).json({ error: "Seul le prestataire peut terminer la commande." });
  }
  if (order.status !== 'acceptee') {
    return res.status(400).json({ error: 'La commande doit être acceptée avant d\'être terminée.' });
  }

  db.prepare("UPDATE orders SET status = 'terminee', updated_at = datetime('now') WHERE id = ?").run(order.id);
  notify(order.client_id, `${req.user.username} a terminé ta commande #${order.id} !`, '/dashboard?tab=orders');
  res.json({ ok: true, status: 'terminee' });
});

// ---------------- Annuler (client, si en attente) ----------------
router.post('/:id/cancel', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Commande introuvable.' });
  if (order.client_id !== req.user.id) {
    return res.status(403).json({ error: "Seul le client peut annuler sa commande." });
  }
  if (order.status !== 'en_attente') {
    return res.status(400).json({ error: "On ne peut annuler qu'une commande en attente." });
  }

  db.prepare("UPDATE orders SET status = 'annulee', updated_at = datetime('now') WHERE id = ?").run(order.id);
  notify(order.provider_id, `${req.user.username} a annulé sa commande #${order.id}.`, '/dashboard?tab=orders');
  res.json({ ok: true, status: 'annulee' });
});

// ---------------- Historique des commandes terminées ----------------
router.get('/history', (req, res) => {
  const uid = req.user.id;
  const rows = db
    .prepare(
      `SELECT o.*, cu.username AS client_name, pu.username AS provider_name
       FROM orders o
       JOIN users cu ON cu.id = o.client_id
       JOIN users pu ON pu.id = o.provider_id
       WHERE (o.client_id = ? OR o.provider_id = ?) AND o.status = 'terminee'
       ORDER BY o.updated_at DESC`
    )
    .all(uid, uid);
  res.json({ history: rows });
});

module.exports = router;
