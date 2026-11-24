import { haversine } from '../routing';
import { createStore } from '../store';
import type { PositionObservation } from './hybridPosition';

export const MAP_LOCATION_STALE_MS = 15_000;
const STORAGE_KEY = 'ace:map-location';
export type MapLocation = Pick<PositionObservation, 'lat' | 'lon' | 'accuracy' | 'at' | 'source'>;

function load(): MapLocation | null {
  try {
    const p = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as MapLocation | null;
    return p && Number.isFinite(p.lat) && Math.abs(p.lat) <= 85 && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180 &&
      Number.isFinite(p.at) && p.at <= Date.now() && p.accuracy > 0 && p.accuracy <= 1500 ? p : null;
  } catch { return null; }
}

export const mapLocationStore = createStore<MapLocation | null>(load());
let lastSaved = 0;

export function selectMapLocation(previous: MapLocation | null, fix: PositionObservation, now: number, rejectedJump = false): MapLocation | null {
  const { lat, lon, accuracy, at, source } = fix;
  const approximate = source === 'network' || fix.cached || fix.provisional || accuracy > 30;
  const maxAge = fix.cached ? 60_000 : approximate ? 30_000 : 5_000;
  if (rejectedJump || fix.mock || !['network', 'gps', 'fused'].includes(source) ||
    ![lat, lon, accuracy, at].every(Number.isFinite) || Math.abs(lat) > 85 || Math.abs(lon) > 180 ||
    accuracy <= 0 || accuracy > 1500 || now - at > maxAge || at - now > 500) return previous;
  if (previous) {
    const elapsed = at - previous.at;
    if (elapsed <= 0) return previous;
    if (now - previous.at < MAP_LOCATION_STALE_MS && accuracy > previous.accuracy * 1.8 + 20) return previous;
    if (elapsed < 60_000 && haversine(previous, fix) > Math.max(150, 65 * elapsed / 1000 + 2 * previous.accuracy + accuracy)) return previous;
  }
  return { lat, lon, accuracy, at, source };
}

export function recordMapLocation(fix: PositionObservation, now: number, rejectedJump: boolean) {
  const previous = mapLocationStore.get();
  const next = selectMapLocation(previous, fix, now, rejectedJump);
  if (!next || next === previous) return false;
  mapLocationStore.set(next);
  if (!previous || now - lastSaved > 10_000) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); lastSaved = now; } catch { /* private mode */ }
  }
  return true;
}

export function clearMapLocation() {
  mapLocationStore.set(null);
  lastSaved = 0;
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
}
