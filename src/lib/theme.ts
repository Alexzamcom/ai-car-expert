/* Дневная и ночная темы.
   Единственный источник цветов: токены ниже применяются как CSS-переменные на <html>.
   Контраст пар «текст/фон» проверяется unit-тестом (WCAG: 4,5:1 для текста, 3:1 для значков). */
import { createStore } from './store';
import { settingsStore } from './state';
import { geoStore } from './nav';
import { daylight } from './sun';

export type ThemeMode = 'auto' | 'day' | 'night';
export type ThemeName = 'day' | 'night';

export const THEME_MODE_LABEL: Record<ThemeMode, string> = { auto: 'Автоматически', day: 'День', night: 'Ночь' };

export interface Tokens {
  bg: string;
  'bg-2': string;
  panel: string;
  'panel-2': string;
  'panel-3': string;
  line: string;
  'line-2': string;
  text: string;
  'text-2': string;
  muted: string;
  'icon-off': string;
  accent: string;
  'accent-2': string;
  'accent-ink': string;
  ok: string;
  warn: string;
  danger: string;
  /** Подложка элементов поверх карты. */
  overlay: string;
  /** Затемнение под модальными окнами. */
  scrim: string;
  shadow: string;
  'map-bg': string;
  route: string;
  'route-casing': string;
  maneuver: string;
  'maneuver-2': string;
  chatgpt: string;
  /** Фирменный красный кнопки YouTube Music (белый значок поверх). */
  ytm: string;
  'car-body': string;
  'car-body-2': string;
  'car-line': string;
  'car-wheel': string;
  'car-rim': string;
  glow: string;
}

export const THEMES: Record<ThemeName, Tokens> = {
  // Ночь: прежний стиль; приглушённые тексты и значки «выкл.» сделаны контрастнее.
  night: {
    bg: '#06080b',
    'bg-2': '#0b0e13',
    panel: '#11151b',
    'panel-2': '#171c24',
    'panel-3': '#1f2630',
    line: '#262e3a',
    'line-2': '#323c4a',
    text: '#eef2f6',
    'text-2': '#bec7d3',
    muted: '#8f9aaa',
    'icon-off': '#66717f',
    accent: '#36d1ff',
    'accent-2': '#2fe6b0',
    'accent-ink': '#001620',
    ok: '#3ddc84',
    warn: '#ffb020',
    danger: '#ff6b70',
    overlay: 'rgba(17, 21, 27, 0.96)',
    scrim: '#020305',
    shadow: 'rgba(0, 0, 0, 0.5)',
    'map-bg': '#0d1116',
    route: '#36d1ff',
    'route-casing': '#06080b',
    maneuver: '#0f6b8a',
    'maneuver-2': '#0c5571',
    chatgpt: '#19c37d',
    ytm: '#d91c23',
    'car-body': '#2a3442',
    'car-body-2': '#141a22',
    'car-line': '#3a4656',
    'car-wheel': '#0b0e12',
    'car-rim': '#8b96a5',
    glow: 'rgba(54, 209, 255, 0.06)',
  },
  // День: светлый фон, тёмный текст, насыщенный акцент — читается на солнце.
  day: {
    bg: '#e8ecf1',
    'bg-2': '#f2f4f7',
    panel: '#ffffff',
    'panel-2': '#f4f6f9',
    'panel-3': '#e6ebf1',
    line: '#d2d9e2',
    'line-2': '#aeb9c6',
    text: '#0b121a',
    'text-2': '#2c3846',
    muted: '#525e6d',
    'icon-off': '#7a8695',
    accent: '#0064a6',
    'accent-2': '#007a57',
    'accent-ink': '#ffffff',
    ok: '#0f7a3d',
    warn: '#8a5000',
    danger: '#bf1f2a',
    overlay: 'rgba(255, 255, 255, 0.97)',
    scrim: '#0b121a',
    shadow: 'rgba(20, 32, 48, 0.16)',
    'map-bg': '#e6e2dc',
    route: '#0064a6',
    'route-casing': '#ffffff',
    maneuver: '#0064a6',
    'maneuver-2': '#004f84',
    chatgpt: '#0d8a57',
    ytm: '#d91c23',
    'car-body': '#cfd7e1',
    'car-body-2': '#9aa7b6',
    'car-line': '#7d8a99',
    'car-wheel': '#2b333d',
    'car-rim': '#c9d1db',
    glow: 'rgba(0, 100, 166, 0.05)',
  },
};

/* ---------- Контраст (WCAG 2.x) ---------- */

function channel(c: number) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function parseColor(c: string): [number, number, number, number] {
  const hex = c.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const m = c.match(/^rgba?\(([^)]+)\)$/);
  if (!m) throw new Error(`Неизвестный цвет ${c}`);
  const [r, g, b, a = '1'] = m[1].split(',').map((x) => x.trim());
  return [Number(r), Number(g), Number(b), Number(a)];
}

/** Полупрозрачный цвет поверх фона. */
export function over(fg: string, bg: string): string {
  const [r, g, b, a] = parseColor(fg);
  const [R, G, B] = parseColor(bg);
  const mix = (x: number, y: number) => Math.round(x * a + y * (1 - a));
  return `#${[mix(r, R), mix(g, G), mix(b, B)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

export function contrast(a: string, b: string): number {
  const lum = (c: string) => {
    const [r, g, bl] = parseColor(c);
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(bl);
  };
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/* ---------- Выбор темы ---------- */

export interface ThemeState {
  active: ThemeName;
  mode: ThemeMode;
  reason: 'manual' | 'sun' | 'system';
  next: { at: number; to: ThemeName } | null;
}

/** Последние известные координаты (округлены до ~10 км) — чтобы «Авто» работало сразу после запуска. */
export const lastPlaceStore = createStore<{ lat: number; lon: number } | null>(null, 'last-place');

export function computeTheme(
  mode: ThemeMode,
  now: Date,
  place: { lat: number; lon: number } | null,
  systemDark: boolean,
): ThemeState {
  if (mode !== 'auto') return { active: mode, mode, reason: 'manual', next: null };
  if (place) {
    const d = daylight(now, place.lat, place.lon);
    return {
      active: d.day ? 'day' : 'night',
      mode,
      reason: 'sun',
      next: d.next ? { at: d.next.at.valueOf(), to: d.next.to } : null,
    };
  }
  return { active: systemDark ? 'night' : 'day', mode, reason: 'system', next: null };
}

export const themeStore = createStore<ThemeState>({ active: 'night', mode: 'auto', reason: 'system', next: null });

const systemDarkQuery = () => (typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : null);

function place(): { lat: number; lon: number } | null {
  const g = geoStore.get();
  if (g.lat != null && g.lon != null) return { lat: g.lat, lon: g.lon };
  return lastPlaceStore.get();
}

let switchTimer: ReturnType<typeof setTimeout> | null = null;

/** Применить тему к документу: CSS-переменные, color-scheme, цвет строки состояния. */
export function applyTheme(name: ThemeName, animate: boolean) {
  const root = document.documentElement;
  if (animate && root.dataset.theme && root.dataset.theme !== name) {
    root.classList.add('theme-switching');
    if (switchTimer) clearTimeout(switchTimer);
    switchTimer = setTimeout(() => root.classList.remove('theme-switching'), 600);
  }
  for (const [k, v] of Object.entries(THEMES[name])) root.style.setProperty(`--${k}`, v);
  root.dataset.theme = name;
  root.style.colorScheme = name === 'night' ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEMES[name].bg);
}

export function evaluateTheme(animate = true) {
  const mode = settingsStore.get().theme;
  const next = computeTheme(mode, new Date(), place(), systemDarkQuery()?.matches ?? true);
  const prev = themeStore.get();
  if (prev.active !== next.active || prev.mode !== next.mode || prev.reason !== next.reason || prev.next?.at !== next.next?.at) {
    themeStore.set(next);
  }
  if (document.documentElement.dataset.theme !== next.active) applyTheme(next.active, animate);
}

export function setThemeMode(mode: ThemeMode) {
  settingsStore.set((s) => ({ ...s, theme: mode }));
}

/** Быстрое переключение с главного экрана: Авто → День → Ночь → Авто. */
export function cycleThemeMode(): ThemeMode {
  const order: ThemeMode[] = ['auto', 'day', 'night'];
  const next = order[(order.indexOf(settingsStore.get().theme) + 1) % order.length];
  setThemeMode(next);
  return next;
}

let started = false;
export function startTheme() {
  if (started) return;
  started = true;
  evaluateTheme(false);
  settingsStore.subscribe(() => evaluateTheme());
  geoStore.subscribe(() => {
    const g = geoStore.get();
    if (g.lat != null && g.lon != null) {
      const coarse = { lat: Math.round(g.lat * 10) / 10, lon: Math.round(g.lon * 10) / 10 };
      const last = lastPlaceStore.get();
      if (!last || last.lat !== coarse.lat || last.lon !== coarse.lon) lastPlaceStore.set(coarse);
    }
    evaluateTheme();
  });
  systemDarkQuery()?.addEventListener?.('change', () => evaluateTheme());
  // Восход/закат проверяем раз в минуту; после сна устройства — при возвращении на экран.
  setInterval(() => evaluateTheme(), 60_000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && evaluateTheme());
}
