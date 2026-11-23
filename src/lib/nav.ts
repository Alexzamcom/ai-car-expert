import { nativePosition, usesAndroidNativePosition } from './geo/nativePosition';
import { HybridPosition, type DrivingMeasurement, type PositionEstimate } from './geo/hybridPosition';
import { courseBetween } from './autonomy/gnss';
import type { PluginListenerHandle } from '@capacitor/core';
import { androidDriving } from './androidDriving';
import { createStore } from './store';
import { placesStore, savePlace, removePlace, placeOfType, findSaved } from './places';
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
import { Locator, STALE_FIX_MS, type FixSource, type GeoErrorInfo } from './geo/locator';
import { updateDisplay, resetDisplay, displayStore } from './matching/display';
import { remainingCoords, RouteTrimmer } from './routeTrim';
import { recordArrival, recordPositionSample } from './diag';
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
  /** Каким запросом получена показанная точка (способ определения — спутники, Wi-Fi, сеть — браузер не сообщает). */
  source: FixSource | null;
  nativeTrust?: PositionEstimate['trust'];
  speedSource?: PositionEstimate['speedSource'];
  nativeReason?: string;
  /** Последняя ошибка Geolocation API (null — ошибок не было с последнего запуска). */
  lastError: GeoErrorInfo | null;
  /** Разрешение браузера на геопозицию (Permissions API; на части браузеров неизвестно). */
  permission: 'granted' | 'prompt' | 'denied' | 'unknown';
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
  source: null,
  lastError: null,
  permission: 'unknown',
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

export { STALE_FIX_MS };

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
  const prevFresh = now - prev.timestamp <= STALE_FIX_MS;
  // Две точки почти одновременно (запасное слежение и слежение с высокой точностью): заметно худшая не сдвигает точную.
  if (prevFresh && now - prev.at < 10_000 && fix.accuracy > Math.max(2 * prev.accuracy, prev.accuracy + 25)) return 'coarse';
  if (prevFresh && prev.accuracy <= 100 && fix.accuracy > Math.max(3 * prev.accuracy, 250)) return 'coarse';
  const dt = Math.max(1, (fix.timestamp - prev.timestamp) / 1000);
  const d = haversine(prev, fix);
  if (prevFresh && d > 70 * dt + prev.accuracy + fix.accuracy + 50) {
    // Новая точка заметно точнее прежней (GPS после Wi-Fi/сети) — ошибалась, скорее всего, прежняя: принимаем,
    // иначе точные точки отбрасывались бы до 30 с.
    if (fix.accuracy <= 25 && fix.accuracy * 2 <= prev.accuracy) return 'accept';
    return 'jump';
  }
  return 'accept';
}

/* ---------- Курс машинки ---------- */

export interface HeadingState {
  /** Показанный курс, градусы от севера по часовой; null — ещё неизвестен. */
  heading: number | null;
  /** Точка, от которой считаем направление смещения. */
  anchor: RawFix | null;
  /** Время последнего обновления (coords timestamp). */
  at: number | null;
}
/** Направление маршрута в месте машины и удаление от него. */
export interface RoadHint {
  bearing: number;
  offRouteM: number;
}

/** Разность углов в диапазоне −180…180. */
export const angleDiff = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180;
const norm360 = (a: number) => ((a % 360) + 360) % 360;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const validDeg = (h: number | null | undefined): h is number => h != null && Number.isFinite(h) && h >= 0;

/** Скорость, ниже которой курс не меняется (≈5 км/ч): на месте и в пробке GPS-шум крутит направление. */
export const MIN_HEADING_SPEED = 1.5;

/**
 * Курс машинки.
 * - Стоим или ползём — последний достоверный курс (без маршрута и истории — направление дороги, если едем по маршруту).
 * - Курс устройства (GPS course) — при уверенном движении (≥ 9 км/ч) и точности ≤ 30 м; иначе — направление между
 *   двумя точными точками, разнесёнными больше погрешности, со свежей опорой (не через поворот).
 * - Задний ход: на малой скорости направление движения, противоположное носу, не разворачивает машинку.
 * - На маршруте курс сверяется с дорогой: поперёк дороги — шум GPS, берём направление дороги; сход с маршрута — верим GPS.
 * - Плавность: зона нечувствительности 3°, ограничение скорости поворота.
 */
export function updateHeading(st: HeadingState, fix: RawFix, road: RoadHint | null = null): HeadingState {
  const prev = st.heading;
  const at = fix.timestamp;
  const dt = st.at != null ? clamp((fix.timestamp - st.at) / 1000, 0.2, 5) : 1;
  let anchor = st.anchor;
  // Опора старше 15 с — новая: иначе направление считается «через угол» после поворота.
  if (anchor && fix.timestamp - anchor.timestamp > 15_000) anchor = null;
  const moved = anchor ? haversine(anchor, fix) : 0;
  const dtA = anchor ? Math.max(0.5, (fix.timestamp - anchor.timestamp) / 1000) : 1;
  const speed = validDeg(fix.speed) ? fix.speed : anchor ? moved / dtA : null;
  const onRoad = !!road && road.offRouteM <= Math.max(15, Math.min(fix.accuracy, 40));
  const fallback = prev ?? (onRoad ? norm360(road!.bearing) : null);

  if (speed == null || speed < MIN_HEADING_SPEED) return { heading: fallback, anchor: anchor ?? fix, at };

  const farEnough = moved >= Math.max(12, 1.2 * fix.accuracy);
  let c: number | null = null;
  if (validDeg(fix.heading) && speed >= 2.5 && fix.accuracy <= 30) c = fix.heading;
  else if (anchor && fix.accuracy <= 40 && farEnough) c = bearing(anchor, fix);
  if (!anchor || farEnough) anchor = fix;
  if (c == null) return { heading: fallback, anchor, at };

  // Задний ход: медленно и «назад» относительно носа — нос не разворачиваем.
  if (prev != null && speed < 4 && Math.abs(angleDiff(c, prev)) > 150) return { heading: prev, anchor, at };

  if (onRoad) {
    const d = angleDiff(c, road!.bearing);
    if (Math.abs(d) <= 35) c = road!.bearing + d * 0.3;
    else if (Math.abs(d) < 145) c = road!.bearing;
    // ≥ 145° — едем против направления маршрута (разворот): верим GPS.
  }
  c = norm360(c);
  if (prev == null) return { heading: c, anchor, at };
  const delta = angleDiff(c, prev);
  if (Math.abs(delta) < 3) return { heading: prev, anchor, at };
  const k = Math.abs(delta) > 60 ? 0.6 : 0.35;
  const maxStep = 90 * dt + 15;
  return { heading: norm360(prev + clamp(k * delta, -maxStep, maxStep)), anchor, at };
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

export const recentsStore = createStore<Place[]>([], 'recents');
/* «Мои места» (src/lib/places.ts) — единственный источник. Ниже — производные списки для прежнего кода:
   «Избранное» (все мои места, название — данное пользователем) и «Дом»/«Работа» (команды «едем домой», «на работу»).
   Они же сохраняются в прежние ключи как зеркало. */
export const favoritesStore = createStore<Place[]>([], 'favorites');
export const savedPlacesStore = createStore<{ home: Place | null; work: Place | null }>({ home: null, work: null }, 'saved-places');
const mirrorPlaces = () => {
  const list = placesStore.get();
  favoritesStore.set(list.map((p) => ({ ...p, name: p.label })));
  savedPlacesStore.set({ home: placeOfType('home', list), work: placeOfType('work', list) });
};
mirrorPlaces();
placesStore.subscribe(mirrorPlaces);

/** «Сделать домом / работой» (null — убрать). Место с теми же координатами получает новый тип, а не дублируется. */
export function setSavedPlace(kind: 'home' | 'work', place: Place | null) {
  if (!place) {
    const cur = placeOfType(kind);
    if (cur) removePlace(cur.id);
    return;
  }
  const existing = findSaved(place);
  savePlace({ ...place, id: existing?.id, placeType: kind, label: kind === 'home' ? 'Дом' : 'Работа', savedAt: existing?.savedAt });
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
  if (s.status === 'guiding' && step?.type === 'arrive') return head;
  if (s.status === 'guiding' && step && p) return `${head} ${L('Через', 'Через')} ${fmtDistance(p.toStepM, lang)} ${stepText(step, lang)}.`;
  return s.status === 'preview' ? `${head} ${L('Скажите «поехали», чтобы начать.', 'Скажіть «поїхали», щоб почати.')}` : head;
}

/** Последняя принятая точка (для фильтра) и точка, от которой считаем направление движения. */
let acceptedFix: (RawFix & { at: number }) | null = null;
/** Последняя отброшенная как «скачок» точка — если следующая с ней согласна, ошибалась прежняя принятая. */
let lastJump: RawFix | null = null;
let headingState: HeadingState = { heading: null, anchor: null, at: null };

/** Направление маршрута в месте машины (отрезок не короче 10 м) — для проверки курса. */
export function roadHint(pos: LatLon): RoadHint | null {
  const s = navStore.get();
  if (!s.route || !routeCache || s.route.coords.length < 2) return null;
  const p = routeProgress(s.route, pos, routeCache, s.progress?.segIndex ?? 0);
  const c = s.route.coords;
  const a = c[p.segIndex];
  let k = p.segIndex + 1;
  while (k < c.length - 1 && haversine(a, c[k]) < 10) k++;
  if (!c[k]) return null;
  return { bearing: bearing(a, c[k]), offRouteM: p.offRouteM };
}

/** Направление движения (°) между двумя точками. */
export function bearing(a: LatLon, b: LatLon) {
  const r = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r);
  return ((Math.atan2(y, x) / r) + 360) % 360;
}

/** Точка с точностью хуже этой не используется для ведения вообще — только для показа на карте. */
export const MAX_GUIDANCE_ACCURACY = 100;
/** Точка не хуже этой — пригодна для «поверните сейчас», «вы прибыли» и перестроения. */
export const FULL_GUIDANCE_ACCURACY = 50;

/**
 * Как использовать точку при ведении. Показ на карте и ведение разделены:
 * - full — всё (прогресс, подсказки, прибытие, перестроение);
 * - progress — прогресс по маршруту и заблаговременные подсказки, без «сейчас», прибытия и перестроения;
 * - display — только показать на карте с кругом точности.
 */
export function guidanceUse(accuracy: number): 'full' | 'progress' | 'display' {
  return accuracy <= FULL_GUIDANCE_ACCURACY ? 'full' : accuracy <= MAX_GUIDANCE_ACCURACY ? 'progress' : 'display';
}

/** Обработка точки GPS: фильтр, курс, состояние для карты и ведения. Экспортирована для тестов. */
export function handleFix(fix: RawFix, now = Date.now(), source: FixSource = 'high', native?: PositionEstimate) {
  let verdict = native ? 'accept' as const : acceptFix(acceptedFix, fix, now);
  // Две «невозможные» точки подряд согласны между собой — ошибочной была принятая раньше: переходим на новые.
  if (verdict === 'jump' && lastJump && haversine(lastJump, fix) <= 70 * Math.max(1, (fix.timestamp - lastJump.timestamp) / 1000) + lastJump.accuracy + fix.accuracy + 30) verdict = 'accept';
  lastJump = verdict === 'jump' ? fix : null;
  recordArrival(verdict, now);
  recordPositionSample(fix, verdict);
  if (verdict !== 'accept') {
    // Запасная менее точная точка рядом с точной — обычное дело, это не «слабый сигнал».
    if (verdict === 'coarse' && source !== 'high' && acceptedFix && now - acceptedFix.at < 10_000) return;
    geoStore.set((s) => ({ ...s, status: 'watching', held: verdict }));
    return;
  }
  const previous = acceptedFix;
  const elapsed = previous ? (fix.timestamp - previous.timestamp) / 1000 : 0;
  let measuredCourse: number | null = null;
  if (validDeg(fix.heading) && (fix.speed ?? 0) >= 2.5 && fix.accuracy <= 30) measuredCourse = fix.heading;
  else if (previous && elapsed >= 0.5 && elapsed <= 5 && (fix.speed == null || fix.speed >= 2) &&
    Math.max(previous.accuracy, fix.accuracy) <= 25) {
    const distance = haversine(previous, fix);
    if (distance >= Math.max(6, previous.accuracy + fix.accuracy, 2 * elapsed) && distance <= 70 * elapsed) measuredCourse = bearing(previous, fix);
  }
  headingState = updateHeading(headingState, fix);
  const heading = native ? native.heading : headingState.heading;
  acceptedFix = { ...fix, at: now };
  const speedKmh = fix.speed != null && fix.speed >= 0 ? fix.speed * 3.6 : null;
  const quality = classifyAccuracy(fix.accuracy);
  geoStore.set((s) => ({ ...s, status: 'watching', lat: fix.lat, lon: fix.lon, accuracy: fix.accuracy, speedKmh, heading, updated: now, quality, held: null, fixAt: fix.timestamp, source,
    nativeTrust: native?.trust, speedSource: native?.speedSource, nativeReason: native ? nativeFusion.reason : undefined }));
  // Отображаемая позиция (привязка к дороге) — отдельно; решения ведения ниже — только по сырой точке.
  const nav = navStore.get();
  updateDisplay({ lat: fix.lat, lon: fix.lon, accuracy: fix.accuracy, speed: validDeg(fix.speed) ? fix.speed : null, heading, measuredCourse, timestamp: fix.timestamp }, nav.status === 'guiding' ? (nav.route?.coords ?? null) : null, now, !native);
  if (quality === 'precise') saveLastPos(fix);
  recordFix({ lat: fix.lat, lon: fix.lon }, fix.accuracy, speedKmh, now);
  onPosition(fix, now);
}

export function __resetGeo() {
  lastPosSaved = 0;
  acceptedFix = null;
  lastJump = null;
  headingState = { heading: null, anchor: null, at: null };
  locator?.stop();
  locator = null;
  resetDisplay();
  nativeFusion.reset();
  geoStore.set({ status: 'idle', lat: null, lon: null, accuracy: null, speedKmh: null, heading: null, updated: null, quality: null, held: null, fixAt: null, source: null, lastError: null, permission: 'unknown' });
}

const toFix = (p: GeolocationPosition): RawFix => ({
  lat: p.coords.latitude,
  lon: p.coords.longitude,
  accuracy: p.coords.accuracy,
  speed: p.coords.speed,
  heading: p.coords.heading,
  timestamp: p.timestamp || Date.now(),
});

let locator: Locator | null = null;
let permWatched = false;

/** Ошибка Geolocation API: запрет — остановка; остальное — продолжаем попытки (последняя точка остаётся). */
export function handleGeoError(e: GeoErrorInfo) {
  geoStore.set((s) => ({ ...s, lastError: e, status: e.kind === 'denied' ? 'denied' : s.status === 'idle' ? 'watching' : s.status, ...(e.kind === 'denied' ? { permission: 'denied' as const } : {}) }));
}

function watchPermission() {
  if (permWatched) return;
  permWatched = true;
  navigator.permissions
    ?.query({ name: 'geolocation' as PermissionName })
    .then((p) => {
      const sync = () => {
        const st = p.state as GeoState['permission'];
        geoStore.set((s) => ({ ...s, permission: st }));
        // Разрешили в настройках, пока приложение открыто, — сразу начинаем.
        if (st === 'granted' && geoStore.get().status === 'denied') restartGeo();
      };
      sync();
      p.onchange = sync;
    })
    .catch(() => {});
}

const nativeFusion = new HybridPosition();
let nativeGeneration = 0;
let nativeRunning = false;
let nativeHandles: PluginListenerHandle[] = [];
let nativeTimer: ReturnType<typeof setInterval> | undefined;
let experiment = false;

function estimatedRoad() {
  const s = navStore.get();
  const point = nativeFusion.state;
  if (!point || s.status !== 'guiding' || !s.route || !routeCache) return undefined;
  const p = routeProgress(s.route, point, routeCache, s.progress?.segIndex ?? 0);
  const a = s.route.coords[p.segIndex], b = s.route.coords[p.segIndex + 1];
  if (!a || !b || haversine(a, b) < 2 || p.offRouteM > 14) return undefined;
  return { heading: courseBetween(a, b), distance: p.offRouteM };
}

function publishNative(estimate: PositionEstimate | null, now: number, rawAt?: number) {
  if (!estimate) return;
  const { lat, lon, source, accuracy, heading, trust, speed, speedSource } = estimate;
  if (trust === 'confirmed') {
    handleFix({ lat, lon, accuracy, heading, speed, timestamp: rawAt ?? now }, now, source, estimate);
    return;
  }
  const s = geoStore.get();
  geoStore.set({ ...s, status: 'watching', lat, lon, heading, accuracy, speedKmh: speed == null ? null : speed * 3.6,
    updated: now, fixAt: rawAt ?? s.fixAt, quality: 'approx', held: 'stale', source, nativeTrust: trust, speedSource, nativeReason: nativeFusion.reason });
  const prev = displayStore.get();
  displayStore.set({ ...prev, lat, lon, heading, accuracy, mode: 'predicted', confidence: 0, at: now, reason: nativeFusion.reason });
  // Estimations can update a route overview, but never trigger arrival or rerouting.
  const nav = navStore.get();
  if (nav.route && routeCache && nav.status === 'guiding' && accuracy <= 100 && trust !== 'network') {
    const progress = routeProgress(nav.route, { lat, lon }, routeCache, nav.progress?.segIndex ?? 0);
    if (progress.offRouteM <= 30) navStore.set({ ...nav, progress });
  }
}

function acceptNative(input: DrivingMeasurement) {
  const now = Date.now();
  const rawAt = input.kind === 'position' ? input.data.at : undefined;
  const estimate = nativeFusion.update(input, now, input.kind === 'motion' && nativeFusion.state?.trust !== 'confirmed' ? estimatedRoad() : undefined);
  publishNative(estimate, now, estimate?.trust === 'held' ? undefined : rawAt);
  if (!estimate && input.kind === 'position' && geoStore.get().nativeReason !== nativeFusion.reason) {
    geoStore.set((s) => ({ ...s, nativeReason: nativeFusion.reason }));
  }
}

async function stopNativePosition() {
  nativeGeneration++;
  nativeRunning = false;
  clearInterval(nativeTimer);
  nativeTimer = undefined;
  const handles = nativeHandles;
  nativeHandles = [];
  await Promise.allSettled([nativePosition.stop(), ...handles.map((handle) => handle.remove())]);
}

let nativePermissionRequested = false;

async function startNativePosition(ask: boolean) {
  if (ask) nativePermissionRequested = true;
  if (nativeRunning || experiment || !geoActive) return;
  nativeRunning = true;
  const generation = ++nativeGeneration;
  const add = async (handle: Promise<PluginListenerHandle>) => {
    const listener = await handle;
    if (generation === nativeGeneration) nativeHandles.push(listener);
    else await listener.remove();
  };
  try {
    await add(nativePosition.addListener('position', (data) => {
      if (generation === nativeGeneration && geoActive && !experiment) acceptNative({ kind: 'position', data });
    }));
    await add(nativePosition.addListener('motion', (data) => {
      if (generation === nativeGeneration && geoActive && !experiment) acceptNative({ kind: 'motion', data });
    }));
    if (generation !== nativeGeneration) return;
    await nativePosition.start({ ask: nativePermissionRequested });
    if (generation !== nativeGeneration) return;
    nativePermissionRequested = false;
    geoStore.set((s) => ({ ...s, status: 'watching', permission: 'granted' }));
    nativeTimer = setInterval(() => {
      const now = Date.now();
      publishNative(nativeFusion.tick(now, estimatedRoad()), now);
    }, 500);
  } catch (error) {
    if (generation !== nativeGeneration) return;
    nativePermissionRequested = false;
    const denied = (error as { code?: string }).code === 'DENIED';
    handleGeoError({ code: denied ? 1 : 2, kind: denied ? 'denied' : 'unavailable', at: Date.now(), source: 'fused',
      message: error instanceof Error ? error.message : 'Нативные источники Android недоступны' });
    await stopNativePosition();
  }
}

export function setAndroidGeoExperiment(active: boolean) {
  if (experiment === active || !usesAndroidNativePosition()) return;
  experiment = active;
  if (active) void stopNativePosition();
  else if (geoActive && geoStore.get().status !== 'denied') void startNativePosition(false);
}

let geoActive = true;

/** Capacitor останавливает наблюдатель при уходе Activity с переднего плана. */
export function setAndroidGeoActive(active: boolean) {
  if (geoActive === active) return;
  geoActive = active;
  if (usesAndroidNativePosition()) {
    if (!active) void stopNativePosition();
    else if (geoStore.get().status !== 'denied') void startNativePosition(false);
    return;
  }
  if (!active) {
    locator?.stop();
    locator = null;
  } else if (geoStore.get().status !== 'denied') {
    startGeo();
  }
}

/** Начать определение позиции: быстрая доступная точка, затем непрерывное уточнение (см. geo/locator.ts). */
export function startGeo() {
  if (usesAndroidNativePosition()) {
    void startNativePosition(true);
    return;
  }
  if (!geoActive || locator?.state.running) return;
  if (!('geolocation' in navigator)) {
    geoStore.set((s) => ({ ...s, status: 'unavailable' }));
    return;
  }
  watchPermission();
  // Последняя ошибка не сбрасывается: в диагностике видно, когда она была.
  geoStore.set((s) => ({ ...s, status: s.status === 'denied' ? 'denied' : 'watching' }));
  locator ??= new Locator(
    {
      geo: navigator.geolocation,
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (id) => clearTimeout(id as number),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (id) => clearInterval(id as number),
    },
    (p, source) => handleFix(toFix(p), Date.now(), source),
    handleGeoError,
  );
  locator.start();
}

/** Перезапуск (возврат в приложение, «Обновить позицию»): iOS может приостановить слежение и затем отдать старую точку. */
export function restartGeo() {
  if (locator) locator.stop();
  startGeo();
}

/** Состояние запросов — для диагностики. */
export const locatorState = () => usesAndroidNativePosition() ? { running: nativeRunning, high: nativeRunning, low: nativeRunning, retries: 0 } : locator?.state ?? { running: false, high: false, low: false, retries: 0 };

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
  if (usesAndroidNativePosition()) return 'Настройки Android → Приложения → AI Car Expert → Разрешения → Местоположение → При использовании.';
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
const fmtAcc = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1).replace('.0', '')} км` : `${Math.round(m)} м`);

export function geoStatusText(g: GeoState, now = Date.now()): { text: string; tone: 'warn' | 'info'; help: () => string } | null {
  if (g.status === 'denied') return { text: 'Нет доступа к геопозиции — как включить', tone: 'warn', help: geoHelp };
  if (g.status === 'unavailable' && g.lat == null) return { text: 'Геопозиция недоступна', tone: 'warn', help: geoHelp };
  if (g.lat == null) {
    if (g.status === 'idle') return null;
    if (g.lastError?.kind === 'unavailable')
      return { text: 'Устройство пока не сообщает местоположение — пробую снова', tone: 'warn', help: () => `Проверьте, что службы геолокации включены. ${geoHelp()}` };
    return {
      text: g.lastError?.kind === 'timeout' ? 'Определяю местоположение… (дольше обычного)' : 'Определяю местоположение…',
      tone: 'info',
      help: () => 'Сначала показываю позицию, которую устройство может дать сразу (может быть приблизительной), затем уточняю её.',
    };
  }
  if (g.held === 'coarse' || g.held === 'jump') return { text: 'Слабый сигнал — показываю последнюю точную позицию', tone: 'info', help: () => 'Новые точки заметно хуже или невозможны для автомобиля; машинка не двигается по ним, чтобы не прыгать по карте.' };
  if (g.quality === 'coarse') return { text: `Приблизительно, ±${fmtAcc(g.accuracy!)}`, tone: 'warn', help: preciseHelp };
  if (g.updated && now - g.updated > 60_000) return { text: 'Позиция не обновлялась больше минуты', tone: 'info', help: () => 'Показана последняя известная позиция. Проверьте, что геолокация включена.' };
  if (g.fixAt && now - g.fixAt > 60_000) return { text: `Последняя известная позиция (${Math.round((now - g.fixAt) / 60_000)} мин назад) — уточняю`, tone: 'info', help: () => 'Устройство отдало сохранённую позицию; как только появится свежая, машинка переместится.' };
  if (g.accuracy != null && g.accuracy > FULL_GUIDANCE_ACCURACY) return { text: `Приблизительно, ±${fmtAcc(g.accuracy)} — уточняю`, tone: 'info', help: () => `${preciseHelp()} Пока точность хуже ${FULL_GUIDANCE_ACCURACY} м, подсказки «поверните сейчас», «вы прибыли» и перестроение маршрута не срабатывают.` };
  return null;
}

/* ---------- Поиск мест ---------- */

export function searchPlaces(query: string, near?: LatLon, signal?: AbortSignal): Promise<Place[]> {
  return geoSearch(query, { near, lang: navLang(), signal });
}

export function addRecent(p: Place) {
  recentsStore.set((l) => [p, ...l.filter((x) => x.lat !== p.lat || x.lon !== p.lon)].slice(0, 8));
}

/** Звёздочка в карточке маршрута: место в «Моих местах» — убрать, нет — добавить под своим названием. */
export function toggleFavorite(p: Place) {
  const existing = findSaved(p);
  if (existing) removePlace(existing.id);
  else savePlace({ ...p, id: undefined, placeType: 'custom', label: p.name });
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
  routeCutM: number;
  rerouting: boolean;
  /** Сообщение во время ведения (нет сети для перестроения и т. п.). */
  notice: string | null;
}

const emptyNav = (): NavState => ({ dest: null, via: null, route: null, routes: [], routeIndex: 0, status: 'idle', error: null, progress: null, routeCutM: 0, rerouting: false, notice: null });
export const navStore = createStore<NavState>(emptyNav());

const routeTrimmer = new RouteTrimmer();
let routeCache: { route: Route; cum: number[]; offsets: number[] } | null = null;
let routeAbort: AbortController | null = null;
let lastReroute = 0;
let offRouteCount = 0;
let pendingReroute = false;
const announced = new Set<string>();

export function navLang(): Lang {
  const l = settingsStore.get().speechLang.slice(0, 2);
  return l === 'uk' || l === 'en' ? l : 'ru';
}

const emptyRouteCoords: LatLon[] = [];
let visibleRoute: { route: Route; cut: number; coords: LatLon[] } | undefined;

/** Одна линия для основной карты и обоих режимов HUD. */
export function visibleRouteCoords(s = navStore.get()): LatLon[] {
  if (!s.route || s.status === 'arrived') return emptyRouteCoords;
  if (s.status !== 'guiding' || s.routeCutM <= 0) return s.route.coords;
  if (visibleRoute?.route !== s.route || visibleRoute.cut !== s.routeCutM) {
    visibleRoute = { route: s.route, cut: s.routeCutM, coords: remainingCoords(s.route.coords, routeCache?.route === s.route ? routeCache.cum : cumulative(s.route.coords), s.routeCutM) };
  }
  return visibleRoute.coords;
}

function updateRouteCut(route: Route, progress: Progress, t: number, speed: number | null, initialMaxM?: number) {
  return routeTrimmer.update({ route, along: routeCache!.cum.at(-1)! - progress.remainingM, offRouteM: progress.offRouteM, t, speed, initialMaxM });
}

function initialRouteProgress(route: Route, from: LatLon, requestedAt: number, guiding: boolean) {
  const fix = acceptedFix;
  const trusted = fix && fix.accuracy <= FULL_GUIDANCE_ACCURACY && Date.now() - fix.timestamp <= 10_000;
  const progress = routeProgress(route, currentPos() ?? from, routeCache!);
  // Машина может проехать часть нового маршрута, пока сервер готовит ответ.
  const initialMaxM = 150 + 45 * Math.min(30, Math.max(0, ((fix?.timestamp ?? requestedAt) - requestedAt) / 1000));
  const routeCutM = guiding && trusted ? updateRouteCut(route, progress, fix.timestamp, fix.speed, initialMaxM) : 0;
  return { progress, routeCutM };
}

function setRoute(route: Route) {
  const cum = cumulative(route.coords);
  routeCache = { route, cum, offsets: stepOffsets(route, cum) };
  routeTrimmer.reset();
  visibleRoute = undefined;
  announced.clear();
}

async function buildRoutes(from: LatLon, dest: Place, via?: Place | null) {
  routeAbort?.abort();
  routeAbort = new AbortController();
  const { signal } = routeAbort;
  const routes = await fetchRoutes(from, dest, { signal, via: via ?? undefined });
  if (signal.aborted) throw new DOMException('Route request cancelled', 'AbortError');
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
  const base = { dest, via, progress: null, routeCutM: 0, rerouting: false, notice: null, routeIndex: 0 };
  const from = currentPos();
  if (!from) {
    navStore.set({ ...base, route: null, routes: [], status: 'preview', error: 'Нет геопозиции — маршрут построить нельзя. Разрешите геолокацию или откройте маршрут во внешнем навигаторе.' });
    return;
  }
  navStore.set({ ...base, route: null, routes: [], status: 'routing', error: null });
  const requestedAt = Date.now();
  try {
    const routes = await buildRoutes(from, dest, via);
    if (navStore.get().dest !== dest) return;
    const status = keepStatus && prevStatus === 'guiding' ? 'guiding' : 'preview';
    setRoute(routes[0]);
    navStore.set({ ...base, route: routes[0], routes, status, error: null, ...initialRouteProgress(routes[0], from, requestedAt, status === 'guiding') });
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
  if (acceptedFix && geoStore.get().held == null) onPosition(acceptedFix, Date.now());
  const current = navStore.get();
  const p = current.progress;
  const step = p && s.route.steps[p.stepIndex];
  if (current.status === 'guiding' && p && step && step.type !== 'arrive') say(`${stepText(step, navLang())}, ${t('through')} ${fmtDistance(p.toStepM, navLang())}`);
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
  routeTrimmer.reset();
  visibleRoute = undefined;
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
  const requestedAt = Date.now();
  buildRoutes(pos, s.dest, s.via)
    .then((routes) => {
      const cur = navStore.get();
      if (cur.route !== s.route || cur.status !== 'guiding' || !cur.rerouting) return;
      const route = routes[0];
      setRoute(route);
      navStore.set({ ...cur, route, routes: [route], routeIndex: 0, rerouting: false, notice: null, ...initialRouteProgress(route, pos, requestedAt, true) });
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

function onPosition(pos: RawFix, now: number) {
  const { accuracy } = pos;
  const s = navStore.get();
  if (!s.route || !routeCache || (s.status !== 'guiding' && s.status !== 'preview')) return;
  const use = guidanceUse(accuracy);
  // Приблизительная точка (> 100 м) только показывается на карте: прогресс по маршруту не сдвигаем, если он уже есть.
  if (use === 'display' && s.progress && s.status === 'guiding') return;
  const p = routeProgress(s.route, pos, routeCache, s.progress?.segIndex ?? 0);
  const full = use === 'full';
  const guiding = s.status === 'guiding';
  const finish = s.route.coords.at(-1);
  // Проверяем сырую точку, дорожный финиш и выбранную цель. Проекция сама по себе
  // может попасть на конец линии с соседней улицы; погрешность расходует запас до финиша.
  if (guiding && finish && s.dest && accuracy <= 25 &&
    now - pos.timestamp <= 10_000 && p.remainingM <= 30 &&
    haversine(pos, finish) + accuracy <= 40 && haversine(pos, s.dest) + accuracy <= 65) {
    navStore.set({ ...s, status: 'arrived', progress: { ...p, remainingM: 0, toStepM: 0 } });
    if (driveUiStore.get().minimal) setMinimal(false);
    say(t('arrived'));
    return;
  }

  const routeCutM = guiding && full && now - pos.timestamp <= 10_000
    ? updateRouteCut(s.route, p, pos.timestamp, pos.speed)
    : s.routeCutM;
  navStore.set({ ...s, progress: p, routeCutM });
  if (!guiding || use === 'display') return;

  // Сход с маршрута: 3 точки подряд дальше 60 м (с учётом точности GPS) → перестроение.
  // Неточная точка (50–100 м) не считается ни сходом, ни возвратом на маршрут.
  if (full) offRouteCount = p.offRouteM > Math.max(60, accuracy * 1.5) ? offRouteCount + 1 : 0;
  if (full && offRouteCount >= 3 && Date.now() - lastReroute > (pendingReroute ? 30000 : 15000) && s.dest && !s.rerouting) {
    reroute(pos);
    return;
  }

  // Промежуточная точка пройдена — дальше считаем маршрут без неё.
  if (full && s.via && haversine(pos, s.via) < 60) {
    navStore.set({ ...navStore.get(), via: null });
  }

  // Голосовые подсказки перед манёвром: ~600 м, ~200 м и в момент манёвра.
  const step = s.route.steps[p.stepIndex];
  if (!step || step.type === 'arrive') return;
  const lang = navLang();
  const thresholds: [string, number][] = [
    ['far', 600],
    ['near', 200],
    ['now', 40],
  ];
  for (const [key, m] of thresholds) {
    const id = `${p.stepIndex}:${key}`;
    if (p.toStepM <= m && !announced.has(id)) {
      // «Сейчас поверните» — только по точной точке: иначе возможна ложная команда до перекрёстка.
      if (key === 'now' && !full) break;
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
  route?: Route;
}

let lastSavedRoute: Route | null = null;
navStore.subscribe(() => {
  const s = navStore.get();
  // Пишем только при смене цели/остановки/режима, а не на каждую точку GPS.
  const key = s.dest ? JSON.stringify([s.dest, s.via, s.status === 'guiding']) : '';
  if (key === lastSaved && (!androidDriving || s.route === lastSavedRoute) || s.status === 'routing') return;
  lastSaved = key;
  lastSavedRoute = s.route;
  try {
    if (!s.dest || s.status === 'arrived') localStorage.removeItem(NAV_KEY);
    else localStorage.setItem(NAV_KEY, JSON.stringify({ dest: s.dest, via: s.via, guiding: s.status === 'guiding', at: Date.now(),
      route: androidDriving && s.route && s.route.coords.length <= 20_000 ? s.route : undefined } satisfies NavSession));
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
  const route = saved.route;
  if (androidDriving && route && route.coords?.length >= 2 && route.steps?.length) {
    setRoute(route);
    const pos = currentPos();
    navStore.set({ ...navStore.get(), dest: saved.dest, via: saved.via, route, routes: [route],
      status: saved.guiding ? 'guiding' : 'preview', progress: pos ? routeProgress(route, pos, routeCache!) : null });
    return;
  }
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
