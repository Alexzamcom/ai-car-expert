import { describe, expect, it } from 'vitest';
import { maneuverNotice } from '../../src/lib/androidDriving';
import { cumulative, routeProgress, type Route } from '../../src/lib/routing';
import { advance } from '../../src/lib/autonomy/estimator';

const a = { lat: 48.5, lon: 35.04 };
const b = advance(a, 0, 600);
const c = advance(b, 90, 50);
const d = advance(c, 0, 290);
const route: Route = { coords: [a, b, c, d], distance: 940, duration: 90, steps: [
  { location: a, type: 'depart', modifier: 'straight', name: '', distance: 600, duration: 50 },
  { location: b, type: 'turn', modifier: 'right', name: '', distance: 50, duration: 8 },
  { location: c, type: 'turn', modifier: 'left', name: '', distance: 290, duration: 32 },
  { location: d, type: 'arrive', name: '', distance: 0, duration: 0 },
] };

describe('Контекстные подсказки Android', () => {
  it('показывает один и тот же поворот раньше на трассе, чем в городе', () => {
    const progress = routeProgress(route, advance(a, 0, 300));
    expect(maneuverNotice(route, progress, 35, true)).toBeNull();
    expect(maneuverNotice(route, progress, 105, true)?.step.modifier).toBe('right');
    expect(maneuverNotice(route, routeProgress(route, advance(a, 0, 580)), 35, true)?.urgent).toBe(true);
  });
  it('удерживает первый манёвр при раннем переключении прогресса, затем сразу показывает второй', () => {
    const approaching = routeProgress(route, advance(a, 0, 597));
    expect(approaching.stepIndex).toBe(2);
    expect(maneuverNotice(route, approaching, 30, true)?.step.modifier).toBe('right');
    const leaving = routeProgress(route, advance(b, 90, 13));
    expect(maneuverNotice(route, leaving, 30, true)?.step.modifier).toBe('left');
  });
  it('при потере надёжности оставляет направление без точного расстояния', () => {
    const total = cumulative(route.coords).at(-1)!;
    const cue = maneuverNotice(route, { segIndex: 0, offRouteM: 5, remainingM: total - 575, stepIndex: 1, toStepM: 25 }, 35, false);
    expect(cue).toMatchObject({ distance: null, urgent: false });
    expect(cue?.step.modifier).toBe('right');
  });
});
