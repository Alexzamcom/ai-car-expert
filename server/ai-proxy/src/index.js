// Точка входа Cloudflare Worker: ИИ-прокси (OpenAI / Grok).
import { handle } from './handler.js';

export default {
  fetch(request, env) {
    return handle(request, env).catch(() =>
      new Response(JSON.stringify({ error: 'Внутренняя ошибка прокси' }), { status: 500, headers: { 'Content-Type': 'application/json' } }),
    );
  },
};
