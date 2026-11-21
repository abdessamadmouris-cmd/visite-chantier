/* ============================================================
   sw.js — mode hors-ligne
   RESEAU D'ABORD pour tout : quand il y a du réseau, on sert
   toujours la dernière version déposée sur Netlify, et on met
   le cache à jour au passage. Le cache ne sert que lorsqu'il
   n'y a pas de réseau (terrasse, sous-sol, zone blanche).
   Les données des chantiers ne passent pas par ici : elles
   restent dans la base locale du téléphone.
   ============================================================ */

const CACHE = 'visite360-v16';
const V = '?v=16';
const COQUE = [
  './',
  'index.html',
  'css/app.css' + V,
  'js/app.js' + V,
  'js/db.js' + V,
  'js/geo.js' + V,
  'js/viewer.js' + V,
  'js/capture.js' + V,
  'js/alignement.js' + V,
  'js/carte.js' + V,
  'manifest.webmanifest',
  'icons/icone-192.png',
  'icons/icone-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(COQUE).catch(() => null))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((cles) => Promise.all(cles.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  e.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((r) => {
        if (r.ok) { const copie = r.clone(); caches.open(CACHE).then((c) => c.put(req, copie)); }
        return r;
      })
      .catch(() => caches.match(req).then((r) =>
        r || (req.mode === 'navigate' ? caches.match('index.html') : undefined)))
  );
});
