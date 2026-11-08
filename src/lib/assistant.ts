import { createStore, uid } from './store';
import { settingsStore, serviceStore, nextServiceEstimate, vehicleName, SERVICE_CATEGORIES } from './state';
import { searchArticles, articleToText } from './manualData';
import { DTC_RE, decodeDtc, dtcSummary } from './dtc';
import { speak } from './speech';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Откуда ответ: внешний AI-сервис или встроенная база (офлайн). */
  source?: 'ai' | 'local' | 'error';
  articleId?: string;
  time: number;
}

export const chatStore = createStore<ChatMessage[]>([], 'chat');
export const chatBusyStore = createStore(false);

/** Запросы к системам автомобиля, которые пока нельзя выполнить. */
const VEHICLE_CONTROL_RE =
  /(климат|кондиционер|печк|отоплен|обогрев|подогрев|вентиляц|температур[уы] в салоне|двер|замок|замк|заблокир|разблокир|окн|стекл|багажник|капот|фар|габарит|зеркал|люк|заряд[кa] (?:авто|машин)|завед[иу]|запуст[иь] двигател|сигнализац)/i;

export function isVehicleControlRequest(text: string) {
  return VEHICLE_CONTROL_RE.test(text) && /(включ|выключ|откр|закр|заблок|разблок|постав|сделай|подними|опусти|запуст|завед|прогре|теплее|холоднее)/i.test(text);
}

export const VEHICLE_CONTROL_REPLY =
  'Управление системами автомобиля (климат, двери, окна, свет и т. д.) пока недоступно: AI Car Expert ещё не подключён к автомобилю. Эти функции появятся после реальной интеграции.';

function vehicleContext() {
  const s = settingsStore.get();
  const records = serviceStore.get();
  return {
    vehicle: {
      name: vehicleName(s.vehicle) || null,
      vin: s.vehicle.vin || null,
      fuel: s.vehicle.fuel,
      odometerKm: s.vehicle.odometerKm,
    },
    recentService: records.slice(0, 10).map((r) => ({
      date: r.date,
      odometerKm: r.odometerKm,
      type: SERVICE_CATEGORIES[r.category],
      title: r.title,
    })),
    vehicleIntegration: false,
    locale: s.speechLang,
  };
}

async function askRemote(history: ChatMessage[]): Promise<string> {
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
      body: JSON.stringify({
        messages: history
          .filter((m) => m.source !== 'error')
          .slice(-20)
          .map((m) => ({ role: m.role, content: m.text })),
        context: vehicleContext(),
      }),
    });
    if (!res.ok) throw new Error(`Сервер ответил ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('application/json')) {
      const data = (await res.json()) as { reply?: string; text?: string; content?: string; message?: string };
      const reply = data.reply ?? data.text ?? data.content ?? data.message;
      if (!reply) throw new Error('Пустой ответ сервера');
      return reply;
    }
    return (await res.text()).trim();
  } finally {
    clearTimeout(timer);
  }
}

/** Ответ без внешнего AI: код ошибки, ТО, руководство. */
export function answerLocally(text: string): { text: string; articleId?: string } {
  if (isVehicleControlRequest(text)) return { text: VEHICLE_CONTROL_REPLY };

  const dtc = text.match(DTC_RE);
  if (dtc) return { text: dtcSummary(decodeDtc(dtc[1] + dtc[2])) };

  // \b в JS не работает с кириллицей — границы слова задаём явно.
  if (/((^|[^а-яё])то([^а-яё]|$)|техобслуж|обслуживан|замен[аиу] масла)/i.test(text) && /(когда|скоро|следующ|сколько)/i.test(text)) {
    const s = settingsStore.get();
    const est = nextServiceEstimate(serviceStore.get(), s.vehicle);
    if (!est) return { text: 'В истории обслуживания нет записей о плановом ТО. Добавьте запись в разделе «История обслуживания», и я посчитаю срок следующего.' };
    const parts = [`Следующее ТО — ориентировочно ${est.dueDate.toLocaleDateString('ru-RU')}`];
    if (est.dueKm != null) parts.push(`или при пробеге ${est.dueKm.toLocaleString('ru-RU')} км`);
    if (est.kmLeft != null) parts.push(`(осталось около ${Math.max(0, est.kmLeft).toLocaleString('ru-RU')} км)`);
    return { text: parts.join(' ') + '.' };
  }

  const [best] = searchArticles(text, 1);
  if (best && text.trim().length > 2) {
    return { text: `${best.title}. ${best.summary}\n\n${articleToText(best)}`, articleId: best.id };
  }

  return {
    text: 'AI-сервис не подключён, поэтому я отвечаю из встроенной базы. Сейчас могу расшифровать код ошибки (например, «P0420»), подсказать по индикаторам на панели, найти статью в руководстве или напомнить о ТО. Адрес AI-сервиса задаётся в настройках.',
  };
}

export async function sendToAssistant(text: string) {
  const clean = text.trim();
  if (!clean || chatBusyStore.get()) return;
  const userMsg: ChatMessage = { id: uid(), role: 'user', text: clean, time: Date.now() };
  chatStore.set((l) => [...l, userMsg].slice(-100));
  chatBusyStore.set(true);

  const { aiEndpoint, speakReplies, speechLang } = settingsStore.get();
  let reply: ChatMessage;
  try {
    if (isVehicleControlRequest(clean)) {
      reply = { id: uid(), role: 'assistant', text: VEHICLE_CONTROL_REPLY, source: 'local', time: Date.now() };
    } else if (aiEndpoint && navigator.onLine) {
      const answer = await askRemote(chatStore.get());
      reply = { id: uid(), role: 'assistant', text: answer, source: 'ai', time: Date.now() };
    } else {
      const local = answerLocally(clean);
      reply = { id: uid(), role: 'assistant', ...local, source: 'local', time: Date.now() };
    }
  } catch (e) {
    const local = answerLocally(clean);
    const why = e instanceof Error && e.name !== 'AbortError' ? e.message : 'превышено время ожидания';
    reply = {
      id: uid(),
      role: 'assistant',
      text: `AI-сервис недоступен (${why}). Ответ из встроенной базы:\n\n${local.text}`,
      articleId: local.articleId,
      source: 'local',
      time: Date.now(),
    };
  }
  chatStore.set((l) => [...l, reply].slice(-100));
  chatBusyStore.set(false);
  if (speakReplies) speak(reply.text, speechLang);
}

export function clearChat() {
  chatStore.set([]);
}
