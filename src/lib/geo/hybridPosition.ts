import { advance } from '../autonomy/estimator';
import { courseBetween, headingDelta } from '../autonomy/gnss';
import { haversine, type LatLon } from '../routing';

export type NativeProvider = 'fused' | 'gps' | 'network';
export type PositionObservation = LatLon & {
  at: number; source: NativeProvider; accuracy: number; mock?: boolean;
  speed?: number; speedAccuracy?: number; heading?: number;
};
export type MotionObservation = { at: number; yawRate: number; east?: number; north?: number };
// Adapter boundary. A future trusted OBD adapter can supply speed and/or a measured increment.
export type OdometerObservation = { at: number; source: 'obd' | 'wheel'; speedMps?: number; distanceM?: number };
export type DrivingMeasurement = { kind: 'position'; data: PositionObservation } | { kind: 'motion'; data: MotionObservation } |
  { kind: 'odometer'; data: OdometerObservation };
export type PositionEstimate = LatLon & {
  at: number; accuracy: number; heading: number | null; speed: number | null;
  source: NativeProvider | 'inertial'; speedSource: 'gnss' | 'motion' | 'obd' | 'wheel' | 'unknown';
  trust: 'confirmed' | 'network' | 'recovering' | 'estimated' | 'held';
};
const radians = Math.PI / 180;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const wrap = (n: number) => ((n % 360) + 360) % 360;
const isSpeed = (n: number | undefined): n is number => n != null && Number.isFinite(n) && n >= 0 && n <= 62;

export class HybridPosition {
  state: PositionEstimate | null = null;
  reason = 'Ожидание свежей позиции';
  private accepted: PositionObservation | null = null;
  private candidate: PositionObservation | null = null;
  private streak = 0;
  private lastMotion: MotionObservation | null = null;
  private odometry: OdometerObservation | null = null;
  private integrationAt = 0;
  private heading: number | null = null;
  private speed: number | null = null;
  private recovering = false;
  private confirmedAnchor = false;

  reset() {
    this.state = this.accepted = this.candidate = this.lastMotion = this.odometry = null;
    this.streak = 0;
    this.integrationAt = 0;
    this.heading = this.speed = null;
    this.recovering = false;
    this.confirmedAnchor = false;
    this.reason = 'Ожидание свежей позиции';
  }

  update(input: DrivingMeasurement, now: number, road?: { heading: number; distance: number }) {
    if (input.kind === 'position') return this.position(input.data, now);
    if (input.kind === 'odometer') {
      const data = input.data;
      if (now - data.at > 2000 || data.at > now + 300 || this.odometry && data.at <= this.odometry.at) return null;
      this.odometry = data;
      if (isSpeed(data.speedMps)) this.speed = data.speedMps;
      if (this.state && this.state.trust !== 'confirmed' && this.heading != null && data.distanceM != null && data.distanceM >= 0 && data.distanceM <= 25) {
        const next = advance(this.state, this.heading, data.distanceM);
        this.state = { ...this.state, ...next, at: now, source: 'inertial', trust: 'estimated', speed: this.speed, speedSource: data.source,
          accuracy: this.state.accuracy + data.distanceM * 0.08 };
        this.integrationAt = now;
        return this.state;
      }
      return null;
    }
    const m = input.data;
    if (!Number.isFinite(m.at) || !Number.isFinite(m.yawRate) || now - m.at > 1000 || m.at > now + 300 ||
      this.lastMotion && m.at <= this.lastMotion.at) return null;
    const dt = this.lastMotion ? clamp((m.at - this.lastMotion.at) / 1000, 0, 0.3) : 0;
    this.lastMotion = m;
    if (this.heading != null && (this.speed ?? 0) > 0.8 && Math.abs(m.yawRate) > 1.4) {
      this.heading = wrap(this.heading + clamp(m.yawRate, -95, 95) * dt);
    }
    const independent = this.odometry && now - this.odometry.at <= 1500 ? this.odometry : null;
    if (this.speed != null && this.heading != null && Number.isFinite(m.east) && Number.isFinite(m.north) && !independent) {
      const a = m.east! * Math.sin(this.heading * radians) + m.north! * Math.cos(this.heading * radians);
      if (Math.abs(a) > 0.22) this.speed = clamp(this.speed + clamp(a, -6, 4) * dt, 0, 62);
    }
    return this.tick(now, road);
  }

  tick(now: number, road?: { heading: number; distance: number }): PositionEstimate | null {
    const s = this.state;
    if (!s || !this.accepted || (s.trust === 'confirmed' || s.trust === 'network') && now - this.accepted.at < 2800 ||
      now - this.integrationAt < 220) return null;
    if (this.confirmedAnchor && !this.recovering) {
      this.recovering = true;
      this.candidate = null;
      this.streak = 0;
    }
    const dt = clamp((now - this.integrationAt) / 1000, 0, 0.7);
    this.integrationAt = now;
    const age = now - this.accepted.at;
    const independent = this.odometry && now - this.odometry.at <= 1500 ? this.odometry : null;
    const live = this.lastMotion && now - this.lastMotion.at < 1000;
    const speed = independent && isSpeed(independent.speedMps) ? independent.speedMps :
      live && age < 15_000 ? this.speed : null;
    const moving = speed != null && speed > 0.45 && this.heading != null;
    const heading = this.heading != null && road && road.distance <= 14 && Math.abs(headingDelta(road.heading, this.heading)) <= 24
      ? wrap(this.heading + headingDelta(road.heading, this.heading) * 0.26) : this.heading;
    const distance = moving && independent?.distanceM == null ? speed * dt : 0;
    const pos = distance && heading != null ? advance(s, heading, distance) : s;
    this.reason = speed == null ? 'Надёжные GNSS и скорость недоступны' : 'Положение оценено по последней точке и датчикам';
    this.state = { ...s, lat: pos.lat, lon: pos.lon, at: now, accuracy: Math.min(2000, s.accuracy + dt * (moving ? 1.8 : 2.5) + distance * 0.12),
      heading, speed, speedSource: independent ? independent.source : speed == null ? 'unknown' : 'motion',
      source: 'inertial', trust: moving ? 'estimated' : 'held' };
    return this.state;
  }

  private position(f: PositionObservation, now: number): PositionEstimate | null {
    if (f.mock || !['fused', 'gps', 'network'].includes(f.source) ||
      ![f.lat, f.lon, f.at, f.accuracy].every(Number.isFinite) || Math.abs(f.lat) > 85 || Math.abs(f.lon) > 180 ||
      f.accuracy <= 0 || f.accuracy > 50 || now - f.at > 5000 || f.at - now > 500) {
      this.reason = f.mock ? 'Отброшен тестовый источник Android' : 'Отброшена старая или неточная точка';
      return null;
    }
    const network = f.source === 'network' || f.accuracy > 30;
    // A provisional network marker must not block a later precise cold start.
    if (!this.confirmedAnchor && network) {
      if (this.accepted && f.at <= this.accepted.at + 250) return null;
      this.accepted = f;
      this.integrationAt = now;
      this.reason = 'Приблизительная сетевая позиция';
      this.state = { lat: f.lat, lon: f.lon, at: now, accuracy: f.accuracy, heading: null,
        speed: null, source: f.source, speedSource: 'unknown', trust: 'network' };
      return this.state;
    }
    const previous = this.confirmedAnchor ? this.accepted : null;
    if (previous && f.at <= previous.at + 250) return null; // correlated Fused/GPS deliveries
    if (previous && now - previous.at < 8000 && (network && previous.source !== 'network' && previous.accuracy <= 30 ||
      f.accuracy > previous.accuracy * 1.8 + 8)) return null;
    const dt = previous ? (f.at - previous.at) / 1000 : 0;
    const d = previous ? haversine(previous, f) : 0;
    const innovation = this.state ? haversine(this.state, f) : 0;
    const oldSpeed = this.speed ?? 0;
    const allowance = Math.min(150, Math.max(25, (previous?.accuracy ?? 0) + f.accuracy +
      Math.min(5, dt) * Math.max(7, oldSpeed * 1.45 + 5)));
    const course = previous && d > Math.max(5, f.accuracy * 0.65) ? courseBetween(previous, f) : null;
    const recentMotion = this.lastMotion && now - this.lastMotion.at < 1200;
    const headingConflict = recentMotion && this.heading != null && course != null && oldSpeed > 4 &&
      dt < 4 && Math.abs(headingDelta(course, this.heading)) > 85 && d > 12;
    if (previous && (innovation > allowance || headingConflict)) {
      this.candidate = null;
      this.streak = 0;
      this.recovering = true;
      this.reason = 'Координаты не согласуются с предыдущей позицией и направлением';
      if (!this.state) return null;
      if (this.state.trust === 'confirmed' || this.state.trust === 'network') this.integrationAt = now;
      this.state = { ...this.state, at: now, accuracy: Math.max(this.state.accuracy, 35), trust: 'held',
        speed: this.lastMotion && now - this.lastMotion.at < 1000 ? this.speed : null,
        speedSource: this.lastMotion && now - this.lastMotion.at < 1000 && this.speed != null ? 'motion' : 'unknown' };
      return this.state;
    }
    const c = this.candidate;
    if (c && f.at <= c.at + 350) {
      if (f.accuracy + 4 < c.accuracy) this.candidate = f;
      return null;
    }
    if (!c || f.at - c.at > 12_000 || haversine(c, f) > 55 * Math.max(0.4, (f.at - c.at) / 1000) + c.accuracy + f.accuracy) {
      this.streak = 1;
    } else this.streak++;
    this.candidate = f;
    const recover = this.confirmedAnchor && (this.recovering || dt > 3.5);
    if ((!previous && !network || recover) && this.streak < (recover ? 3 : 2)) {
      this.reason = 'Ожидание согласованных последовательных точек';
      return null;
    }

    const speed = f.speed;
    const independent = this.odometry && now - this.odometry.at <= 1500 ? this.odometry : null;
    const freshPair = previous && dt >= 0.45 && dt <= 4;
    const gnssSpeed = !network && freshPair && isSpeed(speed) &&
      (f.speedAccuracy == null || f.speedAccuracy >= 0 && f.speedAccuracy <= 3) &&
      Math.abs(d - speed * dt) <= Math.max(4 * dt, f.accuracy * 0.65 + previous.accuracy * 0.65) &&
      !(d < 2 && speed * dt > 10) &&
      (!recentMotion || this.speed == null || Math.abs(this.speed - speed) <= Math.max(5, 4 * dt)) &&
      (!independent || !isSpeed(independent.speedMps) || Math.abs(independent.speedMps - speed) <= 4);
    const estimateSpeed = !network && freshPair && d >= Math.max(5, (f.accuracy + previous.accuracy) * 0.65) && d / dt <= 55 ? d / dt : null;
    if (independent && isSpeed(independent.speedMps)) this.speed = independent.speedMps;
    else if (gnssSpeed) this.speed = speed;
    else if (estimateSpeed != null && (!recentMotion || this.speed == null || Math.abs(estimateSpeed - this.speed) <= 5)) this.speed = estimateSpeed;
    else if (!recentMotion || network) this.speed = null;
    if (!network && (this.speed ?? 0) > 1.8) {
      const proposed = course ?? (Number.isFinite(f.heading) ? f.heading! : null);
      if (proposed != null) this.heading = wrap(this.heading == null ? proposed : this.heading + headingDelta(proposed, this.heading) * 0.65);
    }
    const pos = recover && this.state && innovation > 7 ? advance(this.state, courseBetween(this.state, f), Math.min(12, innovation * 0.45)) : f;
    this.recovering = pos !== f;
    if (!network) this.confirmedAnchor = true;
    this.accepted = f;
    this.integrationAt = now;
    this.reason = this.recovering ? 'Плавное уточнение по восстановившемуся GNSS' : network ? 'Приблизительная сетевая позиция' : 'Согласованные точки Android';
    this.state = { lat: pos.lat, lon: pos.lon, at: now, accuracy: this.recovering ? Math.max(30, f.accuracy + innovation * 0.5) : f.accuracy,
      heading: this.heading, speed: this.speed, source: f.source,
      speedSource: independent && isSpeed(independent.speedMps) ? independent.source :
        gnssSpeed || estimateSpeed != null && this.speed === estimateSpeed ? 'gnss' : this.speed == null ? 'unknown' : 'motion',
      trust: this.recovering ? 'recovering' : network ? 'network' : 'confirmed' };
    return this.state;
  }
}
