/* Быстрый запуск сторонних приложений по URL-схемам.
   Веб-приложение не может проверить, установлено ли приложение, и не получает
   управления обратно — переход уводит AI Car Expert в фон. */
import type { IconName } from '../components/Icon';

export interface AppLink {
  id: string;
  name: string;
  group: 'nav' | 'music' | 'comm';
  icon: IconName;
  /** URL-схема приложения; web — запасной вариант в браузере. */
  href: string;
  web?: string;
}

export const APPS: AppLink[] = [
  { id: 'yandexnavi', name: 'Яндекс Навигатор', group: 'nav', icon: 'navigate', href: 'yandexnavi://' },
  { id: 'yandexmaps', name: 'Яндекс Карты', group: 'nav', icon: 'map', href: 'yandexmaps://', web: 'https://yandex.ru/maps/' },
  { id: 'googlemaps', name: 'Google Maps', group: 'nav', icon: 'map', href: 'comgooglemaps://', web: 'https://www.google.com/maps' },
  { id: 'applemaps', name: 'Apple Карты', group: 'nav', icon: 'map', href: 'maps://', web: 'https://maps.apple.com/' },
  { id: 'waze', name: 'Waze', group: 'nav', icon: 'navigate', href: 'waze://', web: 'https://waze.com/' },
  { id: '2gis', name: '2ГИС', group: 'nav', icon: 'map', href: 'dgis://' },
  { id: 'applemusic', name: 'Apple Музыка', group: 'music', icon: 'music', href: 'music://' },
  { id: 'spotify', name: 'Spotify', group: 'music', icon: 'music', href: 'spotify://', web: 'https://open.spotify.com/' },
  { id: 'yandexmusic', name: 'Яндекс Музыка', group: 'music', icon: 'music', href: 'yandexmusic://', web: 'https://music.yandex.ru/' },
  { id: 'youtubemusic', name: 'YouTube Music', group: 'music', icon: 'music', href: 'youtubemusic://', web: 'https://music.youtube.com/' },
  { id: 'podcasts', name: 'Подкасты', group: 'music', icon: 'radio', href: 'podcasts://' },
  { id: 'telegram', name: 'Telegram', group: 'comm', icon: 'chat', href: 'tg://', web: 'https://web.telegram.org/' },
  { id: 'whatsapp', name: 'WhatsApp', group: 'comm', icon: 'chat', href: 'whatsapp://', web: 'https://web.whatsapp.com/' },
];

export const GROUPS: Record<AppLink['group'], string> = { nav: 'Навигация', music: 'Музыка', comm: 'Связь' };

export function findApp(query: string): AppLink | undefined {
  const q = query.toLowerCase().replace(/ё/g, 'е');
  return APPS.find((a) => a.id === q || a.name.toLowerCase().replace(/ё/g, 'е').includes(q) || q.includes(a.name.toLowerCase().split(' ')[0]));
}

export function launchApp(app: AppLink) {
  window.location.href = app.href;
}
