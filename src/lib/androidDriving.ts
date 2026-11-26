import { Capacitor } from '@capacitor/core';
import { cumulative, stepOffsets, type Progress, type Route } from './routing';

export const androidDriving = Capacitor.getPlatform() === 'android';
export const nativeDriving = androidDriving || Capacitor.getPlatform() === 'ios';

export const ANDROID_OVERVIEW = { lon: 0, lat: 0 };
const offsets = new WeakMap<Route, { total: number; offsets: number[] }>();

export function maneuverNotice(route: Route | null, progress: Progress | null, speedKmh: number | null, reliable: boolean) {
  if (!route || !progress || !route.steps.length || !Number.isFinite(progress.toStepM)) return null;
  let geometry = offsets.get(route);
  if (!geometry) {
    const cum = cumulative(route.coords);
    geometry = { total: cum.at(-1) ?? 0, offsets: stepOffsets(route, cum) };
    offsets.set(route, geometry);
  }
  const along = geometry.total - progress.remainingM;
  let index = progress.stepIndex;
  const previous = route.steps[index - 1];
  // OSRM progress can select the next step 5 m before the junction. Keep
  // the visible cue until progress is safely on the exit of the junction.
  if (index > 1 && previous && geometry.offsets[index - 1] > along - 11 &&
    previous.type !== 'depart' && previous.modifier !== 'straight') index--;
  const step = route.steps[index];
  if (!step || step.type === 'depart' || (step.modifier === 'straight' && !/fork|ramp|roundabout|merge/.test(step.type))) return null;
  const distance = Math.max(0, index === progress.stepIndex ? progress.toStepM : geometry.offsets[index] - along);
  const speed = Math.max(0, Math.min(160, speedKmh ?? 30)) / 3.6;
  const complex = /fork|ramp|roundabout|merge/.test(step.type);
  const horizon = Math.min(1200, Math.max(complex ? 155 : 90, speed * (complex ? 23 : 17)));
  if (distance > horizon) return null;
  const urgent = distance <= Math.max(25, speed * 5);
  return { step, index, distance: reliable ? distance : null, urgent: reliable && urgent };
}
