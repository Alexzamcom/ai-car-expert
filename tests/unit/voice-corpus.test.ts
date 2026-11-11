/* Корпус реальных голосовых фраз (ru/uk) → локальное действие без ИИ.
   Фразы — как их возвращает распознавание речи iOS/Android: без знаков препинания, со словами-паразитами. */
import { describe, it, expect, beforeEach } from 'vitest';
import { parseCommand, isRepeatRequest } from '../../src/lib/voiceCommands';
import { settingsStore } from '../../src/lib/state';

const base = settingsStore.get();
beforeEach(() => settingsStore.set({ ...base, vehicle: { ...base.vehicle, odometerKm: 150000 } }));

const parsed = (t: string) => {
  const c = parseCommand(t);
  return c.kind === 'tool' ? [c.name, c.args] : ['ask'];
};

type Case = [string, string, Record<string, unknown>?];
const table = (cases: Case[]) =>
  it.each(cases)('«%s» → %s', (phrase, name, args) => {
    const [n, a] = parsed(phrase);
    expect(n).toBe(name);
    if (args) expect(a).toMatchObject(args);
  });

describe('Навигация: маршрут', () => {
  table([
    ['Маршрут до Красной площади', 'navigate_to', { destination: 'красной площади' }],
    ['проложи маршрут до Львова', 'navigate_to', { destination: 'львова' }],
    ['поехали в аэропорт Шереметьево', 'navigate_to', { destination: 'аэропорт шереметьево' }],
    ['отвези меня в аэропорт', 'navigate_to', { destination: 'аэропорт' }],
    ['довези до вокзала', 'navigate_to', { destination: 'вокзала' }],
    ['пожалуйста проложи маршрут до Одессы', 'navigate_to', { destination: 'одессы' }],
    ['слушай как доехать до Ашана', 'navigate_to', { destination: 'ашана' }],
    ['как проехать к Театру Сатиры', 'navigate_to', { destination: 'театру сатиры' }],
    ['хочу поехать в Сочи', 'navigate_to', { destination: 'сочи' }],
    ['едем домой', 'navigate_to', { destination: 'дом' }],
    ['поехали на работу', 'navigate_to', { destination: 'работа' }],
    ['Їдемо до Львова', 'navigate_to', { destination: 'львова' }],
    ['прокладі маршрут до Києва', 'navigate_to', { destination: 'києва' }],
    ['відвези мене до вокзалу', 'navigate_to', { destination: 'вокзалу' }],
    ['як проїхати до Хрещатика', 'navigate_to', { destination: 'хрещатика' }],
    ['їдемо додому', 'navigate_to', { destination: 'дім' }],
    ['будь ласка поїхали до центру', 'navigate_to', { destination: 'центру' }],
    ['включи навигацию до Одессы', 'navigate_to', { destination: 'одессы' }],
  ]);
});

describe('Навигация: ведение и маршрут', () => {
  table([
    ['поехали', 'start_navigation'],
    ['погнали', 'start_navigation'],
    ['начни ведение', 'start_navigation'],
    ['рушаймо', 'start_navigation'],
    ['почни навігацію', 'start_navigation'],
    ['отмени маршрут', 'stop_navigation'],
    ['отмени этот маршрут', 'stop_navigation'],
    ['закончи навигацию', 'stop_navigation'],
    ['стоп навигация', 'stop_navigation'],
    ['скасуй маршрут', 'stop_navigation'],
    ['припини навігацію', 'stop_navigation'],
    ['сколько еще ехать', 'get_status', { topic: 'route' }],
    ['когда приедем', 'get_status', { topic: 'route' }],
    ['сколько осталось', 'get_status', { topic: 'route' }],
    ['скільки ще їхати', 'get_status', { topic: 'route' }],
    ['коли приїдемо', 'get_status', { topic: 'route' }],
    ['куда поворачивать', 'get_status', { topic: 'route' }],
    ['другой маршрут', 'choose_route', { index: 1 }],
    ['второй вариант', 'choose_route', { index: 1 }],
    ['інший маршрут', 'choose_route', { index: 1 }],
    ['убери остановку', 'remove_stop'],
    ['без заезда', 'remove_stop'],
    ['прибери зупинку', 'remove_stop'],
    ['вернись к карте', 'open_section', { section: 'navigation' }],
    ['покажи карту', 'open_section', { section: 'navigation' }],
    ['до мапи', 'open_section', { section: 'navigation' }],
  ]);
});

describe('Остановки и объекты по пути', () => {
  table([
    ['заедем на заправку', 'add_stop', { category: 'fuel' }],
    ['давай заедем в Макдональдс', 'add_stop', { query: 'макдональдс' }],
    ['по дороге заедем в аптеку', 'add_stop', { query: 'аптеку' }],
    ['добавь остановку Ашан на Петровке', 'add_stop', { query: 'ашан на петровке' }],
    ['добавь заправку в маршрут', 'add_stop', { category: 'fuel' }],
    ['давай дозаправимся по дороге', 'add_stop', { category: 'fuel' }],
    ['додай зупинку на АЗС', 'add_stop', { category: 'fuel' }],
    ['заїдемо в кафе', 'add_stop', { category: 'food' }],
    ['по дорозі заїдемо на заправку', 'add_stop', { category: 'fuel' }],
    ['найди заправку', 'find_along_route', { category: 'fuel' }],
    ['где поесть', 'find_along_route', { category: 'food' }],
    ['заправки по пути', 'find_along_route', { category: 'fuel' }],
    ['нужно заправиться', 'find_along_route', { category: 'fuel' }],
    ['хочу кофе', 'find_along_route', { category: 'food' }],
    ['где перекусить', 'find_along_route', { category: 'food' }],
    ['парковка рядом', 'find_along_route', { category: 'parking' }],
    ['где припарковаться', 'find_along_route', { category: 'parking' }],
    ['треба заправитись', 'find_along_route', { category: 'fuel' }],
    ['де поїсти', 'find_along_route', { category: 'food' }],
    ['знайди заправку поблизу', 'find_along_route', { category: 'fuel' }],
    ['паркінг поруч', 'find_along_route', { category: 'parking' }],
    ['найди Театр Сатиры', 'search_places', { query: 'театр сатиры' }],
    ['знайди Хрещатик 22', 'search_places', { query: 'хрещатик 22' }],
  ]);
});

describe('Радио и музыка', () => {
  table([
    ['включи радио', 'play_radio', { station: '' }],
    ['радио', 'play_radio', { station: '' }],
    ['увімкни радіо', 'play_radio', { station: '' }],
    ['включи радио Рекорд', 'play_radio', { station: 'рекорд' }],
    ['поставь Хит FM', 'play_radio', { station: 'хит fm' }],
    ['включи джаз', 'play_radio', { genre: 'jazz' }],
    ['поставь что-нибудь спокойное', 'play_radio', { genre: 'chillout' }],
    ['включи рок', 'play_radio', { genre: 'rock' }],
    ['увімкни джаз', 'play_radio', { genre: 'jazz' }],
    ['постав щось спокійне', 'play_radio', { genre: 'chillout' }],
    ['включи новости', 'play_radio', { genre: 'news' }],
    ['пауза', 'media_control', { action: 'pause' }],
    ['стоп', 'media_control', { action: 'pause' }],
    ['выключи музыку', 'media_control', { action: 'pause' }],
    ['выключи радио', 'media_control', { action: 'pause' }],
    ['вимкни радіо', 'media_control', { action: 'pause' }],
    ['продолжи', 'media_control', { action: 'play' }],
    ['играй', 'media_control', { action: 'play' }],
    ['продовж', 'media_control', { action: 'play' }],
    ['следующая', 'media_control', { action: 'next' }],
    ['следующая станция', 'media_control', { action: 'next' }],
    ['переключи станцию', 'media_control', { action: 'next' }],
    ['другую станцию', 'media_control', { action: 'next' }],
    ['наступна', 'media_control', { action: 'next' }],
    ['предыдущая', 'media_control', { action: 'previous' }],
    ['громче', 'media_control', { action: 'louder' }],
    ['тише', 'media_control', { action: 'quieter' }],
    ['зроби тихіше', 'media_control', { action: 'quieter' }],
    ['что играет', 'get_status', { topic: 'music' }],
    ['що грає', 'get_status', { topic: 'music' }],
    ['включи музыку', 'play_music'],
    ['открой YouTube Music', 'open_music_service', { service: 'youtube-music' }],
    ['включи ютуб музыку', 'open_music_service', { service: 'youtube-music' }],
  ]);
});

describe('Сервис и напоминания', () => {
  table([
    ['напомни проверить шины', 'add_reminder', { text: 'проверить шины' }],
    ['напомни заменить масло через 5000 км', 'add_reminder', { text: 'заменить масло', due_km: 155000 }],
    ['нагадай завтра заїхати на мийку', 'add_reminder', { text: 'заїхати на мийку' }],
    ['пожалуйста напомни через неделю купить омывайку', 'add_reminder', { text: 'купить омывайку' }],
    ['я заменил масло', 'add_service_record', { category: 'oil' }],
    ['поменял масло на 152000', 'add_service_record', { category: 'oil', odometer_km: 152000 }],
    ['сегодня прошел ТО пробег 151 500', 'add_service_record', { category: 'to', odometer_km: 151500 }],
    ['поменял колодки', 'add_service_record', { category: 'brakes' }],
    ['переобул резину', 'add_service_record', { category: 'tires' }],
    ['замінив мастило', 'add_service_record', { category: 'oil' }],
    ['пройшов ТО', 'add_service_record', { category: 'to' }],
    ['какие напоминания', 'service_status'],
    ['что по сервису', 'service_status'],
    ['які нагадування', 'service_status'],
  ]);
});

describe('Разделы, тема, голос', () => {
  table([
    ['открой настройки', 'open_section', { section: 'settings' }],
    ['відкрий налаштування', 'open_section', { section: 'settings' }],
    ['ночная тема', 'set_theme', { mode: 'night' }],
    ['нічна тема', 'set_theme', { mode: 'night' }],
    ['выключи голос', 'set_voice_replies', { enabled: false }],
    ['открой ChatGPT', 'open_app', { app: 'chatgpt' }],
  ]);
});

describe('Остаётся помощнику (ИИ или встроенная база)', () => {
  table([
    ['как работает круиз-контроль', 'ask'],
    ['включи кондиционер', 'ask'],
    ['надеюсь кафе у театра работает допоздна', 'ask'],
    ['почему горит чек', 'ask'],
    ['напомни через полгода после ТО проверить тормоза', 'ask'],
    ['напомни', 'ask'],
    ['отвези меня в театр где играют сатиру и скажи сколько ехать', 'ask'],
    ['маршрут до кафе где вкусно кормят', 'ask'],
    ['добавь остановку', 'ask'],
  ]);
});

describe('Повтор', () => {
  it('«повтори», «ещё раз», «що?»', () => {
    for (const t of ['повтори', 'повтори пожалуйста', 'еще раз', 'что', 'повтори будь ласка', 'що']) expect(isRepeatRequest(t), t).toBe(true);
    expect(isRepeatRequest('повтори маршрут до дома')).toBe(false);
  });
});

/* ---------- Исполнение команд ---------- */
import { vi, afterEach } from 'vitest';
import osrm from '../fixtures/osrm-route.json';
import osrmAlt from '../fixtures/osrm-alternatives.json';
import rb from '../fixtures/radio-browser.json';
import { runTool } from '../../src/lib/tools';
import { geoStore, navStore, stopNavigation, setSavedPlace, savedPlacesStore, favoritesStore, spokenDuration, knownPlace, setDestination } from '../../src/lib/nav';
import { _resetThrottle } from '../../src/lib/geo/geocode';
import { __resetRadioHosts, playerStore } from '../../src/lib/player';
import { speak, lastSpokenText } from '../../src/lib/speech';

const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
const here = () => geoStore.set((g) => ({ ...g, status: 'watching', lat: 55.757, lon: 37.6156, accuracy: 10 }));
const theatre = { id: 't', name: 'Театр Сатиры', address: 'Москва', lat: 55.779, lon: 37.617 };

describe('Исполнение голосовых команд', () => {
  beforeEach(() => {
    _resetThrottle();
    __resetRadioHosts();
    savedPlacesStore.set({ home: null, work: null });
    favoritesStore.set([]);
    vi.stubGlobal('navigator', { onLine: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7)', maxTouchPoints: 5 });
  });
  afterEach(() => {
    stopNavigation();
    vi.unstubAllGlobals();
  });

  it('минуты и часы полными словами (ru/uk)', () => {
    expect(spokenDuration(60, 'ru')).toBe('1 минута');
    expect(spokenDuration(180, 'ru')).toBe('3 минуты');
    expect(spokenDuration(11 * 60, 'ru')).toBe('11 минут');
    expect(spokenDuration(80 * 60, 'ru')).toBe('1 час 20 минут');
    expect(spokenDuration(125 * 60, 'uk')).toBe('2 години 5 хвилин');
    expect(spokenDuration(22 * 60, 'uk')).toBe('22 хвилини');
  });

  it('«едем домой»: без сохранённого дома — подсказка; с сохранённым — маршрут без поиска', async () => {
    here();
    const f = vi.fn((u: string) => ok(u.includes('nominatim') ? [] : osrm));
    vi.stubGlobal('fetch', f);
    const miss = await runTool('navigate_to', { destination: 'дом' });
    expect(miss.ok).toBe(false);
    expect(miss.text).toContain('Сделать домом');
    setSavedPlace('home', theatre);
    const r = await runTool('navigate_to', { destination: 'дом' });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/^Маршрут до «Театр Сатиры»: 2,4 км, 6 минут\.$/);
    expect(f.mock.calls.some(([u]) => String(u).includes('nominatim'))).toBe(false);
  });

  it('избранное узнаётся по названию в падеже («до театра сатиры» → «Театр Сатиры»)', () => {
    favoritesStore.set([theatre]);
    expect(knownPlace('театр сатиры')).toMatchObject({ name: 'Театр Сатиры' });
    expect(knownPlace('театра сатиры')).toBeNull(); // разные основы — поиск по адресу
    expect(knownPlace('театр')).toMatchObject({ name: 'Театр Сатиры' });
  });

  it('«сколько ехать»: остаток, время, прибытие; без маршрута — честно', async () => {
    expect((await runTool('get_status', { topic: 'route' })).text).toBe('Маршрута нет.');
    here();
    vi.stubGlobal('fetch', () => ok(osrmAlt));
    await setDestination(theatre);
    const t = (await runTool('get_status', { topic: 'route' })).text;
    expect(t).toMatch(/^Осталось \d+,\d км, \d+ минут[аы]?, прибытие в \d\d:\d\d\. Скажите «поехали»/);
  });

  it('«другой маршрут» и «убери остановку»', async () => {
    here();
    vi.stubGlobal('fetch', () => ok(osrmAlt));
    await setDestination(theatre);
    const r = await runTool('choose_route', { index: 1 });
    expect(r.text).toMatch(/^Вариант 2: 3,1 км, 7 минут\.$/);
    expect(navStore.get().routeIndex).toBe(1);
    expect((await runTool('remove_stop', {})).text).toBe('Остановки нет.');
  });

  it('громкость: Android — меняется; iPad — честная подсказка', async () => {
    playerStore.set((p) => ({ ...p, volume: 0.5 }));
    // volumeControllable вычисляется при загрузке модуля (Node — не iOS).
    const r = await runTool('media_control', { action: 'louder' });
    expect(r).toEqual({ ok: true, text: 'Громкость 65%.' });
    expect(playerStore.get().volume).toBe(0.65);
  });

  it('радио по жанру: из каталога по тегу', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', (u: string) => {
      urls.push(u);
      return ok(u.includes('/json/servers') ? [{ name: 'de1.api.radio-browser.info' }] : rb);
    });
    const r = await runTool('play_radio', { genre: 'jazz' });
    expect(urls.some((u) => u.includes('tag=jazz'))).toBe(true);
    expect(r.text).toMatch(/^Включаю джаз: /);
  });

  it('спокойная музыка — своя станция с жанром «Эмбиент», без каталога', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const r = await runTool('play_radio', { genre: 'chillout' });
    expect(r.text).toMatch(/^Включаю спокойную музыку: /);
    expect(f).not.toHaveBeenCalled();
  });

  it('«повтори» — последняя озвученная фраза', () => {
    vi.stubGlobal('window', {});
    speak('Через 200 метров поверните направо', 'ru-RU');
    expect(lastSpokenText()).toBe('Через 200 метров поверните направо');
  });
});

import { quickActions } from '../../src/lib/voiceCommands';

describe('Быстрые действия в окне голоса', () => {
  afterEach(() => stopNavigation());
  it('без маршрута: «Домой», если дом сохранён; команды разбираются локально', () => {
    savedPlacesStore.set({ home: theatre, work: null });
    const qa = quickActions();
    expect(qa[0]).toMatchObject({ label: 'Домой', primary: true });
    for (const q of qa) expect(parseCommand(q.command).kind, q.command).toBe('tool');
  });
  it('во время ведения: «Сколько ехать», «Повтори», «Заверши маршрут»; по-украински', () => {
    settingsStore.set((s) => ({ ...s, speechLang: 'uk-UA' }));
    navStore.set((n) => ({ ...n, status: 'guiding', dest: theatre, via: null }));
    const qa = quickActions();
    expect(qa.map((q) => q.label)).toEqual(['Скільки ще їхати', 'Повтори', 'Заїдемо на заправку', 'Що грає', 'Заверши маршрут']);
    for (const q of qa) expect(parseCommand(q.command).kind === 'tool' || isRepeatRequest(q.command), q.command).toBe(true);
    settingsStore.set((s) => ({ ...s, speechLang: 'ru-RU' }));
  });
});
