/* Быстрые голосовые команды (работают без сети и без Grok).
   Разбор — чистая функция parseCommand (покрыта тестами), выполнение — через те же
   инструменты, что вызывает Grok. Всё, что не распознано, уходит помощнику. */
import { runTool } from './tools';
import { openSection, toast, settingsStore } from './state';
import { sendToAssistant, chatStore } from './assistant';
import { uid } from './store';
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

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const NUM_WORDS: Record<string, number> = { один: 1, одну: 1, два: 2, две: 2, дві: 2, три: 3, четыре: 4, чотири: 4, пять: 5, "п'ять": 5, десять: 10 };

/** Простые относительные сроки ru/uk → дата YYYY-MM-DD и текст без них. */
export function extractRelativeDate(text: string, now = new Date()): { date: string | null; text: string } {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const rules: [RegExp, (m: RegExpMatchArray) => void][] = [
    [/(?:^|\s)(?:послезавтра|післязавтра)(?=\s|$)/, () => d.setDate(d.getDate() + 2)],
    [/(?:^|\s)(?:завтра)(?=\s|$)/, () => d.setDate(d.getDate() + 1)],
    [/(?:^|\s)через\s+(?:(\d+|[а-яіїє']+)\s+)?(?:недел[юиь]|тижн[іяь]|тиждень)(?=\s|$)/, (m) => d.setDate(d.getDate() + 7 * (Number(m[1]) || NUM_WORDS[m[1] ?? ''] || 1))],
    [/(?:^|\s)через\s+(?:(\d+|[а-яіїє']+)\s+)?(?:месяц[а-яёіїє]*|місяц[а-яёіїє]*|місяць)(?=\s|$)/, (m) => d.setMonth(d.getMonth() + (Number(m[1]) || NUM_WORDS[m[1] ?? ''] || 1))],
    [/(?:^|\s)через\s+(\d+|[а-яіїє']+)\s+(?:дн[а-яёіїє]*|ден[а-яёіїє]*|день)(?=\s|$)/, (m) => d.setDate(d.getDate() + (Number(m[1]) || NUM_WORDS[m[1]] || 1))],
  ];
  for (const [re, apply] of rules) {
    const m = text.match(re);
    if (m) {
      apply(m);
      return { date: iso(d), text: text.replace(m[0], ' ').replace(/\s+/g, ' ').trim() };
    }
  }
  return { date: null, text };
}

export function parseCommand(raw: string): Command {
  const t = normalize(raw);
  if (!t) return { kind: 'ask', text: raw };

  // Управление системами автомобиля — только честный ответ помощника.
  if (isVehicleControlRequest(t)) return { kind: 'ask', text: raw };

  // YouTube Music: «открой YouTube Music», «включи ютуб музыку», «відкрий YouTube Music»
  if (/(youtube ?music|ютуб ?(музык|музик|мьюзик|мюзик)|ю ?туб ?(музык|музик|мьюзик)|youtube ?(музык|музик))/.test(t)) {
    return { kind: 'tool', name: 'open_music_service', args: { service: 'youtube-music' } };
  }

  // Остановка по пути: «заедем на заправку», «добавь остановку Ашан», «додай зупинку на АЗС», «заїдемо в кафе»
  const stop = t.match(/^(?:заедем|заехать|заехали бы|давай заедем|добавь остановку|добавить остановку|остановка|заїдемо|заїхати|додай зупинку|зупинка)\s*(?:на|в|во|до|к|у)?\s*(.*)$/);
  if (stop) {
    const what = stop[1].trim();
    for (const [re, cat] of POI_WORDS) if (re.test(what)) return { kind: 'tool', name: 'add_stop', args: { category: cat } };
    if (what.length > 1) return { kind: 'tool', name: 'add_stop', args: { query: what } };
  }

  // Напоминание: «напомни заменить масло через 5000 км», «нагадай через тиждень перевірити шини», «напомни завтра …»
  const remind = t.match(/^(?:напомни|напомнить|нагадай|нагадати)(?:\s+мне|\s+мені)?\s+(.+)$/);
  if (remind) {
    let rest = remind[1];
    const kmM = rest.match(/\s*через\s+(\d[\d ]*)\s*(?:км|километр[а-яёіїє]*|кілометр[а-яёіїє]*)/);
    rest = rest.replace(kmM?.[0] ?? '', ' ');
    const { date, text } = extractRelativeDate(rest);
    const clean = text.replace(/^(?:про|о|об)\s+/, '').replace(/\s+/g, ' ').trim();
    const km = kmM ? parseInt(kmM[1].replace(/\s/g, ''), 10) : null;
    const odo = settingsStore.get().vehicle.odometerKm;
    // Без известного пробега «через N км» не превращаем в выдуманный срок — пусть уточнит ИИ или пользователь.
    // Непонятный срок («через полгода после ТО») — тоже ИИ.
    if (clean.length > 2 && (km == null || odo != null) && !/через|после|після|до\s+\d/.test(clean)) {
      return { kind: 'tool', name: 'add_reminder', args: { text: clean, ...(date ? { due_date: date } : {}), ...(km != null ? { due_km: odo! + km } : {}) } };
    }
  }

  // Поиск места без маршрута: «найди Театр Сатиры», «знайди Хрещатик 22», «покажи на карте вокзал»
  const find = t.match(/^(?:найди|найти|знайди|покажи на карте|покажи на мапі|где находится|де знаходиться)\s+(.+)$/);
  if (find && !POI_WORDS.some(([re]) => re.test(find[1])) && !SECTION_WORDS.some(([re]) => re.test(find[1]) && find[1].split(' ').length <= 2)) {
    return { kind: 'tool', name: 'search_places', args: { query: find[1] } };
  }

  // Назад к карте: «вернись к карте», «покажи карту», «повернись до карти», «до мапи»
  if (/^(вернись|вернуться|назад|верни|повернись|повернутися|покажи|покажи мне)\s*(к|на|до)?\s*(карт|мап|навигац|навігац)/.test(t) || /^(к карте|на карту|до мапи|до карти)$/.test(t)) {
    return { kind: 'tool', name: 'open_section', args: { section: 'navigation' } };
  }

  // Маршрут: «маршрут до …», «поехали в …», «проклади маршрут до …», «їдемо до …»
  const route = t.match(
    /^(?:(?:проложи|построй|прокладі|проклади|побудуй|включи|запусти|увімкни|ввімкни)\s+)?(?:маршрут|поехали|поедем|едем|ехать|їдемо|поїхали|навигаци[а-яё]*|веди|как доехать|як доїхати)\s+(?:до|в|во|на|к|ко)\s+(.+)$/,
  );
  if (route && route[1].length > 1) return { kind: 'tool', name: 'navigate_to', args: { destination: route[1] } };

  if (/^(поехали|начать движение|старт|почати рух|їдемо)$/.test(t)) return { kind: 'tool', name: 'start_navigation', args: {} };
  if (/(заверши|отмени|сбрось|скасуй|зупини) (маршрут|навигаци|навігаці)/.test(t)) return { kind: 'tool', name: 'stop_navigation', args: {} };

  // Объекты по пути: «найди заправку», «где поесть», «заправки по пути»; «добавь заправку в маршрут» — остановка
  // «де»/«где» — отдельными словами: как подстрока они встречаются почти везде.
  if (/(найди|найти|покажи|знайди|ближайш|найближч|по пути|по дороге|по дорозі|по маршруту|добав|додай|заед|заїд|дозаправ|заправимся|заправимо)/.test(t) || /(^|\s)(где|де)(\s|$)/.test(t)) {
    const asStop = /(добав|додай|заед|заїд|останов|зупинк|заехать|заїхати|дозаправ|заправимся|заправимо)/.test(t);
    for (const [re, cat] of POI_WORDS) if (re.test(t)) return { kind: 'tool', name: asStop ? 'add_stop' : 'find_along_route', args: { category: cat } };
  }

  // Музыка
  if (/^(пауза|стоп|останови музыку|выключи (музыку|радио)|тише|вимкни (музику|радіо)|зупини музику)$/.test(t)) {
    return { kind: 'tool', name: 'media_control', args: { action: 'pause' } };
  }
  if (/^(следующ|дальше|переключи|наступн|далі)/.test(t)) return { kind: 'tool', name: 'media_control', args: { action: 'next' } };
  if (/^(предыдущ|назад|попередн)/.test(t)) return { kind: 'tool', name: 'media_control', args: { action: 'previous' } };
  const radio = t.match(/^(?:включи|поставь|играй|увімкни|ввімкни|постав)\s+(?:радио|радіо|станцию|станцію)\s*(.*)$/);
  if (radio) return { kind: 'tool', name: 'play_radio', args: { station: radio[1] ?? '' } };
  if (/^(включи|продолжи|увімкни|продовж)\s+(музыку|музику)$/.test(t)) return { kind: 'tool', name: 'play_music', args: {} };
  if (/^(играй|грай)$/.test(t)) return { kind: 'tool', name: 'media_control', args: { action: 'play' } };

  // Тема: «ночной режим», «включи дневную тему», «тема авто», «нічна тема»
  if (/(тем[ауы]|режим|оформлен)/.test(t) || /^(день|ночь|ніч)$/.test(t)) {
    if (/(авто|автомат)/.test(t)) return { kind: 'tool', name: 'set_theme', args: { mode: 'auto' } };
    if (/(ночн|нічн|ночь|ніч|темн)/.test(t)) return { kind: 'tool', name: 'set_theme', args: { mode: 'night' } };
    if (/(дневн|денн|день|светл|світл)/.test(t)) return { kind: 'tool', name: 'set_theme', args: { mode: 'day' } };
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
  // Команда и результат — в истории диалога (видно, что было сделано голосом).
  chatStore.set((l) =>
    [
      ...l,
      { id: uid(), role: 'user' as const, text: raw.trim(), time: Date.now() },
      { id: uid(), role: 'assistant' as const, text: res.text, source: 'local' as const, actions: res.ok ? [res.text] : undefined, time: Date.now() },
    ].slice(-100),
  );
  const s = settingsStore.get();
  // Озвучиваем результат для навигации и поиска, где важна обратная связь без взгляда на экран.
  // Отказ управлять YouTube Music тоже озвучиваем: водитель может не смотреть на экран.
  const spokenRefusal = cmd.name === 'media_control' && !res.ok;
  if ((s.speakReplies || cmd.say) && (spokenRefusal || ['navigate_to', 'search_places', 'add_stop', 'add_reminder', 'find_along_route', 'set_voice_replies', 'set_navigation_voice', 'play_radio', 'set_theme', 'open_music_service', 'play_music'].includes(cmd.name))) {
    speak(res.text, s.speechLang);
  }
}

export const VEHICLE_CONTROL_HINT = 'Команды для систем автомобиля не выполняются — интеграции с автомобилем пока нет.';
