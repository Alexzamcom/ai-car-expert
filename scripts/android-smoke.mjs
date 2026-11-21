// Install the CI APK on Android and drive its real WebView with synthetic GPS from the emulator.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const app = 'com.aicarexpert.app';
const apk = process.argv[2];
assert(apk, 'Pass the path of the APK to install');
const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8', timeout: 25_000 }).trim();
const fixture = (name) => readFileSync(new URL(`../tests/fixtures/${name}.json`, import.meta.url), 'utf8');
const route = fixture('osrm-route');
const style = fixture('maplibre-style');

async function until(fn, message, timeout = 60_000) {
  const end = Date.now() + timeout;
  let lastError;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(message, { cause: lastError });
}

adb('install', '-r', apk);
adb('shell', 'settings', 'put', 'system', 'screen_off_timeout', '600000');
adb('shell', 'cmd', 'location', 'set-location-enabled', 'true');
adb('shell', 'am', 'start', '-W', '-n', `${app}/.MainActivity`);
await until(() => {
  const permissions = adb('shell', 'dumpsys', 'package', app);
  if (/android\.permission\.ACCESS_FINE_LOCATION: granted=true/.test(permissions)) return true;
  adb('shell', 'uiautomator', 'dump', '/sdcard/ace-permissions.xml');
  const ui = adb('shell', 'cat', '/sdcard/ace-permissions.xml');
  const allow = ui.match(/<node\b[^>]*permission_allow_foreground_only_button[^>]*>/)?.[0];
  const bounds = allow?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)?.slice(1).map(Number);
  if (bounds) adb('shell', 'input', 'tap', String(Math.round((bounds[0] + bounds[2]) / 2)), String(Math.round((bounds[1] + bounds[3]) / 2)));
  return false;
}, 'Android did not grant precise foreground location via its permission dialog');
console.log('✓ APK installed, launched and granted precise foreground location in Android');

const pid = await until(() => adb('shell', 'pidof', app).split(' ')[0], 'Android app process not found');
adb('forward', 'tcp:9222', `localabstract:webview_devtools_remote_${pid}`);
const endpoint = 'http://127.0.0.1:9222';
await until(async () => {
  const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(2000) });
  return response.ok;
}, 'Debug Android WebView not reachable');
const browser = await chromium.connectOverCDP(endpoint);
try {
  const ctx = browser.contexts()[0];
  const page = await until(() => ctx.pages().find((p) => p.url().startsWith('https://localhost')), 'Capacitor app page not available');
  page.setDefaultTimeout(45_000);
  page.on('pageerror', (error) => console.error('[WebView]', error.message));
  await page.route('**/*', (request) => {
    const url = new URL(request.request().url());
    if (url.origin === 'https://localhost') return request.continue();
    const headers = { 'Access-Control-Allow-Origin': '*' };
    if (url.hostname.includes('openfreemap') && url.pathname.includes('/styles/')) return request.fulfill({ body: style, contentType: 'application/json', headers });
    if (url.pathname.includes('/route/v1/')) return request.fulfill({ body: route, contentType: 'application/json', headers });
    return request.fulfill({ status: 204, headers });
  });
  await page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem('ace:settings') ?? '{}');
    localStorage.setItem('ace:settings', JSON.stringify({ ...settings, mapEngine: 'maplibre', mapEngineExplicit: true, mapLook: 'game', carStyle: '3d', theme: 'day' }));
    localStorage.setItem('ace:diag', JSON.stringify({ on: true }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  assert.equal(await page.evaluate(() => window.Capacitor.getPlatform()), 'android');
  await page.waitForFunction(() => window.__aceMap?.state()?.car3d && window.__aceMap.state().styleReady);
  const sw = await page.evaluate(async () => navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : 0);
  assert.equal(sw, 0, 'The Android asset bundle must not install a service worker');
  console.log('✓ Capacitor WebView opens local assets, MapLibre renders and loads the 3D vehicle layer');

  const fix = (lon, lat) => adb('emu', 'geo', 'fix', String(lon), String(lat));
  const position = async (lon, lat) => {
    await until(async () => {
      fix(lon, lat);
      return await page.evaluate(([x, y]) => {
        const gps = window.__aceMap?.state()?.raw;
        return gps && Math.abs(gps.lat - y) < 0.00006 && Math.abs(gps.lon - x) < 0.00006;
      }, [lon, lat]);
    }, 'WebView did not receive the emulator GPS fix');
  };
  await position(37.6156, 55.757);

  const click = (locator) => locator.evaluate((node) => node.click());
  await page.locator('#map-search').fill('55.779, 37.617');
  await page.locator('form.map-search').evaluate((form) => form.requestSubmit());
  await click(page.locator('.map-panel .place-row').first());
  await click(page.getByRole('button', { name: 'Маршрут сюда', exact: true }));
  await click(page.getByRole('button', { name: 'Поехали', exact: true }));
  await page.waitForFunction(() => document.querySelector('.maneuver') && window.__aceMap.state().routePoints > 2);
  const routePoints = await page.evaluate(() => window.__aceMap.state().routePoints);
  const guideText = await page.locator('.maneuver-instr').textContent();
  assert(guideText?.trim());
  console.log('✓ GPS positions reach WebView and a mocked router response starts turn-by-turn navigation');

  adb('shell', 'input', 'keyevent', '223');
  await until(() => /mWakefulness=Asleep/.test(adb('shell', 'dumpsys', 'power')), 'Emulator screen did not lock');
  fix(37.61524, 55.7573);
  await sleep(2500);
  adb('shell', 'input', 'keyevent', '224');
  adb('shell', 'wm', 'dismiss-keyguard');
  await page.waitForFunction(() => document.visibilityState === 'visible');
  await position(37.61488, 55.7576);
  assert.equal(await page.evaluate(() => window.__aceMap.state().routePoints), routePoints);
  assert(await page.locator('.maneuver').isVisible());
  console.log('✓ Screen sleep/wake delivers a fresh GPS fix and keeps the active route');

  const reveal = page.locator('.driving-reveal');
  if (await reveal.isVisible()) await click(reveal);
  await click(page.locator('.guide-hud'));
  const warning = page.getByRole('button', { name: /Понятно/ });
  if (await warning.count()) await click(warning);
  await page.waitForFunction(() => {
    const stage = document.querySelector('.hud-stage');
    return stage && new DOMMatrixReadOnly(getComputedStyle(stage).transform).a === -1;
  });
  await page.waitForFunction(() => (document.querySelector('.hud-line')?.getAttribute('d') ?? '').includes('L'));
  assert(await page.locator('.hud-maneuver').isVisible());
  console.log('✓ HUD route is rendered in the Android WebView with mirror transform');
} finally {
  await browser.close();
  adb('forward', '--remove', 'tcp:9222');
}
