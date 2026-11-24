import { cumulative, haversine, type LatLon } from '../routing';

import { consistentPair, goodFix, roadAnchor, courseBetween, headingDelta } from './gnss';

export const ALGORITHM_VERSION = 'dr-2';
export type Motion = { at: number; x: number; y: number; yawRate: number; orientation?: number[] };
export type Fix = LatLon & {
  at: number; accuracy: number; speed: number | null; speedAccuracy?: number;
  verticalAccuracy?: number; course?: number; courseAccuracy?: number;
};
export type Variant = 'inertial' | 'road' | 'hybrid' | 'adaptive' | 'gps';
export type Measurement =
  | { type: 'motion'; sample: Motion }
  | { type: 'gps'; sample: Fix }
  | { type: 'vehicle'; at: number; speedMps?: number; distanceM?: number; wheelSpeedMps?: number[] }
  | { type: 'correction'; at: number; position: LatLon; heading: number }
  | { type: 'pause'; at: number }
  | { type: 'tick'; at: number };

export type Estimate = LatLon & {
  heading: number; speed: number; uncertainty: number; stopped: boolean;
  gps: 'disabled' | 'waiting' | 'rejected' | 'relative' | 'trusted';
  source: 'gnss' | 'hybrid' | 'inertial';
  distance: { gps: number; sensors: number; fused: number }; event?: 'turn' | 'stop';
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
  private goodRun = 0;
  private goodAt: number | null = null;
  private sensorSpeed = 0;
  private lastTick: number;
  private lastMotion: number | null = null;
  private motionEvidenceAt = -Infinity;
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
  private cumulative: number[];
  constructor(origin: Origin, private road: LatLon[], private variant: Variant) {
    this.lastTick = origin.at;
    this.cumulative = cumulative(road);
    this.state = this.initial(origin.position, origin.heading);
    this.alignAnchor(origin.position);
  }
  setVariant(variant: Variant) {
    if (variant === this.variant) return;
    this.variant = variant;
    this.lastGps = this.goodAt = this.relativeSpeed = null;
    this.goodRun = 0;
    this.motionEvidenceAt = -Infinity;
    this.state = { ...this.state, gps: ['gps', 'hybrid', 'adaptive'].includes(variant) ? 'waiting' : 'disabled',
      source: 'inertial', speed: 0, event: undefined };
  }

  setRoute(road: LatLon[]) {
    this.road = road;
    this.cumulative = cumulative(road);
    this.alignAnchor(this.state);
  }

  private initial(position: LatLon, heading: number): Estimate {
    return { ...position, heading: wrap(heading), speed: 0, stopped: true, uncertainty: 12, gps: ['gps', 'hybrid', 'adaptive'].includes(this.variant) ? 'waiting' : 'disabled', source: 'inertial', distance: { gps: 0, sensors: 0, fused: 0 } };
  }
  private alignAnchor(position: LatLon) {
    const anchor = roadAnchor(position, [this.road], this.state.heading);
    this.roadAligned = !!anchor;
    this.roadSegment = anchor?.index ?? 0;
    const start = this.cumulative[this.roadSegment] ?? 0;
    this.roadDistance = anchor ? start + anchor.t * (this.cumulative[anchor.index + 1] - start) : start;
  }
  update(input: Measurement): Estimate {
    if (input.type === 'tick') {
      const dt = Math.min(5, Math.max(0, (input.at - this.lastTick) / 1000));
      this.lastTick = input.at;
      if ((this.variant === 'adaptive' || this.variant === 'gps') && (this.goodAt == null || input.at - this.goodAt > 2500)) {
        const source = this.goodAt != null && input.at - this.goodAt <= 6000 ? 'hybrid' : 'inertial';
        const idle = this.lastMotion == null || input.at - this.lastMotion > 1500;
        this.state = { ...this.state, gps: this.state.gps === 'trusted' ? 'waiting' : this.state.gps, source,
          uncertainty: Math.min(5000, this.state.uncertainty + (idle || this.variant === 'gps' ? dt * 3 : 0)),
          speed: this.variant === 'gps' ? 0 : this.state.speed, event: undefined };
      }
      return this.state;
    }
    if (input.type === 'correction' || input.type === 'pause') {
      this.lastMotion = this.goodAt = null;
      this.sensorSpeed = this.goodRun = 0;
      this.motionEvidenceAt = -Infinity;
      this.lastTick = input.at;
      this.lastGps = null;
      this.relativeSpeed = null;
      this.headingDelta = 0;
      this.lastTurnAt = this.roadTurnAt = -Infinity;
      this.forward = null;
      this.calibration = { x: 0, y: 0, samples: 0 };
      if (input.type === 'correction') {
        this.state = { ...this.initial(input.position, input.heading), distance: this.state.distance };
        this.alignAnchor(input.position);
      } else {
        this.state = { ...this.state, stopped: false, speed: 0, uncertainty: Math.min(5000, this.state.uncertainty + 35), event: undefined };
      }
    } else if (input.type === 'gps') {
      if (this.variant === 'adaptive' || this.variant === 'gps') this.adaptiveGps(input.sample);
      else this.gps(input.sample);
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
  private adaptiveGps(fix: Fix) {
    const s = this.state;
    const previous = this.lastGps;
    const usable = goodFix(fix, this.lastTick);
    const dt = previous ? (fix.at - previous.at) / 1000 : 0;
    const distance = previous ? haversine(previous, fix) : 0;
    const course = previous && distance >= 6 ? courseBetween(previous, fix) : null;
    const headingConflict = course != null && this.lastMotion != null && s.speed > 4 &&
      Math.abs(headingDelta(course, s.heading)) > 75;
    const frozen = !!previous && distance < 1.5 &&
      ((this.sensorSpeed > 3 && (fix.speed ?? 0) < 1) || (fix.speed ?? 0) * dt > 12);
    const reachable = haversine(s, fix) <= Math.min(75, Math.max(22, s.uncertainty + s.speed * Math.max(1, dt) + fix.accuracy));
    const valid = usable && reachable && !headingConflict && !frozen && (!previous || consistentPair(previous, fix));
    this.lastGps = usable ? fix : null;
    if (!valid) {
      this.goodRun = 0;
      this.state = { ...s, gps: usable ? 'rejected' : 'waiting', source: this.goodAt == null || fix.at - this.goodAt > 6000 ? 'inertial' : 'hybrid', event: undefined };
      return;
    }
    if (++this.goodRun < 3) return;
    const rawSpeed = fix.speed ?? (distance >= 4 && dt > 0 ? distance / dt : 0);
    const speed = clamp(rawSpeed, 0, 55);
    const heading = course != null && speed > 2 ? course : s.heading;
    const anchor = roadAnchor(fix, [this.road], speed > 2 ? heading : undefined);
    const position = speed < 0.8 && haversine(s, fix) <= fix.accuracy ? s : anchor?.point ?? fix;
    const travelled = distance >= 3 || speed > 1 ? distance : 0;
    this.goodAt = fix.at;
    this.state = { lat: position.lat, lon: position.lon, speed, heading, stopped: speed < 0.8,
      uncertainty: Math.max(5, fix.accuracy), gps: 'trusted', source: 'gnss',
      distance: { ...s.distance, gps: s.distance.gps + travelled, fused: s.distance.fused + haversine(s, position) } };
    this.alignAnchor(position);
  }
  private gps(fix: Fix) {
    if (this.variant !== 'hybrid') return;
    const previous = this.lastGps;
    this.lastGps = fix;
    const dt = previous ? (fix.at - previous.at) / 1000 : 0;
    const distance = previous ? haversine(previous, fix) : 0;
    const speed = fix.speed;
    const course = previous && distance > 12 ? bearing(previous, fix) : null;
    const next = this.roadSegment + 1;
    const nearCorner = (this.cumulative[next] ?? Infinity) - this.roadDistance < 35;
    const onCorridor = !this.roadAligned || course == null ||
      Math.abs(difference(course, bearing(this.road[this.roadSegment], this.road[next]))) <= 45 ||
      (nearCorner && next < this.road.length - 1 && Math.abs(difference(course, bearing(this.road[next], this.road[next + 1]))) <= 45);
    const valid = previous && dt >= 0.4 && dt <= 4 && fix.accuracy > 0 && fix.accuracy <= 20 && previous.accuracy > 0 && previous.accuracy <= 20 &&
      speed != null && (fix.speedAccuracy == null || fix.speedAccuracy <= 3) && Number.isFinite(speed) && speed >= 0 && speed <= 55 &&
      Math.abs(distance / dt - speed) <= Math.max(3, (fix.accuracy + previous.accuracy) / dt / 2) &&
      speed <= this.state.speed + 4 && Math.abs(speed - this.state.speed) <= 6 &&
      (previous.speed == null || Math.abs(speed - previous.speed) / dt <= 5) &&
      (course == null || Math.abs(difference(course, this.state.heading)) <= 45) && onCorridor;
    // A stationary fix supplies no independent evidence of a real stop.
    // Applying it as a brake can lock the estimator at zero as a car starts moving.
    this.relativeSpeed = valid && speed >= 0.8 ? { speed, at: fix.at } : null;
    this.state = { ...this.state, gps: this.relativeSpeed ? 'relative' : valid || !previous ? 'waiting' : 'rejected',
      distance: { ...this.state.distance, gps: this.state.distance.gps + (this.relativeSpeed ? distance : 0) }, event: undefined };
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
    const dv = Math.abs(acceleration) > 0.15 ? clamp(acceleration, -5, 4) * elapsed : 0;
    if (dv !== 0 || Math.abs(yawRate) >= 5) this.motionEvidenceAt = sample.at;
    this.sensorSpeed = clamp(this.sensorSpeed + dv, 0, 55);
    const sensorDistance = s.distance.sensors + this.sensorSpeed * elapsed;
    if (this.variant === 'adaptive' && s.gps === 'trusted' && this.goodAt != null && sample.at - this.goodAt <= 2500) {
      this.state = { ...s, heading, distance: { ...s.distance, sensors: sensorDistance }, event: undefined };
      return;
    }
    if (this.variant === 'gps') return;
    let speed = clamp(s.speed + dv, 0, 55);
    const aid = this.relativeSpeed && Math.abs(this.relativeSpeed.at - sample.at) <= 3500 ? this.relativeSpeed : null;
    if (aid) speed += (aid.speed - speed) * Math.min(0.25, elapsed * 0.3);
    const unmeasured = (this.variant === 'road' || this.variant === 'adaptive') && !aid && (speed > 0 || !s.stopped) &&
      sample.at - Math.max(this.motionEvidenceAt, this.goodAt ?? -Infinity) > 12_000;
    if (unmeasured) speed = 0;
    const stopped = !unmeasured && speed < 0.35 && strength < 0.25 && yawRate === 0;
    if (stopped) speed = 0;
    const distance = speed * elapsed;
    const raw = distance > 0 ? advance(s, heading, distance) : s;
    let position = raw;
    let uncertainty = Math.min(5000, s.uncertainty + elapsed * (stopped ? 0.15 : 0.85) + distance * 0.18 + Math.abs(yaw) * 0.08);
    if (unmeasured) uncertainty = Math.max(50, uncertainty);
    this.headingDelta = Math.abs(yawRate) > 5 ? this.headingDelta + yaw : this.headingDelta * Math.max(0, 1 - elapsed);
    const turn = Math.abs(this.headingDelta) >= 24 && sample.at - this.lastTurnAt > 4000;
    if (turn) this.lastTurnAt = sample.at;
    if (this.variant !== 'inertial' && this.roadAligned && (distance > 0 || turn)) {
      const next = this.roadSegment + 1;
      const currentBearing = bearing(this.road[this.roadSegment], this.road[next]);
      const nextBearing = next < this.road.length - 1 ? bearing(this.road[next], this.road[next + 1]) : currentBearing;
      const bend = Math.abs(difference(nextBearing, currentBearing));
      const gap = this.cumulative[next] - this.roadDistance;
      // Detection starts before the car has completed the turn. Keep it
      // eligible until the measured heading actually aligns with the exit.
      const confirmed = sample.at - this.lastTurnAt <= 3000 && this.roadTurnAt !== this.lastTurnAt &&
        bend >= 24 && gap < Math.min(45, uncertainty) && Math.abs(difference(heading, nextBearing)) < 22;
      if (confirmed && !unmeasured) {
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
    this.state = { ...position, heading, speed, uncertainty, stopped,
      source: this.variant === 'adaptive' && this.goodAt != null && sample.at - this.goodAt <= 6000 || aid ? 'hybrid' : 'inertial',
      distance: { ...s.distance, sensors: sensorDistance, fused: s.distance.fused + haversine(s, position) },
      gps: s.gps === 'trusted' ? 'waiting' : !aid && s.gps === 'relative' ? 'waiting' : s.gps,
      event: turn ? 'turn' : stopped && !s.stopped ? 'stop' : undefined };
  }
}
