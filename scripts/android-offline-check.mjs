// Android profile, fixture-only provider and real IndexedDB/MapLibre protocol.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const { chromium, devices } = createRequire(import.meta.url)('playwright');
const url = new URL(process.argv[2] ?? 'http://localhost:4173/');
const fixture = JSON.parse(fs.readFileSync(new URL('../tests/fixtures/osrm-route.json', import.meta.url))).routes[0];
const route = { coords: fixture.geometry.coordinates.map(([lon, lat]) => ({ lon, lat })), distance: fixture.distance, duration: fixture.duration,
  steps: fixture.legs.flatMap((leg) => leg.steps.map((step) => ({
    ...step, ...step.maneuver, location: { lon: step.maneuver.location[0], lat: step.maneuver.location[1] },
  }))) };
const point = route.coords[0];
const style = {
  version: 8, glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: { roads: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#e8e2d0' } },
    { id: 'road_primary', type: 'line', source: 'roads', 'source-layer': 'transportation', paint: { 'line-width': 4, 'line-color': '#605b51' } },
    { id: 'street', type: 'symbol', source: 'roads', 'source-layer': 'transportation', layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'] } },
  ],
};
const fields = (id, bytes) => [id * 8 + 2, bytes.length, ...bytes];
const utf8 = (s) => Array.from(Buffer.from(s));
const feature = [24, 2, ...fields(2, [0, 0, 1, 1]), ...fields(4, [9, 0, 128, 32, 10, 128, 64, 0])];
const layer = [120, 2, ...fields(1, utf8('transportation')), ...fields(2, feature),
  ...fields(3, utf8('name')), ...fields(3, utf8('class')), ...fields(4, fields(1, utf8('Улица тестовой карты'))),
  ...fields(4, fields(1, utf8('primary'))), 40, 128, 32];
const tile = Buffer.from(fields(3, layer));
const tileJson = { tiles: ['https://tiles.openfreemap.org/fixture/{z}/{x}/{y}.pbf'], maxzoom: 14, attribution: 'OpenFreeMap · © OpenStreetMap contributors' };
const browser = await chromium.launch();
try {
  const { defaultBrowserType, ...device } = devices['Pixel 7'];
  const ctx = await browser.newContext({ ...device, deviceScaleFactor: 1, serviceWorkers: 'block' });
  let blocked = false;
  let routeRequests = 0;
  await ctx.route('**/*', (r) => {
    const u = new URL(r.request().url());
    if (u.origin === url.origin) return r.continue();
    if (u.pathname.includes('/route/v1/')) routeRequests++;
    if (blocked) return r.abort('internetdisconnected');
    const headers = { 'Access-Control-Allow-Origin': '*' };
    if (u.pathname.includes('/styles/')) return r.fulfill({ json: style, headers });
    if (u.pathname === '/planet') return r.fulfill({ json: { ...tileJson, tiles: tileJson.tiles }, headers });
    if (u.pathname.startsWith('/fixture/')) return r.fulfill({ body: tile, headers });
    return r.fulfill({ status: 204, headers });
  });
  await ctx.addInitScript(({ point, style, tileJson, tileB64 }) => {
    window.CapacitorCustomPlatform = { name: 'android' };
    window.testProviderCalls = 0;
    window.Capacitor = {
      PluginHeaders: [
        { name: 'CapacitorHttp', methods: [{ name: 'get', rtype: 'promise' }] },
        { name: 'TripSensors', methods: [] },
      ],
      nativePromise: async (plugin, method, payload) => {
        if (plugin !== 'CapacitorHttp' || method !== 'get') throw new Error('Unexpected native request');
        if (!payload.headers['User-Agent'].startsWith('AI-Car-Expert-Android/')) throw new Error('Missing app identity');
        window.testProviderCalls++;
        const path = new URL(payload.url).pathname;
        if (path.includes('/styles/')) return { status: 200, data: style };
        if (path === '/planet') return { status: 200, data: tileJson };
        if (path.startsWith('/fixture/')) return { status: 200, data: tileB64 };
        if (path.startsWith('/fonts/')) return { status: 200, data: '' };
        throw new Error('Unexpected fixture path ' + path);
      },
    };
    localStorage.setItem('ace:settings', JSON.stringify({ mapEngine: 'maplibre', mapEngineExplicit: true, theme: 'day', speakNavigation: false }));
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => !sessionStorage.getItem('test-offline') });
    const gps = () => ({ coords: { latitude: point.lat, longitude: point.lon, accuracy: 5, speed: 0, heading: 0 }, timestamp: Date.now() });
    let id = 0;
    Object.defineProperty(navigator, 'geolocation', { value: {
      getCurrentPosition: (cb) => { if (!sessionStorage.getItem('test-no-gps')) queueMicrotask(() => cb(gps())); },
      watchPosition: (cb) => { if (!sessionStorage.getItem('test-no-gps')) queueMicrotask(() => cb(gps())); return ++id; },
      clearWatch: () => {},
    } });
  }, { point, style, tileJson, tileB64: tile.toString('base64') });
  const page = await ctx.newPage();
  page.setDefaultTimeout(45_000);
  const wait = (test) => page.waitForFunction(test, null, { polling: 150 });
  const click = (name) => page.getByRole('button', { name, exact: true }).evaluate((node) => node.click());
  const load = () => page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await load();
  await wait(() => window.__aceMap?.state().styleReady && window.__aceMap.state().raw.lat != null);
  await click('Дополнительные настройки');
  await click('Настройки навигации и HUD');
  await page.getByLabel('Название региона').fill('Тестовый район');
  await page.getByLabel('Радиус региона').selectOption('2');
  await click('Текущее местоположение');
  await click('Скачать регион');
  await page.getByText('Регион доступен без интернета.', { exact: true }).waitFor();
  assert(await page.evaluate(() => window.testProviderCalls > 10 && window.testProviderCalls < 3000));
  await page.evaluate((r) => localStorage.setItem('ace:nav-session', JSON.stringify({
    dest: { id: 'saved', name: 'Финиш', address: '', ...r.coords.at(-1) }, at: Date.now(), via: null, guiding: true, route: r,
  })), route);
  await load();
  await wait(() => window.__aceMap?.state().routePoints > 2 && window.__aceMap.state().raw.lat != null);
  assert.equal(routeRequests, 0);
  blocked = true;
  await page.evaluate(() => { sessionStorage.setItem('test-offline', '1'); window.dispatchEvent(new Event('offline')); });
  await wait(() => {
    const { map, state } = window.__aceMap;
    const s = state();
    return s.offline.region === 'Тестовый район' && s.routePoints > 2 && s.raw.lat != null &&
      map.getStyle()?.glyphs?.startsWith('aceoffline:') &&
      map.querySourceFeatures('roads', { sourceLayer: 'transportation' }).some((f) => f.properties.name.includes('Улица'));
  });
  await page.evaluate(() => sessionStorage.setItem('test-no-gps', '1'));
  await load();
  await wait(() => {
    const s = window.__aceMap?.state();
    return s?.offline.region === 'Тестовый район' && s.routePoints > 2 && s.raw.lat == null && !s.car;
  });
  assert.match(await page.locator('.android-position-tag').innerText(), /Положение не подтверждено/);
  assert(await page.locator('.android-position-tag').getByRole('button', { name: 'Старт вручную' }).isVisible());
  blocked = false;
  await page.evaluate(() => { sessionStorage.removeItem('test-offline'); window.dispatchEvent(new Event('online')); });
  await wait(() => {
    const s = window.__aceMap.state();
    return !s.offline.local && window.__aceMap.map.getStyle()?.glyphs?.startsWith('https:') && s.raw.lat == null && s.routePoints > 2;
  });
  assert.equal(routeRequests, 0, 'No routing server calls while restoring the existing route');
  await click('Дополнительные настройки');
  await click('Настройки навигации и HUD');
  const section = page.getByRole('region', { name: 'Офлайн-карты' });
  await section.getByRole('button', { name: 'Обновить', exact: true }).evaluate((el) => el.click());
  await page.getByText('Регион доступен без интернета.', { exact: true }).waitFor();
  assert.equal(await section.getByText('Тестовый район', { exact: true }).count(), 1);
  await section.getByRole('button', { name: 'Удалить', exact: true }).evaluate((el) => el.click());
  await section.getByText('Тестовый район', { exact: true }).waitFor({ state: 'hidden' });
  console.log('✓ 4 режима сети и GPS: загрузка региона, локальные векторы и названия, сохранённый маршрут, холодный офлайн-старт и возврат к онлайн-стилю');
} finally { await browser.close(); }
