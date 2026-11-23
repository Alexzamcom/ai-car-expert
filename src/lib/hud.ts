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

/** Палитра HUD: «Авто» — ночью существующая (ночная) палитра, днём — дневная; «Дневной» — всегда дневная; «Ручной» — своя. */
export type HudLook = 'auto' | 'day' | 'manual';
export const HUD_LOOKS: { id: HudLook; label: string; hint: string }[] = [
  { id: 'auto', label: 'Авто', hint: 'Ночью — ваша обычная палитра HUD, днём — дневная (по той же теме, что и приложение)' },
  { id: 'day', label: 'Дневной', hint: 'Всегда дневная: белые цифры, жёлтые стрелки, полная яркость, крупнее' },
  { id: 'manual', label: 'Ручной', hint: 'Свои цвета, размеры и яркость — в любое время суток' },
];

/** Ручная палитра: цвета цифр и указаний, размеры, яркость. */
export interface HudManual {
  /** Цвет скорости и других цифр (расстояние, время прибытия, остаток). */
  digits: string;
  /** Цвет стрелок, линии маршрута и текста указаний. */
  arrows: string;
  /** Размер цифр 0.7…1.8. */
  digitsScale: number;
  /** Размер стрелок и указаний 0.7…1.8. */
  arrowsScale: number;
  /** Яркость графических элементов 0.3…1. */
  brightness: number;
}
export const DEFAULT_HUD_MANUAL: HudManual = { digits: '#f2f4f7', arrows: '#3ee6ff', digitsScale: 1, arrowsScale: 1, brightness: 0.9 };
/** Готовые цвета для ручного режима (плюс любой свой — через выбор цвета). */
export const HUD_SWATCHES = ['#f2f4f7', '#3ee6ff', '#39ff88', '#ffe14a', '#ffae3a', '#ff5a5a', '#ff6bf0', '#8fa8ff'];
/** Дневная палитра: в отражении днём лучше всего видны белые цифры и жёлтые указания на полной яркости. */
export const HUD_DAY = { digits: '#ffffff', arrows: '#ffe14a', brightness: 1, minScale: 1.15 } as const;

export type HudStyle = 'classic' | 'game';

export interface HudSettings {
  style: HudStyle;
  mode: HudMode;
  /** Палитра: авто / дневная / ручная. */
  look: HudLook;
  /** Значения ручной палитры (сохраняются отдельно — переключение режимов их не теряет). */
  manual: HudManual;
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
  style: 'classic',
  mode: 'route',
  look: 'auto',
  manual: DEFAULT_HUD_MANUAL,
  mirror: true,
  color: 'cyan',
  brightness: 0.85,
  contrast: 'high',
  scale: 1,
  showSpeed: true,
  showEta: true,
  warned: false,
};

/** Итоговое оформление HUD сейчас: цвета, размеры, яркость, контраст. */
export interface HudAppearance {
  palette: 'night' | 'day' | 'manual';
  digits: string;
  arrows: string;
  digitsScale: number;
  arrowsScale: number;
  brightness: number;
  contrast: HudSettings['contrast'];
}

const clamp = (v: number, lo: number, hi: number, d: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const hex = (c: unknown, d: string) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : d);

/**
 * Оформление по палитре и времени суток (dark — ночная тема приложения).
 * Ночная палитра — ровно прежняя: один цвет, яркость, масштаб и контраст из настроек (не меняется этой функцией).
 */
export function hudAppearance(s: HudSettings, dark: boolean): HudAppearance {
  const look = s.look ?? 'auto';
  if (look === 'manual') {
    const m = { ...DEFAULT_HUD_MANUAL, ...(s.manual ?? {}) };
    return {
      palette: 'manual',
      digits: hex(m.digits, DEFAULT_HUD_MANUAL.digits),
      arrows: hex(m.arrows, DEFAULT_HUD_MANUAL.arrows),
      digitsScale: clamp(m.digitsScale, 0.7, 1.8, 1),
      arrowsScale: clamp(m.arrowsScale, 0.7, 1.8, 1),
      brightness: clamp(m.brightness, 0.3, 1, 0.9),
      contrast: s.contrast,
    };
  }
  if (look === 'auto' && dark) {
    const c = HUD_COLORS[s.color]?.[1] ?? HUD_COLORS.cyan[1];
    return { palette: 'night', digits: c, arrows: c, digitsScale: s.scale, arrowsScale: s.scale, brightness: s.brightness, contrast: s.contrast };
  }
  const k = Math.max(s.scale, HUD_DAY.minScale);
  return { palette: 'day', digits: HUD_DAY.digits, arrows: HUD_DAY.arrows, digitsScale: k, arrowsScale: k, brightness: HUD_DAY.brightness, contrast: 'high' };
}

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
