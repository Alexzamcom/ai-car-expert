import type { StyleSpecification } from 'maplibre-gl';
import type { Place } from './geo/geocode';
import type { LatLon } from './routing';

export type RegionBounds = [number, number, number, number];
export type OfflineAsset = { path: string; bytes: number; chunk?: number; offset?: number; sha256?: string };
export type OfflineAddress = Place & { aliases?: string[] };

export interface OfflinePackage {
  version: 1;
  engine: 'valhalla-3.9';
  bounds: RegionBounds;
  style: StyleSpecification;
  assets: OfflineAsset[];
  chunks?: { path: string; bytes: number; sha256: string }[];
  settlementId?: string;
  center?: LatLon;
  radiusKm?: number;
  dataDate?: string;
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
  if (value.chunks) {
    const hex = /^[a-f0-9]{64}$/;
    if (!Array.isArray(value.chunks) || !value.chunks.length || value.chunks.length > 2000 ||
      !/^osm-[NWR]-\d+$/.test(value.settlementId ?? '') || !value.center ||
      ![value.center.lat, value.center.lon].every(Number.isFinite) || !pointInBounds(value.center, value.bounds) ||
      ![10, 25, 50, 100].includes(value.radiusKm ?? 0) || !Number.isFinite(Date.parse(value.dataDate ?? ''))) throw invalid();
    const consumed = value.chunks.map((chunk, index) => {
      if (!chunk || chunk.path !== `data-${index}.bin` || !hex.test(chunk.sha256) ||
        !Number.isSafeInteger(chunk.bytes) || chunk.bytes <= 0 || chunk.bytes > 36_000_000) throw invalid();
      return 0;
    });
    for (const asset of value.assets) {
      const index = asset.chunk ?? -1;
      if (!Number.isInteger(index) || index < 0 || index >= consumed.length || consumed[index] !== asset.offset ||
        !hex.test(asset.sha256 ?? '')) throw invalid();
      consumed[index] += asset.bytes;
    }
    if (consumed.some((bytes, index) => bytes !== value.chunks![index].bytes)) throw invalid();
  }
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

export function verifyRegionIdentity(pkg: OfflinePackage, id: string, center: LatLon, radiusKm: number) {
  if (!pkg.chunks || pkg.settlementId !== id || pkg.radiusKm !== radiusKm || !pkg.center ||
    Math.abs(pkg.center.lat - center.lat) > 0.000001 || Math.abs(pkg.center.lon - center.lon) > 0.000001) {
    throw new Error('Пакет относится к другому населённому пункту или радиусу.');
  }
}
