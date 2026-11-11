import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import osrm from '../fixtures/osrm-route.json';
import nominatim from '../fixtures/nominatim.json';
import { parseCommand } from '../../src/lib/voiceCommands';
import { decideRoute, sendToAssistant, chatStore, chatBusyStore, systemPrompt, answerLocally, speechText } from '../../src/lib/assistant';
import { cloudBlock, currentUsage, recordUsage, usageStore, resetUsage, estimateCost } from '../../src/lib/ai/usage';
import { buildContext } from '../../src/lib/ai/context';
import { remindersStore, addReminder, isDue } from '../../src/lib/reminders';
import { runTool, TOOLS } from '../../src/lib/tools';
import { settingsStore, serviceStore, type Settings } from '../../src/lib/state';
import { geoStore, navStore, stopNavigation } from '../../src/lib/nav';
import { _resetThrottle } from '../../src/lib/geo/geocode';

const base = settingsStore.get();
const set = (p: Partial<Settings>) => settingsStore.set((s) => ({ ...s, ...p }));
const ok = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
const tool = (t: string) => {
  const c = parseCommand(t);
  return c.kind === 'tool' ? [c.name, c.args] : ['ask'];
};

beforeEach(() => {
  settingsStore.set({ ...base, speakReplies: false, aiEndpoint: '', aiMode: 'hybrid', speechLang: 'ru-RU' });
  resetUsage();
  remindersStore.set([]);
  serviceStore.set([]);
  chatStore.set([]);
  chatBusyStore.set(false);
  _resetThrottle();
  vi.stubGlobal('navigator', { onLine: true, userAgent: 'test' });
});
afterEach(() => {
  stopNavigation();
  vi.unstubAllGlobals();
});

describe('Гибридный маршрутизатор', () => {
  it('простые команды — локально (ru/uk), без платного API', () => {
    set({ aiEndpoint: 'https://proxy.test/chat' });
    for (const t of ['включи радио', 'увімкни радіо', 'маршрут до Киева', 'проклади маршрут до Львова', 'ночная тема', 'заедем на заправку', 'пауза', 'открой настройки']) {
      expect(decideRoute(t).kind, t).toBe('command');
    }
  });
  it('коды ошибок и срок ТО — локально; управление машиной — честный отказ', () => {
    set({ aiEndpoint: 'https://proxy.test/chat' });
    expect(decideRoute('что значит P0420').kind).toBe('local');
    expect(decideRoute('когда следующее ТО?').kind).toBe('local');
    expect(decideRoute('коли наступне ТО?').kind).toBe('local');
    expect(decideRoute('включи кондиционер').kind).toBe('refuse');
    expect(decideRoute('увімкни кондиціонер').kind).toBe('refuse');
  });
  it('сложный вопрос — в облако, если оно доступно; иначе — встроенная база', () => {
    const q = 'почему при холодном пуске двигатель троит и что проверить в первую очередь?';
    expect(decideRoute(q).kind).toBe('local'); // не подключено
    set({ aiEndpoint: 'https://proxy.test/chat' });
    expect(decideRoute(q).kind).toBe('cloud');
    set({ aiMode: 'local' });
    expect(decideRoute(q).kind).toBe('local');
  });
});

describe('Новые локальные команды', () => {
  it('остановка по пути: категория или адрес', () => {
    expect(tool('заедем на заправку')).toEqual(['add_stop', { category: 'fuel' }]);
    expect(tool('додай зупинку на АЗС')).toEqual(['add_stop', { category: 'fuel' }]);
    expect(tool('заїдемо в кафе')).toEqual(['add_stop', { category: 'food' }]);
    expect(tool('добавь остановку Ашан на Петровке')).toEqual(['add_stop', { query: 'ашан на петровке' }]);
  });
  it('поиск места без маршрута', () => {
    expect(tool('найди Театр Сатиры')).toEqual(['search_places', { query: 'театр сатиры' }]);
    expect(tool('знайди Хрещатик 22')).toEqual(['search_places', { query: 'хрещатик 22' }]);
    expect(tool('найди заправку')).toEqual(['find_along_route', { category: 'fuel' }]); // прежнее поведение
    expect(tool('покажи карту')).toEqual(['open_section', { section: 'navigation' }]);
  });
  it('напоминание: «через N км» только при известном пробеге', () => {
    expect(tool('напомни проверить шины')).toEqual(['add_reminder', { text: 'проверить шины' }]);
    expect(tool('напомни заменить масло через 5000 км')).toEqual(['ask']);
    set({ vehicle: { ...base.vehicle, odometerKm: 150000 } });
    expect(tool('напомни заменить масло через 5 000 км')).toEqual(['add_reminder', { text: 'заменить масло', due_km: 155000 }]);
    expect(tool('нагадай замінити мастило через 5000 км')).toEqual(['add_reminder', { text: 'замінити мастило', due_km: 155000 }]);
  });
});

describe('Расходы и ограничения', () => {
  const now = new Date('2026-11-11T10:00:00Z');
  it('причины, по которым облако недоступно', () => {
    expect(cloudBlock(now)).toBe('not-configured');
    set({ aiEndpoint: 'https://proxy.test/chat', aiMode: 'local' });
    expect(cloudBlock(now)).toBe('local-mode');
    set({ aiMode: 'hybrid' });
    expect(cloudBlock(now)).toBeNull();
    vi.stubGlobal('navigator', { onLine: false });
    expect(cloudBlock(now)).toBe('offline');
  });
  it('суточный лимит запросов', () => {
    set({ aiEndpoint: 'https://proxy.test/chat', aiDailyLimit: 2 });
    recordUsage('openai', { prompt_tokens: 100, completion_tokens: 10 }, 0, now);
    recordUsage('openai', { prompt_tokens: 100, completion_tokens: 10 }, 0, now);
    expect(cloudBlock(now)).toBe('daily-limit');
    // Новый день — снова можно.
    expect(cloudBlock(new Date('2026-11-12T10:00:00Z'))).toBeNull();
    expect(currentUsage(new Date('2026-11-12T10:00:00Z')).monthRequests).toBe(2);
    // Новый месяц — счётчики с нуля.
    expect(currentUsage(new Date('2026-12-01T10:00:00Z')).monthRequests).toBe(0);
  });
  it('месячный бюджет по ценам токенов', () => {
    set({ aiEndpoint: 'https://proxy.test/chat', aiDailyLimit: 0, aiMonthlyBudgetUsd: 1, aiPrices: { openai: { inUsd: 0.5, outUsd: 2 }, grok: { inUsd: 0, outUsd: 0 } } });
    expect(estimateCost('openai', 1_000_000, 100_000)).toBeCloseTo(0.7);
    expect(estimateCost('grok', 1000, 1000)).toBeNull();
    recordUsage('openai', { prompt_tokens: 1_000_000, completion_tokens: 100_000 }, 0, now);
    expect(cloudBlock(now)).toBeNull();
    recordUsage('openai', { prompt_tokens: 1_000_000, completion_tokens: 100_000 }, 0, now);
    expect(usageStore.get().monthCostUsd).toBeCloseTo(1.4);
    expect(cloudBlock(now)).toBe('budget');
  });
  it('без цен считаются токены, стоимость помечена как неполная', () => {
    recordUsage('grok', undefined, 4000, now);
    expect(usageStore.get()).toMatchObject({ monthTokensIn: 1000, monthCostUsd: 0, costUnknown: true });
  });
});

describe('Контекст для ИИ', () => {
  it('положение, маршрут, автомобиль, музыка, сервис, напоминания', () => {
    geoStore.set((g) => ({ ...g, status: 'watching', lat: 50.450123, lon: 30.523456, speedKmh: 62.4 }));
    serviceStore.set([{ id: '1', date: '2026-03-01', odometerKm: 140000, category: 'to', title: 'ТО-8', cost: null, workshop: '', notes: '' }]);
    addReminder({ text: 'Проверить шины', dueDate: '2026-11-01' });
    const ctx = buildContext(new Date('2026-11-11T10:00:00Z'));
    expect(ctx).toContain('≈50.450, 30.523');
    expect(ctx).toContain('скорость 62 км/ч');
    expect(ctx).toContain('Маршрут: нет');
    expect(ctx).toContain('Peugeot 3008');
    expect(ctx).toContain('интернет-радио');
    expect(ctx).toContain('Следующее ТО: ');
    expect(ctx).toContain('Проверить шины');
    expect(ctx).toContain('[срок наступил]');
    expect(ctx).not.toContain('50.450123'); // координаты округлены
  });
  it('местоположение можно не передавать', () => {
    geoStore.set((g) => ({ ...g, status: 'watching', lat: 50.45, lon: 30.52 }));
    set({ aiShareLocation: false });
    expect(buildContext()).toContain('координаты скрыты');
    expect(buildContext()).not.toContain('50.45');
  });
  it('промпт: короткие ответы, язык, контекст', () => {
    set({ speechLang: 'uk-UA' });
    const p = systemPrompt();
    expect(p).toContain('до 30 слов');
    expect(p).toContain('українською');
    expect(p).toContain('Текущее состояние:');
  });
});

describe('Инструменты', () => {
  it('описания для function calling: уникальные имена, допустимые для прокси', () => {
    const names = TOOLS.map((t) => t.function.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z_]{1,48}$/);
    expect(names).toEqual(expect.arrayContaining(['navigate_to', 'search_places', 'add_stop', 'service_status', 'add_service_record', 'add_reminder', 'play_radio', 'open_section']));
    expect(TOOLS.length).toBeLessThanOrEqual(32);
  });
  it('напоминание и срок', async () => {
    const r = await runTool('add_reminder', { text: 'Заменить масло', due_km: 155000, due_date: 'завтра' });
    expect(r.ok).toBe(true);
    const rem = remindersStore.get()[0];
    expect(rem).toMatchObject({ text: 'Заменить масло', dueKm: 155000, dueDate: null });
    expect(isDue(rem, new Date(), 154000)).toBe(false);
    expect(isDue(rem, new Date(), 155000)).toBe(true);
  });
  it('запись в журнал обслуживания и статус ТО', async () => {
    const r = await runTool('add_service_record', JSON.stringify({ category: 'to', title: 'ТО', odometer_km: 150000, date: '2026-11-01' }));
    expect(r.text).toContain('Плановое ТО');
    expect(serviceStore.get()[0]).toMatchObject({ category: 'to', odometerKm: 150000 });
    expect(settingsStore.get().vehicle.odometerKm).toBe(150000);
    expect((await runTool('service_status', {})).text).toMatch(/Следующее ТО — .*160\s000 км/);
    expect((await runTool('add_service_record', { category: 'magic' })).ok).toBe(false);
  });
  it('ответы на украинском', async () => {
    set({ speechLang: 'uk-UA' });
    expect((await runTool('set_theme', { mode: 'night' })).text).toBe('Увімкнено нічну тему.');
    expect(answerLocally('увімкни кондиціонер').text).toContain('Керувати системами');
  });
  it('остановка по адресу добавляется к маршруту', async () => {
    geoStore.set((g) => ({ ...g, status: 'watching', lat: 55.757, lon: 37.6156, accuracy: 10 }));
    vi.stubGlobal('fetch', (u: string) => ok(u.includes('nominatim') ? nominatim : osrm));
    await runTool('navigate_to', { destination: 'Театр Сатиры' });
    const r = await runTool('add_stop', { query: 'касса' });
    expect(r.ok).toBe(true);
    expect(navStore.get().via).not.toBeNull();
  });
  it('озвучивание без разметки и ссылок', () => {
    const t = speechText('**Готово**. Подробнее: https://example.com\n- пункт [статья](https://x.y)');
    expect(t.startsWith('Готово.')).toBe(true);
    expect(t).not.toMatch(/https?:|\*|\]\(/);
    expect(t).toContain('статья');
  });
});

describe('Облачный ИИ через прокси', () => {
  it('сложный вопрос → OpenAI вызывает инструмент → маршрут построен → короткий ответ; расход учтён', async () => {
    set({ aiEndpoint: 'https://proxy.test/chat', aiToken: 'tok', aiProvider: 'openai' });
    geoStore.set((g) => ({ ...g, status: 'watching', lat: 55.757, lon: 37.6156, accuracy: 10 }));
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', (u: string, init?: RequestInit) => {
      if (u.startsWith('https://proxy.test')) {
        const body = JSON.parse(String(init!.body));
        calls.push({ url: u, body });
        const hasTool = body.messages.some((m: { role: string }) => m.role === 'tool');
        return ok(
          hasTool
            ? { choices: [{ message: { content: 'Маршрут построен, около 6 минут.' } }], provider: 'openai', usage: { prompt_tokens: 900, completion_tokens: 12 } }
            : {
                choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'navigate_to', arguments: '{"destination":"Театр Сатиры"}' } }] } }],
                provider: 'openai',
                usage: { prompt_tokens: 850, completion_tokens: 20 },
              },
        );
      }
      return ok(u.includes('nominatim') ? nominatim : osrm);
    });
    const reply = await sendToAssistant('Отвези меня в театр, где играют сатиру, и скажи, сколько ехать');
    expect(reply).toMatchObject({ source: 'ai', provider: 'openai', text: 'Маршрут построен, около 6 минут.' });
    expect(reply!.actions![0]).toContain('Театр Сатиры');
    expect(navStore.get().route).not.toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls[0].body.provider).toBe('openai');
    expect((calls[0].body.messages as { content: string }[])[0].content).toContain('Текущее состояние:');
    expect(currentUsage()).toMatchObject({ dayRequests: 2, monthTokensIn: 1750, monthTokensOut: 32 });
  });
  it('простая команда не тратит запрос к облаку', async () => {
    set({ aiEndpoint: 'https://proxy.test/chat' });
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const reply = await sendToAssistant('ночная тема');
    expect(reply).toMatchObject({ source: 'local', text: 'Включена ночная тема.' });
    expect(f).not.toHaveBeenCalled();
    expect(currentUsage().dayRequests).toBe(0);
  });
  it('лимит сервера (429) — честное сообщение и ответ из встроенной базы', async () => {
    set({ aiEndpoint: 'https://proxy.test/chat', aiProvider: 'grok' });
    vi.stubGlobal('fetch', () => ok({ error: 'Суточный лимит запросов сервера исчерпан' }, 429));
    const reply = await sendToAssistant('Расскажи, чем отличается зимнее масло от летнего');
    expect(reply!.source).toBe('local');
    expect(reply!.text).toContain('Grok недоступен (Суточный лимит запросов сервера исчерпан)');
  });
  it('исчерпан дневной лимит — облако не вызывается', async () => {
    set({ aiEndpoint: 'https://proxy.test/chat', aiDailyLimit: 1 });
    recordUsage('openai', { prompt_tokens: 1, completion_tokens: 1 });
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const reply = await sendToAssistant('Как подготовить машину к зиме?');
    expect(f).not.toHaveBeenCalled();
    expect(reply!.source).toBe('local');
  });
});
