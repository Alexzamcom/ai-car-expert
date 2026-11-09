/* Бортовой компьютер поездки по данным GPS устройства (не автомобиля). */
import { createStore } from './store';
import { haversine, type LatLon } from './routing';

export interface TripState {
  startedAt: number | null;
  lastAt: number | null;
  distanceM: number;
  movingS: number;
  maxKmh: number;
  last: LatLon | null;
}

const empty = (): TripState => ({ startedAt: null, lastAt: null, distanceM: 0, movingS: 0, maxKmh: 0, last: null });

export const tripStore = createStore<TripState>(empty(), 'trip');

/** Поездка считается новой после 2 часов без движения. */
const NEW_TRIP_GAP = 2 * 3600 * 1000;

export function nextTripState(s: TripState, pos: LatLon, accuracy: number | null, speedKmh: number | null, now: number): TripState {
  if (accuracy != null && accuracy > 50) return s; // неточная точка
  if (s.startedAt == null || s.lastAt == null || now - s.lastAt > NEW_TRIP_GAP) {
    return { ...empty(), startedAt: now, lastAt: now, last: pos };
  }
  const d = s.last ? haversine(s.last, pos) : 0;
  const dt = (now - s.lastAt) / 1000;
  // Отсекаем «прыжки» GPS: больше 70 м/с (250 км/ч) — не учитываем.
  if (dt > 0 && d / dt > 70) return { ...s, lastAt: now };
  const moving = d > 3 && dt < 60;
  return {
    ...s,
    lastAt: now,
    last: moving ? pos : s.last,
    distanceM: s.distanceM + (moving ? d : 0),
    movingS: s.movingS + (moving ? dt : 0),
    maxKmh: Math.max(s.maxKmh, speedKmh ?? 0),
  };
}

let pending = 0;
export function recordFix(pos: LatLon, accuracy: number | null, speedKmh: number | null, now: number) {
  // Пишем в хранилище не чаще раза в 2 секунды.
  if (now - pending < 2000) return;
  pending = now;
  tripStore.set((s) => nextTripState(s, pos, accuracy, speedKmh, now));
}

export function resetTrip() {
  tripStore.set(empty());
}
