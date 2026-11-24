import { loadValhalla, MemoryTileSource } from '@adret-maps/valhalla-wasm';
import wasmUrl from '@adret-maps/valhalla-wasm/valhalla.wasm?url';
import { readOfflineAsset } from './offlineMaps';
import { fromValhalla } from './valhallaRoute';
import type { OfflineRegion } from './offlineMaps';
import type { LatLon } from './routing';

self.onmessage = async ({ data }: MessageEvent<{ region: OfflineRegion; points: LatLon[] }>) => {
  const { region, points } = data;
  try {
    const tiles = new MemoryTileSource();
    for (const path of region.graph ?? []) {
      const buffer = await readOfflineAsset(region.id, path);
      if (!buffer) throw new Error('Не хватает данных дорожного графа. Обновите пакет.');
      tiles.set(path.slice('graph/'.length), new Uint8Array(buffer));
    }
    const engine = await loadValhalla({ tiles, wasmUrl: new URL(wasmUrl, self.location.href),
      config: { mjolnir: { max_cache_size: 16_000_000 } } });
    const result = engine.route({ locations: points.map((point) => ({ ...point, radius: 75, search_cutoff: 150 })),
      costing: 'auto', units: 'kilometers' });
    self.postMessage({ route: fromValhalla(result, region.name) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Локальный поиск маршрута завершился ошибкой.' });
  }
};
