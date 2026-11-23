import { describe, expect, it } from 'vitest';
import { VehicleAnimation } from '../../src/lib/vehicleAnimation';
import { advance } from '../../src/lib/autonomy/estimator';
import { haversine } from '../../src/lib/routing';

const origin = { lat: 48.45, lon: 35.04 };
const target = { ...origin, heading: 1, roadHeading: 0, speedMps: 10, reliable: true };
describe('Кадры автомобиля Android', () => {
  it('интерполирует независимо от секундных отсчётов GPS и не принимает боковой курс', () => {
    const animation = new VehicleAnimation();
    animation.receive(target, 0);
    animation.receive({ ...target, ...advance(origin, 0, 10), heading: 38, predict: true }, 1000);
    let last = animation.frame(1000)!;
    for (let t = 1016; t <= 1850; t += 16) {
      const frame = animation.frame(t)!;
      expect(haversine(last, frame)).toBeLessThan(1.5);
      expect(frame.heading).toBe(0);
      last = frame;
    }
    expect(haversine(origin, last)).toBeGreaterThan(12);
    expect(haversine(origin, last)).toBeLessThan(20);
  });
  it('удерживает место и курс при GPS-шуме на остановке и при медленном ходе допускает реальное перемещение', () => {
    const a = new VehicleAnimation();
    a.receive(target, 0);
    a.receive({ ...target, ...advance(origin, 120, 4), heading: 120, speedMps: 0.1 }, 1000);
    expect(a.frame(1020)).toMatchObject({ ...origin, heading: 0 });
    a.receive({ ...target, ...advance(origin, 0, 7), speedMps: 0.8, heading: 170 }, 2000);
    const next = a.frame(2020)!;
    expect(haversine(next, origin)).toBeGreaterThan(0);
    expect(next.heading).toBe(0);
  });
  it('плавно меняет курс на реальном повороте, пропускает неверный фикс и восстанавливается без скачка', () => {
    const a = new VehicleAnimation();
    a.receive(target, 0);
    a.receive({ ...target, ...advance(origin, 90, 300), reliable: false }, 1000);
    expect(a.frame(1500)).toMatchObject({ ...origin, heading: 0 });
    a.receive({ ...target, ...advance(origin, 90, 12), roadHeading: 90 }, 2500);
    let pose = a.frame(2516)!;
    expect(pose.heading).toBeGreaterThan(0);
    expect(pose.heading).toBeLessThan(60);
    for (let t = 2532; t < 3100; t += 16) pose = a.frame(t)!;
    expect(pose.heading).toBeGreaterThan(85);
    expect(haversine(origin, pose)).toBeGreaterThan(11);
  });
});
