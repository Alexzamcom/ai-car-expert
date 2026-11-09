/* Переход во внешнее приложение (ChatGPT, YouTube Music) и возвращение.
   Веб-приложение не получает событий от чужих приложений: всё, что мы знаем, — когда
   ушли, в какое приложение и что играло встроенное радио. */
import { createStore } from './store';
import { playerStore } from './player';

export type ExternalApp = 'chatgpt' | 'youtube-music';

export interface Handoff {
  app: ExternalApp;
  at: number;
  radioWasPlaying: boolean;
}

const KEY = 'ace:handoff';

/** Последний переход — для строки состояния «YouTube Music открыт в 14:03». */
export const lastHandoffStore = createStore<{ app: ExternalApp; at: number } | null>(null, 'last-handoff');

export function markLeaving(app: ExternalApp) {
  const h: Handoff = { app, at: Date.now(), radioWasPlaying: playerStore.get().playing };
  try {
    sessionStorage.setItem(KEY, JSON.stringify(h));
  } catch {
    /* без хранилища — просто без сообщения при возврате */
  }
  lastHandoffStore.set({ app, at: h.at });
}

/** Возвращение на страницу: запись о переходе (если он реально состоялся) или null. */
export function takeReturn(now = Date.now()): Handoff | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  const h = JSON.parse(raw) as Handoff;
  return now - h.at < 1500 ? null : h; // мгновенное «возвращение» — переход не состоялся
}
