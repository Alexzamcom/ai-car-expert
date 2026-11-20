/* Привязка отображаемой машинки к дороге (map matching).

   Три позиции раздельно:
   - сырая — точка GPS (geoStore) — по ней и только по ней принимаются навигационные решения
     (прогресс, подсказки, прибытие, перестроение — src/lib/nav.ts);
   - отображаемая — эта (displayStore): на дороге, если совпадение уверенное; иначе сырая или плавный переход;
   - прогноз — при кратковременной потере сигнала, только для показа, с ограничением по времени и ростом неопределённости.

   Дорога выбирается не по расстоянию: учитываются точность GPS, курс и скорость, направление одностороннего движения,
   история (держимся выбранной дороги, переход — только на связанную или после подтверждения), активный маршрут —
   как небольшое предпочтение, а не как «магнит». Нет данных о дорогах — показываем сырую точку, без ложной привязки. */
import type { LatLon } from '../routing';

export interface RoadLine {
  id: string;
  coords: LatLon[];
  /** 1 — только по направлению линии, -1 — против, 0 — в обе стороны. */
  oneway: 0 | 1 | -1;
  /** Источник: активный маршрут (направление известно) или дорога из карты. */
  kind: 'route' | 'road';
  /** Класс дороги (motorway, primary, …) — для небольшого предпочтения крупных дорог при прочих равных. */
  cls?: string;
}

export interface MatchFix {
  lat: number;
  lon: number;
  accuracy: number;
  /** м/с, null — неизвестно */
  speed: number | null;
  /** курс машины (уже сглаженный), null — неизвестен */
  heading: number | null;
  t: number;
}

export interface Candidate {
  line: RoadLine;
  seg: number;
  /** доля по отрезку 0…1 */
  f: number;
  point: LatLon;
  dist: number;
  /** направление отрезка по ходу линии */
  bearing: number;
  /** направление движения по дороге (с учётом курса и одностороннего движения) */
  travel: number;
  cost: number;
}

export interface MatchResult {
  mode: 'matched' | 'blend' | 'raw' | 'predicted';
  lat: number;
  lon: number;
  /** Направление дороги по ходу движения (если привязано), иначе null. */
  bearing: number | null;
  /** Неопределённость отображаемой позиции, м. */
  accuracy: number;
  confidence: number;
  lineId: string | null;
  /** Почему так: выбранная дорога и её стоимость, вторая по вероятности, или причина «без привязки» (для диагностики). */
  reason: string;
  /** Расстояние от сырой точки до показанной, м. */
  shift: number;
}

/* ---------- Геометрия в локальной плоскости (метры) ---------- */
const R = 111_320;
const toXY = (p: LatLon, o: LatLon): [number, number] => [(p.lon - o.lon) * R * Math.cos((o.lat * Math.PI) / 180), (p.lat - o.lat) * R];
const fromXY = (x: number, y: number, o: LatLon): LatLon => ({ lat: o.lat + y / R, lon: o.lon + x / (R * Math.cos((o.lat * Math.PI) / 180)) });
const norm = (a: number) => ((a % 360) + 360) % 360;
export const adiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
const bearingXY = (dx: number, dy: number) => norm((Math.atan2(dx, dy) * 180) / Math.PI);
export const distM = (a: LatLon, b: LatLon) => {
  const [x, y] = toXY(b, a);
  return Math.hypot(x, y);
};

/** Ближайшая точка каждой линии в радиусе (одна — лучшая по отрезкам линии). */
export function candidates(fix: MatchFix, lines: RoadLine[], radius: number): Omit<Candidate, 'cost' | 'travel'>[] {
  const out: Omit<Candidate, 'cost' | 'travel'>[] = [];
  for (const line of lines) {
    let best: Omit<Candidate, 'cost' | 'travel'> | null = null;
    for (let i = 0; i < line.coords.length - 1; i++) {
      const [ax, ay] = toXY(line.coords[i], fix);
      const [bx, by] = toXY(line.coords[i + 1], fix);
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      if (len2 < 0.01) continue;
      const f = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
      const px = ax + dx * f;
      const py = ay + dy * f;
      const d = Math.hypot(px, py);
      if (d <= radius && (!best || d < best.dist)) best = { line, seg: i, f, point: fromXY(px, py, fix), dist: d, bearing: bearingXY(dx, dy) };
    }
    if (best) out.push(best);
  }
  return out;
}

const MAJOR = /motorway|trunk|primary/;

export interface MatcherOptions {
  /** Хуже этой точности не привязываем — показываем сырую точку. */
  maxAccuracy: number;
  /** Сколько секунд допускается прогноз при потере сигнала. */
  predictSec: number;
}
export const MATCH_DEFAULTS: MatcherOptions = { maxAccuracy: 60, predictSec: 2 };
/** Дальше этого от сырой точки машинку на дорогу не переносим (полоса движения — не дальше ~10–15 м от оси дороги). */
export const MAX_SNAP_M = 20;
/** Прогноз — только на скорости (≥ 30 км/ч): на стоянке iOS может перестать присылать точки, и прогноз увёл бы машинку вперёд. */
export const PREDICT_MIN_SPEED = 8;
/** Скорость выше этой (≈ 200 км/ч) считаем ошибкой измерения. */
export const MAX_SPEED = 55;
/** Прогноз уводит машинку вперёд не дальше этого. */
export const MAX_PREDICT_M = 40;

/** Состояние сопоставления между точками. */
export class Matcher {
  private cur: Candidate | null = null;
  /** Кандидат на переход, подтверждения. */
  private pending: { id: string; n: number } | null = null;
  private last: { fix: MatchFix; res: MatchResult; speed: number } | null = null;
  /** Когда последний раз ехали (≥ 2 м/с): стоя «в здании» к дороге не привязываем. */
  private movedAt = -Infinity;
  constructor(private opts: MatcherOptions = MATCH_DEFAULTS) {}

  reset() {
    this.cur = null;
    this.pending = null;
    this.last = null;
    this.movedAt = -Infinity;
  }

  get current() {
    return this.cur;
  }

  get moving() {
    return (this.last?.speed ?? 0) >= 2;
  }

  /** Стоимость кандидата: меньше — вероятнее. */
  private score(c: Omit<Candidate, 'cost' | 'travel'>, fix: MatchFix): Candidate {
    const sigma = Math.max(4, fix.accuracy * 0.6);
    let cost = (c.dist / sigma) ** 2;
    const moving = fix.speed != null ? fix.speed >= 2 : false;
    // Направление движения по дороге: по линии или против — какое ближе к курсу.
    const along = c.bearing;
    const back = norm(c.bearing + 180);
    let travel = along;
    if (fix.heading != null) travel = adiff(fix.heading, along) <= adiff(fix.heading, back) ? along : back;
    if (c.line.kind === 'route' || c.line.oneway === 1) travel = along;
    if (c.line.oneway === -1) travel = back;
    if (fix.heading != null && moving) {
      const dh = adiff(fix.heading, travel);
      // Против одностороннего движения или поперёк — дорога маловероятна (параллельная встречная, съезд под углом).
      // Расхождение больше 45° в движении — не «своя» дорога (поперечная, диагональная): стоимость выше порога правдоподобия.
      cost += dh > 100 ? 12 : dh > 45 ? 8 + (dh / 30) ** 2 : (dh / 30) ** 2;
    }
    // История: держимся текущей дороги; переход на другую — небольшой штраф (на связанную — меньше).
    if (this.cur) {
      if (c.line.id === this.cur.line.id) cost -= 1.2;
      else cost += connected(this.cur, c) ? 0.4 : 2.5;
    }
    if (c.line.kind === 'route') cost -= 0.6; // небольшое предпочтение маршрута, не «магнит»
    else if (c.line.cls && MAJOR.test(c.line.cls)) cost -= 0.15;
    return { ...c, travel, cost };
  }

  /** Новая точка GPS. lines — маршрут и дороги рядом (могут быть пустыми). */
  update(fix: MatchFix, lines: RoadLine[]): MatchResult {
    const raw = (reason: string, confidence = 0): MatchResult => ({ mode: 'raw', lat: fix.lat, lon: fix.lon, bearing: null, accuracy: fix.accuracy, confidence, lineId: null, reason, shift: 0 });
    // Скорость: от устройства; иначе по двум точкам, но только если между ними ≥ 0,8 с. Точки, пришедшие пачкой
    // (почти одновременно после паузы), давали «433 км/ч», и прогноз уносил машинку на сотню метров вперёд.
    const dtS = this.last ? (fix.t - this.last.fix.t) / 1000 : 0;
    const speed = Math.min(MAX_SPEED, fix.speed ?? (this.last && dtS >= 0.8 ? distM(this.last.fix, fix) / dtS : (this.last?.speed ?? 0)));
    if (speed >= 2) this.movedAt = fix.t;
    const done = (res: MatchResult) => {
      res.shift = distM(fix, res);
      this.last = { fix, res, speed };
      return res;
    };
    if (fix.accuracy > this.opts.maxAccuracy || !lines.length) {
      this.cur = null;
      this.pending = null;
      return done(raw(!lines.length ? 'нет данных о дорогах и маршрута рядом' : `точность ±${Math.round(fix.accuracy)} м хуже ${this.opts.maxAccuracy} м`));
    }
    const radius = Math.min(80, Math.max(25, fix.accuracy * 2 + 15));
    const cs = candidates(fix, lines, radius).map((c) => this.score(c, { ...fix, speed }));
    if (!cs.length) {
      // Рядом нет известных дорог (съехали с маршрута, а карта дорог не загружена) — без ложной привязки.
      this.cur = null;
      this.pending = null;
      return done(raw(`нет дорог в радиусе ${Math.round(radius)} м`));
    }
    cs.sort((a, b) => a.cost - b.cost);
    let best = cs[0];
    let held = false;
    // Переход на несвязанную дорогу — только после двух подтверждений подряд (шум GPS у параллельных дорог).
    if (this.cur && best.line.id !== this.cur.line.id && !connected(this.cur, best)) {
      const stay = cs.find((c) => c.line.id === this.cur!.line.id);
      const n = this.pending?.id === best.line.id ? this.pending.n + 1 : 1;
      this.pending = { id: best.line.id, n };
      if (stay && n < 2 && stay.cost - best.cost < 6) {
        best = stay;
        held = true;
      }
    } else this.pending = null;

    // Уверенность: насколько лучший лучше остальных и насколько он близко.
    // Маршрут и тайлы часто содержат одну ось дороги. Совпадающие проекции
    // с одинаковым курсом — одно наблюдение, а не конкурирующие дороги.
    const sameRoad = (c: Candidate) => distM(c.point, best.point) < 3 && adiff(c.travel, best.travel) < 15;
    const bestWeight = Math.exp(-(best.cost - cs[0].cost) / 2);
    const sum = cs.reduce((total, c) => sameRoad(c) ? total : total + Math.exp(-(c.cost - cs[0].cost) / 2), bestWeight);
    const pBest = bestWeight / sum;
    // Не дальше заявленной точности и не дальше MAX_SNAP_M: иначе машинка «уезжает» на соседнюю дорогу из здания, двора, парковки.
    // Держимся своей дороги после уверенной привязки — до MAX_SNAP_M (одиночный выброс не уводит машинку с дороги).
    const snapLimit = held ? MAX_SNAP_M : Math.min(MAX_SNAP_M, Math.max(8, fix.accuracy * 1.5));
    const near = best.dist <= snapLimit;
    const why = `${best.line.id}${best.line.cls ? ` (${best.line.cls})` : ''}: ${Math.round(best.dist)} м, стоимость ${best.cost.toFixed(1)}${cs[1] && cs[1] !== best ? `; вторая ${cs[1].line.id === best.line.id ? cs[0].line.id : cs[1].line.id} — ${(cs[1] === best ? cs[0] : cs[1]).cost.toFixed(1)}` : '; других дорог рядом нет'}${held ? '; держимся своей дороги (переход не подтверждён)' : ''}`;
    // Стоим и давно не ехали (вошли в здание, двор, парковка): к дороге не тянем, кроме совсем близкой.
    const parked = speed < 1 && fix.t - this.movedAt > 30_000;
    if (parked && best.dist > 6) {
      this.cur = null;
      this.pending = null;
      return done(raw(`стоим, ближайшая дорога в ${Math.round(best.dist)} м — без привязки`));
    }
    if (!near && best.dist > snapLimit) {
      this.cur = best;
      return done(raw(`дорога ${best.line.id} в ${Math.round(best.dist)} м — дальше ${Math.round(snapLimit)} м, без привязки`));
    }
    // Абсолютная правдоподобность: единственная дорога рядом ещё не значит «наша» (едем поперёк или против направления).
    const plausible = best.cost < 8;
    const confidence = (near ? Math.min(1, pBest) : pBest * 0.4) * (plausible ? 1 : 0.2);
    this.cur = best;
    const bearing = best.travel;
    // Одиночный выброс к соседней дороге: остаёмся на своей (прыжок туда-обратно хуже, чем одна неточная точка).
    if (plausible && held && this.last?.res.mode === 'matched' && this.last.res.lineId === best.line.id)
      return done({ mode: 'matched', lat: best.point.lat, lon: best.point.lon, bearing, accuracy: fix.accuracy, confidence: Math.max(confidence, 0.5), lineId: best.line.id, reason: why, shift: 0 });
    if (confidence >= 0.7) return done({ mode: 'matched', lat: best.point.lat, lon: best.point.lon, bearing, accuracy: Math.min(fix.accuracy, 10), confidence, lineId: best.line.id, reason: why, shift: 0 });
    if (confidence >= 0.35) {
      // Сомнительно: смещаем к дороге частично — без резких скачков.
      const w = (confidence - 0.35) / 0.35;
      return done({
        mode: 'blend',
        lat: fix.lat + (best.point.lat - fix.lat) * w,
        lon: fix.lon + (best.point.lon - fix.lon) * w,
        bearing: null,
        accuracy: fix.accuracy,
        confidence,
        lineId: best.line.id,
        reason: `частично к дороге (уверенность ${confidence.toFixed(2)}): ${why}`,
        shift: 0,
      });
    }
    return done(raw(`неуверенно (${confidence.toFixed(2)}): ${why}`, confidence));
  }

  /**
   * Прогноз при потере сигнала: только после уверенной привязки и в движении, вдоль той же дороги,
   * не дольше predictSec; неопределённость растёт. null — прогноз не делаем (показываем последнюю позицию).
   */
  predict(now: number): MatchResult | null {
    const l = this.last;
    const c = this.cur;
    if (!l || !c || l.res.mode !== 'matched' || l.speed < PREDICT_MIN_SPEED) return null;
    const dt = (now - l.fix.t) / 1000;
    if (dt <= 1.5 || dt > this.opts.predictSec) return null;
    // Направление прогноза должно быть известно: курс машины совпадает с дорогой (как при привязке — не больше 45°),
    // либо его задаёт сама дорога (маршрут, одностороннее движение). Иначе прогноз мог развернуть машинку назад.
    const sure = l.fix.heading != null ? adiff(l.fix.heading, c.travel) <= 45 : c.line.kind === 'route' || c.line.oneway === 1 || c.line.oneway === -1;
    if (!sure) return null;
    const ahead = Math.min(MAX_PREDICT_M, l.speed * dt);
    const forward = adiff(c.travel, c.bearing) < 90; // едем по ходу линии
    const p = walk(c.line.coords, c.seg, c.f, forward ? ahead : -ahead);
    if (!p) return null;
    return { mode: 'predicted', lat: p.lat, lon: p.lon, bearing: c.travel, accuracy: l.res.accuracy + ahead * 0.5, confidence: Math.max(0, l.res.confidence * (1 - dt / this.opts.predictSec)), lineId: c.line.id, reason: `прогноз ${dt.toFixed(1)} с без новых точек, ${Math.round(l.speed * 3.6)} км/ч по ${c.line.id}`, shift: distM(l.fix, p) };
  }
}

/** Дороги связаны: та же линия, та же дорога (куски из соседних тайлов карты) или общий узел рядом (перекрёсток, съезд). */
type Cand = Pick<Candidate, 'line' | 'point' | 'bearing'>;
function connected(a: Cand, b: Cand): boolean {
  if (a.line.id === b.line.id) return true;
  if (distM(a.point, b.point) < 4 && (adiff(a.bearing, b.bearing) < 20 || adiff(a.bearing, b.bearing) > 160)) return true;
  const ends = (l: RoadLine) => l.coords;
  // Ищем общую (в пределах 6 м) вершину в окрестности 60 м от текущей привязки.
  for (const p of ends(a.line)) {
    if (distM(p, a.point) > 60) continue;
    for (const q of ends(b.line)) if (distM(p, q) < 6) return true;
  }
  return false;
}

/** Пройти по линии от (seg, f) на m метров (минус — назад). */
export function walk(coords: LatLon[], seg: number, f: number, m: number): LatLon | null {
  const lerp = (a: LatLon, b: LatLon, k: number) => ({ lat: a.lat + (b.lat - a.lat) * k, lon: a.lon + (b.lon - a.lon) * k });
  let i = seg;
  let pos = lerp(coords[i], coords[i + 1], f);
  let left = Math.abs(m);
  if (m >= 0) {
    while (i < coords.length - 1) {
      const end = coords[i + 1];
      const d = distM(pos, end);
      if (d >= left) return lerp(pos, end, d ? left / d : 0);
      left -= d;
      pos = end;
      i++;
    }
  } else {
    while (i >= 0) {
      const start = coords[i];
      const d = distM(pos, start);
      if (d >= left) return lerp(pos, start, d ? left / d : 0);
      left -= d;
      pos = start;
      i--;
    }
  }
  return pos;
}
