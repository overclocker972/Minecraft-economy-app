# ⛏️ MC Économie

Site web complet pour gérer l'économie d'un serveur Minecraft entre joueurs :
**commandes** (service/objet), **échanges** (objet↔objet, objet↔service, service↔service),
**coordonnées publiques et privées**, **comptes joueurs**, **dashboard**, **notifications**,
**chat écrit temps réel** et **chat vocal** (WebRTC, son direct entre navigateurs).

- Backend : **Node.js + Express + SQLite** (fichier, zéro configuration)
- Frontend : HTML/CSS/JS statique servi par le même serveur
- Auth : mots de passe **hashés (bcrypt)** + sessions **JWT**
- 100 % hébergeable gratuitement (Render / Railway)

---

## 📁 Arborescence

```
.
├── backend/
│   ├── server.js          # Serveur Express (API + frontend statique)
│   ├── db.js              # SQLite : schéma (users, orders, trades, public_coords, private_coords, notifications)
│   ├── realtime.js        # Hub WebSocket : chat temps réel + signalisation WebRTC (vocal)
│   ├── auth.js            # JWT + middleware requireAuth
│   └── routes/
│       ├── auth.js        # POST /register, /login — GET /me, /players
│       ├── orders.js      # Commandes : créer, lister, accepter/refuser/terminer/annuler, historique
│       ├── trades.js      # Échanges : créer (3 types), lister, accepter/refuser/terminer/annuler, historique
│       └── coords.js      # Coordonnées publiques/privées + notifications
├── frontend/
│   ├── index.html         # Connexion / inscription
│   ├── dashboard.html     # Dashboard (5 onglets, dont Chat & Vocal)
│   ├── css/style.css
│   └── js/ (api.js, index.js, dashboard.js)
├── tests/api.test.js      # Tests bout-en-bout de l'API
├── Procfile               # Démarrage Railway/Render
├── render.yaml            # Blueprint Render (disque persistant + JWT auto)
├── .env.example
└── package.json
```

---

## 🚀 Installation locale (2 minutes)

```bash
npm install
npm start
# → http://localhost:3000
```

La base SQLite `data/app.db` est créée automatiquement au premier lancement.
Chaque joueur crée son compte sur la page d'accueil, puis tout se passe dans le dashboard.

---

## 🧭 Utilisation

1. **Crée un compte** (pseudo + mot de passe) — chaque joueur du serveur fait pareil.
2. **Onglet Commandes** : envoie une commande (service ou objet + quantité) à un joueur.
   - Le destinataire voit la commande dans « Reçues » → **Accepter / Refuser**.
   - Acceptée → elle passe dans « Commandes à faire » (statut Acceptée).
   - Le prestataire clique **Marquer comme terminée** → historique.
3. **Onglet Échanges** : propose objet↔objet, objet↔service ou service↔service.
   - Le partenaire accepte/refuse, puis n'importe quel participant marque l'échange terminé.
4. **Onglet Coordonnées publiques** : titre + description + X/Y/Z + dimension, visible par tous.
5. **Onglet Mes coordonnées** : tes points privés, visibles uniquement par toi.
6. **🔔 Notifications** : commande reçue / acceptée / refusée / terminée, échange reçu, etc.
   Rafraîchissement automatique toutes les 20 s.

---

## 🔌 API (résumé)

| Méthode | Route | Description |
|---|---|---|
| POST | `/api/auth/register` | Créer un compte |
| POST | `/api/auth/login` | Connexion → token JWT |
| GET | `/api/auth/me` | Profil courant |
| GET | `/api/auth/players` | Liste des joueurs (pour choisir un destinataire) |
| POST | `/api/orders` | Créer une commande |
| GET | `/api/orders/mine` | Mes commandes reçues/envoyées |
| POST | `/api/orders/:id/accept` / `refuse` / `complete` / `cancel` | Actions |
| GET | `/api/orders/history` | Commandes terminées |
| POST | `/api/trades` | Créer un échange |
| GET | `/api/trades/mine` · `/api/trades/history` | Mes échanges / historique |
| POST | `/api/trades/:id/accept` / `refuse` / `complete` / `cancel` | Actions |
| GET | `/api/coords/public` | Coordonnées publiques (public) |
| POST/DELETE | `/api/coords/public/:id` | Publier / supprimer (auteur) |
| GET/POST/DELETE | `/api/coords/private` | Coordonnées privées |
| GET | `/api/chat/history` | Historique des messages du chat |
| WS | `/ws?token=…` | Temps réel : chat, présence, salles vocales, signalisation WebRTC |
| GET | `/api/notifications` | Notifications + compteur non-lues |
| POST | `/api/notifications/read` | Tout marquer comme lu |
| GET | `/api/health` | État du serveur |

---

## ☁️ Déployer gratuitement

> Le plan gratuit de Render garde la base **persistante** grâce au disque.
> Railway et Render sont les deux options recommandées (le site et l'API dans un seul service).

### Option A — Render (recommandé, 5 min)

1. Pousse ce dossier sur un dépôt **GitHub**.
2. Sur [render.com](https://render.com) → **New → Blueprint** → sélectionne le dépôt
   (le fichier `render.yaml` configure tout : plan gratuit, disque persistant, `JWT_SECRET` généré).
3. Attends le déploiement → ton site est en ligne sur `https://mc-economie.onrender.com`.

> ⚠️ Sur le plan gratuit Render, le serveur s'endort après 15 min d'inactivité
> (il redémarre à la première visite, ~30 s). Pour un usage 24/24 réel, Railway est mieux.

### Option B — Railway

1. [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**.
2. Railway détecte Node tout seul. **Variables** : ajoute `JWT_SECRET` (n'importe quelle longue chaîne aléatoire).
3. Railway fournit un domaine public dans **Settings → Networking → Generate Domain**.

> 💾 Sur Railway, le disque est éphémère sur le plan d'essai : la base se recrée vide à chaque redéploiement.
> Pour la persistance, attache un **Volume** monté sur `/app/data` et définis `DATA_DIR=/app/data`.

### Option C — Vercel / Netlify (frontend seul)

Vercel et Netlify n'exécutent pas de serveur Node long-lived sur leurs plans gratuits
(fonctions serverless avec limites de temps) : cette app étant un serveur Express + SQLite,
**l'API doit tourner sur Render ou Railway**, et le **frontend seul** peut être mis sur Vercel/Netlify
si tu veux une URL séparée :

1. Héberge le backend sur Render/Railway → note son URL, ex : `https://mc-economie.onrender.com`.
2. Sur Vercel/Netlify, importe le repo avec **répertoire racine `frontend/`**.
3. Pour que le frontend appelle le backend distant : remplace dans `frontend/js/api.js`
   la ligne `fetch(`/api${path}`…` par `fetch(`${BACKEND_URL}/api${path}`…` avec
   `const BACKEND_URL = 'https://ton-app.onrender.com';`
4. Dans `render.yaml` (ou les variables Render), mets `CORS_ORIGIN=https://ton-front.vercel.app`.

**En pratique : garde tout sur Render ou Railway — c'est plus simple et gratuit.**

---

## 💬 Chat écrit & 🔊 vocal

**Chat écrit** (onglet Chat & Vocal) :
- Temps réel via WebSocket (`/ws`), messages sauvegardés en SQLite (80 derniers affichés, 500 caractères max)
- Présence : nombre de joueurs en ligne en direct
- Reconnexion automatique si la connexion tombe

**Chat vocal** :
- Le son circule **en direct de navigateur à navigateur** (WebRTC mesh) : aucune bande passante serveur, illimité et gratuit
- Salons nommés (défaut `general`), bouton couper le micro, liste des participants en direct
- Jusqu'à **~8 joueurs simultanés** par salon au-delà (mesh), chaque navigateur envoie son flux à chaque participant
- STUN Google public inclus (aucune clé) ; pour des réseaux d'entreprise très restrictifs, un serveur TURN serait nécessaire (payant, optionnel)
- ⚠️ Le micro exige **HTTPS** (automatique sur Render/Railway) et ne fonctionne pas en HTTP local sauf `localhost`

## 🧪 Tests

```bash
npm test
```

Lance 11 tests bout-en-bout : inscription → commandes (accept/refuse/complete/historique),
échanges (3 types), coordonnées publiques/privées, notifications, sécurité,
**chat écrit temps réel** et **signalisation vocale WebRTC**.

## 🔒 Sécurité incluse

- Mots de passe hashés bcrypt (jamais stockés en clair)
- Sessions JWT signées (7 jours, configurable via `TOKEN_TTL`)
- Helmet (headers HTTP), rate-limit anti brute-force sur login/register
- Contrôles de propriété sur chaque action (seul le destinataire accepte, seul l'auteur supprime…)
- Échappement HTML côté frontend (anti-XSS)
- CORS restreint aux origines que tu autorises (`CORS_ORIGIN`)

---

## 📜 Licence

MIT — fais-en ce que tu veux.
