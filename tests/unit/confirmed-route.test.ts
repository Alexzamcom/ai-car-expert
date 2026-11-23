import { describe, expect, it } from 'vitest';
import { ConfirmedRoute, type RouteMeasurement } from '../../src/lib/confirmedRoute';
import { advance } from '../../src/lib/autonomy/estimator';
import { cumulative, routeProgress, stepOffsets, type Route } from '../../src/lib/routing';

const start = { lat: 48, lon: 35 };
const north = advance(start, 0, 120);
const east = advance(north, 90, 14);
const south = advance(east, 180, 120);
const coords = [start, north, east, south];
const route: Route = { coords, distance: 254, duration: 40, steps: coords.map((location, i) => ({
  location, type: ['depart', 'turn', 'turn', 'arrive'][i], modifier: 'right', name: '', distance: 0, duration: 0,
})) };
const cum = cumulative(coords);
const geometry = { cum, offsets: stepOffsets(route, cum) };
const fix = (latLon: { lat: number; lon: number }, at: number, extra: Partial<RouteMeasurement> = {}): RouteMeasurement =>
  ({ ...latLon, at, accuracy: 5, heading: 0, speed: 10, estimated: false, ...extra });

describe('Android confirmed route', () => {
  it('reproduces the old jump to a parallel return leg and keeps the active forward segment', () => {
    const p = advance(advance(start, 0, 37), 90, 8);
    expect(routeProgress(route, p, geometry).segIndex).toBe(2);
    const matcher = new ConfirmedRoute(route, geometry, 30);
    const matched = matcher.update(fix(p, 1000));
    expect(matched.kind).toBe('matched');
    expect(matched.progress.segIndex).toBe(0);
    expect(matched.heading).toBeCloseTo(0, 3);
    expect(matcher.along).toBeCloseTo(37, 0);
  });

  it('does not walk backward after a reverse fix or advance from stationary jitter', () => {
    const matcher = new ConfirmedRoute(route, geometry, 30);
    matcher.update(fix(advance(start, 0, 35), 1000));
    expect(matcher.update(fix(advance(start, 0, 27), 2000)).kind).toBe('held');
    expect(matcher.along).toBeCloseTo(35, 0);
    matcher.update(fix(advance(start, 0, 36), 3000, { speed: 0, accuracy: 10 }));
    matcher.update(fix(advance(start, 0, 38), 4000, { speed: 0, accuracy: 10 }));
    expect(matcher.along).toBeCloseTo(35, 0);
  });

  it('holds without measured motion and advances on a supported odometry increment', () => {
    const matcher = new ConfirmedRoute(route, geometry, 30);
    const p = advance(start, 0, 35);
    expect(matcher.update(fix(p, 1000, { estimated: true, distanceM: 0 })).kind).toBe('held');
    expect(matcher.along).toBe(30);
    expect(matcher.update(fix(p, 2000, { estimated: true, distanceM: 6 })).kind).toBe('estimated');
    expect(matcher.along).toBeCloseTo(35, 0);
    expect(matcher.update(fix(p, 3000, { estimated: true, distanceM: 6, accuracy: 80 })).kind).toBe('held');
  });

  it('checks heading through consecutive bends and restores the same route checkpoint', () => {
    const matcher = new ConfirmedRoute(route, geometry, 118);
    const towardsEast = advance(north, 90, 6);
    const accepted = matcher.update(fix(towardsEast, 2000, { heading: 90, estimated: true, distanceM: 9 }));
    expect(accepted.progress.segIndex).toBe(1);
    const second = advance(east, 180, 6);
    const restored = new ConfirmedRoute(route, geometry, matcher.along);
    const wrong = restored.update(fix(second, 3000, { heading: 0, estimated: true, distanceM: 16 }));
    expect(wrong.progress.segIndex).toBe(1);
    expect(restored.update(fix(second, 4000, { heading: 180, estimated: true, distanceM: 16 })).progress.segIndex).toBe(2);
  });

  it('exposes a wrong turn only after a series and requires fresh evidence after reconnection', () => {
    const matcher = new ConfirmedRoute(route, geometry, 35);
    const off = (x: number) => advance(advance(start, 0, 35), 270, x);
    expect(matcher.update(fix(off(25), 1000)).kind).toBe('held');
    expect(matcher.update(fix(off(32), 1750)).kind).toBe('held');
    expect(matcher.update(fix(off(39), 2500)).kind).toBe('off-route');
    matcher.requireFreshEvidence();
    expect(matcher.update(fix(off(40), 3500)).kind).toBe('held');
    expect(matcher.update(fix(off(45), 4300)).kind).toBe('held');
    expect(matcher.update(fix(off(50), 5100)).kind).toBe('off-route');
    expect(matcher.along).toBe(35);
  });
});
