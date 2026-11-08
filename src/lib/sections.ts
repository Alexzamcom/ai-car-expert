import type { IconName } from '../components/Icon';

export type SectionId =
  | 'vehicle'
  | 'navigation'
  | 'media'
  | 'assistant'
  | 'manual'
  | 'service'
  | 'diagnostics'
  | 'settings';

export interface SectionMeta {
  id: SectionId;
  title: string;
  short: string;
  icon: IconName;
  inDock: boolean;
}

export const SECTIONS: Record<SectionId, SectionMeta> = {
  vehicle: { id: 'vehicle', title: 'Автомобиль', short: 'Авто', icon: 'car', inDock: true },
  navigation: { id: 'navigation', title: 'Навигация', short: 'Карта', icon: 'map', inDock: true },
  media: { id: 'media', title: 'Мультимедиа', short: 'Медиа', icon: 'music', inDock: true },
  assistant: { id: 'assistant', title: 'AI-помощник', short: 'AI', icon: 'spark', inDock: true },
  manual: { id: 'manual', title: 'Руководство', short: 'Справка', icon: 'book', inDock: true },
  service: { id: 'service', title: 'История обслуживания', short: 'Сервис', icon: 'wrench', inDock: true },
  diagnostics: { id: 'diagnostics', title: 'OBD-диагностика', short: 'OBD', icon: 'gauge', inDock: true },
  settings: { id: 'settings', title: 'Настройки', short: 'Настройки', icon: 'gear', inDock: false },
};

export const DOCK_LEFT: SectionId[] = ['vehicle', 'navigation', 'media', 'assistant'];
export const DOCK_RIGHT: SectionId[] = ['manual', 'service', 'diagnostics'];
