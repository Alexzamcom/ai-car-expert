import { describe, expect, it } from 'vitest';
import { verticalSwipe } from '../../src/lib/drivingControls';

describe('Свайп панели ведения', () => {
  it('распознаёт быстрые движения вверх и вниз', () => {
    expect(verticalSwipe(6, -55, 220)).toBe('up');
    expect(verticalSwipe(-10, 55, 220)).toBe('down');
  });

  it('игнорирует касание, диагональное движение и длинное нажатие', () => {
    expect(verticalSwipe(0, 8, 60)).toBeNull();
    expect(verticalSwipe(40, 45, 220)).toBeNull();
    expect(verticalSwipe(0, 50, 800)).toBeNull();
  });
});
