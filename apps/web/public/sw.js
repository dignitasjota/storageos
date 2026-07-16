/* Service worker mínimo de StorageOS (PWA del inquilino).
 *
 * Objetivos:
 *  - Instalabilidad (junto al manifest).
 *  - App-shell offline: las navegaciones caen a /offline.html sin red.
 *  - Cache-first de assets estáticos de Next (/_next/static).
 *
 * NO cachea NUNCA llamadas a la API (/api ni el backend), respuestas
 * autenticadas, ni peticiones que no sean GET de mismo origen. El pago y las
 * facturas requieren red por diseño.
 */
const CACHE = 'storageos-pwa-v3';
const PRECACHE = [
  '/offline.html',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.webmanifest',
  '/manifest-staff.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // cross-origin (API backend, Stripe…)
  if (url.pathname.startsWith('/api/')) return; // rutas API del propio Next

  // Navegaciones (documentos): network-first con fallback a offline.html.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() =>
        caches.match(req).then((cached) => cached ?? caches.match('/offline.html')),
      ),
    );
    return;
  }

  // Assets estáticos de Next: cache-first + revalidación en background.
  if (url.pathname.startsWith('/_next/static/') || PRECACHE.includes(url.pathname)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            if (res.ok) {
              const clone = res.clone();
              caches.open(CACHE).then((cache) => cache.put(req, clone));
            }
            return res;
          })
          .catch(() => cached);
        return cached ?? network;
      }),
    );
  }
});

// Web Push: muestra la notificación que envía el backend.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || 'StorageOS';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/portal/login' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Al pulsar la notificación: abre (o enfoca) la URL indicada.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/portal/login';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(target) && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
