/* Запросы к картографическим сервисам: тайм-аут, понятные ошибки, отмена. */

export type NetErrorKind = 'offline' | 'timeout' | 'http' | 'rate-limit' | 'network' | 'bad-response';

export class NetError extends Error {
  constructor(
    public kind: NetErrorKind,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = 'NetError';
  }
}

export function isAbort(e: unknown, signal?: AbortSignal) {
  return (e as Error)?.name === 'AbortError' && !!signal?.aborted;
}

/** GET/POST с тайм-аутом. Отмена снаружи (signal) пробрасывается как AbortError. */
export async function fetchJson<T>(url: string, opts: { timeoutMs: number; signal?: AbortSignal; init?: RequestInit; service: string }): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new NetError('offline', 'Нет подключения к интернету');
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener('abort', onAbort);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, opts.timeoutMs);
  try {
    const res = await fetch(url, { ...opts.init, signal: ctrl.signal });
    if (res.status === 429) throw new NetError('rate-limit', `${opts.service}: слишком много запросов, подождите`, 429);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new NetError(res.ok ? 'bad-response' : 'http', `${opts.service}: ответ ${res.status}`, res.status);
    }
    if (!res.ok) {
      // OSRM отвечает 400 с телом {code: 'NoRoute'…} — тело важнее статуса.
      (body as { __status?: number }).__status = res.status;
      if (res.status >= 500) throw new NetError('http', `${opts.service}: сервер недоступен (${res.status})`, res.status);
    }
    return body as T;
  } catch (e) {
    if (e instanceof NetError) throw e;
    if (opts.signal?.aborted) throw e; // отмена пользователем
    if (timedOut) throw new NetError('timeout', `${opts.service} не ответил за ${Math.round(opts.timeoutMs / 1000)} с`);
    throw new NetError('network', `${opts.service} недоступен`);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
