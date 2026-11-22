import { haversine, projectOnSegment, type LatLon } from '../routing';
import type { Fix } from './estimator';

export const headingDelta = (a: number, b: number) => ((a - b + 540) % 360) - 180;
export function courseBetween(a: LatLon, b: LatLon) {
  const east = headingDelta(b.lon, a.lon) * Math.cos(a.lat * Math.PI / 180);
  return (Math.atan2(east, b.lat - a.lat) * 180 / Math.PI + 360) % 360;
}

export function goodFix(fix: Fix, now: number) {
  return Number.isFinite(fix.lat) && Number.isFinite(fix.lon) && Math.abs(fix.lat) < 85 &&
    Math.abs(fix.lon) <= 180 && now - fix.at >= -1000 && now - fix.at <= 4000 &&
    fix.accuracy > 0 && fix.accuracy <= 15;
}

export function consistentPair(a: Fix, b: Fix) {
  const seconds = (b.at - a.at) / 1000;
  if (seconds < 0.35 || seconds > 4) return false;
  const distance = haversine(a, b);
  if (distance > seconds * 55 + a.accuracy + b.accuracy) return false;
  if (b.speed == null) return true;
  if (!Number.isFinite(b.speed) || b.speed < 0 || b.speed > 55 ||
    (b.speedAccuracy != null && !(b.speedAccuracy >= 0 && b.speedAccuracy <= 3))) return false;
  return Math.abs(distance - seconds * b.speed) <= Math.max(5 * seconds, a.accuracy + b.accuracy) &&
    (a.speed == null || Math.abs(b.speed - a.speed) <= 6 * seconds + 2);
}

export function roadAnchor(position: LatLon, roads: LatLon[][], heading?: number, radius = 18) {
  const candidates = roads.flatMap((coords) => {
    let best: { point: LatLon; dist: number; index: number; t: number; course: number } | undefined;
    for (let i = 0; i + 1 < coords.length; i++) {
      const a = coords[i], b = coords[i + 1];
      if (haversine(a, b) < 0.1) continue;
      const course = courseBetween(a, b);
      if (heading != null && Math.abs(headingDelta(heading, course)) > 55) continue;
      const { t, dist } = projectOnSegment(position, a, b);
      if (dist < (best?.dist ?? radius)) best = { t, dist, index: i, course, point: { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) } };
    }
    return best ? [best] : [];
  }).sort((a, b) => a.dist - b.dist);
  const [first, second] = candidates;
  if (first && second && second.dist - first.dist < 5 && haversine(first.point, second.point) > 4) return undefined;
  return first;
}
