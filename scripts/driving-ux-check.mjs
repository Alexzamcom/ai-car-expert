// Regression suite for #37. Run against a local production build.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const [url = 'http://localhost:4173/', out = 'smoke-local/driving-ux'] = process.argv.slice(2).filter((arg) => arg !== '--baseline');
const baseline = process.argv.includes('--baseline');
const fixture = (name) => readFile(new URL(`../tests/fixtures/${name}.json`, import.meta.url), 'utf8');
const [route, places, style] = await Promise.all(['osrm-route', 'nominatim', 'maplibre-style'].map(fixture));
const coords = JSON.parse(route).routes[0].geometry.coordinates;
const [a, b] = coords.slice(-2);
const scaleX = 111320 * Math.cos(b[1] * Math.PI / 180);
const dx = (b[0] - a[0]) * scaleX;
const dy = (b[1] - a[1]) * 111320;
const length = Math.hypot(dx, dy);
const course = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
const beforeEnd = (distance, accuracy = 6, side = 0) => ({
  longitude: b[0] - (dx * distance - dy * side) / length / scaleX,
  latitude: b[1] - (dy * distance + dx * side) / length / 111320,
  accuracy,
  speed: 10,
  heading: course,
});

await mkdir(out, { recursive: true });
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ ...devices['iPad Pro 11'], deviceScaleFactor: 1, serviceWorkers: 'block', reducedMotion: 'reduce' });
  await ctx.route('**/*', (r) => {
    const u = new URL(r.request().url());
    if (u.origin === new URL(url).origin) return r.continue();
    const body = u.hostname.includes('openfreemap') && !u.pathname.endsWith('.pbf') ? style
      : u.hostname.includes('nominatim') ? places
      : u.pathname.includes('/route/v1/') ? route : null;
    return r.fulfill({ status: body ? 200 : 204, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: body ?? '' });
  });
  await ctx.addInitScript(({ initial, baseline }) => {
    localStorage.setItem('ace:settings', JSON.stringify({ mapEngine: baseline ? 'leaflet' : 'maplibre', minimalGuidance: true, speakNavigation: true }));
    let coords = initial;
    let timestamp = Date.now();
    const realTimeout = window.setTimeout.bind(window);
    const realClear = window.clearTimeout.bind(window);
    let idleTime = 0;
    let timerId = -1;
    const idleTimers = new Map();
    window.setTimeout = (callback, delay, ...args) => {
      if (delay !== 20_000) return realTimeout(callback, delay, ...args);
      idleTimers.set(--timerId, { due: idleTime + delay, callback, args });
      return timerId;
    };
    window.clearTimeout = (id) => Number(id) < 0 ? idleTimers.delete(id) : realClear(id);
    window.advanceDrivingIdle = (ms) => {
      idleTime += ms;
      for (const [id, timer] of idleTimers) {
        if (timer.due <= idleTime) {
          idleTimers.delete(id);
          timer.callback(...timer.args);
        }
      }
    };
    const watchers = new Map();
    let id = 0;
    const position = () => ({ coords, timestamp });
    Object.defineProperty(navigator, 'geolocation', { value: {
      getCurrentPosition: (callback) => queueMicrotask(() => callback(position())),
      watchPosition: (callback) => {
        watchers.set(++id, callback);
        queueMicrotask(() => callback(position()));
        return id;
      },
      clearWatch: (id) => watchers.delete(id),
    } });
    window.sendDrivingFix = (fix) => {
      coords = fix;
      timestamp = Math.max(Date.now(), timestamp + 1_000);
      watchers.values().next().value?.(position());
    };
  }, { initial: beforeEnd(150), baseline });
  const page = await ctx.newPage();
  const click = (locator) => locator.evaluate((el) => el.click());
  page.setDefaultTimeout(25_000);
  await page.goto(url, { waitUntil: 'load' });
  if (!baseline) await page.waitForFunction(() => window.__aceMap?.state()?.car);
  console.log('✓ Локальная карта загружена');
  await page.locator('#map-search').fill('Театр Сатиры');
  await page.locator('#map-search').press('Enter');
  await click(page.locator('.map-panel .place-row').first());
  await click(page.getByRole('button', { name: 'Маршрут сюда', exact: true }));
  await click(page.getByRole('button', { name: 'Поехали', exact: true }));
  const bar = page.locator('.guide-bar');
  const maneuver = page.locator('.maneuver');
  const reveal = page.getByRole('button', { name: 'Показать панель управления', exact: true });
  await bar.waitFor();
  assert.match(await maneuver.innerText(), baseline ? /150 м[\s\S]*Вы прибыли/ : /150 м[\s\S]*Пункт назначения/);
  console.log('✓ Подпись у отметки 150 м');
  await page.screenshot({ path: `${out}/${baseline ? 'before' : 'after'}-150m.png` });
  if (!baseline) {
    await page.evaluate(() => window.advanceDrivingIdle(19_999));
    assert(await bar.isVisible());
    await page.mouse.move(410, 500);
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointermove')));
    await page.evaluate(() => window.advanceDrivingIdle(19_999));
    assert(await bar.isVisible(), 'Движение указателя над картой сбрасывает таймер');
    await page.evaluate(() => window.advanceDrivingIdle(1));
    await reveal.waitFor();
    console.log('✓ Панель скрылась на границе 20 секунд');
    assert(!(await bar.isVisible()), 'Через 20 секунд панель скрыта');
    const mute = page.locator('.compact-voice');
    await click(mute);
    assert.equal(await mute.getAttribute('aria-pressed'), 'true');
    await page.screenshot({ path: `${out}/after-hidden.png` });

    const cdp = await ctx.newCDPSession(page);
    const swipe = async (x, y, dy, dx = 0) => {
      const send = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
      await send('touchStart', [{ x, y }]);
      await send('touchMove', [{ x: x + dx / 2, y: y + dy / 2 }]);
      await send('touchMove', [{ x: x + dx, y: y + dy }]);
      await send('touchEnd', []);
    };
    await swipe(410, 530, -85, 40);
    assert(await reveal.isVisible(), 'Свайп по карте управляет картой');
    const handle = await reveal.boundingBox();
    await swipe(handle.x + handle.width / 2, handle.y + handle.height / 2, -100);
    await bar.waitFor();
    assert.equal(await bar.locator('.guide-voice:not(.guide-cam)').getAttribute('aria-pressed'), 'true');
    assert(await bar.locator('.guide-hud').isVisible());
    console.log('✓ Свайп вверх восстановил панель');
    const grabber = await page.locator('.guide-sheet .guide-grabber').boundingBox();
    await swipe(grabber.x + grabber.width / 2, grabber.y + grabber.height / 2, 85);
    await reveal.waitFor();
    await click(reveal);

    const sendFix = async (fix) => {
      await page.evaluate((p) => window.sendDrivingFix(p), fix);
    };
    for (const distance of [140, 130, 120, 110, 100]) await sendFix(beforeEnd(distance, 8, 5));
    const normal = await page.evaluate(() => window.__aceMap.state());
    assert(normal.routeTrim.cut > 300 && normal.routeTrim.first);
    assert.equal(normal.display.mode, 'matched');
    assert(Math.abs(((normal.heading - course + 540) % 360) - 180) < 3);

    await click(bar.locator('.guide-hud'));
    await click(page.getByRole('button', { name: 'Понятно' }));
    await page.waitForFunction(() => (window.__aceHud?.points ?? 0) >= 2);
    assert.deepEqual(await page.evaluate(() => window.__aceHud.first), normal.routeTrim.first);
    await click(page.locator('.hud-stage'));
    await click(page.getByRole('button', { name: 'Полная карта', exact: true }));
    await page.waitForFunction(() => window.__aceHud?.state?.()?.loaded);
    const hudFirst = await page.evaluate(async () => (await window.__aceHud.map.getSource('route').getData()).geometry.coordinates[0]);
    assert.deepEqual(hudFirst, normal.routeTrim.first);
    await page.screenshot({ path: `${out}/after-hud-trim.png` });
    await sendFix(beforeEnd(90, 8, 5));
    const firsts = await page.evaluate(async () => [
      (await window.__aceHud.map.getSource('route').getData()).geometry.coordinates[0],
      window.__aceMap.state().routeTrim.first,
    ]);
    assert.deepEqual(firsts[0], firsts[1]);
    assert.notDeepEqual(firsts[0], hudFirst);
    await click(page.getByRole('button', { name: 'Выйти из HUD' }));
    assert.deepEqual(await page.evaluate(() => window.__aceMap.state().routeTrim.first), firsts[1]);

    const ordinary = page.getByRole('button', { name: 'Обычный интерфейс', exact: true });
    if (!(await ordinary.isVisible())) await click(bar.locator('.guide-grabber'));
    await click(ordinary);
    const card = page.locator('.route-guiding');
    await card.waitFor();
    await page.evaluate(() => window.advanceDrivingIdle(20_000));
    await reveal.waitFor();
    assert(!(await card.isVisible()), 'В обычном интерфейсе карточка тоже скрывается');
    await click(reveal);
    await card.waitFor();
    assert.equal(await card.locator('.card-voice.is-muted').count(), 1);

    await sendFix(beforeEnd(0, 30));
    assert(await maneuver.isVisible(), 'У финиша ждём точный GPS');
    await sendFix(beforeEnd(0, 6));
    await page.getByText('Вы прибыли', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__aceMap.state().routeTrim.shownPoints), 0);
    console.log('✓ Таймер, свайпы, голос, прибытие, общая линия HUD и курс машинки');
  }
} finally {
  await browser.close();
}
