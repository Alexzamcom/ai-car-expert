import { createStore } from './store';
import type { Place } from './geo/geocode';
import { haversine, type LatLon, type Route } from './routing';

export type Endpoint = 'from' | 'to';
export type PlannerLaunch = { destination?: Place; rejectGps?: boolean; route?: Route };
export const plannedRoute = createStore<{ from: Place | null; to: Place | null; route: Route | null }>(
  { from: null, to: null, route: null }, 'planned-route');
export const positionMode = createStore<{ manual: boolean; rechecking: boolean; point: (LatLon & { at: number }) | null }>(
  { manual: false, rechecking: false, point: null }, 'position-mode');

export function setManualPoint(point: LatLon) {
  positionMode.set({ manual: true, rechecking: false, point: { lat: point.lat, lon: point.lon, at: Date.now() } });
}

// During hand-back, a fresh manual anchor provides an independent consistency check.
export function recoveryNearManual(point: LatLon, anchor: (LatLon & { at: number }) | null, now: number) {
  if (!anchor) return true;
  const elapsed = Math.max(0, now - anchor.at) / 1000;
  const reachable = Math.min(100_000, 1500 + elapsed * 45);
  return haversine(point, anchor) <= reachable;
}
