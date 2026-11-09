import { describe, it, expect, vi, afterEach } from 'vitest';
import osrm from '../fixtures/osrm-route.json';
import rb from '../fixtures/radio-browser.json';
import { routeBoxes, buildBoxQuery } from '../../src/lib/poi';
import { parseOsrm, cumulative, type LatLon } from '../../src/lib/routing';
import { searchStations, radioBrowserHosts, __resetRadioHosts, RB_FALLBACK_HOSTS } from '../../src/lib/player';

afterEach(() => {
  vi.unstubAllGlobals();
  __resetRadioHosts();
});

describe('АЗС по маршруту: прямоугольники', () => {
  const route = parseOsrm(osrm);
  it('короткий маршрут — один прямоугольник с запасом коридора', () => {
    const boxes = routeBoxes(route.coords, 1000);
    expect(boxes).toHaveLength(1);
    const [s, w, n, e] = boxes[0];
    for (const c of route.coords) {
      expect(c.lat).toBeGreaterThan(s);
      expect(c.lat).toBeLessThan(n);
      expect(c.lon).toBeGreaterThan(w);
      expect(c.lon).toBeLessThan(e);
    }
    // запас ~1 км ≈ 0,009° широты
    expect(Math.min(...route.coords.map((c) => c.lat)) - s).toBeCloseTo(0.009, 3);
  });
  it('длинный маршрут режется на участки и ограничен 60 км впереди', () => {
    const line: LatLon[] = Array.from({ length: 2001 }, (_, i) => ({ lat: 50 + i * 0.001, lon: 30 })); // ~222 км на север
    expect(cumulative(line).at(-1)!).toBeGreaterThan(200_000);
    const boxes = routeBoxes(line, 1000);
    expect(boxes.length).toBeGreaterThanOrEqual(7);
    expect(boxes.length).toBeLessThanOrEqual(9);
    expect(boxes.at(-1)![2]).toBeLessThan(50 + 0.61); // не дальше ~60 км + коридор
  });
  it('запрос объединяет прямоугольники', () => {
    const q = buildBoxQuery('fuel', [[55.7, 37.5, 55.8, 37.6], [55.8, 37.6, 55.9, 37.7]]);
    expect(q).toBe('[out:json][timeout:12];(nwr["amenity"="fuel"](55.70000,37.50000,55.80000,37.60000);nwr["amenity"="fuel"](55.80000,37.60000,55.90000,37.70000););out center 80;');
  });
});

describe('Каталог радио: серверы', () => {
  it('берёт актуальный список серверов у каталога', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/json/servers')) return new Response(JSON.stringify([{ name: 'nl1.api.radio-browser.info' }, { name: 'evil.example.com' }]));
      return new Response('[]');
    }));
    const hosts = await radioBrowserHosts();
    expect(hosts[0]).toBe('https://nl1.api.radio-browser.info');
    expect(hosts).not.toContain('https://evil.example.com');
  });
  it('если список недоступен — запасные серверы, и поиск идёт дальше при ошибке сервера', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seen.push(url);
      if (url.endsWith('/json/servers')) return new Response('', { status: 503 });
      if (url.startsWith(RB_FALLBACK_HOSTS[0])) return new Response('', { status: 502 });
      return new Response(JSON.stringify(rb));
    }));
    const list = await searchStations({ countrycode: 'UA' });
    expect(list.map((s) => s.name)).toEqual(['Радио Тест FM', 'Радіо Україна Тест']);
    expect(seen.some((u) => u.startsWith(RB_FALLBACK_HOSTS[1]))).toBe(true);
  });
});
