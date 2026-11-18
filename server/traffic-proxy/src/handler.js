// Пробки TomTom для AI Car Expert: посредник, который хранит ключ (секрет TOMTOM_KEY) и бережёт бесплатную квоту.
//
// Защита квоты и от злоупотреблений:
// - только разрешённые адреса и параметры: тайлы z 6…16, координаты в пределах Украины и соседей, без произвольных URL;
// - запросы только с разрешённых Origin (браузер приложения); /usage и /diag — без Origin, но с ограничением частоты;
// - суточные потолки по видам запросов (тайлы, маршруты, отрезки, происшествия) — при превышении 429, платных запросов нет;
// - кэш в памяти экземпляра и заголовки Cache-Control: одинаковые тайлы и маршруты не запрашиваются повторно;
// - счётчики — в KV (общие для экземпляров), запись пачками: бесплатный KV — 1000 записей в сутки;
// - без KV (REQUIRE_KV=1) к TomTom не обращаемся (fail-closed).
//
// Ключ никогда не возвращается клиенту и не пишется в журнал; в ответах об ошибках — только код TomTom.

const TT = 'https://api.tomtom.com';
const KINDS = ['tiles', 'routes', 'flow', 'incidents'];
const LIMIT_VAR = { tiles: 'DAILY_TILES', routes: 'DAILY_ROUTES', flow: 'DAILY_FLOW', incidents: 'DAILY_INCIDENTS' };
const DEFAULT_LIMIT = { tiles: 5000, routes: 300, flow: 500, incidents: 300 };
/** Граница допустимых координат: Украина с запасом (запросы по всему миру квоту не тратят). */
export const BOUNDS = { minLat: 43.5, maxLat: 53.5, minLon: 21.0, maxLon: 41.5 };
const FLUSH_EVERY = 25;
const FLUSH_MS = 120_000;

/* ---------- Счётчики квоты ---------- */
const mem = { day: '', counts: { tiles: 0, routes: 0, flow: 0, incidents: 0 }, pending: { tiles: 0, routes: 0, flow: 0, incidents: 0 }, flushedAt: 0, stored: null };

export const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

async function loadStored(env, day) {
  if (!env.USAGE?.get) return { tiles: 0, routes: 0, flow: 0, incidents: 0 };
  const raw = await env.USAGE.get(`day:${day}`);
  return raw ? { tiles: 0, routes: 0, flow: 0, incidents: 0, ...JSON.parse(raw) } : { tiles: 0, routes: 0, flow: 0, incidents: 0 };
}

/** Текущий расход за сутки: сохранённый в KV + ещё не записанный в этом экземпляре. */
export async function usage(env, now = Date.now()) {
  const day = today(now);
  if (mem.day !== day) {
    mem.day = day;
    mem.pending = { tiles: 0, routes: 0, flow: 0, incidents: 0 };
    mem.stored = null;
  }
  if (!mem.stored || now - mem.flushedAt > FLUSH_MS) {
    mem.stored = await loadStored(env, day);
    mem.flushedAt = now;
  }
  const out = {};
  for (const k of KINDS) out[k] = mem.stored[k] + mem.pending[k];
  return out;
}

async function flush(env, now = Date.now()) {
  if (!env.USAGE?.put) return;
  const day = today(now);
  const stored = await loadStored(env, day);
  for (const k of KINDS) stored[k] += mem.pending[k];
  mem.pending = { tiles: 0, routes: 0, flow: 0, incidents: 0 };
  mem.stored = stored;
  mem.flushedAt = now;
  await env.USAGE.put(`day:${day}`, JSON.stringify(stored), { expirationTtl: 40 * 86400 });
}

export const limitOf = (env, kind) => Number(env[LIMIT_VAR[kind]] || DEFAULT_LIMIT[kind]);

/** Разрешить запрос к TomTom этого вида (и учесть его) — или отказать по суточному потолку. */
export async function spend(env, kind, ctx, now = Date.now()) {
  const u = await usage(env, now);
  if (u[kind] >= limitOf(env, kind)) return false;
  mem.pending[kind]++;
  const pend = KINDS.reduce((a, k) => a + mem.pending[k], 0);
  if (pend >= FLUSH_EVERY || now - mem.flushedAt > FLUSH_MS) {
    const p = flush(env, now);
    if (ctx?.waitUntil) ctx.waitUntil(p);
    else await p;
  }
  return true;
}

/* ---------- Частота с одного адреса ---------- */
const hits = new Map();
export function rateLimited(ip, perMin, now = Date.now()) {
  const minute = Math.floor(now / 60_000);
  const key = `${ip}:${minute}`;
  const n = (hits.get(key) || 0) + 1;
  hits.set(key, n);
  if (hits.size > 5000) for (const k of hits.keys()) if (!k.endsWith(`:${minute}`)) hits.delete(k);
  return n > perMin;
}

/* ---------- Кэш в памяти экземпляра ---------- */
const cache = new Map();
const CACHE_MAX = 400;
function cacheGet(key, now = Date.now()) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.until < now) {
    cache.delete(key);
    return null;
  }
  return hit;
}
function cachePut(key, value, ttlMs, now = Date.now()) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { ...value, until: now + ttlMs });
}
export function __reset() {
  cache.clear();
  hits.clear();
  mem.day = '';
  mem.stored = null;
  mem.pending = { tiles: 0, routes: 0, flow: 0, incidents: 0 };
  mem.flushedAt = 0;
}

/* ---------- Ответы ---------- */
export function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return null;
  return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' };
}
const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });

const num = (v) => (v == null || v === '' ? NaN : Number(v));
export const inBounds = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && lat >= BOUNDS.minLat && lat <= BOUNDS.maxLat && lon >= BOUNDS.minLon && lon <= BOUNDS.maxLon;

/** Тайл (z/x/y) пересекает допустимую область. */
export function tileInBounds(z, x, y) {
  const n = 2 ** z;
  if (!(x >= 0 && x < n && y >= 0 && y < n)) return false;
  const lon0 = (x / n) * 360 - 180;
  const lon1 = ((x + 1) / n) * 360 - 180;
  const lat = (yy) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / n))) * 180) / Math.PI;
  const lat0 = lat(y + 1);
  const lat1 = lat(y);
  return lon1 >= BOUNDS.minLon && lon0 <= BOUNDS.maxLon && lat1 >= BOUNDS.minLat && lat0 <= BOUNDS.maxLat;
}

async function upstream(env, path, params = {}) {
  const u = new URL(TT + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  u.searchParams.set('key', env.TOMTOM_KEY);
  return fetch(u.toString(), { headers: { Accept: '*/*' } });
}

/* ---------- Маршрут: сокращённый ответ ---------- */
export function trimRoutes(data) {
  return (data.routes || []).map((r) => ({
    lengthM: r.summary?.lengthInMeters ?? null,
    timeS: r.summary?.travelTimeInSeconds ?? null,
    delayS: r.summary?.trafficDelayInSeconds ?? null,
    noTrafficS: r.summary?.noTrafficTravelTimeInSeconds ?? null,
    historicS: r.summary?.historicTrafficTravelTimeInSeconds ?? null,
    liveS: r.summary?.liveTrafficIncidentsTravelTimeInSeconds ?? null,
    departure: r.summary?.departureTime ?? null,
    coords: (r.legs || []).flatMap((l) => (l.points || []).map((p) => [Math.round(p.longitude * 1e6) / 1e6, Math.round(p.latitude * 1e6) / 1e6])),
    sections: (r.sections || []).filter((s) => s.sectionType === 'TRAFFIC').map((s) => ({ from: s.startPointIndex, to: s.endPointIndex, delayS: s.delayInSeconds ?? null, magnitude: s.magnitudeOfDelay ?? null, type: s.simpleCategory ?? null })),
  }));
}

/* ---------- Обработка ---------- */
export async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const cors = corsHeaders(origin, env);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (request.method === 'OPTIONS') return cors ? new Response(null, { status: 204, headers: cors }) : new Response(null, { status: 403 });
  if (request.method !== 'GET') return json(405, { error: 'Метод не поддерживается' }, cors || {});
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  if (rateLimited(ip, Number(env.RATE_PER_MIN || 120))) return json(429, { error: 'Слишком много запросов, подождите минуту' }, cors || {});

  if (path === '/' || path === '/health') {
    return json(200, { ok: true, service: 'ai-car-expert-traffic', provider: 'TomTom', configured: Boolean(env.TOMTOM_KEY), persistent: Boolean(env.USAGE?.get) }, cors || {});
  }
  if (path === '/usage') {
    const u = await usage(env);
    const limits = Object.fromEntries(KINDS.map((k) => [k, limitOf(env, k)]));
    return json(200, { day: today(), used: u, limits, note: 'Оценка посредника; точный расход — в кабинете TomTom (developer.tomtom.com → Dashboard).' }, cors || {});
  }
  if (path === '/diag') return diag(env, ctx, cors);

  // Остальное — только из приложения (разрешённый Origin).
  if (!cors) return json(403, { error: 'Источник запроса не разрешён' });
  if (!env.TOMTOM_KEY) return json(503, { error: 'Сервер пробок не настроен: нет ключа TomTom', code: 'not-configured' }, cors);
  if (env.REQUIRE_KV === '1' && !env.USAGE?.get) return json(503, { error: 'Сервер пробок не настроен: нет хранилища счётчиков', code: 'not-configured' }, cors);

  let m;
  if ((m = path.match(/^\/tiles\/(flow|incidents)\/(\d+)\/(\d+)\/(\d+)\.png$/))) {
    const [, layer, zs, xs, ys] = m;
    const z = Number(zs);
    const x = Number(xs);
    const y = Number(ys);
    if (z < 6 || z > 16 || !tileInBounds(z, x, y)) return json(400, { error: 'Тайл вне допустимой области' }, cors);
    const dark = url.searchParams.get('theme') === 'night';
    const style = layer === 'flow' ? (dark ? 'relative0-dark' : 'relative0') : dark ? 'night' : 's3';
    const key = `t:${layer}:${style}:${z}/${x}/${y}`;
    const hit = cacheGet(key);
    if (hit) return new Response(hit.body, { status: 200, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=120', 'X-Cache': 'HIT', ...cors } });
    if (!(await spend(env, 'tiles', ctx))) return json(429, { error: 'Суточный лимит тайлов пробок исчерпан', code: 'quota' }, cors);
    const r = await upstream(env, `/traffic/map/4/tile/${layer}/${style}/${z}/${x}/${y}.png`, { tileSize: 512 });
    if (!r.ok) return json(r.status === 403 || r.status === 429 ? 429 : 502, { error: `TomTom: ${r.status}`, code: r.status === 403 || r.status === 429 ? 'quota' : 'upstream' }, cors);
    const body = await r.arrayBuffer();
    cachePut(key, { body }, 120_000);
    return new Response(body, { status: 200, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=120', 'X-Cache': 'MISS', ...cors } });
  }

  if (path === '/flow') {
    const lat = num(url.searchParams.get('lat'));
    const lon = num(url.searchParams.get('lon'));
    if (!inBounds(lat, lon)) return json(400, { error: 'Координаты вне допустимой области' }, cors);
    const key = `f:${lat.toFixed(4)},${lon.toFixed(4)}`;
    const hit = cacheGet(key);
    if (hit) return json(200, hit.data, { ...cors, 'Cache-Control': 'public, max-age=60' });
    if (!(await spend(env, 'flow', ctx))) return json(429, { error: 'Суточный лимит данных отрезков исчерпан', code: 'quota' }, cors);
    const r = await upstream(env, `/traffic/services/4/flowSegmentData/relative0/12/json`, { point: `${lat},${lon}`, unit: 'KMPH' });
    if (!r.ok) return json(r.status === 404 ? 404 : 502, { error: `TomTom: ${r.status}`, code: r.status === 404 ? 'no-data' : 'upstream' }, cors);
    const d = (await r.json()).flowSegmentData || {};
    const data = { currentSpeed: d.currentSpeed ?? null, freeFlowSpeed: d.freeFlowSpeed ?? null, confidence: d.confidence ?? null, roadClosure: d.roadClosure ?? null, frc: d.frc ?? null };
    cachePut(key, { data }, 60_000);
    return json(200, data, { ...cors, 'Cache-Control': 'public, max-age=60' });
  }

  if (path === '/route') {
    const pts = (url.searchParams.get('points') || '').split(';').map((p) => p.split(',').map(Number));
    if (pts.length < 2 || pts.length > 4 || pts.some(([la, lo]) => !inBounds(la, lo))) return json(400, { error: 'Нужно 2–4 точки в пределах области' }, cors);
    const alts = Math.min(2, Math.max(0, Number(url.searchParams.get('alternatives') || 0)));
    const locs = pts.map(([la, lo]) => `${la.toFixed(5)},${lo.toFixed(5)}`).join(':');
    const key = `r:${locs}:${alts}`;
    const hit = cacheGet(key);
    if (hit) return json(200, hit.data, { ...cors, 'Cache-Control': 'private, max-age=60' });
    if (!(await spend(env, 'routes', ctx))) return json(429, { error: 'Суточный лимит маршрутов с пробками исчерпан', code: 'quota' }, cors);
    const r = await upstream(env, `/routing/1/calculateRoute/${locs}/json`, {
      traffic: 'true',
      computeTravelTimeFor: 'all',
      routeType: 'fastest',
      travelMode: 'car',
      maxAlternatives: alts,
      sectionType: 'traffic',
      language: 'ru-RU',
    });
    if (!r.ok) return json(502, { error: `TomTom: ${r.status}`, code: 'upstream' }, cors);
    const data = { routes: trimRoutes(await r.json()), at: Date.now() };
    cachePut(key, { data }, 60_000);
    return json(200, data, { ...cors, 'Cache-Control': 'private, max-age=60' });
  }

  return json(404, { error: 'Нет такого адреса' }, cors);
}

/* ---------- Проверка реальных данных: Павлоград, Днепр, трасса между ними ---------- */
let lastDiag = 0;
export const DIAG_POINTS = [
  ['Павлоград, центр (ул. Соборная)', 48.5318, 35.8708],
  ['Павлоград, выезд на Днепр', 48.5146, 35.8268],
  ['Днепр, проспект Яворницкого', 48.4668, 35.0459],
  ['Днепр, Новый мост', 48.4581, 35.0723],
  ['Днепр, Набережная Победы', 48.4413, 35.0647],
];

async function diag(env, ctx, cors) {
  const h = cors || {};
  if (!env.TOMTOM_KEY) return json(503, { error: 'Нет ключа TomTom (секрет TOMTOM_KEY)', code: 'not-configured' }, h);
  // Проверка тратит ~20 запросов — не чаще раза в 10 минут.
  if (Date.now() - lastDiag < 600_000) return json(429, { error: 'Проверка уже выполнялась, повторите через 10 минут' }, h);
  lastDiag = Date.now();
  const out = { at: new Date().toISOString(), flow: [], route: null, alongRoute: [], incidents: null, tiles: [] };
  const flow = async (name, lat, lon) => {
    if (!(await spend(env, 'flow', ctx))) return { name, error: 'лимит' };
    const r = await upstream(env, `/traffic/services/4/flowSegmentData/absolute/12/json`, { point: `${lat},${lon}`, unit: 'KMPH' });
    if (!r.ok) return { name, lat, lon, status: r.status };
    const d = (await r.json()).flowSegmentData || {};
    return { name, lat, lon, status: 200, frc: d.frc, currentSpeed: d.currentSpeed, freeFlowSpeed: d.freeFlowSpeed, currentTravelTime: d.currentTravelTime, freeFlowTravelTime: d.freeFlowTravelTime, confidence: d.confidence, roadClosure: d.roadClosure, segmentPoints: d.coordinates?.coordinate?.length ?? 0 };
  };
  for (const [name, lat, lon] of DIAG_POINTS) out.flow.push(await flow(name, lat, lon));

  // Маршрут Павлоград → Днепр с пробками и альтернативами.
  if (await spend(env, 'routes', ctx)) {
    const r = await upstream(env, `/routing/1/calculateRoute/${DIAG_POINTS[0][1]},${DIAG_POINTS[0][2]}:${DIAG_POINTS[2][1]},${DIAG_POINTS[2][2]}/json`, {
      traffic: 'true',
      computeTravelTimeFor: 'all',
      routeType: 'fastest',
      travelMode: 'car',
      maxAlternatives: 2,
      sectionType: 'traffic',
    });
    if (r.ok) {
      const routes = trimRoutes(await r.json());
      out.route = routes.map(({ coords, ...rest }) => ({ ...rest, points: coords.length }));
      // Отрезки вдоль основного маршрута — каждые ~1/6 пути (трасса между городами).
      const c = routes[0]?.coords || [];
      for (let k = 1; k <= 5; k++) {
        const p = c[Math.floor((c.length * k) / 6)];
        if (p) out.alongRoute.push(await flow(`Трасса Павлоград → Днепр, ${k}/6 пути`, p[1], p[0]));
      }
    } else out.route = { status: r.status };
  }

  // Происшествия в Днепре (описания v5).
  if (await spend(env, 'incidents', ctx)) {
    const r = await upstream(env, `/traffic/services/5/incidentDetails`, {
      bbox: '34.90,48.38,35.20,48.55',
      fields: '{incidents{type,geometry{type},properties{iconCategory,magnitudeOfDelay,events{description,code},startTime,endTime,from,to,length,delay,roadNumbers}}}',
      language: 'ru-RU',
      timeValidityFilter: 'present',
    });
    if (r.ok) {
      const d = await r.json();
      const list = d.incidents || [];
      out.incidents = { status: 200, count: list.length, sample: list.slice(0, 5).map((i) => ({ category: i.properties?.iconCategory, delay: i.properties?.delay, from: i.properties?.from, to: i.properties?.to, events: (i.properties?.events || []).map((e) => e.description).slice(0, 2) })) };
    } else out.incidents = { status: r.status };
  }

  // Тайлы потока: Днепр и Павлоград, z12 — пустой тайл весит сотни байт, с дорогами — килобайты.
  const tile = (lat, lon, z) => {
    const n = 2 ** z;
    const x = Math.floor(((lon + 180) / 360) * n);
    const y = Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
    return [z, x, y];
  };
  for (const [name, lat, lon] of [DIAG_POINTS[0], DIAG_POINTS[2]]) {
    const [z, x, y] = tile(lat, lon, 12);
    if (!(await spend(env, 'tiles', ctx))) break;
    const r = await upstream(env, `/traffic/map/4/tile/flow/relative0/${z}/${x}/${y}.png`, { tileSize: 512 });
    out.tiles.push({ name, z, x, y, status: r.status, bytes: r.ok ? (await r.arrayBuffer()).byteLength : 0 });
  }
  return json(200, out, h);
}
