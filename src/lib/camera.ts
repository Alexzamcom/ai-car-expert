/* Камера навигации: масштаб по скорости и упреждение (впереди по ходу видно больше дороги).
   Чистые функции — общие для карты Leaflet и прототипа MapLibre, покрыты тестами. */

/** Масштаб при ведении: в городе крупнее, на трассе — дальше обзор. */
export function followZoom(speedKmh: number | null): number {
  const v = speedKmh ?? 0;
  return v < 50 ? 17 : v < 90 ? 16 : 15;
}

/** Полоса скорости — масштаб меняем только при переходе между полосами (иначе мешаем щипку пользователя). */
export const speedBand = (speedKmh: number | null) => followZoom(speedKmh);

/**
 * Смещение центра карты от машинки в пикселях экрана, чтобы машинка была ниже/позади центра по ходу движения.
 * Карта «север сверху»: курс 0° (на север) → центр выше машинки; 90° (на восток) → центр правее.
 * fraction — доля половины размера карты (0.5 — машинка у края).
 */
export function lookAheadOffset(headingDeg: number, width: number, height: number, fraction = 0.28): [number, number] {
  const r = (headingDeg * Math.PI) / 180;
  return [Math.sin(r) * fraction * width, -Math.cos(r) * fraction * height];
}

/** Отступ сверху для камеры «по движению» (MapLibre padding): машинка в нижней трети экрана. */
export function courseUpPadding(height: number, bottomUi = 0): { top: number; bottom: number; left: number; right: number } {
  return { top: Math.round(height * 0.42), bottom: Math.round(bottomUi), left: 0, right: 0 };
}

export type CameraMode = 'course' | 'north' | 'free';

export const CAMERA_MODE_LABEL: Record<CameraMode, string> = {
  course: 'По движению',
  north: 'Север сверху',
  free: 'Свободный обзор',
};

/** Следующий режим по кнопке: по движению → север сверху → по движению (свободный — только жестом). */
export function nextCameraMode(m: CameraMode, courseAvailable: boolean): CameraMode {
  if (!courseAvailable) return 'north';
  return m === 'course' ? 'north' : 'course';
}

/**
 * Автомасштаб при ведении: по скорости (на трассе — дальше), перед манёвром — плавное приближение перекрёстка.
 * toStepM — расстояние до ближайшего манёвра (null — неизвестно).
 */
export function autoZoom(speedKmh: number | null, toStepM: number | null): number {
  const base = followZoom(speedKmh) - 0.4; // по движению с наклоном видно дальше — чуть мельче, чем «север сверху»
  if (toStepM == null) return base;
  // Плавно (без рывков камеры): от 500 м до 120 м приближение растёт от 0 до 1,3 уровня.
  const t = Math.min(1, Math.max(0, (500 - toStepM) / 380));
  const smooth = t * t * (3 - 2 * t);
  return Math.min(18.2, base + 1.3 * smooth);
}

/* ---------- Камера ведения: обычная, игровая (вид сзади), динамическая (подъём перед поворотами) ---------- */

/** Плавный переход между городским и трассовым масштабами игрового вида. */
export function gameFollowZoom(speedKmh: number | null): number {
  const smooth = (x: number) => {
    const t = Math.max(0, Math.min(1, x));
    return t * t * (3 - 2 * t);
  };
  const speed = speedKmh ?? 0;
  return 16.6 - smooth((speed - 30) / 35) - smooth((speed - 65) / 45);
}

export type NavCamera = 'normal' | 'game' | 'dynamic';
export const NAV_CAMERAS: { id: NavCamera; label: string; hint: string }[] = [
  { id: 'normal', label: 'Обычная', hint: 'Прежний вид: наклон 50°, машинка в нижней части' },
  { id: 'game', label: 'Игровая', hint: 'Вид сзади-сверху за машиной: впереди дорога, здания и маршрут' },
  { id: 'dynamic', label: 'Динамическая', hint: 'Вид сзади; перед поворотом камера плавно поднимается и показывает перекрёсток' },
];

/** Камера по настройке; не выбрана — для «Игровой 3D» динамическая, иначе обычная. */
export function effectiveNavCamera(setting: NavCamera | null | undefined, gameLook: boolean): NavCamera {
  return setting ?? (gameLook ? 'dynamic' : 'normal');
}

/** Манёвр маршрута (шаг OSRM). */
export interface StepLike {
  type: string;
  modifier?: string;
}

/**
 * Насколько поднять камеру перед манёвром: 0 — не поднимать (прямо, продолжение дороги), 1 — поворот,
 * 1.3 — сложный узел (кольцо, развязка, съезд, развилка). Начинается за 150 м (сложные — за 220 м; на скорости —
 * примерно за 7 с), полностью — к 40 м.
 * toStepM — расстояние до манёвра по прогрессу вдоль маршрута (не по ближайшей точке GPS).
 */
export function maneuverLift(step: StepLike | null | undefined, toStepM: number | null | undefined, speedKmh?: number | null): number {
  if (!step || toStepM == null || !Number.isFinite(toStepM) || toStepM < 0) return 0;
  const t = step.type;
  const m = step.modifier ?? '';
  const complex = /roundabout|rotary|fork|ramp|merge/.test(t);
  let strength: number;
  if (complex) strength = 1.3;
  else if (t === 'arrive') strength = 0.6;
  else if (/^(depart|notification)$/.test(t) || m === 'straight' || (!m && /^(continue|new name)$/.test(t))) strength = 0;
  else if (/^slight/.test(m)) strength = 0.6;
  else strength = 1; // turn, end of road, sharp, uturn
  if (!strength) return 0;
  // На скорости подъём начинается раньше — примерно за 7 с до манёвра (но не дальше 400 м).
  const early = speedKmh != null && speedKmh > 0 ? Math.min(400, (speedKmh / 3.6) * 7) : 0;
  const start = Math.max(complex ? 220 : 150, early);
  const full = 40;
  const k = Math.min(1, Math.max(0, (start - toStepM) / (start - full)));
  return strength * k * k * (3 - 2 * k);
}

/**
 * Плавный подъём/опускание камеры: подъём быстрее (успеть показать перекрёсток), возврат медленнее.
 * Ограничение шага по времени — без рывков после потери GPS или перестроения.
 */
export class LiftFilter {
  value = 0;
  update(target: number, dtSec: number): number {
    // Не больше 1 с за обновление: после паузы (потеря GPS, перестроение) камера догоняет за несколько шагов, без рывка.
    const dt = Math.min(1, Math.max(0, dtSec));
    const tau = target > this.value ? 1.1 : 2.2;
    const difference = target - this.value;
    const step = difference * (1 - Math.exp(-dt / tau));
    const delta = Math.abs(difference - step) < 0.005 ? difference : step;
    // Даже если очередная точка сразу переносит нас к сложному манёвру.
    this.value += Math.max(-0.59, Math.min(0.59, delta));
    return this.value;
  }
  reset() {
    this.value = 0;
  }
}

/**
 * Параметры камеры по движению. base — обычный масштаб (autoZoom без приближения перед манёвром — его заменяет подъём).
 * offset — доля высоты экрана, на которую центр карты выше машинки (машинка ближе к нижнему краю).
 */
export function navCameraPose(style: NavCamera, opts: { baseZoom: number; normalPitch: number; lift: number; maxPitch?: number; landscape?: boolean; gameLook?: boolean }): { pitch: number; zoom: number; offset: number } {
  const maxPitch = opts.maxPitch ?? 70;
  if (style === 'normal') return { pitch: opts.normalPitch, zoom: opts.baseZoom, offset: 0.24 };
  // Вид сзади: круче наклон, ближе к машине, машинка ниже — впереди видно дорогу и здания.
  // На широком экране чуть выше обзор и больше запаса под машинкой.
  const game = opts.gameLook === true;
  const chase = {
    pitch: Math.min(maxPitch, game ? (opts.landscape ? 62 : 64) : 60),
    zoom: opts.baseZoom + 0.6,
    offset: game ? (opts.landscape ? 0.21 : 0.24) : 0.3,
  };
  if (style === 'game') return chase;
  const l = Math.max(0, Math.min(1.3, opts.lift));
  // Перед поворотом: выше (меньше наклон), чуть дальше, машинка ближе к центру — виден перекрёсток и примыкающие улицы.
  return {
    pitch: chase.pitch - 15 * l,
    zoom: chase.zoom - 0.45 * l,
    offset: chase.offset - 0.1 * Math.min(1, l),
  };
}
