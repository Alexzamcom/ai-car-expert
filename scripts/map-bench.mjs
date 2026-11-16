// Замер производительности карт: Leaflet (рабочая навигация) и MapLibre GL (прототип lab.html).
//   node scripts/map-bench.mjs <адрес приложения> [папка] [--mock] [--seconds=15]
// Одинаковая поездка (центр Киева, 45 км/ч, точка GPS раз в секунду), эмуляция iPad / iPhone / Android
// и замедление процессора (iPad ×2, телефоны ×4). Считаем кадры через requestAnimationFrame.
// ВАЖНО: в CI WebGL рисуется программно (SwiftShader), без GPU — абсолютные числа MapLibre занижены;
// сравнение ориентировочное, окончательно — на реальных устройствах.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const args = process.argv.slice(2);
const MOCK = args.includes('--mock');
const SECONDS = Number((args.find((a) => a.startsWith('--seconds=')) ?? '--seconds=15').split('=')[1]);
const [url = 'http://localhost:4173/', out = 'bench'] = args.filter((a) => !a.startsWith('--'));
fs.mkdirSync(out, { recursive: true });

const ROUTE = [
  [50.44185, 30.52165], [50.44412, 30.52208], [50.44655, 30.52258], [50.44902, 30.52318], [50.45025, 30.52358],
  [50.45195, 30.52502], [50.45332, 30.52705], [50.45362, 30.52842], [50.45212, 30.53005], [50.45026, 30.53212],
];
const hav = (a, b) => {
  const r = Math.PI / 180;
  const x = Math.sin(((b[0] - a[0]) * r) / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(((b[1] - a[1]) * r) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(x));
};
function at(s) {
  for (let i = 0; i < ROUTE.length - 1; i++) {
    const d = hav(ROUTE[i], ROUTE[i + 1]);
    if (s <= d) return [ROUTE[i][0] + ((ROUTE[i + 1][0] - ROUTE[i][0]) * s) / d, ROUTE[i][1] + ((ROUTE[i + 1][1] - ROUTE[i][1]) * s) / d];
    s -= d;
  }
  return ROUTE[ROUTE.length - 1];
}

const FPS_PROBE = () => {
  window.__frames = [];
  let last = performance.now();
  const f = (t) => {
    window.__frames.push(t - last);
    last = t;
    requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
};
const summarize = (frames) => {
  const ok = frames.filter((x) => x > 0 && x < 1000);
  const avg = ok.reduce((a, b) => a + b, 0) / Math.max(1, ok.length);
  const sorted = [...ok].sort((a, b) => a - b);
  return { fps: avg ? Math.round(1000 / avg) : 0, p95ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0), long: ok.filter((x) => x > 50).length, frames: ok.length };
};

const DEVICES = [
  ['iPad Pro 12.9 вертикально', { viewport: { width: 1024, height: 1366 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true }, 2],
  ['iPhone 15', devices['iPhone 15'], 4],
  ['Pixel 7', devices['Pixel 7'], 4],
];

const browser = await chromium.launch();
const rows = [];
try {
  for (const [name, dev, cpu] of DEVICES) {
    for (const engine of ['Leaflet', 'MapLibre']) {
      const ctx = await browser.newContext({ ...dev, locale: 'ru-RU', geolocation: { latitude: ROUTE[0][0], longitude: ROUTE[0][1], accuracy: 6 }, permissions: ['geolocation'] });
      if (MOCK) {
        await ctx.route('**/tile.openstreetmap.org/**', (r) => r.fulfill({ status: 204 }));
        await ctx.route('**/tiles.openfreemap.org/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: fs.readFileSync(path.resolve('tests/fixtures/maplibre-style.json'), 'utf8') }));
      }
      await ctx.addInitScript(FPS_PROBE);
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
      await page.goto(engine === 'Leaflet' ? url : `${url}lab.html?sim=1`, { waitUntil: 'load' });
      await page.waitForTimeout(4000);
      await page.evaluate(() => (window.__frames = []));
      const t0 = Date.now();
      for (let s = 0; s < SECONDS; s++) {
        if (engine === 'Leaflet') {
          const [lat, lon] = at(s * 12.5);
          await ctx.setGeolocation({ latitude: lat, longitude: lon, accuracy: 6 });
        }
        await page.waitForTimeout(Math.max(0, t0 + (s + 1) * 1000 - Date.now()));
      }
      const r = summarize(await page.evaluate(() => window.__frames));
      const heap = await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null));
      rows.push({ device: name, engine, cpu: `×${cpu}`, ...r, heapMb: heap });
      console.log(`${name.padEnd(28)} ${engine.padEnd(9)} CPU ×${cpu}: ${String(r.fps).padStart(3)} к/с, p95 ${String(r.p95ms).padStart(4)} мс, долгих кадров ${r.long}, память ${heap ?? '—'} МБ`);
      await page.screenshot({ path: `${out}/${engine}-${name.replace(/\s+/g, '-')}.png` });
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
fs.writeFileSync(`${out}/bench.json`, JSON.stringify({ seconds: SECONDS, mock: MOCK, rows }, null, 2));
