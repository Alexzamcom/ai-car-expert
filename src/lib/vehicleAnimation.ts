import { advance } from './autonomy/estimator';
import { headingDelta } from './autonomy/gnss';
import { haversine, type LatLon } from './routing';

type Pose = LatLon & { heading: number };
export type VehicleTarget = LatLon & { heading: number | null; roadHeading?: number | null; speedMps: number | null; reliable: boolean; predict?: boolean };
const wrap = (angle: number) => ((angle % 360) + 360) % 360;

/** Presentation only. The navigation and trip recorder keep the original estimator coordinates. */
export class VehicleAnimation {
  private target: Pose | null = null;
  private shown: Pose | null = null;
  private at = 0;
  private receivedAt = 0;
  private velocity = 0;

  clear() {
    this.target = this.shown = null;
    this.velocity = 0;
  }

  receive(sample: VehicleTarget, at: number) {
    if (!this.target) {
      if (!sample.reliable) return;
      this.target = this.shown = { lat: sample.lat, lon: sample.lon, heading: sample.roadHeading ?? sample.heading ?? 0 };
      this.at = this.receivedAt = at;
      return;
    }
    if (!sample.reliable) {
      this.velocity = 0;
      return;
    }
    const previous = this.target;
    const distance = haversine(previous, sample);
    const stationary = sample.speedMps != null && sample.speedMps < 0.6;
    if (distance < (stationary ? 6 : sample.speedMps == null ? 3 : 0.45)) {
      if (stationary) this.velocity = 0;
      return;
    }
    const interval = (at - this.receivedAt) / 1000;
    this.receivedAt = at;
    this.velocity = sample.predict && !stationary && sample.speedMps != null && interval >= 0.25 && interval <= 1.8
      ? Math.min(38, sample.speedMps, distance / interval) : 0;
    const heading = !stationary && (sample.speedMps ?? 2) > 1.1
      ? sample.roadHeading ?? sample.heading ?? previous.heading : previous.heading;
    this.target = { lat: sample.lat, lon: sample.lon, heading };
  }

  frame(at: number): Pose | null {
    const from = this.shown;
    const target = this.target;
    if (!from || !target) return null;
    const lead = this.velocity * Math.min(0.8, Math.max(0, (at - this.receivedAt) / 1000));
    const to = lead > 0 ? { ...target, ...advance(target, target.heading, lead) } : target;
    const dt = Math.max(0, Math.min(100, at - this.at));
    this.at = Math.max(this.at, at);
    const metres = haversine(from, to);
    const turn = headingDelta(to.heading, from.heading);
    if (metres < 0.025 && Math.abs(turn) < 0.08) return this.shown = to;
    // Convert elapsed time to a blend. Faster catch-up after a gap bounds
    // lag, while the frame cap prevents a single jump after a stalled renderer.
    const travel = 1 - Math.exp(-dt / (metres > 16 ? 145 : 195));
    const rotation = 1 - Math.exp(-dt / (Math.abs(turn) >= 30 ? 160 : 250));
    return this.shown = {
      lat: from.lat + (to.lat - from.lat) * travel,
      lon: headingDelta(to.lon, from.lon) === to.lon - from.lon
        ? from.lon + (to.lon - from.lon) * travel
        : wrap(from.lon + headingDelta(to.lon, from.lon) * travel + 180) - 180,
      heading: wrap(from.heading + turn * rotation),
    };
  }
}
