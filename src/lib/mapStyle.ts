/* Оформление векторной карты MapLibre: стиль OpenFreeMap (бесплатно, без ключа) и палитры поверх него.
   День — спокойная светлая карта; ночь — тёмная; HUD — чёрный фон, яркие дороги, минимум подписей.
   Данные карты не меняются — только цвета и видимость слоёв. */
import type { StyleSpecification } from 'maplibre-gl';

export const DEFAULT_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';

export type MapPalette = 'day' | 'night' | 'hud' | 'game';

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

/* ---------- «Игровая 3D»: пастельная миниатюра (diorama) из тех же данных OpenFreeMap ---------- */

/** Цвета режима: тёплый светлый фон, мягкая зелень, голубая вода, «игрушечные» пастельные дома. */
export const GAME = {
  ground: '#f3ead9',
  residential: '#efe2cc',
  grass: '#c6e6a3',
  park: '#addc8f',
  wood: '#8fcd78',
  water: '#8ed2ef',
  shore: '#d4f0fb',
  asphalt: '#8b919c',
  asphaltMajor: '#7a818e',
  curb: '#fbf8f2',
  shadow: 'rgba(92, 78, 60, 0.22)',
  path: '#e4d6bd',
  text: '#5b5048',
  halo: '#fbf6ec',
  walls: ['#f6c9ad', '#f8e3bf', '#cfe9d2', '#dcd3f1', '#cde1f4', '#f5d0d8'],
  roofs: ['#e08f72', '#e9b871', '#8fc59b', '#a99ad6', '#8fb6dc', '#e19aa9'],
};
/** Иконка дерева для режима (рисуется в коде, см. treeImage). */
export const GAME_TREE = 'game-tree';

const wallColor = (pal: string[]): unknown => [
  'match',
  ['%', ['floor', ['/', ['coalesce', ['get', 'render_height'], 6], 3]], pal.length],
  ...pal.flatMap((c, i) => (i < pal.length - 1 ? [i, c] : [])),
  pal[pal.length - 1],
];
const zoomW = (pairs: [number, number][]): unknown => ['interpolate', ['exponential', 1.6], ['zoom'], ...pairs.flat()];

function game(style: StyleSpecification) {
  const src = Object.entries(style.sources).find(([, v]) => v.type === 'vector')?.[0];
  for (const l of style.layers) {
    const id = l.id;
    const paint = paintOf(l);
    if (l.type === 'background') paint['background-color'] = GAME.ground;
    else if (l.type === 'fill') {
      if (/water/.test(id)) paint['fill-color'] = GAME.water;
      else if (/park/.test(id)) paint['fill-color'] = GAME.park;
      else if (/wood|forest/.test(id)) paint['fill-color'] = GAME.wood;
      else if (/residential|landuse/.test(id)) paint['fill-color'] = GAME.residential;
      else if (id === 'building') {
        // Плоские здания — только на дальних масштабах; ближе — объёмные (game-buildings).
        paint['fill-color'] = GAME.walls[1];
        paint['fill-outline-color'] = '#e6d3b4';
        (l as { maxzoom?: number }).maxzoom = 14;
      }
      else if (/glacier|ice/.test(id)) paint['fill-color'] = '#f4f8fb';
      paint['fill-opacity'] = 1;
    } else if (l.type === 'line') {
      if (/waterway|river/.test(id)) paint['line-color'] = GAME.water;
      else if (/boundary/.test(id)) paint['line-color'] = '#d8c6a8';
      else if (/rail/.test(id)) paint['line-color'] = '#b9ad9a';
      else if (/path|pier/.test(id)) paint['line-color'] = GAME.path;
      else if (ROAD.test(id)) {
        const major = MAJOR.test(id) || /major/.test(id);
        if (/casing/.test(id)) {
          // Бордюр: светлая кайма шире полотна.
          paint['line-color'] = GAME.curb;
          paint['line-width'] = major ? zoomW([[10, 2], [14, 7], [16, 17], [18, 44]]) : zoomW([[12, 1.5], [14, 4.5], [16, 13], [18, 34]]);
        } else if (/subtle/.test(id)) {
          layoutOf(l).visibility = 'none';
        } else {
          paint['line-color'] = major ? GAME.asphaltMajor : GAME.asphalt;
          paint['line-width'] = major ? zoomW([[10, 1.2], [14, 5], [16, 13], [18, 36]]) : zoomW([[12, 0.8], [14, 3], [16, 9.5], [18, 26]]);
          paint['line-opacity'] = 1;
        }
      }
    } else if (l.type === 'symbol') {
      paint['text-color'] = GAME.text;
      paint['text-halo-color'] = GAME.halo;
      paint['text-halo-width'] = 1.6;
      if (/shield/.test(id)) layoutOf(l).visibility = 'none';
    }
  }
  if (!src) return style; // нет векторного источника (тестовый стиль) — только перекраска
  const firstSymbol = style.layers.findIndex((l) => l.type === 'symbol');
  const at = firstSymbol < 0 ? style.layers.length : firstSymbol;
  const firstRoad = style.layers.findIndex((l) => l.type === 'line' && ROAD.test(l.id) && !/path|pier|rail/.test(l.id));
  const add: StyleSpecification['layers'] = [];
  const beforeRoads: StyleSpecification['layers'] = [
    // Трава и луга — светлее парков; берег — светлая кайма воды.
    { id: 'game-grass', type: 'fill', source: src, 'source-layer': 'landcover', filter: ['match', ['get', 'class'], ['grass', 'farmland', 'meadow'], true, false], paint: { 'fill-color': GAME.grass } },
    { id: 'game-shore', type: 'line', source: src, 'source-layer': 'water', minzoom: 12, paint: { 'line-color': GAME.shore, 'line-width': zoomW([[12, 1], [16, 4], [18, 8]]) as never } },
  ];
  // Тень дорог: смещённая полупрозрачная линия под бордюром — дорога «приподнята», как в макете.
  const roadShadow = {
    id: 'game-road-shadow',
    type: 'line',
    source: src,
    'source-layer': 'transportation',
    minzoom: 13,
    filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service'], true, false],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': GAME.shadow, 'line-width': zoomW([[13, 4], [16, 16], [18, 42]]), 'line-translate': [1.5, 2.5], 'line-blur': 1.5 },
  } as StyleSpecification['layers'][number];
  add.push(
    // Объёмные здания: реальная высота, пастельный цвет по высоте, мягкий вертикальный градиент.
    {
      id: 'game-buildings',
      type: 'fill-extrusion',
      source: src,
      'source-layer': 'building',
      minzoom: 14,
      filter: ['!', ['has', 'hide_3d']],
      paint: {
        'fill-extrusion-color': wallColor(GAME.walls) as never,
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 6],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-vertical-gradient': true,
        'fill-extrusion-opacity': 1,
      },
    },
    // Крыши: тонкая «шапка» более насыщенного цвета поверх стен (только вблизи — экономия GPU).
    {
      id: 'game-roofs',
      type: 'fill-extrusion',
      source: src,
      'source-layer': 'building',
      minzoom: 15,
      filter: ['!', ['has', 'hide_3d']],
      paint: {
        'fill-extrusion-color': wallColor(GAME.roofs) as never,
        'fill-extrusion-base': ['coalesce', ['get', 'render_height'], 6],
        'fill-extrusion-height': ['+', ['coalesce', ['get', 'render_height'], 6], ['min', 2.5, ['+', 0.7, ['*', 0.03, ['coalesce', ['get', 'render_height'], 6]]]]],
        'fill-extrusion-vertical-gradient': false,
        'fill-extrusion-opacity': 1,
      },
    },
    // Деревья: стилизованные «игрушечные» деревья вдоль границ парков и лесов, стоят вертикально при наклоне.
    {
      id: 'game-trees',
      type: 'symbol',
      source: src,
      'source-layer': 'park',
      minzoom: 15,
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 46,
        'icon-image': GAME_TREE,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 15, 0.45, 17, 0.75, 19, 1.1],
        'icon-anchor': 'bottom',
        'icon-pitch-alignment': 'viewport',
        'icon-rotation-alignment': 'viewport',
        'icon-allow-overlap': false,
        'icon-padding': 0,
      },
    },
    {
      id: 'game-trees-wood',
      type: 'symbol',
      source: src,
      'source-layer': 'landcover',
      minzoom: 15,
      filter: ['match', ['get', 'class'], ['wood', 'forest'], true, false],
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 34,
        'icon-image': GAME_TREE,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 15, 0.5, 17, 0.85, 19, 1.2],
        'icon-anchor': 'bottom',
        'icon-pitch-alignment': 'viewport',
        'icon-rotation-alignment': 'viewport',
        'icon-allow-overlap': false,
        'icon-padding': 0,
      },
    },
  );
  const layers = [...style.layers];
  layers.splice(at, 0, ...add);
  if (firstRoad >= 0) layers.splice(firstRoad, 0, ...beforeRoads, roadShadow);
  else layers.splice(at, 0, ...beforeRoads);
  style.layers = layers;
  // Свет для объёмных зданий и пастельное небо у горизонта.
  (style as { light?: unknown }).light = { anchor: 'viewport', color: '#fff4e3', intensity: 0.42, position: [1.4, 205, 38] };
  (style as { sky?: unknown }).sky = {
    'sky-color': '#bfe4f8',
    'horizon-color': '#f9efe0',
    'fog-color': GAME.ground,
    'sky-horizon-blend': 0.7,
    'horizon-fog-blend': 0.6,
    'fog-ground-blend': 0.75,
    'atmosphere-blend': 0,
  };
  return style;
}

/**
 * Стилизованное low-poly дерево для режима «Игровая 3D» (рисуется на холсте один раз; без сторонних изображений).
 * Возвращает данные RGBA для map.addImage.
 */
export function treeImage(px = 2): { width: number; height: number; data: Uint8ClampedArray } | null {
  if (typeof document === 'undefined') return null;
  const w = 26 * px;
  const h = 36 * px;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) return null;
  g.scale(px, px);
  // Тень на земле
  g.fillStyle = 'rgba(70, 90, 50, 0.25)';
  g.beginPath();
  g.ellipse(13, 33.5, 8, 2.3, 0, 0, Math.PI * 2);
  g.fill();
  // Ствол
  g.fillStyle = '#9b6b4a';
  g.fillRect(11.6, 24, 2.8, 9.5);
  // Крона: три «грани» low-poly — тёмная, средняя, светлая
  const poly = (pts: number[][], fill: string) => {
    g.fillStyle = fill;
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts.slice(1)) g.lineTo(p[0], p[1]);
    g.closePath();
    g.fill();
  };
  poly([[13, 1.5], [3, 26], [13, 23]], '#6fbf5a');
  poly([[13, 1.5], [23, 26], [13, 23]], '#4f9e45');
  poly([[13, 9], [5.5, 26], [20.5, 26], [13, 23.5]], '#5bb04e');
  poly([[13, 1.5], [9, 12], [13, 10]], '#8fd476');
  const img = g.getImageData(0, 0, w, h);
  return { width: w, height: h, data: img.data };
}

export function paletteTransform(p: MapPalette, opts: { roadColor?: string } = {}) {
  return (_prev: StyleSpecification | undefined, next: StyleSpecification): StyleSpecification => {
    const copy = structuredClone(next);
    if (p === 'night') return night(copy);
    if (p === 'hud') return hud(copy, opts.roadColor ?? '#9aa3ad');
    if (p === 'game') return game(copy);
    return copy;
  };
}
