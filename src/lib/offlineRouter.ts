import { initializeOfflineMaps, offlineRegions } from './offlineMaps';
import { pointInBounds } from './offlinePackageFormat';
import type { LatLon, Route } from './routing';

export async function routingRegion(points: LatLon[]) {
  await initializeOfflineMaps().catch(() => {});
  return offlineRegions.get().find((region) => region.graph?.length && points.every((point) => pointInBounds(point, region.bounds)));
}

export async function localRoute(points: LatLon[], signal?: AbortSignal): Promise<Route> {
  const region = await routingRegion(points);
  signal?.throwIfAborted();
  if (!region) throw new Error('Нет покрытия дорожного графа для всех точек. Скачайте общий регион или выберите точки внутри него.');
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./offlineRouter.worker.ts', import.meta.url), { type: 'module' });
    const done = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      worker.terminate();
    };
    const abort = () => { done(); reject(new DOMException('Route cancelled', 'AbortError')); };
    const timeout = setTimeout(() => { done(); reject(new Error('Локальный расчёт маршрута превысил время ожидания.')); }, 40_000);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }) => {
      done();
      if (data.route?.coords?.length >= 2) resolve(data.route);
      else reject(new Error(`Локальный маршрут не найден. ${data.error ?? ''}`.trim()));
    };
    worker.onerror = () => { done(); reject(new Error('Локальный движок Valhalla недоступен.')); };
    worker.postMessage({ region, points });
  });
}
