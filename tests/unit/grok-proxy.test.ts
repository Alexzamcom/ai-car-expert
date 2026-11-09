import { describe, it, expect, vi } from 'vitest';
// @ts-expect-error — модуль на JS без типов
import { handle, validateBody, safeEqual } from '../../server/grok-proxy/src/handler.js';

const env = { XAI_API_KEY: 'xai-secret', ACCESS_TOKEN: 'app-token', ALLOWED_ORIGINS: 'https://alexzamcom.github.io', GROK_MODEL: 'grok-test' };
const body = { messages: [{ role: 'user', content: 'Привет' }], tools: [{ type: 'function', function: { name: 'navigate_to', description: 'x', parameters: { type: 'object' } } }] };
const req = (init: { origin?: string; token?: string; body?: unknown; method?: string; path?: string } = {}) =>
  new Request(`https://proxy.example${init.path ?? '/chat'}`, {
    method: init.method ?? 'POST',
    headers: {
      ...(init.origin !== undefined ? { Origin: init.origin } : { Origin: 'https://alexzamcom.github.io' }),
      ...(init.token !== undefined ? { Authorization: `Bearer ${init.token}` } : { Authorization: 'Bearer app-token' }),
      'Content-Type': 'application/json',
    },
    body: (init.method ?? 'POST') === 'POST' ? JSON.stringify(init.body ?? body) : undefined,
  });

const okUpstream = () =>
  vi.fn(async () => new Response(JSON.stringify({ model: 'grok-test', choices: [{ message: { role: 'assistant', content: 'Здравствуйте' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

describe('Grok-прокси', () => {
  it('пересылает запрос в xAI с ключом сервера и моделью из настроек', async () => {
    const f = okUpstream();
    const res = await handle(req(), env, f);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.choices[0].message.content).toBe('Здравствуйте');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.x.ai/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer xai-secret');
    const sent = JSON.parse(String(init.body));
    expect(sent.model).toBe('grok-test');
    expect(sent.tools[0].function.name).toBe('navigate_to');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://alexzamcom.github.io');
  });
  it('ключ xAI не попадает в ответ', async () => {
    const res = await handle(req(), env, okUpstream());
    expect(await res.text()).not.toContain('xai-secret');
  });
  it('отклоняет чужой источник', async () => {
    const f = okUpstream();
    const res = await handle(req({ origin: 'https://evil.example' }), env, f);
    expect(res.status).toBe(403);
    expect(f).not.toHaveBeenCalled();
  });
  it('отклоняет неверный токен', async () => {
    const f = okUpstream();
    expect((await handle(req({ token: 'wrong' }), env, f)).status).toBe(401);
    expect(f).not.toHaveBeenCalled();
  });
  it('не скрывает отсутствие настройки сервера', async () => {
    expect((await handle(req(), { ...env, XAI_API_KEY: '' }, okUpstream())).status).toBe(500);
  });
  it('health без секретов', async () => {
    const res = await handle(req({ method: 'GET', path: '/health' }), env, okUpstream());
    expect(await res.json()).toEqual({ ok: true, model: 'grok-test', keyConfigured: true });
  });
  it('ошибка авторизации xAI не раскрывается клиенту как 401', async () => {
    const f = vi.fn(async () => new Response('{"error":"bad key xai-..."}', { status: 401 }));
    const res = await handle(req(), env, f);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('bad key');
  });
  it('валидация тела', () => {
    expect(validateBody({}).error).toBeTruthy();
    expect(validateBody({ messages: [{ role: 'hacker', content: 'x' }] }).error).toBeTruthy();
    expect(validateBody({ messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'Bad Name!' } }] }).error).toBeTruthy();
    expect(validateBody(body).messages).toHaveLength(1);
  });
  it('safeEqual', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
