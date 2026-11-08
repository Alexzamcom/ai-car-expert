import type { SectionId } from './sections';
import { SECTIONS } from './sections';
import { openSection, toast } from './state';
import { sendToAssistant, isVehicleControlRequest, VEHICLE_CONTROL_REPLY } from './assistant';
import { pause, resume, next, prev } from './player';
import { navQueryStore } from './nav';
import { speak } from './speech';
import { settingsStore } from './state';

const SECTION_WORDS: [RegExp, SectionId][] = [
  [/(навигац|карт[ауеы]|маршрут)/, 'navigation'],
  [/(музык|радио|медиа|мультимеди|плеер)/, 'media'],
  [/(руководств|инструкц|справк)/, 'manual'],
  [/(истори|обслуживан|сервис|записи то)/, 'service'],
  [/(диагност|obd|обд)/, 'diagnostics'],
  [/(помощник|ассистент|чат)/, 'assistant'],
  [/(автомобил|машин[уа]|главн|домой экран)/, 'vehicle'],
  [/(настройк)/, 'settings'],
];

function say(text: string) {
  const { speakReplies, speechLang } = settingsStore.get();
  toast(text);
  if (speakReplies) speak(text, speechLang);
}

/**
 * Обработка голосовой команды. Простые команды выполняются сразу,
 * всё остальное отправляется AI-помощнику.
 */
export function handleVoiceCommand(raw: string) {
  const text = raw.toLowerCase().replace(/ё/g, 'е').trim();
  if (!text) return;

  if (isVehicleControlRequest(text)) {
    openSection('assistant');
    void sendToAssistant(raw);
    return;
  }

  const route = text.match(/(?:проложи маршрут|маршрут|поехали|едем|ехать|навигац\w* до|как доехать)\s+(?:до|в|на|к)?\s*(.+)/);
  if (route && route[1].length > 1) {
    openSection('navigation');
    navQueryStore.set({ query: route[1], nonce: Date.now() });
    return;
  }

  if (/^(пауза|стоп|останови|выключи (музыку|радио)|тише)/.test(text)) return pause();
  if (/^(следующ|дальше|переключи)/.test(text)) return next();
  if (/^(предыдущ|назад)/.test(text)) return prev();
  if (/^(включи|играй|продолжи)\s*(музык|радио)?/.test(text) && /(музык|радио|играй|продолжи)/.test(text)) {
    resume();
    openSection('media');
    return;
  }

  if (/^(открой|покажи|перейди|запусти|включи)/.test(text) || text.split(' ').length <= 2) {
    for (const [re, id] of SECTION_WORDS) {
      if (re.test(text)) {
        openSection(id);
        say(`Открываю: ${SECTIONS[id].title}`);
        return;
      }
    }
  }

  openSection('assistant');
  void sendToAssistant(raw);
}

export { VEHICLE_CONTROL_REPLY };
