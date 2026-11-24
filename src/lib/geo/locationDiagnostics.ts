import { createStore } from '../store';
import type { PositionObservation } from './hybridPosition';

export interface AndroidLocationStatus {
  requestStartedAt?: number;
  firstMeasurementAt?: number;
  firstSource?: PositionObservation['source'];
  firstAccuracy?: number;
  fine: boolean;
  coarse: boolean;
  playServices: number;
  fusedStatus: string;
  gpsEnabled: boolean;
  networkEnabled: boolean;
}

interface LocationEvent {
  at: number;
  receivedAt: number;
  source: PositionObservation['source'];
  accuracy: number;
  cached: boolean;
  reason: string;
}

export const androidLocationDiagnostics = createStore<{ status: AndroidLocationStatus | null; samples: LocationEvent[] }>({ status: null, samples: [] });

export function recordLocationStatus(status: AndroidLocationStatus | undefined) {
  if (!status || typeof status.fine !== 'boolean') return;
  const { fine, coarse, playServices, fusedStatus, gpsEnabled, networkEnabled, requestStartedAt, firstMeasurementAt, firstSource, firstAccuracy } = status;
  androidLocationDiagnostics.set((state) => ({ ...state, status: { fine, coarse, playServices, fusedStatus, gpsEnabled, networkEnabled, requestStartedAt, firstMeasurementAt, firstSource, firstAccuracy } }));
}

export function recordLocationSample(fix: PositionObservation, receivedAt: number, reason: string) {
  const { at, source, accuracy, cached = false } = fix;
  androidLocationDiagnostics.set((state) => ({ ...state, samples: [...state.samples.slice(-59), { at, source, accuracy, cached, receivedAt, reason }] }));
}

export const locationDiagnosticsJson = () => JSON.stringify(androidLocationDiagnostics.get(), null, 2);
