// Точка входа Cloudflare Worker: пробки TomTom для AI Car Expert.
import { handle } from './handler.js';

export default {
  fetch(request, env, ctx) {
    return handle(request, env, ctx).catch(() =>
      new Response(JSON.stringify({ error: 'Внутренняя ошибка сервера пробок' }), { status: 500, headers: { 'Content-Type': 'application/json' } }),
    );
  },
};
