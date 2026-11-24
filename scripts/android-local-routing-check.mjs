// Restarts the application offline and runs real Valhalla WASM on a synthetic street network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const { chromium, devices } = createRequire(import.meta.url)('playwright');
const url = new URL(process.argv[2] ?? 'http://localhost:4173/');
const source = 'graph/2/000/798/623.gph';
const graph = fs.readFileSync(new URL(`../tests/fixtures/offline-route/${source}`, import.meta.url));
const viewStyle = JSON.parse(fs.readFileSync(new URL('../tests/fixtures/maplibre-style.json', import.meta.url)));
const manifestStyle = { version: 8, sources: { roads: { type: 'vector', tiles: ['https://unused.example/{z}/{x}/{y}'] } },
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e8e2d0' } }] };
const start = { lat: 48.525, lon: 35.8603 };
const finish = { lat: 48.5288, lon: 35.865 };
const index = Buffer.from(JSON.stringify([{ ...finish, id: 'finish', name: 'Тестова 12', address: 'Павлоград', aliases: ['Тестовая 12'] }]));
const assets = { [source]: graph, 'addresses.json': index, 't/0/0/0': Buffer.from([26, 0]) };
const manifest = { version: 1, engine: 'valhalla-3.9', bounds: [35.7, 48.4, 36, 48.7], style: manifestStyle,
  assets: Object.entries(assets).map(([path, body]) => ({ path, bytes: body.length })) };
const browser = await chromium.launch();
try {
  const { defaultBrowserType, ...device } = devices['Pixel 7'];
  const ctx = await browser.newContext({ ...device, deviceScaleFactor: 1, serviceWorkers: 'block' });
  let online = true;
  let remoteRoutes = 0;
  let queried = '';
  await ctx.route('**/*', (r) => {
    const request = new URL(r.request().url());
    if (request.origin === url.origin) return r.continue();
    if (request.pathname.includes('/route/v1/')) remoteRoutes++;
    if (!online) return r.abort('internetdisconnected');
    const headers = { 'Access-Control-Allow-Origin': '*' };
    if (request.hostname === 'photon.komoot.io') {
      assert(!request.searchParams.has('lat') && !request.searchParams.has('lon'));
      queried = request.searchParams.get('q');
      return r.fulfill({ headers, json: { features: [{ geometry: { coordinates: [35.86, 48.525] },
        properties: { osm_id: 57, osm_value: 'city', name: 'Павлоград' } }] } });
    }
    if (request.hostname === 'package.example') {
      const key = request.pathname.split('/').slice(3).join('/');
      return key === 'manifest.json' ? r.fulfill({ json: manifest, headers }) : r.fulfill({ body: assets[key], headers });
    }
    return request.pathname.includes('/styles/') ? r.fulfill({ json: viewStyle, headers }) : r.fulfill({ status: 204, headers });
  });
  await ctx.addInitScript(() => {
    const listeners = new Map();
    let id = 0;
    window.CapacitorCustomPlatform = { name: 'android' };
    window.Capacitor = {
      PluginHeaders: [{ name: 'TripSensors', methods: [
        ...['start', 'stop', 'startGps', 'stopGps', 'setHudAwake'].map((name) => ({ name, rtype: 'promise' })),
        { name: 'addListener' }, { name: 'removeListener' },
      ] }],
      nativePromise: async (_, method, payload) => {
        if (method === 'start') window.gpsStarted = payload.gps;
        if (method === 'stopGps') window.gpsStopped = true;
      },
      nativeCallback: async (_, method, { eventName, callbackId }, fn) => {
        if (method === 'removeListener') { listeners.delete(callbackId); return; }
        listeners.set(++id, { eventName, fn });
        return id;
      },
    };
    window.emit = (name, data) => {
      for (const entry of listeners.values()) if (entry.eventName === name) entry.fn(data);
    };
    if (sessionStorage.getItem('offline')) Object.defineProperty(navigator, 'onLine', { get: () => false });
  });
  const page = await ctx.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error' && /valhalla|wasm/i.test(msg.text())) console.log(msg.text()); });
  page.on('pageerror', (error) => console.error(error));
  page.setDefaultTimeout(40_000);
  const btn = (name) => page.getByRole('button', { name, exact: true });
  const click = (name) => btn(name).evaluate((button) => button.click());
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await click('Дополнительные настройки');
  await click('Настройки навигации и HUD');
  await page.getByLabel('Город или село').fill('Павлоград');
  await click('Найти населённый пункт');
  await btn('Павлоград').evaluate((button) => button.click());
  assert.equal(queried, 'Павлоград');
  await page.locator('details').filter({ hasText: 'Источник пакетов' }).locator('summary').click();
  await page.getByLabel('HTTPS-адрес поставщика').fill('https://package.example/');
  await click('Проверить пакет');
  await click('Скачать регион');
  await page.getByText('Регион доступен без интернета.').waitFor();
  online = false;
  await page.evaluate(() => {
    sessionStorage.setItem('offline', '1');
    localStorage.setItem('ace:hud', JSON.stringify({ style: 'game', warned: true, mirror: true }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await click('Старт вручную');
  await page.waitForFunction(() => window.__aceMap?.state().styleReady);
  await page.evaluate(({ lat, lon }) => window.__aceMap.map.jumpTo({ center: [lon, lat], zoom: 17 }), start);
  await click('Указать старт на карте');
  await page.waitForFunction(() => document.querySelector('.place-map-picker .btn-primary')?.disabled === false);
  await page.touchscreen.tap(205, 315);
  await page.waitForFunction(() => !!document.querySelector('.place-map-picker-pin')?.style.left);
  await click('Подтвердить');
  await page.getByLabel('Офлайн-адрес').fill('Тестовая 12');
  await click('Найти офлайн');
  await click('Тестова 12 · Павлоград');
  await btn('Начать поездку без GPS').waitFor();
  await page.waitForFunction(() => window.__aceMap.state().routePoints >= 5);
  await click('Начать поездку без GPS');
  await btn('HUD').waitFor();
  assert.equal(await page.evaluate(() => window.gpsStarted), false);
  const original = await page.evaluate(() => window.__aceMap.state().experimentalEstimate);
  await page.evaluate(() => {
    const at = Date.now();
    window.emit('gps', { lat: -12.04, lon: -77.04, at, speed: 14, accuracy: 2 });
    window.motionTimer = setInterval(() => window.emit('motion', { at: Date.now(), x: 0, y: 0, yawRate: 0 }), 100);
  });
  await page.waitForTimeout(400);
  const stopped = await page.evaluate(() => window.__aceMap.state().experimentalEstimate);
  assert(Math.abs(original.lon - stopped.lon) + Math.abs(original.lat - stopped.lat) < 1e-6);
  await click('HUD');
  const warning = page.getByRole('button', { name: /Понятно/ });
  if (await warning.count()) await warning.evaluate((button) => button.click());
  await page.locator('.hud[data-style="game"] .hud-speed').waitFor();
  assert(await page.locator('.hud-stage').evaluate((stage) => stage.classList.contains('is-mirrored')));
  await page.locator('.hud-stage').evaluate((node) => node.click());
  await click('Выйти из HUD');
  await click('Меню поездки');
  await page.getByLabel('Режим').selectOption('adaptive');
  const pos = { lat: original.lat, lon: original.lon, accuracy: 8, speed: 0 };
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(560);
    await page.evaluate((value) => window.emit('gps', { ...value, at: Date.now() }), pos);
  }
  await page.waitForFunction(() => window.__aceMap.state().experimentalEstimate.gps === 'trusted');
  await page.getByLabel('Режим').selectOption('road');
  await page.waitForFunction(() => window.gpsStopped && window.__aceMap.state().routePoints >= 5);
  assert.equal(remoteRoutes, 0);
  console.log('✓ Павлоград без координат: пакет, перезапуск офлайн, касание, поиск адреса, локальный Valhalla, запуск, остановка, HUD и переключение режима.');
} finally { await browser.close(); }
