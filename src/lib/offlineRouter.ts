import { initializeOfflineMaps, offlineRegions, type OfflineRegion } from './offlineMaps';
import { pointInBounds } from './offlinePackageFormat';
import type { LatLon, Route } from './routing';

type Phase = 'catalogue' | 'worker' | 'graph' | 'wasm' | 'route';
type Failure = 'timeout' | 'worker' | 'graph' | 'wasm' | 'no-route' | 'catalogue';
type Reply = { phase: Phase } | { route: Route } | { failure: Failure };
const messages: Record<Failure, string> = {
  timeout: 'Локальный маршрутизатор не ответил вовремя. Повторите попытку.',
  worker: 'Не удалось запустить локальный маршрутизатор. Повторите попытку.',
  graph: 'Не удалось прочитать дорожный граф. Обновите скачанную карту.',
  wasm: 'Не удалось инициализировать Valhalla. Повторите попытку.',
  'no-route': 'Valhalla не нашёл проезда. Уточните точки на дороге или скачайте карту всей поездки.',
  catalogue: 'Не удалось открыть каталог скачанных карт. Повторите попытку.',
};
class LocalFailure extends Error {
  constructor(readonly code: Failure) { super(messages[code]); }
}
const logKey = 'ace:offline-routing-diagnostics';
const events: Record<string, unknown>[] = (() => {
  try { return JSON.parse(localStorage.getItem(logKey) ?? '[]').slice(-80); }
  catch { return []; }
})();
routingEvent({ lifecycle: 'new-session' });
export function routingEvent(event: Record<string, unknown>) {
  events.push({ at: new Date().toISOString(), ...event });
  if (events.length > 80) events.shift();
  try { localStorage.setItem(logKey, JSON.stringify(events)); } catch { /* Report remains in memory. */ }
}
export function routingDiagnostics() { return events.slice(); }
const cancelled = () => new DOMException('Route cancelled', 'AbortError');

function bounded<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const settle = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { settle(); reject(cancelled()); };
    const timer = setTimeout(() => { settle(); reject(new LocalFailure('timeout')); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    work.then((value) => { settle(); resolve(value); }, (error) => { settle(); reject(error); });
  });
}

export async function routingRegion(points: LatLon[], signal?: AbortSignal) {
  const start = performance.now();
  try {
    await bounded(initializeOfflineMaps(), 8000, signal);
    const region = offlineRegions.get().find((candidate) => candidate.graph?.length && points.every((point) => pointInBounds(point, candidate.bounds)));
    routingEvent({ phase: 'catalogue', ms: Math.round(performance.now() - start), covered: !!region });
    return region;
  } catch {
    if (signal?.aborted) throw cancelled();
    routingEvent({ phase: 'catalogue', failure: 'catalogue', ms: Math.round(performance.now() - start) });
    throw new LocalFailure('catalogue');
  }
}

function attempt(region: OfflineRegion, points: LatLon[], signal?: AbortSignal): Promise<Route> {
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    let worker: Worker | undefined;
    let phase: Phase = 'worker';
    let started = performance.now();
    const log = () => routingEvent({ phase, ms: Math.round(performance.now() - started) });
    const done = () => {
      log();
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      worker?.terminate();
    };
    const fail = (code: Failure) => { done(); reject(new LocalFailure(code)); };
    const abort = () => { done(); reject(cancelled()); };
    const timeout = setTimeout(() => fail('timeout'), 40_000);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      worker = new Worker(new URL('./offlineRouter.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }: MessageEvent<Reply>) => {
        if ('phase' in data) {
          log();
          phase = data.phase;
          started = performance.now();
        } else if ('route' in data && data.route.coords.length >= 2) {
          done();
          resolve(data.route);
        } else fail('failure' in data ? data.failure : 'no-route');
      };
      worker.onerror = () => fail('worker');
      worker.onmessageerror = () => fail('worker');
      worker.postMessage({ region, points });
    } catch { fail('worker'); }
  });
}

export async function localRoute(points: LatLon[], signal?: AbortSignal, installed?: OfflineRegion | null): Promise<Route> {
  const region = installed === undefined ? await routingRegion(points, signal) : installed;
  if (!region) throw new Error('Нет покрытия дорожного графа для всех точек. Скачайте общий регион или выберите точки внутри него.');
  const graph = { region: region.name, version: region.dataDate ?? new Date(region.updated).toISOString(), installedAt: region.updated };
  routingEvent({ router: 'local', settlement: region.settlementId, radiusKm: region.radiusKm, version: graph.version,
    installedAt: graph.installedAt, graphTiles: region.graph?.length, externalRequests: 0 });
  for (let run = 1; ; run++) {
    try {
      const route = await attempt(region, points, signal);
      routingEvent({ result: 'success', attempt: run, externalRequests: 0 });
      return { ...route, offlineGraph: graph };
    } catch (error) {
      const retry = !signal?.aborted && run === 1 && error instanceof LocalFailure &&
        (error.code === 'timeout' || error.code === 'worker' || error.code === 'wasm');
      routingEvent({ failure: error instanceof LocalFailure ? error.code : 'cancelled', attempt: run, retry });
      if (!retry) throw error;
    }
  }
}
