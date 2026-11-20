/* Три позиции раздельно: сырая (решения ведения), отображаемая (привязка), прогноз (только показ). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleFix, geoStore, __resetGeo, setDestination, startGuidance, stopNavigation, navStore, visibleRouteCoords, type RawFix } from '../../src/lib/nav';
import { displayStore, __tickDisplay, setRoadProvider } from '../../src/lib/matching/display';
import { diagModeStore, positionSampleStore } from '../../src/lib/diag';
import { distM } from '../../src/lib/matching/matcher';
import osrm from '../fixtures/osrm-route.json';

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear() };
}
const coords = osrm.routes[0].geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
/** Точка в m метрах по первому отрезку маршрута, со сдвигом side метров вбок (вправо по ходу). */
const seg0 = Math.hypot((coords[1].lat - coords[0].lat) * 111_320, (coords[1].lon - coords[0].lon) * 111_320 * Math.cos((coords[0].lat * Math.PI) / 180));
const at = (m: number, side = 0) => {
  const k = m / seg0;
  const dy = (coords[1].lat - coords[0].lat) * 111_320;
  const dx = (coords[1].lon - coords[0].lon) * 111_320 * Math.cos((coords[0].lat * Math.PI) / 180);
  const [nx, ny] = [dy / seg0, -dx / seg0]; // вправо от направления
  return { lat: coords[0].lat + (coords[1].lat - coords[0].lat) * k + (ny * side) / 111_320, lon: coords[0].lon + (coords[1].lon - coords[0].lon) * k + (nx * side) / (111_320 * Math.cos((coords[0].lat * Math.PI) / 180)) };
};

describe('Отображаемая позиция и решения ведения', () => {
  const dest = { id: 'd', name: 'Театр', address: '', lat: 55.779, lon: 37.617 };
  let t = Date.now();
  const fix = (p: { lat: number; lon: number }, o: Partial<RawFix> = {}) => {
    t += 1000;
    handleFix({ ...p, accuracy: 8, speed: 10, heading: null, timestamp: t, ...o }, t, 'high');
  };
  beforeEach(async () => {
    __resetGeo();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date(1_900_000_000_000));
    t = Date.now();
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal('navigator', { onLine: true, userAgent: 'test' });
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify(osrm), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    vi.stubGlobal('window', { speechSynthesis: { cancel: vi.fn(), speak: vi.fn(), getVoices: () => [] } });
    vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(public text: string) {} });
    fix(coords[0]);
    await setDestination(dest);
    startGuidance();
  });
  afterEach(() => {
    diagModeStore.set({ on: false });
    setRoadProvider(null);
    __resetGeo();
    stopNavigation();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('точные входные данные для панели хранятся только при включённой диагностике', () => {
    diagModeStore.set({ on: false });
    fix(at(12));
    expect(positionSampleStore.get()).toBeNull();
    diagModeStore.set({ on: true });
    const pos = at(25);
    fix(pos, { heading: 320 });
    expect(positionSampleStore.get()).toMatchObject({ fix: { ...pos, heading: 320, timestamp: t }, verdict: 'accept' });
    diagModeStore.set({ on: false });
    expect(positionSampleStore.get()).toBeNull();
  });

  it('кешированный стартовый GPS не привязывается и не блокирует свежую точку худшей заявленной точности', () => {
    stopNavigation();
    __resetGeo();
    setRoadProvider(() => [{ id: 'tile-road', coords: coords.slice(0, 2), kind: 'road', oneway: 0 }]);
    const cached = at(36, 5);
    fix(cached, { accuracy: 5, speed: 12, heading: 320, timestamp: t - 60_000 });
    expect(displayStore.get()).toMatchObject({ mode: 'raw', ...cached });
    vi.setSystemTime(t + 1800);
    __tickDisplay();
    expect(displayStore.get().mode).toBe('raw');
    const fresh = at(48, 5);
    fix(fresh, { accuracy: 32, speed: 12, heading: null });
    expect(geoStore.get()).toMatchObject({ ...fresh, held: null });
    expect(displayStore.get()).toMatchObject({ mode: 'matched', mapRoads: 1, lineId: 'tile-road' });
  });

  it('без курса браузера не принимает сглаженный курс за наблюдение', () => {
    fix(at(0), { speed: 10, heading: 270 });
    fix(at(2), { speed: 10, heading: null });
    expect(geoStore.get().heading).not.toBeNull();
    expect(displayStore.get().course).toBeNull();
    fix(at(20), { speed: null, heading: null });
    expect(displayStore.get().course).not.toBeNull();
  });

  it('при отсутствии тайлов использует только близкий маршрут и показывает сырой GPS при съезде', () => {
    setRoadProvider(() => []);
    fix(at(30, 4));
    expect(displayStore.get()).toMatchObject({ mode: 'matched', mapRoads: 0, routeRoads: 1 });
    const outside = at(50, 42);
    fix(outside, { speed: 0 });
    expect(displayStore.get()).toMatchObject({ ...outside, mode: 'raw', mapRoads: 0, lineId: null });
  });

  it('точка в 7 м от маршрута: машинка на дороге, а сырая точка и прогресс — по GPS', () => {
    for (let m = 12; m <= 60; m += 12) fix(at(m, 1));
    const raw = at(72, 7);
    fix(raw);
    const d = displayStore.get();
    expect(d.mode).toBe('matched');
    expect(distM(d as { lat: number; lon: number }, raw)).toBeGreaterThan(4); // показана на линии маршрута
    expect(geoStore.get()).toMatchObject({ lat: raw.lat, lon: raw.lon }); // сырая — без изменений
    expect(navStore.get().progress!.offRouteM).toBeGreaterThan(4); // решения — по сырой точке
  });

  it('новый маршрут публикуется сразу от последней принятой точки, даже если машина успела проехать вперёд', async () => {
    fix(at(28));
    const oldLine = visibleRouteCoords();
    expect(oldLine[0]).not.toEqual(coords[0]);

    const next = structuredClone(osrm);
    const newStart = at(28);
    next.routes[0].geometry.coordinates[0] = [newStart.lon, newStart.lat];
    let respond!: (response: Response) => void;
    vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => { respond = resolve; }));
    const request = setDestination(dest, null, true);
    t += 8_000;
    vi.setSystemTime(t);
    const current = at(238);
    fix(current);
    respond(new Response(JSON.stringify(next), { status: 200 }));
    await request;

    expect(navStore.get().status).toBe('guiding');
    expect(navStore.get().routeCutM).toBeGreaterThan(200);
    const newLine = visibleRouteCoords();
    expect(distM(newLine[0], current)).toBeLessThan(1);
    expect(visibleRouteCoords()).toBe(newLine);
    expect(navStore.get().route?.coords[0]).toEqual(newStart);
  });

  it('прибытие не засчитывается по привязанной позиции, только по сырой', () => {
    const last = coords[coords.length - 1];
    // GPS в 45 м от цели (поперёк), привязка могла бы «дотянуть» до линии — но прибытия нет.
    fix({ lat: last.lat, lon: last.lon + 45 / (111_320 * Math.cos((last.lat * Math.PI) / 180)) });
    expect(navStore.get().status).toBe('guiding');
  });

  it('потеря сигнала: прогноз только в показе, сырая позиция и ведение не двигаются', () => {
    for (let m = 12; m <= 60; m += 12) fix(at(m), { speed: 12 });
    const raw = { ...geoStore.get() };
    const p0 = navStore.get().progress;
    vi.setSystemTime(t + 1900); // 1,9 с без новых точек
    __tickDisplay();
    const d = displayStore.get();
    expect(d.mode).toBe('predicted');
    expect(distM(d as { lat: number; lon: number }, raw as { lat: number; lon: number })).toBeGreaterThan(15); // ~12 м/с × 1,9 с вперёд
    expect(geoStore.get().lat).toBe(raw.lat);
    expect(navStore.get().progress).toBe(p0);
    vi.setSystemTime(t + 2500);
    __tickDisplay();
    expect(displayStore.get()).toMatchObject({ lat: d.lat, lon: d.lon, confidence: 0 });
  });
});
