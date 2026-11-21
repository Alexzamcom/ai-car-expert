// Browser screenshots against repeatable map geometry and a simulated GPS feed.
import assert from 'node:assert/strict';

export async function gameCameraVisual({ chromium, devices, url, out, fixture, coords, along }) {
  const style = JSON.parse(fixture('maplibre-style.json'));
  const roads = { type: 'FeatureCollection', features: [{
    type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords.map(({ lon, lat }) => [lon, lat]) },
  }] };
  const buildings = { type: 'FeatureCollection', features: [] };
  for (let d = 1000; d < 2030; d += 32) {
    if (Math.abs(d - 1655) < 31) continue;
    const a = along(d);
    const b = along(d + 15);
    const lonM = 111320 * Math.cos(a.latitude * Math.PI / 180);
    const dx = (b.longitude - a.longitude) * lonM;
    const dy = (b.latitude - a.latitude) * 111320;
    const len = Math.hypot(dx, dy);
    const position = (forward, side) => [
      a.longitude + (dx * forward + dy * side) / (len * lonM),
      a.latitude + (dy * forward - dx * side) / (len * 111320),
    ];
    for (const side of [-1, 1]) {
      const shape = [[-8, 14], [8, 14], [8, 27], [-8, 27], [-8, 14]].map(([x, y]) => position(x, y * side));
      buildings.features.push({ type: 'Feature', properties: { height: 9 + (d % 5) * 3 }, geometry: { type: 'Polygon', coordinates: [shape] } });
    }
    if (d % 96 === 40) roads.features.push({
      type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [position(13, -150), position(13, 150)] },
    });
  }
  style.sources.visualRoads = { type: 'geojson', data: roads };
  style.sources.visualBuildings = { type: 'geojson', data: buildings };
  style.layers.push(
    { id: 'visual-road-major-casing', type: 'line', source: 'visualRoads', layout: { 'line-join': 'round' }, paint: { 'line-color': '#c9b9ad', 'line-width': 16 } },
    { id: 'visual-road-major', type: 'line', source: 'visualRoads', layout: { 'line-join': 'round' }, paint: { 'line-color': '#777d84', 'line-width': 13 } },
    { id: 'visual-blocks', type: 'fill-extrusion', source: 'visualBuildings', paint: { 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-color': '#bda995', 'fill-extrusion-opacity': 0.94 } },
  );

  const browser = await chromium.launch();
  const open = async (profile) => {
    const ctx = await browser.newContext({ ...profile, serviceWorkers: 'block' });
    await ctx.route('**/*', (r) => {
      const target = new URL(r.request().url());
      if (target.origin === new URL(url).origin) return r.continue();
      const headers = { 'Access-Control-Allow-Origin': '*' };
      if (target.pathname.includes('/styles/')) return r.fulfill({ json: style, headers });
      if (target.pathname.includes('/route/v1/')) return r.fulfill({ body: fixture('osrm-route.json'), contentType: 'application/json', headers });
      return r.fulfill({ status: 204, headers });
    });
    await ctx.addInitScript((coords) => {
      localStorage.setItem('ace:settings', JSON.stringify({ mapEngine: 'maplibre', mapEngineExplicit: true, mapLook: 'game', carStyle: '3d', theme: 'day', speakNavigation: false }));
      localStorage.setItem('ace:nav-session', JSON.stringify({ dest: { id: 'visual', name: 'Финиш', address: '', lon: 37.617, lat: 55.779 }, via: null, guiding: true, at: Date.now() }));
      let timestamp = Date.now();
      const watches = new Map();
      let id = 0;
      const current = () => ({ coords, timestamp });
      Object.defineProperty(navigator, 'geolocation', { value: {
        getCurrentPosition: (fn) => queueMicrotask(() => fn(current())),
        watchPosition: (fn) => { watches.set(++id, fn); queueMicrotask(() => fn(current())); return id; },
        clearWatch: (id) => watches.delete(id),
      } });
      window.sendCameraFix = (fix) => {
        coords = fix;
        timestamp = Math.max(timestamp + 1200, Date.now());
        for (const fn of watches.values()) fn(current());
      };
    }, { ...along(1180), heading: 323, speed: 10, accuracy: 6 });

    const page = await ctx.newPage();
    page.setDefaultTimeout(30_000);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const s = window.__aceMap?.state();
      return document.querySelector('.maneuver') && s?.pitch >= 61.5 &&
        s.car?.y > 0.66 && s.car.y < 0.80 && s.carWidthShare > 0 && !window.__aceMap.map.isMoving();
    }, null, { polling: 100 });
    return { ctx, page };
  };
  try {
    const { ctx, page } = await open({ ...devices['iPad Pro 11'], viewport: { width: 700, height: 950 }, deviceScaleFactor: 1 });
    const state = () => page.evaluate(() => window.__aceMap.state());
    const wait = (condition) => page.waitForFunction(condition, null, { polling: 100 });
    const send = async (d, speed = 10, heading = 323) => {
      const fix = { ...along(d), speed, heading, accuracy: 6 };
      await page.evaluate((p) => window.sendCameraFix(p), fix);
      await page.waitForFunction(({ latitude, longitude }) => {
        const { map, state } = window.__aceMap;
        const s = state();
        return !map.isMoving() && s.raw.lat === latitude && s.raw.lon === longitude && s.carWidthShare > 0;
      }, fix, { polling: 100 });
    };

    await wait(() => document.querySelector('.maneuver') && window.__aceMap?.state()?.carWidthShare > 0);
    await wait(() => {
      const s = window.__aceMap.state();
      return s.pitch >= 63 && s.car.y > 0.68 && s.car.y < 0.80;
    });
    await send(1200);
    const normal = await state();
    assert(normal.carWidthShare >= 0.235 && normal.carWidthShare <= 0.265, JSON.stringify(normal));
    await page.screenshot({ path: `${out}/01-chase-normal.png` });

    await send(1225, 34);
    const fast = await state();
    assert(fast.zoom < normal.zoom - 1.5 && fast.carWidthShare >= 0.18 && fast.carWidthShare <= 0.20, JSON.stringify(fast));
    await page.screenshot({ path: `${out}/02-chase-distant.png` });
    await send(1250);

    await page.setViewportSize({ width: 950, height: 570 });
    await wait(() => {
      const s = window.__aceMap.state();
      return s.pitch >= 61.5 && s.pitch <= 62.5 && s.car.y > 0.66 && s.car.y < 0.77;
    });
    await page.setViewportSize({ width: 700, height: 950 });
    await wait(() => window.__aceMap.state().pitch >= 63.8);

    const cdp = await ctx.newCDPSession(page);
    const pinch = async (from, to) => {
      const { car } = await state();
      const x = 700 * car.x;
      const y = 950 * car.y;
      const send = (type, gap) => cdp.send('Input.dispatchTouchEvent', {
        type, touchPoints: type === 'touchEnd' ? [] : [{ x: x - gap, y, id: 1 }, { x: x + gap, y, id: 2 }],
      });
      await send('touchStart', from);
      for (let k = 1; k <= 8; k++) await send('touchMove', from + (to - from) * k / 8);
      await send('touchEnd', 0);
      await wait(() => !window.__aceMap.map.isMoving());
    };
    await pinch(30, 142);
    const close = await state();
    assert(close.zoom >= normal.zoom + 1.6 && close.carWidthShare >= 0.30 && close.carWidthShare <= 0.33, JSON.stringify(close));
    await page.screenshot({ path: `${out}/03-chase-zoomed.png` });
    await pinch(142, 30);
    const far = await state();
    assert(far.carWidthShare < close.carWidthShare - 0.05, JSON.stringify(far));
    const recenter = page.locator('.recenter-pill');
    if (await recenter.isVisible()) await recenter.evaluate((button) => button.click());

    for (const d of [1300, 1350, 1400, 1450, 1500, 1540, 1570, 1595, 1610, 1625]) await send(d);
    const turning = await state();
    assert(turning.camera.lift > 0.65 && turning.pitch < normal.pitch - 9 && turning.car.y >= 0.60, JSON.stringify(turning));
    const angle = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
    await send(1635, 0);
    const stopped = await state();
    for (const d of [1636, 1634, 1635]) await send(d, 0, 55);
    await page.waitForTimeout(8000);
    const afterGap = await state();
    assert(angle(afterGap.bearing, stopped.bearing) < 2 &&
      Math.abs(afterGap.carWidthShare - stopped.carWidthShare) < 0.008, JSON.stringify(afterGap));
    await send(1665, 10, 40);
    const reacquired = await state();
    assert(Math.abs(reacquired.pitch - afterGap.pitch) < 15 && typeof reacquired.heading === 'number');
    for (const d of [1690, 1720, 1750, 1780, 1810, 1840]) await send(d, 10, 40);
    const recovered = await state();
    assert(recovered.camera.lift < turning.camera.lift * 0.55 &&
      recovered.pitch > turning.pitch + 5 && angle(recovered.bearing, recovered.heading) < 12, JSON.stringify(recovered));

    const reveal = page.locator('.driving-reveal');
    if (await reveal.isVisible()) await reveal.evaluate((button) => button.click());
    await page.locator('.guide-hud').evaluate((button) => button.click());
    await page.getByRole('button', { name: /Понятно/ }).evaluate((button) => button.click());
    await wait(() => {
      const stage = document.querySelector('.hud-stage');
      const route = document.querySelector('.hud-line')?.getAttribute('d');
      return stage && route?.includes('L') && new DOMMatrixReadOnly(getComputedStyle(stage).transform).a === -1;
    });
    console.log(JSON.stringify({
      normal: { pitch: normal.pitch, zoom: normal.zoom, widthShare: normal.carWidthShare },
      fast: { zoom: fast.zoom, widthShare: fast.carWidthShare },
      pinch: { zoom: close.zoom, widthShare: close.carWidthShare },
      beforeTurn: { pitch: turning.pitch, lift: turning.camera.lift, widthShare: turning.carWidthShare },
      landscape: true, stoppedGpsGap: true, recoveredPitch: recovered.pitch, mirroredHud: true,
    }));
    await ctx.close();

    for (const [name, profile, minimum] of [
      ['iPhone 15 portrait', devices['iPhone 15'], 0.235],
      ['iPhone 15 landscape', devices['iPhone 15 landscape'], 0.20],
      ['Pixel 7', devices['Pixel 7'], 0.235],
      ['iPad Pro 11', devices['iPad Pro 11'], 0.235],
    ]) {
      const { ctx: mobile, page: mobilePage } = await open(profile);
      try {
        const measured = await mobilePage.evaluate(() => {
          const state = window.__aceMap.state();
          return { widthShare: state.carWidthShare, heightShare: state.carHeightShare, dpr: devicePixelRatio };
        });
        assert(measured.widthShare >= minimum && measured.widthShare <= 0.27 && measured.heightShare <= 0.63, JSON.stringify({ name, ...measured }));
        console.log(JSON.stringify({ name, ...measured }));
      } finally {
        await mobile.close();
      }
    }
  } finally {
    await browser.close();
  }
}
