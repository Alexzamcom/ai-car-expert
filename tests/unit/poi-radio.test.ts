import { describe, it, expect } from 'vitest';
import overpass from '../fixtures/overpass-fuel.json';
import rb from '../fixtures/radio-browser.json';
import osrm from '../fixtures/osrm-route.json';
import { buildQuery, parseOverpass } from '../../src/lib/poi';
import { filterPlayable } from '../../src/lib/player';
import { parseOsrm, distanceToRoute } from '../../src/lib/routing';

describe('POI', () => {
  it('запрос Overpass вдоль ломаной', () => {
    const q = buildQuery('fuel', { radius: 1000, points: [{ lat: 55.7, lon: 37.6 }, { lat: 55.8, lon: 37.7 }] });
    expect(q).toContain('nwr["amenity"="fuel"](around:1000,55.70000,37.60000,55.80000,37.70000)');
    expect(q).toContain('out center');
  });
  it('разбор ответа: узлы и полигоны, названия', () => {
    const items = parseOverpass(overpass, 'fuel');
    expect(items.map((i) => i.name)).toEqual(['Лукойл', 'Роснефть', 'Газпромнефть']);
    expect(items[2]).toMatchObject({ lat: 55.758, lon: 37.614 });
  });
  it('расстояние от АЗС до маршрута', () => {
    const route = parseOsrm(osrm);
    const [luk] = parseOverpass(overpass, 'fuel');
    expect(distanceToRoute(route, luk).dist).toBeLessThan(300);
  });
});

describe('Radio Browser', () => {
  it('оставляет только HTTPS MP3/AAC', () => {
    const list = filterPlayable(rb);
    expect(list.map((s) => s.name)).toEqual(['Радио Тест FM', 'Радіо Україна Тест']);
    expect(list.every((s) => s.url.startsWith('https://'))).toBe(true);
  });
});
