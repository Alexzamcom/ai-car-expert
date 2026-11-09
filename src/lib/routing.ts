/* Маршруты: запрос к OSRM, текст манёвров, расчёт прогресса по маршруту.
   Чистые функции (без DOM) — покрыты unit-тестами. */

export type LatLon = { lat: number; lon: number };

export interface RouteStep {
  distance: number; // м до следующего манёвра
  duration: number; // с
  name: string; // название дороги после манёвра
  type: string; // OSRM maneuver.type
  modifier?: string; // OSRM maneuver.modifier
  exit?: number; // номер съезда на кольце
  location: LatLon; // точка манёвра
}

export interface Route {
  distance: number; // м
  duration: number; // с (без учёта пробок)
  coords: LatLon[];
  steps: RouteStep[];
}

export const OSRM_URL = 'https://router.project-osrm.org';

interface OsrmStep {
  distance: number;
  duration: number;
  name: string;
  ref?: string;
  maneuver: { type: string; modifier?: string; exit?: number; location: [number, number] };
}

export function parseOsrm(json: unknown): Route {
  const data = json as {
    code?: string;
    message?: string;
    routes?: { distance: number; duration: number; geometry: { coordinates: [number, number][] }; legs: { steps: OsrmStep[] }[] }[];
  };
  if (data.code !== 'Ok' || !data.routes?.length) {
    throw new Error(data.code === 'NoRoute' ? 'Маршрут не найден' : data.message || 'Сервис маршрутов не ответил');
  }
  const r = data.routes[0];
  return {
    distance: r.distance,
    duration: r.duration,
    coords: r.geometry.coordinates.map(([lon, lat]) => ({ lat, lon })),
    steps: r.legs.flatMap((leg, li) =>
      leg.steps.map((s) => ({
        distance: s.distance,
        duration: s.duration,
        name: s.name || s.ref || '',
        // «arrive» промежуточного участка — это промежуточная точка, а не финиш.
        type: s.maneuver.type === 'arrive' && li < r.legs.length - 1 ? 'waypoint' : s.maneuver.type,
        modifier: s.maneuver.modifier,
        exit: s.maneuver.exit,
        location: { lat: s.maneuver.location[1], lon: s.maneuver.location[0] },
      })),
    ),
  };
}

export async function fetchRoute(from: LatLon, to: LatLon, signal?: AbortSignal, via?: LatLon): Promise<Route> {
  const pts = [from, ...(via ? [via] : []), to].map((p) => `${p.lon},${p.lat}`).join(';');
  const url = `${OSRM_URL}/route/v1/driving/${pts}?overview=full&geometries=geojson&steps=true&alternatives=false`;
  const res = await fetch(url, { signal });
  if (res.status === 429) throw new Error('Сервис маршрутов перегружен, повторите позже');
  return parseOsrm(await res.json());
}

/* ---------- Текст манёвров ---------- */

export type Lang = 'ru' | 'uk' | 'en';

const DIR: Record<Lang, Record<string, string>> = {
  ru: {
    left: 'налево',
    right: 'направо',
    'slight left': 'плавно налево',
    'slight right': 'плавно направо',
    'sharp left': 'резко налево',
    'sharp right': 'резко направо',
    straight: 'прямо',
    uturn: 'разворот',
  },
  uk: {
    left: 'ліворуч',
    right: 'праворуч',
    'slight left': 'плавно ліворуч',
    'slight right': 'плавно праворуч',
    'sharp left': 'різко ліворуч',
    'sharp right': 'різко праворуч',
    straight: 'прямо',
    uturn: 'розворот',
  },
  en: {
    left: 'left',
    right: 'right',
    'slight left': 'slight left',
    'slight right': 'slight right',
    'sharp left': 'sharp left',
    'sharp right': 'sharp right',
    straight: 'straight',
    uturn: 'U-turn',
  },
};

const T = {
  ru: { depart: 'Начните движение', arrive: 'Вы прибыли', turn: 'Поверните', keep: 'Держитесь', roundabout: 'На кольце', exit: 'съезд', onto: 'на', merge: 'Перестройтесь', ramp: 'Съезд', fork: 'На развилке', continue: 'Продолжайте', uturn: 'Развернитесь', waypoint: 'Промежуточная точка' },
  uk: { depart: 'Почніть рух', arrive: 'Ви прибули', turn: 'Поверніть', keep: 'Тримайтеся', roundabout: 'На колі', exit: "з'їзд", onto: 'на', merge: 'Перешикуйтеся', ramp: "З'їзд", fork: 'На розвилці', continue: 'Продовжуйте', uturn: 'Розверніться', waypoint: 'Проміжна точка' },
  en: { depart: 'Start driving', arrive: 'You have arrived', turn: 'Turn', keep: 'Keep', roundabout: 'At the roundabout take', exit: 'exit', onto: 'onto', merge: 'Merge', ramp: 'Take the ramp', fork: 'At the fork keep', continue: 'Continue', uturn: 'Make a U-turn', waypoint: 'Waypoint reached' },
};

const ORD: Record<Lang, (n: number) => string> = {
  ru: (n) => `${n}-й`,
  uk: (n) => `${n}-й`,
  en: (n) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`,
};

export function stepText(s: RouteStep, lang: Lang = 'ru'): string {
  const t = T[lang];
  const dir = s.modifier ? DIR[lang][s.modifier] ?? s.modifier : '';
  const onto = s.name ? ` ${t.onto} ${s.name}` : '';
  switch (s.type) {
    case 'depart':
      return `${t.depart}${onto}`;
    case 'arrive':
      return t.arrive;
    case 'waypoint':
      return t.waypoint;
    case 'depart_after_waypoint':
      return t.continue;
    case 'roundabout':
    case 'rotary':
    case 'roundabout turn':
      return s.exit ? `${t.roundabout} ${ORD[lang](s.exit)} ${t.exit}${onto}` : `${t.roundabout}${onto}`;
    case 'exit roundabout':
    case 'exit rotary':
      return `${t.continue}${onto}`;
    case 'merge':
      return `${t.merge}${dir ? ` ${dir}` : ''}${onto}`;
    case 'on ramp':
    case 'off ramp':
      return `${t.ramp}${dir ? ` ${dir}` : ''}${onto}`;
    case 'fork':
      return `${t.fork} ${dir}${onto}`.trim();
    case 'continue':
    case 'new name':
      if (s.modifier === 'uturn') return t.uturn;
      return s.modifier && s.modifier !== 'straight' ? `${t.keep} ${dir}${onto}` : `${t.continue}${onto}`;
    default:
      if (s.modifier === 'uturn') return t.uturn;
      if (s.modifier === 'straight') return `${t.continue} ${dir}${onto}`;
      return `${t.turn} ${dir}${onto}`.trim();
  }
}

/** Иконка манёвра (имя из набора Icon). */
export function stepIcon(s: RouteStep): 'arrowLeft' | 'arrowRight' | 'arrowUp' | 'uturn' | 'roundabout' | 'flag' {
  if (s.type === 'arrive' || s.type === 'waypoint') return 'flag';
  if (s.type.includes('roundabout') || s.type.includes('rotary')) return 'roundabout';
  if (s.modifier === 'uturn') return 'uturn';
  if (s.modifier?.includes('left')) return 'arrowLeft';
  if (s.modifier?.includes('right')) return 'arrowRight';
  return 'arrowUp';
}

/* ---------- Форматирование ---------- */

export function fmtDistance(m: number, lang: Lang = 'ru'): string {
  const km = lang === 'en' ? 'km' : 'км';
  const mm = lang === 'en' ? 'm' : 'м';
  if (m >= 10000) return `${Math.round(m / 1000)} ${km}`;
  if (m >= 1000) return `${(m / 1000).toFixed(1).replace('.', lang === 'en' ? '.' : ',')} ${km}`;
  if (m >= 100) return `${Math.round(m / 50) * 50} ${mm}`;
  return `${Math.max(0, Math.round(m / 10) * 10)} ${mm}`;
}

export function fmtDuration(sec: number, lang: Lang = 'ru'): string {
  const min = Math.max(1, Math.round(sec / 60));
  const h = Math.floor(min / 60);
  const m = min % 60;
  const [hh, mm] = lang === 'en' ? ['h', 'min'] : lang === 'uk' ? ['год', 'хв'] : ['ч', 'мин'];
  return h ? `${h} ${hh} ${m} ${mm}` : `${m} ${mm}`;
}

/* ---------- Геометрия и прогресс ---------- */

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversine(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Проекция точки на отрезок в локальной плоской системе (метры). */
function projectOnSegment(p: LatLon, a: LatLon, b: LatLon) {
  const kx = Math.cos(rad(p.lat)) * R * (Math.PI / 180);
  const ky = R * (Math.PI / 180);
  const ax = (a.lon - p.lon) * kx;
  const ay = (a.lat - p.lat) * ky;
  const bx = (b.lon - p.lon) * kx;
  const by = (b.lat - p.lat) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  const x = ax + t * dx;
  const y = ay + t * dy;
  return { t, dist: Math.hypot(x, y) };
}

export interface Progress {
  segIndex: number; // индекс сегмента ломаной
  offRouteM: number; // расстояние до линии маршрута
  remainingM: number; // осталось до финиша по маршруту
  stepIndex: number; // индекс следующего манёвра
  toStepM: number; // до следующего манёвра
}

/** Накопленная дистанция вдоль ломаной до каждой вершины. */
export function cumulative(coords: LatLon[]): number[] {
  const out = [0];
  for (let i = 1; i < coords.length; i++) out.push(out[i - 1] + haversine(coords[i - 1], coords[i]));
  return out;
}

/** Ближайшая вершина ломаной к точке (для привязки манёвров). */
function nearestVertex(coords: LatLon[], p: LatLon, from = 0): number {
  let best = from;
  let bestD = Infinity;
  for (let i = from; i < coords.length; i++) {
    const d = haversine(coords[i], p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Позиции манёвров вдоль маршрута (м от старта). */
export function stepOffsets(route: Route, cum = cumulative(route.coords)): number[] {
  let from = 0;
  return route.steps.map((s) => {
    const i = nearestVertex(route.coords, s.location, from);
    from = i;
    return cum[i];
  });
}

export function routeProgress(
  route: Route,
  pos: LatLon,
  cache?: { cum: number[]; offsets: number[] },
  hintSeg = 0,
): Progress {
  const cum = cache?.cum ?? cumulative(route.coords);
  const offsets = cache?.offsets ?? stepOffsets(route, cum);
  const c = route.coords;
  let best = { i: 0, dist: Infinity, along: 0 };
  // Ищем сначала около предыдущего сегмента, чтобы не «перепрыгивать» на встречную ветку.
  const start = Math.max(0, hintSeg - 5);
  for (let i = start; i < c.length - 1; i++) {
    const pr = projectOnSegment(pos, c[i], c[i + 1]);
    if (pr.dist < best.dist - 0.5) best = { i, dist: pr.dist, along: cum[i] + pr.t * (cum[i + 1] - cum[i]) };
  }
  if (c.length === 1) best = { i: 0, dist: haversine(pos, c[0]), along: 0 };
  const total = cum[cum.length - 1] ?? 0;
  let stepIndex = offsets.findIndex((o, idx) => idx > 0 && o > best.along + 5);
  if (stepIndex === -1) stepIndex = route.steps.length - 1;
  return {
    segIndex: best.i,
    offRouteM: best.dist,
    remainingM: Math.max(0, total - best.along),
    stepIndex,
    toStepM: Math.max(0, offsets[stepIndex] - best.along),
  };
}

/** Прореживание ломаной для запросов «вдоль маршрута». */
export function downsample(coords: LatLon[], maxPoints = 80): LatLon[] {
  if (coords.length <= maxPoints) return coords;
  const step = (coords.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, i) => coords[Math.round(i * step)]);
}

/** Минимальное расстояние от точки до ломаной и позиция вдоль неё. */
export function distanceToRoute(route: Route, p: LatLon, cum = cumulative(route.coords)) {
  let best = { dist: Infinity, along: 0 };
  for (let i = 0; i < route.coords.length - 1; i++) {
    const pr = projectOnSegment(p, route.coords[i], route.coords[i + 1]);
    if (pr.dist < best.dist) best = { dist: pr.dist, along: cum[i] + pr.t * (cum[i + 1] - cum[i]) };
  }
  return best;
}
