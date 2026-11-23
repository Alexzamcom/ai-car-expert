import { courseBetween, headingDelta } from './autonomy/gnss';
import { haversine, projectOnSegment, type LatLon, type Route } from './routing';

export type RouteGeometry = { cum: number[]; offsets: number[] };
export type RouteMeasurement = LatLon & { accuracy: number; heading: number | null; speed: number | null; at: number; estimated: boolean; distanceM?: number };

export class ConfirmedRoute {
  along: number;
  private last: RouteMeasurement | null = null;
  private misses = 0;
  private deviationAt: number | null = null;

  constructor(readonly route: Route, readonly geometry: RouteGeometry, along = 0) {
    this.along = Math.max(0, Math.min(this.total, along));
  }

  get total() { return this.geometry.cum.at(-1) ?? 0; }

  private segment(along: number) {
    const { cum } = this.geometry;
    let lo = 0, hi = cum.length - 2;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (cum[mid + 1] <= along) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  snapshot(offRouteM = 0) {
    const { cum, offsets } = this.geometry;
    const segIndex = this.segment(this.along);
    const [a, b] = this.route.coords.slice(segIndex, segIndex + 2);
    const fraction = (this.along - cum[segIndex]) / (cum[segIndex + 1] - cum[segIndex] || 1);
    const turn = offsets.findIndex((o, i) => i > 0 && o > this.along + 5);
    const stepIndex = turn < 0 ? offsets.length - 1 : turn;
    return { point: { lat: a.lat + fraction * (b.lat - a.lat), lon: a.lon + fraction * (b.lon - a.lon) },
      heading: courseBetween(a, b), progress: { segIndex, offRouteM, remainingM: this.total - this.along,
        stepIndex, toStepM: Math.max(0, (offsets[stepIndex] ?? this.total) - this.along) } };
  }

  requireFreshEvidence() {
    this.last = null;
    this.misses = 0;
    this.deviationAt = null;
  }

  update(fix: RouteMeasurement) {
    if (fix.estimated && ((fix.distanceM ?? 0) <= 0 || fix.accuracy > 60)) return this.result('held');
    if (!fix.estimated && fix.accuracy > 30) return this.result('held');
    const last = this.last;
    if (!fix.estimated && last && fix.at - last.at < 350) return this.result('held');
    const dt = last ? Math.min(8, (fix.at - last.at) / 1000) : 0;
    const displacement = last ? haversine(last, fix) : 0;
    const course = fix.estimated ? fix.heading : last && displacement >= Math.max(5, fix.accuracy, last.accuracy)
      ? courseBetween(last, fix) : (fix.speed ?? 0) > 3 ? fix.heading : null;
    const forward = fix.estimated ? Math.min(25, fix.distanceM ?? 0) : Math.max(16, Math.min(140, displacement + 12), Math.min(140, (fix.speed ?? 0) * dt + 12));
    const from = this.segment(Math.max(0, this.along - 18));
    const to = this.segment(Math.min(this.total, this.along + forward));
    const corridor = Math.max(12, Math.min(24, fix.accuracy * 1.4));
    const { cum } = this.geometry;
    let best: { along: number; score: number; dist: number } | undefined;
    for (let i = from; i <= to; i++) {
      const a = this.route.coords[i], b = this.route.coords[i + 1];
      const length = cum[i + 1] - cum[i];
      if (length < 0.01) continue;
      const projection = projectOnSegment(fix, a, b);
      const along = cum[i] + projection.t * length;
      if (along < this.along - 18 || along > this.along + forward || projection.dist > corridor) continue;
      const angle = course == null ? 0 : Math.abs(headingDelta(course, courseBetween(a, b)));
      if (angle > (fix.estimated ? 42 : 85)) continue;
      // A segment after a bend needs a matching travel direction. A nearby
      // projection alone cannot complete a turn during dead reckoning.
      const score = projection.dist + angle * 0.13 + Math.abs(along - this.along) * 0.12;
      if (!best || score < best.score) best = { along, score, dist: projection.dist };
    }
    if (!fix.estimated) this.last = fix;
    if (!best) {
      if (!fix.estimated && (this.deviationAt == null || fix.at - this.deviationAt >= 650)) {
        if (this.deviationAt != null && fix.at - this.deviationAt > 8000) this.misses = 0;
        this.deviationAt = fix.at;
        this.misses++;
      }
      return this.result(this.misses >= 3 ? 'off-route' : 'held');
    }
    if (!fix.estimated) {
      this.misses = 0;
      this.deviationAt = null;
    }
    const previous = this.along;
    // Stationary noise must not ratchet the marker forward.
    if (fix.estimated || (fix.speed ?? 0) > 0.8 || displacement > Math.max(3, fix.accuracy)) {
      this.along = Math.max(previous, best.along);
    }
    return this.result(fix.estimated ? 'estimated' : 'matched', best.dist);
  }

  private result(kind: 'matched' | 'held' | 'estimated' | 'off-route', dist = 0) {
    return { kind, ...this.snapshot(kind === 'off-route' || kind === 'held' ? Infinity : dist) };
  }
}
