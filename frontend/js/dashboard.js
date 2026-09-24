// Dashboard : onglets, commandes, échanges, coordonnées, notifications.

// --- Garde d'authentification ---
const token = localStorage.getItem('mceco_token');
if (!token) location.replace('/index.html');

let ME = null;
try {
  ME = JSON.parse(localStorage.getItem('mceco_user') || 'null');
} catch { /* ignore */ }

const $ = (id) => document.getElementById(id);

// --- Déconnexion ---
$('logout').addEventListener('click', () => {
  setToken('');
  localStorage.removeItem('mceco_user');
  location.href = '/index.html';
});

// --- Identité affichée ---
(async function initWho() {
  try {
    const { user } = await api('/auth/me');
    ME = user;
    localStorage.setItem('mceco_user', JSON.stringify(user));
  } catch { /* 401 déjà géré par api() */ }
  $('who').textContent = `Connecté : ${ME ? ME.username : '?'}`;
})();

// --- Onglets ---
const TABS = ['orders', 'trades', 'public', 'private'];

function showTab(name, pushUrl = true) {
  for (const t of TABS) {
    $(`tab-${t}`).hidden = t !== name;
  }
  document.querySelectorAll('#tabs-nav .tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  if (pushUrl) {
    const url = new URL(location);
    url.searchParams.set('tab', name);
    history.replaceState(null, '', url);
  }
}

document.querySelectorAll('#tabs-nav .tab').forEach((btn) => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
});

const initialTab = new URLSearchParams(location.search).get('tab');
showTab(TABS.includes(initialTab) ? initialTab : 'orders', false);

// ============================================================
// COMMANDES
// ============================================================
let PLAYERS = [];

async function loadPlayers() {
  const { players } = await api('/players');
  PLAYERS = players.filter((p) => p.id !== (ME && ME.id));
  const options = PLAYERS.map(
    (p) => `<option value="${p.id}">${esc(p.username)}${p.mc_pseudo && p.mc_pseudo !== p.username ? ` (${esc(p.mc_pseudo)})` : ''}</option>`
  ).join('');
  $('order-provider').innerHTML = options;
  $('trade-partner').innerHTML = options;
}

$('order-type').addEventListener('change', () => {
  $('order-objet-fields').hidden = $('order-type').value !== 'objet';
});

$('order-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('order-msg');
  try {
    const type = $('order-type').value;
    await api('/orders', {
      method: 'POST',
      body: {
        provider_id: Number($('order-provider').value),
        type,
        item_name: $('order-item').value,
        quantity: Number($('order-qty').value || 1),
        description: $('order-desc').value,
      },
    });
    flash(msg, 'Commande envoyée !', false);
    $('order-form').reset();
    $('order-qty').value = 1;
    $('order-objet-fields').hidden = true;
    await Promise.all([loadOrders(), refreshNotifs()]);
  } catch (err) {
    flash(msg, err.message);
  }
});

function orderCard(o, perspective) {
  // perspective : 'received' (je suis le prestataire) ou 'sent' (je suis le client)
  const actions = [];
  if (perspective === 'received' && o.status === 'en_attente') {
    actions.push(`<button class="btn small ok" onclick="orderAction(${o.id},'accept')">Accepter</button>`);
    actions.push(`<button class="btn small danger" onclick="orderAction(${o.id},'refuse')">Refuser</button>`);
  }
  if (perspective === 'received' && o.status === 'acceptee') {
    actions.push(`<button class="btn small primary" onclick="orderAction(${o.id},'complete')">Marquer comme terminée</button>`);
  }
  if (perspective === 'sent' && o.status === 'en_attente') {
    actions.push(`<button class="btn small ghost" onclick="orderAction(${o.id},'cancel')">Annuler</button>`);
  }

  const what = o.type === 'objet'
    ? `📦 ${esc(o.item_name)} ×${o.quantity}`
    : `🛠️ ${esc(o.description)}`;

  return `
    <div class="item">
      <div class="item-head">
        <strong>#${o.id} ${what}</strong>
        <span class="status s-${o.status}">${statusLabel(o.status)}</span>
      </div>
      ${o.type === 'objet' && o.description ? `<div class="muted">${esc(o.description)}</div>` : ''}
      <div class="muted small-text">
        ${perspective === 'received' ? `De : ${esc(o.client_name)}` : `Pour : ${esc(o.provider_name)}`} · ${timeAgo(o.created_at)}
      </div>
      ${actions.length ? `<div class="actions">${actions.join(' ')}</div>` : ''}
    </div>`;
}

async function loadOrders() {
  const [{ received, sent }, { history }] = await Promise.all([
    api('/orders/mine'),
    api('/orders/history'),
  ]);

  $('orders-received').innerHTML = received.length
    ? received.map((o) => orderCard(o, 'received')).join('')
    : '<p class="muted">Aucune commande reçue.</p>';
  $('orders-sent').innerHTML = sent.length
    ? sent.map((o) => orderCard(o, 'sent')).join('')
    : '<p class="muted">Aucune commande envoyée.</p>';
  $('orders-history').innerHTML = history.length
    ? history.map((o) => orderCard(o, o.provider_id === (ME && ME.id) ? 'received' : 'sent')).join('')
    : '<p class="muted">Pas encore de commandes terminées.</p>';

  $('c-rec').textContent = received.filter((o) => o.status === 'en_attente').length;
  $('c-sent').textContent = sent.filter((o) => o.status === 'acceptee').length;
}

async function orderAction(id, action) {
  try {
    await api(`/orders/${id}/${action}`, { method: 'POST' });
    await Promise.all([loadOrders(), refreshNotifs()]);
  } catch (err) {
    alert(err.message);
  }
}
window.orderAction = orderAction;

// ============================================================
// ÉCHANGES
// ============================================================
function wireOffer(prefix) {
  const typeSel = $(`${prefix}-type`);
  const update = () => {
    $(`${prefix}-objet`).hidden = typeSel.value !== 'objet';
    $(`${prefix}-service`).hidden = typeSel.value !== 'service';
  };
  typeSel.addEventListener('change', update);
  update();
}
wireOffer('ta');
wireOffer('tb');

function readOffer(prefix) {
  const type = $(`${prefix}-type`).value;
  if (type === 'objet') {
    return {
      type,
      item_name: $(`${prefix}-item`).value,
      quantity: Number($(`${prefix}-qty`).value || 1),
    };
  }
  return { type, description: $(`${prefix}-desc`).value };
}

$('trade-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('trade-msg');
  try {
    await api('/trades', {
      method: 'POST',
      body: {
        partner_id: Number($('trade-partner').value),
        initiator_offer: readOffer('ta'),
        partner_offer: readOffer('tb'),
      },
    });
    flash(msg, 'Échange proposé !', false);
    $('trade-form').reset();
    wireOfferReset('ta');
    wireOfferReset('tb');
    await Promise.all([loadTrades(), refreshNotifs()]);
  } catch (err) {
    flash(msg, err.message);
  }
});

function wireOfferReset(prefix) {
  $(`${prefix}-type`).value = 'objet';
  $(`${prefix}-objet`).hidden = false;
  $(`${prefix}-service`).hidden = true;
}

function offerText(o) {
  return o.type === 'objet'
    ? `📦 ${esc(o.item_name)} ×${o.quantity}`
    : `🛠️ ${esc(o.description)}`;
}

function tradeCard(t, perspective) {
  const actions = [];
  if (perspective === 'received' && t.status === 'en_attente') {
    actions.push(`<button class="btn small ok" onclick="tradeAction(${t.id},'accept')">Accepter</button>`);
    actions.push(`<button class="btn small danger" onclick="tradeAction(${t.id},'refuse')">Refuser</button>`);
  }
  if (t.status === 'accepte') {
    actions.push(`<button class="btn small primary" onclick="tradeAction(${t.id},'complete')">Marquer comme terminé</button>`);
  }
  if (perspective === 'sent' && t.status === 'en_attente') {
    actions.push(`<button class="btn small ghost" onclick="tradeAction(${t.id},'cancel')">Annuler</button>`);
  }

  return `
    <div class="item">
      <div class="item-head">
        <strong>#${t.id} ${offerText(t.initiator_offer)} ⇄ ${offerText(t.partner_offer)}</strong>
        <span class="status s-${t.status}">${statusLabel(t.status)}</span>
      </div>
      <div class="muted small-text">
        ${perspective === 'received' ? `De : ${esc(t.initiator_name)}` : `Avec : ${esc(t.partner_name)}`} ·
        type : ${t.trade_type.replace('_', ' ↔ ')} · ${timeAgo(t.created_at)}
      </div>
      ${actions.length ? `<div class="actions">${actions.join(' ')}</div>` : ''}
    </div>`;
}

async function loadTrades() {
  const [{ received, sent }, { history }] = await Promise.all([
    api('/trades/mine'),
    api('/trades/history'),
  ]);

  $('trades-received').innerHTML = received.length
    ? received.map((t) => tradeCard(t, 'received')).join('')
    : '<p class="muted">Aucun échange reçu.</p>';
  $('trades-sent').innerHTML = sent.length
    ? sent.map((t) => tradeCard(t, 'sent')).join('')
    : '<p class="muted">Aucun échange envoyé.</p>';
  $('trades-history').innerHTML = history.length
    ? history.map((t) => tradeCard(t, t.initiator_id === (ME && ME.id) ? 'sent' : 'received')).join('')
    : '<p class="muted">Pas encore d\'échanges terminés.</p>';

  $('c-trec').textContent = received.filter((t) => t.status === 'en_attente').length;
  $('c-tsent').textContent = sent.filter((t) => t.status === 'accepte').length;
}

async function tradeAction(id, action) {
  try {
    await api(`/trades/${id}/${action}`, { method: 'POST' });
    await Promise.all([loadTrades(), refreshNotifs()]);
  } catch (err) {
    alert(err.message);
  }
}
window.tradeAction = tradeAction;

// ============================================================
// COORDONNÉES
// ============================================================
function coordCard(c, isPrivate) {
  const dimIcon = { overworld: '🌍', nether: '🔥', end: '🌌' }[c.dimension] || '';
  const del = isPrivate
    ? `<button class="btn small danger" onclick="delPrivate(${c.id})">Supprimer</button>`
    : (ME && c.user_id === ME.id
        ? `<button class="btn small danger" onclick="delPublic(${c.id})">Supprimer</button>`
        : '');
  return `
    <div class="item">
      <div class="item-head">
        <strong>${dimIcon} ${esc(c.title)}</strong>
        <code class="coords">X ${c.x} · Y ${c.y} · Z ${c.z}</code>
      </div>
      ${c.description ? `<div class="muted">${esc(c.description)}</div>` : ''}
      <div class="muted small-text">${isPrivate ? 'Privé' : `Par ${esc(c.author)}`} · ${timeAgo(c.created_at)}</div>
      ${del ? `<div class="actions">${del}</div>` : ''}
    </div>`;
}

$('pub-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('pub-msg');
  try {
    await api('/coords/public', {
      method: 'POST',
      body: {
        title: $('pub-title').value,
        description: $('pub-desc').value,
        x: Number($('pub-x').value),
        y: Number($('pub-y').value),
        z: Number($('pub-z').value),
        dimension: $('pub-dim').value,
      },
    });
    flash(msg, 'Publiée !', false);
    $('pub-form').reset();
    $('pub-y').value = 64;
    await loadPublic();
  } catch (err) {
    flash(msg, err.message);
  }
});

$('priv-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('priv-msg');
  try {
    await api('/coords/private', {
      method: 'POST',
      body: {
        title: $('priv-title').value,
        description: $('priv-desc').value,
        x: Number($('priv-x').value),
        y: Number($('priv-y').value),
        z: Number($('priv-z').value),
        dimension: $('priv-dim').value,
      },
    });
    flash(msg, 'Ajoutée !', false);
    $('priv-form').reset();
    $('priv-y').value = 64;
    await loadPrivate();
  } catch (err) {
    flash(msg, err.message);
  }
});

async function loadPublic() {
  const { coords } = await api('/coords/public');
  $('pub-list').innerHTML = coords.length
    ? coords.map((c) => coordCard(c, false)).join('')
    : '<p class="muted">Aucune coordonnée publique pour le moment.</p>';
}

async function loadPrivate() {
  const { coords } = await api('/coords/private');
  $('priv-list').innerHTML = coords.length
    ? coords.map((c) => coordCard(c, true)).join('')
    : '<p class="muted">Aucune coordonnée privée.</p>';
}

async function delPublic(id) {
  try {
    await api(`/coords/public/${id}`, { method: 'DELETE' });
    await loadPublic();
  } catch (err) { alert(err.message); }
}
async function delPrivate(id) {
  try {
    await api(`/coords/private/${id}`, { method: 'DELETE' });
    await loadPrivate();
  } catch (err) { alert(err.message); }
}
window.delPublic = delPublic;
window.delPrivate = delPrivate;

// ============================================================
// NOTIFICATIONS
// ============================================================
let pollTimer = null;

function startPolling() {
  stopPolling();
  if ($('notif-live').checked) {
    pollTimer = setInterval(refreshNotifs, 20000);
  }
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
$('notif-live').addEventListener('change', startPolling);

$('bell').addEventListener('click', () => {
  const panel = $('notif-panel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) refreshNotifs();
});

$('notif-clear').addEventListener('click', async () => {
  await api('/notifications/read', { method: 'POST' });
  await refreshNotifs();
});

async function refreshNotifs() {
  try {
    const { notifications, unread } = await api('/notifications');
    $('bell-count').hidden = unread === 0;
    $('bell-count').textContent = unread > 99 ? '99+' : String(unread);
    $('notif-list').innerHTML = notifications.length
      ? notifications.map(
          (n) => `
          <div class="notif ${n.is_read ? 'read' : 'unread'}">
            <div>${esc(n.message)}</div>
            <div class="muted small-text">${timeAgo(n.created_at)}</div>
          </div>`
        ).join('')
      : '<p class="muted">Aucune notification.</p>';
  } catch { /* silencieux : le polling continue */ }
}

// ============================================================
// CHARGEMENT INITIAL
// ============================================================
(async function init() {
  await loadPlayers();
  await Promise.all([loadOrders(), loadTrades(), loadPublic(), loadPrivate(), refreshNotifs()]);
  startPolling();
})();
