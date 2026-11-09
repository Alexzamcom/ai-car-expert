import { createStore, uid } from './store';
import {
  fetchRoute,
  routeProgress,
  cumulative,
  stepOffsets,
  stepText,
  fmtDistance,
  haversine,
  type Route,
  type LatLon,
  type Lang,
  type Progress,
} from './routing';
import { poiAlongRoute, poiNearby, type Poi, type PoiCategory } from './poi';
import { settingsStore } from './state';
import { speak } from './speech';
import { recordFix } from './trip';

/* ---------- Геопозиция ---------- */

export interface Place {
  id: string;
  name: string;
  address: string;
  lat: number;
  lon: number;
}

export interface GeoState {
  status: 'idle' | 'watching' | 'denied' | 'unavailable';
  lat: number | null;
  lon: number | null;
  accuracy: number | null;
  speedKmh: number | null;
  heading: number | null;
  updated: number | null;
}

export const geoStore = createStore<GeoState>({
  status: 'idle',
  lat: null,
  lon: null,
  accuracy: null,
  speedKmh: null,
  heading: null,
  updated: null,
});

/** Запрос из голоса/помощника: найти место и построить маршрут. */
export const navQueryStore = createStore<{ query: string; nonce: number } | null>(null);

export const favoritesStore = createStore<Place[]>([], 'favorites');
export const recentsStore = createStore<Place[]>([], 'recents');

let watchId: number | null = null;

export function startGeo() {
  if (watchId != null) return;
  if (!('geolocation' in navigator)) {
    geoStore.set((s) => ({ ...s, status: 'unavailable' }));
    return;
  }
  watchId = navigator.geolocation.watchPosition(
    (p) => {
      const speed = p.coords.speed != null && p.coords.speed >= 0 ? p.coords.speed * 3.6 : null;
      geoStore.set({
        status: 'watching',
        lat: p.coords.latitude,
        lon: p.coords.longitude,
        accuracy: p.coords.accuracy,
        speedKmh: speed,
        heading: p.coords.heading != null && !Number.isNaN(p.coords.heading) ? p.coords.heading : null,
        updated: Date.now(),
      });
      recordFix({ lat: p.coords.latitude, lon: p.coords.longitude }, p.coords.accuracy, speed, Date.now());
      onPosition({ lat: p.coords.latitude, lon: p.coords.longitude });
    },
    (err) => {
      geoStore.set((s) => ({ ...s, status: err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable' }));
      if (err.code === err.PERMISSION_DENIED && watchId != null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
  );
}

export function currentPos(): LatLon | null {
  const g = geoStore.get();
  return g.lat != null && g.lon != null ? { lat: g.lat, lon: g.lon } : null;
}

/** Подсказка, где разрешить геолокацию — зависит от платформы. */
export function geoHelp(): string {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) {
    return 'Настройки → Конфиденциальность и безопасность → Службы геолокации → включите их и для «Сайты Safari» выберите «При использовании».';
  }
  if (/Android/.test(ua)) return 'Нажмите на значок слева от адреса → Разрешения → Местоположение → Разрешить.';
  return 'Разрешите доступ к местоположению в настройках браузера для этого сайта.';
}

/* ---------- Поиск мест ---------- */

export async function searchPlaces(query: string, near?: LatLon): Promise<Place[]> {
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: '8',
    'accept-language': 'ru,uk,en',
    addressdetails: '0',
  });
  if (near) {
    const d = 1.5;
    params.set('viewbox', `${near.lon - d},${near.lat + d},${near.lon + d},${near.lat - d}`);
  }
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
  if (!res.ok) throw new Error(`Поиск адресов недоступен (${res.status})`);
  const data = (await res.json()) as { place_id: number; name?: string; display_name: string; lat: string; lon: string }[];
  return data.map((r) => {
    const [first, ...rest] = r.display_name.split(', ');
    return {
      id: String(r.place_id),
      name: r.name || first,
      address: (r.name ? r.display_name : rest.join(', ')).split(', ').slice(0, 4).join(', '),
      lat: Number(r.lat),
      lon: Number(r.lon),
    };
  });
}

export function addRecent(p: Place) {
  recentsStore.set((l) => [p, ...l.filter((x) => x.lat !== p.lat || x.lon !== p.lon)].slice(0, 8));
}

export function toggleFavorite(p: Place) {
  favoritesStore.set((l) =>
    l.some((x) => x.lat === p.lat && x.lon === p.lon)
      ? l.filter((x) => x.lat !== p.lat || x.lon !== p.lon)
      : [...l, { ...p, id: uid() }],
  );
}

export function routeLinks(p: LatLon & { name?: string }) {
  const ll = `${p.lat},${p.lon}`;
  return [
    { id: 'apple', label: 'Apple Карты', href: `https://maps.apple.com/?daddr=${ll}&dirflg=d` },
    { id: 'google', label: 'Google Maps', href: `https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=driving` },
    { id: 'yandexnavi', label: 'Яндекс Навигатор', href: `yandexnavi://build_route_on_map?lat_to=${p.lat}&lon_to=${p.lon}` },
    { id: 'yandex', label: 'Яндекс Карты', href: `https://yandex.ru/maps/?rtext=~${ll}&rtt=auto` },
    { id: 'waze', label: 'Waze', href: `https://waze.com/ul?ll=${ll}&navigate=yes` },
  ];
}

/* ---------- Маршрут и ведение ---------- */

export interface NavState {
  dest: Place | null;
  /** Промежуточная остановка (например, АЗС по пути). */
  via: Place | null;
  route: Route | null;
  status: 'idle' | 'routing' | 'preview' | 'guiding' | 'arrived';
  error: string | null;
  progress: Progress | null;
  rerouting: boolean;
}

export const navStore = createStore<NavState>({ dest: null, via: null, route: null, status: 'idle', error: null, progress: null, rerouting: false });

let routeCache: { cum: number[]; offsets: number[] } | null = null;
let routeAbort: AbortController | null = null;
let lastReroute = 0;
let offRouteCount = 0;
const announced = new Set<string>();

export function navLang(): Lang {
  const l = settingsStore.get().speechLang.slice(0, 2);
  return l === 'uk' || l === 'en' ? l : 'ru';
}

function setRoute(route: Route) {
  routeCache = { cum: cumulative(route.coords), offsets: stepOffsets(route) };
  announced.clear();
}

async function buildRoute(from: LatLon, dest: Place, via?: Place | null) {
  routeAbort?.abort();
  routeAbort = new AbortController();
  const route = await fetchRoute(from, dest, routeAbort.signal, via ?? undefined);
  setRoute(route);
  return route;
}

/** Выбрать пункт назначения и построить маршрут (предпросмотр). */
export async function setDestination(dest: Place, via: Place | null = null, keepStatus = false) {
  if (!via) addRecent(dest);
  poiStore.set(emptyPoi());
  const prevStatus = navStore.get().status;
  const base = { dest, via, progress: null, rerouting: false };
  const from = currentPos();
  if (!from) {
    navStore.set({ ...base, route: null, status: 'preview', error: 'Нет геопозиции — маршрут построить нельзя. Можно открыть его во внешнем навигаторе.' });
    return;
  }
  navStore.set({ ...base, route: null, status: 'routing', error: null });
  try {
    const route = await buildRoute(from, dest, via);
    if (navStore.get().dest !== dest) return;
    const status = keepStatus && prevStatus === 'guiding' ? 'guiding' : 'preview';
    navStore.set({ ...base, route, status, error: null, progress: routeProgress(route, from, routeCache!) });
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    navStore.set({
      ...base,
      route: null,
      status: 'preview',
      error: navigator.onLine ? (e as Error).message : 'Нет интернета — маршрут построить нельзя',
    });
  }
}

/** Заехать по пути (АЗС, кафе) и продолжить к цели. */
export function addStop(stop: Place) {
  const s = navStore.get();
  if (!s.dest) return setDestination(stop);
  return setDestination(s.dest, stop, true);
}

export function removeStop() {
  const s = navStore.get();
  if (s.dest) return setDestination(s.dest, null, true);
}

export function startGuidance() {
  const s = navStore.get();
  if (!s.route) return;
  navStore.set({ ...s, status: 'guiding' });
  offRouteCount = 0;
  const pos = currentPos();
  if (pos) onPosition(pos);
  const p = navStore.get().progress;
  if (p) say(`${stepText(s.route.steps[p.stepIndex], navLang())}, ${t('through')} ${fmtDistance(p.toStepM, navLang())}`);
}

export function stopNavigation() {
  routeAbort?.abort();
  routeCache = null;
  navStore.set({ dest: null, via: null, route: null, status: 'idle', error: null, progress: null, rerouting: false });
  poiStore.set(emptyPoi());
}

const PHRASES: Record<Lang, Record<string, string>> = {
  ru: { through: 'через', now: 'сейчас', reroute: 'Перестраиваю маршрут', arrived: 'Вы прибыли в пункт назначения' },
  uk: { through: 'через', now: 'зараз', reroute: 'Перебудовую маршрут', arrived: 'Ви прибули до пункту призначення' },
  en: { through: 'in', now: 'now', reroute: 'Rerouting', arrived: 'You have arrived at your destination' },
};
const t = (k: string) => PHRASES[navLang()][k];

function say(text: string) {
  const s = settingsStore.get();
  if (s.speakNavigation) speak(text, s.speechLang);
}

function onPosition(pos: LatLon) {
  const s = navStore.get();
  if (!s.route || !routeCache || (s.status !== 'guiding' && s.status !== 'preview')) return;
  const p = routeProgress(s.route, pos, routeCache, s.progress?.segIndex ?? 0);
  navStore.set({ ...s, progress: p });
  if (s.status !== 'guiding') return;

  if (p.remainingM < 30) {
    navStore.set({ ...navStore.get(), status: 'arrived' });
    say(t('arrived'));
    return;
  }

  // Сход с маршрута: 3 точки подряд дальше 60 м (с учётом точности GPS) → перестроение.
  const acc = geoStore.get().accuracy ?? 20;
  offRouteCount = p.offRouteM > Math.max(60, acc * 1.5) ? offRouteCount + 1 : 0;
  if (offRouteCount >= 3 && Date.now() - lastReroute > 15000 && s.dest) {
    lastReroute = Date.now();
    offRouteCount = 0;
    say(t('reroute'));
    navStore.set({ ...navStore.get(), rerouting: true });
    buildRoute(pos, s.dest, s.via)
      .then((route) => navStore.set({ ...navStore.get(), route, rerouting: false, progress: routeProgress(route, pos, routeCache!) }))
      .catch(() => navStore.set({ ...navStore.get(), rerouting: false }));
    return;
  }

  // Промежуточная точка пройдена — дальше считаем маршрут без неё.
  if (s.via && haversine(pos, s.via) < 60) {
    navStore.set({ ...navStore.get(), via: null });
  }

  // Голосовые подсказки перед манёвром: ~600 м, ~200 м и в момент манёвра.
  const step = s.route.steps[p.stepIndex];
  if (!step) return;
  const lang = navLang();
  const thresholds: [string, number][] = [
    ['far', 600],
    ['near', 200],
    ['now', 40],
  ];
  for (const [key, m] of thresholds) {
    const id = `${p.stepIndex}:${key}`;
    if (p.toStepM <= m && !announced.has(id)) {
      // Помечаем все более дальние пороги, чтобы не говорить их задним числом.
      thresholds.forEach(([k, mm]) => mm >= m && announced.add(`${p.stepIndex}:${k}`));
      if (key === 'far' && step.distance < 800 && p.toStepM < 400) break;
      say(key === 'now' ? `${t('now')} ${stepText(step, lang)}` : `${t('through')} ${fmtDistance(p.toStepM, lang)} ${stepText(step, lang)}`);
      break;
    }
  }
}

/* ---------- Объекты по пути ---------- */

export interface PoiState {
  category: PoiCategory | null;
  items: Poi[];
  loading: boolean;
  error: string | null;
  mode: 'route' | 'nearby';
}

const emptyPoi = (): PoiState => ({ category: null, items: [], loading: false, error: null, mode: 'nearby' });
export const poiStore = createStore<PoiState>(emptyPoi());
let poiAbort: AbortController | null = null;

export async function findPoi(category: PoiCategory) {
  poiAbort?.abort();
  poiAbort = new AbortController();
  const nav = navStore.get();
  const pos = currentPos();
  const mode: PoiState['mode'] = nav.route ? 'route' : 'nearby';
  poiStore.set({ category, items: [], loading: true, error: null, mode });
  try {
    let items: Poi[];
    if (nav.route) items = await poiAlongRoute(nav.route, category, nav.route.distance - (nav.progress?.remainingM ?? nav.route.distance), poiAbort.signal);
    else if (pos) items = await poiNearby(pos, category, poiAbort.signal);
    else throw new Error('Нет геопозиции и маршрута — искать негде');
    poiStore.set({ category, items, loading: false, error: items.length ? null : 'Ничего не найдено', mode });
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    poiStore.set({ category, items: [], loading: false, error: navigator.onLine ? (e as Error).message : 'Нет интернета', mode });
  }
}

export function clearPoi() {
  poiAbort?.abort();
  poiStore.set(emptyPoi());
}

export function placeFromPoi(p: Poi): Place {
  return { id: p.id, name: p.name, address: p.brand && p.brand !== p.name ? p.brand : '', lat: p.lat, lon: p.lon };
}

/** Найти место по тексту и сразу построить маршрут (голос, Grok). */
export async function navigateToQuery(query: string): Promise<{ ok: boolean; text: string }> {
  try {
    const results = await searchPlaces(query, currentPos() ?? undefined);
    if (!results.length) return { ok: false, text: `Не нашёл «${query}».` };
    await setDestination(results[0]);
    const s = navStore.get();
    if (s.route) {
      return { ok: true, text: `Маршрут до «${results[0].name}»: ${fmtDistance(s.route.distance)}, около ${Math.round(s.route.duration / 60)} мин без учёта пробок.` };
    }
    return { ok: true, text: `Нашёл «${results[0].name}». ${s.error ?? ''}`.trim() };
  } catch (e) {
    return { ok: false, text: navigator.onLine ? (e as Error).message : 'Нет интернета для поиска адреса.' };
  }
}
