import { encodeBytes, iosOffline, offlineFiles, readIosAsset, writeIosAssets } from './iosOfflineFiles';
import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';
import { createStore } from './store';
import { DEFAULT_STYLE_URL } from './mapStyle';
import type { LatLon } from './routing';
import { matchOfflineAddresses, pointInBounds, validateOfflinePackage, type OfflineAddress, type OfflinePackage } from './offlinePackageFormat';

type Bounds = [number, number, number, number];
type Tile = [number, number, number];
export type OfflineRegion = { id: string; name: string; center: LatLon; bounds: Bounds; style: StyleSpecification; bytes: number; updated: number; packageUrl?: string; graph?: string[]; radiusKm?: number; settlementId?: string; dataDate?: string };
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

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
}

function open() {
  return db ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('ace-offline-maps', 1);
    let expired = false;
    const deadline = setTimeout(() => {
      expired = true;
      reject(new Error('IndexedDB open timed out'));
    }, 5000);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('regions', { keyPath: 'name' });
      request.result.createObjectStore('resources');
    };
    request.onsuccess = () => {
      clearTimeout(deadline);
      const database = request.result;
      if (expired) { database.close(); return; }
      database.onversionchange = () => { database.close(); db = undefined; init = undefined; };
      resolve(database);
    };
    request.onerror = () => { clearTimeout(deadline); reject(request.error); };
  }).catch((error) => { db = undefined; throw error; });
}

async function read<T>(store: string, key?: string) {
  const database = await open();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(store);
    const object = transaction.objectStore(store);
    const deadline = setTimeout(() => {
      reject(new Error('IndexedDB read timed out'));
      try { transaction.abort(); } catch { /* Already closed. */ }
    }, 2000);
    const request = key == null ? object.getAll() : object.get(key);
    request.onsuccess = () => { clearTimeout(deadline); resolve(request.result as T); };
    request.onerror = () => { clearTimeout(deadline); reject(request.error); };
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
  return init ??= (iosOffline() ? offlineFiles.regions().then(({ entries }) => entries) : read<OfflineRegion[]>('regions')).then((regions) => offlineRegions.set(regions.sort((a, b) => b.updated - a.updated)))
    .catch((error) => { init = undefined; throw error; });
}

export function regionAt(p: LatLon): OfflineRegion | undefined {
  return offlineRegions.get().find(({ bounds: [w, s, e, n] }) => p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n);
}

function purge(id: string) {
  if (iosOffline()) return offlineFiles.erase({ id });
  return write('resources', (s) => s.delete(IDBKeyRange.bound(id + '/', id + '/\uffff')));
}

export async function deleteOfflineRegion(region: OfflineRegion) {
  if (downloading) throw new Error('Дождитесь завершения загрузки.');
  if (iosOffline()) await offlineFiles.remove({ id: region.id });
  else await write('regions', (store) => store.delete(region.name));
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
    style.layers = style.layers.flatMap<LayerSpecification>((layer) => {
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
      checkAbort(signal);
      const batch = jobs.slice(i, i + 4);
      const results = await Promise.allSettled(batch.map((job) => request(job.url, true) as Promise<ArrayBuffer>));
      checkAbort(signal);
      const data = results.map((result) => { if (result.status === 'rejected') throw result.reason; return result.value; });
      bytes += data.reduce((sum, resource) => sum + resource.byteLength, 0);
      if (bytes > LIMIT_BYTES) throw new Error('Область превышает 50 МБ. Уменьшите радиус.');
      if (iosOffline()) await writeIosAssets(id, batch.map((job, j) => [job.key, data[j]]), signal);
      else await write('resources', (store) => batch.forEach((job, j) => store.put(data[j], `${id}/${job.key}`)));
      progress({ done: i + batch.length, total: jobs.length, bytes });
    }
    const region = { id, name, center, bounds, style, bytes, updated: Date.now() };
    if (iosOffline()) await offlineFiles.publish({ region, previous: old?.id });
    else await write('regions', (store) => store.put(region));
    published = true;
    offlineRegions.set([region, ...offlineRegions.get().filter((r) => r.name !== name)]);
    if (old) await purge(old.id).catch(() => {});
    return region;
  } finally {
    if (!published) await purge(id).catch(() => {});
    downloading = false;
  }
}

export async function getOfflinePackage(url: string, signal?: AbortSignal) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('Укажите HTTPS-адрес пакета.');
  const response = await fetch(endpoint, { signal, credentials: 'omit', cache: 'no-cache' });
  if (!response.ok) throw new Error('Карта для этого населённого пункта и радиуса недоступна.');
  return validateOfflinePackage(await response.json());
}

const offlineStorage = registerPlugin<{ capacity(): Promise<{ availableBytes: number }> }>('OfflineStorage');
const remainingSpace = async () => {
  const { quota, usage } = await navigator.storage?.estimate?.().catch(() => undefined) ?? {};
  const browserAvailable = typeof quota === 'number' && typeof usage === 'number' ? Math.max(0, quota - usage) : Infinity;
  if (iosOffline()) return (await offlineFiles.capacity()).availableBytes;
  const physical = Capacitor.isPluginAvailable('OfflineStorage')
    ? (await offlineStorage.capacity().catch(() => undefined))?.availableBytes ?? Infinity : Infinity;
  const free = Math.min(browserAvailable, physical);
  return Number.isFinite(free) ? free : null;
};

const digest = async (buffer: ArrayBuffer) => {
  if (!globalThis.crypto?.subtle && iosOffline()) return (await offlineFiles.digest({ data: encodeBytes(buffer) })).hash;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), (value) => value.toString(16).padStart(2, '0')).join('');
};

export const regionalStorageBytes = (remaining: number) => Math.ceil(remaining * 1.15) + 8_000_000;

async function fetchAsset(url: URL, bytes: number, signal?: AbortSignal) {
  const request = new AbortController();
  const stop = () => request.abort();
  signal?.addEventListener('abort', stop, { once: true });
  const deadline = setTimeout(stop, 60_000);
  try {
    checkAbort(signal);
    const response = await fetch(url, { signal: request.signal, credentials: 'omit', redirect: 'error' });
    if (!response.ok) throw new Error(`Не удалось загрузить ресурс пакета (HTTP ${response.status}).`);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== bytes) throw new Error('Размер ресурса отличается от указанного в пакете.');
    return buffer;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', stop);
  }
}

export type Checkpoint = { id: string; fingerprint: string; done: number; bytes: number };
const checkpointKey = (url: string) => `checkpoint:${url}`;


async function readCheckpoint(url: string) {
  const key = checkpointKey(url);
  return iosOffline() ? (await offlineFiles.checkpoint({ key })).entry : read<Checkpoint | undefined>('resources', key);
}
async function removeCheckpoint(url: string) {
  const key = checkpointKey(url);
  if (iosOffline()) await offlineFiles.checkpoint({ key, remove: true });
  else await write('resources', (store) => store.delete(key));
}

export async function regionalDownloadState(url: string, pkg: OfflinePackage) {
  const fingerprint = await digest(new TextEncoder().encode(JSON.stringify(pkg)).buffer);
  const cached = await readCheckpoint(url);
  // A crash after atomically publishing a region can leave its old checkpoint.
  const checkpoint = cached && !offlineRegions.get().some(({ id }) => id === cached.id) ? cached : undefined;
  return { fingerprint, checkpoint, matching: checkpoint?.fingerprint === fingerprint ? checkpoint : undefined };
}

export async function discardRegionalDownload(url: string) {
  const checkpoint = await readCheckpoint(url);
  if (checkpoint && !offlineRegions.get().some(({ id }) => id === checkpoint.id)) await purge(checkpoint.id);
  if (checkpoint) await removeCheckpoint(url);
}

export async function downloadNavigationPackage(name: string, center: LatLon, radiusKm: number, packageUrl: string, manifest: OfflinePackage,
  progress: (data: { done: number; total: number; bytes: number }) => void, signal?: AbortSignal) {
  if (downloading) throw new Error('Дождитесь завершения текущей загрузки.');
  const pkg = validateOfflinePackage(manifest);
  const bounds = areaBounds(center, radiusKm);
  if (!pointInBounds({ lon: bounds[0], lat: bounds[1] }, pkg.bounds) ||
    !pointInBounds({ lon: bounds[2], lat: bounds[3] }, pkg.bounds)) throw new Error('Пакет не покрывает выбранную территорию.');
  const url = new URL(packageUrl);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Укажите HTTPS-адрес пакета.');
  const key = `${name} · ${radiusKm} км`;
  const old = offlineRegions.get().find((item) => pkg.settlementId ?
    item.settlementId === pkg.settlementId && item.radiusKm === radiusKm : item.name === key);
  let id = 'p' + Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, '0')).join('');
  downloading = true;
  let published = false;
  let bytes = 0;
  try {
    const totalBytes = pkg.assets.reduce((sum, asset) => sum + asset.bytes, 0);
    const state = pkg.chunks ? await regionalDownloadState(url.href, pkg) : undefined;
    if (state?.checkpoint && !state.matching) await discardRegionalDownload(url.href);
    if (state?.matching) {
      id = state.matching.id;
      bytes = state.matching.bytes;
    }
    const free = await remainingSpace();
    if (free !== null && free < regionalStorageBytes(totalBytes - bytes)) throw new Error('Недостаточно свободного места для установки карты.');
    checkAbort(signal);
    const root = `${OFFLINE_PROTOCOL}://${id}`;
    const style: StyleSpecification = JSON.parse(JSON.stringify(pkg.style));
    const vectors = Object.entries(style.sources).filter(([, source]) => source.type === 'vector');
    if (vectors.length !== 1) throw new Error('Пакет должен содержать один источник векторной карты.');
    const [sourceId, source] = vectors[0];
    if (source.type !== 'vector') throw new Error('Пакет не содержит векторный источник.');
    style.sources = { [sourceId]: { type: 'vector', tiles: [`${root}/t/{z}/{x}/{y}`], bounds,
      minzoom: source.minzoom ?? 0, maxzoom: source.maxzoom ?? 14, attribution: '© OpenStreetMap contributors' } };
    style.layers = style.layers.filter((layer) => !('source' in layer) || layer.source === sourceId);
    delete style.sprite;
    style.glyphs = `${root}/g/{range}?font={fontstack}`;
    style.layers = style.layers.flatMap<LayerSpecification>((layer) => {
      if (layer.type !== 'symbol') return [layer];
      if (!layer.layout?.['text-field']) return [];
      layer.layout = { ...layer.layout, 'text-font': ['Noto Sans Regular'] };
      delete layer.layout['icon-image'];
      return [layer];
    });
    if (pkg.chunks && state) {
      const parts = pkg.chunks.map(() => [] as typeof pkg.assets);
      for (const asset of pkg.assets) parts[asset.chunk!].push(asset);
      const start = state.matching?.done ?? 0;
      progress({ done: start, total: pkg.chunks.length, bytes });
      for (let index = start; index < pkg.chunks.length; index++) {
        const chunk = pkg.chunks[index];
        const body = await fetchAsset(new URL(chunk.path, url), chunk.bytes, signal);
        if (await digest(body) !== chunk.sha256) throw new Error('Проверка целостности части пакета не пройдена.');
        const entries = await Promise.all(parts[index].map(async (asset) => {
          const data = body.slice(asset.offset!, asset.offset! + asset.bytes);
          if (await digest(data) !== asset.sha256) throw new Error('Целостность ресурса пакета нарушена.');
          if (asset.path === 'addresses.json') decodeAddresses(data);
          return [asset.path, data] as const;
        }));
        checkAbort(signal);
        bytes += body.byteLength;
        const checkpoint: Checkpoint = { id, fingerprint: state.fingerprint, done: index + 1, bytes };
        if (iosOffline()) {
          await writeIosAssets(id, entries, signal);
          await offlineFiles.checkpoint({ key: checkpointKey(url.href), entry: checkpoint });
        } else await write('resources', (store) => {
          for (const [path, data] of entries) store.put(data, `${id}/${path}`);
          store.put(checkpoint, checkpointKey(url.href));
        });
        progress({ done: index + 1, total: pkg.chunks.length, bytes });
      }
    } else {
      for (let i = 0; i < pkg.assets.length; i += 4) {
        checkAbort(signal);
        const batch = pkg.assets.slice(i, i + 4);
        const data = await Promise.all(batch.map(async ({ path, bytes }) => {
          const buffer = await fetchAsset(new URL(path, url), bytes, signal);
          if (path === 'addresses.json') decodeAddresses(buffer);
          return buffer;
        }));
        checkAbort(signal);
        if (iosOffline()) {
          await writeIosAssets(id, batch.map(({ path }, index) => [path, data[index]]), signal);
        } else await write('resources', (store) => batch.forEach(({ path }, index) => store.put(data[index], `${id}/${path}`)));
        bytes += data.reduce((sum, item) => sum + item.byteLength, 0);
        progress({ done: i + batch.length, total: pkg.assets.length, bytes });
      }
    }
    checkAbort(signal);
    const region: OfflineRegion = { id, name: key, center, bounds, style, bytes, updated: Date.now(), packageUrl, radiusKm, settlementId: pkg.settlementId, dataDate: pkg.dataDate,
      graph: pkg.assets.filter(({ path }) => path.startsWith('graph/')).map(({ path }) => path) };
    if (iosOffline()) {
      await offlineFiles.publish({ region, previous: old?.id });
      published = true;
      if (pkg.chunks) await removeCheckpoint(url.href).catch(() => {});
    } else {
      const database = await open();
      await new Promise<void>((resolve, reject) => {
        const publication = database.transaction(['regions', 'resources'], 'readwrite');
        publication.oncomplete = () => resolve();
        publication.onabort = () => reject(publication.error ?? new Error('Не удалось установить карту.'));
        const records = publication.objectStore('regions');
        if (old && old.name !== key) records.delete(old.name);
        records.put(region);
        if (pkg.chunks) publication.objectStore('resources').delete(checkpointKey(url.href));
      });
    }
    published = true;
    offlineRegions.set([region, ...offlineRegions.get().filter((item) => item.name !== key && item.id !== old?.id)]);
    if (old) await purge(old.id).catch(() => {});
    return region;
  } finally {
    if (!published && !pkg.chunks) await purge(id).catch(() => {});
    downloading = false;
  }
}

function decodeAddresses(buffer: ArrayBuffer) {
  const addresses = JSON.parse(new TextDecoder().decode(buffer)) as OfflineAddress[];
  if (!Array.isArray(addresses) || !addresses.length || addresses.some((entry) => !entry || typeof entry.id !== 'string' ||
    typeof entry.name !== 'string' || typeof entry.address !== 'string' || !Number.isFinite(entry.lat) || !Number.isFinite(entry.lon) ||
    entry.aliases != null && (!Array.isArray(entry.aliases) || entry.aliases.some((alias) => typeof alias !== 'string')))) {
    throw new Error('Адресный индекс пакета повреждён.');
  }
  return addresses;
}

export function readOfflineAsset(id: string, path: string) {
  return iosOffline() ? readIosAsset(id, path) : read<ArrayBuffer | undefined>('resources', `${id}/${path}`);
}

export async function searchOfflineAddresses(query: string) {
  await initializeOfflineMaps();
  const results = new Map<string, OfflineAddress>();
  for (const region of offlineRegions.get()) {
    if (!region.graph) continue;
    const data = await readOfflineAsset(region.id, 'addresses.json');
    if (!data) continue;
    for (const match of matchOfflineAddresses(decodeAddresses(data), query)) {
      if (pointInBounds(match, region.bounds)) results.set(match.id, match);
    }
    if (results.size >= 12) break;
  }
  return [...results.values()].slice(0, 12);
}

export async function offlineResource(url: string) {
  const parsed = new URL(url);
  const buffer = await readOfflineAsset(parsed.hostname, parsed.pathname.slice(1));
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
