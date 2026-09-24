const express = require('express');
const { db, notify } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

// Validation des deux offres d'un échange.
function parseOffer(raw, side) {
  const offer = raw || {};
  if (!['objet', 'service'].includes(offer.type)) {
    return { error: `Côté ${side} : le type doit être "objet" ou "service".` };
  }
  if (offer.type === 'objet') {
    const name = String(offer.item_name || '').trim();
    const qty = Number(offer.quantity);
    if (!name) return { error: `Côté ${side} : le nom de l'objet est obligatoire.` };
    if (!Number.isInteger(qty) || qty < 1 || qty > 100000) {
      return { error: `Côté ${side} : quantité invalide (1 à 100000).` };
    }
    return { value: { type: 'objet', item_name: name, quantity: qty } };
  }
  const desc = String(offer.description || '').trim();
  if (!desc) return { error: `Côté ${side} : la description du service est obligatoire.` };
  if (desc.length > 1000) return { error: `Côté ${side} : description trop longue (max 1000).` };
  return { value: { type: 'service', description: desc } };
}

// ---------------- Créer un échange ----------------
router.post('/', (req, res) => {
  const { partner_id, initiator_offer, partner_offer } = req.body || {};
  const me = req.user.id;
  const partnerId = Number(partner_id);

  if (!Number.isInteger(partnerId)) return res.status(400).json({ error: 'Partenaire invalide.' });
  if (partnerId === me) return res.status(400).json({ error: "Tu ne peux pas échanger avec toi-même." });
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(partnerId)) {
    return res.status(404).json({ error: "Ce joueur n'existe pas." });
  }

  const a = parseOffer(initiator_offer, 'ton offre');
  if (a.error) return res.status(400).json({ error: a.error });
  const b = parseOffer(partner_offer, 'sa demande');
  if (b.error) return res.status(400).json({ error: b.error });

  const tradeType =
    a.value.type === 'objet' && b.value.type === 'objet' ? 'objet_objet'
    : a.value.type === 'objet' || b.value.type === 'objet' ? 'objet_service'
    : 'service_service';

  const info = db
    .prepare(`INSERT INTO trades (initiator_id, partner_id, trade_type, initiator_offer, partner_offer)
              VALUES (?, ?, ?, ?, ?)`)
    .run(me, partnerId, tradeType, JSON.stringify(a.value), JSON.stringify(b.value));

  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(info.lastInsertRowid);
  notify(partnerId, `${req.user.username} te propose un échange (#${trade.id}).`, '/dashboard?tab=trades');

  res.status(201).json({ trade: serialize(trade) });
});

// ---------------- Mes échanges ----------------
router.get('/mine', (req, res) => {
  const uid = req.user.id;
  const rows = db
    .prepare(
      `SELECT t.*, iu.username AS initiator_name, pu.username AS partner_name
       FROM trades t
       JOIN users iu ON iu.id = t.initiator_id
       JOIN users pu ON pu.id = t.partner_id
       WHERE t.initiator_id = ? OR t.partner_id = ?
       ORDER BY
         CASE t.status WHEN 'en_attente' THEN 0 WHEN 'accepte' THEN 1 ELSE 2 END,
         t.created_at DESC`
    )
    .all(uid, uid);

  res.json({
    received: rows.filter((t) => t.partner_id === uid).map(serialize),
    sent: rows.filter((t) => t.initiator_id === uid).map(serialize),
  });
});

// ---------------- Historique des échanges terminés ----------------
router.get('/history', (req, res) => {
  const uid = req.user.id;
  const rows = db
    .prepare(
      `SELECT t.*, iu.username AS initiator_name, pu.username AS partner_name
       FROM trades t
       JOIN users iu ON iu.id = t.initiator_id
       JOIN users pu ON pu.id = t.partner_id
       WHERE (t.initiator_id = ? OR t.partner_id = ?) AND t.status = 'termine'
       ORDER BY t.updated_at DESC`
    )
    .all(uid, uid);
  res.json({ history: rows.map(serialize) });
});

// ---------------- Accepter / Refuser (partenaire) ----------------
function decide(req, res, newStatus) {
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(Number(req.params.id));
  if (!trade) return res.status(404).json({ error: 'Échange introuvable.' });
  if (trade.partner_id !== req.user.id) {
    return res.status(403).json({ error: "Seul le destinataire peut répondre à cet échange." });
  }
  if (trade.status !== 'en_attente') {
    return res.status(400).json({ error: `Cet échange est déjà ${trade.status.replace('_', ' ')}.` });
  }

  db.prepare("UPDATE trades SET status = ?, updated_at = datetime('now') WHERE id = ?").run(newStatus, trade.id);
  notify(
    trade.initiator_id,
    `${req.user.username} a ${newStatus === 'accepte' ? 'accepté' : 'refusé'} ton échange #${trade.id}.`,
    '/dashboard?tab=trades'
  );
  res.json({ ok: true, status: newStatus });
}

router.post('/:id/accept', (req, res) => decide(req, res, 'accepte'));
router.post('/:id/refuse', (req, res) => decide(req, res, 'refuse'));

// ---------------- Marquer comme terminé (n'importe quel participant) ----------------
router.post('/:id/complete', (req, res) => {
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(Number(req.params.id));
  if (!trade) return res.status(404).json({ error: 'Échange introuvable.' });
  if (trade.initiator_id !== req.user.id && trade.partner_id !== req.user.id) {
    return res.status(403).json({ error: 'Tu ne participes pas à cet échange.' });
  }
  if (trade.status !== 'accepte') {
    return res.status(400).json({ error: "L'échange doit être accepté avant d'être terminé." });
  }

  db.prepare("UPDATE trades SET status = 'termine', updated_at = datetime('now') WHERE id = ?").run(trade.id);
  const other = trade.initiator_id === req.user.id ? trade.partner_id : trade.initiator_id;
  notify(other, `${req.user.username} a terminé l'échange #${trade.id} !`, '/dashboard?tab=trades');
  res.json({ ok: true, status: 'termine' });
});

// ---------------- Annuler (initiateur, si en attente) ----------------
router.post('/:id/cancel', (req, res) => {
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(Number(req.params.id));
  if (!trade) return res.status(404).json({ error: 'Échange introuvable.' });
  if (trade.initiator_id !== req.user.id) {
    return res.status(403).json({ error: "Seul l'initiateur peut annuler." });
  }
  if (trade.status !== 'en_attente') {
    return res.status(400).json({ error: "On ne peut annuler qu'un échange en attente." });
  }

  db.prepare("UPDATE trades SET status = 'annule', updated_at = datetime('now') WHERE id = ?").run(trade.id);
  notify(trade.partner_id, `${req.user.username} a annulé son échange #${trade.id}.`, '/dashboard?tab=trades');
  res.json({ ok: true, status: 'annule' });
});

// Ajoute les offres parsées pour le frontend.
function serialize(t) {
  return {
    ...t,
    initiator_offer: JSON.parse(t.initiator_offer),
    partner_offer: JSON.parse(t.partner_offer),
  };
}

module.exports = router;
