/* Отображаемая позиция машинки (карты, HUD). Сырая точка GPS — в geoStore, по ней принимаются решения ведения;
   здесь — только то, что рисуется: привязка к дороге, плавный переход, кратковременный прогноз. */
import { createStore } from '../store';
import { STALE_FIX_MS } from '../geo/locator';
import type { LatLon } from '../routing';
import { Matcher, type MatchResult, type RoadLine } from './matcher';

export interface DisplayPos {
  lat: number | null;
  lon: number | null;
  heading: number | null;
  /** Неопределённость показанной позиции, м. */
  accuracy: number | null;
  mode: MatchResult['mode'] | null;
  confidence: number;
  lineId: string | null;
  /** Почему показана именно эта позиция (выбор дороги или причина «без привязки»). */
  reason: string;
  /** Расстояние от сырой точки GPS до показанной, м. */
  shift: number;
  at: number;
  segment: number | null;
  mapRoads: number | null;
  routeRoads: number;
  hasRoute: boolean;
  course: number | null;
}

const EMPTY: DisplayPos = { lat: null, lon: null, heading: null, accuracy: null, mode: null, confidence: 0, lineId: null, reason: '', shift: 0, at: 0, segment: null, mapRoads: null, routeRoads: 0, hasRoute: false, course: null };
export const displayStore = createStore<DisplayPos>(EMPTY);

/** Дороги рядом из карты (MapLibre, векторные тайлы). Нет поставщика — привязка только к маршруту. */
export type RoadProvider = (p: LatLon, radiusM: number) => RoadLine[];
let roadProvider: RoadProvider | null = null;
export function setRoadProvider(fn: RoadProvider | null) {
  roadProvider = fn;
}

const matcher = new Matcher();
let lastFixAt = 0;
let timer: ReturnType<typeof setInterval> | null = null;

export interface DisplayFix {
  lat: number;
  lon: number;
  accuracy: number;
  /** м/с */
  speed: number | null;
  /** сглаженный курс машинки (nav.updateHeading) */
  heading: number | null;
  measuredCourse: number | null;
  timestamp: number;
}

/** Активный маршрут как дорога с известным направлением — только участок рядом (быстрее и без петель маршрута). */
function routeNear(coords: LatLon[] | null, p: LatLon, radius: number): RoadLine[] {
  if (!coords || coords.length < 2) return [];
  const kx = 111_320 * Math.cos((p.lat * Math.PI) / 180);
  const xy = (q: LatLon): [number, number] => [(q.lon - p.lon) * kx, (q.lat - p.lat) * 111_320];
  const segNear = (a: LatLon, b: LatLon) => {
    const [ax, ay] = xy(a);
    const [bx, by] = xy(b);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    const f = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    return Math.hypot(ax + dx * f, ay + dy * f) <= radius;
  };
  const out: RoadLine[] = [];
  let run: LatLon[] = [];
  const flush = () => {
    // id по порядку участка: обычно участок один — «route:0», и он не меняется от точки к точке.
    if (run.length >= 2) out.push({ id: `route:${out.length}`, coords: run, oneway: 1, kind: 'route' });
    run = [];
  };
  for (let i = 0; i < coords.length - 1; i++) {
    if (segNear(coords[i], coords[i + 1])) {
      if (!run.length) run.push(coords[i]);
      run.push(coords[i + 1]);
    } else flush();
  }
  flush();
  return out;
}

/** Новая принятая точка GPS → отображаемая позиция. route — координаты активного маршрута (или null). */
export function updateDisplay(fix: DisplayFix, route: LatLon[] | null, now = Date.now()) {
  lastFixAt = now;
  const radius = 120;
  const routeRoads = routeNear(route, fix, radius);
  let mapRoads: RoadLine[] | null = null;
  try {
    mapRoads = roadProvider?.(fix, radius) ?? null;
  } catch {
    // Стиль или источник может исчезнуть при смене карты.
  }
  const stale = now - fix.timestamp > STALE_FIX_MS;
  // Кешированную позицию можно показать при запуске, но не привязывать и не прогнозировать.
  if (stale) matcher.reset();
  const course = stale ? null : fix.measuredCourse;
  const r: MatchResult = stale
    ? { mode: 'raw', lat: fix.lat, lon: fix.lon, bearing: null, accuracy: fix.accuracy, confidence: 0, lineId: null, reason: 'кешированная точка GPS', shift: 0 }
    : matcher.update({ ...fix, heading: course, t: fix.timestamp }, [...routeRoads, ...(mapRoads ?? [])]);
  const prev = displayStore.get();
  const heading = r.mode === 'matched' && matcher.moving && course != null && r.bearing != null ? r.bearing : (fix.heading ?? prev.heading);
  displayStore.set({ lat: r.lat, lon: r.lon, heading, accuracy: r.accuracy, mode: r.mode, confidence: r.confidence, lineId: r.lineId,
    segment: r.lineId ? matcher.current?.seg ?? null : null, reason: r.reason, shift: r.shift, at: now,
    mapRoads: mapRoads?.length ?? null, routeRoads: routeRoads.length, hasRoute: !!route, course });
  timer ??= setInterval(tick, 500);
}

/** Потеря сигнала: короткий прогноз вдоль дороги (Matcher.predict ограничивает время и растит неопределённость). */
function tick() {
  const now = Date.now();
  if (now - lastFixAt < 1500) return;
  const p = matcher.predict(now);
  const prev = displayStore.get();
  if (!p) {
    if (prev.mode === 'predicted' && prev.confidence > 0) {
      displayStore.set({ ...prev, confidence: 0, reason: 'GPS не обновляется; удерживается последняя оценка' });
    }
    return;
  }
  displayStore.set({ ...prev, lat: p.lat, lon: p.lon, heading: p.bearing ?? prev.heading, accuracy: p.accuracy, mode: 'predicted', confidence: p.confidence, reason: p.reason, shift: p.shift, at: now });
}

export function resetDisplay() {
  matcher.reset();
  lastFixAt = 0;
  if (timer) clearInterval(timer);
  timer = null;
  displayStore.set(EMPTY);
}

/** Для тестов: прогноз «сейчас». */
export const __tickDisplay = tick;
