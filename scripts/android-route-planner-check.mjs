import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const [url, directory, screenshots = 'route-planner-screens'] = process.argv.slice(2);
fs.mkdirSync(screenshots, { recursive: true });
const load = (file) => fs.readFileSync(path.join(directory, file));
const city = JSON.parse(load('catalog.json')).settlements.find((place) => place.name === 'Павлоград');
const manifestPath = city.packages[25];
const manifest = JSON.parse(load(manifestPath));
const addresses = manifest.assets.find((entry) => entry.path === 'addresses.json');
const chunk = load(path.join(path.dirname(manifestPath), manifest.chunks[addresses.chunk].path));
const index = JSON.parse(chunk.subarray(addresses.offset, addresses.offset + addresses.bytes));
const origin = index.find((entry) => entry.name === 'Соборна вулиця 93/2');
const destination = index.find((entry) => entry.name === 'вулиця Незалежності 156');
assert(origin && destination);
const style = JSON.parse(fs.readFileSync(new URL('../tests/fixtures/maplibre-style.json', import.meta.url)));
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ ...devices['Pixel 7'], defaultBrowserType: undefined, deviceScaleFactor: 1, serviceWorkers: 'block' });
  let offline = false;
  let serverRequests = 0;
  let localWasmRequests = 0;
  await ctx.route('**/*', (request) => {
    const target = new URL(request.request().url());
    if (target.origin === new URL(url).origin) {
      if (target.pathname.endsWith('.wasm')) localWasmRequests++;
      return request.continue();
    }
    if (/route\/v1|nominatim|photon|reverse|\.wasm/.test(target.href)) serverRequests++;
    if (offline) return request.abort('internetdisconnected');
    const headers = { 'Access-Control-Allow-Origin': '*' };
    if (target.hostname === 'raw.githubusercontent.com') {
      return request.fulfill({ body: load(target.pathname.split('/').slice(4).join('/')), headers });
    }
    return target.pathname.includes('/styles/') ? request.fulfill({ json: style, headers }) : request.fulfill({ status: 204, headers });
  });
  await ctx.addInitScript(({ origin, destination }) => {
    window.CapacitorCustomPlatform = { name: 'android' };
    const handlers = new Map();
    let id = 0;
    const status = { fine: true, coarse: true, playServices: 0, fusedStatus: 'watching', gpsEnabled: true, networkEnabled: true };
    const plugin = (name, methods) => ({ name, methods: [...methods.map((name) => ({ name, rtype: 'promise' })),
      { name: 'addListener' }, { name: 'removeListener' }] });
    window.Capacitor = {
      PluginHeaders: [plugin('NativePosition', ['start', 'stop', 'refresh', 'diagnostics', 'acknowledge']),
        plugin('TripSensors', ['start', 'startGps', 'stopGps', 'stop', 'setHudAwake'])],
      nativeCallback: async (plugin, method, payload, callback) => {
        if (method === 'removeListener') { handlers.delete(payload.callbackId); return; }
        handlers.set(++id, { plugin, name: payload.eventName, callback });
        return id;
      },
      nativePromise: async (plugin, method, payload) => {
        if (plugin === 'TripSensors' && method === 'start') window.tripGps = payload.gps;
        if (plugin === 'NativePosition' && method === 'start') window.nativeStarted = true;
        return status;
      },
    };
    window.emit = (plugin, event, data) => {
      for (const h of handlers.values()) if (h.plugin === plugin && h.name === event) h.callback({ at: Date.now(), ...data });
    };
    const Worker = window.Worker;
    window.Worker = class extends Worker {
      constructor(url, options) {
        super(url, options);
        if (String(url).includes('offlineRouter.worker')) {
          window.routeWorkers = (window.routeWorkers ?? 0) + 1;
          if (window.failNextRouter) {
            window.failNextRouter = false;
            this.postMessage = () => queueMicrotask(() => this.onmessage?.({ data: { failure: 'wasm' } }));
          }
        }
      }
    };
    if (sessionStorage.getItem('offline')) Object.defineProperty(navigator, 'onLine', { get: () => false });
    if (!localStorage.getItem('ace:places')) localStorage.setItem('ace:places', JSON.stringify([
      { ...destination, id: 'home', name: 'Дом', placeType: 'home', createdAt: 1, updatedAt: 1 },
      { ...origin, id: 'work', name: 'Работа', placeType: 'work', createdAt: 1, updatedAt: 1 },
    ]));
  }, { origin, destination });
  const page = await ctx.newPage();
  page.setDefaultTimeout(40_000);
  page.on('pageerror', (error) => console.error(error));
  const button = (name) => page.getByRole('button', { name, exact: true });
  const click = (name) => button(name).evaluate((node) => node.click());
  const mapReady = () => page.waitForFunction(() => window.__aceMap?.state().styleReady);
  const center = (point) => page.evaluate(({ lat, lon }) => window.__aceMap.map.jumpTo({ center: [lon, lat], zoom: 17 }), point);
  const screenshot = (name) => page.screenshot({ path: path.join(screenshots, name) });
  const built = () => button('Начать поездку').waitFor({ timeout: 20_000 }).catch(async (error) => {
    console.error(await page.locator('.autonomy-panel').innerText());
    throw error;
  });
  const menu = () => click('Дополнительные настройки');
  const field = (name) => page.locator('.route-planner-field').filter({ has: page.getByText(name, { exact: true }) });
  const chooseField = async (name) => {
    const entry = field(name);
    if (await entry.getAttribute('aria-pressed') !== 'true') await entry.evaluate((node) => node.click());
  };
  const chooseAddress = async (fieldName, input, point) => {
    await chooseField(fieldName);
    await page.getByLabel(input).fill(point.name);
    await click('Найти');
    await page.locator('.route-planner-result').filter({ hasText: point.name }).first().evaluate((node) => node.click());
  };
  const paint = async () => {
    await page.waitForFunction(() => {
      const { map, state } = window.__aceMap;
      return state().routePoints > 2 && map.queryRenderedFeatures({ layers: ['route-line'] }).length > 0;
    });
  };
  const tapPoint = async (offset = { x: 0, y: 0 }) => {
    await page.waitForFunction(() => document.querySelector('.place-map-picker .btn-primary')?.disabled === false);
    const point = await page.locator('.place-map-picker-map').evaluate((map, delta) => {
      const rect = map.getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2 + delta.x), y: Math.round(rect.y + rect.height / 2 + delta.y) };
    }, offset);
    await page.waitForFunction(({ x, y }) =>
      !!document.elementFromPoint(x, y)?.closest('.place-map-picker-map .maplibregl-canvas-container'), point);
    const selected = () => !!document.querySelector('.place-map-picker-pin')?.style.left;
    await page.touchscreen.tap(point.x, point.y);
    try {
      await page.waitForFunction(selected, null, { timeout: 2500 });
    } catch {
      // A busy software renderer can miss a tap. Retry once, after the double-tap window.
      if (!await page.evaluate(selected)) await page.touchscreen.tap(point.x, point.y);
      await page.waitForFunction(selected, null, { timeout: 5000 }).catch(async (error) => {
        await screenshot('04-touch-failure.png');
        throw error;
      });
    }
    await click('Подтвердить');
  };

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await menu();
  await click('Настройки навигации и HUD');
  await page.getByLabel('Город или село').fill(city.name);
  await click('Найти населённый пункт');
  await click(city.name + ' · ' + city.address);
  await click('Скачать карту');
  await page.getByText('Регион доступен без интернета.').waitFor();
  await Promise.all([page.waitForEvent('domcontentloaded'), click('Перезапустить приложение')]);
  serverRequests = 0;
  await mapReady();
  // Establish a believable but false prior position before explicit rejection.
  const emitFix = (point) => page.evaluate((p) => window.emit('NativePosition', 'position', { ...p, source: 'gps', accuracy: 8, speed: 0 }), point);
  await page.waitForFunction(() => window.nativeStarted);
  for (let i = 0; i < 3; i++) { await emitFix({ lat: -12.04, lon: -77.04 }); await page.waitForTimeout(650); }
  await page.waitForFunction(() => window.__aceMap.map.getCenter().lat < 0);
  await menu();
  await click('GPS показывает неверное местоположение');
  // The settlement label centre is a plaza with no car path. Touch the
  // location of the independently verified start address on the actual map.
  const world = 512 * 2 ** 16;
  const mercator = (lat) => (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2;
  await tapPoint({ x: (origin.lon - city.lon) * world / 360, y: (mercator(origin.lat) - mercator(city.lat)) * world });
  await mapReady();
  assert(await page.evaluate(() => window.__aceMap.map.getCenter().lat > 48));
  const manual = await page.evaluate(() => JSON.parse(localStorage.getItem('ace:position-mode')).point);
  assert(Math.abs(manual.lat - origin.lat) < .00005 && Math.abs(manual.lon - origin.lon) < .00005);
  await emitFix({ lat: -12.04, lon: -77.04 });
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('ace:position-mode')).point), manual);

  await chooseAddress('Откуда', 'Адрес отправления', origin);
  await chooseAddress('Куда', 'Адрес назначения', destination);
  await screenshot('01-endpoints.png');
  await page.evaluate(() => { window.failNextRouter = true; });
  await click('Построить маршрут');
  await built();
  await paint();
  assert.equal(await page.evaluate(() => window.routeWorkers), 2);
  assert.equal(serverRequests, 0);
  await click('Начать поездку');
  await click('Подтвердить фактическую позицию');
  await button('HUD').waitFor();
  await click('Завершить поездку');
  await click('Выйти без записи');
  offline = true;
  await page.evaluate(() => {
    sessionStorage.setItem('offline', '1');
    Object.defineProperty(navigator, 'onLine', { get: () => false });
    dispatchEvent(new Event('offline'));
  });
  await page.locator('#map-search').focus();
  await click('Домой');
  await chooseAddress('Откуда', 'Адрес отправления', origin);
  await chooseAddress('Куда', 'Адрес назначения', destination);
  await click('Построить маршрут');
  await built();
  await paint();
  await page.waitForFunction(() => !window.__aceMap.map.isMoving());
  assert(await button('Начать поездку').evaluate((node) => {
    const panel = node.closest('.autonomy-panel').getBoundingClientRect();
    return node.getBoundingClientRect().bottom <= panel.bottom;
  }));
  await screenshot('02-offline-route.png');

  await click('Поменять точки местами');
  assert.match(await field('Откуда').innerText(), /Незалежності/);
  await click('Поменять точки местами');
  await chooseField('Откуда');
  await click('Выбрать на карте');
  await tapPoint();
  assert.match(await field('Куда').innerText(), /Незалежності/);
  await chooseField('Куда');
  await click('Выбрать на карте');
  await tapPoint();
  assert.match(await field('Откуда').innerText(), /Старт на карте/);
  await click('Построить маршрут'); await built(); await paint();

  await click('Назад');
  await page.locator('#map-search').focus();
  await click('Домой');
  assert.match(await field('Откуда').innerText(), /Моё местоположение/);
  assert.match(await field('Куда').innerText(), /Дом/);
  await click('Построить маршрут'); await built(); await paint();

  await chooseField('Откуда'); await click('Дом');
  await chooseField('Куда'); await click('Работа');
  await click('Построить маршрут'); await built(); await paint();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await built(); await paint();
  assert.match(await field('Откуда').innerText(), /Дом/);
  await click('Начать поездку');
  await button('Подтвердить фактическую позицию').waitFor();
  await page.waitForFunction(() => {
    const { map } = window.__aceMap;
    return !map.isMoving() && map.areTilesLoaded();
  });
  await screenshot('03-confirm-position.png');
  await click('Подтвердить фактическую позицию');
  await button('HUD').waitFor();
  assert.equal(await page.evaluate(() => window.tripGps), false);
  await page.evaluate(() => {
    window.motionTimer = setInterval(() => window.emit('TripSensors', 'motion', { x: 0, y: 0, yawRate: 0 }), 120);
  });
  await page.waitForFunction(() => {
    const map = window.__aceMap.state();
    return map.experimentalEstimate?.stopped && map.camera.style === 'dynamic' && map.pitch > 25;
  });
  await click('HUD');
  if (await page.getByRole('button', { name: /Понятно/ }).count()) {
    await page.getByRole('button', { name: /Понятно/ }).evaluate((node) => node.click());
  }
  await page.locator('.hud[data-style="classic"] .hud-speed').waitFor();
  await click('Выйти из HUD');
  await page.evaluate(() => localStorage.setItem('ace:hud', JSON.stringify({ style: 'game', warned: true, mirror: true })));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await button('Уточнить и продолжить').waitFor();
  await click('Завершить предыдущую поездку');
  await click('Начать поездку');
  await click('Подтвердить фактическую позицию');
  await click('HUD');
  await page.locator('.hud[data-style="game"] .hud-speed').waitFor();
  assert(await page.locator('.hud-stage').evaluate((stage) => stage.classList.contains('is-mirrored')));
  await click('Выйти из HUD');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await click('Завершить предыдущую поездку');
  await page.locator('.route-planner-position summary').click();
  await button('Включить автоматическое местоположение').waitFor();
  await click('Включить автоматическое местоположение');
  for (let i = 0; i < 3; i++) { await emitFix({ lat: -12.04, lon: -77.04 }); await page.waitForTimeout(650); }
  assert(await page.evaluate(() => JSON.parse(localStorage.getItem('ace:position-mode')).rechecking));
  for (let i = 0; i < 3; i++) { await emitFix(origin); await page.waitForTimeout(650); }
  await page.waitForFunction(() => !JSON.parse(localStorage.getItem('ace:position-mode')).rechecking);
  await paint();
  assert.equal(serverRequests, 0);
  assert(localWasmRequests > 0);
  if (process.env.ACE_RECOVERY_REPEAT) {
    async function completeTrip() {
      await click('Начать поездку');
      const confirmation = button('Подтвердить фактическую позицию');
      await Promise.race([confirmation.waitFor(), button('HUD').waitFor()]);
      if (await confirmation.isVisible()) await click('Подтвердить фактическую позицию');
      await button('HUD').waitFor();
      await click('Завершить поездку');
      await click('Выйти без записи');
      await page.locator('#map-search').focus();
      await click('Домой');
    }
    const workers = await page.evaluate(() => window.routeWorkers);
    for (let run = 0; run < 20; run++) {
      await chooseField('Откуда'); await click(run % 2 ? 'Дом' : 'Работа');
      await chooseField('Куда'); await click(run % 2 ? 'Работа' : 'Дом');
      await click('Построить маршрут');
      await built();
      await paint();
      await completeTrip();
    }
    assert.equal(await page.evaluate(() => window.routeWorkers), workers + 20);

    await click('Назад');
    offline = false;
    await page.evaluate(() => {
      sessionStorage.removeItem('offline');
      delete navigator.onLine;
      dispatchEvent(new Event('online'));
    });
    await menu();
    await click('Настройки навигации и HUD');
    const dnipro = JSON.parse(load('catalog.json')).settlements.find((place) => place.name === 'Дніпро');
    await page.getByLabel('Город или село').fill(dnipro.name);
    await click('Найти населённый пункт');
    await click(dnipro.name + ' · ' + dnipro.address);
    await click('Скачать карту');
    await page.getByText('Регион доступен без интернета.').waitFor({ timeout: 90_000 });
    offline = true;
    await page.evaluate(() => sessionStorage.setItem('offline', '1'));
    await Promise.all([page.waitForEvent('domcontentloaded'), click('Перезапустить приложение')]);
    await mapReady();
    await page.locator('#map-search').focus();
    await click('Домой');
    await chooseAddress('Откуда', 'Адрес отправления', { name: 'проспект Дмитра Яворницького 52' });
    await chooseAddress('Куда', 'Адрес назначения', { name: 'Херсонська вулиця 7' });
    await click('Построить маршрут');
    await built();
    await paint();
    const dniproRoute = await page.evaluate(() => JSON.parse(localStorage.getItem('ace:planned-route')).route);
    assert.match(dniproRoute.offlineGraph.region, /Дніпро/);
    assert(dniproRoute.steps.some((step) => step.type === 'turn'));
    await screenshot('05-dnipro-offline.png');
    assert.equal(serverRequests, 0);
    console.log('✓ Дніпро и 20 повторных офлайн-поездок по реальному пакету Павлограда.');
  }
  console.log('✓ Реальный Павлоград: два адреса, касания, дом → работа, ложная позиция, офлайн-перезапуск, подтверждение старта и HUD.');
} finally { await browser.close(); }
