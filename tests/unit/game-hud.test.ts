import { expect, it } from 'vitest';
import { approachHudProgress, canAlignGameHud, GameHudGeometry } from '../../src/lib/gameHud';
import { advance } from '../../src/lib/autonomy/estimator';
import type { Route } from '../../src/lib/routing';
import { DEFAULT_HUD } from '../../src/lib/hud';

const start = { lat: 48, lon: 35 };
const first = advance(start, 0, 90);
const second = advance(first, 90, 35);
const finish = advance(second, 0, 65);
const coords = [start, first, second, finish];
const route: Route = { coords, distance: 190, duration: 35, steps: coords.map((location, index) => ({
  location, distance: 0, duration: 0, name: '', type: index === 0 ? 'depart' : index === 3 ? 'arrive' : 'turn',
})) };

it('preserves classic as the default and requires recent aligned measured progress for the game HUD', () => {
  expect(DEFAULT_HUD.style).toBe('classic');
  const input = { fresh: true, held: false, accuracy: 6, offRoute: 2, trusted: true };
  expect(canAlignGameHud(input)).toBe(true);
  expect(canAlignGameHud({ ...input, held: true })).toBe(false);
  expect(canAlignGameHud({ ...input, fresh: false })).toBe(false);
  expect(canAlignGameHud({ ...input, trusted: false })).toBe(false);
  expect(canAlignGameHud({ ...input, offRoute: Infinity })).toBe(false);
});

it('uses a saved route to project perspective and two successive turns without network data', () => {
  const scene = new GameHudGeometry(JSON.parse(JSON.stringify(route)));
  const turn = scene.offsets[1];
  const before = scene.scene(turn - 55, 1, 400, 760);
  const closer = scene.scene(turn - 35, 1, 400, 760);
  expect(before.road[0].scale).toBe(1);
  expect(before.road.at(-1)!.scale).toBeLessThan(0.3);
  expect(before.road.some((point) => point.x > 225)).toBe(true);
  expect(closer.chevrons[0].point.y).toBeGreaterThan(before.chevrons[0].point.y);
  expect(scene.scene(turn - 2, 1, 400, 760).chevrons[0].angle).toBeGreaterThan(0.25);
  expect(scene.scene(turn + 10, 1, 400, 760).chevrons).toHaveLength(0);
  expect(scene.scene(turn + 10, 2, 400, 760).chevrons.length).toBeGreaterThan(0);
  expect(scene.scene(turn + 10, null, 400, 760).chevrons).toHaveLength(0);
});

it('interpolates accepted displacement without moving when progress is stationary', () => {
  expect(approachHudProgress(10, 10, 0.033)).toBe(10);
  let shown = 10;
  for (let i = 0; i < 50; i++) {
    const next = approachHudProgress(shown, 30, 0.033);
    expect(next).toBeGreaterThanOrEqual(shown);
    expect(next).toBeLessThanOrEqual(30);
    shown = next;
  }
  expect(shown).toBeCloseTo(30, 0);
});
