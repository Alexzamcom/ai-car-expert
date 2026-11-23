import { CapacitorHttp } from '@capacitor/core';
import type { StyleSpecification } from 'maplibre-gl';
import { createStore } from './store';
import { DEFAULT_STYLE_URL } from './mapStyle';
import type { LatLon } from './routing';

type Bounds = [number, number, number, number];
type Tile = [number, number, number];
export type OfflineRegion = { id: string; name: string; center: LatLon; bounds: Bounds; style: StyleSpecification; bytes: number; updated: number };
const LIMIT_TILES = 3000;
const LIMIT_BYTES = 50_000_000;
const GLYPHS = [0, 256, 512, 768, 1024, 1280, 1536, 1792, 8192, 8448];
const UA = 'AI-Car-Expert-Android/1.0 (https://github.com/Alexzamcom/ai-car-expert)';
export const OFFLINE_PROTOCOL = 'aceoffline';
export const offlineRegions = createStore<OfflineRegion[]>([]);
let db: Promise<IDBDatabase> | undefined;
let init: Promise<void> | undefined;
let downloading = false;

export function areaBounds(center: LatLon, radiusKm: number): Bounds {
  const lat = radiusKm / 111.2;
  const lon = lat / Math.max(0.12, Math.cos(center.lat * Math.PI / 180));
  return [Math.max(-180, center.lon - lon), Math.max(-85, center.lat - lat), Math.min(180, center.lon + lon), Math.min(85, center.lat + lat)];
}

export function areaTiles(bounds: Bounds, maxZoom = 14): Tile[] {
  const result: Tile[] = [];
  for (let z = 0; z <= maxZoom; z++) {
    const n = 2 ** z;
    const index = (v: number) => Math.min(n - 1, Math.max(0, Math.floor(v * n)));
    const x = (lon: number) => index((lon + 180) / 360);
    const y = (lat: number) => index((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2);
    for (let row = y(bounds[3]); row <= y(bounds[1]); row++) {
      for (let col = x(bounds[0]); col <= x(bounds[2]); col++) {
        result.push([z, col, row]);
        if (result.length > LIMIT_TILES) throw new Error('Область превышает лимит OpenFreeMap. Уменьшите радиус.');
      }
    }
  }
  return result;
}

function open() {
  return db ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('ace-offline-maps', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('regions', { keyPath: 'name' });
      request.result.createObjectStore('resources');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((error) => { db = undefined; throw error; });
}

async function read<T>(store: string, key?: string) {
  const database = await open();
  return new Promise<T>((resolve, reject) => {
    const object = database.transaction(store).objectStore(store);
    const request = key == null ? object.getAll() : object.get(key);
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error);
  });
}

async function write(store: string, change: (s: IDBObjectStore) => void) {
  const database = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(store, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    change(tx.objectStore(store));
  });
}

export function initializeOfflineMaps() {
  return init ??= read<OfflineRegion[]>('regions').then((regions) => offlineRegions.set(regions.sort((a, b) => b.updated - a.updated)))
    .catch((error) => { init = undefined; throw error; });
}

export function regionAt(p: LatLon): OfflineRegion | undefined {
  return offlineRegions.get().find(({ bounds: [w, s, e, n] }) => p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n);
}

function purge(id: string) {
  return write('resources', (s) => s.delete(IDBKeyRange.bound(id + '/', id + '/\uffff')));
}

export async function deleteOfflineRegion(region: OfflineRegion) {
  if (downloading) throw new Error('Дождитесь завершения загрузки.');
  await write('regions', (store) => store.delete(region.name));
  offlineRegions.set(offlineRegions.get().filter((r) => r.id !== region.id));
  await purge(region.id);
}

function providerUrl(value: string, base = DEFAULT_STYLE_URL) {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || !['tiles.openfreemap.org', 'openfreemap.org'].includes(url.hostname)) {
    throw new Error('Источник не входит в разрешённый список OpenFreeMap.');
  }
  return url.href.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
}

async function request(url: string, bytes = false) {
  const response = await CapacitorHttp.get({ url: providerUrl(url), headers: { 'User-Agent': UA },
    responseType: bytes ? 'arraybuffer' : 'json', connectTimeout: 12_000, readTimeout: 20_000 });
  if (response.status === 404 && bytes) return new ArrayBuffer(0);
  if (response.status < 200 || response.status >= 300) throw new Error(`OpenFreeMap ответил HTTP ${response.status}`);
  if (!bytes) return typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
  if (typeof response.data !== 'string') throw new Error('Некорректный формат ресурса OpenFreeMap.');
  const text = atob(response.data);
  const data = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) data[i] = text.charCodeAt(i);
  if (data[0] === 31 && data[1] === 139) {
    return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  return data.buffer;
}

type TileJson = { tiles?: string[]; minzoom?: number; maxzoom?: number; scheme?: string; attribution?: string };

export async function downloadOfflineRegion(name: string, center: LatLon, radiusKm: number,
  progress: (data: { done: number; total: number; bytes: number }) => void, signal?: AbortSignal) {
  if (downloading) throw new Error('Дождитесь завершения текущей загрузки.');
  if (!name.trim() || !Number.isFinite(center.lat) || !Number.isFinite(center.lon) || Math.abs(center.lat) >= 80 ||
    Math.abs(center.lon) > 180 || !Number.isFinite(radiusKm) || radiusKm < 2 || radiusKm > 10) throw new Error('Укажите корректный центр и радиус от 2 до 10 км.');
  const old = offlineRegions.get().find((area) => area.name === name);
  const id = `r${Date.now().toString(36)}`;
  downloading = true;
  let published = false;
  try {
    const style = await request(DEFAULT_STYLE_URL) as StyleSpecification;
    const vector = Object.entries(style.sources).filter(([, s]) => s.type === 'vector');
    if (vector.length !== 1) throw new Error('Формат карты OpenFreeMap изменился.');
    const [sourceId, source] = vector[0];
    if (source.type !== 'vector') throw new Error('Не найден векторный источник.');
    const json = (source.url ? await request(providerUrl(source.url)) : source) as TileJson;
    if (!json.tiles?.length || json.scheme === 'tms' || !style.glyphs) throw new Error('Схема карты OpenFreeMap не поддерживается.');
    const template = providerUrl(json.tiles[0], source.url ?? DEFAULT_STYLE_URL);
    const bounds = areaBounds(center, radiusKm);
    const maxZoom = Math.min(14, json.maxzoom ?? 14);
    const tiles = areaTiles(bounds, maxZoom).filter(([z]) => z >= (json.minzoom ?? 0));
    const root = `${OFFLINE_PROTOCOL}://${id}`;
    const font = 'Noto Sans Regular';
    const glyphTemplate = providerUrl(style.glyphs);
    const jobs = [
      ...tiles.map(([z, x, y]) => ({
        key: `t/${z}/${x}/${y}`,
        url: template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)),
      })),
      ...GLYPHS.map((first) => {
        const range = `${first}-${first + 255}`;
        return { key: `g/${range}`, url: glyphTemplate.replace('{fontstack}', encodeURIComponent(font)).replace('{range}', range) };
      }),
    ];
    style.sources = { [sourceId]: { type: 'vector', tiles: [`${root}/t/{z}/{x}/{y}`], bounds,
      minzoom: json.minzoom ?? 0, maxzoom: maxZoom, attribution: json.attribution ?? source.attribution ?? 'OpenFreeMap · © OpenMapTiles · © OpenStreetMap contributors' } };
    delete style.sprite;
    style.glyphs = `${root}/g/{range}?font={fontstack}`;
    style.layers = style.layers.flatMap((layer) => {
      if ('source' in layer && layer.source !== sourceId) return [];
      if (layer.type === 'symbol') {
        if (!layer.layout?.['text-field']) return [];
        layer.layout = { ...layer.layout, 'text-font': [font] };
        delete layer.layout['icon-image'];
      }
      return [layer];
    });
    let bytes = new TextEncoder().encode(JSON.stringify(style)).byteLength;
    progress({ done: 0, total: jobs.length, bytes });
    // Bound concurrency and await all requests in a batch before cleanup.
    for (let i = 0; i < jobs.length; i += 4) {
      signal?.throwIfAborted();
      const batch = jobs.slice(i, i + 4);
      const results = await Promise.allSettled(batch.map((job) => request(job.url, true) as Promise<ArrayBuffer>));
      signal?.throwIfAborted();
      const data = results.map((result) => { if (result.status === 'rejected') throw result.reason; return result.value; });
      bytes += data.reduce((sum, resource) => sum + resource.byteLength, 0);
      if (bytes > LIMIT_BYTES) throw new Error('Область превышает 50 МБ. Уменьшите радиус.');
      await write('resources', (store) => batch.forEach((job, j) => store.put(data[j], `${id}/${job.key}`)));
      progress({ done: i + batch.length, total: jobs.length, bytes });
    }
    const region = { id, name, center, bounds, style, bytes, updated: Date.now() };
    await write('regions', (store) => store.put(region));
    published = true;
    offlineRegions.set([region, ...offlineRegions.get().filter((r) => r.name !== name)]);
    if (old) await purge(old.id).catch(() => {});
    return region;
  } finally {
    if (!published) await purge(id).catch(() => {});
    downloading = false;
  }
}

export async function offlineResource(url: string) {
  const parsed = new URL(url);
  const buffer = await read<ArrayBuffer | undefined>('resources', parsed.hostname + parsed.pathname);
  // Outside the chosen region or unsupported font range: valid empty PBF.
  return { data: buffer ?? new ArrayBuffer(0) };
}

export const EMPTY_OFFLINE_STYLE: StyleSpecification = {
  version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e6e2d9' } }],
};

export const offlineStatus = createStore<{ local: boolean; region: string | null }>({ local: false, region: null });
let protocolRegistered = false;
export function registerOfflineProtocol(addProtocol: (name: string, handler: (request: { url: string }) => Promise<{ data: ArrayBuffer }>) => void) {
  if (!protocolRegistered) {
    addProtocol(OFFLINE_PROTOCOL, (request) => offlineResource(request.url));
    protocolRegistered = true;
  }
}

export function offlineStyleFor(p: LatLon) {
  const region = regionAt(p) ?? offlineRegions.get()[0];
  return { style: region?.style ?? EMPTY_OFFLINE_STYLE, region: region?.name ?? null };
}
