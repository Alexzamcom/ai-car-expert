import { describe, it, expect, vi, beforeEach } from 'vitest';
// @ts-expect-error — модуль на JS без типов
import { handle, validateBody, safeEqual, pickProvider, upstreamBody, __resetDaily, __resetModels, priceFor, costUsd, resolveModels } from '../../server/ai-proxy/src/handler.js';

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

beforeEach(() => {
  __resetDaily();
  __resetModels();
});

describe('ИИ-прокси: Grok', () => {
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
    expect((await handle(req(), { ...env, ACCESS_TOKEN: '' }, okUpstream())).status).toBe(500);
  });
  it('health без секретов', async () => {
    const res = await handle(req({ method: 'GET', path: '/health' }), env, okUpstream());
    const data = await res.json();
    expect(data).toMatchObject({ ok: true, model: 'grok-test', keyConfigured: true, defaultProvider: 'grok' });
    expect(data.providers.openai).toMatchObject({ configured: false, model: 'gpt-5-mini' });
    expect(data.providers.grok).toMatchObject({ configured: true, model: 'grok-test' });
    expect(data.limits).toMatchObject({ monthlyBudgetUsd: 5, persistent: false });
    expect(JSON.stringify(data)).not.toContain('secret');
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

const envBoth = { ...env, OPENAI_API_KEY: 'sk-openai-secret', OPENAI_MODEL: 'gpt-test', DEFAULT_PROVIDER: 'openai', OPENAI_REASONING_EFFORT: 'minimal', MAX_TOKENS: '300' };
const okOpenAi = () =>
  vi.fn(async () =>
    new Response(JSON.stringify({ model: 'gpt-test', choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'navigate_to', arguments: '{"destination":"Київ"}' } }] } }], usage: { prompt_tokens: 1200, completion_tokens: 40 } }), { status: 200 }),
  );

describe('ИИ-прокси: OpenAI и выбор провайдера', () => {
  it('по умолчанию — OpenAI с ключом сервера, max_completion_tokens и без temperature', async () => {
    const f = okOpenAi();
    const res = await handle(req(), envBoth, f);
    expect(res.status).toBe(200);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-openai-secret');
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject({ model: 'gpt-test', max_completion_tokens: 300, reasoning_effort: 'minimal', tool_choice: 'auto' });
    expect(sent.temperature).toBeUndefined();
    expect(sent.max_tokens).toBeUndefined();
    const data = await res.json();
    expect(data.provider).toBe('openai');
    expect(data.usage).toEqual({ prompt_tokens: 1200, completion_tokens: 40 });
    expect(data.choices[0].message.tool_calls[0].function.name).toBe('navigate_to');
    expect(JSON.stringify(data)).not.toContain('sk-openai');
  });
  it('приложение может выбрать Grok', async () => {
    const f = okUpstream();
    await handle(req({ body: { ...body, provider: 'grok' } }), envBoth, f);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.x.ai/v1/chat/completions');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'grok-test', max_tokens: 300, temperature: 0.4 });
  });
  it('провайдер без ключа — понятная ошибка, без запроса наружу', async () => {
    const f = okOpenAi();
    const res = await handle(req({ body: { ...body, provider: 'openai' } }), env, f);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('OpenAI');
    expect(f).not.toHaveBeenCalled();
    expect(pickProvider('claude', envBoth).error).toBeTruthy();
    expect(pickProvider(undefined, { XAI_API_KEY: 'x' }).provider).toBe('grok');
  });
  it('суточный предел запросов защищает бюджет', async () => {
    const f = okOpenAi();
    const e = { ...envBoth, DAILY_REQUEST_LIMIT: '2' };
    expect((await handle(req(), e, f)).status).toBe(200);
    expect((await handle(req(), e, f)).status).toBe(200);
    const res = await handle(req(), e, f);
    expect(res.status).toBe(429);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('общий счётчик в KV, если подключён', async () => {
    const kv = new Map<string, string>();
    const USAGE = { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v) };
    const e = { ...envBoth, DAILY_REQUEST_LIMIT: '1', USAGE };
    expect((await handle(req(), e, okOpenAi())).status).toBe(200);
    expect((await handle(req(), e, okOpenAi())).status).toBe(429);
    expect(kv.get(`requests:${new Date().toISOString().slice(0, 10)}`)).toBe('2');
  });
  it('ошибка OpenAI не пересылается дословно', async () => {
    const f = vi.fn(async () => new Response('{"error":{"message":"Incorrect API key sk-openai-secret"}}', { status: 401 }));
    const res = await handle(req(), envBoth, f);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('sk-openai');
  });
  it('тело для Grok и OpenAI', () => {
    const v = { messages: [{ role: 'user', content: 'x' }] };
    expect(upstreamBody('openai', {}, v)).toEqual({ model: 'gpt-5-mini', messages: v.messages, max_completion_tokens: 700 });
    expect(upstreamBody('grok', {}, v)).toEqual({ model: 'grok-4', messages: v.messages, max_tokens: 700, temperature: 0.4 });
  });
  it('недопустимый провайдер в теле', () => {
    expect(validateBody({ ...body, provider: 42 }).error).toBeTruthy();
    expect(validateBody({ ...body, provider: 'grok' }).provider).toBe('grok');
  });
});

const kvStore = () => {
  const kv = new Map<string, string>();
  return { kv, USAGE: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v) } };
};
const openAiReply = (usage = { prompt_tokens: 4000, completion_tokens: 100 }, model = 'gpt-5-mini') =>
  new Response(JSON.stringify({ model, choices: [{ message: { role: 'assistant', content: 'Ок' } }], usage }), { status: 200 });

describe('ИИ-прокси: бюджет и модель', () => {
  it('цены: известные модели, датированные версии, неизвестная — по завышенной цене', () => {
    expect(priceFor('openai', 'gpt-5-mini', {})).toEqual([0.25, 2]);
    expect(priceFor('openai', 'gpt-5-mini-2025-08-07', {})).toEqual([0.25, 2]);
    expect(priceFor('openai', 'gpt-5.4-mini', {})).toEqual([0.75, 4.5]);
    expect(priceFor('openai', 'gpt-9-ultra', {})).toEqual([3, 15]);
    expect(priceFor('openai', 'gpt-5-mini', { OPENAI_PRICE_IN: '1', OPENAI_PRICE_OUT: '8' })).toEqual([1, 8]);
    expect(costUsd([0.25, 2], { prompt_tokens: 4000, completion_tokens: 100 })).toBeCloseTo(0.0012);
  });
  it('месячный бюджет в KV: расход считается по usage и останавливает запросы', async () => {
    const { kv, USAGE } = kvStore();
    const e = { ...envBoth, OPENAI_MODEL: 'gpt-5-mini', MONTHLY_BUDGET_USD: '0.002', USAGE };
    const f = vi.fn(async () => openAiReply());
    expect((await handle(req(), e, f)).status).toBe(200); // 0.0012
    expect((await handle(req(), e, f)).status).toBe(200); // 0.0024 — превышение на один запрос
    const res = await handle(req(), e, f);
    expect(res.status).toBe(429);
    expect((await res.json()).error).toContain('Месячный бюджет');
    expect(f).toHaveBeenCalledTimes(2);
    expect(kv.get(`cost:${new Date().toISOString().slice(0, 7)}`)).toBe('2400');
  });
  it('расход сервера доступен только с токеном приложения', async () => {
    const { USAGE } = kvStore();
    const e = { ...envBoth, OPENAI_MODEL: 'gpt-5-mini', USAGE };
    await handle(req(), e, vi.fn(async () => openAiReply()));
    expect((await handle(req({ method: 'GET', path: '/usage', token: 'wrong' }), e)).status).toBe(401);
    const data = await (await handle(req({ method: 'GET', path: '/usage' }), e)).json();
    expect(data).toMatchObject({ spentUsd: 0.0012, budgetUsd: 5, requestsToday: 1, persistent: true });
  });
  it('REQUIRE_KV: без хранилища лимитов сервер не тратит деньги', async () => {
    const f = vi.fn(async () => openAiReply());
    const res = await handle(req(), { ...envBoth, REQUIRE_KV: '1' }, f);
    expect(res.status).toBe(500);
    expect(f).not.toHaveBeenCalled();
  });
  it('модель: первая доступная ключу из списка', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'gpt-4.1-mini' }, { id: 'gpt-5.4-mini' }] }), { status: 200 }));
    const env2 = { OPENAI_API_KEY: 'k', OPENAI_MODEL: 'gpt-5-mini, gpt-5.4-mini ,gpt-4.1-mini' };
    expect(await resolveModels('openai', env2, f)).toEqual(['gpt-5.4-mini', 'gpt-4.1-mini', 'gpt-5-mini']);
    await resolveModels('openai', env2, f);
    expect(f).toHaveBeenCalledTimes(1); // кэш
  });
  it('провайдер не принял reasoning_effort — повтор без него; модель недоступна — следующая', async () => {
    const bodies: Record<string, unknown>[] = [];
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/models')) return new Response('{}', { status: 500 });
      const b = JSON.parse(String(init!.body));
      bodies.push(b);
      if (b.reasoning_effort) return new Response(JSON.stringify({ error: { message: "Unsupported value: 'reasoning_effort'" } }), { status: 400 });
      if (b.model === 'gpt-a') return new Response(JSON.stringify({ error: { message: 'The model `gpt-a` does not exist' } }), { status: 404 });
      return openAiReply(undefined, b.model);
    });
    const res = await handle(req(), { ...envBoth, OPENAI_MODEL: 'gpt-a,gpt-b' }, f);
    expect(res.status).toBe(200);
    expect(bodies.map((b) => [b.model, Boolean(b.reasoning_effort)])).toEqual([
      ['gpt-a', true],
      ['gpt-a', false],
      ['gpt-b', false],
    ]);
  });
});

describe('Конфигурация развёртывания', () => {
  it('KV и REQUIRE_KV добавляются к wrangler.toml, секреты не появляются', async () => {
    // @ts-expect-error — модуль на JS без типов
    const { withKv } = await import('../../scripts/ai-proxy-config.mjs');
    const fs = await import('node:fs');
    const base = fs.readFileSync('server/ai-proxy/wrangler.toml', 'utf8');
    const out = withKv(base, '0123456789abcdef0123456789abcdef');
    expect(out).toMatch(/\[vars\]\nREQUIRE_KV = "1"/);
    expect(out).toContain('binding = "USAGE"\nid = "0123456789abcdef0123456789abcdef"');
    expect(out).toContain('MONTHLY_BUDGET_USD = "4.5"');
    expect(out).not.toMatch(/OPENAI_API_KEY\s*=|ACCESS_TOKEN\s*=|sk-/);
    expect(() => withKv(base, 'bad')).toThrow();
  });
});
