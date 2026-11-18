// Длительный тест MapLibre 3D (по умолчанию 15 минут): ведение по маршруту, точка GPS каждую секунду с шумом,
// движение туда-обратно (разворот камеры по курсу), периодический поворот карты двумя пальцами и «К машине»,
// 3D-машинка, автотема по солнцу (как у пользователя). Проверяет, что карта не пересоздаётся, стиль не
// перезагружается, нет потери WebGL-контекста, отображаемая машинка не отстаёт и не уходит далеко от GPS.
// Устройства — параллельно: iPad, iPhone 15, Pixel 7.
//
//   node scripts/soak.mjs <url> <папка> [--mock] [--minutes=15] [--devices=ipad,iphone,pixel]
//
// --mock — стиль карты и маршрут из tests/fixtures (без сети); без него — живые OpenFreeMap и сервер маршрутов.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const args = process.argv.slice(2);
const MOCK = args.includes('--mock');
const MINUTES = Number(args.find((a) => a.startsWith('--minutes='))?.split('=')[1] ?? 15);
const WANT = (args.find((a) => a.startsWith('--devices='))?.split('=')[1] ?? 'ipad,iphone,pixel').split(',');
/** Вид карты: normal или game («Игровая 3D»). */
const LOOK = args.find((a) => a.startsWith('--look='))?.split('=')[1] ?? 'normal';
const [url = 'http://localhost:4173/', out = 'soak'] = args.filter((a) => !a.startsWith('--'));
fs.mkdirSync(out, { recursive: true });
const fixture = (f) => fs.readFileSync(path.resolve('tests/fixtures', f), 'utf8');

const DEVICES = {
  ipad: ['iPad Pro 12.9', { viewport: { width: 1024, height: 1366 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
  iphone: ['iPhone 15', devices['iPhone 15']],
  pixel: ['Pixel 7', devices['Pixel 7']],
};

const ROUTE = JSON.parse(fixture('osrm-route.json')).routes[0].geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
const K = Math.cos((ROUTE[0].lat * Math.PI) / 180);
const dist = (a, b) => Math.hypot((b.lat - a.lat) * 111320, (b.lon - a.lon) * 111320 * K);
const cum = [0];
for (let i = 1; i < ROUTE.length; i++) cum.push(cum[i - 1] + dist(ROUTE[i - 1], ROUTE[i]));
/** Точка в m метрах от начала маршрута. */
function along(m) {
  let i = 1;
  while (i < ROUTE.length - 1 && cum[i] < m) i++;
  const k = Math.max(0, Math.min(1, (m - cum[i - 1]) / (cum[i] - cum[i - 1] || 1)));
  return { lat: ROUTE[i - 1].lat + (ROUTE[i].lat - ROUTE[i - 1].lat) * k, lon: ROUTE[i - 1].lon + (ROUTE[i].lon - ROUTE[i - 1].lon) * k };
}

const results = [];
const check = (name, ok, info = '') => {
  results.push({ name, ok, info });
  console.log(`${ok ? '✓' : '✗'} ${name}${info ? ` — ${info}` : ''}`);
};

async function soak(key) {
  const [name, device] = DEVICES[key];
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...device, locale: 'ru-RU', geolocation: { latitude: ROUTE[0].lat, longitude: ROUTE[0].lon, accuracy: 8 }, permissions: ['geolocation'], serviceWorkers: 'block' });
  const json = (body) => ({ status: 200, contentType: 'application/json', body, headers: { 'Access-Control-Allow-Origin': '*' } });
  if (MOCK) {
    await ctx.route('**/tiles.openfreemap.org/**', (r) => (r.request().url().endsWith('.pbf') ? r.fulfill({ status: 204, body: '' }) : r.fulfill(json(fixture('maplibre-style.json')))));
    const osrm = (r) => r.fulfill(json(fixture('osrm-route.json')));
    await ctx.route('**/routing.openstreetmap.de/**', osrm);
    await ctx.route('**/router.project-osrm.org/**', osrm);
    await ctx.route('**/nominatim.openstreetmap.org/**', (r) => r.fulfill(json(fixture(r.request().url().includes('/reverse') ? 'nominatim-reverse.json' : 'nominatim.json'))));
    await ctx.route('**/photon.komoot.io/**', (r) => r.fulfill(json('{"features":[]}')));
  }
  // Как у пользователя: MapLibre, автотема по солнцу (от координат), 3D-машинка; диагностика включена.
  await ctx.addInitScript((look) => {
    localStorage.setItem('ace:settings', JSON.stringify({ mapEngine: 'maplibre', mapEngineExplicit: true, theme: 'auto', carStyle: '3d', mapLook: look }));
    localStorage.setItem('ace:diag', JSON.stringify({ on: true }));
  }, LOOK);
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__aceMap?.state?.().car3d, null, { timeout: 60000 }).catch(() => {});

  // Маршрут и «Поехали».
  await page.fill('#map-search', 'Театр Сатиры');
  await page.press('#map-search', 'Enter');
  await page.locator('.map-panel .place-row').first().click({ timeout: 20000 }).catch(() => {});
  await page.locator('.pick-card button:has-text("Маршрут сюда")').click({ timeout: 10000 }).catch(() => {});
  await page.waitForSelector('.route-card .btn-primary:has-text("Поехали")', { timeout: 30000 }).catch(() => {});
  await page.evaluate(() => [...document.querySelectorAll('.route-card .btn-primary')].find((b) => b.textContent.includes('Поехали'))?.click());
  await page.waitForTimeout(3000);
  const guiding = await page.evaluate(() => !!document.querySelector('.guide-bar, .maneuver'));
  check(`${name}: ведение по маршруту запущено (вид карты: ${LOOK})`, guiding);

  const base = await page.evaluate(() => ({ map: window.__aceDiag.map(), state: window.__aceMap.state() }));
  const cdp = await ctx.newCDPSession(page);
  const total = Math.max(1, MINUTES) * 60;
  const lo = Math.min(200, cum[cum.length - 1] * 0.05);
  const hi = cum[cum.length - 1] * 0.7; // не доезжаем до цели: ведение не завершается
  let m = lo;
  let dir = 1;
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const samples = [];
  const t0 = Date.now();
  let gestures = 0;
  for (let s = 1; s <= total; s++) {
    m += dir * 12; // ~43 км/ч
    if (m > hi || m < lo) dir = -dir;
    const p = along(m);
    const noise = 4;
    await ctx.setGeolocation({ latitude: p.lat + (rnd() * noise) / 111320, longitude: p.lon + (rnd() * noise) / 111320 / K, accuracy: 8 + Math.abs(rnd()) * 8 });
    // Каждые 60 с — поворот двумя пальцами (свободный обзор), через 5 с — «К машине».
    if (s % 60 === 30) {
      const box = await page.locator('.ml-map').boundingBox();
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height * 0.45;
      const two = (a) => [[cx + 110 * Math.cos(a), cy + 110 * Math.sin(a)], [cx - 110 * Math.cos(a), cy - 110 * Math.sin(a)]].map(([x, y], i) => ({ x, y, id: i + 1 }));
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: two(0) });
      for (let k = 1; k <= 8; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: two((k * Math.PI) / 20) });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      gestures++;
    }
    if (s % 60 === 35) await page.evaluate(() => document.querySelector('.recenter-pill')?.click());
    if (s % 5 === 0) {
      const smp = await page.evaluate(() => {
        const st = window.__aceMap.state();
            const mem = performance.memory?.usedJSHeapSize ?? null;
        // styleReady — сам стиль загружен (isStyleLoaded() ложен и во время подгрузки данных маршрута/тайлов — это не мерцание).
        return { at: Date.now(), map: window.__aceDiag.map(), geo: window.__aceDiag.geo(), styleLoaded: st.styleReady, car: st.car, car3d: st.car3d, display: st.display, raw: st.raw, mem, look: st.look, gameLayers: st.gameLayers?.length ?? 0 };
      });
      samples.push(smp);
    }
    // Ровно раз в секунду (с учётом времени на запросы к странице).
    const wait = t0 + s * 1000 - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
    if (s % 300 === 0) {
      await page.screenshot({ path: `${out}/soak-${key}-${s / 60}min.png` });
      console.log(`${name}: ${s / 60} мин`);
    }
  }
  const last = samples[samples.length - 1];
  const d = (k) => last.map[k] - base.map[k];
  check(`${name}: экземпляр MapLibre не пересоздавался ${MINUTES} мин`, last.map.creates === base.map.creates && d('removes') === 0, JSON.stringify({ creates: last.map.creates, removes: last.map.removes }));
  check(`${name}: стиль карты не перезагружался (нет мерцания от setStyle)`, d('setStyles') === 0 && d('styleLoads') === 0, JSON.stringify({ setStyles: d('setStyles'), styleLoads: d('styleLoads') }));
  check(`${name}: стиль всё время загружен`, samples.every((x) => x.styleLoaded), `${samples.filter((x) => !x.styleLoaded).length} из ${samples.length} замеров без стиля`);
  check(`${name}: WebGL-контекст не терялся`, d('contextLost') === 0, JSON.stringify({ lost: d('contextLost') }));
  check(`${name}: 3D-машинка всё время на карте`, samples.every((x) => x.car3d && x.car), `${samples.filter((x) => !x.car3d).length} замеров без машинки`);
  // Привязка к дороге — не дальше 20 м от GPS; прогноз (точки задержались > 1,5 с) — не дальше 40 м вперёд.
  const shiftOf = (mode) => samples.filter((x) => x.display?.lat != null && (mode === 'predicted' ? x.display.mode === 'predicted' : x.display.mode !== 'predicted')).map((x) => x.display.shift);
  const snap = shiftOf('snap');
  const pred = shiftOf('predicted');
  const maxSnap = snap.length ? Math.max(...snap) : 0;
  const maxPred = pred.length ? Math.max(...pred) : 0;
  check(`${name}: привязка к дороге не уводит машинку от GPS дальше 20 м`, maxSnap <= 20.5, `макс. ${maxSnap.toFixed(1)} м по ${snap.length} замерам`);
  check(`${name}: прогноз при задержке точек — не дальше 40 м`, maxPred <= 40.5, `макс. ${maxPred.toFixed(1)} м, прогнозов ${pred.length} из ${samples.length}`);
  check(`${name}: ошибок страницы нет`, pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  // Паузы — только во время езды (эмуляция присылает точку лишь при setGeolocation; этап поиска маршрута не считаем).
  // Остановку слежения отличаем от задержек медленной эмуляции: 15 с подряд (3 замера) без единой точки.
  const points = (x) => x.geo.accepted + Object.values(x.geo.rejected).reduce((a, b) => a + b, 0);
  let emptyWindows = 0;
  let run = 0;
  let longest = 0;
  for (let i = 1; i < samples.length; i++) {
    if (points(samples[i]) === points(samples[i - 1])) {
      emptyWindows++;
      longest = Math.max(longest, ++run);
    } else run = 0;
  }
  check(`${name}: слежение за GPS не останавливалось во время езды (нет 15 с без точек)`, longest < 3, `пустых 5-секундных окон ${emptyWindows} из ${samples.length - 1}, подряд до ${longest}, принято ${last.geo.accepted}`);
  const gaps = last.geo.maxGap;
  const fps = samples.map((x) => x.map.fps);
  const mem0 = samples.find((x) => x.mem)?.mem;
  const mem1 = last.mem;
  const summary = {
    device: name,
    minutes: MINUTES,
    gestures,
    fps: { min: Math.min(...fps), median: fps.sort((a, b) => a - b)[Math.floor(fps.length / 2)] },
    memoryMB: mem0 && mem1 ? { start: +(mem0 / 1e6).toFixed(1), end: +(mem1 / 1e6).toFixed(1) } : null,
    map: last.map,
    geo: { accepted: last.geo.accepted, rejected: last.geo.rejected, maxGapS: +(gaps / 1000).toFixed(1) },
  };
  // Память: не растёт неограниченно (программный WebGL в CI — ориентировочно).
  if (summary.memoryMB) check(`${name}: память не растёт неограниченно`, summary.memoryMB.end < summary.memoryMB.start * 2 + 30, JSON.stringify(summary.memoryMB));
  console.log(`${name}: итог ${JSON.stringify(summary)}`);
  if (LOOK === 'game') check(`${name}: «Игровая 3D» включена всё время (слои зданий, крыш и деревьев на месте)`, samples.every((x) => x.look === 'game' && x.gameLayers === 3), `${samples.filter((x) => x.gameLayers !== 3).length} замеров без слоёв`);
  fs.writeFileSync(`${out}/soak-${key}.json`, JSON.stringify({ summary, samples }, null, 1));
  await page.screenshot({ path: `${out}/soak-${key}-end.png` });
  await browser.close();
}

try {
  await Promise.all(WANT.filter((k) => DEVICES[k]).map((k) => soak(k).catch((e) => check(`${DEVICES[k][0]}: сценарий выполнен`, false, String(e).slice(0, 300)))));
} finally {
  const failed = results.filter((r) => !r.ok);
  console.log(`\nПройдено ${results.length - failed.length}/${results.length}, провалов: ${failed.length}`);
  process.exitCode = failed.length ? 1 : 0;
}
