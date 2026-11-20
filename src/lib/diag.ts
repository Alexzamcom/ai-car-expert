/* Временная диагностика карты и геопозиции (Настройки → Диагностика геопозиции → «Диагностический режим»,
   или адрес с ?diag=1). Счётчики жизненного цикла MapLibre, поток точек GPS, причина привязки к дороге.
   Ничего не отправляет наружу — только показывает на экране. */
import { createStore } from './store';
import type { LatLon } from './routing';
import type { RawFix } from './nav';

export const diagModeStore = createStore<{ on: boolean }>({ on: false }, 'diag');
try {
  if (new URLSearchParams(location.search).get('diag') === '1') diagModeStore.set({ on: true });
} catch {
  /* нет location (тесты) */
}

export interface MapDiag {
  /** экземпляров MapLibre создано / удалено (норма — 1 / 0, пока карта открыта) */
  creates: number;
  removes: number;
  /** смен стиля (setStyle) и полных загрузок стиля */
  setStyles: number;
  styleLoads: number;
  errors: number;
  contextLost: number;
  contextRestored: number;
  fps: number;
  /** последние события с временем */
  events: { at: number; text: string }[];
}

const EMPTY: MapDiag = { creates: 0, removes: 0, setStyles: 0, styleLoads: 0, errors: 0, contextLost: 0, contextRestored: 0, fps: 0, events: [] };
export const mapDiagStore = createStore<MapDiag>(EMPTY);

function bump(k: keyof Omit<MapDiag, 'events' | 'fps'>, text?: string) {
  mapDiagStore.set((s) => ({ ...s, [k]: s[k] + 1, events: text ? [{ at: Date.now(), text }, ...s.events].slice(0, 30) : s.events }));
}

export const mapDiag = {
  create: (what = 'MapLibre') => bump('creates', `${what}: карта создана`),
  remove: (what = 'MapLibre') => bump('removes', `${what}: карта удалена`),
  setStyle: (why: string) => bump('setStyles', `setStyle: ${why}`),
  styleLoad: () => bump('styleLoads', 'стиль загружен'),
  error: (msg: string) => bump('errors', `ошибка: ${msg.slice(0, 120)}`),
  contextLost: () => bump('contextLost', 'WebGL-контекст потерян'),
  contextRestored: () => bump('contextRestored', 'WebGL-контекст восстановлен'),
  event: (text: string) => mapDiagStore.set((s) => ({ ...s, events: [{ at: Date.now(), text }, ...s.events].slice(0, 30) })),
  fps: (n: number) => mapDiagStore.get().fps !== n && mapDiagStore.set((s) => ({ ...s, fps: n })),
};

/* ---------- Поток точек GPS ---------- */
export interface GeoDiag {
  /** время прихода последних точек (мс) — для частоты и пауз */
  arrivals: number[];
  accepted: number;
  rejected: { stale: number; coarse: number; jump: number };
  /** самая длинная пауза между точками, мс */
  maxGap: number;
}
export const geoDiagStore = createStore<GeoDiag>({ arrivals: [], accepted: 0, rejected: { stale: 0, coarse: 0, jump: 0 }, maxGap: 0 });

export function recordArrival(verdict: 'accept' | 'stale' | 'coarse' | 'jump', now = Date.now()) {
  geoDiagStore.set((s) => {
    const last = s.arrivals[s.arrivals.length - 1];
    return {
      arrivals: [...s.arrivals, now].slice(-30),
      accepted: s.accepted + (verdict === 'accept' ? 1 : 0),
      rejected: verdict === 'accept' ? s.rejected : { ...s.rejected, [verdict]: s.rejected[verdict] + 1 },
      maxGap: last ? Math.max(s.maxGap, now - last) : s.maxGap,
    };
  });
}

/** Средний интервал между последними точками, с. */
export function meanInterval(arrivals: number[]): number | null {
  if (arrivals.length < 2) return null;
  return (arrivals[arrivals.length - 1] - arrivals[0]) / (arrivals.length - 1) / 1000;
}

/** Для длительного теста (scripts/soak.mjs): счётчики без открытия панели. */
if (typeof window !== 'undefined') (window as unknown as { __aceDiag?: unknown }).__aceDiag = { map: () => mapDiagStore.get(), geo: () => geoDiagStore.get() };


/** Только в памяти и только при включённой панели. */
type FixVerdict = 'accept' | 'stale' | 'coarse' | 'jump';
export const positionSampleStore = createStore<{ fix: RawFix; verdict: FixVerdict } | null>(null);
export const mapPositionStore = createStore<{ marker: LatLon; target: LatLon; following: boolean } | null>(null);
export function recordPositionSample(fix: RawFix, verdict: FixVerdict) {
  if (diagModeStore.get().on) positionSampleStore.set({ fix, verdict });
}
diagModeStore.subscribe(() => {
  if (diagModeStore.get().on) return;
  positionSampleStore.set(null);
  mapPositionStore.set(null);
});
