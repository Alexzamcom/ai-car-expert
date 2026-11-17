import { describe, it, expect } from 'vitest';
import { toCarFrame, routeInCarFrame, hudRangeM, reliableSpeed, hudShowsSpeed, HUD_MODES, DEFAULT_HUD } from '../../src/lib/hud';

const car = { lat: 50.45, lon: 30.52 };
const north = (m: number) => ({ lat: car.lat + m / 111320, lon: car.lon });
const east = (m: number) => ({ lat: car.lat, lon: car.lon + m / (111320 * Math.cos((car.lat * Math.PI) / 180)) });

describe('HUD: координаты автомобиля', () => {
  it('курс на север: точка севернее — впереди, восточнее — справа', () => {
    const [x, y] = toCarFrame(north(100), car, 0);
    expect(Math.abs(x)).toBeLessThan(0.5);
    expect(y).toBeCloseTo(100, 0);
    const [ex, ey] = toCarFrame(east(50), car, 0);
    expect(ex).toBeCloseTo(50, 0);
    expect(Math.abs(ey)).toBeLessThan(0.5);
  });
  it('курс на восток: восток — впереди, север — слева', () => {
    const [x, y] = toCarFrame(east(100), car, 90);
    expect(y).toBeCloseTo(100, 0);
    expect(Math.abs(x)).toBeLessThan(0.5);
    const [nx] = toCarFrame(north(40), car, 90);
    expect(nx).toBeCloseTo(-40, 0);
  });
  it('участок маршрута: немного позади и до запаса впереди', () => {
    const coords = [north(-50), north(0), north(100), north(300), north(900), north(2000)];
    const pts = routeInCarFrame(coords, 1, car, 0, 300);
    expect(pts[0][1]).toBeCloseTo(-50, 0);
    expect(pts.length).toBe(5); // 2000 м — за пределами запаса (300 × 1,8), первая точка за ним включена для непрерывности
  });
});

describe('HUD: масштаб', () => {
  it('на прямой — больше дороги на скорости, перед манёвром — ближе', () => {
    expect(hudRangeM(30, null)).toBe(220);
    expect(hudRangeM(100, null)).toBe(600);
    expect(hudRangeM(60, 100)).toBe(170);
    expect(hudRangeM(60, 40)).toBe(90);
    expect(hudRangeM(60, 5000)).toBe(360);
  });
});

describe('HUD: скорость', () => {
  const now = 1_000_000;
  const g = { speedKmh: 63.6, accuracy: 8, updated: now - 500, held: null };
  it('свежая и точная — показываем', () => {
    expect(reliableSpeed(g, now)).toBe(64);
    expect(reliableSpeed({ ...g, speedKmh: 1.2 }, now)).toBe(0);
  });
  it('устаревшая, неточная, отброшенная или неизвестная — не показываем как точную', () => {
    expect(reliableSpeed({ ...g, updated: now - 5000 }, now)).toBeNull();
    expect(reliableSpeed({ ...g, accuracy: 120 }, now)).toBeNull();
    expect(reliableSpeed({ ...g, held: 'jump' as const }, now)).toBeNull();
    expect(reliableSpeed({ ...g, speedKmh: null }, now)).toBeNull();
  });
  it('режимы: в «Маршрут» скорость скрыта, в остальных — по настройке', () => {
    expect(hudShowsSpeed('route', { showSpeed: true })).toBe(false);
    expect(hudShowsSpeed('route-speed', { showSpeed: true })).toBe(true);
    expect(hudShowsSpeed('map', { showSpeed: false })).toBe(false);
    expect(hudShowsSpeed('minimal', { showSpeed: true })).toBe(true);
  });
  it('четыре режима, зеркальность по умолчанию', () => {
    expect(HUD_MODES.map((m) => m.id)).toEqual(['route', 'route-speed', 'map', 'minimal']);
    expect(DEFAULT_HUD.mirror).toBe(true);
  });
});
