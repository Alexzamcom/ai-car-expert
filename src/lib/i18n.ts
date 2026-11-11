/* Язык коротких ответов приложения: по языку речи в настройках (русский или украинский). */
import { settingsStore } from './state';

export type UiLang = 'ru' | 'uk';

export function uiLang(): UiLang {
  return settingsStore.get().speechLang.startsWith('uk') ? 'uk' : 'ru';
}

/** Фраза на языке пользователя: L('Готово.', 'Готово.'). */
export function L(ru: string, uk: string): string {
  return uiLang() === 'uk' ? uk : ru;
}
