import { describe, expect, it } from 'vitest';
import { HybridPosition, type PositionObservation } from '../../src/lib/geo/hybridPosition';
import { advance } from '../../src/lib/autonomy/estimator';
import { haversine } from '../../src/lib/routing';
const a = { lat: 48.46, lon: 35.04 };
const epoch = 10_000;
function observation(m: number, t: number, extra: Partial<PositionObservation> = {}): PositionObservation {
  return { ...advance(a, 0, m), at: epoch + t, source: 'gps', speed: 10, heading: 0, accuracy: 4, ...extra };
}
const fix = (h: HybridPosition, data: PositionObservation, now = data.at) => h.update({ kind: 'position', data }, now);
const motion = (h: HybridPosition, t: number, yawRate = 0, north = 0) => h.update({ kind: 'motion', data: { at: epoch + t, yawRate, north, east: 0 } }, epoch + t);
function moving() {
  const h = new HybridPosition();
  for (let i = 0; i < 4; i++) fix(h, observation(i * 10, i * 1000));
  return h;
}

describe('Нативное позиционирование Android', () => {
  it('отдаёт предпочтение свежему GNSS при одновременно доступном Wi-Fi', () => {
    const h = new HybridPosition();
    expect(fix(h, observation(0, 0, { source: 'network', accuracy: 90 }))).toBeNull();
    expect(fix(h, observation(0, 0, { source: 'fused' }))).toBeNull();
    expect(fix(h, observation(0, 100, { source: 'gps' }))).toBeNull();
    expect(fix(h, observation(10, 1000))?.trust).toBe('confirmed');
    expect(fix(h, observation(14, 1700, { source: 'network', accuracy: 38 }))).toBeNull();
    expect(h.state?.source).toBe('gps');
  });
  it('различает сетевой старт, отсутствие точки и прямой GPS без интернета', () => {
    const h = new HybridPosition();
    expect(h.state).toBeNull();
    expect(fix(h, observation(0, 0, { source: 'fused', mock: true }))).toBeNull();
    expect(fix(h, observation(0, 0), epoch + 8000)).toBeNull();
    expect(fix(h, observation(0, 1000, { source: 'network', accuracy: 37 }))).toMatchObject({ trust: 'network', source: 'network', speed: null });
    expect(moving().state?.source).toBe('gps');
  });
  it('уточняет ошибочную сетевую точку холодного старта только после двух точных отсчётов', () => {
    const h = new HybridPosition();
    expect(fix(h, observation(700, 0, { source: 'network', accuracy: 40 }))?.trust).toBe('network');
    expect(fix(h, observation(0, 1000))).toBeNull();
    expect(fix(h, observation(710, 1600, { source: 'network', accuracy: 41 }))?.trust).toBe('network');
    h.tick(epoch + 4500);
    expect(fix(h, observation(10, 4800))).toMatchObject({ ...advance(a, 0, 10), trust: 'confirmed' });
  });
  it('отбрасывает даже несколько согласованных между собой точек другого города с правдоподобной скоростью', () => {
    const h = moving();
    const p = h.state!;
    for (let i = 4; i < 12; i++) {
      fix(h, observation(i * 10, i * 1000, { lat: 50.45, lon: 30.52, speed: 9, source: i % 2 ? 'gps' : 'fused' }));
      expect(h.state?.trust).toBe('held');
      expect(h.state?.speed).toBeNull();
      expect(haversine(p, h.state!)).toBeLessThan(0.01);
    }
  });
  it('отдельно не принимает спутниковую скорость при неподвижных координатах', () => {
    const h = moving();
    fix(h, observation(30, 4000, { speed: 27 }));
    expect(h.state).toMatchObject({ trust: 'confirmed', speed: null, speedSource: 'unknown' });
  });
  it('с датчиками сохраняет оценку, растит неопределённость и постепенно восстанавливается', () => {
    const h = moving();
    const p = h.state!;
    for (let t = 3200; t < 6700; t += 100) motion(h, t);
    expect(h.state?.trust).toBe('estimated');
    expect(h.state?.accuracy).toBeGreaterThan(p.accuracy);
    expect(haversine(p, h.state!)).toBeGreaterThan(5);
    const before = h.state!;
    expect(fix(h, observation(63, 6800))).toBeNull();
    expect(fix(h, observation(64, 7400))).toBeNull();
    const recovering = fix(h, observation(68, 8100));
    expect(recovering).toMatchObject({ trust: 'recovering' });
    expect(haversine(before, recovering!)).toBeLessThanOrEqual(12.1);
  });
  it('принимает подтверждённый поворот и непрерывный съезд с маршрута', () => {
    const h = moving();
    for (let t = 3000; t <= 4000; t += 100) motion(h, t, 90);
    const east = advance(advance(a, 0, 30), 90, 10);
    const turn = fix(h, observation(0, 4100, { ...east, heading: 90 }));
    expect(turn?.trust).toBe('confirmed');
    expect(turn?.heading).toBeGreaterThan(45);
    expect(haversine(turn!, east)).toBeLessThan(0.01);
  });
  it('останавливает поворот от шума при нулевой независимой скорости', () => {
    const h = moving();
    h.update({ kind: 'odometer', data: { at: epoch + 3400, source: 'obd', speedMps: 0 } }, epoch + 3400);
    for (let t = 3500; t <= 3750; t += 50) motion(h, t, 90);
    fix(h, observation(30, 3800, { speed: 35, heading: 200 }));
    expect(h.state).toMatchObject({ heading: 0, speed: 0, speedSource: 'obd' });
  });
});
