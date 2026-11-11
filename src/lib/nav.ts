import { createStore, uid } from './store';
import {
  fetchRoutes,
  RouteError,
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
import { L } from './i18n';
import { searchPlaces as geoSearch, reverseGeocode, coordsPlace, type Place } from './geo/geocode';

export type { Place };

/* ---------- Геопозиция ---------- */

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
/** «Дом» и «Работа» — для команд «едем домой», «на работу» и кнопок в одно касание. */
export const savedPlacesStore = createStore<{ home: Place | null; work: Place | null }>({ home: null, work: null }, 'saved-places');

export function setSavedPlace(kind: 'home' | 'work', place: Place | null) {
  savedPlacesStore.set((s) => ({ ...s, [kind]: place ? { ...place, id: `${kind}:${place.lat},${place.lon}` } : null }));
}

/* ---------- Короткие фразы для озвучивания ---------- */

const plural = (n: number, one: string, few: string, many: string) => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
};

/** «6 минут», «1 час 20 минут», «2 години 5 хвилин» — полными словами, чтобы синтез речи читал естественно. */
export function spokenDuration(sec: number, lang: Lang = navLang()) {
  const total = Math.max(1, Math.round(sec / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  const uk = lang === 'uk';
  const hs = h ? `${h} ${uk ? plural(h, 'година', 'години', 'годин') : plural(h, 'час', 'часа', 'часов')}` : '';
  const ms = m ? `${m} ${uk ? plural(m, 'хвилина', 'хвилини', 'хвилин') : plural(m, 'минута', 'минуты', 'минут')}` : '';
  return [hs, ms].filter(Boolean).join(' ');
}

const clock = (sec: number) => new Date(Date.now() + sec * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

/** Состояние маршрута одной-двумя фразами: «Осталось 12 км, 15 минут, прибытие в 14:30. Через 300 м поверните направо.» */
export function routeSummary(): string {
  const s = navStore.get();
  const lang = navLang();
  if (!s.dest) return L('Маршрута нет.', 'Маршруту немає.');
  if (s.status === 'routing') return L('Строю маршрут.', 'Будую маршрут.');
  if (!s.route) return s.error ?? L(`Маршрут до «${s.dest.name}» не построен.`, `Маршрут до «${s.dest.name}» не побудовано.`);
  if (s.status === 'arrived') return L('Вы на месте.', 'Ви на місці.');
  const remainM = s.progress?.remainingM ?? s.route.distance;
  const remainS = s.route.duration * (remainM / Math.max(1, s.route.distance));
  const head = L(
    `Осталось ${fmtDistance(remainM)}, ${spokenDuration(remainS, lang)}, прибытие в ${clock(remainS)}.`,
    `Залишилось ${fmtDistance(remainM, 'uk')}, ${spokenDuration(remainS, lang)}, прибуття о ${clock(remainS)}.`,
  );
  const p = s.progress;
  const step = p ? s.route.steps[p.stepIndex] : null;
  if (s.status === 'guiding' && step && p) return `${head} ${L('Через', 'Через')} ${fmtDistance(p.toStepM, lang)} ${stepText(step, lang)}.`;
  return s.status === 'preview' ? `${head} ${L('Скажите «поехали», чтобы начать.', 'Скажіть «поїхали», щоб почати.')}` : head;
}

let watchId: number | null = null;
let lastFix: LatLon | null = null;

/** Направление движения (°) между двумя точками. */
export function bearing(a: LatLon, b: LatLon) {
  const r = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r);
  return ((Math.atan2(y, x) / r) + 360) % 360;
}

/** Точка GPS с точностью хуже этой не используется для перестроения и «прибыли». */
export const MAX_GUIDANCE_ACCURACY = 100;

export function startGeo() {
  if (watchId != null) return;
  if (!('geolocation' in navigator)) {
    geoStore.set((s) => ({ ...s, status: 'unavailable' }));
    return;
  }
  watchId = navigator.geolocation.watchPosition(
    (p) => {
      const speed = p.coords.speed != null && p.coords.speed >= 0 ? p.coords.speed * 3.6 : null;
      const pos = { lat: p.coords.latitude, lon: p.coords.longitude };
      let heading = p.coords.heading != null && !Number.isNaN(p.coords.heading) ? p.coords.heading : null;
      // Safari часто не даёт heading — считаем по смещению, если сдвинулись заметно больше погрешности.
      const movedEnough = !lastFix || haversine(lastFix, pos) > Math.max(8, p.coords.accuracy * 0.5);
      if (heading == null && lastFix) heading = movedEnough ? bearing(lastFix, pos) : geoStore.get().heading;
      if (movedEnough) lastFix = pos;
      geoStore.set({
        status: 'watching',
        lat: p.coords.latitude,
        lon: p.coords.longitude,
        accuracy: p.coords.accuracy,
        speedKmh: speed,
        heading,
        updated: Date.now(),
      });
      recordFix({ lat: p.coords.latitude, lon: p.coords.longitude }, p.coords.accuracy, speed, Date.now());
      onPosition(pos, p.coords.accuracy);
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

export function searchPlaces(query: string, near?: LatLon, signal?: AbortSignal): Promise<Place[]> {
  return geoSearch(query, { near, lang: navLang(), signal });
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
  /** Все варианты от сервиса маршрутов (основной + альтернативы); route = routes[routeIndex]. */
  routes: Route[];
  routeIndex: number;
  status: 'idle' | 'routing' | 'preview' | 'guiding' | 'arrived';
  error: string | null;
  progress: Progress | null;
  rerouting: boolean;
  /** Сообщение во время ведения (нет сети для перестроения и т. п.). */
  notice: string | null;
}

const emptyNav = (): NavState => ({ dest: null, via: null, route: null, routes: [], routeIndex: 0, status: 'idle', error: null, progress: null, rerouting: false, notice: null });
export const navStore = createStore<NavState>(emptyNav());

let routeCache: { cum: number[]; offsets: number[] } | null = null;
let routeAbort: AbortController | null = null;
let lastReroute = 0;
let offRouteCount = 0;
let pendingReroute = false;
const announced = new Set<string>();

export function navLang(): Lang {
  const l = settingsStore.get().speechLang.slice(0, 2);
  return l === 'uk' || l === 'en' ? l : 'ru';
}

function setRoute(route: Route) {
  routeCache = { cum: cumulative(route.coords), offsets: stepOffsets(route) };
  announced.clear();
}

async function buildRoutes(from: LatLon, dest: Place, via?: Place | null) {
  routeAbort?.abort();
  routeAbort = new AbortController();
  const routes = await fetchRoutes(from, dest, { signal: routeAbort.signal, via: via ?? undefined });
  setRoute(routes[0]);
  return routes;
}

function routeErrorText(e: unknown) {
  if (e instanceof RouteError) return e.message;
  return navigator.onLine ? (e as Error).message : 'Нет интернета — маршрут построить нельзя';
}

/** Выбрать пункт назначения и построить маршрут (предпросмотр). */
export async function setDestination(dest: Place, via: Place | null = null, keepStatus = false) {
  if (!via) addRecent(dest);
  poiStore.set(emptyPoi());
  const prevStatus = navStore.get().status;
  pickStore.set(null);
  const base = { dest, via, progress: null, rerouting: false, notice: null, routeIndex: 0 };
  const from = currentPos();
  if (!from) {
    navStore.set({ ...base, route: null, routes: [], status: 'preview', error: 'Нет геопозиции — маршрут построить нельзя. Разрешите геолокацию или откройте маршрут во внешнем навигаторе.' });
    return;
  }
  navStore.set({ ...base, route: null, routes: [], status: 'routing', error: null });
  try {
    const routes = await buildRoutes(from, dest, via);
    if (navStore.get().dest !== dest) return;
    const status = keepStatus && prevStatus === 'guiding' ? 'guiding' : 'preview';
    navStore.set({ ...base, route: routes[0], routes, status, error: null, progress: routeProgress(routes[0], from, routeCache!) });
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    navStore.set({ ...base, route: null, routes: [], status: 'preview', error: routeErrorText(e) });
  }
}

/** Выбрать один из вариантов маршрута (до начала ведения). */
export function selectRoute(i: number) {
  const s = navStore.get();
  const route = s.routes[i];
  if (!route || s.status === 'guiding') return;
  setRoute(route);
  const pos = currentPos();
  navStore.set({ ...s, route, routeIndex: i, progress: pos ? routeProgress(route, pos, routeCache!) : null });
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
  // Во время ведения варианты не нужны: остаётся выбранный.
  navStore.set({ ...s, status: 'guiding', routes: [s.route], routeIndex: 0, notice: null });
  offRouteCount = 0;
  const pos = currentPos();
  if (pos) onPosition(pos);
  const p = navStore.get().progress;
  if (p) say(`${stepText(s.route.steps[p.stepIndex], navLang())}, ${t('through')} ${fmtDistance(p.toStepM, navLang())}`);
}

export function stopNavigation() {
  routeAbort?.abort();
  routeCache = null;
  pendingReroute = false;
  navStore.set(emptyNav());
  poiStore.set(emptyPoi());
}

const PHRASES: Record<Lang, Record<string, string>> = {
  ru: { through: 'через', now: 'сейчас', reroute: 'Перестраиваю маршрут', arrived: 'Вы прибыли в пункт назначения', offline: 'Нет интернета, маршрут не перестроить' },
  uk: { through: 'через', now: 'зараз', reroute: 'Перебудовую маршрут', arrived: 'Ви прибули до пункту призначення', offline: 'Немає інтернету, маршрут не перебудувати' },
  en: { through: 'in', now: 'now', reroute: 'Rerouting', arrived: 'You have arrived at your destination', offline: 'No internet, cannot reroute' },
};
const t = (k: string) => PHRASES[navLang()][k];

function say(text: string) {
  const s = settingsStore.get();
  if (s.speakNavigation) speak(text, s.speechLang);
}

/** Перестроить маршрут от текущей точки (сход с маршрута или возврат сети). */
function reroute(pos: LatLon) {
  const s = navStore.get();
  if (!s.dest) return;
  lastReroute = Date.now();
  offRouteCount = 0;
  if (navigator.onLine === false) {
    if (!pendingReroute) say(t('offline'));
    pendingReroute = true;
    navStore.set({ ...s, notice: 'Нет интернета: вы ушли с маршрута, перестрою, когда появится связь' });
    return;
  }
  pendingReroute = false;
  say(t('reroute'));
  navStore.set({ ...s, rerouting: true, notice: null });
  buildRoutes(pos, s.dest, s.via)
    .then((routes) => {
      const cur = navStore.get();
      if (cur.dest !== s.dest) return;
      navStore.set({ ...cur, route: routes[0], routes: [routes[0]], routeIndex: 0, rerouting: false, notice: null, progress: routeProgress(routes[0], pos, routeCache!) });
    })
    .catch((e) => {
      if ((e as Error).name === 'AbortError') return;
      if (!navigator.onLine) pendingReroute = true;
      navStore.set({ ...navStore.get(), rerouting: false, notice: `${routeErrorText(e)} Повторю попытку.` });
    });
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    const s = navStore.get();
    const pos = currentPos();
    if (pendingReroute && s.status === 'guiding' && pos) reroute(pos);
    else if (s.notice) navStore.set({ ...s, notice: null });
  });
}

function onPosition(pos: LatLon, accuracy = 20) {
  const s = navStore.get();
  if (!s.route || !routeCache || (s.status !== 'guiding' && s.status !== 'preview')) return;
  const p = routeProgress(s.route, pos, routeCache, s.progress?.segIndex ?? 0);
  navStore.set({ ...s, progress: p });
  if (s.status !== 'guiding') return;
  // Грубая точка (вышки сотовой связи, туннель) не должна вызывать перестроение или «прибыли».
  if (accuracy > MAX_GUIDANCE_ACCURACY) return;

  if (p.remainingM < 30) {
    navStore.set({ ...navStore.get(), status: 'arrived' });
    say(t('arrived'));
    return;
  }

  // Сход с маршрута: 3 точки подряд дальше 60 м (с учётом точности GPS) → перестроение.
  offRouteCount = p.offRouteM > Math.max(60, accuracy * 1.5) ? offRouteCount + 1 : 0;
  if (offRouteCount >= 3 && Date.now() - lastReroute > (pendingReroute ? 30000 : 15000) && s.dest && !s.rerouting) {
    reroute(pos);
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

/* ---------- Выбор точки на карте (долгое нажатие, правый клик, результат поиска) ---------- */

export interface PickState {
  lat: number;
  lon: number;
  /** Адрес (обратное геокодирование) или результат поиска; null — пока неизвестен. */
  place: Place | null;
  loading: boolean;
  /** Адрес определить не удалось — показываем координаты. */
  failed: boolean;
  origin: 'map' | 'search';
}

export const pickStore = createStore<PickState | null>(null);
let pickAbort: AbortController | null = null;

/** Показать точку на карте с карточкой «Маршрут сюда / Добавить остановку / Отмена». */
export async function pickPoint(pt: LatLon, origin: PickState['origin'] = 'map', place?: Place) {
  pickAbort?.abort();
  if (place) {
    pickStore.set({ lat: place.lat, lon: place.lon, place, loading: false, failed: false, origin });
    return;
  }
  pickAbort = new AbortController();
  const signal = pickAbort.signal;
  pickStore.set({ lat: pt.lat, lon: pt.lon, place: null, loading: true, failed: false, origin });
  try {
    const found = await reverseGeocode(pt, { lang: navLang(), signal });
    if (signal.aborted) return;
    pickStore.set({ lat: pt.lat, lon: pt.lon, place: found, loading: false, failed: !found, origin });
  } catch (e) {
    if (signal.aborted) return;
    void e;
    pickStore.set({ lat: pt.lat, lon: pt.lon, place: null, loading: false, failed: true, origin });
  }
}

export function cancelPick() {
  pickAbort?.abort();
  pickStore.set(null);
}

function pickedPlace(): Place | null {
  const p = pickStore.get();
  if (!p) return null;
  return p.place ?? coordsPlace(p);
}

/** «Маршрут сюда». */
export function routeToPick() {
  const place = pickedPlace();
  if (!place) return;
  pickAbort?.abort();
  pickStore.set(null);
  return setDestination(place);
}

/** «Добавить остановку» — заезд по пути к текущей цели. */
export function addPickAsStop() {
  const place = pickedPlace();
  if (!place) return;
  pickAbort?.abort();
  pickStore.set(null);
  return addStop(place);
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
const HOME_WORDS = /^(дом|дім|домой|додому|home)$/;
const WORK_WORDS = /^(работа|робота|на работу|на роботу|work)$/;

/** Место без поиска: «дом», «работа», избранное или недавнее с таким названием. */
export function knownPlace(query: string): Place | null | 'home-missing' | 'work-missing' {
  const q = query.trim().toLowerCase().replace(/ё/g, 'е');
  const saved = savedPlacesStore.get();
  if (HOME_WORDS.test(q)) return saved.home ?? 'home-missing';
  if (WORK_WORDS.test(q)) return saved.work ?? 'work-missing';
  const norm = (n: string) => n.toLowerCase().replace(/ё/g, 'е');
  // Падежи («до ашана», «в макдональдс»): совпадение по основе слова.
  const stem = q.length > 4 ? q.slice(0, -1) : q;
  return [...favoritesStore.get(), ...recentsStore.get()].find((p) => norm(p.name) === q || (stem.length > 3 && norm(p.name).startsWith(stem))) ?? null;
}

export async function navigateToQuery(query: string): Promise<{ ok: boolean; text: string }> {
  try {
    const known = knownPlace(query);
    if (known === 'home-missing' || known === 'work-missing') {
      const home = known === 'home-missing';
      return {
        ok: false,
        text: home
          ? L('Адрес дома не сохранён. Постройте маршрут к дому и нажмите «Сделать домом» в карточке маршрута.', 'Адресу дому не збережено. Побудуйте маршрут до дому й натисніть «Зробити домом» у картці маршруту.')
          : L('Адрес работы не сохранён. Постройте маршрут к работе и нажмите «Сделать работой» в карточке маршрута.', 'Адресу роботи не збережено. Побудуйте маршрут до роботи й натисніть «Зробити роботою» у картці маршруту.'),
      };
    }
    const target = known ?? (await searchPlaces(query, currentPos() ?? undefined))[0];
    if (!target) return { ok: false, text: L(`Не нашёл «${query}».`, `Не знайшов «${query}».`) };
    await setDestination(target);
    const s = navStore.get();
    if (s.route) {
      const lang = navLang();
      const alt = s.routes.length > 1 ? L(' Есть другой вариант.', ' Є інший варіант.') : '';
      return {
        ok: true,
        text: L(
          `Маршрут до «${target.name}»: ${fmtDistance(s.route.distance)}, ${spokenDuration(s.route.duration, lang)}.${alt}`,
          `Маршрут до «${target.name}»: ${fmtDistance(s.route.distance, 'uk')}, ${spokenDuration(s.route.duration, lang)}.${alt}`,
        ),
      };
    }
    return { ok: true, text: `${L('Нашёл', 'Знайшов')} «${target.name}». ${s.error ?? ''}`.trim() };
  } catch (e) {
    return { ok: false, text: navigator.onLine ? (e as Error).message : L('Нет интернета для поиска адреса.', 'Немає інтернету для пошуку адреси.') };
  }
}

/* ---------- Сохранение маршрута между запусками ----------
   iPadOS может выгрузить веб-приложение из памяти, пока открыт YouTube Music или ChatGPT.
   Цель, промежуточная точка и режим ведения сохраняются; маршрут перестраивается при возвращении. */

const NAV_KEY = 'ace:nav-session';
const NAV_TTL = 6 * 3600 * 1000;
let lastSaved = '';

export interface NavSession {
  dest: Place;
  via: Place | null;
  guiding: boolean;
  at: number;
}

navStore.subscribe(() => {
  const s = navStore.get();
  // Пишем только при смене цели/остановки/режима, а не на каждую точку GPS.
  const key = s.dest ? JSON.stringify([s.dest, s.via, s.status === 'guiding']) : '';
  if (key === lastSaved || s.status === 'routing') return;
  lastSaved = key;
  try {
    if (!s.dest || s.status === 'arrived') localStorage.removeItem(NAV_KEY);
    else localStorage.setItem(NAV_KEY, JSON.stringify({ dest: s.dest, via: s.via, guiding: s.status === 'guiding', at: Date.now() } satisfies NavSession));
  } catch {
    /* хранилище недоступно */
  }
});

export function readNavSession(now = Date.now()): NavSession | null {
  try {
    const raw = localStorage.getItem(NAV_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as NavSession;
    return s.dest && now - s.at < NAV_TTL ? s : null;
  } catch {
    return null;
  }
}

/** Восстановить маршрут после перезапуска (ждём первую точку GPS до 30 с). */
export function restoreNavSession() {
  const saved = readNavSession();
  if (!saved || navStore.get().dest) return;
  const go = async () => {
    await setDestination(saved.dest, saved.via);
    if (saved.guiding && navStore.get().route) startGuidance();
  };
  if (currentPos()) return void go();
  let done = false;
  const unsub = geoStore.subscribe(() => {
    if (!done && currentPos()) {
      done = true;
      unsub();
      void go();
    }
  });
  setTimeout(() => {
    if (!done) {
      done = true;
      unsub();
      void go();
    }
  }, 30000);
}
