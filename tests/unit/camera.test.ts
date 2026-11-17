import { describe, it, expect } from 'vitest';
import { followZoom, lookAheadOffset, courseUpPadding, nextCameraMode, speedBand } from '../../src/lib/camera';

describe('Камера навигации', () => {
  it('упреждение: центр карты впереди по курсу — машинка ниже/позади центра', () => {
    const [nx, ny] = lookAheadOffset(0, 1024, 1366); // на север, iPad вертикально
    expect(Math.abs(Math.round(nx))).toBe(0);
    expect(ny).toBeLessThan(-300); // центр выше машинки
    const [ex, ey] = lookAheadOffset(90, 1024, 1366); // на восток
    expect(ex).toBeGreaterThan(250);
    expect(Math.abs(Math.round(ey))).toBe(0);
    const [sx, sy] = lookAheadOffset(180, 1366, 1024); // на юг, горизонтально
    expect(Math.abs(Math.round(sx))).toBe(0);
    expect(sy).toBeGreaterThan(250);
  });
  it('упреждение не выводит машинку за экран в обеих ориентациях', () => {
    for (const [w, h] of [[1024, 1366], [1366, 1024], [393, 852], [852, 393]]) {
      for (let a = 0; a < 360; a += 15) {
        const [dx, dy] = lookAheadOffset(a, w, h);
        expect(Math.abs(dx)).toBeLessThan(w / 2 - 20);
        expect(Math.abs(dy)).toBeLessThan(h / 2 - 20);
      }
    }
  });
  it('масштаб по скорости и полосы', () => {
    expect([followZoom(null), followZoom(30), followZoom(70), followZoom(120)]).toEqual([17, 17, 16, 15]);
    expect(speedBand(49)).toBe(speedBand(10));
    expect(speedBand(51)).not.toBe(speedBand(49));
  });
  it('по движению: машинка в нижней трети', () => {
    expect(courseUpPadding(1366).top).toBeGreaterThan(1366 / 3);
  });
  it('кнопка режима: по движению ⇄ север; без поворота карты — только север', () => {
    expect(nextCameraMode('course', true)).toBe('north');
    expect(nextCameraMode('north', true)).toBe('course');
    expect(nextCameraMode('free', true)).toBe('course');
    expect(nextCameraMode('course', false)).toBe('north');
  });
});

import { autoZoom } from '../../src/lib/camera';
describe('Автомасштаб при ведении', () => {
  it('на прямой — по скорости; перед манёвром — ближе, плавно', () => {
    expect(autoZoom(30, 2000)).toBeCloseTo(16.6, 1);
    expect(autoZoom(120, 2000)).toBeCloseTo(14.6, 1);
    const far = autoZoom(40, 400);
    const mid = autoZoom(40, 200);
    const near = autoZoom(40, 80);
    expect(mid).toBeGreaterThan(far);
    expect(near).toBeGreaterThanOrEqual(mid);
    expect(near).toBeLessThanOrEqual(18.2);
    // Непрерывность: нет скачка на границе 300 м.
    expect(Math.abs(autoZoom(40, 299) - autoZoom(40, 301))).toBeLessThan(0.05);
  });
});
