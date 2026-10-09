/* IV Devis mobile — fonctionnement SANS internet (07/10/2026, modèle d'IV Clients).
   Les fichiers de l'application sont gardés dans l'appareil. Une nouvelle version
   publiée change CACHE (empreinte posée par fabriquer-mobile.py) : à l'ouverture
   suivante avec internet, elle est téléchargée en arrière-plan et prend effet à
   l'ouverture d'après — sans rien demander.
   Seuls les fichiers de l'application passent par ici : les données vivent dans
   IndexedDB, et le site Immigration Voyages (synchronisation) n'est jamais mis en cache. */
'use strict';
const CACHE = 'iv-devis-2.11.0-d1ea02118c';
const FICHIERS = ["./", "assets/icone-192.png", "assets/icone-512.png", "assets/icone-apple-180.png", "assets/icone-maskable-512.png", "assets/logo-256.png", "index.html", "manifest.webmanifest", "mobile.js", "paquet.js", "pdf-mobile.js", "reglages-agence.js", "renderer.js", "styles.css"];

// cache: 'reload' : les fichiers viennent du serveur, jamais d'une copie gardée par le
// navigateur (GitHub Pages en garde 10 minutes) — sinon une nouvelle version pourrait
// s'installer avec des fichiers de l'ancienne.
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(FICHIERS.map((f) => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((cles) => Promise.all(cles.filter((k) => k.startsWith('iv-devis-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((r) => r || fetch(req)));
});
