/* Получение координат через Geolocation API в два этапа.

   1. Быстро: getCurrentPosition без высокой точности и с допустимым кешем (maximumAge) — браузер отдаёт позицию,
      которую устройство уже знает или может определить сразу (например, недавно определённую другим приложением).
   2. Непрерывно: watchPosition с enableHighAccuracy — уточнение, когда устройство даёт более точные координаты.
   3. Запасное слежение без высокой точности — только пока слежение с высокой точностью не даёт пригодных точек
      (в здании, в туннеле, при ошибке); выключается, как только точные точки появились.

   Каким способом устройство определило координаты (спутники, Wi-Fi, сотовая сеть), браузер не сообщает и
   переключать эти способы не позволяет. Известно только, каким запросом получена точка и её точность. */

export type FixSource = 'quick' | 'high' | 'low' | 'gps' | 'fused' | 'network' | 'inertial';

export const FIX_SOURCE_LABEL: Record<FixSource, string> = {
  fused: 'Android Fused Location',
  gps: 'спутниковый GPS Android',
  network: 'сетевая позиция Android',
  inertial: 'оценка по датчикам',
  quick: 'быстрый запрос (обычная точность, допускается кеш)',
  high: 'слежение с высокой точностью',
  low: 'запасное слежение (обычная точность)',
};

/** Точка старше этого считается кешированной. */
export const STALE_FIX_MS = 30_000;

export const QUICK_OPTS: PositionOptions = { enableHighAccuracy: false, maximumAge: 5 * 60_000, timeout: 10_000 };
export const HIGH_OPTS: PositionOptions = { enableHighAccuracy: true, maximumAge: 2_000, timeout: 30_000 };
export const LOW_OPTS: PositionOptions = { enableHighAccuracy: false, maximumAge: 30_000, timeout: 30_000 };

/** Точка от слежения с высокой точностью считается «пригодной», если не хуже этой. */
export const GOOD_HIGH_ACCURACY = 100;
/** Через сколько без пригодных точек от высокой точности включать запасное слежение. */
export const LOW_FALLBACK_AFTER_MS = 12_000;
const CHECK_EVERY_MS = 4_000;
const RETRY_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000];

export interface GeoErrorInfo {
  code: number;
  /** 1 — запрещено, 2 — устройство не сообщает позицию, 3 — не успело за отведённое время. */
  kind: 'denied' | 'unavailable' | 'timeout' | 'other';
  message: string;
  source: FixSource;
  at: number;
}

export interface LocatorDeps {
  geo: Pick<Geolocation, 'getCurrentPosition' | 'watchPosition' | 'clearWatch'>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (id: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
}

export function errorKind(code: number): GeoErrorInfo['kind'] {
  return code === 1 ? 'denied' : code === 2 ? 'unavailable' : code === 3 ? 'timeout' : 'other';
}

export class Locator {
  private highId: number | null = null;
  private lowId: number | null = null;
  private interval: unknown = null;
  private retryTimer: unknown = null;
  private retries = 0;
  private startedAt = 0;
  private lastGoodHighAt = 0;
  private running = false;

  constructor(
    private deps: LocatorDeps,
    private onFix: (p: GeolocationPosition, source: FixSource) => void,
    private onError: (e: GeoErrorInfo) => void,
  ) {}

  get state() {
    return { running: this.running, high: this.highId != null, low: this.lowId != null, retries: this.retries };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.startedAt = this.deps.now();
    this.lastGoodHighAt = 0;
    // Этап 1: быстрая доступная позиция — карта не ждёт спутников.
    this.deps.geo.getCurrentPosition(
      (p) => this.running && this.onFix(p, 'quick'),
      (e) => this.running && this.fail(e, 'quick'),
      QUICK_OPTS,
    );
    // Этап 2: непрерывное уточнение.
    this.startHigh();
    this.interval = this.deps.setInterval(() => this.check(), CHECK_EVERY_MS);
  }

  stop() {
    this.running = false;
    if (this.highId != null) this.deps.geo.clearWatch(this.highId);
    if (this.lowId != null) this.deps.geo.clearWatch(this.lowId);
    this.highId = this.lowId = null;
    if (this.interval != null) this.deps.clearInterval(this.interval);
    if (this.retryTimer != null) this.deps.clearTimer(this.retryTimer);
    this.interval = this.retryTimer = null;
    this.retries = 0;
  }

  restart() {
    this.stop();
    this.start();
  }

  private startHigh() {
    if (this.highId != null) return;
    this.highId = this.deps.geo.watchPosition(
      (p) => {
        if (!this.running) return;
        this.retries = 0;
        if (p.coords.accuracy <= GOOD_HIGH_ACCURACY) {
          this.lastGoodHighAt = this.deps.now();
          this.stopLow();
        }
        this.onFix(p, 'high');
      },
      (e) => this.running && this.fail(e, 'high'),
      HIGH_OPTS,
    );
  }

  private startLow() {
    if (this.lowId != null || !this.running) return;
    this.lowId = this.deps.geo.watchPosition(
      (p) => this.running && this.onFix(p, 'low'),
      (e) => this.running && this.fail(e, 'low'),
      LOW_OPTS,
    );
  }

  private stopLow() {
    if (this.lowId == null) return;
    this.deps.geo.clearWatch(this.lowId);
    this.lowId = null;
  }

  /** Нет пригодных точек от высокой точности — включаем запасное слежение; есть — выключаем. */
  private check() {
    if (!this.running) return;
    const now = this.deps.now();
    const since = this.lastGoodHighAt || this.startedAt;
    if (now - since >= LOW_FALLBACK_AFTER_MS) this.startLow();
    else if (this.lastGoodHighAt) this.stopLow();
  }

  private fail(e: GeolocationPositionError, source: FixSource) {
    const info: GeoErrorInfo = { code: e.code, kind: errorKind(e.code), message: e.message || '', source, at: this.deps.now() };
    this.onError(info);
    if (info.kind === 'denied') {
      this.stop();
      return;
    }
    // Высокая точность не справилась — сразу запасное слежение, не дожидаясь проверки.
    if (source !== 'low') this.startLow();
    // «Устройство не сообщает позицию» в слежении: некоторые браузеры после этого не присылают точек — перезапуск с паузой.
    if (info.kind === 'unavailable' && source !== 'quick' && this.retryTimer == null) {
      const delay = RETRY_BACKOFF_MS[Math.min(this.retries, RETRY_BACKOFF_MS.length - 1)];
      this.retries++;
      this.retryTimer = this.deps.setTimer(() => {
        this.retryTimer = null;
        if (!this.running) return;
        const id = source === 'high' ? this.highId : this.lowId;
        if (id != null) this.deps.geo.clearWatch(id);
        if (source === 'high') {
          this.highId = null;
          this.startHigh();
        } else {
          this.lowId = null;
          this.startLow();
        }
      }, delay);
    }
  }
}
