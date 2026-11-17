/* HUD — проекция навигации на лобовое стекло. Чистые функции: маршрут в координатах автомобиля, масштаб, скорость.
   Отрисовка — src/sections/Hud.tsx; маршрут, GPS, перестроение и голос — общие с навигацией. */
import { createStore } from './store';
import type { LatLon } from './routing';
import type { GeoState } from './nav';

export type HudMode = 'route' | 'route-speed' | 'map' | 'minimal';

export const HUD_MODES: { id: HudMode; label: string; hint: string }[] = [
  { id: 'route', label: 'Маршрут', hint: 'Упрощённая карта: дорога, маршрут, поворот, прибытие' },
  { id: 'route-speed', label: 'Маршрут + скорость', hint: 'То же и крупная скорость по GPS' },
  { id: 'map', label: 'Полная карта', hint: 'Движущаяся карта с перекрёстками, по движению' },
  { id: 'minimal', label: 'Минимальный', hint: 'Стрелка манёвра, расстояние, скорость' },
];

/** Цвета элементов HUD: хорошо видны в отражении ночью. */
export const HUD_COLORS = {
  white: ['Белый', '#f2f4f7'],
  green: ['Зелёный', '#39ff88'],
  cyan: ['Голубой', '#3ee6ff'],
  yellow: ['Жёлтый', '#ffe14a'],
  amber: ['Янтарный', '#ffae3a'],
} as const;
export type HudColor = keyof typeof HUD_COLORS;

export interface HudSettings {
  mode: HudMode;
  mirror: boolean;
  color: HudColor;
  /** Яркость оформления 0.3…1 (системную яркость iOS веб-приложение менять не может). */
  brightness: number;
  /** Контраст: толщина линий и обводка текста. */
  contrast: 'normal' | 'high';
  /** Масштаб элементов 0.8…1.6. */
  scale: number;
  showSpeed: boolean;
  showEta: boolean;
  /** Предупреждение о безопасности показано. */
  warned: boolean;
}

export const DEFAULT_HUD: HudSettings = {
  mode: 'route',
  mirror: true,
  color: 'cyan',
  brightness: 0.85,
  contrast: 'high',
  scale: 1,
  showSpeed: true,
  showEta: true,
  warned: false,
};

/** Показывать ли скорость в режиме. В «Маршрут» скорость скрыта по замыслу; в остальных — по настройке. */
export function hudShowsSpeed(mode: HudMode, s: Pick<HudSettings, 'showSpeed'>) {
  return mode !== 'route' && s.showSpeed;
}

/** Скорость только свежая (≤ 3 с) и при достоверной точке (≤ 50 м); иначе null — не выдаём неточное за точное. */
export function reliableSpeed(g: Pick<GeoState, 'speedKmh' | 'accuracy' | 'updated' | 'held'>, now = Date.now()): number | null {
  if (g.speedKmh == null || g.updated == null) return null;
  if (now - g.updated > 3000) return null;
  if ((g.accuracy ?? 999) > 50 || g.held) return null;
  return Math.round(g.speedKmh < 3 ? 0 : g.speedKmh);
}

/**
 * Сколько метров впереди показывать: на прямой — больше дороги (по скорости), перед манёвром — ближе к перекрёстку.
 */
export function hudRangeM(speedKmh: number | null, toStepM: number | null): number {
  const v = speedKmh ?? 30;
  const straight = Math.min(700, Math.max(220, v * 6));
  if (toStepM == null) return straight;
  if (toStepM < straight * 0.8) return Math.max(90, Math.min(straight, toStepM * 1.7));
  return straight;
}

/**
 * Точка → координаты автомобиля в метрах: x — вправо, y — вперёд (по курсу).
 * Курс 0° (на север): x — восток, y — север; 90° (на восток): север оказывается слева.
 */
export function toCarFrame(p: LatLon, car: LatLon, headingDeg: number): [number, number] {
  const dx = (p.lon - car.lon) * 111320 * Math.cos((car.lat * Math.PI) / 180);
  const dy = (p.lat - car.lat) * 111320;
  const h = (headingDeg * Math.PI) / 180;
  return [dx * Math.cos(h) - dy * Math.sin(h), dx * Math.sin(h) + dy * Math.cos(h)];
}

/** Участок маршрута вокруг машины в координатах автомобиля: немного позади и до range метров впереди (с запасом). */
export function routeInCarFrame(coords: LatLon[], segIndex: number, car: LatLon, headingDeg: number, rangeM: number): [number, number][] {
  const out: [number, number][] = [];
  const start = Math.max(0, segIndex - 1);
  for (let i = start; i < coords.length; i++) {
    const q = toCarFrame(coords[i], car, headingDeg);
    out.push(q);
    if (Math.hypot(q[0], q[1]) > rangeM * 1.8 && i > segIndex + 1) break;
  }
  return out;
}

/* ---------- Состояние ---------- */

/** Настройки HUD (сохраняются). */
export const hudSettingsStore = createStore<HudSettings>(DEFAULT_HUD, 'hud');
/** HUD открыт — сохраняется, чтобы восстановиться после выгрузки приложения iPadOS. */
export const hudUiStore = createStore<{ active: boolean; at: number }>({ active: false, at: 0 }, 'hud-ui');

export function openHud() {
  hudUiStore.set({ active: true, at: Date.now() });
}
export function closeHud() {
  hudUiStore.set({ active: false, at: 0 });
}
/** HUD открыт недавно (≤ 6 ч) — восстанавливать после перезапуска. */
export function hudActiveNow(now = Date.now()) {
  const u = hudUiStore.get();
  return u.active && now - u.at < 6 * 3600_000;
}
