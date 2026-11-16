/* Демонстрационная поездка для прототипа (без GPS и без сети маршрутов): центр Киева, ~3 км, несколько поворотов.
   Используется для проверки камеры, курса и производительности одинаково на всех устройствах. */
import { haversine, type LatLon } from '../lib/routing';
import { bearing, type RawFix } from '../lib/nav';

export const DEMO_ROUTE: LatLon[] = [
  { lat: 50.44185, lon: 30.52165 },
  { lat: 50.44412, lon: 30.52208 },
  { lat: 50.44655, lon: 30.52258 },
  { lat: 50.44902, lon: 30.52318 },
  { lat: 50.45025, lon: 30.52358 },
  { lat: 50.45195, lon: 30.52502 },
  { lat: 50.45332, lon: 30.52705 },
  { lat: 50.45362, lon: 30.52842 },
  { lat: 50.45212, lon: 30.53005 },
  { lat: 50.45026, lon: 30.53212 },
  { lat: 50.44852, lon: 30.53418 },
  { lat: 50.44655, lon: 30.53612 },
  { lat: 50.44472, lon: 30.53872 },
];

/** Точка на маршруте через s метров от начала и направление отрезка. */
export function pointAt(route: LatLon[], s: number): { pos: LatLon; bearing: number; done: boolean } {
  let left = Math.max(0, s);
  for (let i = 0; i < route.length - 1; i++) {
    const seg = haversine(route[i], route[i + 1]);
    if (left <= seg) {
      const t = seg ? left / seg : 0;
      return {
        pos: { lat: route[i].lat + (route[i + 1].lat - route[i].lat) * t, lon: route[i].lon + (route[i + 1].lon - route[i].lon) * t },
        bearing: bearing(route[i], route[i + 1]),
        done: false,
      };
    }
    left -= seg;
  }
  const n = route.length;
  return { pos: route[n - 1], bearing: bearing(route[n - 2], route[n - 1]), done: true };
}

/** Детерминированный «шум» GPS (одинаковый в каждом прогоне — для честного сравнения). */
const noise = (i: number, k: number) => Math.sin(i * 12.9898 + k * 78.233) * 0.5;

/** Точка GPS демонстрационной поездки: скорость 45 км/ч, шум положения ±3 м, курс устройства ±6° (или без курса). */
export function demoFix(i: number, opts: { speedKmh?: number; withHeading?: boolean; start?: number } = {}): RawFix & { done: boolean } {
  const v = (opts.speedKmh ?? 45) / 3.6;
  const p = pointAt(DEMO_ROUTE, i * v);
  const m = 1 / 111_320;
  return {
    lat: p.pos.lat + noise(i, 1) * 6 * m,
    lon: p.pos.lon + (noise(i, 2) * 6 * m) / Math.cos((p.pos.lat * Math.PI) / 180),
    accuracy: 6,
    speed: v,
    heading: opts.withHeading === false ? null : (p.bearing + noise(i, 3) * 12 + 360) % 360,
    timestamp: (opts.start ?? Date.now()) + i * 1000,
    done: p.done,
  };
}
