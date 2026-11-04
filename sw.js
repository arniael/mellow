const CACHE_VERSION = 'mellow-v1';
const ASSETS = [
    './', 'index.html', 'style.css', 'manifest.json',
    'js/app.js', 'js/i18n.js', 'js/link.js', 'js/protocol.js', 'js/storage.js', 'js/qr.js',
    'vendor/qrcode.js',
    'icon.svg', 'icon-192.png', 'icon-512.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

// Cache d'abord (démarrage instantané, même sans réseau), réseau en arrière-plan pour rafraîchir.
// Seuls les fichiers de l'application sont mis en cache : aucun message n'est jamais stocké ici.
self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
    event.respondWith(
        caches.match(req, { ignoreSearch: true }).then((cached) => {
            const network = fetch(req).then((res) => {
                if (res && res.ok) { const copy = res.clone(); caches.open(CACHE_VERSION).then((c) => c.put(req, copy)); }
                return res;
            }).catch(() => cached || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()));
            return cached || network;
        })
    );
});
