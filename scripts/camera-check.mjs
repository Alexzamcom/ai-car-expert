// Динамическая камера «Игровой 3D» в браузере (тестовые данные маршрута): едем по маршруту к повороту и дальше.
// Проверяется: вид сзади при движении прямо, плавный подъём перед поворотом, плавный возврат после него, остановка
// без дрожания, потеря GPS без скачков, ручной поворот карты и плавное возвращение ракурса, iPad вертикально, ночь.
//
//   node scripts/camera-check.mjs <url> <папка>
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const [url = 'http://localhost:4173/', out = 'camera-check'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
fs.mkdirSync(out, { recursive: true });
const F = (n) => fs.readFileSync(new URL(`../tests/fixtures/${n}`, import.meta.url), 'utf8');
const json = (b) => ({ status: 200, contentType: 'application/json', body: b });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const coords = JSON.parse(F('osrm-route.json')).routes[0].geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
const dist = (a, b) => Math.hypot((a.lat - b.lat) * 111320, (a.lon - b.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180));
const cum = [0];
for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + dist(coords[i - 1], coords[i]));
/** Точка маршрута на расстоянии d от начала. */
const along = (d) => {
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const k = Math.max(0, Math.min(1, (d - cum[i - 1]) / (cum[i] - cum[i - 1])));
  return { latitude: coords[i - 1].lat + (coords[i].lat - coords[i - 1].lat) * k, longitude: coords[i - 1].lon + (coords[i].lon - coords[i - 1].lon) * k };
};
if (process.argv.includes('--visual')) {
  const { gameCameraVisual } = await import('./game-camera-visual.mjs');
  await gameCameraVisual({ chromium, devices, url, out, fixture: F, coords, along });
  process.exit(0);
}

const angle = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

async function run(name, dev, theme) {
  const browser = await chromium.launch();
  const { defaultBrowserType: _b, ...opts } = dev;
  const ctx = await browser.newContext({ ...opts, geolocation: { ...along(0), accuracy: 6 }, permissions: ['geolocation'], serviceWorkers: 'block' });
  await ctx.route(/openfreemap|\.pbf/, (r) => (r.request().url().includes('/styles/') ? r.fulfill(json(F('maplibre-style.json'))) : r.fulfill({ status: 204 })));
  await ctx.route('**/nominatim.openstreetmap.org/**', (r) => r.fulfill(json(F(r.request().url().includes('/reverse') ? 'nominatim-reverse.json' : 'nominatim.json'))));
  await ctx.route('**/photon.komoot.io/**', (r) => r.fulfill(json('{"features":[]}')));
  for (const h of ['**/routing.openstreetmap.de/**', '**/router.project-osrm.org/**']) await ctx.route(h, (r) => r.fulfill(json(F('osrm-route.json'))));
  // «Игровая 3D» без выбора камеры — по умолчанию динамическая.
  await ctx.addInitScript((th) => localStorage.setItem('ace:settings', JSON.stringify({ mapEngine: 'maplibre', mapEngineExplicit: true, mapLook: 'game', theme: th, carStyle: '3d' })), theme);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__aceMap?.state?.().car3d, null, { timeout: 60000 }).catch(() => {});
  const st = () => page.evaluate(() => window.__aceMap.state());
  check(`${name}: «Игровая 3D» — по умолчанию динамическая камера`, (await st()).camera.style === 'dynamic');

  // Маршрут и «Поехали» (нажатия через DOM — медленный программный WebGL)
  await page.fill('#map-search', 'Театр Сатиры');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.map-panel .place-row', { timeout: 20000 }).catch(() => {});
  await page.evaluate(() => document.querySelector('.map-panel .place-row')?.click());
  await page.waitForSelector('.pick-card', { timeout: 10000 }).catch(() => {});
  await page.evaluate(() => [...document.querySelectorAll('.pick-card .btn')].find((b) => b.textContent.includes('Маршрут сюда'))?.click());
  await page.waitForSelector('.route-card .btn-primary', { timeout: 20000 }).catch(() => {});
  await page.evaluate(() => [...document.querySelectorAll('.route-card .btn-primary')].find((b) => b.textContent.includes('Поехали'))?.click());
  await page.waitForTimeout(4500);

  // Едем ~35 м за 1,1 с (≈115 км/ч в тесте — укладывается в фильтр GPS), записываем камеру.
  const samples = [];
  let d = 20;
  let turnAt = null;
  const drive = async (to, step = 35) => {
    for (; d <= to; d += step) {
      const position = along(d);
      await ctx.setGeolocation({ ...position, accuracy: 6 });
      await page.waitForTimeout(1100);
      const s = await st();
      samples.push({ d, toStepM: s.camera.toStepM, step: s.camera.step, lift: s.camera.lift, pitch: s.pitch, zoom: s.zoom, bearing: s.bearing, heading: s.heading, carY: s.car?.y, carWidthShare: s.carWidthShare });
      if (turnAt == null && s.camera.step?.startsWith('turn') && s.camera.toStepM != null) turnAt = d + s.camera.toStepM;
    }
  };
  await page.evaluate(() => {
    const { map, state } = window.__aceMap;
    const targets = [state().camera.lift];
    map.on('movestart', () => targets.push(state().camera.lift));
    window.cameraLiftTargets = targets;
  });
  await drive(260);
  const straight = samples.filter((x) => x.step?.startsWith('turn') && x.toStepM > 300).slice(-3);
  check(
    `${name}: прямо — вид сзади (наклон ≥ 58°, курс камеры по движению, машинка в нижней части)`,
    straight.length > 0 && straight.every((x) => x.lift === 0 && x.pitch >= 58 && x.heading != null && angle(x.bearing, x.heading) < 15 && x.carY > 0.65 && x.carY < 0.82),
    JSON.stringify(straight.at(-1) ?? samples.at(-1)),
  );
  check(
    `${name}: прямо — кузов занимает 18–33% ширины карты при текущем автомасштабе`,
    straight.length > 0 && straight.every((x) => x.carWidthShare >= 0.18 && x.carWidthShare <= 0.33),
    JSON.stringify(straight.map(({ zoom, carWidthShare }) => ({ zoom, carWidthShare }))),
  );
  if (turnAt == null) turnAt = 1300;
  // Подъезд к повороту — с замедлением, как в городе (35 → 15 м за точку).
  await drive(turnAt - 260);
  await drive(turnAt - 80, 15);
  // Остановка за ~80 м до поворота (светофор): GPS «гуляет» ±1.5 м — камера не дрожит (после плавного доезда до ракурса).
  for (let i = 0; i < 6; i++) {
    await ctx.setGeolocation({ ...along(d), accuracy: 8 });
    await page.waitForTimeout(1100);
  }
  const hold = along(d);
  const still = [];
  for (let i = 0; i < 6; i++) {
    await ctx.setGeolocation({ latitude: hold.latitude + ((i % 2 ? 1 : -1) * 1.5) / 111320, longitude: hold.longitude, accuracy: 10 });
    await page.waitForTimeout(1100);
    const s = await st();
    still.push({ pitch: s.pitch, bearing: s.bearing, zoom: s.zoom });
  }
  const span = (k) => Math.max(...still.map((x) => x[k])) - Math.min(...still.map((x) => x[k]));
  const bspan = Math.max(...still.map((x) => angle(x.bearing, still[0].bearing)));
  // Дрожание — колебания туда-обратно; плавный доезд камеры до ракурса (монотонно) дрожанием не считается.
  const diffs = still.slice(1).map((x, i) => x.pitch - still[i].pitch);
  const flips = diffs.slice(1).filter((x, i) => Math.sign(x) !== Math.sign(diffs[i]) && Math.abs(x) > 0.5 && Math.abs(diffs[i]) > 0.5).length;
  check(
    `${name}: остановка у перекрёстка — без дрожания (курс неподвижен, наклон без колебаний, масштаб почти не меняется)`,
    bspan < 3 && flips === 0 && span('pitch') < 6 && span('zoom') < 0.3,
    JSON.stringify({ pitch: span('pitch').toFixed(2), flips, bearing: bspan.toFixed(1), zoom: span('zoom').toFixed(2) }),
  );
  await drive(turnAt - 15, 15);
  const near = samples.filter((x) => x.toStepM != null && x.toStepM < 90 && x.step?.startsWith('turn'));
  const peak = Math.max(...samples.map((x) => x.lift));
  check(`${name}: перед поворотом — камера плавно поднимается (подъём > 0.5, наклон < 52°)`, near.some((x) => x.lift > 0.5 && x.pitch < 52), JSON.stringify(near.at(-1)));
  const targets = await page.evaluate(() => window.cameraLiftTargets);
  const jumps = targets.slice(1).map((lift, i) => Math.abs(lift - targets[i]));
  check(`${name}: подъём без рывков (за шаг < 0.6)`, jumps.length > 0 && Math.max(...jumps) < 0.6, `макс. ${Math.max(0, ...jumps).toFixed(2)}, пик ${peak.toFixed(2)}`);
  await page.screenshot({ path: `${out}/camera-${name.replace(/\W+/g, '-')}-turn.png` });

  // Проверяем отрисованную камеру при возвращении GPS. Курс-цель может
  // сразу стать курсом следующей улицы, а карта должна повернуться плавно.
  await drive(turnAt + 60);
  await page.waitForTimeout(8000);
  await page.waitForFunction(() => !window.__aceMap.map.isMoving(), null, { timeout: 15_000 });
  const beforeLoss = await st();
  // MapLibre использует время, а не счётчик кадров. Продвигаем его часы
  // только после реального рендера, чтобы медленный WebGL не пропускал фазу.
  const firstAfterGap = d;
  const position = along(firstAfterGap);
  const frozenAt = await page.evaluate(() => {
    const t = performance.now();
    window.__aceMap.frameClock.set(t);
    return t;
  });
  let frames;
  try {
    await ctx.setGeolocation({ ...position, accuracy: 6 });
    await page.waitForFunction(({ latitude, longitude }) => {
      const raw = window.__aceMap.state().raw;
      return raw.lat === latitude && raw.lon === longitude;
    }, position, { polling: 100, timeout: 15_000 });
    frames = await page.evaluate(async (start) => {
      const { map, frameClock } = window.__aceMap;
      const samples = [];
      for (let ms = 0; ms <= 1000; ms += 125) {
        frameClock.set(start + ms);
        const rendered = map.once('render');
        map.triggerRepaint();
        await rendered;
        samples.push({ t: ms, bearing: map.getBearing(), pitch: map.getPitch() });
      }
      return samples;
    }, frozenAt);
  } finally {
    await page.evaluate(() => window.__aceMap.frameClock.restore());
  }
  const afterLoss = await st();
  d += 35;
  const yawSteps = frames.slice(1).map((frame, i) => ({
    degrees: angle(frame.bearing, frames[i].bearing),
    pitchDegrees: Math.abs(frame.pitch - frames[i].pitch),
    seconds: (frame.t - frames[i].t) / 1000,
  }));
  const yaw = angle(afterLoss.bearing, beforeLoss.bearing);
  const pitch = Math.abs(afterLoss.pitch - beforeLoss.pitch);
  // Частота кадров программного WebGL непостоянна. За короткий интервал
  // камера может пройти только соответствующую долю секундной анимации.
  const intermediate = frames.slice(1, -1).some((frame) => {
    const turned = angle(frame.bearing, beforeLoss.bearing);
    const tilted = Math.abs(frame.pitch - beforeLoss.pitch);
    return (turned > 0.2 && turned < yaw - 0.2) || (tilted > 0.2 && tilted < pitch - 0.2);
  });
  check(
    `${name}: потеря GPS на 8 с — без скачка камеры`,
    !await page.evaluate(() => window.__aceMap.map.isMoving()) && afterLoss.heading != null && pitch < 15 &&
      angle(afterLoss.bearing, afterLoss.heading) < 1 &&
      frames.length >= 3 && angle(frames[0].bearing, beforeLoss.bearing) < 1 &&
      Math.abs(frames[0].pitch - beforeLoss.pitch) < 1 &&
      yawSteps.every(({ degrees, pitchDegrees, seconds }) =>
        degrees <= Math.min(180, yaw + 5) * seconds + 1 && pitchDegrees <= Math.min(15, pitch + 3) * seconds + 1) &&
      (yaw < 1 && pitch < 1 || intermediate),
    JSON.stringify({
      before: { lift: beforeLoss.camera.lift, pitch: beforeLoss.pitch, bearing: beforeLoss.bearing, heading: beforeLoss.heading },
      after: { lift: afterLoss.camera.lift, pitch: afterLoss.pitch, bearing: afterLoss.bearing, heading: afterLoss.heading },
      headingChange: angle(afterLoss.heading, beforeLoss.heading), frames: frames.length, intermediate,
      largestFrame: yawSteps.reduce((max, step) => step.degrees > max.degrees ? step : max, { degrees: 0, seconds: 0 }),
    }),
  );
  await drive(turnAt + 420);
  const after = samples.filter((x) => x.d > turnAt + 250);
  check(
    `${name}: после поворота — плавный возврат к виду сзади (подъём снижается, наклон растёт)`,
    after.length >= 2 && after.at(-1).lift < peak * 0.6 && after.at(-1).pitch > Math.min(...samples.map((x) => x.pitch)) + 5,
    JSON.stringify({ peak, last: after.at(-1) }),
  );

  // Ручной поворот карты двумя пальцами → свободный обзор; «К машине» — плавно обратно к ракурсу
  const cdp = await ctx.newCDPSession(page);
  const box = await page.evaluate(() => { const r = document.querySelector('.ml-map').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h * 0.45;
  const two = (a) => [[cx + 110 * Math.cos(a), cy + 110 * Math.sin(a)], [cx - 110 * Math.cos(a), cy - 110 * Math.sin(a)]].map(([x, y], i) => ({ x, y, id: i + 1 }));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: two(0) });
  for (let k = 1; k <= 10; k++) {
    await page.waitForTimeout(16);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: two((k * Math.PI) / 20) });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForSelector('.recenter-pill, .route-card .btn-primary:has-text("машине")', { timeout: 8000 }).catch(() => {});
  const freeBearing = (await st()).bearing;
  // Пока свободный обзор — новая точка GPS не возвращает камеру сама (нет борьбы с пользователем)
  d += 35;
  await ctx.setGeolocation({ ...along(d), accuracy: 6 });
  await page.waitForTimeout(1500);
  const held = await st();
  check(`${name}: ручной поворот — свободный обзор, автоследование не мешает`, angle(held.bearing, freeBearing) < 3, JSON.stringify({ freeBearing, now: held.bearing }));
  await page.evaluate(() => (document.querySelector('.recenter-pill') ?? [...document.querySelectorAll('.btn')].find((b) => /К машине|Вернуться к машине/.test(b.textContent)))?.click());
  await page.waitForTimeout(2500);
  const back = await st();
  check(`${name}: «К машине» — ракурс сзади восстановлен`, back.pitch > 45 && back.heading != null && angle(back.bearing, back.heading) < 15, JSON.stringify({ pitch: back.pitch, bearing: back.bearing, heading: back.heading }));
  const diag = await page.evaluate(() => window.__aceDiag.map());
  check(`${name}: без мерцания и потери WebGL (стиль не перезагружался, контекст цел)`, diag.setStyles <= 1 && diag.contextLost === 0 && errors.length === 0, JSON.stringify({ setStyles: diag.setStyles, lost: diag.contextLost, errors: errors.slice(0, 2) }));
  fs.writeFileSync(`${out}/camera-${name.replace(/\W+/g, '-')}.json`, JSON.stringify(samples, null, 1));
  await browser.close();
}

try {
  await run('iPad вертикально, день', { ...devices['iPad Pro 11'], viewport: { width: 1024, height: 1366 } }, 'day').catch((e) => check('iPad: сценарий выполнен', false, String(e).slice(0, 300)));
  await run('iPhone 15, ночь', devices['iPhone 15'], 'night').catch((e) => check('iPhone: сценарий выполнен', false, String(e).slice(0, 300)));
} finally {
  const failed = results.filter((r) => !r.ok);
  console.log(`\nПройдено ${results.length - failed.length}/${results.length}, провалов: ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
}
