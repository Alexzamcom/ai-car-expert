// Снимки режима «Игровая 3D» на настоящих тайлах OpenFreeMap (Днепр, Павлоград) и замер плавности поворота камеры.
// Изображения печатаются в журнал (base64 JPEG между метками) — их можно посмотреть без скачивания артефактов.
//
//   node scripts/map-preview.mjs <url> <папка>
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const [url = 'http://localhost:4173/', out = 'map-preview'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
fs.mkdirSync(out, { recursive: true });

const PLACES = [
  ['dnipro', 'Днепр, центр', 48.4668, 35.0459],
  ['pavlograd', 'Павлоград, центр', 48.5318, 35.8708],
  // Парк имени Шевченко (Днепр) — деревья вблизи
  ['dnipro-park', 'Днепр, парк Шевченко', 48.4581, 35.0624],
];
const browser = await chromium.launch();
const report = [];
for (const [key, name, lat, lon] of PLACES) {
  for (const look of key === 'dnipro-park' ? ['game'] : ['game', 'normal']) {
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 1366 }, deviceScaleFactor: 1, geolocation: { latitude: lat, longitude: lon, accuracy: 8 }, permissions: ['geolocation'], serviceWorkers: 'block' });
    await ctx.addInitScript((lk) => localStorage.setItem('ace:settings', JSON.stringify({ mapEngine: 'maplibre', mapEngineExplicit: true, mapLook: lk, theme: 'day' })), look);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__aceMap?.state?.().car3d, null, { timeout: 60000 }).catch(() => {});
    // Вид «миниатюры»: близко, с наклоном и поворотом; ждём, пока догрузятся тайлы.
    await page.evaluate(([la, lo]) => window.__aceMap.map.jumpTo({ center: [lo, la], zoom: key === 'dnipro-park' ? 17.2 : 16.4, pitch: 58, bearing: 32 }), [lat, lon]);
    await page.waitForFunction(() => window.__aceMap.map.loaded() && window.__aceMap.map.areTilesLoaded(), null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const info = await page.evaluate(() => {
      const m = window.__aceMap.map;
      const q = (id) => (m.getLayer(id) ? m.queryRenderedFeatures({ layers: [id] }).length : -1);
      return { buildings: q('game-buildings'), roofs: q('game-roofs'), trees: Math.max(0, q('game-trees')) + Math.max(0, q('game-trees-grass')) + Math.max(0, q('game-trees-wood')), look: window.__aceMap.state().look, treeIcon: m.hasImage('game-tree') };
    });
    // Плавность: поворот камеры на 90° за 6 с (программный WebGL в CI — ориентировочно, устройство быстрее).
    const fps = await page.evaluate(
      () =>
        new Promise((res) => {
          const m = window.__aceMap.map;
          let frames = 0;
          const on = () => frames++;
          m.on('render', on);
          m.easeTo({ bearing: m.getBearing() + 90, duration: 6000, easing: (x) => x });
          setTimeout(() => {
            m.off('render', on);
            res(+(frames / 6).toFixed(1));
          }, 6200);
        }),
    );
    const file = `${out}/${key}-${look}.jpg`;
    await page.screenshot({ path: file, type: 'jpeg', quality: 62 });
    const b64 = fs.readFileSync(file).toString('base64');
    report.push({ place: name, look, ...info, fps, errors: errors.slice(0, 2) });
    console.log(`IMG-BEGIN ${key}-${look} ${b64.length}`);
    for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
    console.log(`IMG-END ${key}-${look}`);
    await ctx.close();
  }
}
await browser.close();
console.log('ИТОГ ' + JSON.stringify(report));
