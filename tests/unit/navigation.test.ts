import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import osrm from '../fixtures/osrm-route.json';
import osrmAlt from '../fixtures/osrm-alternatives.json';
import reverse from '../fixtures/nominatim-reverse.json';
import { LongPressDetector } from '../../src/lib/geo/longpress';
import { fetchJson, NetError } from '../../src/lib/geo/http';
import { fetchRoutes, parseOsrmAll, routeUrl, RouteError, PUBLIC_ROUTERS, type Router } from '../../src/lib/routing';
import {
  searchPlaces,
  reverseGeocode,
  nominatimToPlace,
  parseCoords,
  searchUrl,
  reverseUrl,
  acceptLanguage,
  coordsPlace,
  dedupe,
  _resetThrottle,
} from '../../src/lib/geo/geocode';
import { navStore, pickStore, pickPoint, cancelPick, routeToPick, addPickAsStop, selectRoute, startGuidance, stopNavigation, bearing, geoStore } from '../../src/lib/nav';

const ok = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response);

beforeEach(() => _resetThrottle());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/* ---------- Долгое нажатие ---------- */

describe('Долгое нажатие на карте', () => {
  const setup = () => {
    vi.useFakeTimers();
    const fired: [number, number][] = [];
    const lp = new LongPressDetector({ delay: 600, tolerance: 10, onLongPress: (x, y) => fired.push([x, y]) });
    return { lp, fired };
  };

  it('палец неподвижно 600 мс — точка выбрана в месте касания', () => {
    const { lp, fired } = setup();
    lp.down(1, 100, 200);
    vi.advanceTimersByTime(599);
    expect(fired).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(fired).toEqual([[100, 200]]);
  });

  it('мелкое дрожание пальца (до 10 px) не мешает', () => {
    const { lp, fired } = setup();
    lp.down(1, 100, 200);
    lp.move(1, 106, 205);
    vi.advanceTimersByTime(700);
    expect(fired).toEqual([[100, 200]]);
  });

  it('сдвиг карты отменяет', () => {
    const { lp, fired } = setup();
    lp.down(1, 100, 200);
    vi.advanceTimersByTime(300);
    lp.move(1, 130, 200);
    vi.advanceTimersByTime(1000);
    expect(fired).toHaveLength(0);
  });

  it('короткое касание — не долгое нажатие', () => {
    const { lp, fired } = setup();
    lp.down(1, 100, 200);
    vi.advanceTimersByTime(250);
    lp.up(1);
    vi.advanceTimersByTime(1000);
    expect(fired).toHaveLength(0);
  });

  it('второй палец (масштаб, прокрутка двумя пальцами) отменяет до отпускания всех пальцев', () => {
    const { lp, fired } = setup();
    lp.down(1, 100, 200);
    vi.advanceTimersByTime(200);
    lp.down(2, 300, 200);
    lp.up(2);
    // Первый палец всё ещё на экране после щипка — точку не выбираем.
    vi.advanceTimersByTime(1000);
    expect(fired).toHaveLength(0);
    lp.up(1);
    lp.down(3, 50, 50);
    vi.advanceTimersByTime(600);
    expect(fired).toEqual([[50, 50]]);
  });

  it('отмена системой и начало масштабирования отменяют', () => {
    const { lp, fired } = setup();
    lp.down(1, 1, 1);
    lp.cancel();
    vi.advanceTimersByTime(1000);
    lp.down(2, 1, 1);
    lp.reset();
    vi.advanceTimersByTime(1000);
    expect(fired).toHaveLength(0);
  });

  it('срабатывает один раз за касание и запоминает время (против дубля contextmenu)', () => {
    const { lp, fired } = setup();
    lp.down(1, 5, 5);
    vi.advanceTimersByTime(2000);
    expect(fired).toHaveLength(1);
    expect(lp.lastFired).toBeGreaterThan(0);
    expect(lp.pending).toBe(false);
  });
});

/* ---------- Запросы с тайм-аутом ---------- */

describe('Сетевые запросы', () => {
  it('тайм-аут — понятная ошибка, а не вечное ожидание', async () => {
    vi.stubGlobal('fetch', (_u: string, init: RequestInit) =>
      new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
    );
    await expect(fetchJson('https://x', { timeoutMs: 20, service: 'Тест' })).rejects.toMatchObject({ kind: 'timeout', message: 'Тест не ответил за 0 с' });
  });

  it('нет сети — offline без запроса', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    vi.stubGlobal('navigator', { onLine: false });
    await expect(fetchJson('https://x', { timeoutMs: 1000, service: 'Тест' })).rejects.toBeInstanceOf(NetError);
    expect(f).not.toHaveBeenCalled();
  });

  it('429 — сообщение о перегрузке', async () => {
    vi.stubGlobal('fetch', () => ok({}, 429));
    await expect(fetchJson('https://x', { timeoutMs: 1000, service: 'Тест' })).rejects.toMatchObject({ kind: 'rate-limit' });
  });
});

/* ---------- Маршруты ---------- */

const A = { lat: 55.757, lon: 37.6156 };
const B = { lat: 55.779, lon: 37.617 };

describe('Маршрут по дорогам', () => {
  it('варианты маршрута: основной и альтернатива', () => {
    const routes = parseOsrmAll(osrmAlt, 'OSRM');
    expect(routes).toHaveLength(2);
    expect(routes[1].distance).toBeGreaterThan(routes[0].distance);
    expect(routes[0].coords.length).toBeGreaterThan(2);
    expect(routes[0].source).toBe('OSRM');
  });

  it('URL: координаты lon,lat, геометрия, шаги; альтернативы только без промежуточной точки', () => {
    const u = routeUrl(PUBLIC_ROUTERS[0], [A, B], true);
    expect(u).toBe('https://routing.openstreetmap.de/routed-car/route/v1/driving/37.615600,55.757000;37.617000,55.779000?overview=full&geometries=geojson&steps=true&alternatives=true');
  });

  it('основной сервер недоступен — маршрут с запасного', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (u: string) => {
      calls.push(u);
      return u.includes('openstreetmap.de') ? ok({}, 503) : ok(osrmAlt);
    });
    const routes = await fetchRoutes(A, B);
    expect(calls).toHaveLength(2);
    expect(routes).toHaveLength(2);
    expect(routes[0].source).toBe('OSRM · демо-сервер');
  });

  it('нет дороги к точке — ошибка «маршрут не найден», без перебора серверов', async () => {
    const f = vi.fn(() => ok({ code: 'NoRoute', message: 'Impossible route' }, 400));
    vi.stubGlobal('fetch', f);
    await expect(fetchRoutes(A, B)).rejects.toMatchObject({ kind: 'no-route' });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('все серверы молчат — честная ошибка с советом', async () => {
    const routers: Router[] = [{ id: 'a', name: 'A', base: 'https://a', profile: 'driving' }];
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    const e = await fetchRoutes(A, B, { routers }).catch((x) => x);
    expect(e).toBeInstanceOf(RouteError);
    expect(e.message).toMatch(/Не удалось построить маршрут.*внешний навигатор/);
  });

  it('с промежуточной точкой — 3 точки и без альтернатив', async () => {
    let url = '';
    vi.stubGlobal('fetch', (u: string) => ((url = u), ok(osrm)));
    await fetchRoutes(A, B, { via: { lat: 55.76, lon: 37.61 } });
    expect(url.split(';')).toHaveLength(3);
    expect(url).toContain('alternatives=false');
  });
});

/* ---------- Адреса ---------- */

describe('Поиск адресов и адрес точки', () => {
  it('язык ответа зависит от языка интерфейса', () => {
    expect(acceptLanguage('uk')).toBe('uk,ru,en');
    expect(acceptLanguage('ru')).toBe('ru,uk,en');
    expect(searchUrl('Хрещатик 22, Київ', 'uk')).toContain('accept-language=uk%2Cru%2Cen');
    expect(searchUrl('Крещатик 22, Киев', 'ru', { lat: 50.45, lon: 30.52 })).toContain('viewbox=29.0200%2C51.9500%2C32.0200%2C48.9500');
    expect(reverseUrl({ lat: 50.45, lon: 30.52 }, 'uk')).toContain('/reverse?lat=50.450000&lon=30.520000');
  });

  it('координаты в строке поиска', () => {
    expect(parseCoords('50.4501, 30.5234')).toEqual({ lat: 50.4501, lon: 30.5234 });
    expect(parseCoords('50,4501 30,5234')).toEqual({ lat: 50.4501, lon: 30.5234 });
    expect(parseCoords('Хрещатик 22')).toBeNull();
    expect(parseCoords('95, 30')).toBeNull();
  });

  it('дом на улице: «улица, дом» и город', () => {
    const p = nominatimToPlace({
      place_id: 1,
      display_name: '22, Хрещатик, Печерський район, Київ, 01001, Україна',
      lat: '50.4473',
      lon: '30.5225',
      type: 'house',
      address: { house_number: '22', road: 'Хрещатик', city: 'Київ', state: 'Київ', country: 'Україна' },
    });
    expect(p.name).toBe('Хрещатик, 22');
    expect(p.address).toBe('Київ, Україна');
    expect(p.kind).toBe('Дом');
  });

  it('объект с названием (POI)', () => {
    const p = nominatimToPlace({ place_id: 2, name: 'WOG', display_name: 'WOG, Велика Кільцева, Київ, Україна', lat: '50.4', lon: '30.4', type: 'fuel', address: { road: 'Велика Кільцева', city: 'Київ', country: 'Україна' } });
    expect(p).toMatchObject({ name: 'WOG', address: 'Велика Кільцева, Київ, Україна', kind: 'АЗС' });
  });

  it('поиск: Nominatim, затем запасной Photon при сбое', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (u: string) => {
      calls.push(u);
      if (u.includes('nominatim')) return ok({}, 503);
      return ok({ features: [{ geometry: { coordinates: [30.5225, 50.4473] }, properties: { osm_id: 5, street: 'Хрещатик', housenumber: '22', city: 'Київ', country: 'Україна', osm_value: 'house' } }] });
    });
    const r = await searchPlaces('Хрещатик 22, Київ', { lang: 'uk' });
    expect(calls[0]).toContain('nominatim');
    expect(calls[1]).toContain('photon.komoot.io');
    expect(r[0]).toMatchObject({ name: 'Хрещатик, 22', lat: 50.4473, lon: 30.5225 });
  });

  it('дубли одного места убираются', () => {
    const a = { id: '1', name: 'X', address: '', lat: 50, lon: 30 };
    expect(dedupe([a, { ...a, id: '2', lat: 50.0001 }, { ...a, id: '3', name: 'Y' }])).toHaveLength(2);
  });

  it('адрес точки: координаты остаются те, что выбрал пользователь', async () => {
    vi.stubGlobal('fetch', () => ok(reverse));
    const p = await reverseGeocode({ lat: 55.7577, lon: 37.6139 });
    expect(p).toMatchObject({ name: 'Петровка, 12', lat: 55.7577, lon: 37.6139 });
  });

  it('адреса нет (море, поле) — null, без выдуманного адреса', async () => {
    vi.stubGlobal('fetch', () => ok({ error: 'Unable to geocode' }));
    expect(await reverseGeocode({ lat: 43.1, lon: 34.2 })).toBeNull();
    expect(coordsPlace({ lat: 43.1, lon: 34.2 })).toMatchObject({ name: 'Точка на карте', address: '43.10000, 34.20000' });
  });
});

/* ---------- Выбор точки → маршрут ---------- */

describe('Выбор точки на карте и «Маршрут сюда»', () => {
  const here = () => geoStore.set((s) => ({ ...s, status: 'watching', lat: A.lat, lon: A.lon, accuracy: 10 }));
  afterEach(() => {
    stopNavigation();
    cancelPick();
  });

  it('долгое нажатие → адрес → маршрут по дорогам с вариантами', async () => {
    here();
    vi.stubGlobal('fetch', (u: string) => ok(u.includes('/reverse') ? reverse : osrmAlt));
    await pickPoint({ lat: 55.7577, lon: 37.6139 });
    expect(pickStore.get()).toMatchObject({ loading: false, failed: false, place: { name: 'Петровка, 12' } });
    await routeToPick();
    const s = navStore.get();
    expect(pickStore.get()).toBeNull();
    expect(s.status).toBe('preview');
    expect(s.dest).toMatchObject({ name: 'Петровка, 12', lat: 55.7577, lon: 37.6139 });
    expect(s.routes).toHaveLength(2);
    expect(s.route!.coords.length).toBeGreaterThan(2);
    selectRoute(1);
    expect(navStore.get().route).toBe(s.routes[1]);
    vi.stubGlobal('window', {}); // без синтеза речи
    startGuidance();
    expect(navStore.get()).toMatchObject({ status: 'guiding', routes: [s.routes[1]] });
  });

  it('адрес не определился — маршрут к координатам точки', async () => {
    here();
    vi.stubGlobal('fetch', (u: string) => (u.includes('/reverse') ? Promise.reject(new TypeError('x')) : ok(osrm)));
    await pickPoint({ lat: 55.77, lon: 37.62 });
    expect(pickStore.get()).toMatchObject({ failed: true, place: null });
    await routeToPick();
    expect(navStore.get().dest).toMatchObject({ name: 'Точка на карте', lat: 55.77, lon: 37.62 });
    expect(navStore.get().route).not.toBeNull();
  });

  it('«Добавить остановку» — заезд по пути к текущей цели', async () => {
    here();
    vi.stubGlobal('fetch', (u: string) => ok(u.includes('/reverse') ? reverse : osrm));
    await pickPoint(B, 'search', { id: 'd', name: 'Цель', address: '', ...B });
    await routeToPick();
    await pickPoint({ lat: 55.7577, lon: 37.6139 });
    await addPickAsStop();
    expect(navStore.get()).toMatchObject({ dest: { name: 'Цель' }, via: { name: 'Петровка, 12' } });
  });

  it('нет дороги — понятная ошибка вместо линии по прямой', async () => {
    here();
    vi.stubGlobal('fetch', () => ok({ code: 'NoRoute' }, 400));
    await pickPoint(B, 'search', { id: 'd', name: 'Остров', address: '', ...B });
    await routeToPick();
    expect(navStore.get()).toMatchObject({ route: null, routes: [], error: expect.stringContaining('Маршрут не найден') });
  });

  it('«Отмена» убирает точку', async () => {
    await pickPoint(B, 'search', { id: 'd', name: 'X', address: '', ...B });
    cancelPick();
    expect(pickStore.get()).toBeNull();
  });
});

describe('Направление движения по GPS', () => {
  it('курс на север и на восток', () => {
    expect(bearing({ lat: 50, lon: 30 }, { lat: 50.01, lon: 30 })).toBeCloseTo(0, 0);
    expect(bearing({ lat: 50, lon: 30 }, { lat: 50, lon: 30.01 })).toBeCloseTo(90, 0);
  });
});
