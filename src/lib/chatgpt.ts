/* ChatGPT по существующей подписке пользователя — без API и без встраивания.
   Открываем официальный адрес chatgpt.com обычной ссылкой (новое окно):
   - iPad/iPhone с приложением ChatGPT — iOS открывает приложение (универсальная ссылка);
   - без приложения — сайт ChatGPT в Safari, вход в свою учётную запись;
   - Android — приложение ChatGPT (App Links) или браузер.
   Встраивание сайта (iframe) не используется: OpenAI его запрещает, а вход и голос там не работают. */
import { createStore } from './store';
import { playerStore } from './player';
import { toast } from './state';

export const CHATGPT_URL = 'https://chatgpt.com/';

/** Подсказка «как вернуться» показывается, пока пользователь её не отключит. */
export const chatgptPrefsStore = createStore<{ hintSeen: boolean; voiceShortcut: string }>(
  { hintSeen: false, voiceShortcut: '' },
  'chatgpt',
);

/** Ссылка на быструю команду iOS (приложение «Команды»), запускающую голосовой режим ChatGPT. */
export function shortcutUrl(name: string): string | null {
  const n = name.trim();
  return n ? `shortcuts://run-shortcut?name=${encodeURIComponent(n)}` : null;
}

export type Platform = 'ios' | 'android' | 'other';

export function platform(ua = typeof navigator !== 'undefined' ? navigator.userAgent : '', touchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0): Platform {
  if (/iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'other';
}

/** Как вернуться в AI Car Expert — по платформе. */
export function isIpad(ua = typeof navigator !== 'undefined' ? navigator.userAgent : '', touchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0) {
  return /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
}

export function returnHint(p: Platform = platform(), ipad = isIpad()): string[] {
  if (p === 'ios') {
    return [
      'Нажмите «◀ AI Car Expert» или «◀ Safari» в левом верхнем углу экрана, если он показан.',
      ipad
        ? 'Или смахните вверх от нижнего края и выберите AI Car Expert — удобно держать его в Dock.'
        : 'Или смахните по нижней полоске экрана вправо — вернётся предыдущее приложение.',
      ...(ipad ? ['На iPad можно открыть ChatGPT в Split View рядом с картой: потяните его из Dock к краю экрана.'] : []),
    ];
  }
  if (p === 'android') {
    return ['Нажмите «Назад» или выберите AI Car Expert в списке недавних приложений.'];
  }
  return ['ChatGPT откроется в новой вкладке — вернитесь на вкладку AI Car Expert.'];
}

/* ---------- Уход и возвращение ---------- */

const LEFT_KEY = 'ace:left-for-chatgpt';

export function markLeaving() {
  try {
    sessionStorage.setItem(LEFT_KEY, JSON.stringify({ at: Date.now(), playing: playerStore.get().playing }));
  } catch {
    /* хранилище недоступно — просто без приветствия при возврате */
  }
}

/** Вызывается при возвращении на страницу: короткое подтверждение, что всё на месте. */
export function onReturn(): boolean {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(LEFT_KEY);
    sessionStorage.removeItem(LEFT_KEY);
  } catch {
    return false;
  }
  if (!raw) return false;
  const { at, playing } = JSON.parse(raw) as { at: number; playing: boolean };
  if (Date.now() - at < 1500) return false; // переход не состоялся
  const radioPaused = playing && !playerStore.get().playing;
  toast(radioPaused ? 'С возвращением. Маршрут сохранён; радио на паузе — нажмите ▶, чтобы продолжить.' : 'С возвращением. Маршрут и музыка на месте.', 'ok');
  return true;
}
