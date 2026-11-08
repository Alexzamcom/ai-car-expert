import { createStore, uid } from './store';

export interface Place {
  id: string;
  name: string;
  address: string;
  lat: number;
  lon: number;
}

export interface GeoState {
  status: 'idle' | 'watching' | 'denied' | 'unavailable';
  lat: number | null;
  lon: number | null;
  accuracy: number | null;
  speedKmh: number | null;
  heading: number | null;
  updated: number | null;
}

export const geoStore = createStore<GeoState>({
  status: 'idle',
  lat: null,
  lon: null,
  accuracy: null,
  speedKmh: null,
  heading: null,
  updated: null,
});

/** Запрос из голосовой команды «маршрут до …». */
export const navQueryStore = createStore<{ query: string; nonce: number } | null>(null);

export const favoritesStore = createStore<Place[]>([], 'favorites');
export const recentsStore = createStore<Place[]>([], 'recents');

let watchId: number | null = null;

export function startGeo() {
  if (watchId != null) return;
  if (!('geolocation' in navigator)) {
    geoStore.set((s) => ({ ...s, status: 'unavailable' }));
    return;
  }
  watchId = navigator.geolocation.watchPosition(
    (p) =>
      geoStore.set({
        status: 'watching',
        lat: p.coords.latitude,
        lon: p.coords.longitude,
        accuracy: p.coords.accuracy,
        speedKmh: p.coords.speed != null && p.coords.speed >= 0 ? p.coords.speed * 3.6 : null,
        heading: p.coords.heading != null && !Number.isNaN(p.coords.heading) ? p.coords.heading : null,
        updated: Date.now(),
      }),
    (err) => {
      geoStore.set((s) => ({ ...s, status: err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable' }));
      if (err.code === err.PERMISSION_DENIED && watchId != null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
  );
}

export async function searchPlaces(query: string, near?: { lat: number; lon: number }): Promise<Place[]> {
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: '8',
    'accept-language': 'ru',
    addressdetails: '0',
  });
  if (near) {
    const d = 1.5;
    params.set('viewbox', `${near.lon - d},${near.lat + d},${near.lon + d},${near.lat - d}`);
  }
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
  if (!res.ok) throw new Error(`Поиск недоступен (${res.status})`);
  const data = (await res.json()) as { place_id: number; name?: string; display_name: string; lat: string; lon: string }[];
  return data.map((r) => {
    const [first, ...rest] = r.display_name.split(', ');
    return {
      id: String(r.place_id),
      name: r.name || first,
      address: (r.name ? r.display_name : rest.join(', ')).split(', ').slice(0, 4).join(', '),
      lat: Number(r.lat),
      lon: Number(r.lon),
    };
  });
}

export function addRecent(p: Place) {
  recentsStore.set((l) => [p, ...l.filter((x) => x.lat !== p.lat || x.lon !== p.lon)].slice(0, 8));
}

export function toggleFavorite(p: Place) {
  favoritesStore.set((l) =>
    l.some((x) => x.lat === p.lat && x.lon === p.lon)
      ? l.filter((x) => x.lat !== p.lat || x.lon !== p.lon)
      : [...l, { ...p, id: uid() }],
  );
}

export function routeLinks(p: Place) {
  const ll = `${p.lat},${p.lon}`;
  return [
    { id: 'apple', label: 'Apple Карты', href: `https://maps.apple.com/?daddr=${ll}&dirflg=d` },
    { id: 'yandexnavi', label: 'Яндекс Навигатор', href: `yandexnavi://build_route_on_map?lat_to=${p.lat}&lon_to=${p.lon}` },
    { id: 'yandex', label: 'Яндекс Карты', href: `https://yandex.ru/maps/?rtext=~${ll}&rtt=auto` },
    { id: 'google', label: 'Google Maps', href: `https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=driving` },
  ];
}

export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
