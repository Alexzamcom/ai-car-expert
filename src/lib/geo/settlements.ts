import { fetchJson } from './http';
import { PHOTON, type Place } from './geocode';

export const OFFLINE_CATALOG = 'https://raw.githubusercontent.com/Alexzamcom/ai-car-expert/offline-map-data/catalog.json';
const types = new Set(['city', 'town', 'village', 'hamlet', 'municipality']);
export type Settlement = Place & {
  region: string; country: string; countryCode: string; aliases: string[];
  packages?: Partial<Record<10 | 25 | 50 | 100, string>>;
};
type Feature = {
  geometry: { type?: string; coordinates: [number, number] };
  properties: {
    osm_type?: string; osm_id?: number; osm_value?: string; name?: string; state?: string;
    county?: string; country?: string; countrycode?: string;
  };
};

function normalize(value: string) {
  return value.toLocaleLowerCase('uk').normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[’ʼ']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function rankSettlements(query: string, catalog: Settlement[], features: Feature[]) {
  const key = normalize(query);
  const combined = new Map<string, Settlement>();
  for (const f of features) {
    const p = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    if (!p.name || !p.osm_type || !/^[NWR]$/.test(p.osm_type) || !Number.isSafeInteger(p.osm_id) ||
      !types.has(p.osm_value ?? '') || !Number.isFinite(lat) || Math.abs(lat) > 85 ||
      !Number.isFinite(lon) || Math.abs(lon) > 180 || !p.countrycode || !p.country) continue;
    const region = p.state ?? p.county ?? '';
    const countryCode = p.countrycode.toUpperCase();
    combined.set(`osm-${p.osm_type}-${p.osm_id}`, { id: `osm-${p.osm_type}-${p.osm_id}`, name: p.name,
      lat, lon, region, country: p.country, countryCode, aliases: [],
      address: [region, p.country].filter(Boolean).join(' · ') });
  }
  for (const place of catalog) {
    const rank = [place.name, ...place.aliases].some((name) => normalize(name).includes(key));
    if (rank || combined.has(place.id)) combined.set(place.id, place);
  }
  const score = (place: Settlement) => Math.max(...[place.name, ...place.aliases].map((name) => {
    const value = normalize(name);
    return value === key ? 100 : value.startsWith(key) ? 50 : 0;
  })) + (place.packages ? 1 : 0);
  return [...combined.values()].sort((a, b) => score(b) - score(a)).slice(0, 15);
}

export async function searchSettlements(query: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ q: query.trim(), limit: '15', osm_tag: 'place' });
  const [catalog, photon] = await Promise.allSettled([
    fetchJson<{ settlements: Settlement[] }>(OFFLINE_CATALOG, { service: 'Каталог офлайн-карт', timeoutMs: 7000, signal }),
    fetchJson<{ features: Feature[] }>(`${PHOTON}/api/?${params}`, { service: 'Photon', timeoutMs: 8000, signal }),
  ]);
  signal?.throwIfAborted();
  if (catalog.status === 'rejected' && photon.status === 'rejected') throw new Error('Поиск населённых пунктов недоступен. Проверьте подключение.');
  return rankSettlements(query, catalog.status === 'fulfilled' && Array.isArray(catalog.value.settlements)
    ? catalog.value.settlements : [], photon.status === 'fulfilled' ? photon.value.features ?? [] : []);
}

export function settlementPackage(place: Settlement, radius: 10 | 25 | 50 | 100) {
  const path = place.packages?.[radius];
  if (!path || !/^regions\/osm-[NWR]-\d+\/\d+\/manifest\.json$/.test(path)) return null;
  return new URL(path, OFFLINE_CATALOG).href;
}
