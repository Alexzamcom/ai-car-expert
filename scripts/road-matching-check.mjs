// Synthetic vector tiles and GPS samples. No real coordinates are collected.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { chromium, webkit, devices } = createRequire(import.meta.url)('playwright');
const url = process.argv[2] ?? 'http://localhost:4173/';
const engine = process.argv.includes('--webkit') ? webkit : chromium;

// A single north–south residential road around the centre of a synthetic z15 tile.
const z = 15;
const x = 19998;
const y = 10247;
const extent = 4096;
const n = 2 ** z;
const lon = (dx) => (x + dx / extent) / n * 360 - 180;
const lat = (dy) => Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + dy / extent) / n))) * 180 / Math.PI;
const point = (dy) => ({
  latitude: lat(dy), longitude: lon(2076), accuracy: 7, speed: 9, heading: 0,
});

// Minimal Mapbox Vector Tile encoding. Fields are specified in vector_tile.proto.
function varint(n) {
  const bytes = [];
  while (n >= 128) {
    bytes.push((n & 127) | 128);
    n >>>= 7;
  }
  return Buffer.from([...bytes, n]);
}
const number = (field, n) => Buffer.concat([varint(field << 3), varint(n)]);
const bytes = (field, data) => {
  const value = Buffer.from(data);
  return Buffer.concat([varint(field << 3 | 2), varint(value.length), value]);
};
const road = Buffer.concat([
  bytes(2, [0, 0]), number(3, 2),
  bytes(4, Buffer.concat([varint(9), varint(4096), varint(7600), varint(10), varint(0), varint(7199)])),
]);
const tile = bytes(3, Buffer.concat([
  bytes(1, 'transportation'), bytes(2, road), bytes(3, 'class'), bytes(4, bytes(1, 'minor')),
  number(5, extent), number(15, 2),
]));
const source = (name) => ({ type: 'vector', tiles: [`https://tiles.openfreemap.org/test/${name}/{z}/{x}/{y}.pbf`], minzoom: z, maxzoom: z });
const style = {
  version: 8,
  sources: { first: source('other'), roads: source('roads') },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#12181f' } },
    { id: 'water', type: 'fill', source: 'first', 'source-layer': 'water' },
    { id: 'road', type: 'line', source: 'roads', 'source-layer': 'transportation', paint: { 'line-color': '#fff' } },
  ],
};

const browser = await engine.launch();
try {
  const ctx = await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 700, height: 950 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
  let allowRoadTile;
  const roadTileReady = new Promise((resolve) => { allowRoadTile = resolve; });
  await ctx.route('**/*', async (route) => {
    const target = new URL(route.request().url());
    if (target.origin === new URL(url).origin) return route.continue();
    const headers = { 'Access-Control-Allow-Origin': '*' };
    if (target.pathname.startsWith('/styles/')) return route.fulfill({ json: style, headers });
    if (target.pathname === `/test/roads/${z}/${x}/${y}.pbf`) {
      await roadTileReady;
      return route.fulfill({ body: tile, contentType: 'application/vnd.mapbox-vector-tile', headers });
    }
    return route.fulfill({ status: 204, headers });
  });
  await ctx.addInitScript((initial) => {
    localStorage.setItem('ace:settings', JSON.stringify({ mapEngine: 'maplibre', theme: 'day' }));
    let watch;
    let timestamp = Date.now();
    Object.defineProperty(navigator, 'geolocation', { value: {
      getCurrentPosition: (callback) => queueMicrotask(() => callback({ coords: initial, timestamp })),
      watchPosition: (callback) => { watch = callback; return 1; },
      clearWatch: () => {},
    } });
    window.sendRoadFix = (coords) => {
      timestamp = Math.max(timestamp + 1000, Date.now());
      watch({ coords, timestamp });
    };
  }, point(2400));
  const page = await ctx.newPage();
  const appUrl = new URL(url);
  appUrl.searchParams.set('diag', '1');
  await page.goto(appUrl.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__aceMap?.state()?.styleReady, null, { timeout: 30_000 });
  const fix = (dy) => page.evaluate((coords) => window.sendRoadFix(coords), point(dy));
  const state = () => page.evaluate(() => window.__aceMap.state());
  await fix(2370);
  assert.equal((await state()).display.mode, 'raw', 'Before the tile arrives the marker uses the raw fix');
  allowRoadTile();
  await page.waitForFunction(() => window.__aceMap.map.querySourceFeatures('roads', { sourceLayer: 'transportation' }).length > 0);
  await fix(2320);
  await page.waitForFunction(() => window.__aceMap.state().display.mode === 'matched');
  const snapped = await state();
  assert(Math.abs(snapped.display.lon - lon(2048)) < 0.000002);
  assert(Math.abs(snapped.raw.lon - point(2320).longitude) < 0.000002);
  await page.waitForFunction(() => {
    const panel = document.querySelector('.diag-body')?.textContent;
    return panel?.includes('Дороги карты рядом: 1') && panel.includes('отрезок 1') && panel.includes('цель слежения');
  });
  await page.locator('.diag-body').getByText(/цель слежения/).waitFor();
  const coordinates = `${snapped.display.lat.toFixed(6)}, ${snapped.display.lon.toFixed(6)}`;
  await page.waitForFunction((displayed) => document.querySelector('.diag-body')?.textContent?.includes(`Маркер ${displayed} · цель слежения ${displayed}`), coordinates);
  await page.waitForFunction(({ lat, lon }) => {
    const center = window.__aceMap.map.getCenter();
    return Math.abs(center.lat - lat) < 0.000002 && Math.abs(center.lng - lon) < 0.000002;
  }, snapped.display);
  console.log(`✓ ${engine.name()}: late road tile, vector source selection, raw GPS and shared camera/marker target`);
} finally {
  await browser.close();
}
