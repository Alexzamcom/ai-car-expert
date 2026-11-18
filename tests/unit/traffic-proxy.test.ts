/* Сервер пробок (Cloudflare Worker): ключ не утекает, квота и частота ограничены, кэш, запись счётчиков пачками. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// @ts-expect-error — модуль на JS без типов
import { handle, __reset, tileInBounds, inBounds, trimRoutes, spend, usage } from '../../server/traffic-proxy/src/handler.js';

const ORIGIN = 'https://alexzamcom.github.io';
function kv() {
  const m = new Map<string, string>();
  const puts: string[] = [];
  return { m, puts, get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void (m.set(k, v), puts.push(k)) };
}
const baseEnv = (extra: Record<string, unknown> = {}) => ({ TOMTOM_KEY: 'tt-secret-key', ALLOWED_ORIGINS: ORIGIN, REQUIRE_KV: '1', USAGE: kv(), ...extra });
const req = (path: string, origin: string | null = ORIGIN, ip = '1.2.3.4') =>
  new Request(`https://traffic.example${path}`, { headers: { ...(origin ? { Origin: origin } : {}), 'CF-Connecting-IP': ip } });
// Днепр, z12
const DNIPRO_TILE = '/tiles/flow/12/2446/1408.png';

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  __reset();
  fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/tile/')) return new Response(new Uint8Array([137, 80, 78, 71, 1, 2, 3]), { status: 200 });
    if (url.includes('calculateRoute'))
      return new Response(
        JSON.stringify({ routes: [{ summary: { lengthInMeters: 100000, travelTimeInSeconds: 4000, trafficDelayInSeconds: 300, noTrafficTravelTimeInSeconds: 3700 }, legs: [{ points: [{ latitude: 48.53, longitude: 35.87 }, { latitude: 48.46, longitude: 35.04 }] }], sections: [{ sectionType: 'TRAFFIC', startPointIndex: 0, endPointIndex: 1, delayInSeconds: 300, magnitudeOfDelay: 2, simpleCategory: 'JAM' }] }] }),
        { status: 200 },
      );
    if (url.includes('flowSegmentData')) return new Response(JSON.stringify({ flowSegmentData: { currentSpeed: 35, freeFlowSpeed: 60, confidence: 0.9, roadClosure: false, frc: 'FRC2' } }), { status: 200 });
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('Сервер пробок: безопасность', () => {
  it('ключ уходит только в TomTom и никогда не возвращается клиенту', async () => {
    const env = baseEnv();
    const r = await handle(req(DNIPRO_TILE), env);
    expect(r.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toContain('key=tt-secret-key');
    expect(fetchMock.mock.calls[0][0]).toMatch(/^https:\/\/api\.tomtom\.com\/traffic\/map\/4\/tile\/flow\/relative0\/12\/2446\/1408\.png/);
    const health = await (await handle(req('/health', null), env)).text();
    expect(health).not.toContain('tt-secret');
    const route = await (await handle(req('/route?points=48.53,35.87;48.46,35.04'), env)).text();
    expect(route).not.toContain('tt-secret');
  });
  it('чужой Origin и запрос без Origin к данным — отказ, TomTom не вызывается', async () => {
    expect((await handle(req(DNIPRO_TILE, 'https://evil.example'), baseEnv())).status).toBe(403);
    expect((await handle(req(DNIPRO_TILE, null), baseEnv())).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('без ключа или без хранилища счётчиков — «не настроен», без запросов к TomTom', async () => {
    expect((await (await handle(req(DNIPRO_TILE), baseEnv({ TOMTOM_KEY: '' }))).json()).code).toBe('not-configured');
    expect((await handle(req(DNIPRO_TILE), baseEnv({ USAGE: undefined }))).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('только допустимая область и масштабы: мир и z 17+ — отказ', async () => {
    expect((await handle(req('/tiles/flow/17/1/1.png'), baseEnv())).status).toBe(400);
    expect((await handle(req('/tiles/flow/12/0/0.png'), baseEnv())).status).toBe(400);
    expect((await handle(req('/route?points=40.7,-74;48.46,35.04'), baseEnv())).status).toBe(400);
    expect((await handle(req('/flow?lat=0&lon=0'), baseEnv())).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(tileInBounds(12, 2446, 1408)).toBe(true);
    expect(inBounds(48.53, 35.87)).toBe(true);
  });
  it('частота с одного адреса ограничена', async () => {
    const env = baseEnv({ RATE_PER_MIN: '3' });
    for (let i = 0; i < 3; i++) await handle(req('/health', null, '9.9.9.9'), env);
    expect((await handle(req('/health', null, '9.9.9.9'), env)).status).toBe(429);
    expect((await handle(req('/health', null, '8.8.8.8'), env)).status).toBe(200);
  });
});

describe('Сервер пробок: квота и кэш', () => {
  it('повторный тайл — из кэша, без запроса к TomTom', async () => {
    const env = baseEnv();
    await handle(req(DNIPRO_TILE), env);
    const r2 = await handle(req(DNIPRO_TILE), env);
    expect(r2.headers.get('X-Cache')).toBe('HIT');
    expect(r2.headers.get('Cache-Control')).toContain('max-age=120');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('суточный потолок: дальше — 429 «quota», платных запросов нет', async () => {
    const env = baseEnv({ DAILY_TILES: '2' });
    expect((await handle(req('/tiles/flow/12/2446/1408.png'), env)).status).toBe(200);
    expect((await handle(req('/tiles/flow/12/2447/1408.png'), env)).status).toBe(200);
    const r = await handle(req('/tiles/flow/12/2448/1408.png'), env);
    expect(r.status).toBe(429);
    expect((await r.json()).code).toBe('quota');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('счётчики пишутся в KV пачками (бесплатно — 1000 записей в сутки)', async () => {
    const env = baseEnv();
    for (let i = 0; i < 60; i++) expect(await spend(env, 'tiles', undefined, 1_900_000_000_000 + i)).toBe(true);
    expect(env.USAGE.puts.length).toBeLessThanOrEqual(3);
    expect((await usage(env, 1_900_000_000_000 + 61)).tiles).toBe(60);
  });
  it('счётчик общий для экземпляров: потолок из KV действует после перезапуска', async () => {
    const env = baseEnv({ DAILY_ROUTES: '1' });
    const day = new Date().toISOString().slice(0, 10);
    await env.USAGE.put(`day:${day}`, JSON.stringify({ routes: 1 }));
    __reset();
    expect((await handle(req('/route?points=48.53,35.87;48.46,35.04'), env)).status).toBe(429);
  });
  it('TomTom отвечает 403/429 (лимит у поставщика) — приложению «quota», а не «пробок нет»', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 403 }));
    const r = await handle(req(DNIPRO_TILE), baseEnv());
    expect(r.status).toBe(429);
    expect((await r.json()).code).toBe('quota');
  });
});

describe('Сервер пробок: маршрут с пробками', () => {
  it('сокращённый ответ: время с пробками, задержка, без пробок, участки задержек', async () => {
    const r = await handle(req('/route?points=48.53,35.87;48.46,35.04&alternatives=2'), baseEnv());
    const d = await r.json();
    expect(d.routes[0]).toMatchObject({ lengthM: 100000, timeS: 4000, delayS: 300, noTrafficS: 3700 });
    expect(d.routes[0].coords[0]).toEqual([35.87, 48.53]);
    expect(d.routes[0].sections[0]).toMatchObject({ delayS: 300, magnitude: 2 });
    expect(fetchMock.mock.calls[0][0]).toContain('traffic=true');
    expect(fetchMock.mock.calls[0][0]).toContain('maxAlternatives=2');
  });
  it('пустой ответ TomTom — пустой список, без выдуманных данных', () => {
    expect(trimRoutes({})).toEqual([]);
  });
});
