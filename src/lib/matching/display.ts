/* Отображаемая позиция машинки (карты, HUD). Сырая точка GPS — в geoStore, по ней принимаются решения ведения;
   здесь — только то, что рисуется: привязка к дороге, плавный переход, кратковременный прогноз. */
import { createStore } from '../store';
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
  at: number;
}

const EMPTY: DisplayPos = { lat: null, lon: null, heading: null, accuracy: null, mode: null, confidence: 0, lineId: null, at: 0 };
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
  let lines: RoadLine[] = [];
  try {
    lines = [...routeNear(route, fix, radius), ...(roadProvider?.(fix, radius) ?? [])];
  } catch {
    lines = routeNear(route, fix, radius);
  }
  const r = matcher.update({ ...fix, t: now }, lines);
  const prev = displayStore.get();
  // Курс: по дороге — только в движении и при уверенной привязке; стоим — прежний (без вращения от шума).
  const moving = (fix.speed ?? 0) >= 2;
  const heading = r.mode === 'matched' && moving && r.bearing != null ? r.bearing : (fix.heading ?? prev.heading);
  displayStore.set({ lat: r.lat, lon: r.lon, heading, accuracy: r.accuracy, mode: r.mode, confidence: r.confidence, lineId: r.lineId, at: now });
  timer ??= setInterval(tick, 500);
}

/** Потеря сигнала: короткий прогноз вдоль дороги (Matcher.predict ограничивает время и растит неопределённость). */
function tick() {
  const now = Date.now();
  if (now - lastFixAt < 1500) return;
  const p = matcher.predict(now);
  if (!p) return;
  const prev = displayStore.get();
  displayStore.set({ ...prev, lat: p.lat, lon: p.lon, heading: p.bearing ?? prev.heading, accuracy: p.accuracy, mode: 'predicted', confidence: p.confidence, at: now });
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
