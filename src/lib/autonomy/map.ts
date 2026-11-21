import { createStore } from '../store';
import type { LatLon, Progress, Route } from '../routing';
import type { Estimate } from './estimator';

export const autonomyMap = createStore<{
  position: Estimate | null;
  route: Route | null;
  destination: LatLon | null;
  progress: Progress | null;
}>({ position: null, route: null, destination: null, progress: null });
