/* IV Devis mobile — fonctionnement SANS internet (07/10/2026, modèle d'IV Clients).
   Les fichiers de l'application sont gardés dans l'appareil. Une nouvelle version
   publiée change CACHE (empreinte posée par fabriquer-mobile.py) : elle est
   téléchargée en arrière-plan, puis la page est rechargée (voir « activate »).
   Seuls les fichiers de l'application passent par ici : les données vivent dans
   IndexedDB, et le site Immigration Voyages (synchronisation) n'est jamais mis en cache. */
'use strict';
const CACHE = 'iv-devis-2.13.0-cdb35c390a';
const FICHIERS = ["./", "assets/icone-192.png", "assets/icone-512.png", "assets/icone-apple-180.png", "assets/icone-maskable-512.png", "assets/logo-256.png", "index.html", "manifest.webmanifest", "mobile.js", "paquet.js", "pdf-mobile.js", "reglages-agence.js", "renderer.js", "styles.css"];

// cache: 'reload' : les fichiers viennent du serveur, jamais d'une copie gardée par le
// navigateur (GitHub Pages en garde 10 minutes) — sinon une nouvelle version pourrait
// s'installer avec des fichiers de l'ancienne.
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(FICHIERS.map((f) => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

/* Mise à jour (2.12.0, 26/10/2026, comme IV Clients 1.38.1) : la page déjà ouverte tourne encore
   avec l'ancienne version (jusqu'à la 2.11.2, elle réclamait le fichier .ivpaquet) ; on la recharge
   aussitôt, la nouvelle s'affiche dès cette ouverture-ci. Pas au tout premier lancement : aucune
   ancienne version à remplacer.
   Le rechargement part APRÈS l'activation, hors de waitUntil : la page rechargée attend que ce service
   worker soit activé, et l'activation attendrait la page — blocage vérifié dans Chrome 156 le 26/10/2026. */
self.addEventListener('activate', (e) => {
  const fait = caches.keys().then(async (cles) => {
    const anciens = cles.filter((k) => k.startsWith('iv-devis-') && k !== CACHE);
    await Promise.all(anciens.map((k) => caches.delete(k)));
    await self.clients.claim();
    return anciens.length > 0;
  });
  e.waitUntil(fait);
  fait.then((maj) => maj && self.clients.matchAll({ type: 'window' }))
    .then((pages) => (pages || []).forEach((p) => p.navigate(p.url).catch(() => {})))
    .catch(() => {});
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((r) => r || fetch(req)));
});
