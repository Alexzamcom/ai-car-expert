import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { loadValhalla, MemoryTileSource } from '@adret-maps/valhalla-wasm';
import { matchOfflineAddresses, validateOfflinePackage, type OfflinePackage } from '../../src/lib/offlinePackageFormat';
import { fromValhalla } from '../../src/lib/valhallaRoute';
import { advance, Estimator } from '../../src/lib/autonomy/estimator';

const start = { lat: 48.525, lon: 35.8603 };
const finish = { lat: 48.5288, lon: 35.865 };
const tilePath = '2/000/798/623.gph';

describe('Android package contract', () => {
  const manifest: OfflinePackage = {
    version: 1, engine: 'valhalla-3.9', bounds: [35, 48, 36, 49], style: { version: 8, sources: {}, layers: [] },
    assets: [{ path: 'addresses.json', bytes: 100 }, { path: 't/12/1/1', bytes: 400 }, { path: `graph/${tilePath}`, bytes: 1200 }],
  };
  it('requires graphs, vectors and addresses with unique safe paths', () => {
    expect(validateOfflinePackage(manifest)).toBe(manifest);
    expect(() => validateOfflinePackage({ ...manifest, assets: manifest.assets.slice(1) })).toThrow();
    expect(() => validateOfflinePackage({ ...manifest, assets: [...manifest.assets, ...manifest.assets] })).toThrow();
    expect(() => validateOfflinePackage({ ...manifest, assets: [...manifest.assets, { path: '../x', bytes: 1 }] })).toThrow();
  });
  it('finds Ukrainian and Russian aliases and matches house numbers as words', () => {
    const examples = [{ ...start, name: 'Вулиця Центральна 12', address: 'Павлоград', id: '12', aliases: ['улица Центральная'] },
      { ...start, name: 'Вулиця Центральна 123', address: 'Павлоград', id: '123', aliases: ['улица Центральная'] }];
    expect(matchOfflineAddresses(examples, 'павлоград центральна 12').map((x) => x.id)).toEqual(['12']);
    expect(matchOfflineAddresses(examples, 'ЦЕНТРАЛЬНАЯ 12').map((x) => x.id)).toEqual(['12']);
  });
});

describe('local Valhalla automotive profile', () => {
  it('decodes manoeuvres, follows one-way roads and takes the detour for a prohibited turn', async () => {
    const graph = await readFile(new URL(`../fixtures/offline-route/graph/${tilePath}`, import.meta.url));
    const wasmUrl = new URL('../../node_modules/@adret-maps/valhalla-wasm/dist/valhalla.wasm', import.meta.url);
    const engine = await loadValhalla({ tiles: new MemoryTileSource().set(tilePath, graph), wasmUrl });
    const route = fromValhalla(engine.route({ locations: [start, finish], costing: 'auto', units: 'kilometers' }), 'Тест');
    expect(route.coords[0].lon).toBeCloseTo(start.lon, 4);
    expect(route.coords.at(-1)?.lat).toBeCloseTo(finish.lat, 4);
    expect(route.coords).toContainEqual({ lat: 48.527, lon: 35.862 });
    expect(route.steps.some((step) => step.type === 'turn')).toBe(true);
    expect(route.steps.at(-1)?.type).toBe('arrive');
    expect(() => engine.route({ locations: [finish, start], costing: 'auto' })).toThrow();
  });

  it('stops advancing and raises uncertainty when no new measurement supports inferred speed', () => {
    const engine = new Estimator({ position: start, heading: 90, at: 1000 }, [start, advance(start, 90, 500)], 'road');
    for (let at = 1100; at < 3900; at += 100) engine.update({ type: 'motion', sample: { x: 2, y: 0, yawRate: 0, at } });
    expect(engine.state.speed).toBeGreaterThan(1);
    for (let at = 3900; at < 19000; at += 100) engine.update({ type: 'motion', sample: { x: 0, y: 0, yawRate: 0, at } });
    expect(engine.state).toMatchObject({ speed: 0, stopped: false });
    expect(engine.state.uncertainty).toBeGreaterThan(45);
    const held = engine.state.distance.fused;
    for (let at = 19000; at < 20000; at += 100) engine.update({ type: 'motion', sample: { x: 0, y: 0, yawRate: 0, at } });
    expect(engine.state.distance.fused).toBe(held);
  });

  it('holds an autonomous manual anchor through a spoof and stationary samples, then preserves it on a mode change', () => {
    const estimate = new Estimator({ position: start, heading: 90, at: 1000 }, [start, finish], 'road');
    estimate.update({ type: 'gps', sample: { lat: -12.04, lon: -77.04, accuracy: 5, speed: 14, at: 2000 } });
    for (let at = 2000; at < 4000; at += 50) estimate.update({ type: 'motion', sample: { x: 0, y: 0, yawRate: 0, at } });
    expect(estimate.state).toMatchObject({ ...start, gps: 'disabled', stopped: true });
    estimate.setVariant('adaptive');
    expect(estimate.state).toMatchObject({ ...start, gps: 'waiting' });
    estimate.setRoute([start, advance(start, 90, 300)]);
    expect(estimate.state.distance.fused).toBe(0);
  });
});
