import { haversine, type LatLon, type Route } from '../routing';
import { ALGORITHM_VERSION, advance, Estimator, type Estimate, type Measurement, type Origin, type Variant } from './estimator';

export type Feedback = { stars: number; errors: string[]; comment: string; actual?: LatLon; endpointErrorM?: number };
export type Trip = {
  schema: 1; algorithm: string; id: string; origin: Origin; route: Route; variant: Variant;
  ended?: number; feedback?: Feedback; truncated?: boolean;
  frames: { input: Measurement; estimate: Estimate }[];
};
const LIMIT = 100_000;
export function createTrip(origin: Origin, route: Route, variant: Variant): Trip {
  return { schema: 1, algorithm: ALGORITHM_VERSION, id: String(origin.at), origin, route, variant, frames: [] };
}
export function record(trip: Trip, input: Measurement, estimate: Estimate) {
  if (trip.frames.length < LIMIT) trip.frames.push({ input, estimate });
  else trip.truncated = true;
}
export type GpsScenario = 'recorded' | 'blackout' | 'frozen' | 'jump' | 'smooth';
export function replay(trip: Trip, variant: Variant, scenario: GpsScenario, reference: { at: number; position: LatLon }[] = []) {
  if (trip.schema !== 1 || !Array.isArray(trip.frames) || trip.frames.length > LIMIT) throw new Error('Неподдерживаемая запись');
  const estimator = new Estimator(trip.origin, trip.route.coords, variant);
  let index = 0;
  const errors = [];
  const positions = [];
  let firstGps: LatLon | null = null;
  for (const frame of trip.frames) {
    let input = frame.input;
    if (input.type === 'gps') {
      if (scenario === 'blackout') continue;
      firstGps ??= input.sample;
      const elapsed = Math.max(0, (input.sample.at - trip.origin.at) / 1000);
      if (scenario === 'frozen') input = { type: 'gps', sample: { ...input.sample, lat: firstGps.lat, lon: firstGps.lon, speed: 0 } };
      if (scenario === 'jump' && elapsed > 10) input = { type: 'gps', sample: { ...input.sample, ...advance(input.sample, 90, 2500) } };
      if (scenario === 'smooth') input = { type: 'gps', sample: { ...input.sample, ...advance(firstGps, 45, elapsed * 9), speed: 9 } };
    }
    const estimate = estimator.update(input);
    const at = 'sample' in input ? input.sample.at : input.at;
    while (index < reference.length && reference[index].at < at - 250) index++;
    if (reference[index] && Math.abs(reference[index].at - at) <= 250) {
      errors.push(haversine(estimate, reference[index++].position));
    }
    if (positions.length === 0 || at - positions.at(-1)!.at >= 500) positions.push({ at, estimate });
  }
  const rmsM = errors.length ? Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / errors.length) : null;
  return { endpoint: estimator.state, rmsM, referenceCount: errors.length, positions };
}

async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('ace-autonomy', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('trips', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function saveTrip(trip: Trip) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('trips', 'readwrite');
      tx.objectStore('trips').put(trip);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
export async function recentTrips() {
  const db = await database();
  try {
    return await new Promise<Trip[]>((resolve, reject) => {
      const request = db.transaction('trips').objectStore('trips').getAll();
      request.onsuccess = () => resolve((request.result as Trip[]).sort((a, b) => b.origin.at - a.origin.at));
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
export async function deleteTrip(id: string) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('trips', 'readwrite');
      tx.objectStore('trips').delete(id);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
