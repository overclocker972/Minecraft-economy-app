// Tests bout-en-bout de l'API.
// Démarre le serveur dans un processus enfant (port aléatoire + DB temporaire),
// puis vérifie tous les parcours : auth, commandes, échanges, coordonnées, notifications.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Plage 3000-3499 : sans chevauchement avec ws.test.js (3500-3999) car node --test
// exécute les fichiers en parallèle.
const PORT = 3000 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mceco-test-'));

let server;

async function req(method, urlPath, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* vide */ }
  return { status: res.status, data };
}

before(async () => {
  server = spawn(process.execPath, ['backend/server.js'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: TMP, NODE_ENV: 'test' },
    stdio: 'inherit', // visible pour déboguer les échecs de démarrage
  });

  // Attend que /api/health réponde (max ~10 s).
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch { /* pas encore prêt */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Le serveur de test n'a pas démarré.");
});

after(() => {
  if (server) server.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---------------- Auth ----------------
test('inscription + connexion de deux joueurs', async () => {
  const r1 = await req('POST', '/api/auth/register', {
    body: { username: 'alice', password: 'pass123', mc_pseudo: 'Alice_MC' },
  });
  assert.equal(r1.status, 201);
  assert.ok(r1.data.token);

  const r2 = await req('POST', '/api/auth/register', {
    body: { username: 'bob', password: 'pass456' },
  });
  assert.equal(r2.status, 201);

  // Doublon refusé
  const dup = await req('POST', '/api/auth/register', {
    body: { username: 'alice', password: 'pass123' },
  });
  assert.equal(dup.status, 409);

  // Mauvais mot de passe refusé
  const bad = await req('POST', '/api/auth/login', {
    body: { username: 'alice', password: 'wrong' },
  });
  assert.equal(bad.status, 401);

  // Connexion OK
  const login = await req('POST', '/api/auth/login', {
    body: { username: 'alice', password: 'pass123' },
  });
  assert.equal(login.status, 200);
  assert.ok(login.data.token);
});

test('accès protégé sans token refusé', async () => {
  const r = await req('GET', '/api/orders/mine');
  assert.equal(r.status, 401);
});

// ---------------- Commandes ----------------
test('cycle complet d\'une commande objet : création → acceptation → terminée → historique', async () => {
  const a = await req('POST', '/api/auth/login', { body: { username: 'alice', password: 'pass123' } });
  const b = await req('POST', '/api/auth/login', { body: { username: 'bob', password: 'pass456' } });
  const alice = a.data.token, bob = b.data.token;
  const bobId = b.data.user.id;

  // Auto-commande refusée
  const self = await req('POST', '/api/orders', {
    token: alice,
    body: { provider_id: a.data.user.id, type: 'service', description: 'moi' },
  });
  assert.equal(self.status, 400);

  // Création commande objet
  const created = await req('POST', '/api/orders', {
    token: alice,
    body: { provider_id: bobId, type: 'objet', item_name: 'diamant', quantity: 5, description: 'pour ma pioche' },
  });
  assert.equal(created.status, 201);
  const orderId = created.data.order.id;
  assert.equal(created.data.order.status, 'en_attente');

  // Bob voit la commande dans "reçues" + a une notification
  const mine = await req('GET', '/api/orders/mine', { token: bob });
  assert.equal(mine.status, 200);
  assert.ok(mine.data.received.some((o) => o.id === orderId));

  const notifs = await req('GET', '/api/notifications', { token: bob });
  assert.ok(notifs.data.notifications.some((n) => n.message.includes('commande')));

  // Seul Bob peut accepter
  const forbidden = await req('POST', `/api/orders/${orderId}/accept`, { token: alice });
  assert.equal(forbidden.status, 403);

  // Bob refuse puis... on recrée une commande qu'il accepte
  const refused = await req('POST', `/api/orders/${orderId}/refuse`, { token: bob });
  assert.equal(refused.status, 200);

  const created2 = await req('POST', '/api/orders', {
    token: alice,
    body: { provider_id: bobId, type: 'service', description: 'construire une ferme à mobs' },
  });
  const orderId2 = created2.data.order.id;

  const accepted = await req('POST', `/api/orders/${orderId2}/accept`, { token: bob });
  assert.equal(accepted.status, 200);

  // Terminer sans accepter est refusé ; après acceptation, OK
  const completed = await req('POST', `/api/orders/${orderId2}/complete`, { token: bob });
  assert.equal(completed.status, 200);

  // Historique contient la commande terminée
  const hist = await req('GET', '/api/orders/history', { token: alice });
  assert.equal(hist.status, 200);
  assert.ok(hist.data.history.some((o) => o.id === orderId2));
});

// ---------------- Échanges ----------------
test('cycle complet d\'un échange objet ↔ service', async () => {
  const a = await req('POST', '/api/auth/login', { body: { username: 'alice', password: 'pass123' } });
  const b = await req('POST', '/api/auth/login', { body: { username: 'bob', password: 'pass456' } });
  const alice = a.data.token, bob = b.data.token;
  const bobId = b.data.user.id;

  // Offre invalide refusée
  const invalid = await req('POST', '/api/trades', {
    token: alice,
    body: {
      partner_id: bobId,
      initiator_offer: { type: 'objet', item_name: '', quantity: 1 },
      partner_offer: { type: 'service', description: 'x' },
    },
  });
  assert.equal(invalid.status, 400);

  // Échange valide : 10 fer ↔ 1 service
  const created = await req('POST', '/api/trades', {
    token: alice,
    body: {
      partner_id: bobId,
      initiator_offer: { type: 'objet', item_name: 'lingot de fer', quantity: 10 },
      partner_offer: { type: 'service', description: 'réparation complète d\'armure' },
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.trade.trade_type, 'objet_service');
  const tradeId = created.data.trade.id;

  // Bob accepte, puis l'un des deux marque terminé
  assert.equal((await req('POST', `/api/trades/${tradeId}/accept`, { token: bob })).status, 200);
  assert.equal((await req('POST', `/api/trades/${tradeId}/complete`, { token: alice })).status, 200);

  const hist = await req('GET', '/api/trades/history', { token: alice });
  assert.ok(hist.data.history.some((t) => t.id === tradeId));
});

test('échange service ↔ service refusé proprement par le partenaire', async () => {
  const a = await req('POST', '/api/auth/login', { body: { username: 'alice', password: 'pass123' } });
  const b = await req('POST', '/api/auth/login', { body: { username: 'bob', password: 'pass456' } });
  const alice = a.data.token, bob = b.data.token;

  const created = await req('POST', '/api/trades', {
    token: alice,
    body: {
      partner_id: b.data.user.id,
      initiator_offer: { type: 'service', description: 'je t\'enchanter 3 pioches' },
      partner_offer: { type: 'service', description: 'tu me farms 2 stacks de blaze rods' },
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.trade.trade_type, 'service_service');

  const tradeId = created.data.trade.id;
  const refused = await req('POST', `/api/trades/${tradeId}/refuse`, { token: bob });
  assert.equal(refused.status, 200);
});

// ---------------- Coordonnées ----------------
test('coordonnées publiques visibles par tous, privées visibles par le propriétaire seul', async () => {
  const a = await req('POST', '/api/auth/login', { body: { username: 'alice', password: 'pass123' } });
  const alice = a.data.token;

  const pub = await req('POST', '/api/coords/public', {
    token: alice,
    body: { title: 'Ferme à squelettes', description: 'spawner transformé', x: 120, y: 71, z: -340, dimension: 'overworld' },
  });
  assert.equal(pub.status, 201);

  // Lecture publique sans token
  const list = await req('GET', '/api/coords/public');
  assert.equal(list.status, 200);
  assert.ok(list.data.coords.some((c) => c.title === 'Ferme à squelettes'));

  // Y invalide refusé
  const badY = await req('POST', '/api/coords/public', {
    token: alice,
    body: { title: 'test', x: 1, y: 999, z: 2 },
  });
  assert.equal(badY.status, 400);

  const priv = await req('POST', '/api/coords/private', {
    token: alice,
    body: { title: 'Coffre secret', x: -50, z: 80, dimension: 'nether' },
  });
  assert.equal(priv.status, 201);

  // Suppression par un autre joueur refusée
  const b = await req('POST', '/api/auth/login', { body: { username: 'bob', password: 'pass456' } });
  const forbidden = await req('DELETE', `/api/coords/private/${priv.data.coord.id}`, { token: b.data.token });
  assert.equal(forbidden.status, 403);
});

// ---------------- Notifications ----------------
test('notifications : compteur non-lues puis remise à zéro', async () => {
  const b = await req('POST', '/api/auth/login', { body: { username: 'bob', password: 'pass456' } });
  const bob = b.data.token;

  const before1 = await req('GET', '/api/notifications', { token: bob });
  assert.ok(before1.data.unread >= 1);

  const cleared = await req('POST', '/api/notifications/read', { token: bob });
  assert.equal(cleared.status, 200);

  const after1 = await req('GET', '/api/notifications', { token: bob });
  assert.equal(after1.data.unread, 0);
});

// ---------------- Frontend ----------------
test('le frontend statique est servi', async () => {
  const home = await fetch(`${BASE}/`);
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.ok(html.includes('MC Économie'));

  const dash = await fetch(`${BASE}/dashboard.html`);
  assert.equal(dash.status, 200);
});
