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
  if (!anchor || now - anchor.at > 86_400_000) return true;
  const elapsed = Math.max(0, now - anchor.at) / 1000;
  const reachable = Math.min(100_000, 1500 + elapsed * 45);
  return haversine(point, anchor) <= reachable;
}

type RegionAnchor = { name: string; center: LatLon };
const lastRoutingRegion = createStore({ name: '' }, 'last-routing-region');

export function rememberRoutingRegion(name: string) {
  lastRoutingRegion.set({ name });
}

export function plannerViewport<T extends RegionAnchor>(
  mode: ReturnType<typeof positionMode.get>, trusted: LatLon | null, regions: T[],
  last = lastRoutingRegion.get().name, now = Date.now(),
) {
  const recentManual = mode.point && now >= mode.point.at && now - mode.point.at <= 86_400_000;
  if (mode.manual && recentManual) return { point: mode.point, source: 'manual' as const };
  if (!mode.manual && !mode.rechecking && trusted) return { point: trusted, source: 'gnss' as const };
  const region = regions.find((entry) => entry.name === last) ?? (regions.length === 1 ? regions[0] : undefined);
  if (region) return { point: region.center, source: 'region' as const, region };
  return { point: null, source: 'choose' as const };
}

export const recentPlannedRoutes = createStore<Array<{
  from: Place; to: Place; route: Route; at: number;
}>>([], 'recent-planned-routes');

export function rememberPlannedRoute(from: Place, to: Place, route: Route) {
  if (route.offlineGraph) rememberRoutingRegion(route.offlineGraph.region);
  recentPlannedRoutes.set((previous) => [
    { from, to, route, at: Date.now() },
    ...previous.filter((item) => item.from.lat !== from.lat || item.from.lon !== from.lon ||
      item.to.lat !== to.lat || item.to.lon !== to.lon || item.route.offlineGraph?.installedAt !== route.offlineGraph?.installedAt),
  ].slice(0, 5));
}

export const activePlannedTrip = createStore<{
  position: (LatLon & { heading: number }) | null;
}>({ position: null }, 'active-planned-trip');
