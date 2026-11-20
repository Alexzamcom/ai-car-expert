/* Привязка к дороге: параллельные дороги, развязки, перекрёстки, остановки, потеря GPS, реальный уход с маршрута. */
import { describe, it, expect } from 'vitest';
import { Matcher, walk, distM, candidates, type RoadLine, type MatchFix } from '../../src/lib/matching/matcher';

const O = { lat: 55.75, lon: 37.62 };
/** Метры (x — восток, y — север) → координаты. */
const P = (x: number, y: number) => ({ lat: O.lat + y / 111_320, lon: O.lon + x / (111_320 * Math.cos((O.lat * Math.PI) / 180)) });
const line = (id: string, pts: [number, number][], extra: Partial<RoadLine> = {}): RoadLine => ({ id, coords: pts.map(([x, y]) => P(x, y)), oneway: 0, kind: 'road', ...extra });
/** Псевдослучайный шум GPS (повторяемый). */
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const fix = (x: number, y: number, t: number, o: Partial<MatchFix> = {}): MatchFix => ({ ...P(x, y), accuracy: 8, speed: 14, heading: 0, t: t * 1000, ...o });
/** Смещение отображаемой точки от линии (м). */
const offLine = (p: { lat: number; lon: number }, l: RoadLine) => candidates({ ...p, accuracy: 5, speed: null, heading: null, t: 0 }, [l], 1e4)[0].dist;

describe('Привязка к дороге', () => {
  it('едем на север, рядом диагональная улица (~55°) в 9 м — к ней не привязываем', () => {
    const diag = line('diag', [[-200, -150], [200, 140]]);
    const m = new Matcher();
    let r;
    for (let t = 0; t < 5; t++) r = m.update(fix(-8, t * 12 - 20, t, { heading: 0, speed: 12 }), [diag]);
    expect(r!.mode).toBe('raw');
  });

  it('ось из маршрута и дубликаты из тайлов не снижают уверенность в одной дороге', () => {
    const axis: [number, number][] = [[0, -200], [0, 200]];
    const m = new Matcher();
    const r = m.update(fix(6, 0, 1), [
      line('route:0', axis, { kind: 'route', oneway: 1 }),
      line('tile-a', axis),
      line('tile-b', [...axis].reverse()),
    ]);
    expect(r).toMatchObject({ mode: 'matched', lineId: 'route:0', bearing: 0 });
    expect(r.shift).toBeCloseTo(6, 0);
  });

  it('курс исключает поперечную ось даже когда браузер не отдаёт скорость', () => {
    const east = line('east', [[-150, 12], [150, 12]]);
    const north = line('north', [[6, -150], [6, 150]]);
    const m = new Matcher();
    m.update(fix(0, 0, 0, { speed: null }), [east, north]);
    const r = m.update(fix(0, 12, 1, { speed: null }), [east, north]);
    expect(r).toMatchObject({ mode: 'matched', lineId: 'north', bearing: 0 });
  });

  it('синтетический поворот: выбирает подходящий отрезок той же линии, даже если он на 2 м дальше', () => {
    const bend = line('road', [[0, -100], [0, 0], [100, 0]]);
    const m = new Matcher();
    m.update(fix(0, -18, 0), [bend]);
    m.update(fix(0, -5, 1), [bend]);
    const turn = m.update(fix(3, -5, 2, { accuracy: 5, speed: 8, heading: 90 }), [bend]);
    expect(turn).toMatchObject({ mode: 'matched', lineId: 'road', bearing: 90 });
    expect(m.current?.seg).toBe(1);
    expect(distM(turn, P(3, 0))).toBeLessThan(1);
  });

  it('нет данных о дорогах — сырая точка, без ложной привязки', () => {
    const m = new Matcher();
    const r = m.update(fix(3, 0, 0), []);
    expect(r).toMatchObject({ mode: 'raw', lineId: null });
  });

  it('грубая точка (±150 м) не привязывается', () => {
    const m = new Matcher();
    const r = m.update(fix(5, 0, 0, { accuracy: 150 }), [line('a', [[0, -500], [0, 500]])]);
    expect(r.mode).toBe('raw');
  });

  it('параллельная дорога в 18 м: машинка держится своей, несмотря на шум к соседней', () => {
    const main = line('main', [[0, -1000], [0, 1000]], { cls: 'primary' });
    const side = line('side', [[18, -1000], [18, 1000]], { cls: 'service' });
    const m = new Matcher();
    const ids: (string | null)[] = [];
    for (let t = 0; t < 30; t++) {
      // Шум до ±8 м, иногда точка ближе к соседней дороге.
      const x = rnd() * 6 + (t % 7 === 3 ? 10 : 0);
      ids.push(m.update(fix(x, t * 14, t, { accuracy: 10 }), [main, side]).lineId);
    }
    expect(ids.slice(2).every((id) => id === 'main')).toBe(true);
  });

  it('встречные проезжие части в 14 м (односторонние): выбор по курсу, а не по расстоянию', () => {
    const north = line('north', [[0, -1000], [0, 1000]], { oneway: 1, cls: 'trunk' });
    const south = line('south', [[14, 1000], [14, -1000]], { oneway: 1, cls: 'trunk' });
    const m = new Matcher();
    let r;
    // Едем на юг, а GPS смещён к северной проезжей части.
    for (let t = 0; t < 6; t++) r = m.update(fix(4, 500 - t * 14, t, { heading: 180 }), [north, south]);
    expect(r!.lineId).toBe('south');
    expect(r!.mode).not.toBe('raw');
  });

  it('развязка: съезд под малым углом — переход на съезд после расхождения, без скачков', () => {
    const hw = line('hw', [[0, -1000], [0, 2000]], { oneway: 1, cls: 'motorway' });
    // Съезд отходит от магистрали в точке (0, 200) вправо под ~15°.
    const ramp = line('ramp', [[0, 200], [27, 300], [80, 400], [160, 480]], { oneway: 1, cls: 'motorway' });
    const m = new Matcher();
    // По магистрали до начала съезда, затем по съезду (каждые 25 м).
    const path: { p: { lat: number; lon: number }; h: number }[] = [];
    for (let y = 0; y < 200; y += 25) path.push({ p: P(0, y), h: 0 });
    for (let k = 0; k <= 10; k++) {
      const p = walk(ramp.coords, 0, 0, 25 * k)!;
      const q = walk(ramp.coords, 0, 0, 25 * k + 5)!;
      const h = ((Math.atan2((q.lon - p.lon) * Math.cos((O.lat * Math.PI) / 180), q.lat - p.lat) * 180) / Math.PI + 360) % 360;
      path.push({ p, h });
    }
    let prev: { lat: number; lon: number } | null = null;
    let maxJump = 0;
    const ids: (string | null)[] = [];
    path.forEach(({ p, h }, t) => {
      const r = m.update({ ...p, lon: p.lon + (rnd() * 3) / 70_000, accuracy: 8, speed: 25, heading: h, t: t * 1000 }, [hw, ramp]);
      if (prev) maxJump = Math.max(maxJump, distM(prev, r));
      prev = r;
      ids.push(r.lineId);
    });
    expect(ids.slice(0, 8).every((id) => id === 'hw')).toBe(true);
    expect(ids.slice(-3).every((id) => id === 'ramp')).toBe(true);
    expect(maxJump).toBeLessThan(45); // шаг ~25–30 м за секунду, без скачка на соседнюю полосу
  });

  it('перекрёсток: поворот направо — переход на поперечную улицу', () => {
    const ns = line('ns', [[0, -500], [0, 500]]);
    const ew = line('ew', [[-500, 300], [500, 300]]);
    const m = new Matcher();
    let r;
    for (let y = 150; y <= 300; y += 10) r = m.update(fix(rnd() * 3, y, y / 10, { heading: 0, speed: 8 }), [ns, ew]);
    expect(r!.lineId).toBe('ns');
    for (let x = 10; x <= 80; x += 10) r = m.update(fix(x, 300 + rnd() * 3, 30 + x / 10, { heading: 90, speed: 8 }), [ns, ew]);
    expect(r!.lineId).toBe('ew');
    expect(offLine(r!, ew)).toBeLessThan(1);
  });

  it('остановка: шум на месте не уводит машинку на другую дорогу', () => {
    const a = line('a', [[0, -500], [0, 500]]);
    const b = line('b', [[16, -500], [16, 500]]);
    const m = new Matcher();
    for (let t = 0; t < 5; t++) m.update(fix(rnd() * 2, t * 10, t, { speed: 10 }), [a, b]);
    const ids = new Set<string | null>();
    let drift = 0;
    let first: { lat: number; lon: number } | null = null;
    for (let t = 5; t < 25; t++) {
      const r = m.update(fix(5 + rnd() * 6, 40 + rnd() * 6, t, { speed: 0, heading: 0 }), [a, b]);
      ids.add(r.lineId);
      first ??= r;
      drift = Math.max(drift, distM(first, r));
    }
    expect([...ids]).toEqual(['a']);
    expect(drift).toBeLessThan(15);
  });

  it('потеря GPS: короткий прогноз вдоль дороги, затем остановка прогноза; неопределённость растёт', () => {
    const a = line('a', [[0, -500], [0, 1500]]);
    const m = new Matcher();
    for (let t = 0; t < 5; t++) m.update(fix(0, t * 15, t, { speed: 15 }), [a]);
    const last = 4000;
    expect(m.predict(last + 1000)).toBeNull(); // ещё не потеря
    const p2 = m.predict(last + 1600)!;
    const p3 = m.predict(last + 1950)!;
    expect(p2.mode).toBe('predicted');
    expect(p2.lat).toBeGreaterThan(P(0, 60).lat + 20 / 111_320); // продвинулись вперёд ~24 м
    expect(p3.accuracy).toBeGreaterThan(p2.accuracy);
    expect(offLine(p3, a)).toBeLessThan(1);
    expect(m.predict(last + 2600)).toBeNull(); // не дольше 2 с
  });

  it('точки пачкой (0,1 с между ними) не дают «433 км/ч»: прогноз не уносит машинку дальше 40 м', () => {
    const a = line('a', [[0, -500], [0, 1500]]);
    const m = new Matcher();
    for (let t = 0; t < 5; t++) m.update(fix(0, t * 12, t, { speed: null }), [a]);
    // после паузы — две точки почти одновременно, вторая на 12 м дальше
    m.update(fix(0, 60, 6, { speed: null }), [a]);
    m.update({ ...fix(0, 72, 6, { speed: null }), t: 6100 }, [a]);
    const p = m.predict(6100 + 1900);
    if (p) expect(p.shift).toBeLessThanOrEqual(40);
    if (p) expect(p.reason).not.toMatch(/\d{3} км\/ч/);
  });

  it('курс неизвестен на двусторонней дороге — прогноза нет (направление не угадываем, машинка не разворачивается назад)', () => {
    const a = line('a', [[0, 1500], [0, -500]]); // линия нарисована с севера на юг, едем на север
    const m = new Matcher();
    for (let t = 0; t < 5; t++) m.update(fix(0, t * 15, t, { speed: 15, heading: null }), [a]);
    expect(m.predict(4000 + 1700)).toBeNull();
  });

  it('прогноз по курсу: едем на север по линии, нарисованной на юг, — машинка идёт вперёд, курс ~0°', () => {
    const a = line('a', [[0, 1500], [0, -500]]);
    const m = new Matcher();
    for (let t = 0; t < 5; t++) m.update(fix(0, t * 15, t, { speed: 15, heading: 0 }), [a]);
    const p = m.predict(4000 + 1700)!;
    expect(p.mode).toBe('predicted');
    expect(p.lat).toBeGreaterThan(P(0, 60).lat);
    expect(Math.min(p.bearing!, 360 - p.bearing!)).toBeLessThan(5);
  });

  it('на малой скорости (≤ 30 км/ч) прогноза нет: на стоянке iOS может не присылать точки', () => {
    const a = line('a', [[0, -500], [0, 1500]]);
    const m = new Matcher();
    for (let t = 0; t < 5; t++) m.update(fix(0, t * 5, t, { speed: 5 }), [a]);
    expect(m.predict(4000 + 1800)).toBeNull();
  });

  it('стоим давно (здание, парковка): к дороге в 15 м не привязываем, причина записана', () => {
    const a = line('a', [[0, -500], [0, 500]]);
    const m = new Matcher();
    let r;
    for (let t = 0; t < 40; t++) r = m.update(fix(15, 0, t, { speed: 0, heading: null, accuracy: 25 }), [a]);
    expect(r!.mode).toBe('raw');
    expect(r!.reason).toMatch(/стоим/);
  });

  it('дорога дальше 20 м — без привязки даже при плохой точности', () => {
    const a = line('a', [[0, -500], [0, 500]]);
    const m = new Matcher();
    const r = m.update(fix(28, 0, 0, { accuracy: 40 }), [a]);
    expect(r.mode).toBe('raw');
    expect(r.reason).toMatch(/без привязки/);
  });

  it('причина выбора дороги и смещение — для диагностики', () => {
    const a = line('a', [[0, -500], [0, 500]], { cls: 'primary' });
    const b = line('b', [[30, -500], [30, 500]]);
    const m = new Matcher();
    const r = m.update(fix(4, 0, 0), [a, b]);
    expect(r.reason).toMatch(/^a \(primary\): 4 м/);
    expect(r.reason).toMatch(/вторая b/);
    expect(r.shift).toBeCloseTo(4, 0);
  });

  it('стоим — прогноза нет', () => {
    const a = line('a', [[0, -500], [0, 500]]);
    const m = new Matcher();
    for (let t = 0; t < 4; t++) m.update(fix(0, 10, t, { speed: 0 }), [a]);
    expect(m.predict(3000 + 2500)).toBeNull();
  });

  it('реальный уход с маршрута (есть дороги): машинка на новой дороге, а не на старом маршруте', () => {
    const route = line('route', [[0, -500], [0, 1000]], { kind: 'route', oneway: 1 });
    const side = line('side', [[0, 300], [400, 300]]);
    const m = new Matcher();
    let r;
    for (let y = 200; y <= 300; y += 10) r = m.update(fix(0, y, y / 10, { heading: 0 }), [route, side]);
    for (let x = 15; x <= 120; x += 15) r = m.update(fix(x, 300 + rnd() * 2, 30 + x / 15, { heading: 90 }), [route, side]);
    expect(r!.lineId).toBe('side');
  });

  it('реальный уход с маршрута (дорог нет, только маршрут): сырая точка, без «прилипания»', () => {
    const route = line('route', [[0, -500], [0, 1000]], { kind: 'route', oneway: 1 });
    const m = new Matcher();
    let r;
    for (let y = 200; y <= 300; y += 10) r = m.update(fix(0, y, y / 10, { heading: 0 }), [route]);
    expect(r!.mode).toBe('matched');
    const modes: string[] = [];
    for (let x = 15; x <= 120; x += 15) {
      r = m.update(fix(x, 300, 30 + x / 15, { heading: 90 }), [route]);
      modes.push(r.mode);
    }
    expect(modes.slice(-4).every((x) => x === 'raw')).toBe(true);
    expect(distM(r!, P(120, 300))).toBeLessThan(1);
  });

  it('движение против направления маршрута (разворот) — маршрут не притягивает', () => {
    const route = line('route', [[0, -500], [0, 1000]], { kind: 'route', oneway: 1 });
    const m = new Matcher();
    let r;
    for (let t = 0; t < 4; t++) r = m.update(fix(9, 300 - t * 14, t, { heading: 180 }), [route]);
    expect(r!.mode).not.toBe('matched');
  });

  it('проход по линии вперёд и назад', () => {
    const c = [P(0, 0), P(0, 100), P(100, 100)];
    expect(distM(walk(c, 0, 0.5, 100)!, P(50, 100))).toBeLessThan(0.5);
    expect(distM(walk(c, 1, 0.5, -100)!, P(0, 50))).toBeLessThan(0.5);
  });
});
