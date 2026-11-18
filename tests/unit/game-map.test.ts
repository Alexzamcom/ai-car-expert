/* «Игровая 3D»: преобразование стиля OpenFreeMap (positron) — объёмные здания, крыши, деревья, дороги, свет, небо. */
import { describe, it, expect } from 'vitest';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import type { StyleSpecification } from 'maplibre-gl';
import { paletteTransform, GAME, GAME_TREE, treeImage } from '../../src/lib/mapStyle';
import positron from '../fixtures/positron-sample.json';

const base = positron as unknown as StyleSpecification;
const game = () => paletteTransform('game')(undefined, base);
const layer = (s: StyleSpecification, id: string) => s.layers.find((l) => l.id === id) as Record<string, any>;
const idx = (s: StyleSpecification, id: string) => s.layers.findIndex((l) => l.id === id);

describe('«Игровая 3D»: стиль', () => {
  it('проходит официальную проверку стиля MapLibre', () => {
    expect(validateStyleMin(game())).toEqual([]);
  });
  it('объёмные здания и крыши из реальных высот (render_height), только вблизи', () => {
    const s = game();
    const b = layer(s, 'game-buildings');
    expect(b).toMatchObject({ type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 14 });
    expect(JSON.stringify(b.paint['fill-extrusion-height'])).toContain('render_height');
    expect(JSON.stringify(b.paint['fill-extrusion-base'])).toContain('render_min_height');
    expect(b.filter).toEqual(['!', ['has', 'hide_3d']]);
    const r = layer(s, 'game-roofs');
    expect(r).toMatchObject({ type: 'fill-extrusion', minzoom: 15 });
    // плоские здания — только издалека
    expect(layer(s, 'building').maxzoom).toBe(14);
  });
  it('деревья: стилизованная иконка вдоль парков и лесов, стоят вертикально при наклоне', () => {
    const s = game();
    for (const id of ['game-trees', 'game-trees-wood']) {
      const t = layer(s, id);
      expect(t.type).toBe('symbol');
      expect(t.layout['icon-image']).toBe(GAME_TREE);
      expect(t.layout['icon-pitch-alignment']).toBe('viewport');
      expect(t.minzoom).toBe(15);
    }
  });
  it('пастельная палитра: фон, парки, вода; дороги — асфальт с белым бордюром и тенью под ними', () => {
    const s = game();
    expect(layer(s, 'background').paint['background-color']).toBe(GAME.ground);
    expect(layer(s, 'park').paint['fill-color']).toBe(GAME.park);
    expect(layer(s, 'water').paint['fill-color']).toBe(GAME.water);
    expect(layer(s, 'highway_major_inner').paint['line-color']).toBe(GAME.asphaltMajor);
    expect(layer(s, 'highway_major_casing').paint['line-color']).toBe(GAME.curb);
    expect(idx(s, 'game-road-shadow')).toBeLessThan(idx(s, 'highway_minor'));
    expect(layer(s, 'highway_major_subtle').layout.visibility).toBe('none');
  });
  it('порядок: здания и деревья — под подписями; трава и тень — под дорогами', () => {
    const s = game();
    const firstLabel = s.layers.findIndex((l) => l.type === 'symbol' && !l.id.startsWith('game-'));
    expect(idx(s, 'game-buildings')).toBeLessThan(firstLabel);
    expect(idx(s, 'game-trees')).toBeLessThan(firstLabel);
    expect(idx(s, 'game-grass')).toBeLessThan(idx(s, 'highway_minor'));
  });
  it('свет для объёма и пастельное небо у горизонта', () => {
    const s = game() as StyleSpecification & { light?: any; sky?: any };
    expect(s.light).toMatchObject({ anchor: 'viewport' });
    expect(s.sky['sky-color']).toBeTruthy();
  });
  it('исходный стиль не меняется; обычная карта (день) — без изменений', () => {
    const before = JSON.stringify(base);
    game();
    expect(JSON.stringify(base)).toBe(before);
    expect(JSON.stringify(paletteTransform('day')(undefined, base))).toBe(before);
  });
  it('стиль без векторного источника (тестовый) — только перекраска, без новых слоёв', () => {
    const s = paletteTransform('game')(undefined, { version: 8, sources: {}, layers: [{ id: 'background', type: 'background' }] } as StyleSpecification);
    expect(s.layers.map((l) => l.id)).toEqual(['background']);
  });
  it('иконка дерева рисуется только в браузере', () => {
    expect(treeImage()).toBeNull();
  });
});
