import { cumulative, haversine, type LatLon } from '../routing';

export const ALGORITHM_VERSION = 'dr-1';
export type Motion = { at: number; x: number; y: number; yawRate: number; orientation?: number[] };
export type Fix = LatLon & { at: number; accuracy: number; speed: number | null };
export type Variant = 'inertial' | 'road' | 'hybrid';
export type Measurement =
  | { type: 'motion'; sample: Motion }
  | { type: 'gps'; sample: Fix }
  | { type: 'vehicle'; at: number; speedMps?: number; distanceM?: number }
  | { type: 'correction'; at: number; position: LatLon; heading: number }
  | { type: 'pause'; at: number };

export type Estimate = LatLon & {
  heading: number; speed: number; uncertainty: number; stopped: boolean;
  gps: 'disabled' | 'waiting' | 'rejected' | 'relative'; event?: 'turn' | 'stop';
};
export type Origin = { position: LatLon; heading: number; at: number };
const radians = Math.PI / 180;
const wrap = (v: number) => ((v % 360) + 360) % 360;
const difference = (a: number, b: number) => ((wrap(a) - wrap(b) + 540) % 360) - 180;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const bearing = (a: LatLon, b: LatLon) => wrap(Math.atan2((b.lon - a.lon) * Math.cos(a.lat * radians), b.lat - a.lat) / radians);
export function advance(p: LatLon, heading: number, metres: number): LatLon {
  return { lat: p.lat + metres * Math.cos(heading * radians) / 111195,
    lon: ((p.lon + metres * Math.sin(heading * radians) / (111195 * Math.max(0.01, Math.cos(p.lat * radians))) + 540) % 360) - 180 };
}

export class Estimator {
  state: Estimate;
  private lastMotion: number | null = null;
  private lastGps: Fix | null = null;
  private relativeSpeed: { speed: number; at: number } | null = null;
  private calibration: { x: number; y: number; samples: number } = { x: 0, y: 0, samples: 0 };
  private forward: number | null = null;
  private headingDelta = 0;
  private lastTurnAt = -Infinity;
  private roadTurnAt = -Infinity;
  private roadDistance = 0;
  private roadSegment = 0;
  private roadAligned = false;
  private readonly cumulative: number[];
  constructor(origin: Origin, private readonly road: LatLon[], private readonly variant: Variant) {
    this.cumulative = cumulative(road);
    this.state = this.initial(origin.position, origin.heading);
    this.alignAnchor(origin.position);
  }
  private initial(position: LatLon, heading: number): Estimate {
    return { ...position, heading: wrap(heading), speed: 0, stopped: true, uncertainty: 12, gps: this.variant === 'hybrid' ? 'waiting' : 'disabled' };
  }
  private alignAnchor(position: LatLon) {
    const seg = this.road.findIndex((p) => haversine(position, p) <= 15);
    this.roadAligned = seg >= 0 && seg < this.road.length - 1;
    this.roadSegment = Math.max(0, seg);
    this.roadDistance = this.cumulative[this.roadSegment] ?? 0;
  }
  update(input: Measurement): Estimate {
    if (input.type === 'correction' || input.type === 'pause') {
      this.lastMotion = null;
      this.lastGps = null;
      this.relativeSpeed = null;
      this.headingDelta = 0;
      this.lastTurnAt = this.roadTurnAt = -Infinity;
      this.forward = null;
      this.calibration = { x: 0, y: 0, samples: 0 };
      if (input.type === 'correction') {
        this.state = this.initial(input.position, input.heading);
        this.alignAnchor(input.position);
      } else {
        this.state = { ...this.state, stopped: false, speed: 0, uncertainty: Math.min(5000, this.state.uncertainty + 35), event: undefined };
      }
    } else if (input.type === 'gps') {
      this.gps(input.sample);
    } else if (input.type === 'vehicle') {
      // Reserved for a trusted vehicle sensor. GPS never enters through this interface.
      if (input.speedMps != null && Number.isFinite(input.speedMps) && input.speedMps >= 0 && input.speedMps <= 55) {
        this.state = { ...this.state, speed: input.speedMps, stopped: input.speedMps < 0.3, event: undefined };
      }
    } else {
      this.motion(input.sample);
    }
    return this.state;
  }
  private gps(fix: Fix) {
    if (this.variant !== 'hybrid') return;
    const previous = this.lastGps;
    this.lastGps = fix;
    const dt = previous ? (fix.at - previous.at) / 1000 : 0;
    const distance = previous ? haversine(previous, fix) : 0;
    const speed = fix.speed;
    const valid = previous && dt >= 0.4 && dt <= 4 && fix.accuracy > 0 && fix.accuracy <= 20 && previous.accuracy > 0 && previous.accuracy <= 20 &&
      speed != null && Number.isFinite(speed) && speed >= 0 && speed <= 55 &&
      Math.abs(distance / dt - speed) <= Math.max(3, (fix.accuracy + previous.accuracy) / dt / 2) &&
      speed <= this.state.speed + 4 && Math.abs(speed - this.state.speed) <= 6 &&
      (previous.speed == null || Math.abs(speed - previous.speed) / dt <= 5) &&
      (distance <= 12 || Math.abs(difference(bearing(previous, fix), this.state.heading)) <= 45);
    this.relativeSpeed = valid ? { speed, at: fix.at } : null;
    this.state = { ...this.state, gps: valid ? 'relative' : previous ? 'rejected' : 'waiting', event: undefined };
  }
  private motion(sample: Motion) {
    if (![sample.at, sample.x, sample.y, sample.yawRate].every(Number.isFinite) ||
      (this.lastMotion != null && sample.at <= this.lastMotion)) return;
    const elapsed = this.lastMotion == null ? 0 : (sample.at - this.lastMotion) / 1000;
    this.lastMotion = sample.at;
    if (elapsed > 1) {
      this.update({ type: 'pause', at: sample.at });
      this.lastMotion = sample.at;
      return;
    }
    const s = this.state;
    const strength = Math.hypot(sample.x, sample.y);
    const yawRate = Math.abs(sample.yawRate) < 1.5 ? 0 : clamp(sample.yawRate, -100, 100);
    const yaw = elapsed * yawRate;
    if (this.forward == null && strength > 0.45 && strength < 4 && Math.abs(yawRate) < 5) {
      this.calibration.x += sample.x;
      this.calibration.y += sample.y;
      if (++this.calibration.samples >= 12) this.forward = Math.atan2(this.calibration.y, this.calibration.x) / radians;
    } else if (this.forward != null) this.forward -= yaw;
    let heading = wrap(s.heading + yaw);
    const acceleration = this.forward == null ? 0 :
      sample.x * Math.cos(this.forward * radians) + sample.y * Math.sin(this.forward * radians);
    let speed = clamp(s.speed + (Math.abs(acceleration) > 0.15 ? clamp(acceleration, -5, 4) * elapsed : 0), 0, 55);
    const aid = this.relativeSpeed && Math.abs(this.relativeSpeed.at - sample.at) <= 3500 ? this.relativeSpeed : null;
    if (aid) speed += (aid.speed - speed) * Math.min(0.25, elapsed * 0.3);
    const stopped = speed < 0.35 && strength < 0.25 && yawRate === 0;
    if (stopped) speed = 0;
    const distance = speed * elapsed;
    const raw = advance(s, heading, distance);
    let position = raw;
    let uncertainty = Math.min(5000, s.uncertainty + elapsed * (stopped ? 0.15 : 0.85) + distance * 0.18 + Math.abs(yaw) * 0.08);
    this.headingDelta = Math.abs(yawRate) > 5 ? this.headingDelta + yaw : this.headingDelta * Math.max(0, 1 - elapsed);
    const turn = Math.abs(this.headingDelta) >= 24 && sample.at - this.lastTurnAt > 4000;
    if (turn) this.lastTurnAt = sample.at;
    if (this.variant !== 'inertial' && this.roadAligned) {
      const next = this.roadSegment + 1;
      const currentBearing = bearing(this.road[this.roadSegment], this.road[next]);
      const nextBearing = next < this.road.length - 1 ? bearing(this.road[next], this.road[next + 1]) : currentBearing;
      const bend = Math.abs(difference(nextBearing, currentBearing));
      const gap = this.cumulative[next] - this.roadDistance;
      // Detection starts before the car has completed the turn. Keep it
      // eligible until the measured heading actually aligns with the exit.
      const confirmed = sample.at - this.lastTurnAt <= 3000 && this.roadTurnAt !== this.lastTurnAt &&
        bend >= 24 && gap < Math.min(45, uncertainty) && Math.abs(difference(heading, nextBearing)) < 22;
      if (confirmed) {
        this.roadTurnAt = this.lastTurnAt;
        this.roadDistance = this.cumulative[next];
        this.roadSegment = next;
        position = this.road[next];
        uncertainty = Math.max(12, uncertainty * 0.68);
      } else if (Math.abs(difference(heading, currentBearing)) < 30 &&
        (gap > distance || (bend < 24 && next < this.road.length - 1))) {
        this.roadDistance += distance;
        if (this.roadDistance >= this.cumulative[next]) this.roadSegment++;
        const start = this.roadSegment;
        position = advance(this.road[start], bearing(this.road[start], this.road[start + 1]), this.roadDistance - this.cumulative[start]);
      } else if (gap <= distance || Math.abs(difference(heading, currentBearing)) >= 30) {
        uncertainty += distance * 0.4;
        if (gap <= distance) this.roadDistance = this.cumulative[next];
      }
    }
    this.state = { ...position, heading, speed, uncertainty, stopped, gps: !aid && s.gps === 'relative' ? 'waiting' : s.gps,
      event: turn ? 'turn' : stopped && !s.stopped ? 'stop' : undefined };
  }
}
