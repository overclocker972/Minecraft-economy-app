// Chat écrit (WebSocket) + chat vocal (WebRTC mesh) du dashboard.
//
// - Écrit : messages diffusés en temps réel, historique à la connexion, reconnexion auto.
// - Vocal : le son circule en DIRECT entre navigateurs (WebRTC) ; le serveur ne fait
//   que la "signalisation". Un salon = tous entendent tous (mesh, ~8 joueurs max).

// ============================================================
// ÉTAT
// ============================================================
let ws = null;

// Vocal
let currentRoom = null;
let localStream = null;
let muted = false;
const pcs = new Map();          // peerUserId → RTCPeerConnection
const remoteAudios = new Map(); // peerUserId → HTMLAudioElement
const peerNames = new Map();    // peerUserId → username

const $ = (id) => document.getElementById(id);

function wsSend(event, payload) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ event, payload }));
}

// ============================================================
// CONNEXION WEBSOCKET
// ============================================================
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(getToken())}`);

  ws.onopen = () => {
    $('ws-status').textContent = '🟢 connecté';
    $('ws-status').className = 'conn-dot on';
    $('chat-input').disabled = false;
  };

  ws.onclose = () => {
    $('ws-status').textContent = '🔴 déconnecté';
    $('ws-status').className = 'conn-dot off';
    $('chat-input').disabled = true;
    cleanupVoice(); // sécurité : plus de signalisation → on quitte le vocal
    setTimeout(connectWS, 3000); // reconnexion automatique
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleEvent(msg.event, msg.payload);
  };
}

// ============================================================
// ROUTAGE DES ÉVÉNEMENTS SERVEUR
// ============================================================
function handleEvent(event, p) {
  switch (event) {
    case 'chat_history':
      $('chat-messages').innerHTML = '';
      p.messages.forEach(appendChatMessage);
      scrollChat();
      break;
    case 'chat_message':
      appendChatMessage(p);
      scrollChat();
      break;
    case 'presence':
      $('online-count').textContent = p.online;
      break;
    case 'auth_error':
      flash($('chat-msg'), p.error);
      break;
    case 'voice_members':
      renderVoiceMembers(p.members);
      break;
    case 'voice_peer_joined':
      peerNames.set(p.peer.userId, p.peer.username);
      // Membre existant → c'est lui qui initie l'appel vers le nouvel arrivé.
      callPeer(p.peer.userId, p.peer.username);
      addVoiceLog(`${p.peer.username} a rejoint le vocal.`);
      break;
    case 'voice_peer_left':
      cleanupPeer(p.peer.userId);
      addVoiceLog(`${p.peer.username} est parti du vocal.`);
      break;
    case 'voice_signal':
      handleSignal(p.from, p.signal, p.fromName);
      break;
    case 'voice_mute':
      updateMuteIcon(p.peer, p.muted);
      break;
    case 'voice_left':
      currentRoom = null;
      $('voice-room-current').textContent = 'Aucun salon';
      break;
    case 'voice_rooms':
      renderVoiceRooms(p.rooms);
      break;
    default:
      break;
  }
}

// ============================================================
// CHAT ÉCRIT
// ============================================================
function appendChatMessage(m) {
  const div = document.createElement('div');
  div.className = 'chat-msg';
  div.innerHTML = `
    <span class="chat-meta">${esc(m.username)}${m.mc_pseudo ? ` <em>(${esc(m.mc_pseudo)})</em>` : ''} · ${timeAgo(m.created_at)}</span>
    <span class="chat-text">${esc(m.content)}</span>`;
  $('chat-messages').appendChild(div);
}

function scrollChat() {
  const box = $('chat-messages');
  box.scrollTop = box.scrollHeight;
}

$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  wsSend('chat_send', { content: text });
  input.value = '';
});

// ============================================================
// CHAT VOCAL (WebRTC mesh)
// ============================================================
const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

async function ensureLocalStream() {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  return localStream;
}

// Rejoint le salon indiqué (par défaut "general").
$('voice-join').addEventListener('click', async () => {
  const room = ($('voice-room-name').value || 'general').trim().slice(0, 32) || 'general';
  try {
    await ensureLocalStream();
    currentRoom = room;
    $('voice-room-current').textContent = `Salon : ${room}`;
    $('voice-join').disabled = true;
    $('voice-leave').disabled = false;
    $('voice-mute').disabled = false;
    wsSend('voice_join', { room });
    addVoiceLog('Micro activé — connexion aux autres joueurs…');
  } catch (err) {
    flash($('voice-msg'), `Micro inaccessible : ${err.message}`);
  }
});

$('voice-leave').addEventListener('click', () => {
  wsSend('voice_leave');
  cleanupVoice();
  $('voice-join').disabled = false;
  $('voice-leave').disabled = true;
  $('voice-mute').disabled = true;
  $('voice-room-current').textContent = 'Aucun salon';
});

$('voice-mute').addEventListener('click', () => {
  muted = !muted;
  if (localStream) localStream.getAudioTracks().forEach((t) => { t.enabled = !muted; });
  $('voice-mute').textContent = muted ? '🔇 Micro coupé' : '🎙️ Couper le micro';
  wsSend('voice_mute', { muted });
});

function callPeer(peerId, peerName) {
  if (pcs.has(peerId) || !localStream) return;
  peerNames.set(peerId, peerName);
  const pc = createPC(peerId);
  pc.onnegotiationneeded = async () => {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      wsSend('voice_signal', { to: peerId, signal: { type: 'offer', sdp: offer.sdp } });
    } catch { /* peer parti entre-temps */ }
  };
}

function createPC(peerId) {
  const pc = new RTCPeerConnection(ICE);
  pcs.set(peerId, pc);

  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) wsSend('voice_signal', { to: peerId, signal: { candidate: e.candidate } });
  };
  pc.ontrack = (e) => playRemoteAudio(peerId, e.streams[0]);
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') cleanupPeer(peerId);
  };
  return pc;
}

async function handleSignal(from, signal, fromName) {
  if (!signal) return;
  let pc = pcs.get(from);
  if (!pc) pc = createPC(from);
  if (fromName) peerNames.set(from, fromName);

  try {
    if (signal.type === 'offer') {
      await pc.setRemoteDescription(signal);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      wsSend('voice_signal', { to: from, signal: { type: 'answer', sdp: answer.sdp } });
    } else if (signal.type === 'answer') {
      await pc.setRemoteDescription(signal);
    } else if (signal.candidate) {
      await pc.addIceCandidate(signal.candidate).catch(() => {});
    }
  } catch { /* signal tardif après départ du peer */ }
}

function playRemoteAudio(peerId, stream) {
  let audio = remoteAudios.get(peerId);
  if (!audio) {
    audio = document.createElement('audio');
    audio.autoplay = true;
    document.body.appendChild(audio);
    remoteAudios.set(peerId, audio);
  }
  audio.srcObject = stream;
  audio.play().catch(() => {});
}

function cleanupPeer(peerId) {
  const pc = pcs.get(peerId);
  if (pc) { try { pc.close(); } catch { /* déjà fermé */ } }
  pcs.delete(peerId);
  const audio = remoteAudios.get(peerId);
  if (audio) { audio.remove(); remoteAudios.delete(peerId); }
}

function cleanupVoice() {
  for (const peerId of [...pcs.keys()]) cleanupPeer(peerId);
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  muted = false;
  $('voice-mute').textContent = '🎙️ Couper le micro';
  $('voice-members').innerHTML = '';
  $('voice-log').innerHTML = '';
}

// ============================================================
// RENDU VOCAL
// ============================================================
function renderVoiceMembers(members) {
  $('voice-members').innerHTML = members
    .map((m) => {
      const me = m.userId === (ME && ME.id);
      return `<div class="voice-member" data-user="${m.userId}">
        <span>${m.muted ? '🔇' : '🎙️'} ${esc(m.username)}${me ? ' (toi)' : ''}</span>
      </div>`;
    })
    .join('');
}

function updateMuteIcon(peerId, isMuted) {
  const el = document.querySelector(`.voice-member[data-user="${peerId}"] span`);
  if (el) el.textContent = el.textContent.replace(/🎙️|🔇/, isMuted ? '🔇' : '🎙️');
}

function renderVoiceRooms(rooms) {
  $('voice-rooms').innerHTML = rooms.length
    ? rooms.map((r) => `<span class="pill">🔊 ${esc(r.room)} · ${r.count}</span>`).join(' ')
    : '<span class="muted small-text">Aucun salon vocal actif.</span>';
}

function addVoiceLog(text) {
  const div = document.createElement('div');
  div.className = 'muted small-text';
  div.textContent = text;
  $('voice-log').appendChild(div);
  setTimeout(() => div.remove(), 15000);
}

// ============================================================
// DÉMARRAGE
// ============================================================
connectWS();
