/* Регрессия GPS: машинка не должна оказываться «неизвестно где». */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { acceptFix, classifyAccuracy, updateHeading, angleDiff, handleFix, geoStore, __resetGeo, geoStatusText, readLastPos, type RawFix } from '../../src/lib/nav';
import { unwrapAngle, carSvg, CAR_COLORS } from '../../src/lib/carMarker';

const T0 = 1_800_000_000_000;
const KYIV = { lat: 50.4501, lon: 30.5234 };
const fix = (p: Partial<RawFix> = {}): RawFix => ({ ...KYIV, accuracy: 8, speed: null, heading: null, timestamp: T0, ...p });
/** Смещение на dx метров на восток и dy на север. */
const moved = (dx: number, dy: number, p: Partial<RawFix> = {}) =>
  fix({ lat: KYIV.lat + dy / 111_320, lon: KYIV.lon + dx / (111_320 * Math.cos((KYIV.lat * Math.PI) / 180)), ...p });

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear() };
}

beforeEach(() => {
  __resetGeo();
  vi.stubGlobal('localStorage', memoryStorage());
});
afterEach(() => vi.unstubAllGlobals());

describe('Принятие точек GPS', () => {
  it('первая точка принимается, даже грубая (иначе не будет никакой позиции)', () => {
    expect(acceptFix(null, fix({ accuracy: 3000 }), T0)).toBe('accept');
  });
  it('кешированная старая точка не заменяет свежую', () => {
    const prev = { ...fix(), at: T0 };
    expect(acceptFix(prev, fix({ timestamp: T0 - 3600_000 }), T0 + 1000)).toBe('stale');
    expect(acceptFix(prev, fix({ timestamp: T0 - 1000 }), T0 + 1000)).toBe('stale'); // старее принятой
  });
  it('грубая точка (Wi-Fi/вышки) после точной не двигает машинку…', () => {
    const prev = { ...fix({ accuracy: 10 }), at: T0 };
    expect(acceptFix(prev, moved(1500, 0, { accuracy: 2000, timestamp: T0 + 5000 }), T0 + 5000)).toBe('coarse');
  });
  it('…но через 30 с без точных — принимается (лучше приблизительно, чем никак)', () => {
    const prev = { ...fix({ accuracy: 10 }), at: T0 };
    expect(acceptFix(prev, moved(300, 0, { accuracy: 2000, timestamp: T0 + 40_000 }), T0 + 40_000)).toBe('accept');
  });
  it('невозможный скачок отбрасывается, обычное движение — нет', () => {
    const prev = { ...fix(), at: T0 };
    expect(acceptFix(prev, moved(5000, 0, { accuracy: 10, timestamp: T0 + 1000 }), T0 + 1000)).toBe('jump');
    expect(acceptFix(prev, moved(25, 0, { accuracy: 10, timestamp: T0 + 1000 }), T0 + 1000)).toBe('accept'); // 90 км/ч
    expect(acceptFix(prev, moved(2000, 0, { accuracy: 10, timestamp: T0 + 60_000 }), T0 + 60_000)).toBe('accept');
  });
  it('классы точности', () => {
    expect([classifyAccuracy(5), classifyAccuracy(80), classifyAccuracy(3000)]).toEqual(['precise', 'approx', 'coarse']);
  });
});

describe('Позиция на карте', () => {
  it('широта и долгота не перепутаны, точка — та, что дал GPS', () => {
    handleFix(fix(), T0);
    expect(geoStore.get()).toMatchObject({ lat: 50.4501, lon: 30.5234, quality: 'precise', held: null, status: 'watching' });
  });
  it('грубая точка после точной: машинка остаётся, статус «слабый сигнал»', () => {
    handleFix(fix(), T0);
    handleFix(moved(3000, 0, { accuracy: 3000, timestamp: T0 + 3000 }), T0 + 3000);
    expect(geoStore.get()).toMatchObject({ lat: 50.4501, lon: 30.5234, held: 'coarse' });
    expect(geoStatusText(geoStore.get(), T0 + 3000)?.text).toContain('Слабый сигнал');
  });
  it('приблизительная позиция (точная геопозиция iOS выключена): честный статус с подсказкой', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)', maxTouchPoints: 5 });
    handleFix(fix({ accuracy: 3200 }), T0);
    const st = geoStatusText(geoStore.get(), T0)!;
    expect(st.text).toBe('Приблизительно, ±3.2 км');
    expect(st.help()).toContain('Точная геопозиция');
  });
  it('нет точки — «Определяю местоположение…», запрет — подсказка', () => {
    geoStore.set((s) => ({ ...s, status: 'watching' }));
    expect(geoStatusText(geoStore.get())?.text).toBe('Определяю местоположение…');
    expect(geoStatusText({ ...geoStore.get(), status: 'denied' })?.text).toContain('Нет доступа');
  });
  it('последняя точная позиция сохраняется только для открытия карты', () => {
    handleFix(fix(), Date.now());
    expect(readLastPos()).toEqual(KYIV);
    __resetGeo();
    expect(geoStore.get().lat).toBeNull(); // машинку по сохранённой позиции не рисуем
    handleFix(fix({ accuracy: 3000 }), Date.now());
  });
});

type HS = Parameters<typeof updateHeading>[0];
const H0: HS = { heading: null, anchor: null, at: null };
/** Проехать по точкам: [dx, dy] метров от Киева, шаг по времени 1 с. */
function drive(points: [number, number][], opt: Partial<RawFix> & { start?: HS; road?: { bearing: number; offRouteM: number } | null } = {}) {
  let st = opt.start ?? H0;
  const out: (number | null)[] = [];
  points.forEach(([dx, dy], i) => {
    st = updateHeading(st, moved(dx, dy, { timestamp: T0 + i * 1000, accuracy: opt.accuracy ?? 8, speed: opt.speed ?? null, heading: opt.heading ?? null }), opt.road ?? null);
    out.push(st.heading);
  });
  return { st, out, last: out[out.length - 1] };
}
const east = (n: number, step = 14): [number, number][] => Array.from({ length: n }, (_, i) => [i * step, 0]);

describe('Курс машинки', () => {
  it('стоим: шум GPS не вращает машинку, курс сохраняется', () => {
    const r = drive([[0, 0], [5, -4], [-6, 3], [4, 6], [-3, -5], [2, 2]], { start: { heading: 90, anchor: null, at: null } });
    expect(r.out.every((h) => h === 90)).toBe(true);
    expect(drive([[0, 0], [6, 6]]).last).toBeNull();
  });
  it('едем на восток по точным точкам — курс сходится к 90°', () => {
    expect(drive(east(8)).last).toBeCloseTo(90, 0);
  });
  it('курс устройства — только при уверенном движении и хорошей точности', () => {
    expect(updateHeading(H0, fix({ heading: 180, speed: 10 })).heading).toBe(180);
    expect(updateHeading(H0, fix({ heading: 180, speed: 1 })).heading).toBeNull();
    expect(updateHeading({ ...H0, heading: 30 }, fix({ heading: 180, speed: 10, accuracy: 60 })).heading).toBe(30);
  });
  it('iPad без GPS (Wi-Fi, ±65 м) на маршруте: курс по дороге, а не «на север»', () => {
    const r = drive(east(4, 20), { accuracy: 65, road: { bearing: 90, offRouteM: 20 } });
    expect(r.last).toBe(90);
  });
  it('на маршруте курс GPS поперёк дороги — шум: машинка по дороге', () => {
    const r = drive(east(6), { heading: 0, speed: 10, road: { bearing: 90, offRouteM: 5 } });
    expect(r.last).toBeCloseTo(90, 0);
  });
  it('реальный сход с маршрута — верим GPS, а не дороге', () => {
    const r = drive(east(6), { road: { bearing: 0, offRouteM: 80 } });
    expect(r.last).toBeCloseTo(90, 0);
  });
  it('небольшое расхождение с дорогой — плавно к дороге, но не насильно', () => {
    const h = updateHeading(H0, fix({ heading: 100, speed: 10 }), { bearing: 90, offRouteM: 3 }).heading!;
    expect(h).toBeCloseTo(93, 0);
  });
  it('задний ход: медленно назад — нос машинки не разворачивается', () => {
    const r = drive([[0, 0], [-12, 0], [-24, 0], [-36, 0]], { speed: 2, heading: 270, start: { heading: 90, anchor: null, at: null } });
    expect(r.out.every((h) => h === 90)).toBe(true);
  });
  it('разворот на скорости — плавный, без скачка на 180°', () => {
    const r = drive([[0, 0], [-15, 0], [-30, 0], [-45, 0], [-60, 0], [-75, 0]], { speed: 10, heading: 270, start: { heading: 90, anchor: null, at: null } });
    const steps = r.out.map((h, i) => Math.abs(angleDiff(h!, i ? r.out[i - 1]! : 90)));
    expect(Math.max(...steps)).toBeLessThanOrEqual(105);
    expect(Math.abs(angleDiff(r.last!, 270))).toBeLessThan(20);
  });
  it('поворот на 90° — без рывка: первый шаг не больше 60°', () => {
    const h = updateHeading({ heading: 0, anchor: null, at: T0 }, fix({ heading: 90, speed: 10, timestamp: T0 + 1000 })).heading!;
    expect(h).toBeGreaterThan(30);
    expect(h).toBeLessThanOrEqual(60);
  });
  it('дрожание меньше 3° отсекается; переход через север — по кратчайшей дуге', () => {
    expect(updateHeading({ heading: 90, anchor: null, at: T0 }, fix({ heading: 92, speed: 10, timestamp: T0 + 1000 })).heading).toBe(90);
    const h = updateHeading({ heading: 350, anchor: null, at: T0 }, fix({ heading: 10, speed: 10, timestamp: T0 + 1000 })).heading!;
    expect(Math.abs(angleDiff(h, 357))).toBeLessThan(1);
  });
  it('старая опора (> 15 с) не даёт курс «через угол»', () => {
    const st = { heading: 0, anchor: fix({ timestamp: T0 - 60_000 }), at: T0 - 1000 };
    const r = updateHeading(st, moved(40, 40, { timestamp: T0 }));
    expect(r.heading).toBe(0);
    expect(r.anchor?.timestamp).toBe(T0);
  });
  it('поворот иконки без «кувырка»', () => {
    expect(unwrapAngle(350, 10)).toBe(370);
    expect(unwrapAngle(10, 350)).toBe(-10);
    expect(unwrapAngle(720, 90)).toBe(810);
  });
});

describe('Машинка', () => {
  it('SVG для всех цветов, белый по умолчанию', () => {
    for (const c of Object.keys(CAR_COLORS)) expect(carSvg(c as keyof typeof CAR_COLORS)).toContain('<svg');
    expect(carSvg()).toContain('#f7f8fa');
    expect(carSvg('nope' as never)).toContain('#f7f8fa');
  });
});

import osrm from '../fixtures/osrm-route.json';
import { setDestination, startGuidance, stopNavigation, addStop, setNavigationVoice, guidanceStartCount, navStore } from '../../src/lib/nav';
import { driveUiStore, settingsStore } from '../../src/lib/state';
import { playerStore } from '../../src/lib/player';

describe('Полноэкранное ведение и голос', () => {
  const okJson = (b: unknown) => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const dest = { id: 'd', name: 'Театр', address: '', lat: 55.779, lon: 37.617 };
  beforeEach(() => {
    vi.stubGlobal('navigator', { onLine: true, userAgent: 'test' });
    vi.stubGlobal('fetch', () => okJson(osrm));
    vi.stubGlobal('window', { speechSynthesis: { cancel: vi.fn(), speak: vi.fn(), getVoices: () => [] } });
    vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(public text: string) {} });
    settingsStore.set((s) => ({ ...s, minimalGuidance: true, speakNavigation: true }));
    handleFix({ lat: 55.757, lon: 37.6156, accuracy: 8, speed: null, heading: null, timestamp: Date.now() });
  });
  afterEach(() => stopNavigation());

  it('«Поехали» — полный экран; остановка не выключает его и не повторяет обзор; завершение — обычный интерфейс', async () => {
    await setDestination(dest);
    const starts = guidanceStartCount();
    startGuidance();
    expect(driveUiStore.get().minimal).toBe(true);
    expect(guidanceStartCount()).toBe(starts + 1);
    await addStop({ id: 's', name: 'АЗС', address: '', lat: 55.76, lon: 37.61 });
    expect(navStore.get().status).toBe('guiding');
    expect(driveUiStore.get().minimal).toBe(true);
    expect(guidanceStartCount()).toBe(starts + 1);
    stopNavigation();
    expect(driveUiStore.get().minimal).toBe(false);
  });

  it('настройка выключена — ведение в обычном интерфейсе', async () => {
    settingsStore.set((s) => ({ ...s, minimalGuidance: false }));
    await setDestination(dest);
    startGuidance();
    expect(driveUiStore.get().minimal).toBe(false);
  });

  it('выключение голоса прерывает подсказку, не трогает радио и ведение, сохраняется', async () => {
    await setDestination(dest);
    startGuidance();
    playerStore.set((p) => ({ ...p, playing: true }));
    setNavigationVoice(false);
    expect((window as unknown as { speechSynthesis: { cancel: ReturnType<typeof vi.fn> } }).speechSynthesis.cancel).toHaveBeenCalled();
    expect(settingsStore.get().speakNavigation).toBe(false);
    expect(playerStore.get().playing).toBe(true);
    expect(navStore.get().status).toBe('guiding');
    setNavigationVoice(true);
    expect(settingsStore.get().speakNavigation).toBe(true);
  });
});
