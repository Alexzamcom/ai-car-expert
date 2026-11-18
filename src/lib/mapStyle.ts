/* Оформление векторной карты MapLibre: стиль OpenFreeMap (бесплатно, без ключа) и палитры поверх него.
   День — спокойная светлая карта; ночь — тёмная; HUD — чёрный фон, яркие дороги, минимум подписей.
   Данные карты не меняются — только цвета и видимость слоёв. */
import type { StyleSpecification } from 'maplibre-gl';

export const DEFAULT_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';

export type MapPalette = 'day' | 'night' | 'hud' | 'game' | 'game-night';

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
  // Стены — светлые кремовые оттенки, цвет даёт крыша (как у миниатюрного макета города).
  walls: ['#fbf4e8', '#f7ecdc', '#fdf8f1', '#f4ece5', '#eef2f2', '#f6eee2'],
  roofs: ['#e9967c', '#efb886', '#9fcfa8', '#a8bfe3', '#e6a3b4', '#c7b5e6'],
};
/** Ночная «Игровая 3D»: тёмный сине-графитовый город, холодная подсветка дорог, тёплые окна. */
export const GAME_NIGHT: typeof GAME = {
  ground: '#0f1623',
  residential: '#121a28',
  grass: '#13261f',
  park: '#122a20',
  wood: '#0f2219',
  water: '#06111f',
  shore: '#0d2236',
  asphalt: '#2a3242',
  asphaltMajor: '#303a4c',
  curb: '#46536a',
  shadow: 'rgba(0, 0, 0, 0.42)',
  path: '#283246',
  text: '#c3cfe2',
  halo: '#0b111b',
  walls: ['#1d2536', '#222a3b', '#1a2232', '#20283a', '#1c2434', '#242c3d'],
  roofs: ['#2c3548', '#313a4e', '#283143', '#343d50', '#2a3244', '#2f3749'],
};
/** Иконка дерева для режима (рисуется в коде, см. treeImage). */
export const GAME_TREE = 'game-tree';
export const GAME_TREE_NIGHT = 'game-tree-night';
/** Ночные текстуры стен с окнами (несколько вариантов, чтобы соседние дома отличались) и пятно света фонаря. */
export const GAME_WINDOWS = ['game-win-0', 'game-win-1', 'game-win-2'];
export const GAME_LAMP = 'game-lamp';

// Цвет по номеру здания (если есть в тайлах) и высоте: соседние дома разные, а у одного дома цвет не «мигает».
const wallColor = (pal: string[]): unknown => [
  'match',
  ['%', ['+', ['to-number', ['id'], 0], ['floor', ['/', ['coalesce', ['get', 'render_height'], 6], 3]]], pal.length],
  ...pal.flatMap((c, i) => (i < pal.length - 1 ? [i, c] : [])),
  pal[pal.length - 1],
];
const zoomW = (pairs: [number, number][]): unknown => ['interpolate', ['exponential', 1.6], ['zoom'], ...pairs.flat()];

function game(style: StyleSpecification, nightMode = false, opts: { lite?: boolean } = {}) {
  const GAME_ = nightMode ? GAME_NIGHT : GAME;
  const src = Object.entries(style.sources).find(([, v]) => v.type === 'vector')?.[0];
  for (const l of style.layers) {
    const id = l.id;
    const paint = paintOf(l);
    if (l.type === 'background') paint['background-color'] = GAME_.ground;
    else if (l.type === 'fill') {
      if (/water/.test(id)) paint['fill-color'] = GAME_.water;
      else if (/park/.test(id)) paint['fill-color'] = GAME_.park;
      else if (/wood|forest/.test(id)) paint['fill-color'] = GAME_.wood;
      else if (/residential|landuse/.test(id)) paint['fill-color'] = GAME_.residential;
      else if (id === 'building') {
        // Плоские здания — только на дальних масштабах; ближе — объёмные (game-buildings).
        paint['fill-color'] = GAME_.walls[1];
        paint['fill-outline-color'] = nightMode ? '#2a3346' : '#e6d3b4';
        (l as { maxzoom?: number }).maxzoom = 14;
      }
      else if (/glacier|ice/.test(id)) paint['fill-color'] = nightMode ? '#1b2433' : '#f4f8fb';
      paint['fill-opacity'] = 1;
    } else if (l.type === 'line') {
      if (/waterway|river/.test(id)) paint['line-color'] = GAME_.water;
      else if (/boundary/.test(id)) paint['line-color'] = nightMode ? '#33405a' : '#d8c6a8';
      else if (/rail/.test(id)) paint['line-color'] = nightMode ? '#3a4458' : '#b9ad9a';
      else if (/path|pier/.test(id)) paint['line-color'] = GAME_.path;
      else if (ROAD.test(id)) {
        const major = MAJOR.test(id) || /major/.test(id);
        if (/casing/.test(id)) {
          // Бордюр: светлая кайма шире полотна.
          paint['line-color'] = GAME_.curb;
          paint['line-width'] = major ? zoomW([[10, 2], [14, 7], [16, 17], [18, 44]]) : zoomW([[12, 1.5], [14, 4.5], [16, 13], [18, 34]]);
        } else if (/subtle/.test(id)) {
          layoutOf(l).visibility = 'none';
        } else {
          paint['line-color'] = major ? GAME_.asphaltMajor : GAME_.asphalt;
          paint['line-width'] = major ? zoomW([[10, 1.2], [14, 5], [16, 13], [18, 36]]) : zoomW([[12, 0.8], [14, 3], [16, 9.5], [18, 26]]);
          paint['line-opacity'] = 1;
        }
      }
    } else if (l.type === 'symbol') {
      paint['text-color'] = GAME_.text;
      paint['text-halo-color'] = GAME_.halo;
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
    { id: 'game-grass', type: 'fill', source: src, 'source-layer': 'landcover', filter: ['match', ['get', 'class'], ['grass', 'farmland', 'meadow'], true, false], paint: { 'fill-color': GAME_.grass } },
    { id: 'game-shore', type: 'line', source: src, 'source-layer': 'water', minzoom: 12, paint: { 'line-color': GAME_.shore, 'line-width': zoomW([[12, 1], [16, 4], [18, 8]]) as never } },
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
    paint: { 'line-color': GAME_.shadow, 'line-width': zoomW([[13, 4], [16, 16], [18, 42]]), 'line-translate': [1.5, 2.5], 'line-blur': 1.5 },
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
        'fill-extrusion-color': wallColor(GAME_.walls) as never,
        // Ночью стены — текстура с окнами (часть горит тёплым светом); вариант — по номеру и высоте дома.
        ...(nightMode ? { 'fill-extrusion-pattern': wallColor(GAME_WINDOWS) as never } : {}),
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
      minzoom: nightMode ? 14 : 15,
      filter: ['!', ['has', 'hide_3d']],
      paint: {
        'fill-extrusion-color': wallColor(GAME_.roofs) as never,
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
        'icon-image': nightMode ? GAME_TREE_NIGHT : GAME_TREE,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 15, 0.45, 17, 0.75, 19, 1.1],
        'icon-anchor': 'bottom',
        'icon-pitch-alignment': 'viewport',
        'icon-rotation-alignment': 'viewport',
        'icon-allow-overlap': false,
        'icon-padding': 0,
      },
    },
    {
      id: 'game-trees-grass',
      type: 'symbol',
      source: src,
      'source-layer': 'landcover',
      minzoom: 15.5,
      filter: ['match', ['get', 'class'], ['grass', 'meadow'], true, false],
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 64,
        'icon-image': nightMode ? GAME_TREE_NIGHT : GAME_TREE,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 15.5, 0.45, 17, 0.7, 19, 1.05],
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
        'icon-image': nightMode ? GAME_TREE_NIGHT : GAME_TREE,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 15, 0.5, 17, 0.85, 19, 1.2],
        'icon-anchor': 'bottom',
        'icon-pitch-alignment': 'viewport',
        'icon-rotation-alignment': 'viewport',
        'icon-allow-overlap': false,
        'icon-padding': 0,
      },
    },
  );
  const roadClasses = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service'];
  const nightUnder: StyleSpecification['layers'] = [];
  if (nightMode) {
    // Холодно-голубое свечение вокруг дорог: широкая размытая линия под полотном (одна линия — дёшево).
    nightUnder.push({
      id: 'game-road-glow',
      type: 'line',
      source: src,
      'source-layer': 'transportation',
      minzoom: 12,
      filter: ['match', ['get', 'class'], roadClasses, true, false],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#4f86d8',
        'line-width': zoomW([[12, 4], [14, 9], [16, 26], [18, 70]]) as never,
        'line-blur': zoomW([[12, 3], [14, 7], [16, 18], [18, 46]]) as never,
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0.18, 15, 0.3, 18, 0.34],
      },
    } as StyleSpecification['layers'][number]);
    // Пятна света фонарей на дороге: лежат на земле (наклоняются с картой), только вблизи; на слабых устройствах — без них.
    if (!opts.lite)
      add.unshift({
        id: 'game-lamps',
        type: 'symbol',
        source: src,
        'source-layer': 'transportation',
        minzoom: 15.5,
        filter: ['match', ['get', 'class'], ['primary', 'secondary', 'tertiary', 'minor'], true, false],
        layout: {
          'symbol-placement': 'line',
          'symbol-spacing': 110,
          'icon-image': GAME_LAMP,
          'icon-size': ['interpolate', ['exponential', 1.6], ['zoom'], 15.5, 0.35, 17, 0.75, 19, 1.9],
          'icon-pitch-alignment': 'map',
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: { 'icon-opacity': ['interpolate', ['linear'], ['zoom'], 15.5, 0, 16.2, 0.85] },
      } as StyleSpecification['layers'][number]);
  }
  const layers = [...style.layers];
  layers.splice(at, 0, ...add);
  if (firstRoad >= 0) layers.splice(firstRoad, 0, ...beforeRoads, roadShadow, ...nightUnder);
  else layers.splice(at, 0, ...beforeRoads, ...nightUnder);
  style.layers = layers;
  // Свет для объёмных зданий и пастельное небо у горизонта.
  if (nightMode) {
    // Ночь: холодный «лунный» свет — объём зданий читается, но город тёмный; небо — глубокий синий.
    (style as { light?: unknown }).light = { anchor: 'viewport', color: '#9db4e8', intensity: 0.32, position: [1.3, 215, 40] };
    (style as { sky?: unknown }).sky = {
      'sky-color': '#0a1222',
      'horizon-color': '#1a2a46',
      'fog-color': GAME_.ground,
      'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.55,
      'fog-ground-blend': 0.8,
      'atmosphere-blend': 0,
    };
    return style;
  }
  (style as { light?: unknown }).light = { anchor: 'viewport', color: '#fff4e3', intensity: 0.42, position: [1.4, 205, 38] };
  (style as { sky?: unknown }).sky = {
    'sky-color': '#bfe4f8',
    'horizon-color': '#f9efe0',
    'fog-color': GAME_.ground,
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
export function treeImage(px = 2, nightMode = false): { width: number; height: number; data: Uint8ClampedArray } | null {
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
  g.fillStyle = nightMode ? 'rgba(0, 0, 0, 0.35)' : 'rgba(70, 90, 50, 0.25)';
  g.beginPath();
  g.ellipse(13, 33.5, 8, 2.3, 0, 0, Math.PI * 2);
  g.fill();
  // Ствол
  g.fillStyle = nightMode ? '#3b2e2a' : '#9b6b4a';
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
  poly([[13, 1.5], [3, 26], [13, 23]], nightMode ? '#2c5a3e' : '#6fbf5a');
  poly([[13, 1.5], [23, 26], [13, 23]], nightMode ? '#1d4430' : '#4f9e45');
  poly([[13, 9], [5.5, 26], [20.5, 26], [13, 23.5]], nightMode ? '#244e37' : '#5bb04e');
  poly([[13, 1.5], [9, 12], [13, 10]], nightMode ? '#3d6f50' : '#8fd476');
  const img = g.getImageData(0, 0, w, h);
  return { width: w, height: h, data: img.data };
}

type Img = { width: number; height: number; data: Uint8ClampedArray };
const canvas = (w: number, h: number) => {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  return g ? { c, g } : null;
};
/** Повторяемое «случайное» число 0…1 (окна одного варианта всегда одинаковы — без мерцания). */
const hash = (i: number, seed: number) => {
  const x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * Ночная текстура стены: тёмный сине-графитовый фон, ряды небольших окон; часть горит тёплым жёлто-янтарным светом.
 * Вариант 0…2 — разная доля горящих окон и оттенок стены.
 */
export function windowImage(variant: number, px = 2): Img | null {
  const W = 32;
  const H = 48;
  const cv = canvas(W * px, H * px);
  if (!cv) return null;
  const { g } = cv;
  g.scale(px, px);
  g.fillStyle = ['#1d2536', '#222a3b', '#1a2232'][variant % 3];
  g.fillRect(0, 0, W, H);
  const lit = [0.32, 0.45, 0.22][variant % 3];
  const warm = ['#ffcf7a', '#ffb65e', '#ffe0a0', '#f7c26b'];
  let n = 0;
  // 4 этажа × 4 окна; окно 4×5, в центре ячейки 8×12.
  for (let row = 0; row < 4; row++)
    for (let col = 0; col < 4; col++) {
      const on = hash(n, variant + 1) < lit;
      const x = col * 8 + 2;
      const y = row * 12 + 4;
      if (on) {
        // Мягкое свечение вокруг окна, затем само окно.
        g.fillStyle = 'rgba(255, 190, 100, 0.12)';
        g.fillRect(x - 1, y - 1, 6, 7);
        g.fillStyle = warm[Math.floor(hash(n, 9) * warm.length)];
      } else g.fillStyle = '#2b3549';
      g.fillRect(x, y, 4, 5);
      n++;
    }
  const img = g.getImageData(0, 0, W * px, H * px);
  return { width: img.width, height: img.height, data: img.data };
}

/** Пятно света фонаря на асфальте: тёплый центр, холодный голубоватый край, плавно в прозрачность. */
export function lampImage(px = 2): Img | null {
  const S = 48;
  const cv = canvas(S * px, S * px);
  if (!cv) return null;
  const { g } = cv;
  g.scale(px, px);
  const r = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  r.addColorStop(0, 'rgba(255, 236, 196, 0.55)');
  r.addColorStop(0.25, 'rgba(230, 226, 220, 0.32)');
  r.addColorStop(0.6, 'rgba(140, 185, 255, 0.12)');
  r.addColorStop(1, 'rgba(120, 170, 255, 0)');
  g.fillStyle = r;
  g.fillRect(0, 0, S, S);
  const img = g.getImageData(0, 0, S * px, S * px);
  return { width: img.width, height: img.height, data: img.data };
}

/** Изображение для стиля по его имени (map.on('styleimagemissing')); null — не наше. */
export function gameImage(id: string): Img | null {
  if (id === GAME_TREE) return treeImage(2);
  if (id === GAME_TREE_NIGHT) return treeImage(2, true);
  if (id === GAME_LAMP) return lampImage(2);
  const w = GAME_WINDOWS.indexOf(id);
  if (w >= 0) return windowImage(w, 2);
  return null;
}

export function paletteTransform(p: MapPalette, opts: { roadColor?: string; lite?: boolean } = {}) {
  return (_prev: StyleSpecification | undefined, next: StyleSpecification): StyleSpecification => {
    const copy = structuredClone(next);
    if (p === 'night') return night(copy);
    if (p === 'hud') return hud(copy, opts.roadColor ?? '#9aa3ad');
    if (p === 'game') return game(copy);
    if (p === 'game-night') return game(copy, true, { lite: opts.lite });
    return copy;
  };
}
