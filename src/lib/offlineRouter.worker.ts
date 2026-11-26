import { loadValhalla, MemoryTileSource, ValhallaError } from '@adret-maps/valhalla-wasm';
import { readOfflineAsset } from './offlineMaps';
import { fromValhalla } from './valhallaRoute';
import type { OfflineRegion } from './offlineMaps';
import type { LatLon } from './routing';

self.onmessage = async ({ data }: MessageEvent<{ region: OfflineRegion; points: LatLon[]; bytes?: ArrayBuffer; wasmUrl?: string }>) => {
  self.onmessage = null;
  const { region, points, bytes, wasmUrl } = data;
  let blobUrl: string | undefined;
  let failure = 'worker';
  try {
    self.postMessage({ phase: 'graph' });
    const tiles = new MemoryTileSource();
    for (const path of region.graph ?? []) {
      const buffer = await (bytes ? new Promise<ArrayBuffer | undefined>((resolve) => {
        self.addEventListener('message', (event) => resolve(event.data.buffer), { once: true });
        self.postMessage({ asset: path });
      }) : readOfflineAsset(region.id, path));
      if (!buffer?.byteLength) {
        self.postMessage({ failure: 'graph' });
        return;
      }
      tiles.set(path.slice('graph/'.length), new Uint8Array(buffer));
    }
    failure = 'wasm';
    self.postMessage({ phase: 'wasm' });
    if (bytes) blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/wasm' }));
    const resource = blobUrl ?? wasmUrl;
    if (!resource) throw new Error('WASM asset is unavailable');
    const engine = await loadValhalla({ tiles, wasmUrl: new URL(resource, self.location.href),
      config: { mjolnir: { max_cache_size: 16_000_000 } } });
    failure = 'worker';
    self.postMessage({ phase: 'route' });
    const result = engine.route({ locations: points.map((point) => ({ ...point, radius: 75, search_cutoff: 150 })),
      costing: 'auto', units: 'kilometers' });
    self.postMessage({ route: fromValhalla(result, region.name) });
  } catch (error) {
    self.postMessage({ failure: error instanceof ValhallaError ? 'no-route' : failure });
  } finally { if (blobUrl) URL.revokeObjectURL(blobUrl); }
};
