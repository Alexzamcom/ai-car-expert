// Android browser-profile integration and screenshots with synthetic roads and GPS.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { cameraFixtureStyle } from './game-camera-visual.mjs';
const { chromium, devices } = createRequire(import.meta.url)('playwright');
const [url = 'http://localhost:4173/', out = 'android-ux-visuals'] = process.argv.slice(2);
const cameraVideo = process.env.ACE_CAMERA_VIDEO === '1';
const roadTest = process.env.ACE_ROAD_TEST === '1';
const gameHud = process.env.ACE_GAME_HUD === '1';
const record = process.env.ACE_HUD_VIDEO === '1';
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
  const ctx = await browser.newContext({ ...device, viewport: { width: 412, height: 798 }, deviceScaleFactor: 1, serviceWorkers: 'block', ...(record ? { recordVideo: { dir: out, size: { width: 412, height: 798 } } } : {}) });
  await ctx.route('**/*', (r) => {
    const target = new URL(r.request().url());
    if (target.origin === new URL(url).origin) return r.continue();
    const headers = { 'Access-Control-Allow-Origin': '*' };
    if (target.pathname.includes('/styles/')) return r.fulfill({ json: style, headers });
    if (target.pathname.includes('/route/v1/')) return r.fulfill({ body: fixture('osrm-route.json'), contentType: 'application/json', headers });
    return r.fulfill({ status: 204, headers });
  });
  await ctx.addInitScript((game) => {
    if (game && !localStorage.getItem('ace:hud')) localStorage.setItem('ace:hud', JSON.stringify({ style: 'game' }));
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
  }, gameHud);
  const page = await ctx.newPage();
  page.setDefaultTimeout(45_000);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const wait = (fn, arg) => page.waitForFunction(fn, arg, { polling: 150, timeout: 30_000 });
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
  assert(await page.getByText('Ищем местоположение…', { exact: true }).isVisible());
  assert(await page.evaluate(() => window.__aceMap.map.getZoom() <= 2 && !window.__aceMap.state().car));
  await fix(1185);
  await wait(() => window.__aceMap.state().car3d && window.__aceMap.state().car);
  assert(await page.getByPlaceholder('Куда едем?').isVisible());
  assert.equal(await page.locator('.dock').count(), 0);
  await page.screenshot({ path: `${out}/01-home.png` });
  if (roadTest) {
    const saved = [];
    const originalPosition = await page.evaluate(() => window.__aceMap.state().raw);
    const touchscreen = await ctx.newCDPSession(page);
    const touch = (type, points) => touchscreen.send('Input.dispatchTouchEvent', { type, touchPoints: points });
    for (const [type, label] of [['Дом', 'Дом'], ['Работа', 'Работа'], ['Другое', 'Тестовая точка']]) {
      await page.locator('#map-search').focus();
      await click('Добавить место');
      const editor = page.locator('.place-editor');
      const radio = editor.getByRole('radio', { name: type, exact: true });
      if (await radio.count()) await radio.click();
      if (label === 'Тестовая точка') await editor.locator('input').first().fill(label);
      await click('Указать на карте');
      const picker = page.getByRole('dialog', { name: 'Выбор места на карте' });
      await picker.waitFor();
      assert.equal(await page.locator('.place-editor').count(), 0);
      assert(await page.locator('.app').evaluate((root) => root.inert));
      const confirm = picker.getByRole('button', { name: 'Подтвердить' });
      await wait(() => document.querySelector('.place-map-picker .btn-primary')?.disabled === false);
      if (type === 'Дом') {
        await touch('touchStart', [{ x: 274, y: 351, id: 1 }]);
        await touch('touchEnd', []);
        await page.waitForTimeout(900);
        await confirm.click();
        const savedPlace = await page.evaluate(() => JSON.parse(localStorage.getItem('ace:places'))?.find((p) => p.placeType === 'home'));
        assert(savedPlace && Math.abs(savedPlace.lon - originalPosition.lon) > 0.0001, 'A real tap must save coordinates under the finger');
        saved.push(label);
        await page.getByRole('button', { name: 'Маршрут: Дом' }).waitFor();
        continue;
      }
      await page.mouse.move(200, 330);
      await page.mouse.down();
      await page.mouse.move(240, 356, { steps: 8 });
      await page.mouse.up();
      if (type === 'Работа') {
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${out}/06-place-picker.png` });
        await page.setViewportSize({ width: 798, height: 412 });
        await wait(() => document.querySelector('.place-map-picker canvas')?.clientHeight === 412);
        await page.screenshot({ path: `${out}/06-place-picker-landscape.png` });
        await page.setViewportSize({ width: 412, height: 798 });
        await wait(() => document.querySelector('.place-map-picker canvas')?.clientHeight === 798);
      }
      await confirm.click();
      saved.push(label);
      await page.getByRole('button', { name: `Маршрут: ${label}` }).waitFor();
    }
    await touchscreen.detach();
    await page.getByRole('button', { name: 'Изменить: Дом' }).click();
    await click('Указать на карте');
    await page.getByRole('dialog', { name: 'Выбор места на карте' }).waitFor();
    await page.getByRole('dialog', { name: 'Выбор места на карте' }).getByRole('button', { name: 'Отмена' }).click();
    await page.locator('.place-editor').getByRole('button', { name: 'Отмена' }).click();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await wait(() => window.__aceMap?.state().styleReady);
    await fix(1185);
    await page.locator('#map-search').focus();
    for (const label of saved) await page.getByRole('button', { name: `Маршрут: ${label}` }).waitFor();
    console.log('✓ Полноэкранный выбор трёх мест, отмена и восстановление после перезапуска');
  }
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
    return s.camera.style === 'dynamic' && s.pitch >= 65 && s.zoom > 18.7 && s.car?.y > 0.67 && s.carLengthM === 4.8 && s.carWidthShare > 0.015 && s.carWidthShare < 0.13;
  });
  assert.equal(await page.locator('.android-cue.is-visible').count(), 0);
  assert(await page.locator('.android-map-controls .hud-btn').isVisible());
  assert(await page.locator('.android-map-controls button.voice-ctl').first().isVisible());
  await page.screenshot({ path: `${out}/02-driving.png` });
  const verifyOrientation = async (selector) => {
    for (const [width, height] of [[798, 412], [412, 798], [798, 412], [412, 798]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
      await wait(({ selector, width, height }) => {
        const box = document.querySelector(selector)?.getBoundingClientRect();
        return box && Math.abs(box.width - width) <= 2 && Math.abs(box.height - height) <= 2;
      }, { selector, width, height });
    }
  };
  if (roadTest) {
    const count = await page.evaluate(() => window.__aceMap.state().routePoints);
    await verifyOrientation('.ml-map canvas');
    assert.equal(await page.evaluate(() => window.__aceMap.state().routePoints), count);
    await wait(() => window.__aceMap.state().camera.following);
    await page.evaluate(() => {
      const map = window.__aceMap.map;
      const center = map.getCenter();
      map.jumpTo({ center: [center.lng + 0.03, center.lat] });
    });
    await wait(() => {
      const car = window.__aceMap.state().car;
      return car && Math.abs(car.x - 0.5) < 0.02 && car.y > 0.67;
    });
    console.log('✓ Смена ориентации карты и автоматическое восстановление сопровождения после стороннего сдвига');
  }
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    window.dispatchEvent(new Event('offline'));
  });
  for (const d of [1280, 1320, 1360, 1400, 1430, 1460, 1490, 1520, 1550, 1580]) await fix(d);
  await wait(() => document.querySelector('.android-cue.is-visible') && window.__aceMap.state().pitch < 60);
  assert(await page.evaluate(() => !navigator.onLine && window.__aceMap.state().camera.lift > 0.4));
  await page.screenshot({ path: `${out}/03-offline-turn.png` });
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    window.dispatchEvent(new Event('online'));
  });
  await fix(1590);
  await wait(() => {
    const s = window.__aceMap.state();
    return s.styleReady && s.gameLayers.includes('game-buildings') && s.camera.lift >= 0.55 && s.pitch < 59;
  });
  await page.screenshot({ path: `${out}/03-approaching-turn.png` });
  if (cameraVideo) {
    for (const d of [1605, 1620, 1635, 1650, 1665, 1690, 1730]) {
      await fix(d);
      await page.waitForTimeout(250);
    }
    await wait(() => {
      const { pitch, camera } = window.__aceMap.state();
      return camera.following && camera.target?.pitch >= 67 && pitch > 64;
    });
    await page.screenshot({ path: `${out}/07-camera-return.png` });
    const video = page.video();
    await ctx.close();
    await video.saveAs(`${out}/road-test-camera.webm`);
  }
  if (!cameraVideo) {
  await page.locator('.android-map-controls .hud-btn').evaluate((el) => el.click());
  const warning = page.getByRole('button', { name: /Понятно/ });
  if (await warning.count()) await warning.evaluate((el) => el.click());
  const stage = page.locator('.hud-stage');
  await stage.waitFor();
  if (roadTest || gameHud) await verifyOrientation('.hud-stage');
  assert(await page.locator('.hud-maneuver').isVisible());
  assert(await page.locator('.hud-speed').isVisible());
  assert.equal(await stage.evaluate((node) => new DOMMatrixReadOnly(getComputedStyle(node).transform).a), -1);
  if (gameHud) {
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
      window.dispatchEvent(new Event('offline'));
    });
    await fix(1590);
    await wait(() => Number(document.querySelector('.hud-game-road')?.dataset.chevrons) >= 2);
    await page.screenshot({ path: `${out}/05-game-mirrored-offline.png` });
  } else {
    assert.equal(await page.locator('.hud-game-road').count(), 0);
    await page.screenshot({ path: `${out}/05-classic-mirrored.png` });
  }
  await stage.evaluate((el) => el.click());
  await click('Зеркально');
  assert.equal(await stage.evaluate((el) => el.classList.contains('is-mirrored')), false);
  await page.locator('.hud-controls').waitFor({ state: 'hidden' });
  await fix(1590);
  await wait(() => document.querySelector('.hud-speed strong')?.textContent !== '—' &&
    document.querySelector('.hud-dist')?.textContent !== 'Уточняем');
  await page.screenshot({ path: `${out}/04-hud.png` });
  if (gameHud) {
    const frame = () => page.locator('.hud-game-road').evaluate((c) => c.toDataURL());
    const before = await frame();
    for (const d of [1605, 1620, 1635, 1650, 1665, 1680]) {
      await fix(d);
      await page.waitForTimeout(220);
    }
    await wait(() => document.querySelector('.hud-game-road')?.dataset.chevrons === '0');
    assert.notEqual(await frame(), before);
    for (const d of [1695, 1700]) await fix(d);
    await wait(() => document.querySelector('.hud-status')?.textContent === 'Положение уточняется');
    assert.equal(await page.locator('.hud-game-road').getAttribute('data-chevrons'), '0');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.hud[data-style="game"]').waitFor();
    assert.equal(await page.locator('.hud').getAttribute('data-mirror'), '0');
    assert.equal(await page.locator('.hud-game-road').getAttribute('data-chevrons'), '0');
    console.log('✓ Игровой HUD: сохранённый стиль, зеркальное отображение, движение шевронов офлайн, исчезновение после манёвра и при потере позиции');
    if (record) {
      const video = page.video();
      await ctx.close();
      await video.saveAs(`${out}/game-hud-turn.webm`);
    }
  }
  if (!gameHud) {
  await click('Выйти из HUD');
  await wait(() => document.querySelector('.android-position-tag') ||
    document.querySelector('.android-cue.is-visible')?.textContent.includes('Положение уточняется'));
  if (roadTest) {
    for (const d of [1605, 1620, 1635, 1650, 1665, 1690, 1730]) await fix(d);
    await wait(() => {
      const { pitch, camera } = window.__aceMap.state();
      return camera.following && camera.target?.pitch >= 67 && pitch > 64;
    });
    await page.screenshot({ path: `${out}/07-camera-return.png` });
    const cdp = await ctx.newCDPSession(page);
    const input = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
      type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }],
    });
    await input('touchStart', 175, 424);
    for (const x of [190, 210, 235, 260, 285]) {
      await input('touchMove', x, 420);
      await page.waitForTimeout(65);
    }
    await input('touchEnd');
    await cdp.detach();
    await page.getByRole('button', { name: 'Вернуться к автомобилю' }).waitFor();
  }
  const activeCue = page.locator('.android-cue.is-visible');
  if (await activeCue.count()) assert.match(await activeCue.innerText(), /Положение уточняется/);
  await page.waitForTimeout(20500);
  assert.equal(await page.getByRole('button', { name: 'Завершить маршрут' }).count(), 0);
  if (roadTest) {
    const back = page.getByRole('button', { name: 'Вернуться к автомобилю' });
    assert(await back.isVisible());
    await back.click();
    await wait(() => {
      const s = window.__aceMap.state();
      return s.camera.following && s.car?.y > 0.67 && s.routePoints > 2;
    });
    console.log('✓ Камера вернулась после манёвра, ручного сдвига и скрытия интерфейса');
  }
  await page.locator('.ml-map canvas').dispatchEvent('pointerdown');
  await page.getByRole('button', { name: 'Завершить маршрут' }).waitFor();
  console.log('✓ Старт без GPS, поиск, маршрут, камера, приближение, HUD, потеря GPS и скрытие управления');

  }
  }
} finally {
  await browser.close();
}
