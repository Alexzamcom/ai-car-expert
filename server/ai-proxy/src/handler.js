// Прокси AI Car Expert → OpenAI или xAI Grok (формат Chat Completions).
// Ключи провайдеров хранятся только в секретах сервера (OPENAI_API_KEY, XAI_API_KEY) и никогда не попадают в браузер.
// Доступ: только с разрешённых Origin и с токеном доступа приложения (ACCESS_TOKEN).
// Расходы ограничивает сервер: модель, длина ответа, запросов в минуту и в сутки и денежный бюджет в месяц
// задаются здесь, а не клиентом. Счётчики — в Cloudflare KV (привязка USAGE), общие для всех экземпляров.

const MAX_BODY = 96 * 1024;
const MAX_MESSAGES = 40;
const MAX_CONTENT = 24000; // системный промпт с базой знаний бывает длинным
const MAX_TOOLS = 32;
const ROLES = new Set(['system', 'user', 'assistant', 'tool']);

/** Провайдеры. Идентификаторы моделей задаются в wrangler.toml — названия моделей меняются, проверяйте у провайдера. */
export const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    url: 'https://api.openai.com/v1/chat/completions',
    keyEnv: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_MODEL',
    // Список предпочтений: берётся первая модель, доступная ключу (по /v1/models). Экономичные модели с function calling.
    defaultModel: 'gpt-5-mini,gpt-5.4-mini,gpt-4.1-mini',
    modelsUrl: 'https://api.openai.com/v1/models',
  },
  grok: {
    label: 'Grok',
    url: 'https://api.x.ai/v1/chat/completions',
    keyEnv: 'XAI_API_KEY',
    modelEnv: 'GROK_MODEL',
    defaultModel: 'grok-4',
  },
};

/* Цены, $ за 1 млн токенов (вход / выход) — для серверного бюджета. Сверяйте со страницей тарифов провайдера;
   переопределяются переменными OPENAI_PRICE_IN/OUT, GROK_PRICE_IN/OUT. Неизвестная модель считается по
   завышенной цене — бюджет срабатывает раньше, а не позже. */
export const PRICES = {
  'gpt-5-nano': [0.05, 0.4],
  'gpt-5-mini': [0.25, 2.0],
  'gpt-5.4-nano': [0.2, 1.25],
  'gpt-5.4-mini': [0.75, 4.5],
  'gpt-4.1-nano': [0.1, 0.4],
  'gpt-4.1-mini': [0.4, 1.6],
};
const UNKNOWN_PRICE = [3, 15];

export function priceFor(provider, model, env) {
  const pre = provider === 'openai' ? 'OPENAI' : 'GROK';
  const inEnv = Number(env[`${pre}_PRICE_IN`]);
  const outEnv = Number(env[`${pre}_PRICE_OUT`]);
  if (inEnv > 0 && outEnv > 0) return [inEnv, outEnv];
  const base = Object.keys(PRICES)
    .sort((a, b) => b.length - a.length)
    .find((k) => model === k || model.startsWith(`${k}-`));
  return base ? PRICES[base] : UNKNOWN_PRICE;
}

export function costUsd(price, usage) {
  return ((Number(usage?.prompt_tokens) || 0) * price[0] + (Number(usage?.completion_tokens) || 0) * price[1]) / 1e6;
}

/** Модели-кандидаты из настройки (через запятую). */
export function modelCandidates(provider, env) {
  const p = PROVIDERS[provider];
  return String(env[p.modelEnv] || p.defaultModel)
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
}

/* Какая модель доступна ключу: один запрос к списку моделей, результат кэшируется на час в экземпляре. */
const modelCache = new Map();
export function __resetModels() {
  modelCache.clear();
}
export async function resolveModels(provider, env, fetchImpl, now = Date.now()) {
  const list = modelCandidates(provider, env);
  const p = PROVIDERS[provider];
  if (list.length < 2 || !p.modelsUrl) return list;
  const hit = modelCache.get(provider);
  if (hit && now - hit.at < 3600_000) return hit.list;
  let ordered = list;
  try {
    const res = await fetchImpl(p.modelsUrl, { headers: { Authorization: `Bearer ${env[p.keyEnv]}` } });
    if (res.ok) {
      const ids = new Set(((await res.json())?.data ?? []).map((m) => m.id));
      const available = list.filter((m) => ids.has(m));
      // Доступные — первыми; остальные остаются запасными (вдруг список моделей неполный).
      ordered = [...available, ...list.filter((m) => !ids.has(m))];
    }
  } catch {
    /* список моделей недоступен — пробуем по порядку */
  }
  modelCache.set(provider, { at: now, list: ordered });
  return ordered;
}

export function configuredProviders(env) {
  return Object.keys(PROVIDERS).filter((p) => Boolean(env[PROVIDERS[p].keyEnv]));
}

/** Какой провайдер обслужит запрос: запрошенный клиентом (если ключ есть) или провайдер по умолчанию. */
export function pickProvider(requested, env) {
  const ready = configuredProviders(env);
  if (requested != null) {
    if (!PROVIDERS[requested]) return { error: 'Неизвестный провайдер' };
    if (!ready.includes(requested)) return { error: `На сервере не задан ключ для ${PROVIDERS[requested].label}` };
    return { provider: requested };
  }
  const def = env.DEFAULT_PROVIDER;
  if (def && ready.includes(def)) return { provider: def };
  if (ready.length) return { provider: ready[0] };
  return { error: 'На сервере не задан ни один ключ (OPENAI_API_KEY или XAI_API_KEY)' };
}

/** Тело запроса к провайдеру. У OpenAI новые модели принимают max_completion_tokens и не принимают temperature. */
export function upstreamBody(provider, env, v, model = modelCandidates(provider, env)[0], opts = {}) {
  const maxTokens = Number(env.MAX_TOKENS || 700);
  const base = {
    model,
    messages: v.messages,
    ...(v.tools?.length ? { tools: v.tools, tool_choice: 'auto' } : {}),
  };
  if (provider === 'openai') {
    return {
      ...base,
      max_completion_tokens: maxTokens,
      ...(env.OPENAI_REASONING_EFFORT && !opts.noReasoning ? { reasoning_effort: env.OPENAI_REASONING_EFFORT } : {}),
    };
  }
  return { ...base, max_tokens: maxTokens, temperature: 0.4 };
}

/** Сравнение строк за постоянное время (защита токена от подбора по времени ответа). */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}

export function corsHeaders(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!origin || !allowed.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** Проверка и очистка тела запроса от приложения. Возвращает { error } или { messages, tools, provider }. */
export function validateBody(body) {
  if (!body || typeof body !== 'object') return { error: 'Тело запроса должно быть JSON-объектом' };
  const { messages, tools, provider } = body;
  if (provider != null && typeof provider !== 'string') return { error: 'Недопустимый провайдер' };
  if (!Array.isArray(messages) || !messages.length) return { error: 'Нужен непустой массив messages' };
  if (messages.length > MAX_MESSAGES) return { error: 'Слишком много сообщений' };
  const clean = [];
  for (const m of messages) {
    if (!m || !ROLES.has(m.role)) return { error: 'Недопустимая роль сообщения' };
    if (m.content != null && (typeof m.content !== 'string' || m.content.length > MAX_CONTENT)) return { error: 'Недопустимое содержимое сообщения' };
    const out = { role: m.role, content: m.content ?? null };
    if (m.role === 'tool') {
      if (typeof m.tool_call_id !== 'string') return { error: 'tool без tool_call_id' };
      out.tool_call_id = m.tool_call_id;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      out.tool_calls = m.tool_calls.slice(0, 8).map((c) => ({
        id: String(c.id),
        type: 'function',
        function: { name: String(c.function?.name ?? ''), arguments: String(c.function?.arguments ?? '{}') },
      }));
    }
    clean.push(out);
  }
  let cleanTools;
  if (tools != null) {
    if (!Array.isArray(tools) || tools.length > MAX_TOOLS) return { error: 'Недопустимый список инструментов' };
    cleanTools = [];
    for (const t of tools) {
      const name = t?.function?.name;
      if (t?.type !== 'function' || typeof name !== 'string' || !/^[a-z_]{1,48}$/.test(name)) return { error: 'Недопустимое описание инструмента' };
      cleanTools.push({
        type: 'function',
        function: { name, description: String(t.function.description ?? '').slice(0, 400), parameters: t.function.parameters ?? { type: 'object', properties: {} } },
      });
    }
  }
  return { messages: clean, tools: cleanTools, provider: provider ?? undefined };
}

// Простое ограничение частоты в пределах одного экземпляра воркера (не строгая гарантия).
const hits = new Map();
export function rateLimited(key, limit, now = Date.now()) {
  const windowMs = 60_000;
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > limit;
}

/* Суточный предел запросов к платному API — защита бюджета на стороне сервера.
   С привязкой KV (USAGE) счётчик общий для всех экземпляров; без неё — в памяти экземпляра. */
const daily = { day: '', count: 0 };
export async function dailyLimitReached(env, now = new Date()) {
  const limit = Number(env.DAILY_REQUEST_LIMIT || 300);
  const day = now.toISOString().slice(0, 10);
  if (env.USAGE?.get && env.USAGE?.put) {
    const key = `requests:${day}`;
    const count = Number((await env.USAGE.get(key)) || 0) + 1;
    await env.USAGE.put(key, String(count), { expirationTtl: 3 * 86400 });
    return count > limit;
  }
  if (daily.day !== day) {
    daily.day = day;
    daily.count = 0;
  }
  daily.count += 1;
  return daily.count > limit;
}
export function __resetDaily() {
  daily.day = '';
  daily.count = 0;
  hits.clear();
  memCost.month = '';
  memCost.micro = 0;
}

/* Денежный бюджет сервера в месяц (MONTHLY_BUDGET_USD). Счёт в микродолларах по usage из ответа провайдера. */
const memCost = { month: '', micro: 0 };
export async function monthSpentUsd(env, now = new Date()) {
  const month = now.toISOString().slice(0, 7);
  if (env.USAGE?.get) return Number((await env.USAGE.get(`cost:${month}`)) || 0) / 1e6;
  return memCost.month === month ? memCost.micro / 1e6 : 0;
}
export async function addSpend(env, usd, now = new Date()) {
  const month = now.toISOString().slice(0, 7);
  const micro = Math.ceil(usd * 1e6);
  if (env.USAGE?.get && env.USAGE?.put) {
    const cur = Number((await env.USAGE.get(`cost:${month}`)) || 0);
    await env.USAGE.put(`cost:${month}`, String(cur + micro), { expirationTtl: 62 * 86400 });
    return;
  }
  if (memCost.month !== month) {
    memCost.month = month;
    memCost.micro = 0;
  }
  memCost.micro += micro;
}
export async function requestsToday(env, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  if (env.USAGE?.get) return Number((await env.USAGE.get(`requests:${day}`)) || 0);
  return daily.day === day ? daily.count : 0;
}
const budgetUsd = (env) => Number(env.MONTHLY_BUDGET_USD ?? 5);

async function authorize(request, env, cors) {
  if (!cors) return json(403, { error: 'Источник запроса не разрешён' });
  if (!env.ACCESS_TOKEN) return json(500, { error: 'Сервер не настроен: нет ACCESS_TOKEN' }, cors);
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!safeEqual(token, env.ACCESS_TOKEN)) return json(401, { error: 'Неверный токен доступа' }, cors);
  // Без постоянного хранилища счётчики живут в одном экземпляре — бюджет не гарантирован. Можно запретить так работать.
  if (env.REQUIRE_KV === '1' && !env.USAGE?.get) return json(500, { error: 'Сервер не настроен: нет хранилища лимитов (KV USAGE)' }, cors);
  return null;
}

export async function handle(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const cors = corsHeaders(origin, env);

  if (request.method === 'OPTIONS') return cors ? new Response(null, { status: 204, headers: cors }) : new Response(null, { status: 403 });

  if (request.method === 'GET' && url.pathname.endsWith('/health')) {
    const ready = configuredProviders(env);
    const def = pickProvider(undefined, env).provider ?? null;
    const providers = Object.fromEntries(
      Object.keys(PROVIDERS).map((id) => [
        id,
        { configured: ready.includes(id), model: modelCache.get(id)?.list[0] ?? modelCandidates(id, env)[0], candidates: modelCandidates(id, env) },
      ]),
    );
    return json(
      200,
      {
        ok: true,
        providers,
        defaultProvider: def,
        // Совместимость с прежней версией приложения:
        keyConfigured: ready.length > 0,
        model: def ? providers[def].model : null,
        limits: {
          maxTokens: Number(env.MAX_TOKENS || 700),
          perMinute: Number(env.RATE_LIMIT_PER_MIN || 30),
          perDay: Number(env.DAILY_REQUEST_LIMIT || 300),
          monthlyBudgetUsd: budgetUsd(env),
          persistent: Boolean(env.USAGE?.get),
        },
      },
      cors || {},
    );
  }

  // Расход сервера — только с токеном приложения.
  if (request.method === 'GET' && url.pathname.endsWith('/usage')) {
    const denied = await authorize(request, env, cors);
    if (denied) return denied;
    return json(
      200,
      {
        month: new Date().toISOString().slice(0, 7),
        spentUsd: Math.round((await monthSpentUsd(env)) * 1e4) / 1e4,
        budgetUsd: budgetUsd(env),
        requestsToday: await requestsToday(env),
        dailyLimit: Number(env.DAILY_REQUEST_LIMIT || 300),
        persistent: Boolean(env.USAGE?.get),
      },
      cors,
    );
  }

  if (request.method !== 'POST') return json(405, { error: 'Метод не поддерживается' }, cors || {});
  const denied = await authorize(request, env, cors);
  if (denied) return denied;

  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  if (rateLimited(ip, Number(env.RATE_LIMIT_PER_MIN || 30))) return json(429, { error: 'Слишком много запросов, подождите минуту' }, cors);

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json(413, { error: 'Запрос слишком большой' }, cors);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: 'Некорректный JSON' }, cors);
  }
  const v = validateBody(body);
  if (v.error) return json(400, { error: v.error }, cors);

  const picked = pickProvider(v.provider, env);
  if (picked.error) return json(v.provider ? 400 : 500, { error: picked.error }, cors);
  const provider = picked.provider;
  const p = PROVIDERS[provider];

  const budget = budgetUsd(env);
  if (budget > 0 && (await monthSpentUsd(env)) >= budget) return json(429, { error: 'Месячный бюджет сервера исчерпан' }, cors);
  if (await dailyLimitReached(env)) return json(429, { error: 'Суточный лимит запросов сервера исчерпан' }, cors);

  // Модель: первая доступная из списка. Если провайдер не принял модель или параметр — следующая попытка.
  const models = await resolveModels(provider, env, fetchImpl);
  let upstream;
  let model = models[0];
  let noReasoning = false;
  for (let attempt = 0, i = 0; attempt < 4 && i < models.length; attempt++) {
    model = models[i];
    upstream = await fetchImpl(p.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env[p.keyEnv]}` },
      body: JSON.stringify(upstreamBody(provider, env, v, model, { noReasoning })),
    });
    if (upstream.ok || (upstream.status !== 400 && upstream.status !== 404)) break;
    const err = String((await upstream.clone().json().catch(() => null))?.error?.message ?? '').toLowerCase();
    if (!noReasoning && err.includes('reasoning')) noReasoning = true;
    else if (upstream.status === 404 || err.includes('model')) {
      i += 1;
      modelCache.delete(provider);
    } else break;
  }

  if (!upstream.ok) {
    const status = upstream.status === 429 ? 429 : 502;
    // Текст ошибки провайдера не пересылаем целиком — в нём могут быть служебные детали.
    return json(status, { error: upstream.status === 429 ? `Лимит ${p.label} исчерпан` : `Ошибка ${p.label} (${upstream.status})`, provider }, cors);
  }
  const data = await upstream.json();
  const msg = data?.choices?.[0]?.message ?? {};
  const u = data?.usage ?? {};
  await addSpend(env, costUsd(priceFor(provider, String(data?.model || model), env), u));
  return json(
    200,
    {
      choices: [{ message: { role: 'assistant', content: msg.content ?? null, ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) } }],
      model: data?.model,
      provider,
      usage: { prompt_tokens: Number(u.prompt_tokens) || 0, completion_tokens: Number(u.completion_tokens) || 0 },
    },
    cors,
  );
}
