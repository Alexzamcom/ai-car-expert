import { createStore, uid } from './store';
import { settingsStore, serviceStore, nextServiceEstimate, vehicleName, SERVICE_CATEGORIES } from './state';
import { searchArticles, articleToText } from './manualData';
import { DTC_RE, decodeDtc, dtcSummary } from './dtc';
import { speak } from './speech';
import { TOOLS, runTool } from './tools';
import { isVehicleControlRequest, VEHICLE_CONTROL_REPLY } from './vehicleGuard';
import { parseCommand } from './voiceCommands';
import { factsForPrompt, searchFacts, STATUS_LABEL } from './knowledge';
import { navStore } from './nav';
import { playerStore } from './player';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Откуда ответ: Grok (через ваш сервер) или встроенная база (офлайн). */
  source?: 'ai' | 'local' | 'error';
  articleId?: string;
  /** Выполненные действия (маршрут, музыка…) — показываются под ответом. */
  actions?: string[];
  time: number;
}

export const chatStore = createStore<ChatMessage[]>([], 'chat');
export const chatBusyStore = createStore(false);

export { isVehicleControlRequest, VEHICLE_CONTROL_REPLY } from './vehicleGuard';

/* ---------- Системный промпт ---------- */

export function systemPrompt(): string {
  const s = settingsStore.get();
  const v = s.vehicle;
  const records = serviceStore.get();
  const next = nextServiceEstimate(records, v);
  const nav = navStore.get();
  const player = playerStore.get();
  return [
    'Ты — голосовой помощник AI Car Expert в автомобиле. Тебя слушает водитель во время движения.',
    'Отвечай на языке пользователя (русский или украинский). Коротко: 1–3 предложения, без списков и разметки, если не просят подробностей. Текст будет озвучен.',
    'Можешь управлять приложением через инструменты: навигация, поиск АЗС по пути, радио, разделы, сторонние приложения. Если пользователь просит действие — вызывай инструмент, а не описывай его.',
    'Управлять системами автомобиля (климат, двери, окна, свет, двигатель) ты НЕ можешь: интеграции нет. Не делай вид, что выполнил такую команду; объясни, какой кнопкой это сделать, если знаешь.',
    'Об автомобиле владельца опирайся на базу знаний ниже. У каждого факта есть статус: owner — подтвердил владелец; documented — по документу; typical — типично для модели, НЕ проверено для этого автомобиля; community — опыт владельцев, неофициально. Если используешь факт со статусом typical или community, обязательно скажи, что это не подтверждено для этого автомобиля. Если данных нет — честно скажи, что не знаешь, и не придумывай.',
    'Безопасность важнее всего: не отвлекай водителя, при признаках опасной неисправности советуй остановиться в безопасном месте.',
    '',
    `Автомобиль: ${vehicleName(v) || 'не указан'}${v.engine ? `, двигатель ${v.engine}` : ''}${v.odometerKm != null ? `, пробег ${v.odometerKm} км` : ''}.`,
    next ? `Следующее ТО: ${next.dueDate.toLocaleDateString('ru-RU')}${next.dueKm ? ` или ${next.dueKm} км` : ''}.` : 'Данных о последнем ТО нет.',
    records.length
      ? `Последние работы: ${records
          .slice(0, 6)
          .map((r) => `${r.date} ${SERVICE_CATEGORIES[r.category]}${r.title ? ` (${r.title})` : ''}${r.odometerKm ? `, ${r.odometerKm} км` : ''}`)
          .join('; ')}.`
      : '',
    nav.dest ? `Сейчас построен маршрут до: ${nav.dest.name} (${nav.status}).` : '',
    player.current ? `Сейчас ${player.playing ? 'играет' : 'на паузе'}: ${player.current.title}.` : '',
    `Время: ${new Date().toLocaleString('ru-RU')}.`,
    '',
    'База знаний:',
    factsForPrompt() || '(пусто)',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/* ---------- Обмен с сервером ---------- */

interface ApiToolCall {
  id: string;
  type?: 'function';
  function: { name: string; arguments: string };
}
interface ApiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ApiToolCall[];
  tool_call_id?: string;
}

/** Разбор ответа сервера: формат Chat Completions или упрощённый { reply }. */
export function parseServerReply(data: unknown): ApiMessage {
  const d = data as { choices?: { message?: ApiMessage }[]; message?: ApiMessage; reply?: string; text?: string; content?: string };
  const m = d.choices?.[0]?.message ?? d.message;
  if (m) return { role: 'assistant', content: m.content ?? null, tool_calls: m.tool_calls?.length ? m.tool_calls : undefined };
  const text = d.reply ?? d.text ?? d.content;
  if (typeof text === 'string') return { role: 'assistant', content: text };
  throw new Error('Неожиданный формат ответа сервера');
}

async function callServer(messages: ApiMessage[]): Promise<ApiMessage> {
  const { aiEndpoint, aiToken } = settingsStore.get();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await fetch(aiEndpoint, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(aiToken ? { Authorization: `Bearer ${aiToken}` } : {}),
      },
      body: JSON.stringify({ messages, tools: TOOLS, tool_choice: 'auto' }),
    });
    if (res.status === 401 || res.status === 403) throw new Error('сервер отклонил токен доступа');
    if (res.status === 429) throw new Error('превышен лимит запросов');
    if (!res.ok) throw new Error(`сервер ответил ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('application/json')) return parseServerReply(await res.json());
    return { role: 'assistant', content: (await res.text()).trim() };
  } finally {
    clearTimeout(timer);
  }
}

/** Диалог с моделью с выполнением инструментов (до 4 раундов). */
async function askRemote(history: ChatMessage[]): Promise<{ text: string; actions: string[] }> {
  const messages: ApiMessage[] = [
    { role: 'system', content: systemPrompt() },
    ...history
      .filter((m) => m.source !== 'error')
      .slice(-16)
      .map((m) => ({ role: m.role, content: m.text }) as ApiMessage),
  ];
  const actions: string[] = [];
  for (let round = 0; round < 4; round++) {
    const reply = await callServer(messages);
    if (!reply.tool_calls?.length) return { text: reply.content?.trim() || 'Готово.', actions };
    messages.push(reply);
    for (const call of reply.tool_calls) {
      const result = await runTool(call.function.name, call.function.arguments);
      actions.push(result.text);
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return { text: actions[actions.length - 1] ?? 'Готово.', actions };
}

/* ---------- Офлайн-ответы ---------- */

export function answerLocally(text: string): { text: string; articleId?: string } {
  if (isVehicleControlRequest(text)) return { text: VEHICLE_CONTROL_REPLY };

  const dtc = text.match(DTC_RE);
  if (dtc) return { text: dtcSummary(decodeDtc(dtc[1] + dtc[2])) };

  // \b в JS не работает с кириллицей — границы слова задаём явно.
  if (/((^|[^а-яё])то([^а-яё]|$)|техобслуж|обслуживан|замен[аиу] масла)/i.test(text) && /(когда|скоро|следующ|сколько)/i.test(text)) {
    const s = settingsStore.get();
    const est = nextServiceEstimate(serviceStore.get(), s.vehicle);
    if (!est) return { text: 'В истории обслуживания нет записей о плановом ТО. Добавьте запись в разделе «Сервис», и я посчитаю срок следующего.' };
    const parts = [`Следующее ТО — ориентировочно ${est.dueDate.toLocaleDateString('ru-RU')}`];
    if (est.dueKm != null) parts.push(`или при пробеге ${est.dueKm.toLocaleString('ru-RU')} км`);
    if (est.kmLeft != null) parts.push(`(осталось около ${Math.max(0, est.kmLeft).toLocaleString('ru-RU')} км)`);
    return { text: parts.join(' ') + '.' };
  }

  const [fact] = searchFacts(text, 1);
  if (fact) {
    const note = fact.status === 'owner' || fact.status === 'documented' ? '' : ` (${STATUS_LABEL[fact.status].toLowerCase()})`;
    return { text: `${fact.title}${note}. ${fact.text}` };
  }

  const [best] = searchArticles(text, 1);
  if (best && text.trim().length > 2) {
    return { text: `${best.title}. ${best.summary}\n\n${articleToText(best)}`, articleId: best.id };
  }

  return {
    text: 'Grok не подключён, поэтому отвечаю из встроенной базы. Могу построить маршрут, включить радио, расшифровать код ошибки, рассказать о функциях вашего автомобиля или напомнить о ТО. Подключение Grok — в настройках.',
  };
}

/* ---------- Публичный API ---------- */

export function isRemoteConfigured() {
  return Boolean(settingsStore.get().aiEndpoint);
}

export async function sendToAssistant(text: string, opts: { speakReply?: boolean } = {}) {
  const clean = text.trim();
  if (!clean || chatBusyStore.get()) return;
  const userMsg: ChatMessage = { id: uid(), role: 'user', text: clean, time: Date.now() };
  chatStore.set((l) => [...l, userMsg].slice(-100));
  chatBusyStore.set(true);

  const { speakReplies, speechLang } = settingsStore.get();
  let reply: ChatMessage;
  try {
    if (isVehicleControlRequest(clean)) {
      reply = { id: uid(), role: 'assistant', text: VEHICLE_CONTROL_REPLY, source: 'local', time: Date.now() };
    } else if (isRemoteConfigured() && navigator.onLine) {
      const r = await askRemote(chatStore.get());
      reply = { id: uid(), role: 'assistant', text: r.text, actions: r.actions, source: 'ai', time: Date.now() };
    } else {
      // Без Grok: сначала пробуем распознать команду (маршрут, радио, разделы), затем — базу знаний.
      const cmd = parseCommand(clean);
      if (cmd.kind === 'tool') {
        const r = await runTool(cmd.name, cmd.args);
        reply = { id: uid(), role: 'assistant', text: r.text, actions: r.ok ? [r.text] : undefined, source: 'local', time: Date.now() };
      } else {
        const local = answerLocally(clean);
        reply = { id: uid(), role: 'assistant', ...local, source: 'local', time: Date.now() };
      }
    }
  } catch (e) {
    const local = answerLocally(clean);
    const why = e instanceof Error && e.name !== 'AbortError' ? e.message : 'превышено время ожидания';
    reply = {
      id: uid(),
      role: 'assistant',
      text: `Grok недоступен (${why}). Ответ из встроенной базы:\n\n${local.text}`,
      articleId: local.articleId,
      source: 'local',
      time: Date.now(),
    };
  }
  chatStore.set((l) => [...l, reply].slice(-100));
  chatBusyStore.set(false);
  if (opts.speakReply ?? speakReplies) speak(reply.text, speechLang, { onEnd: () => afterSpoken() });
  else afterSpoken();
}

/** Режим разговора: после ответа снова слушаем (подключается из voice.ts). */
let afterSpokenHook: (() => void) | null = null;
export function setAfterSpokenHook(fn: (() => void) | null) {
  afterSpokenHook = fn;
}
function afterSpoken() {
  afterSpokenHook?.();
}

export function clearChat() {
  chatStore.set([]);
}

