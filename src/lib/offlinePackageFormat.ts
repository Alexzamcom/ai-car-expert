import type { StyleSpecification } from 'maplibre-gl';
import type { Place } from './geo/geocode';
import type { LatLon } from './routing';

export type RegionBounds = [number, number, number, number];
export type OfflineAsset = { path: string; bytes: number };
export type OfflineAddress = Place & { aliases?: string[] };

export interface OfflinePackage {
  version: 1;
  engine: 'valhalla-3.9';
  bounds: RegionBounds;
  style: StyleSpecification;
  assets: OfflineAsset[];
}

export function pointInBounds(p: LatLon, [w, s, e, n]: RegionBounds) {
  return p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n;
}

export function validateOfflinePackage(value: OfflinePackage): OfflinePackage {
  const invalid = () => new Error('Несовместимый пакет офлайн-карт.');
  if (value?.version !== 1 || value.engine !== 'valhalla-3.9' || !Array.isArray(value.bounds) || value.bounds.length !== 4 ||
    !value.bounds.every(Number.isFinite) || value.bounds[0] < -180 || value.bounds[2] > 180 || value.bounds[1] < -85 ||
    value.bounds[3] > 85 || value.bounds[0] >= value.bounds[2] || value.bounds[1] >= value.bounds[3] ||
    value.style?.version !== 8 || !value.style.sources || !Array.isArray(value.style.layers) ||
    !Array.isArray(value.assets) || value.assets.length > 75_000) throw invalid();
  const keys = new Set<string>();
  let graphBytes = 0;
  let total = 0;
  let hasVectors = false;
  for (const { path, bytes } of value.assets) {
    if (!/^(graph\/[0-2]\/(?:\d{3}\/){2}\d{3}\.gph|t\/\d{1,2}\/\d+\/\d+|g\/\d+-\d+|addresses\.json)$/.test(path) ||
      !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 36_000_000 || keys.has(path)) throw invalid();
    keys.add(path);
    total += bytes;
    if (path.startsWith('graph/')) graphBytes += bytes;
    if (path.startsWith('t/')) hasVectors = true;
  }
  if (!graphBytes || !hasVectors || !keys.has('addresses.json') || graphBytes > 160_000_000 || total > 450_000_000) throw invalid();
  return value;
}

export function matchOfflineAddresses(addresses: OfflineAddress[], query: string, limit = 12) {
  const normalize = (text: string) => text.toLocaleLowerCase().normalize('NFKC').replace(/[’ʼ']/g, '')
    .replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const terms = normalize(query).split(' ').filter(Boolean);
  if (!terms.length) return [];
  return addresses.filter((place) => {
    const words = normalize([place.name, place.address, ...(place.aliases ?? [])].join(' ')).split(' ');
    return terms.every((term) => words.some((word) => /\d/.test(term) ? word === term : word.startsWith(term)));
  }).slice(0, limit);
}
