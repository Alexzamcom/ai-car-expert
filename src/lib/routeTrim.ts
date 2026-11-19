/* Пройденная часть маршрута: граница «пройдено / осталось» вдоль маршрута для отрисовки.
   Только для изображения — геометрия маршрута, по которой считаются подсказки, не меняется.

   Граница идёт по прогрессу вдоль маршрута (routeProgress: проекция на ломаную с учётом предыдущего участка),
   а не по ближайшей точке GPS. Правила:
   - вперёд — сразу, если сдвиг правдоподобен для скорости; большой скачок вперёд (маршрут проходит рядом сам с собой) —
     только после подтверждения несколькими точками;
   - назад — мелкие откаты (шум GPS, остановка, потеря сигнала) не показываются; крупный откат (разворот на маршруте) —
     после подтверждения, чтобы снова показать нужный участок;
   - вне маршрута граница замирает (ничего не скрываем дополнительно) до перестроения; новый маршрут — с начала. */
import type { LatLon } from './routing';

/** Дальше этого от линии — машина не на маршруте, граница не двигается. */
export const ON_ROUTE_M = 35;
/** Откат назад меньше этого — шум, не показываем. */
export const BACK_JITTER_M = 25;
/** Сколько подряд точек подтверждают крупный скачок вперёд или откат назад. */
export const CONFIRM = 3;

export interface TrimInput {
  /** Маршрут (новый объект — новый маршрут: граница с начала). */
  route: object;
  /** Пройдено вдоль маршрута, м. */
  along: number;
  /** Расстояние от машины до линии маршрута, м. */
  offRouteM: number;
  /** Время точки, мс. */
  t: number;
  /** Скорость, м/с (null — неизвестна). */
  speed?: number | null;
}

export class RouteTrimmer {
  private route: object | null = null;
  private cut = 0;
  private lastT = 0;
  private pending: { along: number; n: number; dir: 1 | -1 } | null = null;

  /** Текущая граница, м от начала маршрута. */
  get value() {
    return this.cut;
  }

  reset() {
    this.route = null;
    this.cut = 0;
    this.pending = null;
  }

  update(i: TrimInput): number {
    if (i.route !== this.route) {
      this.route = i.route;
      this.cut = 0;
      this.pending = null;
      this.lastT = i.t;
      // Новый маршрут строится от машины: если она уже на линии — граница сразу у неё.
      if (i.offRouteM <= ON_ROUTE_M && i.along < 150) this.cut = Math.max(0, i.along);
      return this.cut;
    }
    if (i.t <= this.lastT) return this.cut;
    const dt = Math.min(10, Math.max(0.2, (i.t - this.lastT) / 1000));
    this.lastT = i.t;
    if (i.offRouteM > ON_ROUTE_M || !Number.isFinite(i.along)) {
      this.pending = null;
      return this.cut;
    }
    const d = i.along - this.cut;
    if (d >= 0) {
      // Правдоподобный сдвиг: запас на неточность и задержку точек (на трассе до ~40 м/с).
      const maxStep = 40 + (i.speed != null && i.speed >= 0 ? i.speed : 30) * dt * 1.5;
      if (d <= maxStep) {
        this.cut = i.along;
        this.pending = null;
      } else this.confirm(i.along, 1);
      return this.cut;
    }
    if (-d < BACK_JITTER_M) {
      this.pending = null;
      return this.cut;
    }
    this.confirm(i.along, -1);
    return this.cut;
  }

  private confirm(along: number, dir: 1 | -1) {
    const p = this.pending;
    if (p && p.dir === dir && Math.abs(p.along - along) < 120) {
      p.n++;
      p.along = along;
    } else this.pending = { along, n: 1, dir };
    if (this.pending!.n >= CONFIRM) {
      this.cut = Math.max(0, along);
      this.pending = null;
    }
  }
}

/**
 * Оставшаяся часть ломаной от расстояния `from` (м) до конца: первая точка — точно на границе.
 * cum — накопленные расстояния вершин (routing.cumulative).
 */
export function remainingCoords(coords: LatLon[], cum: number[], from: number): LatLon[] {
  if (coords.length < 2 || from <= 0) return coords;
  const total = cum[cum.length - 1];
  if (from >= total) return [coords[coords.length - 1]];
  // Двоичный поиск отрезка, содержащего границу.
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= from) lo = mid;
    else hi = mid;
  }
  const seg = cum[hi] - cum[lo];
  const k = seg > 0 ? (from - cum[lo]) / seg : 0;
  const a = coords[lo];
  const b = coords[hi];
  return [{ lat: a.lat + (b.lat - a.lat) * k, lon: a.lon + (b.lon - a.lon) * k }, ...coords.slice(hi)];
}
