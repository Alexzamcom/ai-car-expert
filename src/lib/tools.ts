/* Действия, которые помощник (OpenAI или Grok) может выполнять в приложении.
   Описаны в формате function calling (Chat Completions). Те же функции вызывают локальные голосовые команды —
   одна реализация для облака и для офлайна.
   Управления системами автомобиля здесь нет и не будет без отдельной проверки безопасности. */
import { openSection, settingsStore, serviceStore, nextServiceEstimate, upsertServiceRecord, SERVICE_CATEGORIES, type ServiceCategory } from './state';
import {
  navigateToQuery,
  stopNavigation,
  findPoi,
  navStore,
  poiStore,
  startGuidance,
  addStop,
  placeFromPoi,
  searchPlaces,
  currentPos,
  pickPoint,
} from './nav';
import { playByQuery, pause, resume, next, prev, stop, playerStore } from './player';
import { findApp, launchApp, APPS } from './apps';
import { openYouTubeMusic, ytmControlHint } from './music/youtube';
import { setActiveSource, musicStore } from './music/sources';
import { decodeDtc, dtcSummary } from './dtc';
import { searchFacts, STATUS_LABEL } from './knowledge';
import { fmtDistance, haversine } from './routing';
import { addReminder, activeReminders, isDue, reminderLabel } from './reminders';
import { L, uiLang } from './i18n';
import type { PoiCategory } from './poi';
import type { SectionId } from './sections';

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

const fn = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): ToolDef => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

const POI_ENUM = ['fuel', 'rest', 'food', 'parking'];

export const TOOLS: ToolDef[] = [
  fn('navigate_to', 'Найти место по названию или адресу и построить автомобильный маршрут на встроенной карте.', { destination: { type: 'string', description: 'Адрес или название места' } }, ['destination']),
  fn('search_places', 'Найти места по запросу без построения маршрута (показать на карте, сравнить варианты).', { query: { type: 'string' } }, ['query']),
  fn('add_stop', 'Добавить промежуточную остановку к текущему маршруту: по адресу/названию или ближайший объект категории по пути.', {
    query: { type: 'string', description: 'Адрес или название (если не категория)' },
    category: { type: 'string', enum: POI_ENUM, description: 'Категория объекта по пути' },
  }),
  fn('start_navigation', 'Начать ведение по уже построенному маршруту.'),
  fn('stop_navigation', 'Завершить маршрут.'),
  fn('find_along_route', 'Найти объекты по маршруту (если он есть) или рядом и показать список.', { category: { type: 'string', enum: POI_ENUM } }, ['category']),
  fn('play_radio', 'Включить интернет-радио. Без названия — продолжить последнюю станцию.', { station: { type: 'string', description: 'Название станции (необязательно)' } }),
  fn('open_music_service', 'Открыть музыкальный источник: встроенное интернет-радио или приложение YouTube Music. Выбрать трек в YouTube Music нельзя.', {
    service: { type: 'string', enum: ['radio', 'youtube-music'] },
  }, ['service']),
  fn('play_music', 'Включить музыку из предпочитаемого источника пользователя.'),
  fn('media_control', 'Управление встроенным интернет-радио. YouTube Music этим не управляется — для него подскажи системные способы (Siri / Google Ассистент, Пункт управления / шторка, кнопки на руле).', { action: { type: 'string', enum: ['play', 'pause', 'next', 'previous', 'stop'] } }, ['action']),
  fn('open_section', 'Открыть раздел интерфейса.', {
    section: { type: 'string', enum: ['navigation', 'media', 'assistant', 'apps', 'trip', 'vehicle', 'manual', 'service', 'diagnostics', 'settings'] },
  }, ['section']),
  fn('open_app', 'Открыть стороннее приложение на устройстве (уводит AI Car Expert в фон).', { app: { type: 'string', enum: APPS.map((a) => a.id) } }, ['app']),
  fn('service_status', 'Сервис: когда следующее ТО, последние работы и напоминания со сроком.'),
  fn('add_service_record', 'Записать выполненную работу в журнал обслуживания (только если водитель прямо сказал, что работа сделана).', {
    category: { type: 'string', enum: Object.keys(SERVICE_CATEGORIES) },
    title: { type: 'string', description: 'Что сделано' },
    odometer_km: { type: 'number', description: 'Пробег, км (если назван)' },
    date: { type: 'string', description: 'YYYY-MM-DD, по умолчанию сегодня' },
  }, ['category']),
  fn('add_reminder', 'Создать сервисное напоминание на дату и/или пробег.', {
    text: { type: 'string', description: 'О чём напомнить' },
    due_date: { type: 'string', description: 'YYYY-MM-DD' },
    due_km: { type: 'number', description: 'Пробег, км' },
  }, ['text']),
  fn('set_voice_replies', 'Включить или выключить голосовые ответы помощника.', { enabled: { type: 'boolean' } }, ['enabled']),
  fn('set_navigation_voice', 'Включить или выключить голосовые подсказки навигации.', { enabled: { type: 'boolean' } }, ['enabled']),
  fn('set_theme', 'Тема оформления: день, ночь или автоматически по солнцу.', { mode: { type: 'string', enum: ['auto', 'day', 'night'] } }, ['mode']),
  fn('decode_dtc', 'Расшифровать код ошибки OBD-II.', { code: { type: 'string' } }, ['code']),
  fn('lookup_vehicle_knowledge', 'Поиск в базе знаний об автомобиле владельца. Возвращает факты со статусом достоверности.', { query: { type: 'string' } }, ['query']),
  fn('get_status', 'Текущее состояние: маршрут, музыка, геопозиция.'),
];

export type ToolResult = { ok: boolean; text: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function serviceStatusText(now = new Date()): string {
  const s = settingsStore.get();
  const est = nextServiceEstimate(serviceStore.get(), s.vehicle);
  const parts: string[] = [];
  if (!est) parts.push(L('Записей о плановом ТО нет — добавьте последнее ТО в разделе «Сервис».', 'Записів про планове ТО немає — додайте останнє ТО в розділі «Сервіс».'));
  else {
    const date = est.dueDate.toLocaleDateString(uiLang() === 'uk' ? 'uk-UA' : 'ru-RU');
    const km = est.dueKm != null ? L(` или при пробеге ${est.dueKm.toLocaleString('ru-RU')} км`, ` або на пробігу ${est.dueKm.toLocaleString('uk-UA')} км`) : '';
    parts.push(est.daysLeft < 0 || (est.kmLeft != null && est.kmLeft < 0) ? L(`ТО просрочено: срок был ${date}${km}.`, `ТО прострочено: термін був ${date}${km}.`) : L(`Следующее ТО — ${date}${km}.`, `Наступне ТО — ${date}${km}.`));
  }
  const due = activeReminders(now).filter((r) => isDue(r, now));
  if (due.length) parts.push(L(`Срок наступил: ${due.map(reminderLabel).join('; ')}.`, `Настав термін: ${due.map(reminderLabel).join('; ')}.`));
  return parts.join(' ');
}

/** Выполнить вызов инструмента. Возвращает текст результата для модели и для озвучивания. */
export async function runTool(name: string, rawArgs: string | Record<string, unknown>): Promise<ToolResult> {
  let args: Record<string, unknown> = {};
  try {
    args = typeof rawArgs === 'string' ? (rawArgs ? JSON.parse(rawArgs) : {}) : rawArgs;
  } catch {
    return { ok: false, text: 'Некорректные аргументы' };
  }
  const str = (k: string) => String(args[k] ?? '').trim();
  const numArg = (k: string) => (typeof args[k] === 'number' && Number.isFinite(args[k]) ? Math.round(args[k] as number) : null);

  switch (name) {
    case 'navigate_to': {
      if (!str('destination')) return { ok: false, text: L('Куда ехать?', 'Куди їхати?') };
      openSection('navigation');
      return navigateToQuery(str('destination'));
    }
    case 'search_places': {
      const q = str('query');
      if (!q) return { ok: false, text: L('Что искать?', 'Що шукати?') };
      openSection('navigation');
      const pos = currentPos();
      const res = await searchPlaces(q, pos ?? undefined);
      if (!res.length) return { ok: false, text: L(`Ничего не нашёл по запросу «${q}».`, `Нічого не знайшов за запитом «${q}».`) };
      void pickPoint(res[0], 'search', res[0]);
      const list = res
        .slice(0, 5)
        .map((p, i) => `${i + 1}) ${p.name}${p.address ? `, ${p.address}` : ''}${pos ? ` — ${fmtDistance(haversine(pos, p))}` : ''}`)
        .join('; ');
      return { ok: true, text: L(`Нашёл ${res.length}: ${list}. Первый показан на карте.`, `Знайшов ${res.length}: ${list}. Перший показано на мапі.`) };
    }
    case 'add_stop': {
      const cat = str('category') as PoiCategory;
      const q = str('query');
      openSection('navigation');
      if (POI_ENUM.includes(cat)) {
        await findPoi(cat);
        const p = poiStore.get();
        if (!p.items.length) return { ok: false, text: p.error ?? L('По пути ничего не нашёл.', 'По дорозі нічого не знайшов.') };
        const stopPlace = placeFromPoi(p.items[0]);
        await addStop(stopPlace);
        poiStore.set({ ...poiStore.get(), category: null, items: [] });
        return stopResult(stopPlace.name);
      }
      if (!q) return { ok: false, text: L('Какую остановку добавить?', 'Яку зупинку додати?') };
      const res = await searchPlaces(q, currentPos() ?? undefined);
      if (!res.length) return { ok: false, text: L(`Не нашёл «${q}».`, `Не знайшов «${q}».`) };
      await addStop(res[0]);
      return stopResult(res[0].name);
    }
    case 'start_navigation':
      if (!navStore.get().route) return { ok: false, text: L('Маршрут ещё не построен.', 'Маршрут ще не побудовано.') };
      startGuidance();
      return { ok: true, text: L('Ведение по маршруту начато.', 'Ведення маршрутом розпочато.') };
    case 'stop_navigation':
      stopNavigation();
      return { ok: true, text: L('Маршрут завершён.', 'Маршрут завершено.') };
    case 'find_along_route': {
      const cat = str('category') as PoiCategory;
      if (!POI_ENUM.includes(cat)) return { ok: false, text: 'Неизвестная категория' };
      openSection('navigation');
      await findPoi(cat);
      const p = poiStore.get();
      if (p.error) return { ok: false, text: p.error };
      const top = p.items.slice(0, 3).map((x) => `${x.name}${x.alongM != null ? ` ${L('через', 'через')} ${fmtDistance(Math.max(0, x.alongM))}` : x.distanceM != null ? ` ${L('в', 'за')} ${fmtDistance(x.distanceM)}` : ''}`);
      return { ok: true, text: L(`Найдено ${p.items.length}. Ближайшие: ${top.join('; ')}. Список на карте.`, `Знайдено ${p.items.length}. Найближчі: ${top.join('; ')}. Список на мапі.`) };
    }
    case 'play_radio':
      openSection('media');
      return playByQuery(str('station'));
    case 'open_music_service': {
      const svc = str('service');
      if (svc === 'youtube-music') return { ok: true, text: openYouTubeMusic() };
      if (svc === 'radio') {
        setActiveSource('radio');
        openSection('media');
        return playByQuery('');
      }
      return { ok: false, text: L('Этот музыкальный сервис пока не подключён.', 'Цей музичний сервіс ще не підключено.') };
    }
    case 'play_music':
      if (settingsStore.get().preferredMusic === 'youtube-music') return { ok: true, text: openYouTubeMusic() };
      openSection('media');
      return playByQuery('');
    case 'media_control': {
      const a = str('action');
      // Пока активен YouTube Music, команды не трогают встроенное радио: иначе «играй» включило бы его
      // поверх YouTube Music, а «пауза» ответила бы «готово», ничего не сделав с YouTube Music.
      if (musicStore.get().active === 'youtube-music' && !playerStore.get().playing) {
        return { ok: false, text: ytmControlHint() };
      }
      if (a === 'play') resume();
      else if (a === 'pause') pause();
      else if (a === 'next') next();
      else if (a === 'previous') prev();
      else if (a === 'stop') stop();
      else return { ok: false, text: 'Неизвестное действие' };
      return { ok: true, text: L('Готово.', 'Готово.') };
    }
    case 'open_section':
      openSection(str('section') as SectionId);
      return { ok: true, text: L('Открыто.', 'Відкрито.') };
    case 'open_app': {
      const app = findApp(str('app'));
      if (!app) return { ok: false, text: L('Приложение не найдено в списке.', 'Застосунок не знайдено в списку.') };
      if (app.id === 'youtubemusic') return { ok: true, text: openYouTubeMusic() };
      if (app.id === 'chatgpt') {
        launchApp(app);
        return { ok: true, text: L('Открываю ChatGPT. Если окно не открылось, нажмите кнопку ChatGPT внизу экрана.', 'Відкриваю ChatGPT. Якщо вікно не відкрилося, натисніть кнопку ChatGPT унизу екрана.') };
      }
      setTimeout(() => launchApp(app), 1200); // даём договорить ответ
      return { ok: true, text: L(`Открываю ${app.name}. Если приложение не установлено, ничего не произойдёт.`, `Відкриваю ${app.name}. Якщо застосунок не встановлено, нічого не станеться.`) };
    }
    case 'service_status':
      return { ok: true, text: serviceStatusText() };
    case 'add_service_record': {
      const cat = str('category') as ServiceCategory;
      if (!(cat in SERVICE_CATEGORIES)) return { ok: false, text: 'Неизвестная категория работ' };
      const date = DATE_RE.test(str('date')) ? str('date') : new Date().toISOString().slice(0, 10);
      const km = numArg('odometer_km');
      upsertServiceRecord({ date, odometerKm: km, category: cat, title: str('title'), cost: null, workshop: '', notes: L('Добавлено голосом', 'Додано голосом') });
      return {
        ok: true,
        text: L(`Записал в журнал: ${SERVICE_CATEGORIES[cat]}${km != null ? `, ${km} км` : ''}, ${date}.`, `Записав у журнал: ${SERVICE_CATEGORIES[cat]}${km != null ? `, ${km} км` : ''}, ${date}.`),
      };
    }
    case 'add_reminder': {
      const text = str('text');
      if (!text) return { ok: false, text: L('О чём напомнить?', 'Про що нагадати?') };
      const dueDate = DATE_RE.test(str('due_date')) ? str('due_date') : null;
      const dueKm = numArg('due_km');
      const r = addReminder({ text, dueDate, dueKm });
      return { ok: true, text: L(`Напоминание: ${reminderLabel(r)}.`, `Нагадування: ${reminderLabel(r)}.`) };
    }
    case 'set_voice_replies':
      settingsStore.set((s) => ({ ...s, speakReplies: Boolean(args.enabled) }));
      return { ok: true, text: args.enabled ? L('Голосовые ответы включены.', 'Голосові відповіді увімкнено.') : L('Голосовые ответы выключены.', 'Голосові відповіді вимкнено.') };
    case 'set_navigation_voice':
      settingsStore.set((s) => ({ ...s, speakNavigation: Boolean(args.enabled) }));
      return { ok: true, text: args.enabled ? L('Подсказки навигации включены.', 'Підказки навігації увімкнено.') : L('Подсказки навигации выключены.', 'Підказки навігації вимкнено.') };
    case 'set_theme': {
      const mode = str('mode') as 'auto' | 'day' | 'night';
      if (!['auto', 'day', 'night'].includes(mode)) return { ok: false, text: 'Неизвестный режим темы' };
      settingsStore.set((s) => ({ ...s, theme: mode }));
      return {
        ok: true,
        text:
          mode === 'auto'
            ? L('Тема переключается автоматически.', 'Тема перемикається автоматично.')
            : mode === 'day'
              ? L('Включена дневная тема.', 'Увімкнено денну тему.')
              : L('Включена ночная тема.', 'Увімкнено нічну тему.'),
      };
    }
    case 'decode_dtc':
      return { ok: true, text: dtcSummary(decodeDtc(str('code'))) };
    case 'lookup_vehicle_knowledge': {
      const facts = searchFacts(str('query'));
      if (!facts.length) return { ok: true, text: 'В базе знаний об этом автомобиле ничего не найдено. Данных нет — так и скажи.' };
      return { ok: true, text: facts.map((f) => `${f.title} [${STATUS_LABEL[f.status]}]: ${f.text}`).join('\n') };
    }
    case 'get_status': {
      const n = navStore.get();
      const p = playerStore.get();
      return {
        ok: true,
        text: [
          n.dest ? `Маршрут до ${n.dest.name}, статус ${n.status}${n.progress ? `, осталось ${fmtDistance(n.progress.remainingM)}` : ''}.` : 'Маршрута нет.',
          p.current ? `Музыка: ${p.current.title}, ${p.playing ? 'играет' : 'пауза'}.` : 'Музыка не играет.',
        ].join(' '),
      };
    }
    default:
      return { ok: false, text: `Инструмент ${name} недоступен.` };
  }
}

function stopResult(name: string): ToolResult {
  const s = navStore.get();
  if (s.error) return { ok: false, text: s.error };
  if (!s.via) return { ok: true, text: L(`Маршрут до «${name}».`, `Маршрут до «${name}».`) };
  return { ok: true, text: L(`Остановка «${name}» добавлена в маршрут.`, `Зупинку «${name}» додано до маршруту.`) };
}
