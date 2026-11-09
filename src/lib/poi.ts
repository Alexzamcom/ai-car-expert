/* Объекты вдоль маршрута или рядом: АЗС, места отдыха, кафе (OpenStreetMap / Overpass API). */
import { downsample, distanceToRoute, cumulative, haversine, type LatLon, type Route } from './routing';

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

const OVERPASS = 'https://overpass-api.de/api/interpreter';

export function buildQuery(category: PoiCategory, around: { radius: number; points: LatLon[] }): string {
  const pts = around.points.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join(',');
  // around с несколькими точками трактуется Overpass как ломаная линия.
  return `[out:json][timeout:20];${POI_CATEGORIES[category].query}(around:${around.radius},${pts});out center 60;`;
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

async function overpass(query: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(OVERPASS, {
    method: 'POST',
    body: new URLSearchParams({ data: query }),
    signal,
  });
  if (res.status === 429 || res.status === 504) throw new Error('Сервис поиска объектов перегружен, повторите позже');
  if (!res.ok) throw new Error(`Поиск объектов недоступен (${res.status})`);
  return res.json();
}

/** Объекты в коридоре вдоль маршрута, по порядку следования. */
export async function poiAlongRoute(route: Route, category: PoiCategory, from: number, signal?: AbortSignal, corridorM = 1000): Promise<Poi[]> {
  const cum = cumulative(route.coords);
  // Берём часть маршрута, которая ещё впереди.
  const startIdx = Math.max(0, cum.findIndex((d) => d >= from) - 1);
  const ahead = route.coords.slice(startIdx);
  const json = await overpass(buildQuery(category, { radius: corridorM, points: downsample(ahead, 90) }), signal);
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
