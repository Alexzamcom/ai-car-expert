/* Выбор движка карты: MapLibre 3D — основной, Leaflet — резерв (явный выбор пользователя или сбой WebGL/загрузки). */
import { createStore } from './store';

export type MapEngine = 'leaflet' | 'maplibre';

/**
 * Миграция настроек: до этого обновления по умолчанию был Leaflet, и он сохранялся в настройках вместе с остальными
 * полями — отличить «выбрал сам» от «так было по умолчанию» нельзя. Явный выбор теперь отмечается (mapEngineExplicit);
 * неотмеченный Leaflet переводится на MapLibre.
 */
export function migrateEngine(s: { mapEngine: MapEngine; mapEngineExplicit: boolean }): MapEngine {
  return s.mapEngine === 'leaflet' && !s.mapEngineExplicit ? 'maplibre' : s.mapEngine;
}

/** Какой движок показывать: MapLibre, только если он выбран, WebGL есть и сбоя в этой сессии не было. */
export function effectiveEngine(choice: MapEngine, fallback: string | null, webgl: boolean): MapEngine {
  return choice === 'maplibre' && webgl && !fallback ? 'maplibre' : 'leaflet';
}

let webglCache: boolean | null = null;
export function webglAvailable(): boolean {
  if (webglCache != null) return webglCache;
  try {
    const c = document.createElement('canvas');
    webglCache = !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    webglCache = false;
  }
  return webglCache;
}

/** Сбой MapLibre в этой сессии (настройку не меняет: при следующем запуске попробуем снова). */
export const mapRuntimeStore = createStore<{ fallback: string | null }>({
  fallback: null,
});

export function engineFallback(reason: string, notify?: (text: string) => void) {
  if (mapRuntimeStore.get().fallback) return;
  mapRuntimeStore.set({ fallback: reason });
  notify?.(`Карта 3D недоступна (${reason}) — включена резервная карта. Маршрут и ведение сохранены.`);
}
