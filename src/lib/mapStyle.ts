/* Оформление векторной карты MapLibre: стиль OpenFreeMap (бесплатно, без ключа) и палитры поверх него.
   День — спокойная светлая карта; ночь — тёмная; HUD — чёрный фон, яркие дороги, минимум подписей.
   Данные карты не меняются — только цвета и видимость слоёв. */
import type { StyleSpecification } from 'maplibre-gl';

export const DEFAULT_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';

export type MapPalette = 'day' | 'night' | 'hud';

type Paint = Record<string, unknown>;
const paintOf = (l: StyleSpecification['layers'][number]) => ((l as { paint?: Paint }).paint ??= {});
const layoutOf = (l: StyleSpecification['layers'][number]) => ((l as { layout?: Paint }).layout ??= {});

const MAJOR = /motorway|trunk|primary/;
const ROAD = /road|street|highway|bridge|tunnel|motorway|trunk|primary|secondary|tertiary|minor|service|link|path/;

function night(style: StyleSpecification) {
  for (const l of style.layers) {
    const id = l.id;
    const paint = paintOf(l);
    if (l.type === 'background') paint['background-color'] = '#0b0f14';
    else if (l.type === 'fill')
      paint['fill-color'] = /water/.test(id) ? '#0f1b27' : /park|wood|grass|landcover|landuse/.test(id) ? '#10171c' : /building/.test(id) ? '#161d25' : '#0e1318';
    else if (l.type === 'line') {
      if (/water|river|stream|canal/.test(id)) paint['line-color'] = '#0f1b27';
      else if (/casing/.test(id)) paint['line-color'] = '#0b0f14';
      else if (/boundary|admin/.test(id)) paint['line-color'] = '#2b3440';
      else if (MAJOR.test(id)) paint['line-color'] = '#3b4654';
      else paint['line-color'] = '#262e37';
    } else if (l.type === 'symbol') {
      paint['text-color'] = '#8d99a8';
      paint['text-halo-color'] = '#0b0f14';
    }
  }
  return style;
}

/**
 * HUD: отражение в лобовом стекле. Чёрное отражается как прозрачное, поэтому фон и площади — чёрные,
 * дороги — светлые и толще обычного, подписи — только крупных улиц (минимум отвлекающего).
 */
function hud(style: StyleSpecification, roadColor: string) {
  for (const l of style.layers) {
    const id = l.id;
    const paint = paintOf(l);
    if (l.type === 'background') paint['background-color'] = '#000000';
    else if (l.type === 'fill' || l.type === 'fill-extrusion') layoutOf(l).visibility = 'none';
    else if (l.type === 'line') {
      if (ROAD.test(id) && !/casing|path|rail|ferry/.test(id)) {
        paint['line-color'] = roadColor;
        paint['line-opacity'] = MAJOR.test(id) ? 0.85 : 0.55;
      } else layoutOf(l).visibility = 'none';
    } else if (l.type === 'symbol') {
      if (/road|street|highway|transportation_name/.test(id)) {
        paint['text-color'] = roadColor;
        paint['text-halo-color'] = '#000000';
        paint['text-opacity'] = 0.8;
      } else layoutOf(l).visibility = 'none';
    }
  }
  return style;
}

export function paletteTransform(p: MapPalette, opts: { roadColor?: string } = {}) {
  return (_prev: StyleSpecification | undefined, next: StyleSpecification): StyleSpecification => {
    const copy = structuredClone(next);
    if (p === 'night') return night(copy);
    if (p === 'hud') return hud(copy, opts.roadColor ?? '#9aa3ad');
    return copy;
  };
}
