/* Поиск адресов и обратное геокодирование (Nominatim, данные OpenStreetMap).
   Публичный Nominatim: не больше 1 запроса в секунду, без массовых запросов — соблюдаем.
   Запасной поиск — Photon (komoot), если Nominatim недоступен. Подробности: docs/NAVIGATION.md. */
import { fetchJson, isAbort, NetError } from './http';
import type { LatLon, Lang } from '../routing';

export interface Place {
  id: string;
  name: string;
  address: string;
  lat: number;
  lon: number;
  /** Тип объекта для подписи («Улица», «Город», «АЗС»…). */
  kind?: string;
}

export const NOMINATIM = 'https://nominatim.openstreetmap.org';
export const PHOTON = 'https://photon.komoot.io';

/** Язык ответа: сначала язык интерфейса, затем второй язык региона. */
export function acceptLanguage(lang: Lang) {
  return lang === 'uk' ? 'uk,ru,en' : lang === 'en' ? 'en,ru,uk' : 'ru,uk,en';
}

/* Не чаще 1 запроса в секунду к Nominatim (правила публичного сервера). */
let nextSlot = 0;
async function nominatimSlot(signal?: AbortSignal) {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + 1100;
  if (!wait) return;
  await new Promise<void>((res, rej) => {
    const t = setTimeout(res, wait);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      rej(new DOMException('aborted', 'AbortError'));
    });
  });
}
export function _resetThrottle() {
  nextSlot = 0;
}

/** «50.4501, 30.5234» или «50.4501 30.5234» → координаты. */
export function parseCoords(q: string): LatLon | null {
  const m = q.trim().match(/^(-?\d{1,2}(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:[.,]\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1].replace(',', '.'));
  const lon = Number(m[2].replace(',', '.'));
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

export function fmtCoords(p: LatLon) {
  return `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
}

export function coordsPlace(p: LatLon): Place {
  return { id: `pt:${p.lat.toFixed(6)},${p.lon.toFixed(6)}`, name: 'Точка на карте', address: fmtCoords(p), lat: p.lat, lon: p.lon };
}

const KIND: Record<string, string> = {
  city: 'Город', town: 'Город', village: 'Село', hamlet: 'Посёлок', suburb: 'Район', quarter: 'Район', neighbourhood: 'Район',
  house: 'Дом', building: 'Здание', residential: 'Улица', primary: 'Улица', secondary: 'Улица', tertiary: 'Улица',
  unclassified: 'Дорога', living_street: 'Улица', pedestrian: 'Пешеходная улица', trunk: 'Трасса', motorway: 'Автомагистраль',
  fuel: 'АЗС', parking: 'Парковка', cafe: 'Кафе', restaurant: 'Ресторан', fast_food: 'Фастфуд', hospital: 'Больница',
  pharmacy: 'Аптека', supermarket: 'Супермаркет', mall: 'Торговый центр', hotel: 'Гостиница', theatre: 'Театр', museum: 'Музей',
  station: 'Вокзал', aerodrome: 'Аэропорт', car_repair: 'Автосервис', car_wash: 'Автомойка', school: 'Школа', university: 'Университет',
};

interface NomAddress {
  house_number?: string;
  road?: string;
  pedestrian?: string;
  suburb?: string;
  city?: string;
  town?: string;
  village?: string;
  hamlet?: string;
  municipality?: string;
  county?: string;
  state?: string;
  country?: string;
  postcode?: string;
}
interface NomResult {
  place_id: number;
  name?: string;
  display_name: string;
  lat: string;
  lon: string;
  category?: string;
  type?: string;
  addresstype?: string;
  address?: NomAddress;
}

/** Результат Nominatim → понятные «название» и «адрес». */
export function nominatimToPlace(r: NomResult): Place {
  const a = r.address ?? {};
  const road = a.road || a.pedestrian;
  const street = road ? (a.house_number ? `${road}, ${a.house_number}` : road) : '';
  const locality = a.city || a.town || a.village || a.hamlet || a.municipality || '';
  const parts = r.display_name.split(', ');
  const name = r.name || street || parts[0];
  let address: string;
  if (r.address) {
    const rest = [street && street !== name ? street : '', locality && locality !== name ? locality : '', a.state && a.state !== locality ? a.state : '', a.country];
    address = rest.filter(Boolean).join(', ');
  } else {
    address = (r.name ? r.display_name : parts.slice(1).join(', ')).split(', ').slice(0, 4).join(', ');
  }
  return {
    id: `osm:${r.place_id}`,
    name,
    address,
    lat: Number(r.lat),
    lon: Number(r.lon),
    kind: KIND[r.type ?? ''] ?? KIND[r.addresstype ?? ''],
  };
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: { osm_id?: number; name?: string; street?: string; housenumber?: string; city?: string; state?: string; country?: string; osm_value?: string };
}
export function photonToPlace(f: PhotonFeature): Place {
  const p = f.properties;
  const street = p.street ? (p.housenumber ? `${p.street}, ${p.housenumber}` : p.street) : '';
  const name = p.name || street || p.city || 'Место';
  return {
    id: `ph:${p.osm_id ?? f.geometry.coordinates.join(',')}`,
    name,
    address: [street !== name ? street : '', p.city !== name ? p.city : '', p.state, p.country].filter(Boolean).join(', '),
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0],
    kind: KIND[p.osm_value ?? ''],
  };
}

export function searchUrl(query: string, lang: Lang, near?: LatLon) {
  const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: '8', 'accept-language': acceptLanguage(lang), addressdetails: '1' });
  if (near) {
    // Приоритет результатам рядом (не ограничение: можно найти и другой город).
    const d = 1.5;
    params.set('viewbox', `${(near.lon - d).toFixed(4)},${(near.lat + d).toFixed(4)},${(near.lon + d).toFixed(4)},${(near.lat - d).toFixed(4)}`);
  }
  return `${NOMINATIM}/search?${params}`;
}

export function reverseUrl(p: LatLon, lang: Lang) {
  const params = new URLSearchParams({ lat: p.lat.toFixed(6), lon: p.lon.toFixed(6), format: 'jsonv2', zoom: '18', addressdetails: '1', 'accept-language': acceptLanguage(lang) });
  return `${NOMINATIM}/reverse?${params}`;
}

/** Убрать дубли (одно место разными объектами OSM в пределах ~30 м с тем же названием). */
export function dedupe(list: Place[]) {
  const out: Place[] = [];
  for (const p of list) {
    if (!out.some((q) => q.name === p.name && Math.abs(q.lat - p.lat) < 3e-4 && Math.abs(q.lon - p.lon) < 3e-4)) out.push(p);
  }
  return out;
}

export async function searchPlaces(query: string, opts: { near?: LatLon; lang?: Lang; signal?: AbortSignal } = {}): Promise<Place[]> {
  const q = query.trim();
  if (!q) return [];
  const coords = parseCoords(q);
  if (coords) return [coordsPlace(coords)];
  const lang = opts.lang ?? 'ru';
  try {
    await nominatimSlot(opts.signal);
    const data = await fetchJson<NomResult[]>(searchUrl(q, lang, opts.near), { timeoutMs: 10000, signal: opts.signal, service: 'Поиск адресов' });
    if (!Array.isArray(data)) throw new NetError('bad-response', 'Поиск адресов: неожиданный ответ');
    return dedupe(data.map(nominatimToPlace));
  } catch (e) {
    if (isAbort(e, opts.signal)) throw e;
    if (e instanceof NetError && e.kind === 'offline') throw e;
    // Запасной сервер поиска.
    const params = new URLSearchParams({ q, limit: '8' });
    if (opts.near) {
      params.set('lat', String(opts.near.lat));
      params.set('lon', String(opts.near.lon));
    }
    try {
      const data = await fetchJson<{ features: PhotonFeature[] }>(`${PHOTON}/api/?${params}`, { timeoutMs: 10000, signal: opts.signal, service: 'Запасной поиск' });
      return dedupe((data.features ?? []).map(photonToPlace));
    } catch (e2) {
      if (isAbort(e2, opts.signal)) throw e2;
      throw e;
    }
  }
}

const reverseCache = new Map<string, Place>();

/** Адрес точки. Без ответа сервиса — null (вызывающий показывает координаты). */
export async function reverseGeocode(p: LatLon, opts: { lang?: Lang; signal?: AbortSignal } = {}): Promise<Place | null> {
  const key = `${p.lat.toFixed(5)},${p.lon.toFixed(5)},${opts.lang ?? 'ru'}`;
  const hit = reverseCache.get(key);
  if (hit) return hit;
  await nominatimSlot(opts.signal);
  const data = await fetchJson<NomResult & { error?: string }>(reverseUrl(p, opts.lang ?? 'ru'), { timeoutMs: 8000, signal: opts.signal, service: 'Определение адреса' });
  if (!data || data.error || !data.display_name) return null;
  // Координаты маршрута — точка, которую выбрал пользователь, а не центр найденного здания.
  const place = { ...nominatimToPlace(data), lat: p.lat, lon: p.lon };
  if (reverseCache.size > 100) reverseCache.clear();
  reverseCache.set(key, place);
  return place;
}
