// Install the CI APK on Android and drive its real WebView with synthetic GPS from the emulator.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { _android as android } from 'playwright';

const app = 'com.aicarexpert.app';
const modern = process.env.EXPECT_ANDROID_UX === '1';
const confirmedRoute = process.env.EXPECT_CONFIRMED_ROUTE === '1';
const scaleCheck = process.env.EXPECT_NAVIGATION_SCALE === '1';
const hybrid = process.env.EXPECT_NATIVE_POSITION === '1';
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

const apiLevel = Number(adb('shell', 'getprop', 'ro.build.version.sdk'));
let webViewVersion = null;
if (apiLevel <= 29) {
  // The old image can spend a full minute initializing PackageManager after boot.
  console.log(execFileSync('adb', ['install', '--no-streaming', '-r', '-g', apk], { encoding: 'utf8', timeout: 120_000 }).trim());
  const provider = adb('shell', 'dumpsys', 'webviewupdate').split('\n').find((line) => line.includes('Current WebView package'));
  console.log(provider);
  webViewVersion = Number(provider?.match(/, (\d+)\./)?.[1]) || null;
} else adb('install', '-r', ...(scaleCheck ? ['-g'] : []), apk);
adb('shell', 'settings', 'put', 'system', 'screen_off_timeout', '600000');
if (apiLevel <= 29) adb('shell', 'settings', 'put', 'secure', 'location_mode', '3');
else adb('shell', 'cmd', 'location', 'set-location-enabled', 'true');
if (hybrid) adb('emu', 'geo', 'fix', '37.6156', '55.757');
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
}, 'Android did not grant precise foreground location');
console.log('✓ APK installed, launched and granted precise foreground location in Android');
if (apiLevel <= 29 && webViewVersion != null && webViewVersion < 80) {
  assert(adb('shell', 'pidof', app), 'The Android 10 activity did not stay running');
  console.log(`✓ Android 10 package/permissions/launch smoke. WebView ${webViewVersion} predates the module workers required by MapLibre; skipping browser driving on this image.`);
  process.exit(0);
}

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
    let sequence = 0;
    await until(async () => {
      fix(lon + (hybrid ? (++sequence % 2) * 0.000005 : 0), lat);
      return await page.evaluate(([x, y]) => {
        const gps = window.__aceMap?.state()?.raw;
        return gps && Math.abs(gps.lat - y) < 0.00006 && Math.abs(gps.lon - x) < 0.00006;
      }, [lon, lat]);
    }, 'WebView did not receive the emulator GPS fix');
  };
  await position(37.6156, 55.757);
  if (hybrid) {
    assert(await page.evaluate(() => window.Capacitor.isPluginAvailable('NativePosition')));
    await page.waitForFunction(() => {
      const native = window.__aceMap.state().nativePosition;
      return native.trust === 'confirmed' && ['fused', 'gps'].includes(native.source);
    });
    console.log('✓ Native Android location confirms the emulator fix');
  }

  const click = (locator) => locator.evaluate((node) => node.click());
  if (modern) {
    await page.waitForFunction(() => window.__aceMap.state().car && !window.__aceMap.map.isMoving());
    assert(await page.getByPlaceholder('Куда едем?').isVisible());
    assert(await page.getByRole('button', { name: 'Моё местоположение' }).isVisible());
    assert.equal(await page.locator('.dock').count(), 0);
    await page.screenshot({ path: `${screenshotDir}/01-home.png` });
  }
  async function confirmNativeMapTap() {
    const confirm = page.getByRole('button', { name: 'Подтвердить', exact: true });
    await page.waitForFunction(() => [...document.querySelectorAll('.place-map-picker button')]
      .some((button) => button.textContent === 'Подтвердить' && !button.disabled));
    const viewport = await page.locator('.place-map-picker-map').evaluate((node) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height, viewportWidth: innerWidth, viewportHeight: innerHeight };
    });
    adb('shell', 'uiautomator', 'dump', '/sdcard/ace-picker.xml');
    const tree = adb('shell', 'cat', '/sdcard/ace-picker.xml');
    const webViewNode = tree.match(/<node\b[^>]*class="android\.webkit\.WebView"[^>]*>/)?.[0];
    const bounds = webViewNode?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)?.slice(1).map(Number);
    // The instrumentation tree can omit the WebView subtree on some emulator
    // builds. Use the full-screen viewport and measured Android display there.
    const [, screenWidth, screenHeight] = [...adb('shell', 'wm', 'size').matchAll(/(\d+)x(\d+)/g)].at(-1);
    const [left, top, right] = bounds ?? [0, Math.max(0, (Number(screenHeight) -
      Number(screenWidth) * viewport.viewportHeight / viewport.viewportWidth) / 2), Number(screenWidth)];
    const scale = (right - left) / viewport.viewportWidth;
    const tapX = Math.round(left + (viewport.x + viewport.width * 0.67) * scale);
    const tapY = Math.round(top + (viewport.y + viewport.height * 0.43) * scale);
    adb('shell', 'input', 'touchscreen', 'tap', String(tapX), String(tapY));
    await page.waitForFunction(() => parseFloat(document.querySelector('.place-map-picker-pin')?.style.left) >
      document.querySelector('.place-map-picker-map')?.clientWidth * 0.60).catch(async (error) => {
        await page.screenshot({ path: `${screenshotDir}/place-picker-failure.png` });
        throw error;
      });
    await click(confirm);
  }
  if (process.env.EXPECT_PHONE_PICKER === '1') {
    await page.locator('#map-search').evaluate((input) => input.focus());
    await click(page.getByRole('button', { name: 'Добавить место' }));
    await click(page.locator('.place-editor').getByRole('radio', { name: 'Дом', exact: true }));
    await click(page.getByRole('button', { name: 'Указать на карте' }));
    await confirmNativeMapTap();
    assert(await page.evaluate(() => {
      const home = JSON.parse(localStorage.getItem('ace:places') ?? '[]').find((place) => place.placeType === 'home');
      return home && Math.abs(home.lon - 37.6156) > 0.0001;
    }));
    console.log('✓ Android touchscreen moves the pin and saves the tapped position');
  }
  if (process.env.EXPECT_ROUTE_PLANNER === '1') {
    await click(page.locator('.android-menu-button'));
    await click(page.getByRole('button', { name: 'Построить маршрут', exact: true }));
    await page.waitForFunction(() => document.querySelector('.route-planner') && window.__aceMap?.state().styleReady);
    await click(page.getByRole('button', { name: 'Выбрать на карте', exact: true }));
    await confirmNativeMapTap();
    await page.locator('.route-planner-field').getByText('Старт на карте', { exact: true }).waitFor();
    await click(page.getByRole('button', { name: 'Назад', exact: true }));
    await page.locator('#map-search').waitFor();
    console.log('✓ Android touchscreen confirms an endpoint in the full-screen route planner');
  }
  if (process.env.EXPECT_AUTONOMY === '1') {
    assert(await page.evaluate(() => window.Capacitor.isPluginAvailable('TripSensors')));
    const button = (name) => page.getByRole('button', { name, exact: true });
    const open = modern ? 'Экспериментальная поездка' : 'GPS показывает неверное местоположение';
    if (modern) await click(page.locator('.android-menu-button'));
    await click(button(open));
    await page.waitForFunction(() => window.__aceMap?.state()?.styleReady && document.querySelector('.autonomy-crosshair'));
    const [lon, lat] = JSON.parse(route).routes[0].geometry.coordinates[0];
    await page.evaluate(([x, y]) => window.__aceMap.map.jumpTo({ center: [x, y], zoom: 17 }), [lon, lat]);
    await click(button('Установить автомобиль'));
    if (hybrid) {
      // The ordinary native stream is suspended during this experiment.
      fix(37.6201, 55.7601);
      await sleep(1000);
      fix(37.6156, 55.757);
    } else await position(37.6201, 55.7601);
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
      return map.camera.style === 'dynamic' && map.pitch >= 65 && map.zoom > 18.7 && map.car?.y > 0.67 && map.carLengthM === 4.8 && map.carWidthShare >= 0.015 && map.carWidthShare <= 0.13;
    });
    assert.equal(await page.locator('.android-cue.is-visible').count(), 0, 'A distant turn must leave the map clear');
    await page.screenshot({ path: `${screenshotDir}/02-driving.png` });
    if (scaleCheck) {
      // Sample the actual WebView rendering loop while successive GNSS fixes move the chase camera.
      const sample = page.evaluate(() => new Promise((resolve) => {
        let renders = 0;
        const intervals = [];
        const map = window.__aceMap.map;
        const onRender = () => renders++;
        map.on('render', onRender);
        const start = performance.now();
        let previous = start;
        const frame = (now) => {
          intervals.push(now - previous);
          previous = now;
          if (now - start >= 2500) {
            map.off('render', onRender);
            intervals.sort((a, b) => a - b);
            resolve({ renders, frames: intervals.length, p95Ms: Math.round(intervals[Math.floor(intervals.length * 0.95)]) });
          } else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }));
      for (let i = 1; i <= 3; i++) {
        fix(37.6156 - i * 0.000063, 55.757 + i * 0.000052);
        await sleep(850);
      }
      const performance = await sample;
      console.log('Android WebView render sample:', JSON.stringify(performance));
      assert(performance.frames >= 8 && performance.renders >= 4 && performance.p95Ms < 1000, 'Android WebView rendering stalled');
    }

  } else {
    const guideText = await page.locator('.maneuver-instr').textContent();
    assert(guideText?.trim());
  }
  console.log('✓ GPS positions reach WebView and a mocked router response starts turn-by-turn navigation');

  adb('shell', 'input', 'keyevent', '223');
  await until(() => /mWakefulness=Asleep/.test(adb('shell', 'dumpsys', 'power')), 'Emulator screen did not lock');
  if (hybrid) fix(37.61553, 55.75708);
  else fix(37.61524, 55.7573);
  await sleep(2500);
  adb('shell', 'input', 'keyevent', '224');
  adb('shell', 'wm', 'dismiss-keyguard');
  await page.waitForFunction(() => document.visibilityState === 'visible');
  // The native estimator must reject a teleport from a stopped vehicle.
  // Advance ~20 m across sleep/wake so reacquisition tests a reachable trajectory.
  if (hybrid) {
    await position(37.61546, 55.75716);
    await page.waitForFunction(() => window.__aceMap.state().nativePosition.trust === 'confirmed');
  } else await position(37.61488, 55.7576);
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
  if (confirmedRoute) {
    await click(page.getByRole('button', { name: 'Выйти из HUD', exact: true }));
    await page.waitForFunction(() => window.__aceMap?.state()?.routePoints > 2);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ace:nav-session')));
    assert(saved.guiding && saved.routeId && saved.builtAt > 0);
    assert.equal(saved.route.coords.length, saved.geometry.cum.length);
    assert.equal(saved.route.steps.length, saved.geometry.offsets.length);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'onLine', { get: () => false });
      localStorage.removeItem('ace:hud');
    });
    let requests = 0;
    await page.route('**/route/v1/**', (request) => { requests++; return request.abort(); });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !navigator.onLine && window.__aceMap?.state()?.routePoints > 2);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ace:nav-session')).routeId), saved.routeId);
    assert.equal(requests, 0, 'Restoring a confirmed route offline must never call the router');
    console.log('✓ Android WebView resumes the saved confirmed route offline without a router request');
  }
} catch (error) {
  if (hybrid) {
    const providers = adb('shell', 'dumpsys', 'location').split('\n')
      .filter((line) => /last location|com\.aicarexpert\.app|provider manager|enabled=/.test(line));
    console.error('Android location providers:', providers.slice(0, 80).join('\n'));
    const logs = adb('logcat', '-d', '-s', 'Capacitor', 'Capacitor/Plugin', 'AndroidRuntime');
    console.error('Native bridge:', logs.split('\n').filter((line) => /NativePosition|FATAL|Exception/.test(line)).slice(-20).join('\n'));
  }
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
