// Прокси AI Car Expert → xAI Grok (Chat Completions).
// Ключ xAI хранится только в секрете сервера (XAI_API_KEY) и никогда не попадает в браузер.
// Доступ: только с разрешённых Origin и с токеном доступа приложения (ACCESS_TOKEN).

const XAI_URL = 'https://api.x.ai/v1/chat/completions';
const MAX_BODY = 96 * 1024;
const MAX_MESSAGES = 40;
const MAX_CONTENT = 24000; // системный промпт с базой знаний бывает длинным
const MAX_TOOLS = 24;
const ROLES = new Set(['system', 'user', 'assistant', 'tool']);

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

/** Проверка и очистка тела запроса от приложения. Возвращает { error } или { messages, tools }. */
export function validateBody(body) {
  if (!body || typeof body !== 'object') return { error: 'Тело запроса должно быть JSON-объектом' };
  const { messages, tools } = body;
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
  return { messages: clean, tools: cleanTools };
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

export async function handle(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const cors = corsHeaders(origin, env);

  if (request.method === 'OPTIONS') return cors ? new Response(null, { status: 204, headers: cors }) : new Response(null, { status: 403 });

  if (request.method === 'GET' && url.pathname.endsWith('/health')) {
    return json(200, { ok: true, model: env.GROK_MODEL || 'grok-4', keyConfigured: Boolean(env.XAI_API_KEY) }, cors || {});
  }

  if (request.method !== 'POST') return json(405, { error: 'Метод не поддерживается' }, cors || {});
  if (!cors) return json(403, { error: 'Источник запроса не разрешён' });
  if (!env.XAI_API_KEY || !env.ACCESS_TOKEN) return json(500, { error: 'Сервер не настроен: нет XAI_API_KEY или ACCESS_TOKEN' }, cors);

  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!safeEqual(token, env.ACCESS_TOKEN)) return json(401, { error: 'Неверный токен доступа' }, cors);

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

  const upstream = await fetchImpl(XAI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.XAI_API_KEY}` },
    body: JSON.stringify({
      model: env.GROK_MODEL || 'grok-4',
      messages: v.messages,
      ...(v.tools?.length ? { tools: v.tools, tool_choice: 'auto' } : {}),
      max_tokens: Number(env.MAX_TOKENS || 700),
      temperature: 0.4,
    }),
  });

  if (!upstream.ok) {
    const status = upstream.status === 401 || upstream.status === 403 ? 502 : upstream.status === 429 ? 429 : 502;
    // Текст ошибки xAI не пересылаем целиком — в нём могут быть служебные детали.
    return json(status, { error: upstream.status === 429 ? 'Лимит xAI исчерпан' : `Ошибка xAI (${upstream.status})` }, cors);
  }
  const data = await upstream.json();
  const msg = data?.choices?.[0]?.message ?? {};
  return json(
    200,
    {
      choices: [{ message: { role: 'assistant', content: msg.content ?? null, ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) } }],
      model: data?.model,
    },
    cors,
  );
}
