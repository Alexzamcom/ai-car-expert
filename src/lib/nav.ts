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
import { settingsStore, setMinimal, driveUiStore } from './state';
import { speak, stopSpeaking } from './speech';
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
  /** Точность показанной позиции: precise ≤ 30 м, approx ≤ 200 м, coarse — хуже (Wi-Fi/вышки, «приблизительная геопозиция» iOS). */
  quality: GeoQuality | null;
  /** Последний фикс отброшен (устаревший, грубый или скачок) — на карте остаётся прежняя точная позиция. */
  held: 'stale' | 'coarse' | 'jump' | null;
  /** Время получения фикса устройством (coords timestamp). */
  fixAt: number | null;
}

export type GeoQuality = 'precise' | 'approx' | 'coarse';

export const geoStore = createStore<GeoState>({
  status: 'idle',
  lat: null,
  lon: null,
  accuracy: null,
  speedKmh: null,
  heading: null,
  updated: null,
  quality: null,
  held: null,
  fixAt: null,
});

/* ---------- Фильтр точек GPS (чистые функции, покрыты тестами) ---------- */

export interface RawFix {
  lat: number;
  lon: number;
  accuracy: number;
  /** м/с; null или < 0 — неизвестно */
  speed: number | null;
  /** градусы; null/NaN — неизвестно */
  heading: number | null;
  /** coords timestamp, мс */
  timestamp: number;
}

export function classifyAccuracy(acc: number): GeoQuality {
  return acc <= 30 ? 'precise' : acc <= 200 ? 'approx' : 'coarse';
}

/** Точка старше этого — кешированная (iOS отдаёт её после пробуждения или возврата в приложение). */
export const STALE_FIX_MS = 30_000;

/**
 * Принять ли новую точку. Не двигаем машинку:
 * - по устаревшей точке, если уже есть свежая;
 * - по грубой точке (Wi-Fi, вышки), если недавно была точная;
 * - по скачку, который невозможен для автомобиля (> 250 км/ч) с учётом погрешностей.
 */
export function acceptFix(prev: (RawFix & { at: number }) | null, fix: RawFix, now: number): 'accept' | 'stale' | 'coarse' | 'jump' {
  if (now - fix.timestamp > STALE_FIX_MS && prev) return 'stale';
  if (!prev) return 'accept';
  if (fix.timestamp < prev.timestamp) return 'stale';
  const prevFresh = now - prev.at < 30_000;
  if (prevFresh && prev.accuracy <= 100 && fix.accuracy > Math.max(3 * prev.accuracy, 250)) return 'coarse';
  const dt = Math.max(1, (fix.timestamp - prev.timestamp) / 1000);
  const d = haversine(prev, fix);
  if (prevFresh && d > 70 * dt + prev.accuracy + fix.accuracy + 50) return 'jump';
  return 'accept';
}

/**
 * Курс для машинки. Без движения или при плохой точности — прежний (никакого хаотичного вращения).
 * Источник: курс устройства при скорости ≥ 2 м/с или направление смещения, если сдвинулись заметно больше погрешности.
 */
export function nextHeading(prevHeading: number | null, from: RawFix | null, fix: RawFix): number | null {
  const speed = fix.speed != null && fix.speed >= 0 ? fix.speed : null;
  let raw: number | null = null;
  if (fix.heading != null && !Number.isNaN(fix.heading) && fix.heading >= 0 && (speed ?? 0) >= 2 && fix.accuracy <= 50) raw = fix.heading;
  else if (from && fix.accuracy <= 50) {
    const d = haversine(from, fix);
    const dt = Math.max(0.5, (fix.timestamp - from.timestamp) / 1000);
    if (d >= Math.max(15, 1.5 * fix.accuracy) && (speed ?? d / dt) >= 2) raw = bearing(from, fix);
  }
  if (raw == null) return prevHeading;
  if (prevHeading == null) return raw;
  // Сглаживание по кратчайшей дуге: резкий разворот принимаем, мелкий шум — гасим.
  const delta = ((raw - prevHeading + 540) % 360) - 180;
  const k = Math.abs(delta) > 60 ? 0.8 : 0.5;
  return (prevHeading + k * delta + 360) % 360;
}

/* Последняя точная позиция — только чтобы открыть карту в знакомом месте. Машинку по ней не рисуем. */
const LAST_POS_KEY = 'ace:last-pos';
export function readLastPos(now = Date.now()): LatLon | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_POS_KEY) ?? 'null') as { lat: number; lon: number; at: number } | null;
    return v && now - v.at < 30 * 86400_000 && Number.isFinite(v.lat) && Number.isFinite(v.lon) ? { lat: v.lat, lon: v.lon } : null;
  } catch {
    return null;
  }
}
let lastPosSaved = 0;
function saveLastPos(p: LatLon) {
  if (Date.now() - lastPosSaved < 30_000) return;
  lastPosSaved = Date.now();
  try {
    localStorage.setItem(LAST_POS_KEY, JSON.stringify({ lat: p.lat, lon: p.lon, at: Date.now() }));
  } catch {
    /* хранилище недоступно */
  }
}

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
/** Последняя принятая точка (для фильтра) и точка, от которой считаем направление движения. */
let acceptedFix: (RawFix & { at: number }) | null = null;
let headingFrom: RawFix | null = null;

/** Направление движения (°) между двумя точками. */
export function bearing(a: LatLon, b: LatLon) {
  const r = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r);
  return ((Math.atan2(y, x) / r) + 360) % 360;
}

/** Точка GPS с точностью хуже этой не используется для перестроения и «прибыли». */
export const MAX_GUIDANCE_ACCURACY = 100;

/** Обработка точки GPS: фильтр, курс, состояние для карты и ведения. Экспортирована для тестов. */
export function handleFix(fix: RawFix, now = Date.now()) {
  const verdict = acceptFix(acceptedFix, fix, now);
  if (verdict !== 'accept') {
    geoStore.set((s) => ({ ...s, status: 'watching', held: verdict }));
    return;
  }
  const heading = nextHeading(geoStore.get().heading, headingFrom, fix);
  if (!headingFrom || haversine(headingFrom, fix) >= Math.max(15, 1.5 * fix.accuracy)) headingFrom = fix;
  acceptedFix = { ...fix, at: now };
  const speedKmh = fix.speed != null && fix.speed >= 0 ? fix.speed * 3.6 : null;
  const quality = classifyAccuracy(fix.accuracy);
  geoStore.set({ status: 'watching', lat: fix.lat, lon: fix.lon, accuracy: fix.accuracy, speedKmh, heading, updated: now, quality, held: null, fixAt: fix.timestamp });
  if (quality === 'precise') saveLastPos(fix);
  recordFix({ lat: fix.lat, lon: fix.lon }, fix.accuracy, speedKmh, now);
  onPosition({ lat: fix.lat, lon: fix.lon }, fix.accuracy);
}

export function __resetGeo() {
  lastPosSaved = 0;
  acceptedFix = null;
  headingFrom = null;
  geoStore.set({ status: 'idle', lat: null, lon: null, accuracy: null, speedKmh: null, heading: null, updated: null, quality: null, held: null, fixAt: null });
}

const toFix = (p: GeolocationPosition): RawFix => ({
  lat: p.coords.latitude,
  lon: p.coords.longitude,
  accuracy: p.coords.accuracy,
  speed: p.coords.speed,
  heading: p.coords.heading,
  timestamp: p.timestamp || Date.now(),
});

export function startGeo() {
  if (watchId != null) return;
  if (!('geolocation' in navigator)) {
    geoStore.set((s) => ({ ...s, status: 'unavailable' }));
    return;
  }
  const onError = (err: GeolocationPositionError) => {
    // Тайм-аут одной попытки — не потеря позиции: прежняя точка остаётся, слежение продолжается.
    if (err.code === err.TIMEOUT && geoStore.get().lat != null) return;
    geoStore.set((s) => ({ ...s, status: err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable' }));
    if (err.code === err.PERMISSION_DENIED && watchId != null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
  };
  watchId = navigator.geolocation.watchPosition((p) => handleFix(toFix(p)), onError, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
}

/** Перезапуск слежения (возврат в приложение): iOS может приостановить его и затем отдать старую точку. */
export function restartGeo() {
  if (watchId != null && 'geolocation' in navigator) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  startGeo();
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

/** Как включить точную геопозицию (iOS «Точная геопозиция», Android «Точное местоположение»). */
export function preciseHelp(): string {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) {
    return 'Позиция приблизительная. Настройки → Конфиденциальность и безопасность → Службы геолокации → «Сайты Safari» (и AI Car Expert, если есть) → включите «Точная геопозиция». На улице GPS уточнится сам.';
  }
  if (/Android/.test(ua)) return 'Позиция приблизительная. Значок слева от адреса → Разрешения → Местоположение → «Точное». Включите GPS в шторке.';
  return 'Позиция приблизительная: устройство определяет её по Wi-Fi или сети, без GPS.';
}

/** Короткий статус GPS для карты; null — всё в порядке. */
export function geoStatusText(g: GeoState, now = Date.now()): { text: string; tone: 'warn' | 'info'; help: () => string } | null {
  if (g.status === 'denied') return { text: 'Нет доступа к геопозиции — как включить', tone: 'warn', help: geoHelp };
  if (g.status === 'unavailable' && g.lat == null) return { text: 'Геопозиция недоступна', tone: 'warn', help: geoHelp };
  if (g.lat == null) return g.status === 'watching' || g.status === 'idle' ? { text: 'Ищу GPS…', tone: 'info', help: () => 'Ищу спутники. На открытом месте это быстрее.' } : null;
  if (g.held === 'coarse' || g.held === 'jump') return { text: 'Слабый сигнал GPS — показываю последнюю точную позицию', tone: 'info', help: () => 'Новые точки слишком неточные; машинка не двигается по ним, чтобы не прыгать по карте.' };
  if (g.quality === 'coarse') return { text: `Приблизительно, ±${g.accuracy! >= 1000 ? `${(g.accuracy! / 1000).toFixed(1).replace('.0', '')} км` : `${Math.round(g.accuracy!)} м`}`, tone: 'warn', help: preciseHelp };
  if (g.updated && now - g.updated > 60_000) return { text: 'GPS не обновлялся больше минуты', tone: 'info', help: () => 'Последняя известная позиция. Проверьте, что геолокация включена.' };
  return null;
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
  // «Поехали» — чистый полноэкранный режим (настройка). Перестроение и остановки его не переключают.
  if (settingsStore.get().minimalGuidance) setMinimal(true);
  guidanceStarts += 1;
  offRouteCount = 0;
  const pos = currentPos();
  if (pos) onPosition(pos);
  const p = navStore.get().progress;
  if (p) say(`${stepText(s.route.steps[p.stepIndex], navLang())}, ${t('through')} ${fmtDistance(p.toStepM, navLang())}`);
}

/** Голосовые подсказки навигации: выключение сразу прерывает текущую фразу, но не музыку, радио и ведение. */
export function setNavigationVoice(on: boolean) {
  settingsStore.set((s) => ({ ...s, speakNavigation: on }));
  if (!on) stopSpeaking();
}

/** Счётчик нажатий «Поехали»: обзор маршрута — только при старте, не при перестроении. */
let guidanceStarts = 0;
export const guidanceStartCount = () => guidanceStarts;

export function stopNavigation() {
  if (driveUiStore.get().minimal) setMinimal(false);
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
    if (driveUiStore.get().minimal) setMinimal(false);
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
