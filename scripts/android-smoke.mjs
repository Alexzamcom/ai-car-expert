// Install the CI APK on Android and drive its real WebView with synthetic GPS from the emulator.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { _android as android } from 'playwright';

const app = 'com.aicarexpert.app';
const modern = process.env.EXPECT_ANDROID_UX === '1';
const screenshotDir = 'android-navigation-screens';
if (modern) mkdirSync(screenshotDir, { recursive: true });
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

const [device] = await android.devices();
assert(device, 'Playwright did not find the Android emulator');
let page;
try {
  const webView = await device.webView({ pkg: app }, { timeout: 60_000 });
  page = await webView.page();
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
  if (modern) {
    await page.waitForFunction(() => window.__aceMap.state().car && !window.__aceMap.map.isMoving());
    assert(await page.getByPlaceholder('Куда едем?').isVisible());
    assert(await page.getByRole('button', { name: 'Моё местоположение' }).isVisible());
    assert.equal(await page.locator('.dock').count(), 0);
    await page.screenshot({ path: `${screenshotDir}/01-home.png` });
  }
  if (process.env.EXPECT_AUTONOMY === '1') {
    assert(await page.evaluate(() => window.Capacitor.isPluginAvailable('TripSensors')));
    const button = (name) => page.getByRole('button', { name, exact: true });
    const open = 'GPS показывает неверное местоположение';
    if (modern) await click(page.locator('.android-menu-button'));
    await click(button(open));
    await page.waitForFunction(() => window.__aceMap?.state()?.styleReady && document.querySelector('.autonomy-crosshair'));
    const [lon, lat] = JSON.parse(route).routes[0].geometry.coordinates[0];
    await page.evaluate(([x, y]) => window.__aceMap.map.jumpTo({ center: [x, y], zoom: 17 }), [lon, lat]);
    await click(button('Установить автомобиль'));
    await position(37.6201, 55.7601);
    const manual = await page.evaluate(() => window.__aceMap.state().experimentalEstimate);
    assert(Math.abs(manual.lat - lat) < 0.00001 && Math.abs(manual.lon - lon) < 0.00001);
    await page.evaluate(([x, y]) => window.__aceMap.map.jumpTo({ center: [x + 0.003, y], zoom: 17 }), [lon, lat]);
    await click(button('Построить маршрут сюда'));
    await click(button('Начать поездку без GPS'));
    const hudButton = button('HUD');
    const end = button('Завершить поездку');
    const unavailable = page.getByText(/Датчики движения недоступны|Не удалось запустить датчики/);
    await hudButton.or(unavailable).first().waitFor();
    if (await hudButton.isVisible()) {
      await click(hudButton);
      const warning = page.getByRole('button', { name: /Понятно/ });
      if (await warning.count()) await click(warning);
      await page.locator('.hud-stage').waitFor();
      assert(await page.locator('.hud-speed').isVisible());
      await click(button('Выйти из HUD'));
      await click(button('Меню поездки'));
      await click(end);
      await click(button('Выйти без записи'));
      console.log('✓ Android native sensor bridge started the manually anchored experimental trip');
    } else {
      await click(button('Отмена'));
      console.log('✓ Android native sensor bridge reports missing emulator sensors and preserves manual setup');
    }
    await page.waitForFunction(() => window.__aceMap?.state()?.styleReady && document.querySelector('#map-search'));
    await position(37.6156, 55.757);
  }
  await page.locator('#map-search').fill('55.779, 37.617');
  await page.locator('form.map-search').evaluate((form) => form.requestSubmit());
  await click(page.locator('.map-panel .place-row').first());
  await click(page.getByRole('button', { name: 'Маршрут сюда', exact: true }));
  await click(page.getByRole('button', { name: 'Поехали', exact: true }));
  const guiding = page.locator(modern ? '.android-guiding' : '.maneuver');
  await guiding.waitFor();
  await page.waitForFunction(() => window.__aceMap.state().routePoints > 2);
  await page.waitForFunction(() => {
    const map = window.__aceMap.state();
    return map.look === 'game' && map.pitch > 40 && map.gameLayers.includes('game-buildings');
  });
  const routePoints = await page.evaluate(() => window.__aceMap.state().routePoints);
  if (modern) {
    await page.waitForFunction(() => {
      const map = window.__aceMap.state();
      return map.camera.style === 'dynamic' && map.pitch >= 57 && map.car?.y > 0.64 && map.carWidthShare >= 0.13 && map.carWidthShare <= 0.21;
    });
    assert.equal(await page.locator('.android-cue.is-visible').count(), 0, 'A distant turn must leave the map clear');
    await page.screenshot({ path: `${screenshotDir}/02-driving.png` });
  } else {
    const guideText = await page.locator('.maneuver-instr').textContent();
    assert(guideText?.trim());
  }
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
  assert(await guiding.isVisible());
  console.log('✓ Screen sleep/wake delivers a fresh GPS fix and keeps the active route');

  const reveal = page.locator('.driving-reveal');
  if (await reveal.isVisible()) await click(reveal);
  await click(modern ? page.locator('.android-map-controls .hud-btn') : page.locator('.guide-hud'));
  const warning = page.getByRole('button', { name: /Понятно/ });
  if (await warning.count()) await click(warning);
  await page.waitForFunction(() => {
    const stage = document.querySelector('.hud-stage');
    return stage && new DOMMatrixReadOnly(getComputedStyle(stage).transform).a === -1;
  });
  await page.waitForFunction(() => (document.querySelector('.hud-line')?.getAttribute('d') ?? '').includes('L'));
  if (modern) {
    assert.equal(await page.locator('.hud-maneuver').count(), 0, 'HUD shares the distant-turn visibility rule');
    await page.screenshot({ path: `${screenshotDir}/03-hud.png` });
  } else assert(await page.locator('.hud-maneuver').isVisible());
  if (process.env.EXPECT_AUTONOMY === '1') assert(await page.locator('.hud-speed').isVisible());
  console.log('✓ HUD route is rendered in the Android WebView with mirror transform');
} catch (error) {
  if (page) {
    const status = await page.evaluate(() => ({
      url: location.href,
      visibility: document.visibilityState,
      map: window.__aceMap?.state?.(),
      ui: document.querySelector('.map-ui, .navigation, .hud')?.innerText.slice(0, 1200),
    })).catch(() => null);
    console.error('Android smoke state:', JSON.stringify(status));
  }
  throw error;
} finally {
  await device.close();
}
