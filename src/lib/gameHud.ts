import { cumulative, stepOffsets, type LatLon, type Route } from './routing';
import { courseBetween } from './autonomy/gnss';
import { toCarFrame } from './hud';

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const mix = (a: LatLon, b: LatLon, t: number): LatLon => ({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t });

export type HudPoint = { x: number; y: number; scale: number };
export type HudChevron = { point: HudPoint; angle: number; opacity: number };
export type GameHudScene = { road: HudPoint[]; chevrons: HudChevron[] };

export function canAlignGameHud(input: { fresh: boolean; held: boolean; accuracy: number; offRoute: number; trusted: boolean }) {
  return input.fresh && !input.held && input.trusted && input.accuracy <= 30 && input.offRoute <= 20;
}

// Purely visual distance interpolator. No extrapolation beyond accepted progress.
export function approachHudProgress(current: number, target: number, dt: number) {
  return Math.abs(target - current) < 0.05 ? target : current + (target - current) * (1 - Math.exp(-clamp(dt, 0, 0.1) / 0.28));
}

export class GameHudGeometry {
  private cum: number[];
  readonly offsets: number[];
  readonly total: number;

  constructor(private route: Route) {
    this.cum = cumulative(route.coords);
    this.offsets = stepOffsets(route, this.cum);
    this.total = this.cum.at(-1) ?? 0;
  }

  private point(distance: number): LatLon {
    const d = clamp(distance, 0, this.total);
    let lo = 0;
    let hi = this.cum.length - 1;
    while (hi - lo > 1) {
      const mid = (hi + lo) >>> 1;
      if (this.cum[mid] <= d) lo = mid;
      else hi = mid;
    }
    const segment = this.cum[hi] - this.cum[lo];
    return mix(this.route.coords[lo], this.route.coords[hi], segment > 0 ? (d - this.cum[lo]) / segment : 0);
  }

  scene(along: number, step: number | null, width: number, height: number): GameHudScene {
    if (this.total < 1 || width <= 0 || height <= 0) return { road: [], chevrons: [] };
    const d = clamp(along, 0, this.total);
    const origin = this.point(d);
    const heading = courseBetween(this.point(d - 4), this.point(d + 3));
    const project = (station: number): HudPoint => {
      // Round corners over a few metres solely for the schematic ribbon.
      const p = mix(this.point(station), mix(this.point(station - 4), this.point(station + 4), 0.5), 0.65);
      const [lateral] = toCarFrame(p, origin, heading);
      const distance = Math.max(0, station - d);
      const depth = 1 / (1 + distance / 26);
      return {
        x: width * 0.5 + clamp(lateral * width * 0.018 * depth, -width * 1.3, width * 1.3),
        y: height * (0.30 + 0.52 * depth),
        scale: depth,
      };
    };
    const end = Math.min(this.total, d + 105);
    const road: HudPoint[] = [];
    for (let i = 0; i <= 28; i++) road.push(project(d + (end - d) * i / 28));
    const turn = step == null ? undefined : this.offsets[step];
    const chevrons: HudChevron[] = [];
    if (turn != null && turn + 6 > d) {
      // Anchor each chevron to a station immediately before the maneuver.
      for (const gap of [-5, 3, 11, 19]) {
        const station = turn - gap;
        const ahead = station - d;
        if (ahead <= 0 || ahead > 98 || station > this.total) continue;
        const p = project(station);
        const a = project(station - 2), b = project(station + 2);
        chevrons.push({ point: p, angle: Math.atan2(b.x - a.x, a.y - b.y),
          opacity: Math.min(1, ahead / 5, (98 - ahead) / 14) });
      }
    }
    return { road, chevrons };
  }
}
