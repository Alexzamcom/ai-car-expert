import { describe, expect, it } from 'vitest';
import { areaBounds, areaTiles } from '../../src/lib/offlineMaps';

describe('Границы загрузки OpenFreeMap', () => {
  it('покрывает выбранный район во всех зумах и не дублирует запросы', () => {
    const tiles = areaTiles(areaBounds({ lat: 55.75, lon: 37.6 }, 4));
    expect(tiles[0]).toEqual([0, 0, 0]);
    expect(tiles.at(-1)?.[0]).toBe(14);
    expect(new Set(tiles.map((tile) => tile.join('/'))).size).toBe(tiles.length);
    expect(tiles.length).toBeLessThan(3000);
  });
  it('ограничивает размер запроса и диапазон XYZ', () => {
    expect(() => areaTiles([-180, -85, 180, 85])).toThrow(/лимит/);
    for (const [z, x, y] of areaTiles(areaBounds({ lat: 79, lon: 180 }, 4))) {
      expect(x).toBeLessThan(2 ** z);
      expect(y).toBeLessThan(2 ** z);
    }
  });
});
