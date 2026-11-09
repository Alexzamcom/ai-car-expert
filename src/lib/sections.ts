import type { IconName } from '../components/Icon';

/** Вкладки панели главного экрана (рядом с картой). */
export type PanelId = 'media' | 'assistant' | 'apps' | 'trip';
/** Дополнительные разделы — полноэкранные страницы поверх главного экрана. */
export type PageId = 'vehicle' | 'manual' | 'service' | 'diagnostics' | 'settings';
export type SectionId = 'navigation' | PanelId | PageId;

export interface SectionMeta {
  id: SectionId;
  title: string;
  short: string;
  icon: IconName;
}

export const SECTIONS: Record<SectionId, SectionMeta> = {
  navigation: { id: 'navigation', title: 'Навигация', short: 'Карта', icon: 'map' },
  media: { id: 'media', title: 'Музыка и радио', short: 'Музыка', icon: 'music' },
  assistant: { id: 'assistant', title: 'Помощник Grok', short: 'Grok', icon: 'spark' },
  apps: { id: 'apps', title: 'Приложения', short: 'Прил.', icon: 'grid' },
  trip: { id: 'trip', title: 'Поездка', short: 'Поездка', icon: 'gauge' },
  vehicle: { id: 'vehicle', title: 'Мой автомобиль', short: 'Авто', icon: 'car' },
  manual: { id: 'manual', title: 'Справочник', short: 'Справочник', icon: 'book' },
  service: { id: 'service', title: 'Сервис и обслуживание', short: 'Сервис', icon: 'wrench' },
  diagnostics: { id: 'diagnostics', title: 'Диагностика OBD-II', short: 'OBD', icon: 'obd' },
  settings: { id: 'settings', title: 'Настройки', short: 'Настройки', icon: 'gear' },
};

export const PANELS: PanelId[] = ['media', 'assistant', 'apps', 'trip'];
export const PAGES: PageId[] = ['vehicle', 'manual', 'service', 'diagnostics', 'settings'];

export function isPanel(id: SectionId): id is PanelId {
  return (PANELS as string[]).includes(id);
}
