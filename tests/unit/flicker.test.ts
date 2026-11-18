/* Регрессия: мерцание MapLibre каждые 1–2 с и потеря точных точек GPS. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computeTheme, themeChanged } from '../../src/lib/theme';
import { acceptFix, handleFix, geoStore, __resetGeo, type RawFix } from '../../src/lib/nav';
import { geoDiagStore } from '../../src/lib/diag';

describe('Тема не «меняется» от каждой точки GPS', () => {
  const now = new Date('2026-11-18T10:00:00Z');
  it('сдвиг на метры меняет время заката на миллисекунды — это не смена темы (карта не перезагружает стиль)', () => {
    const a = computeTheme('auto', now, { lat: 55.757, lon: 37.6156 }, true);
    const b = computeTheme('auto', now, { lat: 55.75705, lon: 37.61562 }, true);
    expect(a.next?.at).not.toBe(b.next?.at); // причина мерцания: время отличается…
    expect(themeChanged(a, b)).toBe(false); // …но смены темы нет
  });
  it('настоящая смена (день → ночь, ручной режим) — смена', () => {
    const day = computeTheme('day', now, null, false);
    const night = computeTheme('night', now, null, false);
    expect(themeChanged(day, night)).toBe(true);
    const a = computeTheme('auto', now, { lat: 55.757, lon: 37.6156 }, true);
    const far = computeTheme('auto', now, { lat: 55.757, lon: 60.6 }, true); // другой часовой пояс — закат на часы раньше
    expect(themeChanged(a, far)).toBe(true);
  });
});

const T0 = 1_800_000_000_000;
const P = { lat: 55.757, lon: 37.6156 };
const east = (m: number) => P.lon + m / (111_320 * Math.cos((P.lat * Math.PI) / 180));
const fix = (o: Partial<RawFix> = {}): RawFix => ({ ...P, accuracy: 8, speed: null, heading: null, timestamp: T0, ...o });
function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear() };
}

describe('Точные точки GPS не теряются после ошибочной', () => {
  beforeEach(() => {
    __resetGeo();
    vi.stubGlobal('localStorage', memoryStorage());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('точная точка после неточной (Wi-Fi ошибся на 300 м) принимается сразу, а не через 30 с', () => {
    const wifi = { ...fix({ lon: east(300), accuracy: 45 }), at: T0 };
    expect(acceptFix(wifi, fix({ accuracy: 9, timestamp: T0 + 1000 }), T0 + 1000)).toBe('accept');
  });
  it('настоящий скачок при той же точности по-прежнему отбрасывается', () => {
    const prev = { ...fix(), at: T0 };
    expect(acceptFix(prev, fix({ lon: east(2000), accuracy: 9, timestamp: T0 + 1000 }), T0 + 1000)).toBe('jump');
  });
  it('две «невозможные» точки подряд согласны между собой — переходим на них (ошибалась прежняя)', () => {
    handleFix(fix({ accuracy: 15 }), T0);
    handleFix(fix({ lon: east(800), accuracy: 12, timestamp: T0 + 1000 }), T0 + 1000);
    expect(geoStore.get().lon).toBe(P.lon); // первая — отброшена
    handleFix(fix({ lon: east(810), accuracy: 12, timestamp: T0 + 2000 }), T0 + 2000);
    expect(geoStore.get().lon).toBeCloseTo(east(810), 6); // вторая подтвердила
  });
  it('диагностика считает принятые и отброшенные точки и паузы', () => {
    const before = geoDiagStore.get().accepted;
    handleFix(fix(), T0);
    handleFix(fix({ lon: east(5000), timestamp: T0 + 1000 }), T0 + 1000);
    const d = geoDiagStore.get();
    expect(d.accepted).toBe(before + 1);
    expect(d.rejected.jump).toBeGreaterThan(0);
  });
});
