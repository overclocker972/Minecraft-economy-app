// Hub temps réel : chat écrit (WebSocket) + signalisation WebRTC pour le chat vocal.
//
// Le socket est attaché à l'instance http.Server (nécessaire pour le handshake WS).

const { db } = require('./db');
const { verify } = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const HISTORY_LIMIT = 80; // messages envoyés à l'ouverture

// clients : Map<ws, { userId, username }>
const clients = new Map();

// Salles vocales : code → { host: userId, members: Map<ws, {userId, username}> }
const voiceRooms = new Map();

function send(ws, event, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ event, payload }));
}

function broadcast(event, payload) {
  for (const ws of clients.keys()) {
    send(ws, event, payload);
  }
}

// ---------------- Historique chat ----------------

function recentMessages(limit = HISTORY_LIMIT) {
  return db
    .prepare(
      `SELECT m.id, m.username, m.content, m.created_at, u.mc_pseudo
       FROM chat_messages m LEFT JOIN users u ON u.id = m.user_id
       ORDER BY m.id DESC LIMIT ?`
    )
    .all(limit)
    .reverse();
}

// ---------------- Authentification WS ----------------

function authenticate(ws, req) {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  if (!token) {
    send(ws, 'auth_error', { error: "Token manquant : connecte-toi d'abord." });
    ws.close();
    return null;
  }
  try {
    const payload = verify(token, JWT_SECRET);
    const info = { userId: payload.id, username: payload.username };
    clients.set(ws, info);
    return info;
  } catch {
    send(ws, 'auth_error', { error: 'Session invalide ou expirée. Reconnecte-toi.' });
    ws.close();
    return null;
  }
}

// ---------------- Salles vocales ----------------

function roomMembers(roomCode) {
  const room = voiceRooms.get(roomCode);
  if (!room) return [];
  return [...room.members.keys()].map((ws) => {
    const info = clients.get(ws) || {};
    return { userId: info.userId, username: info.username, muted: !!ws.muted };
  });
}

function listRooms() {
  const rooms = [];
  for (const [code, room] of voiceRooms) {
    if (room.members.size > 0) rooms.push({ room: code, count: room.members.size });
  }
  return rooms;
}

function broadcastRooms() {
  broadcast('voice_rooms', { rooms: listRooms() });
}

function joinVoice(ws, payload) {
  const info = clients.get(ws);
  if (!info) return;
  const code = String((payload && payload.room) || 'general').slice(0, 32) || 'general';

  // Quitte proprement toute salle précédente.
  leaveVoice(ws, { quiet: true });

  if (!voiceRooms.has(code)) {
    voiceRooms.set(code, { host: info.userId, members: new Map() });
  }
  const room = voiceRooms.get(code);
  if (room.members.has(ws)) return; // déjà présent

  room.members.set(ws, { userId: info.userId, username: info.username });

  // Liste pour le nouvel arrivé + annonce aux présents.
  send(ws, 'voice_members', { room: code, members: roomMembers(code) });
  for (const other of room.members.keys()) {
    if (other !== ws) {
      send(other, 'voice_peer_joined', {
        room: code,
        peer: { userId: info.userId, username: info.username },
      });
    }
  }
  broadcastRooms();
}

function leaveVoice(ws, opts) {
  const quiet = opts && opts.quiet;
  const info = clients.get(ws);
  if (!info) return;

  for (const [code, room] of voiceRooms) {
    if (!room.members.has(ws)) continue;

    room.members.delete(ws);
    if (room.members.size === 0) {
      voiceRooms.delete(code);
    } else if (room.host === info.userId) {
      room.host = room.members.keys().next().value.userId;
    }

    for (const other of room.members.keys()) {
      send(other, 'voice_peer_left', {
        room: code,
        peer: { userId: info.userId, username: info.username },
      });
      send(other, 'voice_members', { room: code, members: roomMembers(code) });
    }
    if (!quiet) send(ws, 'voice_left', { room: code });
  }
  broadcastRooms();
}

// Relaye la signalisation WebRTC (offer/answer/candidate) entre deux peers.
function relaySignal(ws, payload) {
  const info = clients.get(ws);
  if (!info) return;
  const to = Number(payload && payload.to);
  const signal = payload && payload.signal;
  if (!to || !signal) return;

  for (const [other, otherInfo] of clients) {
    if (otherInfo.userId === to && other.readyState === 1) {
      send(other, 'voice_signal', { from: info.userId, fromName: info.username, signal });
      return;
    }
  }
}

// Diffuse l'état micro (couper/réactiver) aux autres membres des salles de ce socket.
function relayMute(ws, muted) {
  const info = clients.get(ws);
  if (!info) return;
  ws.muted = !!muted;
  for (const room of voiceRooms.values()) {
    if (!room.members.has(ws)) continue;
    for (const other of room.members.keys()) {
      if (other !== ws) {
        send(other, 'voice_mute', { peer: info.userId, muted: !!muted });
      }
    }
  }
}

// ---------------- Chat écrit ----------------

function chatMessage(ws, payload) {
  const info = clients.get(ws);
  if (!info) return;
  const text = String((payload && payload.content) || '').trim().slice(0, 500);
  if (!text) return;

  const res = db
    .prepare('INSERT INTO chat_messages (user_id, username, content) VALUES (?, ?, ?)')
    .run(info.userId, info.username, text);

  broadcast('chat_message', {
    id: Number(res.lastInsertRowid),
    username: info.username,
    content: text,
    created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
  });
}

// ---------------- Montage sur le serveur HTTP ----------------

function attach(server) {
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const info = authenticate(ws, req);
    if (!info) return;

    send(ws, 'chat_history', { messages: recentMessages() });
    broadcast('presence', { online: clients.size });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg.event !== 'string') return;

      switch (msg.event) {
        case 'chat_send':
          chatMessage(ws, msg.payload);
          break;
        case 'voice_join':
          joinVoice(ws, msg.payload);
          break;
        case 'voice_leave':
          leaveVoice(ws);
          break;
        case 'voice_signal':
          relaySignal(ws, msg.payload);
          break;
        case 'voice_mute':
          relayMute(ws, msg.payload && msg.payload.muted);
          break;
        default:
          break;
      }
    });

    ws.on('close', () => {
      leaveVoice(ws, { quiet: true });
      clients.delete(ws);
      broadcast('presence', { online: clients.size });
    });

    ws.on('error', () => { /* socket déjà géré par close */ });
  });

  return wss;
}

module.exports = { attach };
