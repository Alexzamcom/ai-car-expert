// UI integration with a simulated Capacitor bridge. This does not exercise native sensors.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const { chromium, devices } = createRequire(import.meta.url)('playwright');
const url = new URL(process.argv[2] ?? 'http://localhost:4173/');
const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`../tests/fixtures/${name}`, import.meta.url)));
const osrm = fixture('osrm-route.json');
const [lon, lat] = osrm.routes[0].geometry.coordinates[0];
const browser = await chromium.launch();
try {
  for (const [profile, platform] of [['Pixel 7', 'android'], ['iPhone 15', 'ios']]) {
    const { defaultBrowserType, ...device } = devices[profile];
    const ctx = await browser.newContext({ ...device, deviceScaleFactor: 1, serviceWorkers: 'block' });
    await ctx.route('**/*', (r) => {
      const target = new URL(r.request().url());
      if (target.origin === url.origin) return r.continue();
      const headers = { 'Access-Control-Allow-Origin': '*' };
      if (target.pathname.includes('/styles/')) return r.fulfill({ json: fixture('maplibre-style.json'), headers });
      if (target.pathname.includes('/route/v1/')) return r.fulfill({ json: osrm, headers });
      return r.fulfill({ status: 204, headers });
    });
    await ctx.addInitScript(({ platform }) => {
      window.CapacitorCustomPlatform = { name: platform };
      const listeners = new Map();
      let id = 0;
      const methods = ['start', 'stop', 'startGps', 'exportTrip'];
      window.Capacitor = {
        PluginHeaders: [{ name: 'TripSensors', methods: [
          ...methods.map((name) => ({ name, rtype: 'promise' })),
          { name: 'addListener' }, { name: 'removeListener' },
        ] }],
        nativePromise: async (_, method, payload) => {
          if (method === 'start') window.__startedWith = payload.gps;
        },
        nativeCallback: async (_, method, { eventName, callbackId }, fn) => {
          if (method === 'removeListener') { listeners.delete(callbackId); return; }
          listeners.set(++id, { eventName, fn });
          return id;
        },
      };
      window.tripEvent = (name, data) => {
        for (const sub of listeners.values()) if (sub.eventName === name) sub.fn(data);
      };
    }, { platform });
    const page = await ctx.newPage();
    page.setDefaultTimeout(45_000);
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    const button = (name) => page.getByRole('button', { name, exact: true });
    const click = (name) => button(name).evaluate((el) => el.click());
    await click('GPS показывает неверное местоположение');
    await page.waitForFunction(() => window.__aceMap?.state().styleReady, null, { timeout: 45_000 });
    await page.evaluate(([x, y]) => window.__aceMap.map.jumpTo({ center: [x, y], zoom: 17 }), [lon, lat]);
    await click('Установить автомобиль');
    await page.evaluate(([x, y]) => window.__aceMap.map.jumpTo({ center: [x + 0.003, y], zoom: 17 }), [lon, lat]);
    await click('Построить маршрут сюда');
    await page.getByLabel('Записать поездку локально', { exact: false }).check();
    await click('Начать поездку без GPS');
    await button('Завершить поездку').waitFor();
    assert.equal(await page.evaluate(() => window.__startedWith), false);
    await page.evaluate(() => {
      const start = Date.now();
      let n = 0;
      window.tripEvent('gps', { lat: 1, lon: 1, at: start, speed: 10, accuracy: 1 });
      const timer = setInterval(() => {
        window.tripEvent('motion', { x: n < 35 ? 2 : 0, y: 0, at: start + n++ * 100, yawRate: 0 });
        if (!document.querySelector('button') || !document.querySelector('.autonomy-panel')?.textContent.includes('Оценка скорости')) clearInterval(timer);
      }, 100);
    });
    await page.waitForFunction(() => {
      const { state, map } = window.__aceMap;
      return state().car3d && state().car && map.getCenter().lat > 40 &&
        document.querySelector('.autonomy-panel')?.textContent.match(/Оценка скорости [1-9]/);
    }, null, { polling: 200 });
    await click('Завершить поездку');
    await click('Оценка 4 из 5');
    await click('Сохранить и выйти');
    await click('GPS показывает неверное местоположение');
    await click('Записи поездок');
    await click('Сравнить');
    await page.getByText(/Инерциальный:.*С дорожной привязкой:/s).last().waitFor();
    assert.equal(await page.getByText('Записей пока нет.').count(), 0);
    console.log(`✓ ${profile}: ручной старт, датчики, изоляция GPS, согласие, локальная запись и воспроизведение`);
    await ctx.close();
  }
} finally { await browser.close(); }
