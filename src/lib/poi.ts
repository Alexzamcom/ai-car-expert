/* Объекты вдоль маршрута или рядом: АЗС, места отдыха, кафе (OpenStreetMap / Overpass API). */
import { distanceToRoute, cumulative, haversine, type LatLon, type Route } from './routing';

export type PoiCategory = 'fuel' | 'rest' | 'food' | 'parking';

export const POI_CATEGORIES: Record<PoiCategory, { label: string; query: string }> = {
  fuel: { label: 'АЗС', query: 'nwr["amenity"="fuel"]' },
  rest: { label: 'Отдых', query: 'nwr["highway"~"^(rest_area|services)$"]' },
  food: { label: 'Кафе', query: 'nwr["amenity"~"^(cafe|fast_food|restaurant)$"]' },
  parking: { label: 'Парковки', query: 'nwr["amenity"="parking"]' },
};

export interface Poi {
  id: string;
  name: string;
  brand?: string;
  lat: number;
  lon: number;
  category: PoiCategory;
  /** Для «вдоль маршрута»: где на маршруте и как далеко от него. */
  alongM?: number;
  detourM?: number;
  /** Для «рядом»: расстояние от текущей точки. */
  distanceM?: number;
  openingHours?: string;
}

/** Публичные серверы Overpass часто перегружены: спрашиваем все сразу, берём первый корректный ответ. */
export const OVERPASS_SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
/** Живая проверка: зеркало отвечало за 12,7 с — ждём дольше, но параллельно. */
const SERVER_TIMEOUT = 25000;

export function buildQuery(category: PoiCategory, around: { radius: number; points: LatLon[] }): string {
  const pts = around.points.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join(',');
  return `[out:json][timeout:12];${POI_CATEGORIES[category].query}(around:${around.radius},${pts});out center 60;`;
}

export type BBox = [south: number, west: number, north: number, east: number];

/** Участок маршрута впереди → несколько прямоугольников с запасом corridorM.
    Поиск по прямоугольникам для Overpass намного дешевле, чем «around» по ломаной. */
export function routeBoxes(coords: LatLon[], corridorM: number, maxAheadM = 60000, chunkM = 8000): BBox[] {
  const boxes: BBox[] = [];
  let box: BBox | null = null;
  let chunk = 0;
  let total = 0;
  for (let i = 0; i < coords.length; i++) {
    const c = coords[i];
    if (i > 0) {
      const d = haversine(coords[i - 1], c);
      chunk += d;
      total += d;
    }
    if (!box) box = [c.lat, c.lon, c.lat, c.lon];
    box = [Math.min(box[0], c.lat), Math.min(box[1], c.lon), Math.max(box[2], c.lat), Math.max(box[3], c.lon)];
    if (chunk >= chunkM || total >= maxAheadM || i === coords.length - 1) {
      boxes.push(box);
      // следующий прямоугольник начинается с этой же точки, чтобы не было разрывов
      box = [c.lat, c.lon, c.lat, c.lon];
      chunk = 0;
      if (total >= maxAheadM) break;
    }
  }
  const dLat = corridorM / 111_320;
  return boxes.map(([s, w, n, e]) => {
    const dLon = corridorM / (111_320 * Math.cos(((s + n) / 2) * (Math.PI / 180)));
    return [s - dLat, w - dLon, n + dLat, e + dLon] as BBox;
  });
}

export function buildBoxQuery(category: PoiCategory, boxes: BBox[]): string {
  const q = POI_CATEGORIES[category].query;
  const parts = boxes.map((b) => `${q}(${b.map((x) => x.toFixed(5)).join(',')});`).join('');
  return `[out:json][timeout:12];(${parts});out center 80;`;
}

interface OverpassEl {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export function parseOverpass(json: unknown, category: PoiCategory): Poi[] {
  const els = ((json as { elements?: OverpassEl[] }).elements ?? []).filter((e) => (e.lat ?? e.center?.lat) != null);
  return els.map((e) => {
    const t = e.tags ?? {};
    const fallback = POI_CATEGORIES[category].label;
    return {
      id: `${e.type}/${e.id}`,
      name: t.name || t.brand || t.operator || fallback,
      brand: t.brand,
      lat: e.lat ?? e.center!.lat,
      lon: e.lon ?? e.center!.lon,
      category,
      openingHours: t.opening_hours,
    };
  });
}

async function askServer(server: string, query: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(server, { method: 'POST', body: new URLSearchParams({ data: query }), signal });
  if (!res.ok) throw new Error(res.status === 429 || res.status === 504 ? 'Сервис поиска объектов перегружен' : `Поиск объектов недоступен (${res.status})`);
  const json = (await res.json()) as { remark?: string };
  // При нехватке времени Overpass отвечает 200 с пустым результатом и пометкой remark.
  if (json.remark && /timed out|out of memory/i.test(json.remark)) throw new Error('Сервис поиска объектов не успел ответить');
  return json;
}

async function overpass(query: string, signal?: AbortSignal): Promise<unknown> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => ctrl.abort(), SERVER_TIMEOUT);
  try {
    // Первый успешный ответ побеждает, остальные запросы отменяются в finally.
    return await Promise.any(OVERPASS_SERVERS.map((s) => askServer(s, query, ctrl.signal)));
  } catch (e) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const errors = e instanceof AggregateError ? (e.errors as Error[]) : [e as Error];
    const meaningful = errors.find((x) => x && x.name !== 'AbortError' && !/fetch/i.test(x.message));
    throw meaningful ?? new Error('Сервис поиска объектов не ответил вовремя');
  } finally {
    clearTimeout(timer);
    ctrl.abort();
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Объекты в коридоре вдоль маршрута, по порядку следования. */
export async function poiAlongRoute(route: Route, category: PoiCategory, from: number, signal?: AbortSignal, corridorM = 1000): Promise<Poi[]> {
  const cum = cumulative(route.coords);
  // Берём часть маршрута, которая ещё впереди.
  const startIdx = Math.max(0, cum.findIndex((d) => d >= from) - 1);
  const ahead = route.coords.slice(startIdx);
  const json = await overpass(buildBoxQuery(category, routeBoxes(ahead, corridorM)), signal);
  return parseOverpass(json, category)
    .map((p) => {
      const d = distanceToRoute(route, p, cum);
      return { ...p, alongM: d.along - from, detourM: d.dist };
    })
    .filter((p) => (p.alongM ?? 0) > -200 && (p.detourM ?? 0) <= corridorM)
    .sort((a, b) => (a.alongM ?? 0) - (b.alongM ?? 0))
    .slice(0, 25);
}

/** Объекты рядом с точкой. */
export async function poiNearby(pos: LatLon, category: PoiCategory, signal?: AbortSignal, radius = 5000): Promise<Poi[]> {
  const json = await overpass(buildQuery(category, { radius, points: [pos] }), signal);
  return parseOverpass(json, category)
    .map((p) => ({ ...p, distanceM: haversine(pos, p) }))
    .sort((a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0))
    .slice(0, 25);
}
