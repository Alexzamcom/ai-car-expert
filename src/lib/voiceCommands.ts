/* Быстрые голосовые команды (работают без сети и без Grok).
   Разбор — чистая функция parseCommand (покрыта тестами), выполнение — через те же
   инструменты, что вызывает Grok. Всё, что не распознано, уходит помощнику. */
import { runTool } from './tools';
import { openSection, toast, settingsStore } from './state';
import { sendToAssistant, chatStore } from './assistant';
import { uid } from './store';
import { isVehicleControlRequest } from './vehicleGuard';
import { speak, lastSpokenText } from './speech';
import { L, uiLang } from './i18n';
import { navStore, savedPlacesStore } from './nav';

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
  [/(заправ|азс|бензин|дизел|солярк|пальн)/, 'fuel'],
  [/(кафе|поесть|поїсти|(^|\s)їсти|кофе|кава|каву|ресторан|перекус|пообедать|пообідати|покушать|поужинать)/, 'food'],
  [/(парков|стоянк|паркінг|паркув|припарк|запарк)/, 'parking'],
  [/(отдых|отдохн|передохн|відпочин|відпочи|туалет)/, 'rest'],
];

/** Жанры радио (теги каталога Radio Browser). */
const GENRES: [RegExp, string][] = [
  [/джаз|jazz/, 'jazz'],
  [/(^|\s)рок($|\s|-)|рок-н|rock/, 'rock'],
  [/(^|\s)(поп|попс|pop)($|\s)/, 'pop'],
  [/класс?ик|класичн|classic/, 'classical'],
  [/шансон/, 'chanson'],
  [/электрон|електрон|танц|клубн|дэнс|денс|dance/, 'dance'],
  [/спокойн|спокійн|релакс|расслаб|(^|\s)чил|эмбиент|ембієнт|ambient|lounge|лаунж|chill/, 'chillout'],
  [/новост|новин|news/, 'news'],
  [/ретро|диско|80-х|80х|90-х|90х/, 'retro'],
  [/хип-?хоп|(^|\s)(реп|рэп)($|\s)/, 'hiphop'],
  [/блюз/, 'blues'],
  [/кантри/, 'country'],
  [/метал/, 'metal'],
  [/детск|дитяч/, 'kids'],
];

/** Слова-паразиты и вежливость в начале и конце фразы — не влияют на смысл команды. */
const LEAD = /^(?:(?:пожалуйста|будь ласка|будь добр[аы]?|слушай|слухай|послушай|окей|ок|ok|эй|ну|так|а|алло|привет|привіт|можешь|можеш|можете|ты можешь|ти можеш|можно|можна|сделай так чтобы)\s+)+/;
const TRAIL = /\s+(?:пожалуйста|будь ласка|плиз|please|спасибо|дякую)$/;

export function normalize(raw: string) {
  return raw
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[’ʼ`]/g, "'")
    .replace(/[.,!?«»"…;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LEAD, '')
    .replace(TRAIL, '')
    .trim();
}

/** «Повтори», «ещё раз», «что?» — повторить последний голосовой ответ. */
export function isRepeatRequest(raw: string) {
  return /^(?:повтори(?:те)?|повтор|еще раз|ещ[её] раз|ще раз|что|шо|що|не расслышал|не почув|не чув)(?:\s+(?:пожалуйста|будь ласка|еще раз|ще раз))?$/.test(normalize(raw));
}

const pastServiceKm = (t: string) => {
  const m = t.match(/(\d{1,3}(?:[ \u00a0]\d{3})+|\d{4,7})\s*(?:км|кілометр|километр|тис|тыс)?/);
  if (!m) return null;
  const n = parseInt(m[1].replace(/\D/g, ''), 10);
  return n >= 1000 && n < 2_000_000 ? n : null;
};

/** Выполненная работа: «поменял масло на 152000», «пройшов ТО», «переобул резину». Только прошедшее время. */
function serviceRecord(t: string): Command | null {
  if (!/(заменил|поменял|сменил|замінив|поміняв|змінив|сделал|зробив|прошел|прошла|пройшов|пройшла|переобул|переобув|поставил|поставив|купил новый|купив новий)/.test(t)) return null;
  const cat: [RegExp, string][] = [
    [/(масл|мастил)/, 'oil'],
    [/((^|\s)то($|\s)|техобслуж|техогляд)/, 'to'],
    [/(колодк|тормоз|гальм|диск)/, 'brakes'],
    [/(резин|шин|колес|переобу)/, 'tires'],
    [/(аккумулятор|акумулятор|батаре)/, 'battery'],
  ];
  const found = cat.find(([re]) => re.test(t));
  if (!found) return null;
  const km = pastServiceKm(t);
  return { kind: 'tool', name: 'add_service_record', args: { category: found[1], ...(km != null ? { odometer_km: km } : {}) } };
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

/** Длинная фраза, несколько просьб или придаточное предложение не в начале — это вопрос для помощника. */
export function isComplex(t: string) {
  const words = t.split(' ');
  if (words.length > 12) return true;
  if (/\s(?:и|і|та|а)\s+(?:скажи|расскажи|розкажи|потом|потім|ещ[её]|ще|заодно)(\s|$)/.test(t)) return true;
  return /\s(?:где|де|который|которая|которое|которые|який|яка|яке|які|чтобы|щоб)\s/.test(` ${words.slice(1).join(' ')} `);
}

export function parseCommand(raw: string): Command {
  const t = normalize(raw);
  if (!t) return { kind: 'ask', text: raw };

  // Управление системами автомобиля — только честный ответ помощника.
  if (isVehicleControlRequest(t)) return { kind: 'ask', text: raw };

  // Сложная фраза — несколько просьб или придаточное («…кафе, где вкусно кормят») — не простая команда.
  if (isComplex(t)) return { kind: 'ask', text: raw };

  // YouTube Music: «открой YouTube Music», «включи ютуб музыку», «відкрий YouTube Music»
  if (/(youtube ?music|ютуб ?(музык|музик|мьюзик|мюзик)|ю ?туб ?(музык|музик|мьюзик)|youtube ?(музык|музик))/.test(t)) {
    return { kind: 'tool', name: 'open_music_service', args: { service: 'youtube-music' } };
  }

  // Выполненная работа в журнал обслуживания
  const rec = serviceRecord(t);
  if (rec) return rec;

  // Напоминания и сервис: «какие напоминания», «что по сервису», «які нагадування»
  if (/^(?:какие|які|мои|мої|покажи|прочитай|список)?\s*(?:напоминани|нагадуван)/.test(t) || /^(?:что|що) (?:по|з|с) (?:сервис|сервіс|обслуж|то$)/.test(t)) {
    return { kind: 'tool', name: 'service_status', args: {} };
  }

  // Вопросы о маршруте: «сколько ещё ехать», «когда приедем», «куда поворачивать»
  if (
    /(сколько|скільки)\s+(?:ещ[её]\s+|ще\s+)?(?:ехать|їхати|осталось|залишилось|лишилось|км|километров|кілометрів|минут|хвилин|времени|часу)/.test(t) ||
    /(когда|коли|во сколько|о котрій)\s+(?:мы\s+|ми\s+)?(?:приедем|приїдемо|будем|будемо|прибудем|доедем|доїдемо|прибытие|прибуття)/.test(t) ||
    /(куда|куди)\s+(?:мне\s+|мені\s+)?(?:поворачивать|повертати|ехать дальше|їхати далі|дальше|далі)/.test(t) ||
    /(следующий|наступний|какой|який|ближайший)\s+(?:поворот|манёвр|маневр)/.test(t)
  ) {
    return { kind: 'tool', name: 'get_status', args: { topic: 'route' } };
  }

  // Что играет
  if (/^(?:что|що|какая|яка|какое|яке|кто|хто)\s+(?:сейчас\s+|зараз\s+)?(?:играет|грає|звучит|звучить|станция|станція|за песня|за пісня|поет|співає)/.test(t)) {
    return { kind: 'tool', name: 'get_status', args: { topic: 'music' } };
  }

  // Остановка: убрать / выбрать другой вариант маршрута
  if (/(убери|удали|отмени|прибери|видали|скасуй|не надо|не треба)\s+(?:эту\s+|цю\s+)?(?:остановк|зупинк|заезд|заїзд)/.test(t) || /^без (?:заезда|остановки|заїзду|зупинки)$/.test(t)) {
    return { kind: 'tool', name: 'remove_stop', args: {} };
  }
  const alt = t.match(/^(?:покажи\s+|выбери\s+|обери\s+|давай\s+)?(друг(?:ой|ий|ую)|втор(?:ой|ую)|інш(?:ий|у)|запасн(?:ой|ий)|альтернативн\S*|трет(?:ий|ій)|перв(?:ый|ую)|перш(?:ий|у))\s+(?:маршрут|вариант|варіант|путь|шлях|дорог\S*)$/);
  if (alt) {
    const index = /^трет/.test(alt[1]) ? 2 : /^(перв|перш)/.test(alt[1]) ? 0 : 1;
    return { kind: 'tool', name: 'choose_route', args: { index } };
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

  // Остановка по пути: «заедем на заправку», «по дороге заедем в аптеку», «додай зупинку на АЗС», «заїдемо в кафе»
  const stop = t.match(/(?:^|\s)(?:давай\s+)?(?:заедем|заехать|заедь|заскочим|заскочить|заехали бы|заїдемо|заїхати|заскочимо|добавь остановку|добавить остановку|сделай остановку|додай зупинку|зроби зупинку)\s*(?:на|в|во|до|к|у)?\s*(.*)$/);
  if (stop) {
    const what = stop[1].replace(/\s*(?:по пути|по дороге|по дорозі|по маршруту|ненадолго|на хвилинку|на минутку)\s*/g, ' ').trim();
    for (const [re, cat] of POI_WORDS) if (re.test(what)) return { kind: 'tool', name: 'add_stop', args: { category: cat } };
    if (what.length > 1) return { kind: 'tool', name: 'add_stop', args: { query: what } };
  }

  // Поиск места без маршрута: «найди Театр Сатиры», «знайди Хрещатик 22», «покажи на карте вокзал»
  const find = t.match(/^(?:найди|найти|знайди|покажи на карте|покажи на мапі|где находится|де знаходиться)\s+(.+)$/);
  if (
    find &&
    !POI_WORDS.some(([re]) => re.test(find[1])) &&
    !/(рядом|поблизу|поруч|неподалеку|поблизости|по пути|по дороге|по дорозі)/.test(find[1]) &&
    !SECTION_WORDS.some(([re]) => re.test(find[1]) && find[1].split(' ').length <= 2)
  ) {
    return { kind: 'tool', name: 'search_places', args: { query: find[1] } };
  }

  // Назад к карте: «вернись к карте», «покажи карту», «повернись до карти», «до мапи»
  if (/^(вернись|вернуться|назад|верни|повернись|повернутися|покажи|покажи мне)\s*(к|на|до)?\s*(карт|мап|навигац|навігац)/.test(t) || /^(к карте|на карту|до мапи|до карти)$/.test(t)) {
    return { kind: 'tool', name: 'open_section', args: { section: 'navigation' } };
  }

  // Дом и работа: «едем домой», «поехали на работу», «їдемо додому»
  const GO = '(?:поехали|поедем|едем|еду|ехать|поехать|вези|отвези|довези|веди|маршрут|навигация|поїхали|поїдемо|їдемо|їдьмо|їду|вези|відвези|довези|веди|хочу|хочу поехать|хочу поїхати|пора)';
  const home = t.match(new RegExp(`^(?:${GO}\\s+)?(?:меня\\s+|мене\\s+|нас\\s+)?(домой|додому|до дому|на работу|на роботу|до роботи)$`));
  if (home && (home[0] !== home[1] || /^(домой|додому)$/.test(t))) {
    const uk = /(додому|до дому|роботу|роботи)/.test(home[1]);
    const isHome = /дом/.test(home[1]);
    return { kind: 'tool', name: 'navigate_to', args: { destination: isHome ? (uk ? 'дім' : 'дом') : uk ? 'робота' : 'работа' } };
  }

  // Маршрут: «маршрут до …», «отвези меня в …», «как проехать к …», «проклади маршрут до …», «їдемо до …»
  const route = t.match(
    /^(?:(?:проложи|построй|прокладі|проклади|побудуй|включи|запусти|увімкни|ввімкни|начни|почни)\s+)?(?:маршрут|навигаци[а-яё]*|навігаці[а-яіїє]*|поехали|поедем|едем|ехать|поехать|поїхали|поїдемо|їдемо|їдьмо|веди|вези|отвези|довези|подвези|відвези|как доехать|как проехать|как добраться|як доїхати|як проїхати|як дістатися|хочу поехать|хочу поїхати|хочу|мне надо|мне нужно|мені треба|мені потрібно)(?:\s+(?:меня|мене|нас))?\s+(?:до|в|во|на|к|ко)\s+(.+)$/,
  );
  // Сложная фраза («…в театр, где играют сатиру, и скажи, сколько ехать») — не адрес: её разбирает помощник.
  const simpleDest = (d: string) => d.split(' ').length <= 6 && !/(^|\s)(и|і|та|где|де|который|которая|який|яка|скажи|расскажи|розкажи|потом|потім|чтобы|щоб)(\s|$)/.test(d);
  if (route && route[1].length > 1 && simpleDest(route[1]) && !POI_WORDS.some(([re]) => re.test(route[1]) && route[1].split(' ').length <= 2)) {
    return { kind: 'tool', name: 'navigate_to', args: { destination: route[1] } };
  }

  if (/^(поехали|погнали|поехали поехали|вперед|старт|начни ведение|начать ведение|начать движение|начни навигацию|начни маршрут|веди|почати рух|рушаймо|рушай|почни ведення|почни навігацію|почни маршрут|їдемо|поїхали)$/.test(t)) {
    return { kind: 'tool', name: 'start_navigation', args: {} };
  }
  if (
    /(заверши|завершить|закончи|закончить|отмени|отменить|сбрось|прекрати|останови|скасуй|скасувати|зупини|заверш|припини|відміни|вимкни|выключи)\s+(?:(?:этот|цей|текущий|поточний|весь)\s+)?(маршрут|навигаци|навігаці|ведение|ведення)/.test(t) ||
    /^стоп (навигаци|навігаці|маршрут)/.test(t)
  ) {
    return { kind: 'tool', name: 'stop_navigation', args: {} };
  }

  // Объекты по пути: «найди заправку», «где поесть», «нужно заправиться»; «добавь заправку в маршрут» — остановка.
  // «де»/«где» — отдельными словами: как подстрока они встречаются почти везде.
  if (
    /(найди|найти|покажи|знайди|ближайш|найближч|по пути|по дороге|по дорозі|по маршруту|добав|додай|заед|заїд|дозаправ|заправимся|заправимо|рядом|поблизу|поруч|неподалеку|поблизости|нужно|надо|треба|хочу|хочеться|хочется)/.test(t) ||
    /(^|\s)(где|де)(\s|$)/.test(t)
  ) {
    const asStop = /(добав|додай|заед|заїд|останов|зупинк|заехать|заїхати|дозаправ|заправимся|заправимо)/.test(t);
    for (const [re, cat] of POI_WORDS) if (re.test(t)) return { kind: 'tool', name: asStop ? 'add_stop' : 'find_along_route', args: { category: cat } };
  }
  // «Парковка рядом» без глагола
  if (t.split(' ').length <= 3) for (const [re, cat] of POI_WORDS) if (re.test(t) && /(рядом|поблизу|поруч|близко)/.test(t)) return { kind: 'tool', name: 'find_along_route', args: { category: cat } };

  // Громкость. На iPad громкость меняют только кнопки устройства — инструмент честно скажет об этом.
  if (/^(?:сделай\s+|зроби\s+)?(?:громче|погромче|гучніше|голосніше|прибавь звук|додай звук)$/.test(t)) return { kind: 'tool', name: 'media_control', args: { action: 'louder' } };
  if (/^(?:сделай\s+|зроби\s+)?(?:тише|потише|тихіше|тихше|убавь звук|зменш звук)$/.test(t)) return { kind: 'tool', name: 'media_control', args: { action: 'quieter' } };

  // Музыка
  if (/^(пауза|стоп|на паузу|поставь на паузу|постав на паузу|останови (музыку|радио)|выключи (музыку|радио|звук)|выключи|вимкни (музику|радіо)|вимкни|зупини (музику|радіо))$/.test(t)) {
    return { kind: 'tool', name: 'media_control', args: { action: 'pause' } };
  }
  if (/^(следующ|дальше|переключи|наступн|далі|другую станцию|другую|іншу станцію|іншу|перемкни|пропусти)/.test(t)) return { kind: 'tool', name: 'media_control', args: { action: 'next' } };
  if (/^(предыдущ|назад|попередн)/.test(t)) return { kind: 'tool', name: 'media_control', args: { action: 'previous' } };
  if (/^(играй|грай|продолжи|продовж|продолжай|продовжуй|возобнови|включи снова|грай далі|играй дальше|відтвори)$/.test(t)) return { kind: 'tool', name: 'media_control', args: { action: 'play' } };
  if (/^(радио|радіо)$/.test(t)) return { kind: 'tool', name: 'play_radio', args: { station: '' } };
  const radio = t.match(/^(?:включи|поставь|играй|увімкни|ввімкни|постав|запусти)\s+(?:радио|радіо|станцию|станцію)\s*(.*)$/);
  if (radio) return { kind: 'tool', name: 'play_radio', args: { station: radio[1] ?? '' } };
  const fm = t.match(/^(?:включи|поставь|увімкни|ввімкни|постав)\s+(.+?\s(?:fm|фм))$/);
  if (fm) return { kind: 'tool', name: 'play_radio', args: { station: fm[1] } };
  if (/^(включи|продолжи|увімкни|продовж|поставь|постав)\s+(музыку|музику)$/.test(t)) return { kind: 'tool', name: 'play_music', args: {} };
  const genreReq = t.match(/^(?:включи|поставь|увімкни|ввімкни|постав|давай|хочу|играй|грай)\s+(.+)$/);
  if (genreReq) {
    const g = GENRES.find(([re]) => re.test(genreReq[1]));
    if (g) return { kind: 'tool', name: 'play_radio', args: { genre: g[1] } };
  }

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
  if (/^(открой|покажи|перейди|запусти|відкрий|перейди)\s/.test(t) || t.split(' ').length <= 2) {
    for (const [re, id] of SECTION_WORDS) if (re.test(t)) return { kind: 'tool', name: 'open_section', args: { section: id } };
  }

  return { kind: 'ask', text: raw };
}

/** Результат этих команд озвучивается: водитель не должен смотреть на экран. */
const SPOKEN = new Set([
  'navigate_to', 'search_places', 'add_stop', 'remove_stop', 'choose_route', 'stop_navigation', 'add_reminder', 'add_service_record',
  'service_status', 'get_status', 'find_along_route', 'set_voice_replies', 'set_navigation_voice', 'play_radio', 'set_theme',
  'open_music_service', 'play_music',
]);

export async function handleVoiceCommand(raw: string) {
  const s0 = settingsStore.get();
  if (isRepeatRequest(raw)) {
    const last = lastSpokenText();
    speak(last || L('Пока нечего повторить.', 'Поки нічого повторити.'), s0.speechLang);
    return;
  }
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
  const spokenMedia = cmd.name === 'media_control' && (!res.ok || cmd.args.action === 'louder' || cmd.args.action === 'quieter');
  if ((s.speakReplies || cmd.say) && (spokenMedia || SPOKEN.has(cmd.name))) speak(res.text, s.speechLang);
}

export const VEHICLE_CONTROL_HINT = 'Команды для систем автомобиля не выполняются — интеграции с автомобилем пока нет.';

export interface QuickAction {
  label: string;
  /** Фраза, которая выполняется как голосовая команда (тот же разбор, что и для речи). */
  command: string;
  primary?: boolean;
}

/** Быстрые действия в окне голоса — по ситуации: ведение, готовый маршрут или поездка ещё не начата. */
export function quickActions(): QuickAction[] {
  const uk = uiLang() === 'uk';
  const a = (ru: string, ua: string, primary = false): QuickAction => ({ label: uk ? ua : ru, command: uk ? ua : ru, primary });
  const nav = navStore.get();
  const saved = savedPlacesStore.get();
  if (nav.status === 'guiding') {
    return [
      a('Сколько ехать', 'Скільки ще їхати', true),
      a('Повтори', 'Повтори'),
      nav.via ? a('Убери остановку', 'Прибери зупинку') : a('Заедем на заправку', 'Заїдемо на заправку'),
      a('Что играет', 'Що грає'),
      a('Заверши маршрут', 'Заверши маршрут'),
    ];
  }
  if (nav.dest && nav.route) {
    return [
      a('Поехали', 'Поїхали', true),
      ...(nav.routes.length > 1 ? [a('Другой маршрут', 'Інший маршрут')] : []),
      a('Сколько ехать', 'Скільки ще їхати'),
      a('Заедем на заправку', 'Заїдемо на заправку'),
      a('Отмени маршрут', 'Скасуй маршрут'),
    ];
  }
  return [
    ...(saved.home ? [a('Домой', 'Додому', true)] : []),
    ...(saved.work ? [a('На работу', 'На роботу')] : []),
    a('Найди заправку', 'Знайди заправку'),
    a('Включи радио', 'Увімкни радіо'),
    a('Что играет', 'Що грає'),
    a('Напоминания', 'Нагадування'),
  ];
}
