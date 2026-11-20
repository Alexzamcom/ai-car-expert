/* Геопозиция: быстрая доступная точка, затем уточнение; приблизительная точка показывается, но не ведёт. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Locator, QUICK_OPTS, HIGH_OPTS, LOW_OPTS, LOW_FALLBACK_AFTER_MS, type FixSource, type GeoErrorInfo } from '../../src/lib/geo/locator';
import { handleFix, handleGeoError, geoStore, __resetGeo, geoStatusText, guidanceUse, setDestination, startGuidance, stopNavigation, navStore, type RawFix } from '../../src/lib/nav';
import osrm from '../fixtures/osrm-route.json';

/* ---------- Поддельный Geolocation API ---------- */
type Cb = (p: GeolocationPosition) => void;
type Eb = (e: GeolocationPositionError) => void;
function fakeEnv() {
  let t = 0;
  let nextId = 1;
  const watches = new Map<number, { ok: Cb; err: Eb; opts: PositionOptions }>();
  const once: { ok: Cb; err: Eb; opts: PositionOptions }[] = [];
  const timers: { at: number; fn: () => void; every?: number; id: number }[] = [];
  const geo = {
    getCurrentPosition: (ok: Cb, err: Eb, opts: PositionOptions) => void once.push({ ok, err, opts }),
    watchPosition: (ok: Cb, err: Eb, opts: PositionOptions) => {
      const id = nextId++;
      watches.set(id, { ok, err, opts });
      return id;
    },
    clearWatch: (id: number) => void watches.delete(id),
  };
  const deps = {
    geo: geo as unknown as Geolocation,
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ at: t + ms, fn, id });
      return id;
    },
    clearTimer: (id: unknown) => void timers.splice(timers.findIndex((x) => x.id === id) >>> 0, 1),
    setInterval: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ at: t + ms, fn, every: ms, id });
      return id;
    },
    clearInterval: (id: unknown) => {
      const i = timers.findIndex((x) => x.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      const due = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      t = due.at;
      if (due.every) due.at += due.every;
      else timers.splice(timers.indexOf(due), 1);
      due.fn();
    }
    t = end;
  };
  const pos = (accuracy: number): GeolocationPosition =>
    ({ coords: { latitude: 55.75, longitude: 37.61, accuracy, speed: null, heading: null, altitude: null, altitudeAccuracy: null }, timestamp: t }) as unknown as GeolocationPosition;
  const err = (code: number) => ({ code, message: 'x', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }) as GeolocationPositionError;
  const byOpts = (o: PositionOptions) => [...watches.entries()].filter(([, w]) => w.opts === o);
  return { deps, watches, once, advance, pos, err, byOpts };
}

function makeLocator() {
  const env = fakeEnv();
  const fixes: [number, FixSource][] = [];
  const errors: GeoErrorInfo[] = [];
  const loc = new Locator(env.deps, (p, s) => fixes.push([p.coords.accuracy, s]), (e) => errors.push(e));
  return { env, loc, fixes, errors };
}

describe('Locator: два этапа', () => {
  it('сразу: быстрый запрос без высокой точности с кешем и слежение с высокой точностью', () => {
    const { env, loc } = makeLocator();
    loc.start();
    expect(env.once).toHaveLength(1);
    expect(env.once[0].opts).toBe(QUICK_OPTS);
    expect(QUICK_OPTS.enableHighAccuracy).toBe(false);
    expect(QUICK_OPTS.maximumAge).toBeGreaterThan(0); // позиция, которую устройство уже знает, не отбрасывается
    expect(env.byOpts(HIGH_OPTS)).toHaveLength(1);
    expect(HIGH_OPTS.enableHighAccuracy).toBe(true);
    expect(env.byOpts(LOW_OPTS)).toHaveLength(0); // запасное слежение — только при необходимости
  });

  it('быстрая приблизительная точка приходит до точной — передаётся сразу', () => {
    const { env, loc, fixes } = makeLocator();
    loc.start();
    env.once[0].ok(env.pos(900));
    expect(fixes).toEqual([[900, 'quick']]);
  });

  it('в здании высокая точность молчит — включается запасное слежение; точная точка его выключает', () => {
    const { env, loc, fixes } = makeLocator();
    loc.start();
    env.advance(LOW_FALLBACK_AFTER_MS + 4000);
    const low = env.byOpts(LOW_OPTS);
    expect(low).toHaveLength(1);
    low[0][1].ok(env.pos(65));
    expect(fixes.at(-1)).toEqual([65, 'low']);
    env.byOpts(HIGH_OPTS)[0][1].ok(env.pos(8));
    expect(env.byOpts(LOW_OPTS)).toHaveLength(0);
    // Сигнал снова пропал — через время запасное слежение возвращается.
    env.advance(LOW_FALLBACK_AFTER_MS + 4000);
    expect(env.byOpts(LOW_OPTS)).toHaveLength(1);
  });

  it('тайм-аут высокой точности — сразу запасное слежение, высокая точность продолжает работать', () => {
    const { env, loc, errors } = makeLocator();
    loc.start();
    env.byOpts(HIGH_OPTS)[0][1].err(env.err(3));
    expect(errors[0]).toMatchObject({ kind: 'timeout', source: 'high' });
    expect(env.byOpts(LOW_OPTS)).toHaveLength(1);
    expect(env.byOpts(HIGH_OPTS)).toHaveLength(1);
  });

  it('«устройство не сообщает позицию» — перезапуск слежения с паузой', () => {
    const { env, loc } = makeLocator();
    loc.start();
    const [id] = env.byOpts(HIGH_OPTS)[0];
    env.byOpts(HIGH_OPTS)[0][1].err(env.err(2));
    env.advance(5000);
    const [id2] = env.byOpts(HIGH_OPTS)[0];
    expect(id2).not.toBe(id);
    expect(env.byOpts(HIGH_OPTS)).toHaveLength(1);
  });

  it('запрет — всё остановлено, без повторных запросов', () => {
    const { env, loc, errors } = makeLocator();
    loc.start();
    env.byOpts(HIGH_OPTS)[0][1].err(env.err(1));
    expect(errors[0].kind).toBe('denied');
    expect(env.watches.size).toBe(0);
    env.advance(60_000);
    expect(env.watches.size).toBe(0);
    expect(loc.state.running).toBe(false);
  });

  it('перезапуск (возврат в приложение) — снова быстрый запрос и одно слежение', () => {
    const { env, loc } = makeLocator();
    loc.start();
    env.advance(LOW_FALLBACK_AFTER_MS + 4000);
    loc.restart();
    expect(env.once).toHaveLength(2);
    expect(env.byOpts(HIGH_OPTS)).toHaveLength(1);
    expect(env.byOpts(LOW_OPTS)).toHaveLength(0);
  });
});

/* ---------- Состояние позиции ---------- */
const T0 = 1_800_000_000_000;
const P = { lat: 55.757, lon: 37.6156 };
const fix = (p: Partial<RawFix> = {}): RawFix => ({ ...P, accuracy: 8, speed: null, heading: null, timestamp: T0, ...p });

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear() };
}

describe('Позиция: приблизительная сразу, затем точнее', () => {
  beforeEach(() => {
    __resetGeo();
    vi.stubGlobal('localStorage', memoryStorage());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('без точки — «Определяю местоположение…», без требования выйти на открытое место', () => {
    geoStore.set((s) => ({ ...s, status: 'watching' }));
    const st = geoStatusText(geoStore.get())!;
    expect(st.text).toBe('Определяю местоположение…');
    expect(st.help()).not.toMatch(/открыт/i);
    handleGeoError({ code: 3, kind: 'timeout', message: '', source: 'high', at: T0 });
    expect(geoStatusText(geoStore.get())!.text).toContain('дольше обычного');
    expect(geoStore.get().status).toBe('watching'); // тайм-аут — не «недоступно»
  });

  it('приблизительная точка показывается сразу с честной точностью, точная её уточняет', () => {
    handleFix(fix({ accuracy: 150, lat: P.lat + 0.001 }), T0, 'quick');
    expect(geoStore.get()).toMatchObject({ lat: P.lat + 0.001, accuracy: 150, quality: 'approx', source: 'quick' });
    expect(geoStatusText(geoStore.get(), T0)!.text).toBe('Приблизительно, ±150 м — уточняю');
    handleFix(fix({ timestamp: T0 + 2000 }), T0 + 2000, 'high');
    expect(geoStore.get()).toMatchObject({ lat: P.lat, accuracy: 8, quality: 'precise', source: 'high' });
    expect(geoStatusText(geoStore.get(), T0 + 2000)).toBeNull();
  });

  it('запасная менее точная точка рядом с точной не сдвигает машинку и не пугает «слабым сигналом»', () => {
    handleFix(fix(), T0, 'high');
    handleFix(fix({ accuracy: 70, lat: P.lat + 0.0006, timestamp: T0 + 1000 }), T0 + 1000, 'low');
    expect(geoStore.get()).toMatchObject({ lat: P.lat, accuracy: 8, held: null });
  });

  it('точная пропала (туннель, здание) — через 30 с принимается приблизительная, лучше чем ничего', () => {
    handleFix(fix(), T0, 'high');
    handleFix(fix({ accuracy: 400, lat: P.lat + 0.002, timestamp: T0 + 40_000 }), T0 + 40_000, 'low');
    expect(geoStore.get()).toMatchObject({ lat: P.lat + 0.002, quality: 'coarse' });
  });

  it('сохранённая устройством позиция: показываем и честно пишем возраст', () => {
    handleFix(fix({ accuracy: 40, timestamp: T0 - 4 * 60_000 }), T0, 'quick');
    expect(geoStore.get().lat).toBe(P.lat);
    expect(geoStatusText(geoStore.get(), T0)!.text).toContain('4 мин назад');
  });

  it('ошибки: запрет — подсказка; «не сообщает» без точки — пробую снова', () => {
    handleGeoError({ code: 2, kind: 'unavailable', message: '', source: 'high', at: T0 });
    expect(geoStatusText(geoStore.get())!.text).toContain('пробую снова');
    handleGeoError({ code: 1, kind: 'denied', message: '', source: 'high', at: T0 });
    expect(geoStore.get()).toMatchObject({ status: 'denied', permission: 'denied' });
    expect(geoStatusText(geoStore.get())!.text).toContain('Нет доступа');
  });

  it('ведение: точная — всё, 50–100 м — только прогресс, хуже — только показ', () => {
    expect([guidanceUse(10), guidanceUse(50), guidanceUse(80), guidanceUse(100), guidanceUse(150)]).toEqual(['full', 'full', 'progress', 'progress', 'display']);
  });
});

describe('Ведение по неточным точкам: без ложных поворотов и перестроений', () => {
  const dest = { id: 'd', name: 'Театр', address: '', lat: 55.779, lon: 37.617 };
  let fetches = 0;
  const speak = vi.fn();
  beforeEach(async () => {
    __resetGeo();
    fetches = 0;
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal('navigator', { onLine: true, userAgent: 'test' });
    vi.stubGlobal('fetch', () => {
      fetches++;
      return Promise.resolve(new Response(JSON.stringify(osrm), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });
    speak.mockClear();
    vi.stubGlobal('window', { speechSynthesis: { cancel: vi.fn(), speak, getVoices: () => [] } });
    vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(public text: string) {} });
    handleFix({ ...P, accuracy: 8, speed: null, heading: null, timestamp: Date.now() });
    await setDestination(dest);
    startGuidance();
  });
  afterEach(() => {
    stopNavigation();
    vi.unstubAllGlobals();
  });

  const far = (acc: number, k: number) => handleFix({ lat: P.lat, lon: P.lon + 0.01 + k * 0.00001, accuracy: acc, speed: null, heading: null, timestamp: Date.now() + k * 40_000 }, Date.now() + k * 40_000, 'low');

  it('приблизительные точки далеко от маршрута не вызывают перестроение', () => {
    const before = fetches;
    for (let k = 1; k <= 5; k++) far(80, k);
    expect(fetches).toBe(before);
    expect(navStore.get().rerouting).toBe(false);
  });

  it('очень грубая точка не сдвигает прогресс по маршруту', () => {
    const p0 = navStore.get().progress;
    far(400, 1);
    expect(geoStore.get().accuracy).toBe(400); // на карте показана
    expect(navStore.get().progress).toBe(p0); // ведение не тронуто
  });

  it('не принимает проекцию на конец маршрута за прибытие с соседней улицы', () => {
    const now = Date.now() + 90_000;
    handleFix({ ...dest, lon: dest.lon + 0.0025, accuracy: 8, speed: 5, heading: 0, timestamp: now }, now);
    expect(navStore.get().progress?.remainingM).toBeLessThan(30);
    expect(navStore.get().status).toBe('guiding');
  });

  it('не озвучивает прибытие как предстоящий манёвр', () => {
    const now = Date.now() + 90_000;
    handleFix({ ...dest, lat: dest.lat - 0.00135, accuracy: 8, speed: 5, heading: 0, timestamp: now }, now);
    expect(navStore.get().route?.steps[navStore.get().progress!.stepIndex].type).toBe('arrive');
    expect(navStore.get().status).toBe('guiding');
    expect(speak.mock.calls.map(([utterance]) => utterance.text).join(' ')).not.toMatch(/Вы прибыли/);
  });

  it('у цели по неточной точке «вы прибыли» не срабатывает', () => {
    handleFix({ lat: dest.lat, lon: dest.lon, accuracy: 90, speed: null, heading: null, timestamp: Date.now() + 60_000 }, Date.now() + 60_000, 'low');
    expect(navStore.get().status).toBe('guiding');
    handleFix({ lat: dest.lat, lon: dest.lon, accuracy: 10, speed: null, heading: null, timestamp: Date.now() + 61_000 }, Date.now() + 61_000, 'high');
    expect(navStore.get().status).toBe('arrived');
  });
});
