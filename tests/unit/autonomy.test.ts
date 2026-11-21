import { describe, expect, it } from 'vitest';
import { advance, Estimator, type Origin } from '../../src/lib/autonomy/estimator';
import { createTrip, record, replay } from '../../src/lib/autonomy/trip';
import { haversine, type Route } from '../../src/lib/routing';

const origin: Origin = { position: { lat: 48.46, lon: 35.04 }, heading: 0, at: 1000 };
const north = advance(origin.position, 0, 21);
const east = advance(north, 90, 110);
const far = advance(origin.position, 140, 5000);
function feed(e: Estimator, from: number, count: number, x: number, y = 0, yawRate = 0) {
  for (let n = 0; n < count; n++) e.update({ type: 'motion', sample: { at: from + n * 50, x, y, yawRate } });
}
const fix = (e: Estimator, at: number, point = far, speed = 0) => e.update({
  type: 'gps', sample: { ...point, at, accuracy: 3, speed },
});

describe('Автономная поездка', () => {
  it('стартует с ручного положения и сохраняет его при получении любого GPS', () => {
    for (const variant of ['inertial', 'road', 'hybrid'] as const) {
      const e = new Estimator(origin, [origin.position, north, east], variant);
      fix(e, 2000);
      fix(e, 3000);
      expect(haversine(e.state, origin.position)).toBeLessThan(0.001);
      expect(e.state.heading).toBe(0);
    }
  });
  it('калибрует произвольный горизонтальный угол держателя по разгону и останавливается при торможении', () => {
    for (const [x, y] of [[2, 0], [0, 2], [-1.2, 1.6]]) {
      const e = new Estimator(origin, [], 'inertial');
      feed(e, 1000, 40, x, y);
      const speed = e.state.speed;
      const travelled = haversine(e.state, origin.position);
      feed(e, 3000, 60, 0);
      expect(speed).toBeGreaterThan(2);
      expect(haversine(e.state, origin.position)).toBeGreaterThan(travelled + 5);
      feed(e, 6000, 40, -x, -y);
      feed(e, 8000, 20, 0);
      expect(e.state.stopped).toBe(true);
      expect(e.state.speed).toBe(0);
    }
  });
  it('сопоставляет реальный поворот с ближайшим углом маршрута и повышает уверенность', () => {
    const road = [origin.position, north, east];
    const matched = new Estimator(origin, road, 'road');
    const raw = new Estimator(origin, road, 'inertial');
    for (const e of [matched, raw]) {
      feed(e, 1000, 60, 4 - 0.1);
      feed(e, 4000, 35, 0, 0, 50);
      expect(e.state.heading).toBeGreaterThan(85);
    }
    expect(matched.state.uncertainty).toBeLessThan(raw.state.uncertainty);
    expect(haversine(matched.state, north)).toBeLessThan(25);
  });
  it('отбрасывает скачок, неподвижный GPS при движении и ложное движение поперёк курса', () => {
    const e = new Estimator(origin, [], 'hybrid');
    feed(e, 1000, 75, 3);
    const baseline = e.state;
    fix(e, 5000, far, 12);
    expect(fix(e, 6000, origin.position, 12).gps).toBe('rejected');
    expect(fix(e, 7000, origin.position, 0).gps).toBe('rejected');
    expect(fix(e, 9000, advance(origin.position, 90, 24), 12).gps).toBe('rejected');
    expect(haversine(e.state, baseline)).toBe(0);
  });
  it('даже согласованный GPS используется только как относительная скорость', () => {
    const e = new Estimator(origin, [], 'hybrid');
    feed(e, 1000, 75, 3);
    const baseline = e.state;
    fix(e, 5000, far, 10);
    expect(fix(e, 7000, advance(far, 0, 20), 10).gps).toBe('relative');
    expect(haversine(e.state, baseline)).toBe(0);
    expect(haversine(e.state, far)).toBeGreaterThan(4900);
  });
  it('накапливает погрешность, сбрасывает скорость при паузе и принимает ручную коррекцию', () => {
    const e = new Estimator(origin, [], 'road');
    feed(e, 1000, 160, 1);
    const uncertainty = e.state.uncertainty;
    e.update({ type: 'pause', at: 9000 });
    expect(e.state.uncertainty).toBeGreaterThan(uncertainty);
    expect(e.state.speed).toBe(0);
    e.update({ type: 'correction', position: north, heading: 90, at: 10000 });
    expect(e.state.heading).toBe(90);
    expect(e.state.lat).toBe(north.lat);
    expect(e.state.uncertainty).toBe(12);
  });
  it('воспроизводит запись с независимой меткой и сравнивает варианты без координатной привязки к GPS', () => {
    const route = { coords: [origin.position, north, east] } as Route;
    const trip = createTrip(origin, route, 'road');
    const e = new Estimator(origin, route.coords, 'road');
    for (let n = 0; n < 100; n++) {
      const input = { type: 'motion', sample: { at: 1000 + n * 50, x: n < 40 ? 2 : 0, y: 0, yawRate: 0 } } as const;
      record(trip, input, e.update(input));
    }
    const serialized = JSON.parse(JSON.stringify(trip));
    const ref = [{ at: 1000, position: origin.position }];
    const baseline = replay(serialized, 'road', 'blackout', ref);
    expect(baseline.endpoint).toEqual(e.state);
    expect(baseline.referenceCount).toBe(1);
    expect(baseline.rmsM).toBeCloseTo(0);
    for (const scenario of ['frozen', 'jump', 'smooth'] as const) {
      expect(replay(serialized, 'road', scenario).endpoint).toEqual(e.state);
    }
  });
});
