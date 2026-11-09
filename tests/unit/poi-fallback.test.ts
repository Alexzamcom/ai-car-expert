import { describe, it, expect, vi, afterEach } from 'vitest';
import overpass from '../fixtures/overpass-fuel.json';
import { poiNearby, OVERPASS_SERVERS } from '../../src/lib/poi';

afterEach(() => vi.unstubAllGlobals());

describe('Overpass: резервные серверы', () => {
  it('при 504 первого сервера берёт результат со второго', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      if (calls.length === 1) return new Response('busy', { status: 504 });
      return new Response(JSON.stringify(overpass), { status: 200 });
    }));
    const items = await poiNearby({ lat: 55.757, lon: 37.6156 }, 'fuel');
    expect(calls).toEqual(OVERPASS_SERVERS.slice(0, 2));
    expect(items[0].name).toBe('Газпромнефть'); // ближайшая к точке
  });

  it('ответ «timed out» с пустым результатом не считается успехом', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n++;
      return n === 1
        ? new Response(JSON.stringify({ elements: [], remark: 'runtime error: Query timed out' }), { status: 200 })
        : new Response(JSON.stringify(overpass), { status: 200 });
    }));
    expect((await poiNearby({ lat: 55.757, lon: 37.6156 }, 'fuel')).length).toBe(3);
  });

  it('если все серверы недоступны — понятная ошибка', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })));
    await expect(poiNearby({ lat: 55.757, lon: 37.6156 }, 'fuel')).rejects.toThrow('перегружен');
  });
});
