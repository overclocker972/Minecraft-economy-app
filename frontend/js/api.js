// Client API + helpers partagés.

const TOKEN_KEY = 'mceco_token';

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}
function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* réponse vide */
  }

  if (!res.ok) {
    if (res.status === 401 && getToken()) {
      // session expirée → retour à l'accueil
      setToken('');
      location.href = '/index.html';
    }
    throw new Error((data && data.error) || `Erreur ${res.status}`);
  }
  return data;
}

// Échappe le HTML pour éviter toute injection dans les listes.
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Affiche un petit message d'erreur ou de succès.
function flash(el, message, isError = true) {
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.toggle('success', !isError);
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 5000);
}

function timeAgo(sqliteDate) {
  if (!sqliteDate) return '';
  const then = new Date(sqliteDate.replace(' ', 'T') + 'Z').getTime();
  const diff = Math.max(0, Date.now() - then);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "à l'instant";
  if (mins < 60) return `il y a ${mins} min`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.floor(h / 24);
  return `il y a ${d} j`;
}

const STATUS_LABELS = {
  en_attente: '⏳ En attente',
  acceptee: '✅ Acceptée',
  refusee: '❌ Refusée',
  terminee: '🏁 Terminée',
  annulee: '✖️ Annulée',
  accepte: '✅ Accepté',
  refuse: '❌ Refusé',
  termine: '🏁 Terminé',
  annule: '✖️ Annulé',
};
function statusLabel(s) {
  return STATUS_LABELS[s] || s;
}
