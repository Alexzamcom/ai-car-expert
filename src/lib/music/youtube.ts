/* YouTube Music: открытие официального приложения или сайта без API, без iframe.
   AI Car Expert не получает от YouTube Music ни состояния, ни управления — только открывает его. */
import { createStore } from '../store';
import { pause, playerStore } from '../player';
import { settingsStore, toast } from '../state';
import { markLeaving } from '../handoff';
import { platform, type Platform } from '../chatgpt';
import { setActiveSource } from './sources';

export const YTM_URL = 'https://music.youtube.com/';
/** Схема официального приложения YouTube Music на iOS/iPadOS. */
export const YTM_APP_SCHEME = 'youtubemusic://';

export type LaunchPlan = { kind: 'scheme'; url: string; fallback: string } | { kind: 'link'; url: string };

/** Как открывать на этой платформе.
    iOS: из веб-приложения https-ссылка открывает браузер, поэтому сначала пробуем схему приложения,
    а если оно не открылось — предлагаем сайт. Android: https-ссылку перехватывает установленное
    приложение (App Links), иначе открывается браузер. */
export function launchPlan(p: Platform, mode: 'app' | 'browser'): LaunchPlan {
  if (p === 'ios' && mode === 'app') return { kind: 'scheme', url: YTM_APP_SCHEME, fallback: YTM_URL };
  return { kind: 'link', url: YTM_URL };
}

/** Показать предложение открыть сайт, если приложение не открылось. */
export const ytmFallbackStore = createStore(false);

const FALLBACK_DELAY = 1600;

/** Подготовка к уходу: не играть одновременно с YouTube Music. */
function prepareLeave() {
  if (playerStore.get().playing) pause();
  setActiveSource('youtube-music');
  markLeaving('youtube-music');
}

/** Попытка открыть приложение по схеме; если страница осталась на экране — предложить сайт. */
function tryScheme(url: string) {
  let left = false;
  const onHide = () => {
    if (document.visibilityState === 'hidden') left = true;
  };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onHide);
  try {
    window.location.href = url;
  } catch {
    /* неизвестная схема — покажем запасной вариант */
  }
  setTimeout(() => {
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', onHide);
    if (!left && document.visibilityState === 'visible') ytmFallbackStore.set(true);
  }, FALLBACK_DELAY);
}

export function currentPlan(): LaunchPlan {
  return launchPlan(platform(), settingsStore.get().ytmOpenMode);
}

/** Обработчик нажатия на ссылку/кнопку YouTube Music (ссылка ведёт на https://music.youtube.com/). */
export function onYouTubeMusicClick(e: { preventDefault(): void }) {
  const plan = currentPlan();
  prepareLeave();
  if (plan.kind === 'scheme') {
    e.preventDefault();
    tryScheme(plan.url);
  }
  // kind === 'link' — браузер сам откроет ссылку из нажатия (target=_blank)
}

/** Открыть без нажатия (голос, Grok). Окно браузера без жеста пользователя может быть заблокировано. */
export function openYouTubeMusic(): string {
  const plan = currentPlan();
  prepareLeave();
  if (plan.kind === 'scheme') {
    tryScheme(plan.url);
    return 'Открываю YouTube Music. Треки выбираются в самом приложении.';
  }
  window.open(plan.url, '_blank', 'noopener');
  toast('Если YouTube Music не открылся, нажмите кнопку YouTube Music в разделе «Музыка».', 'info');
  return 'Открываю YouTube Music. Треки выбираются в самом приложении.';
}
