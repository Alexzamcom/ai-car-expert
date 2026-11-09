/* AI Car Expert — service worker (генерируется при сборке) */
const CACHE = '__VERSION__';
const PRECACHE = __PRECACHE__;
const TILE_CACHE = 'ace-osm-tiles';
const TILE_LIMIT = 600;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE && k !== TILE_CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

async function trimTiles() {
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - TILE_LIMIT; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Тайлы OpenStreetMap: сначала сеть (кэширование HTTP по заголовкам сервера),
  // ограниченная копия просмотренных тайлов — только для работы без связи. Массовая загрузка не ведётся.
  if (url.hostname === 'tile.openstreetmap.org') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(TILE_CACHE).then((c) => c.put(req, copy)).then(trimTiles);
          }
          return res;
        })
        .catch(() => caches.open(TILE_CACHE).then((c) => c.match(req)).then((hit) => hit || Response.error())),
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Навигация: сеть, при её отсутствии — оболочка приложения из кэша.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('./', { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
    );
    return;
  }

  // Статика: cache-first.
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
