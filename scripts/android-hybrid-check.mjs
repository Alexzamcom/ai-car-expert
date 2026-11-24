// Android WebView profile with an injected NativePosition bridge.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const { chromium, devices } = createRequire(import.meta.url)('playwright');
const url = new URL(process.argv[2] ?? 'http://localhost:4173/');
const style = fs.readFileSync(new URL('../tests/fixtures/maplibre-style.json', import.meta.url), 'utf8');
const browser = await chromium.launch();
try {
  const { defaultBrowserType, ...device } = devices['Pixel 7'];
  const ctx = await browser.newContext({ ...device, deviceScaleFactor: 1, serviceWorkers: 'block' });
  await ctx.route('**/*', (r) => {
    const target = new URL(r.request().url());
    if (target.origin === url.origin) return r.continue();
    const headers = { 'Access-Control-Allow-Origin': '*' };
    return target.pathname.includes('/styles/') ? r.fulfill({ body: style, contentType: 'application/json', headers }) :
      r.fulfill({ status: 204, headers });
  });
  await ctx.addInitScript(() => {
    window.CapacitorCustomPlatform = { name: 'android' };
    let id = 0;
    const status = { fine: true, coarse: true, playServices: 0, fusedStatus: 'watching', gpsEnabled: true, networkEnabled: true };
    const handlers = new Map();
    window.Capacitor = {
      PluginHeaders: [
        { name: 'NativePosition', methods: [{ name: 'start', rtype: 'promise' }, { name: 'stop', rtype: 'promise' }, { name: 'refresh', rtype: 'promise' },
          { name: 'addListener' }, { name: 'removeListener' }] },
        { name: 'TripSensors', methods: [] },
      ],
      nativePromise: async (plugin, method) => {
        if (plugin !== 'NativePosition') throw new Error('Unexpected plugin ' + plugin);
        if (method === 'start') window.nativeStarted = true;
        if (method === 'refresh') window.refreshRequested = true;
        return status;
      },
      nativeCallback: async (_, method, payload, callback) => {
        if (method === 'removeListener') { handlers.delete(payload.callbackId); return; }
        handlers.set(++id, { name: payload.eventName, callback });
        return id;
      },
    };
    Object.defineProperty(navigator, 'geolocation', { value: {
      watchPosition() { throw new Error('Android must use NativePosition'); },
      getCurrentPosition() { throw new Error('Android must use NativePosition'); },
    } });
    localStorage.setItem('ace:settings', JSON.stringify({ mapEngine: 'maplibre', mapEngineExplicit: true, theme: 'day' }));
    window.sendPosition = (data) => {
      for (const { name, callback } of handlers.values()) if (name === 'position') callback({ at: Date.now(), ...data });
    };
  });
  const page = await ctx.newPage();
  page.on('pageerror', (error) => console.error('[WebView]', error.message));
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  const wait = (fn, arg) => page.waitForFunction(fn, arg, { polling: 150, timeout: 30_000 });
  await wait(() => window.nativeStarted && window.__aceMap?.state().styleReady);
  assert(await page.getByRole('button', { name: 'Старт вручную' }).isVisible());
  assert.equal(await page.evaluate(() => window.__aceMap.state().car), null);

  const good = { lat: 48.46, lon: 35.04, accuracy: 4, speed: 0 };
  const send = (data) => page.evaluate((f) => window.sendPosition(f), data);
  assert.equal(await page.getByRole('button', { name: 'Найти меня' }).count(), 0);
  await wait(() => window.refreshRequested);
  await send({ ...good, source: 'network', accuracy: 1800 });
  assert.equal(await page.evaluate(() => window.__aceMap.state().raw.lat), null);
  await send({ ...good, lat: good.lat + 0.006, source: 'network', accuracy: 380 });
  await wait(() => window.__aceMap.state().nativePosition.trust === 'network' && document.body.innerText.includes('Приблизительная сетевая позиция'));
  await wait(() => document.body.innerText.includes('±380 м') && window.__aceMap.state().accuracyCircle >= 380);
  await page.waitForTimeout(850);
  await send({ ...good, source: 'gps' });
  assert.equal(await page.evaluate(() => window.__aceMap.state().nativePosition.trust), 'network');
  await page.waitForTimeout(850);
  await send({ ...good, source: 'gps' });
  await wait(() => window.__aceMap.state().nativePosition.trust === 'confirmed' && Math.abs(window.__aceMap.state().raw.lat - 48.46) < 0.00001)
    .catch(async (error) => {
      console.error(await page.evaluate(() => window.__aceMap.state()));
      throw error;
    });
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(750);
    await send({ lat: -12.04, lon: -77.04, source: 'fused', accuracy: 4, speed: 10 });
  }
  assert(await page.evaluate(() => {
    const s = window.__aceMap.state();
    return s.nativePosition.trust !== 'confirmed' && s.raw.lat > 48 && s.nativePosition.speedSource !== 'gnss';
  }));
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { get: () => false }); window.dispatchEvent(new Event('offline')); });
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(750);
    await send({ ...good, source: 'gps' });
  }
  await wait(() => window.__aceMap.state().nativePosition.trust === 'confirmed' && window.__aceMap.state().offline.local);
  console.log('✓ Android: Wi-Fi без позиции, приблизительный сеть/GPS, блокировка скачка из другого города и восстановление GNSS без сети');
} finally {
  await browser.close();
}
