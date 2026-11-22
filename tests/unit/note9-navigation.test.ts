import { describe, expect, it } from 'vitest';
import { advance, Estimator, type Fix } from '../../src/lib/autonomy/estimator';
import { goodFix, roadAnchor } from '../../src/lib/autonomy/gnss';
import { haversine } from '../../src/lib/routing';

const start = { lat: 48.46, lon: 35.04 };
const epoch = 30_000;
const road = [start, advance(start, 0, 2000)];
const estimator = () => new Estimator({ position: start, heading: 0, at: epoch }, road, 'adaptive');
const fix = (distance: number, sec: number, accuracy = 4): Fix => ({
  ...advance(start, 0, distance), at: epoch + sec * 1000, accuracy, speed: 10,
});
function send(e: Estimator, sample: Fix) {
  e.update({ type: 'tick', at: sample.at });
  return e.update({ type: 'gps', sample });
}

describe('Экспериментальное ведение Note 9', () => {
  it('проезжает километр даже без поступательного сигнала IMU', () => {
    const e = estimator();
    for (let sec = 0; sec <= 100; sec++) {
      send(e, fix(sec * 10, sec));
      e.update({ type: 'motion', sample: { at: epoch + sec * 1000, x: 0, y: 0, yawRate: 0 } });
    }
    expect(e.state.source).toBe('gnss');
    expect(haversine(e.state, start)).toBeCloseTo(1000, 0);
    expect(e.state.distance.fused).toBeCloseTo(1000, 0);
    expect(e.state.distance.gps).toBeGreaterThan(970);
    expect(e.state.distance.sensors).toBe(0);
    expect(e.state.speed).toBe(10);
  });
  it('отклоняет скачок, не принимает его скорость и переводит оценку в резерв', () => {
    const e = estimator();
    for (let sec = 0; sec < 4; sec++) send(e, fix(sec * 10, sec));
    const position = e.state;
    const rejected = send(e, { ...fix(3500, 4), speed: 42 });
    expect(rejected.source).toBe('hybrid');
    expect(rejected.gps).toBe('rejected');
    expect(rejected.speed).toBe(10);
    expect(haversine(position, rejected)).toBe(0);
    expect(e.update({ type: 'tick', at: epoch + 11_000 }).source).toBe('inertial');
    expect(e.state.uncertainty).toBeGreaterThan(position.uncertainty);
  });
  it('не принимает неподтверждённый старт и неоднозначные параллельные дороги', () => {
    expect(goodFix(fix(0, 0, 35), epoch)).toBe(false);
    expect(goodFix(fix(0, 0), epoch + 5000)).toBe(false);
    const parallel = road.map((p) => advance(p, 90, 10));
    expect(roadAnchor(advance(start, 90, 5), [road, parallel])).toBeUndefined();
    expect(roadAnchor(advance(start, 90, 1), [road, parallel])?.dist).toBeCloseTo(1);
  });
});
