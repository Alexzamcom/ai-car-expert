import { describe, expect, it } from 'vitest';
import { verticalSwipe } from '../../src/lib/drivingControls';

describe('Свайп панели ведения', () => {
  it('распознаёт движения вверх и вниз', () => {
    expect(verticalSwipe(6, -55)).toBe('up');
    expect(verticalSwipe(-10, 55)).toBe('down');
  });

  it('игнорирует касание, диагональное движение', () => {
    expect(verticalSwipe(0, 8)).toBeNull();
    expect(verticalSwipe(40, 45)).toBeNull();
  });
});
