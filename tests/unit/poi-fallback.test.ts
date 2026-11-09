import { describe, it, expect, vi, afterEach } from 'vitest';
import overpass from '../fixtures/overpass-fuel.json';
import { poiNearby, OVERPASS_SERVERS } from '../../src/lib/poi';

afterEach(() => vi.unstubAllGlobals());

describe('Overpass: резервные серверы', () => {
  it('спрашивает все серверы сразу и берёт ответ того, кто ответил', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      if (url === OVERPASS_SERVERS[0]) return new Response('busy', { status: 504 });
      if (url === OVERPASS_SERVERS[1]) return new Promise<Response>(() => {}); // завис
      return new Response(JSON.stringify(overpass), { status: 200 });
    }));
    const items = await poiNearby({ lat: 55.757, lon: 37.6156 }, 'fuel');
    expect(calls.sort()).toEqual([...OVERPASS_SERVERS].sort());
    expect(items[0].name).toBe('Газпромнефть'); // ближайшая к точке
  });

  it('медленный сервер (13 с) не отбрасывается, если остальные отказали', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url !== OVERPASS_SERVERS[2]) return new Response('', { status: 504 });
      await new Promise((r) => setTimeout(r, 13_000));
      return new Response(JSON.stringify(overpass), { status: 200 });
    }));
    const p = poiNearby({ lat: 55.757, lon: 37.6156 }, 'fuel');
    await vi.advanceTimersByTimeAsync(13_500);
    expect((await p).length).toBe(3);
    vi.useRealTimers();
  });

  it('ответ «timed out» с пустым результатом не считается успехом', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url === OVERPASS_SERVERS[0]
        ? new Response(JSON.stringify({ elements: [], remark: 'runtime error: Query timed out' }), { status: 200 })
        : url === OVERPASS_SERVERS[1]
          ? new Response('', { status: 504 })
          : new Response(JSON.stringify(overpass), { status: 200 }),
    ));
    expect((await poiNearby({ lat: 55.757, lon: 37.6156 }, 'fuel')).length).toBe(3);
  });

  it('если все серверы недоступны — понятная ошибка', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })));
    await expect(poiNearby({ lat: 55.757, lon: 37.6156 }, 'fuel')).rejects.toThrow('перегружен');
  });
});
