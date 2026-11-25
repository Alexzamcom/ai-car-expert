import { afterEach, describe, expect, it, vi } from 'vitest';
import { localRoute, routingDiagnostics, routingRegion } from '../../src/lib/offlineRouter';
import { plannerViewport } from '../../src/lib/routePlanner';
import { offlineRegions } from '../../src/lib/offlineMaps';

vi.mock('../../src/lib/offlineMaps', () => ({
  initializeOfflineMaps: vi.fn(async () => {}),
  offlineRegions: { get: vi.fn() },
}));

const start = { lat: 48.53, lon: 35.87 };
const end = { lat: 48.55, lon: 35.9 };
const confused = { lat: -12.04, lon: -77.04 };
const region = { id: 'local', name: 'Павлоград', center: start, bounds: [35, 48, 36, 49], graph: ['graph/tile'], updated: 10 };
const second = { name: 'Дніпро', center: { lat: 48.46, lon: 35.04 } };
const route = { coords: [start, end], distance: 2000, duration: 200, steps: [] };

function installWorker(response: (attempt: number, worker: { onmessage?: (event: { data: unknown }) => void }) => void) {
  const terminate = vi.fn();
  let count = 0;
  vi.stubGlobal('Worker', class {
    onmessage?: (event: { data: unknown }) => void;
    terminate = terminate;
    postMessage() { response(++count, this); }
  });
  return terminate;
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('offline recovery', () => {
  it('never opens rejected GPS or a stale manual point instead of the installed region', () => {
    const regions = [region, second];
    const mode = { manual: true, rechecking: false, point: { ...confused, at: 1 } };
    expect(plannerViewport(mode, confused, regions, '', 100_000_000).source).toBe('choose');
    expect(plannerViewport(mode, confused, regions, second.name, 100_000_000).point).toEqual(second.center);
    expect(plannerViewport(mode, confused, [region], '', 100_000_000).point).toEqual(start);
    expect(plannerViewport({ ...mode, point: { ...end, at: 100_000_000 } }, confused, regions, '', 100_000_000).point).toMatchObject(end);
  });

  it('loads the applicable graph and recovers from a failed WASM instance once', async () => {
    vi.mocked(offlineRegions.get).mockReturnValue([region] as never);
    const close = installWorker((run, worker) => worker.onmessage?.({ data: run === 1 ? { failure: 'wasm' } : { route } }));
    expect(await routingRegion([start, end])).toMatchObject({ id: region.id });
    expect(await localRoute([start, end])).toMatchObject({ offlineGraph: { region: region.name, installedAt: 10 } });
    expect(close).toHaveBeenCalledTimes(2);
    expect(routingDiagnostics()).toContainEqual(expect.objectContaining({ retry: true, failure: 'wasm' }));
  });

  it('recovers from a silent worker without keeping a failed worker alive', async () => {
    vi.useFakeTimers();
    const close = installWorker((run, worker) => {
      if (run === 2) worker.onmessage?.({ data: { route } });
    });
    const result = localRoute([start, end], undefined, region as never);
    await vi.advanceTimersByTimeAsync(40_000);
    await expect(result).resolves.toMatchObject(route);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('terminates a cancelled worker without retry', async () => {
    const close = installWorker(() => {});
    const request = new AbortController();
    const result = localRoute([start, end], request.signal, region as never);
    request.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not retry a corrupt graph or delete it', async () => {
    const close = installWorker((_, worker) => worker.onmessage?.({ data: { failure: 'graph' } }));
    await expect(localRoute([start, end], undefined, region as never)).rejects.toThrow('Обновите скачанную карту');
    expect(close).toHaveBeenCalledOnce();
  });
});
