import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { loadValhalla, MemoryTileSource } from '@adret-maps/valhalla-wasm';

const input = resolve(process.argv[2]);
const load = (path) => readFile(resolve(input, path));
const { settlements } = JSON.parse(await load('catalog.json'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
for (const city of settlements) {
  for (const path of Object.values(city.packages)) {
    const started = performance.now();
    const manifest = JSON.parse(await load(path));
    const base = path.replace(/manifest\.json$/, '');
    const tiles = new MemoryTileSource();
    let addressIndex;
    let vectorCount = 0;
    for (const [index, chunk] of manifest.chunks.entries()) {
      const content = await load(base + chunk.path);
      if (content.length !== chunk.bytes || hash(content) !== chunk.sha256) throw new Error('Invalid package chunk');
      for (const asset of manifest.assets.filter((entry) => entry.chunk === index)) {
        const bytes = content.subarray(asset.offset, asset.offset + asset.bytes);
        if (hash(bytes) !== asset.sha256) throw new Error('Invalid extracted asset');
        if (asset.path.startsWith('graph/')) tiles.set(asset.path.slice(6), Uint8Array.from(bytes));
        if (asset.path.startsWith('t/')) vectorCount++;
        if (asset.path === 'addresses.json') addressIndex = JSON.parse(bytes);
      }
    }
    if (!tiles.size || !vectorCount || !addressIndex?.length) throw new Error('Incomplete offline region');
    const engine = await loadValhalla({ tiles, config: { mjolnir: { max_cache_size: 16_000_000 } } });
    const candidates = addressIndex.filter((entry) => /\d/.test(entry.name))
      .sort((a, b) => distance(a, city) - distance(b, city));
    if (!candidates.length) throw new Error('No mapped house numbers in the region');
    const begin = performance.now();
    let pair, route;
    const errors = new Map();
    // The centre can be a pedestrian plaza or an address tagged deep inside a building.
    // Distribute the sample across streets and neighbourhoods, with the phone's snap radius.
    const local = candidates.filter((entry) => distance(entry, city) < .055);
    const sample = local.filter((_, index) => index % Math.max(1, Math.floor(local.length / 64)) === 0).slice(0, 64);
    for (const from of sample) {
      const destinations = sample.filter((entry) => distance(entry, from) > .002 && distance(entry, from) < .035);
      for (const to of destinations.slice(0, 12)) {
        try {
          route = engine.route({ costing: 'auto', locations: [from, to].map(({ lat, lon }) => ({ lat, lon, radius: 75, search_cutoff: 150 })) });
          if (route.trip.summary.length > .2) { pair = [from.name, to.name]; break; }
        } catch (error) {
          if (error?.name !== 'ValhallaError') throw error;
          errors.set(error.code, (errors.get(error.code) ?? 0) + 1);
        }
      }
      if (pair) break;
    }
    if (!pair || !route.trip.legs.some((leg) => leg.maneuvers.length >= 2)) {
      throw new Error(`No useful route in ${city.name} among ${sample.length} sampled addresses: ${JSON.stringify([...errors])}`);
    }
    console.log(JSON.stringify({ city: city.name, radiusKm: manifest.radiusKm, addresses: addressIndex.length, vectorCount,
      packageBytes: manifest.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0), graphBytes: tiles.bytes,
      pair, routeKm: route.trip.summary.length, computeMs: Math.round(performance.now() - begin),
      verifyAndInitMs: Math.round(begin - started), wasmMemoryBytes: engine.memoryBytes }));
  }
}

function distance(point, center) {
  return Math.hypot(point.lat - center.lat, (point.lon - center.lon) * .66);
}
