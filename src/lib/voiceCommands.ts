/* Быстрые голосовые команды (работают без сети и без Grok).
   Разбор — чистая функция parseCommand (покрыта тестами), выполнение — через те же
   инструменты, что вызывает Grok. Всё, что не распознано, уходит помощнику. */
import { runTool } from './tools';
import { openSection, toast, settingsStore } from './state';
import { sendToAssistant } from './assistant';
import { isVehicleControlRequest } from './vehicleGuard';
import { speak } from './speech';

export type Command =
  | { kind: 'tool'; name: string; args: Record<string, unknown>; say?: boolean }
  | { kind: 'ask'; text: string };

const SECTION_WORDS: [RegExp, string][] = [
  [/(навигац|карт[ауеы]|мапу|мапа)/, 'navigation'],
  [/(музык|радио|радіо|медиа|медіа|плеер)/, 'media'],
  [/(справочник|руководств|инструкц|довідник|інструкці)/, 'manual'],
  [/(сервис|обслуговуван|обслуживан|истори[юя] то|журнал)/, 'service'],
  [/(диагност|діагност|obd|обд)/, 'diagnostics'],
  [/(помощник|ассистент|помічник|грок|grok|чат)/, 'assistant'],
  [/(приложени|застосунк|додатк)/, 'apps'],
  [/(поездк|поїздк|бортов)/, 'trip'],
  [/(автомобил|машин|авто$|мій автомобіль)/, 'vehicle'],
  [/(настройк|налаштуван)/, 'settings'],
];

const POI_WORDS: [RegExp, string][] = [
  [/(заправк|азс|бензин|заправ)/, 'fuel'],
  [/(кафе|поесть|поїсти|кофе|кава|ресторан)/, 'food'],
  [/(парковк|стоянк|паркінг)/, 'parking'],
  [/(отдых|відпочин|туалет)/, 'rest'],
];

export function normalize(raw: string) {
  return raw.toLowerCase().replace(/ё/g, 'е').replace(/[.,!?«»"]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function parseCommand(raw: string): Command {
  const t = normalize(raw);
  if (!t) return { kind: 'ask', text: raw };

  // Управление системами автомобиля — только честный ответ помощника.
  if (isVehicleControlRequest(t)) return { kind: 'ask', text: raw };

  // Маршрут: «маршрут до …», «поехали в …», «проклади маршрут до …», «їдемо до …»
  const route = t.match(
    /^(?:(?:проложи|построй|прокладі|проклади|побудуй)\s+)?(?:маршрут|поехали|поедем|едем|ехать|їдемо|поїхали|навигаци\w*|веди|как доехать|як доїхати)\s+(?:до|в|во|на|к|ко)\s+(.+)$/,
  );
  if (route && route[1].length > 1) return { kind: 'tool', name: 'navigate_to', args: { destination: route[1] } };

  if (/^(поехали|начать движение|старт|почати рух|їдемо)$/.test(t)) return { kind: 'tool', name: 'start_navigation', args: {} };
  if (/(заверши|отмени|сбрось|скасуй|зупини) (маршрут|навигаци|навігаці)/.test(t)) return { kind: 'tool', name: 'stop_navigation', args: {} };

  // Объекты по пути: «найди заправку», «где поесть», «заправки по пути»
  if (/(найди|найти|где|покажи|знайди|де|ближайш|найближч|по пути|по дорозі|по маршруту)/.test(t)) {
    for (const [re, cat] of POI_WORDS) if (re.test(t)) return { kind: 'tool', name: 'find_along_route', args: { category: cat } };
  }

  // Музыка
  if (/^(пауза|стоп|останови музыку|выключи (музыку|радио)|тише|вимкни (музику|радіо)|зупини музику)$/.test(t)) {
    return { kind: 'tool', name: 'media_control', args: { action: 'pause' } };
  }
  if (/^(следующ|дальше|переключи|наступн|далі)/.test(t)) return { kind: 'tool', name: 'media_control', args: { action: 'next' } };
  if (/^(предыдущ|назад|попередн)/.test(t)) return { kind: 'tool', name: 'media_control', args: { action: 'previous' } };
  const radio = t.match(/^(?:включи|поставь|играй|увімкни|ввімкни|постав)\s+(?:радио|радіо|станцию|станцію)\s*(.*)$/);
  if (radio) return { kind: 'tool', name: 'play_radio', args: { station: radio[1] ?? '' } };
  if (/^(включи|продолжи|увімкни|продовж)\s+(музыку|музику)$/.test(t) || /^(играй|грай)$/.test(t)) {
    return { kind: 'tool', name: 'media_control', args: { action: 'play' } };
  }

  // ChatGPT: «открой ChatGPT», «чат джипити», «відкрий чатджіпіті»
  if (/(chat ?gpt|чат ?(джи ?пи ?ти|gpt|жпт|гпт)|чатджипити|чатджіпіті|чат джіпіті)/.test(t)) {
    return { kind: 'tool', name: 'open_app', args: { app: 'chatgpt' } };
  }

  // Голос
  if (/(выключи|отключи|вимкни) (голос|озвучк|голосові)/.test(t)) return { kind: 'tool', name: 'set_voice_replies', args: { enabled: false }, say: true };
  if (/(включи|увімкни) (голос|озвучк|голосові)/.test(t)) return { kind: 'tool', name: 'set_voice_replies', args: { enabled: true }, say: true };
  if (/(выключи|отключи|вимкни) (подсказки|підказки) (навигации|навігації)/.test(t)) return { kind: 'tool', name: 'set_navigation_voice', args: { enabled: false }, say: true };

  // Разделы: «открой …», «покажи …» или одно-два слова
  if (/^(открой|покажи|перейди|запусти|відкрий|покажи|перейди)\s/.test(t) || t.split(' ').length <= 2) {
    for (const [re, id] of SECTION_WORDS) if (re.test(t)) return { kind: 'tool', name: 'open_section', args: { section: id } };
  }

  return { kind: 'ask', text: raw };
}

export async function handleVoiceCommand(raw: string) {
  const cmd = parseCommand(raw);
  if (cmd.kind === 'ask') {
    openSection('assistant');
    await sendToAssistant(raw);
    return;
  }
  const res = await runTool(cmd.name, cmd.args);
  toast(res.text, res.ok ? 'ok' : 'warn');
  const s = settingsStore.get();
  // Озвучиваем результат для навигации и поиска, где важна обратная связь без взгляда на экран.
  if ((s.speakReplies || cmd.say) && ['navigate_to', 'find_along_route', 'set_voice_replies', 'set_navigation_voice', 'play_radio'].includes(cmd.name)) {
    speak(res.text, s.speechLang);
  }
}

export const VEHICLE_CONTROL_HINT = 'Команды для систем автомобиля не выполняются — интеграции с автомобилем пока нет.';
