import { createStore, uid } from './store';
import { settingsStore, serviceStore, nextServiceEstimate, type AiProvider } from './state';
import { searchArticles, articleToText } from './manualData';
import { DTC_RE, decodeDtc, dtcSummary } from './dtc';
import { speak } from './speech';
import { TOOLS, runTool, serviceStatusText } from './tools';
import { isVehicleControlRequest, VEHICLE_CONTROL_REPLY, VEHICLE_CONTROL_REPLY_UK } from './vehicleGuard';
import { parseCommand } from './voiceCommands';
import { factsForPrompt, searchFacts, STATUS_LABEL } from './knowledge';
import { buildContext } from './ai/context';
import { cloudBlock, recordUsage, PROVIDER_LABEL, type CloudBlock } from './ai/usage';
import { L } from './i18n';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Откуда ответ: облачный ИИ (через ваш сервер) или локально (команды, встроенная база). */
  source?: 'ai' | 'local' | 'error';
  /** Какой облачный провайдер ответил. */
  provider?: AiProvider;
  articleId?: string;
  /** Выполненные действия (маршрут, музыка…) — показываются под ответом. */
  actions?: string[];
  time: number;
}

export const chatStore = createStore<ChatMessage[]>([], 'chat');
export const chatBusyStore = createStore(false);

export { isVehicleControlRequest, VEHICLE_CONTROL_REPLY } from './vehicleGuard';

/* ---------- Системный промпт ---------- */

export function systemPrompt(now = new Date()): string {
  const uk = settingsStore.get().speechLang.startsWith('uk');
  return [
    'Ты — голосовой помощник AI Car Expert в автомобиле. Тебя слушает водитель во время движения; ответ будет озвучен.',
    `Отвечай на языке водителя (${uk ? 'по умолчанию українською' : 'по умолчанию по-русски'}; если вопрос на другом из этих языков — на нём).`,
    'Ответ — 1–2 коротких предложения, до 30 слов, без списков, разметки, ссылок и эмодзи. Подробно — только если водитель прямо попросил.',
    'Если водитель просит действие — сразу вызывай инструмент (маршрут, остановка, поиск, радио, раздел, напоминание), а не описывай его. После инструмента — одна фраза о результате.',
    'Время в пути — без учёта пробок; не выдумывай пробки, цены, часы работы и адреса. Если данных нет — так и скажи.',
    'Управлять системами автомобиля (климат, двери, окна, свет, двигатель) ты НЕ можешь: интеграции нет. Не делай вид, что выполнил такую команду.',
    'Записывай работы в журнал обслуживания только когда водитель прямо сказал, что работа сделана.',
    'Факты об автомобиле — из базы знаний ниже. Статусы: owner — подтвердил владелец; documented — по документу; typical — типично для модели, не проверено для этого автомобиля; community — опыт владельцев. Для typical и community скажи, что это не подтверждено.',
    'Безопасность важнее всего: не отвлекай водителя; при признаках опасной неисправности советуй остановиться в безопасном месте.',
    '',
    'Текущее состояние:',
    buildContext(now),
    '',
    'База знаний:',
    factsForPrompt() || '(пусто)',
  ].join('\n');
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

type ServerReply = ApiMessage & { usage?: { prompt_tokens?: number; completion_tokens?: number }; provider?: AiProvider };

async function callServer(messages: ApiMessage[]): Promise<ServerReply> {
  const { aiEndpoint, aiToken, aiProvider } = settingsStore.get();
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
      body: JSON.stringify({ provider: aiProvider, messages, tools: TOOLS, tool_choice: 'auto' }),
    });
    if (res.status === 401 || res.status === 403) throw new Error('сервер отклонил токен доступа');
    const type = res.headers.get('content-type') ?? '';
    const data = type.includes('application/json') ? await res.json().catch(() => null) : null;
    const serverError = (data as { error?: string } | null)?.error;
    if (res.status === 429) throw new Error(serverError ?? 'превышен лимит запросов');
    if (!res.ok) throw new Error(serverError ?? `сервер ответил ${res.status}`);
    if (data) {
      const d = data as { usage?: ServerReply['usage']; provider?: AiProvider };
      return { ...parseServerReply(data), usage: d.usage, provider: d.provider };
    }
    return { role: 'assistant', content: (await res.text()).trim() };
  } finally {
    clearTimeout(timer);
  }
}

/** Диалог с моделью с выполнением инструментов (до 4 раундов). */
async function askRemote(history: ChatMessage[]): Promise<{ text: string; actions: string[]; provider: AiProvider }> {
  const messages: ApiMessage[] = [
    { role: 'system', content: systemPrompt() },
    ...history
      .filter((m) => m.source !== 'error')
      .slice(-16)
      .map((m) => ({ role: m.role, content: m.text }) as ApiMessage),
  ];
  const actions: string[] = [];
  let provider = settingsStore.get().aiProvider;
  for (let round = 0; round < 4; round++) {
    // Каждый раунд — отдельный платный запрос: проверяем лимиты перед каждым.
    if (round > 0 && cloudBlock()) break;
    const reply = await callServer(messages);
    provider = reply.provider ?? provider;
    recordUsage(provider, reply.usage, JSON.stringify(messages).length);
    if (!reply.tool_calls?.length) return { text: reply.content?.trim() || L('Готово.', 'Готово.'), actions, provider };
    messages.push({ role: 'assistant', content: reply.content, tool_calls: reply.tool_calls });
    for (const call of reply.tool_calls) {
      const result = await runTool(call.function.name, call.function.arguments);
      actions.push(result.text);
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return { text: actions[actions.length - 1] ?? L('Готово.', 'Готово.'), actions, provider };
}

/* ---------- Офлайн-ответы ---------- */

const BLOCK_NOTE: Record<CloudBlock, [string, string]> = {
  'not-configured': ['Облачный ИИ не подключён', 'Хмарний ШІ не підключено'],
  'local-mode': ['Включён локальный режим', 'Увімкнено локальний режим'],
  offline: ['Нет интернета', 'Немає інтернету'],
  'daily-limit': ['Дневной лимит запросов к ИИ исчерпан', 'Денний ліміт запитів до ШІ вичерпано'],
  budget: ['Месячный бюджет ИИ исчерпан', 'Місячний бюджет ШІ вичерпано'],
};

export function blockNote(b: CloudBlock) {
  return L(...BLOCK_NOTE[b]);
}

export function isServiceQuestion(text: string) {
  // \b в JS не работает с кириллицей — границы слова задаём явно.
  return /((^|[^а-яёіїє])то([^а-яёіїє]|$)|техобслуж|обслуживан|обслуговуван|замін[аиу] мастила|замен[аиу] масла)/i.test(text) && /(когда|коли|скоро|следующ|наступн|сколько|скільки)/i.test(text);
}

export function answerLocally(text: string, block: CloudBlock | null = cloudBlock()): { text: string; articleId?: string } {
  if (isVehicleControlRequest(text)) return { text: L(VEHICLE_CONTROL_REPLY, VEHICLE_CONTROL_REPLY_UK) };

  const dtc = text.match(DTC_RE);
  if (dtc) return { text: dtcSummary(decodeDtc(dtc[1] + dtc[2])) };

  if (isServiceQuestion(text)) {
    const s = settingsStore.get();
    const est = nextServiceEstimate(serviceStore.get(), s.vehicle);
    if (!est) return { text: serviceStatusText() };
    const parts = [L(`Следующее ТО — ориентировочно ${est.dueDate.toLocaleDateString('ru-RU')}`, `Наступне ТО — орієнтовно ${est.dueDate.toLocaleDateString('uk-UA')}`)];
    if (est.dueKm != null) parts.push(L(`или при пробеге ${est.dueKm.toLocaleString('ru-RU')} км`, `або на пробігу ${est.dueKm.toLocaleString('uk-UA')} км`));
    if (est.kmLeft != null) parts.push(L(`(осталось около ${Math.max(0, est.kmLeft).toLocaleString('ru-RU')} км)`, `(залишилось близько ${Math.max(0, est.kmLeft).toLocaleString('uk-UA')} км)`));
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

  const why = block ? blockNote(block) : L('Облачный ИИ недоступен', 'Хмарний ШІ недоступний');
  return {
    text: L(
      `${why}, поэтому отвечаю из встроенной базы. Могу построить маршрут, добавить остановку, включить радио, расшифровать код ошибки, рассказать о вашем автомобиле или напомнить о ТО.`,
      `${why}, тому відповідаю з вбудованої бази. Можу прокласти маршрут, додати зупинку, увімкнути радіо, розшифрувати код помилки, розповісти про ваш автомобіль або нагадати про ТО.`,
    ),
  };
}

/* ---------- Гибридный маршрутизатор ---------- */

export type Route =
  | { kind: 'refuse' }
  | { kind: 'command'; name: string; args: Record<string, unknown> }
  | { kind: 'local' }
  | { kind: 'cloud' };

/** Куда направить запрос. Простое и детерминированное — локально и бесплатно; остальное — облачному ИИ, если он доступен. */
export function decideRoute(text: string, block: CloudBlock | null = cloudBlock()): Route {
  if (isVehicleControlRequest(text)) return { kind: 'refuse' };
  const cmd = parseCommand(text);
  if (cmd.kind === 'tool') return { kind: 'command', name: cmd.name, args: cmd.args };
  if (DTC_RE.test(text) || isServiceQuestion(text)) return { kind: 'local' };
  return block ? { kind: 'local' } : { kind: 'cloud' };
}

/* ---------- Публичный API ---------- */

export function isRemoteConfigured() {
  return Boolean(settingsStore.get().aiEndpoint);
}

/** Текст для озвучивания: без разметки, ссылок и длинных хвостов. */
export function speechText(text: string) {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/[*_#`>]/g, '')
    .trim();
}

export async function sendToAssistant(text: string, opts: { speakReply?: boolean } = {}) {
  const clean = text.trim();
  if (!clean || chatBusyStore.get()) return;
  const userMsg: ChatMessage = { id: uid(), role: 'user', text: clean, time: Date.now() };
  chatStore.set((l) => [...l, userMsg].slice(-100));
  chatBusyStore.set(true);

  const { speakReplies, speechLang } = settingsStore.get();
  let reply: ChatMessage;
  const block = cloudBlock();
  const route = decideRoute(clean, block);
  try {
    if (route.kind === 'refuse') {
      reply = { id: uid(), role: 'assistant', text: L(VEHICLE_CONTROL_REPLY, VEHICLE_CONTROL_REPLY_UK), source: 'local', time: Date.now() };
    } else if (route.kind === 'command') {
      // Простые команды — локально, без платного API.
      const r = await runTool(route.name, route.args);
      reply = { id: uid(), role: 'assistant', text: r.text, actions: r.ok ? [r.text] : undefined, source: 'local', time: Date.now() };
    } else if (route.kind === 'cloud') {
      const r = await askRemote(chatStore.get());
      reply = { id: uid(), role: 'assistant', text: r.text, actions: r.actions, source: 'ai', provider: r.provider, time: Date.now() };
    } else {
      const local = answerLocally(clean, block);
      reply = { id: uid(), role: 'assistant', ...local, source: 'local', time: Date.now() };
    }
  } catch (e) {
    const local = answerLocally(clean, null);
    const why = e instanceof Error && e.name !== 'AbortError' ? e.message : L('превышено время ожидания', 'перевищено час очікування');
    const name = PROVIDER_LABEL[settingsStore.get().aiProvider];
    reply = {
      id: uid(),
      role: 'assistant',
      text: L(`${name} недоступен (${why}). Ответ из встроенной базы:`, `${name} недоступний (${why}). Відповідь із вбудованої бази:`) + `\n\n${local.text}`,
      articleId: local.articleId,
      source: 'local',
      time: Date.now(),
    };
  }
  chatStore.set((l) => [...l, reply].slice(-100));
  chatBusyStore.set(false);
  // Статья справочника целиком не озвучивается — только первая часть.
  const spoken = speechText(reply.articleId ? reply.text.split('\n\n')[0] : reply.text);
  if (opts.speakReply ?? speakReplies) speak(spoken, speechLang, { onEnd: () => afterSpoken() });
  else afterSpoken();
  return reply;
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

