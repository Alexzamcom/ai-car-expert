/* Действия, которые помощник (Grok) может выполнять в приложении.
   Описаны в формате function calling (совместим с xAI/OpenAI Chat Completions).
   Управления системами автомобиля здесь нет и не будет без отдельной проверки безопасности. */
import { openSection, settingsStore } from './state';
import { navigateToQuery, stopNavigation, findPoi, navStore, poiStore, startGuidance } from './nav';
import { playByQuery, pause, resume, next, prev, stop, playerStore } from './player';
import { findApp, launchApp, APPS } from './apps';
import { openYouTubeMusic } from './music/youtube';
import { setActiveSource } from './music/sources';
import { decodeDtc, dtcSummary } from './dtc';
import { searchFacts, STATUS_LABEL } from './knowledge';
import { fmtDistance } from './routing';
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

export const TOOLS: ToolDef[] = [
  fn('navigate_to', 'Найти место по названию или адресу и построить маршрут на встроенной карте.', { destination: { type: 'string', description: 'Адрес или название места' } }, ['destination']),
  fn('start_navigation', 'Начать ведение по уже построенному маршруту.'),
  fn('stop_navigation', 'Завершить маршрут.'),
  fn('find_along_route', 'Найти объекты по маршруту (если он есть) или рядом.', { category: { type: 'string', enum: ['fuel', 'rest', 'food', 'parking'] } }, ['category']),
  fn('play_radio', 'Включить радио. Без названия — продолжить последнюю станцию.', { station: { type: 'string', description: 'Название станции (необязательно)' } }),
  fn('open_music_service', 'Открыть музыкальный источник: встроенное интернет-радио или приложение YouTube Music. Выбрать трек в YouTube Music нельзя.', {
    service: { type: 'string', enum: ['radio', 'youtube-music'] },
  }, ['service']),
  fn('play_music', 'Включить музыку из предпочитаемого источника пользователя.'),
  fn('media_control', 'Управление воспроизведением.', { action: { type: 'string', enum: ['play', 'pause', 'next', 'previous', 'stop'] } }, ['action']),
  fn('open_section', 'Открыть раздел интерфейса.', {
    section: { type: 'string', enum: ['navigation', 'media', 'assistant', 'apps', 'trip', 'vehicle', 'manual', 'service', 'diagnostics', 'settings'] },
  }, ['section']),
  fn('open_app', 'Открыть стороннее приложение на устройстве (уводит AI Car Expert в фон).', { app: { type: 'string', enum: APPS.map((a) => a.id) } }, ['app']),
  fn('set_voice_replies', 'Включить или выключить голосовые ответы помощника.', { enabled: { type: 'boolean' } }, ['enabled']),
  fn('set_navigation_voice', 'Включить или выключить голосовые подсказки навигации.', { enabled: { type: 'boolean' } }, ['enabled']),
  fn('set_theme', 'Тема оформления: день, ночь или автоматически по солнцу.', { mode: { type: 'string', enum: ['auto', 'day', 'night'] } }, ['mode']),
  fn('decode_dtc', 'Расшифровать код ошибки OBD-II.', { code: { type: 'string' } }, ['code']),
  fn('lookup_vehicle_knowledge', 'Поиск в базе знаний об автомобиле владельца. Возвращает факты со статусом достоверности.', { query: { type: 'string' } }, ['query']),
  fn('get_status', 'Текущее состояние: маршрут, музыка, геопозиция.'),
];

export type ToolResult = { ok: boolean; text: string };

/** Выполнить вызов инструмента. Возвращает текст результата для модели. */
export async function runTool(name: string, rawArgs: string | Record<string, unknown>): Promise<ToolResult> {
  let args: Record<string, unknown> = {};
  try {
    args = typeof rawArgs === 'string' ? (rawArgs ? JSON.parse(rawArgs) : {}) : rawArgs;
  } catch {
    return { ok: false, text: 'Некорректные аргументы' };
  }
  const str = (k: string) => String(args[k] ?? '').trim();

  switch (name) {
    case 'navigate_to': {
      openSection('navigation');
      return navigateToQuery(str('destination'));
    }
    case 'start_navigation':
      if (!navStore.get().route) return { ok: false, text: 'Маршрут ещё не построен.' };
      startGuidance();
      return { ok: true, text: 'Ведение по маршруту начато.' };
    case 'stop_navigation':
      stopNavigation();
      return { ok: true, text: 'Маршрут завершён.' };
    case 'find_along_route': {
      const cat = str('category') as PoiCategory;
      if (!['fuel', 'rest', 'food', 'parking'].includes(cat)) return { ok: false, text: 'Неизвестная категория' };
      openSection('navigation');
      await findPoi(cat);
      const p = poiStore.get();
      if (p.error) return { ok: false, text: p.error };
      const top = p.items.slice(0, 3).map((x) => `${x.name}${x.alongM != null ? ` через ${fmtDistance(Math.max(0, x.alongM))}` : x.distanceM != null ? ` в ${fmtDistance(x.distanceM)}` : ''}`);
      return { ok: true, text: `Найдено ${p.items.length}. Ближайшие: ${top.join('; ')}. Список на карте.` };
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
      return { ok: false, text: 'Этот музыкальный сервис пока не подключён.' };
    }
    case 'play_music':
      if (settingsStore.get().preferredMusic === 'youtube-music') return { ok: true, text: openYouTubeMusic() };
      openSection('media');
      return playByQuery('');
    case 'media_control': {
      const a = str('action');
      if (a === 'play') resume();
      else if (a === 'pause') pause();
      else if (a === 'next') next();
      else if (a === 'previous') prev();
      else if (a === 'stop') stop();
      else return { ok: false, text: 'Неизвестное действие' };
      return { ok: true, text: 'Готово.' };
    }
    case 'open_section':
      openSection(str('section') as SectionId);
      return { ok: true, text: 'Открыто.' };
    case 'open_app': {
      const app = findApp(str('app'));
      if (!app) return { ok: false, text: 'Приложение не найдено в списке.' };
      if (app.id === 'youtubemusic') return { ok: true, text: openYouTubeMusic() };
      if (app.id === 'chatgpt') {
        launchApp(app);
        return { ok: true, text: 'Открываю ChatGPT. Если окно не открылось, нажмите кнопку ChatGPT внизу экрана.' };
      }
      setTimeout(() => launchApp(app), 1200); // даём договорить ответ
      return { ok: true, text: `Открываю ${app.name}. Если приложение не установлено, ничего не произойдёт.` };
    }
    case 'set_voice_replies':
      settingsStore.set((s) => ({ ...s, speakReplies: Boolean(args.enabled) }));
      return { ok: true, text: args.enabled ? 'Голосовые ответы включены.' : 'Голосовые ответы выключены.' };
    case 'set_navigation_voice':
      settingsStore.set((s) => ({ ...s, speakNavigation: Boolean(args.enabled) }));
      return { ok: true, text: args.enabled ? 'Подсказки навигации включены.' : 'Подсказки навигации выключены.' };
    case 'set_theme': {
      const mode = str('mode') as 'auto' | 'day' | 'night';
      if (!['auto', 'day', 'night'].includes(mode)) return { ok: false, text: 'Неизвестный режим темы' };
      settingsStore.set((s) => ({ ...s, theme: mode }));
      return { ok: true, text: mode === 'auto' ? 'Тема переключается автоматически.' : mode === 'day' ? 'Включена дневная тема.' : 'Включена ночная тема.' };
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
