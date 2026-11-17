import { describe, it, expect } from 'vitest';
import { migrateEngine, effectiveEngine, engineFallback, mapRuntimeStore } from '../../src/lib/mapEngine';

describe('Движок карты', () => {
  it('миграция: Leaflet «по умолчанию» → MapLibre; явный выбор сохраняется', () => {
    expect(migrateEngine({ mapEngine: 'leaflet', mapEngineExplicit: false })).toBe('maplibre');
    expect(migrateEngine({ mapEngine: 'leaflet', mapEngineExplicit: true })).toBe('leaflet');
    expect(migrateEngine({ mapEngine: 'maplibre', mapEngineExplicit: false })).toBe('maplibre');
  });
  it('MapLibre — только при WebGL и без сбоя в этой сессии', () => {
    expect(effectiveEngine('maplibre', null, true)).toBe('maplibre');
    expect(effectiveEngine('maplibre', null, false)).toBe('leaflet');
    expect(effectiveEngine('maplibre', 'WebGL недоступен', true)).toBe('leaflet');
    expect(effectiveEngine('leaflet', null, true)).toBe('leaflet');
  });
  it('сбой — одно сообщение, повторные не дублируются', () => {
    const msgs: string[] = [];
    engineFallback('не загрузилась', (t) => msgs.push(t));
    engineFallback('WebGL недоступен', (t) => msgs.push(t));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('резервная карта');
    expect(mapRuntimeStore.get().fallback).toBe('не загрузилась');
    mapRuntimeStore.set({ fallback: null });
  });
});
