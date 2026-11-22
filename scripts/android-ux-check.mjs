// Android browser-profile integration and screenshots with synthetic roads and GPS.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { cameraFixtureStyle } from './game-camera-visual.mjs';
const { chromium, devices } = createRequire(import.meta.url)('playwright');
const [url = 'http://localhost:4173/', out = 'android-ux-visuals'] = process.argv.slice(2);
const fixture = (name) => fs.readFileSync(new URL(`../tests/fixtures/${name}`, import.meta.url), 'utf8');
const route = JSON.parse(fixture('osrm-route.json')).routes[0];
const coords = route.geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
const cum = [0];
for (let i = 1; i < coords.length; i++) {
  const a = coords[i - 1], b = coords[i];
  cum.push(cum[i - 1] + 111195 * Math.hypot(b.lat - a.lat, (b.lon - a.lon) * Math.cos(a.lat * Math.PI / 180)));
}
const along = (metres) => {
  const i = Math.max(1, cum.findIndex((d) => d >= metres));
  const a = coords[i - 1], b = coords[i];
  const t = (metres - cum[i - 1]) / (cum[i] - cum[i - 1]);
  return { latitude: a.lat + (b.lat - a.lat) * t, longitude: a.lon + (b.lon - a.lon) * t, accuracy: 5, speed: 10 };
};
const style = cameraFixtureStyle({ fixture, coords, along });
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  const { defaultBrowserType, ...device } = devices['Pixel 7'];
  const ctx = await browser.newContext({ ...device, viewport: { width: 412, height: 798 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
  await ctx.route('**/*', (r) => {
    const target = new URL(r.request().url());
    if (target.origin === new URL(url).origin) return r.continue();
    const headers = { 'Access-Control-Allow-Origin': '*' };
    if (target.pathname.includes('/styles/')) return r.fulfill({ json: style, headers });
    if (target.pathname.includes('/route/v1/')) return r.fulfill({ body: fixture('osrm-route.json'), contentType: 'application/json', headers });
    return r.fulfill({ status: 204, headers });
  });
  await ctx.addInitScript(() => {
    window.CapacitorCustomPlatform = { name: 'android' };
    localStorage.setItem('ace:settings', JSON.stringify({ mapEngine: 'maplibre', mapEngineExplicit: true, theme: 'day', speakNavigation: false }));
    let coords;
    let t = Date.now();
    const callbacks = new Map();
    let id = 0;
    Object.defineProperty(navigator, 'geolocation', { value: {
      getCurrentPosition: (fn) => { if (coords) queueMicrotask(() => fn({ coords, timestamp: t })); },
      watchPosition: (fn) => {
        callbacks.set(++id, fn);
        if (coords) queueMicrotask(() => fn({ coords, timestamp: t }));
        return id;
      },
      clearWatch: (key) => callbacks.delete(key),
    } });
    window.updateTestGPS = (next) => {
      coords = next;
      t = Math.max(t + 1200, Date.now());
      for (const fn of callbacks.values()) fn({ coords, timestamp: t });
    };
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(45_000);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const wait = (fn, arg) => page.waitForFunction(fn, arg, { polling: 150 });
  const click = (button) => page.getByRole('button', { name: button, exact: true }).evaluate((el) => el.click());
  const fix = async (metres) => {
    const position = along(metres);
    await page.evaluate((value) => window.updateTestGPS(value), position);
    await wait(({ latitude, longitude }) => {
      const s = window.__aceMap?.state();
      return s?.raw.lat === latitude && s?.raw.lon === longitude && !window.__aceMap.map.isMoving();
    }, position);
  };
  await wait(() => window.__aceMap?.state().styleReady);
  assert(await page.getByText('Определите местоположение', { exact: true }).isVisible());
  assert(await page.evaluate(() => window.__aceMap.map.getZoom() <= 2 && !window.__aceMap.state().car));
  await fix(1185);
  await wait(() => window.__aceMap.state().car3d && window.__aceMap.state().car);
  assert(await page.getByPlaceholder('Куда едем?').isVisible());
  assert.equal(await page.locator('.dock').count(), 0);
  await page.screenshot({ path: `${out}/01-home.png` });
  const search = page.locator('#map-search');
  await search.evaluate((input) => {
    input.focus();
    const value = '55.779, 37.617';
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  });
  await page.locator('form.map-search').evaluate((form) => form.requestSubmit());
  await page.locator('.map-panel .place-row').first().evaluate((el) => el.click());
  await click('Маршрут сюда');
  await click('Поехали');
  await fix(1240);
  await wait(() => {
    const s = window.__aceMap.state();
    return s.camera.style === 'dynamic' && s.pitch >= 58 && s.car?.y > 0.65 && s.carWidthShare > 0.14 && s.carWidthShare < 0.20;
  });
  assert.equal(await page.locator('.android-cue.is-visible').count(), 0);
  assert(await page.locator('.android-map-controls .hud-btn').isVisible());
  assert(await page.locator('.android-map-controls button.voice-ctl').first().isVisible());
  await page.screenshot({ path: `${out}/02-driving.png` });
  for (const d of [1280, 1320, 1360, 1400, 1430, 1460, 1490, 1520, 1550, 1580]) await fix(d);
  await wait(() => document.querySelector('.android-cue.is-visible') && window.__aceMap.state().pitch < 60);
  await page.screenshot({ path: `${out}/03-approaching-turn.png` });
  await page.locator('.android-map-controls .hud-btn').evaluate((el) => el.click());
  const warning = page.getByRole('button', { name: /Понятно/ });
  if (await warning.count()) await warning.evaluate((el) => el.click());
  const stage = page.locator('.hud-stage');
  await stage.waitFor();
  assert(await page.locator('.hud-maneuver').isVisible());
  assert(await page.locator('.hud-speed').isVisible());
  await stage.evaluate((el) => el.click());
  await click('Зеркально');
  assert.equal(await stage.evaluate((el) => el.classList.contains('is-mirrored')), false);
  await page.locator('.hud-controls').waitFor({ state: 'hidden' });
  await fix(1580);
  await wait(() => document.querySelector('.hud-speed strong')?.textContent !== '—' &&
    document.querySelector('.hud-dist')?.textContent !== 'Уточняем');
  await page.screenshot({ path: `${out}/04-hud.png` });
  await click('Выйти из HUD');
  await page.waitForTimeout(4300);
  assert(await page.getByText('Положение уточняется', { exact: true }).isVisible());
  await page.waitForTimeout(16000);
  assert.equal(await page.getByRole('button', { name: 'Завершить маршрут' }).count(), 0);
  await page.locator('.ml-map canvas').dispatchEvent('pointerdown');
  await page.getByRole('button', { name: 'Завершить маршрут' }).waitFor();
  console.log('✓ Старт без GPS, поиск, маршрут, камера, приближение, HUD, потеря GPS и скрытие управления');
} finally {
  await browser.close();
}
