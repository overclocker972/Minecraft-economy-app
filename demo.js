// Démonstration bout-en-bout de MC Économie.
// Lance le serveur sur un port aléatoire avec une base temporaire,
// joue un scénario complet entre deux joueurs (Alice & Bob), affiche le déroulé, puis s'arrête.
//
// Usage : node demo.js

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3300 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mceco-demo-'));

let step = 1;
function log(msg) {
  console.log(`${String(step++).padStart(2, '0')}. ${msg}`);
}

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

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch { /* pas encore prêt */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("Le serveur de démo n'a pas démarré.");
}

(async () => {
  const server = spawn(process.execPath, ['backend/server.js'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: TMP, NODE_ENV: 'demo' },
    stdio: 'ignore',
  });

  try {
    await waitReady();
    log(`Serveur démarré sur ${BASE} (base SQLite temporaire)`);

    // ---------- Comptes ----------
    const regA = await req('POST', '/api/auth/register', {
      body: { username: 'alice', password: 'pass123', mc_pseudo: 'Alice_Builder' },
    });
    const regB = await req('POST', '/api/auth/register', {
      body: { username: 'bob', password: 'pass456', mc_pseudo: 'Bob_Farmer' },
    });
    log(`Comptes créés : alice (mc: ${regA.data.user.mc_pseudo}) et bob (mc: ${regB.data.user.mc_pseudo}) — mots de passe hashés bcrypt`);

    const alice = regA.data.token;
    const bob = regB.data.token;
    const bobId = regB.data.user.id;

    const bad = await req('POST', '/api/auth/login', { body: { username: 'alice', password: 'faux' } });
    log(`Connexion avec mauvais mot de passe → ${bad.status === 401 ? 'refusée ✅' : 'PROBLÈME'}`);

    // ---------- Commande ----------
    const order = await req('POST', '/api/orders', {
      token: alice,
      body: { provider_id: bobId, type: 'objet', item_name: 'diamant', quantity: 5, description: 'pour ma pioche' },
    });
    log(`Alice envoie une commande à Bob : 📦 diamant ×5 (#${order.data.order.id}, statut: ${order.data.order.status})`);

    const n1 = await req('GET', '/api/notifications', { token: bob });
    log(`Bob reçoit la notification : « ${n1.data.notifications[0].message} » (badge: ${n1.data.unread} non-lue(s))`);

    await req('POST', `/api/orders/${order.data.order.id}/accept`, { token: bob });
    log(`Bob accepte → la commande passe dans « Commandes à faire » d'Alice`);

    await req('POST', `/api/orders/${order.data.order.id}/complete`, { token: bob });
    log(`Bob marque la commande terminée → elle rejoint l'historique permanent`);

    const hist = await req('GET', '/api/orders/history', { token: alice });
    log(`Historique d'Alice : ${hist.data.history.length} commande(s) terminée(s)`);

    // ---------- Échange objet ↔ service ----------
    const trade = await req('POST', '/api/trades', {
      token: alice,
      body: {
        partner_id: bobId,
        initiator_offer: { type: 'objet', item_name: 'lingot de fer', quantity: 10 },
        partner_offer: { type: 'service', description: 'réparation complète de l\'armure' },
      },
    });
    log(`Alice propose un échange ${trade.data.trade.trade_type.replace('_', ' ↔ ')} : 10 fer ⇄ réparation d'armure`);

    const n2 = await req('GET', '/api/notifications', { token: bob });
    const lastN = n2.data.notifications[0].message;
    log(`Notification reçue par Bob : « ${lastN} »`);

    await req('POST', `/api/trades/${trade.data.trade.id}/accept`, { token: bob });
    await req('POST', `/api/trades/${trade.data.trade.id}/complete`, { token: bob });
    log(`Bob accepte puis marque l'échange terminé`);

    const thist = await req('GET', '/api/trades/history', { token: alice });
    log(`Historique des échanges d'Alice : ${thist.data.history.length} échange(s) terminé(s)`);

    // ---------- Coordonnées ----------
    await req('POST', '/api/coords/public', {
      token: bob,
      body: { title: 'Ferme à squelettes', description: 'spawner transformé, drop XP', x: 120, y: 71, z: -340 },
    });
    const pub = await req('GET', '/api/coords/public');
    log(`Bob publie « Ferme à squelettes » (X 120 · Y 71 · Z -340) — visible publiquement sans compte ✅`);

    await req('POST', '/api/coords/private', {
      token: alice,
      body: { title: 'Coffre secret', x: -50, z: 80, dimension: 'nether' },
    });
    const privB = await req('GET', '/api/coords/private', { token: bob });
    log(`Alice stocke « Coffre secret » (Nether) — visible par elle seule (la liste de Bob est vide: ${privB.data.coords.length === 0})`);

    // ---------- Notifications ----------
    await req('POST', '/api/notifications/read', { token: bob });
    const n3 = await req('GET', '/api/notifications', { token: bob });
    log(`Bob marque tout comme lu → badge: ${n3.data.unread}`);

    log('✅ Démonstration complète : tout fonctionne.');
  } catch (err) {
    console.error('❌ Échec de la démo :', err.message);
    process.exitCode = 1;
  } finally {
    server.kill();
    fs.rmSync(TMP, { recursive: true, force: true });
  }
})();
