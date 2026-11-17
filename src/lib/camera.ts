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
