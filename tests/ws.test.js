// Tests bout-en-bout du hub temps réel (chat écrit + vocal via signalisation).
// Démarre le serveur (port aléatoire + DB temporaire), connecte deux clients WS.
//
// Plage de ports 3500-3899 : sans chevauchement avec api.test.js (3000-3499),
// car node --test exécute les fichiers en parallèle.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const PORT = 3500 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mceco-ws-'));

let server;

async function req(method, urlPath, body, token) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

// Client WS qui enregistre TOUS les événements reçus.
// waitFor(event, predicate) balaie l'historique complet : pas de course possible.
function wsClient(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`);
    const events = [];
    ws.on('message', (raw) => events.push(JSON.parse(raw.toString())));
    ws.on('open', () => resolve({
      ws,
      events,
      async waitFor(event, predicate, timeoutMs = 3000) {
        const start = Date.now();
        for (;;) {
          const found = events.find((e) => e.event === event && (!predicate || predicate(e.payload)));
          if (found) return found;
          if (Date.now() - start > timeoutMs) {
            throw new Error(
              `timeout en attendant "${event}" — événements reçus : ${[...new Set(events.map((e) => e.event))].join(', ')}`
            );
          }
          await new Promise((r) => setTimeout(r, 25));
        }
      },
    }));
    ws.on('error', reject);
  });
}

const send = (ws, event, payload) => ws.send(JSON.stringify({ event, payload }));

before(async () => {
  server = spawn(process.execPath, ['backend/server.js'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: TMP, NODE_ENV: 'test' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch { /* pas prêt */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Le serveur WS de test n'a pas démarré.");
});

after(() => {
  if (server) server.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('chat écrit : historique à la connexion, diffusion temps réel, persistance REST', async () => {
  const regA = await req('POST', '/api/auth/register', { username: 'carol', password: 'pass123' });
  const regB = await req('POST', '/api/auth/register', { username: 'dave', password: 'pass456' });
  assert.equal(regA.status, 201);
  assert.equal(regB.status, 201);

  const a = await wsClient(regA.data.token);
  const b = await wsClient(regB.data.token);

  // Historique (vide) reçu à l'ouverture
  const hist = await a.waitFor('chat_history');
  assert.ok(Array.isArray(hist.payload.messages));

  // Présence : les DEUX clients connectés (prédicat → pas de course)
  await a.waitFor('presence', (p) => p.online === 2);

  // Carol envoie → Dave reçoit
  send(a.ws, 'chat_send', { content: 'Salut Dave, on farming ce soir ?' });
  const msg = await b.waitFor('chat_message', (p) => p.content.includes('farming'));
  assert.equal(msg.payload.username, 'carol');

  // Persisté : visible via l'API REST
  const rest = await req('GET', '/api/chat/history', undefined, regB.data.token);
  assert.equal(rest.status, 200);
  assert.ok(rest.data.messages.some((m) => m.content.includes('farming')));

  // Message vide refusé (pas de diffusion)
  const countBefore = b.events.filter((e) => e.event === 'chat_message').length;
  send(a.ws, 'chat_send', { content: '   ' });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(b.events.filter((e) => e.event === 'chat_message').length, countBefore);

  a.ws.close();
  b.ws.close();
});

test('vocal : join de salle, signalisation relayée entre peers, départ annoncé', async () => {
  const loginA = await req('POST', '/api/auth/login', { username: 'carol', password: 'pass123' });
  const loginB = await req('POST', '/api/auth/login', { username: 'dave', password: 'pass456' });
  const bobId = loginB.data.user.id;

  const a = await wsClient(loginA.data.token);
  const b = await wsClient(loginB.data.token);
  await a.waitFor('chat_history');
  await b.waitFor('chat_history');

  // Carol rejoint la salle "general" (première → hôte)
  send(a.ws, 'voice_join', { room: 'general' });
  await a.waitFor('voice_members', (p) => p.room === 'general' && p.members.length === 1);

  // Dave rejoint → les deux voient la salle à 2
  send(b.ws, 'voice_join', { room: 'general' });
  const announce = await a.waitFor('voice_peer_joined', (p) => p.peer.username === 'dave');
  assert.equal(announce.payload.room, 'general');
  await b.waitFor('voice_members', (p) => p.members.length === 2);

  // Carol envoie une offre WebRTC → Dave la reçoit avec l'expéditeur
  send(a.ws, 'voice_signal', { to: bobId, signal: { type: 'offer', sdp: 'v=0...' } });
  const sig = await b.waitFor('voice_signal', (p) => p.from === loginA.data.user.id);
  assert.equal(sig.payload.signal.type, 'offer');

  // État micro relayé
  send(a.ws, 'voice_mute', { muted: true });
  const mute = await b.waitFor('voice_mute', (p) => p.peer === loginA.data.user.id);
  assert.equal(mute.payload.muted, true);

  // Dave part → Carol est prévenue, la liste tombe à 1
  send(b.ws, 'voice_leave', {});
  const left = await a.waitFor('voice_peer_left', (p) => p.peer.username === 'dave');
  assert.equal(left.payload.room, 'general');
  await a.waitFor('voice_members', (p) => p.room === 'general' && p.members.length === 1);

  // Déconnexion brutale de Carol → salle vide supprimée (pas d'erreur serveur)
  a.ws.close();
  await new Promise((r) => setTimeout(r, 200));

  // Le serveur est toujours vivant
  const health = await req('GET', '/api/health');
  assert.equal(health.status, 200);
  b.ws.close();
});

test('connexion WS sans token rejetée', async () => {
  await assert.rejects(
    () => new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      ws.on('open', () => { ws.close(); reject(new Error('aurait dû être rejeté')); });
      ws.on('error', () => resolve()); // rejet attendu
      setTimeout(() => reject(new Error('timeout')), 2000);
    }),
    /timeout|aurait dû|ECONNRESET|closed/
  );
});
