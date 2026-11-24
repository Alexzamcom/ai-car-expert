import { createStore } from '../store';
import type { PositionObservation } from './hybridPosition';

export interface AndroidLocationStatus {
  requestStartedAt?: number;
  firstMeasurementAt?: number;
  firstSource?: PositionObservation['source'];
  firstAccuracy?: number;
  attempts?: { probe: number; at: number; source: string; result: string }[];
  enabled?: boolean;
  wifiEnabled?: boolean;
  wifiScanAvailable?: boolean;
  sdk?: number;
  settingsResolvable?: boolean;
  sent?: number;
  received?: number;
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
  sequence?: number;
  ageMs: number;
  decision?: string;
  mapAccepted?: boolean;
  reason: string;
}

export interface MapVisibility {
  visible: boolean;
  inViewport: boolean;
  covered: boolean;
  ageMs: number | null;
  zoom: number;
  pitch: number;
  bearing: number;
  following: boolean;
  guiding: boolean;
}

export const androidLocationDiagnostics = createStore<{ status: AndroidLocationStatus | null; samples: LocationEvent[]; marker: string; visibility?: MapVisibility }>({
  status: null, samples: [], marker: 'map-not-ready',
});

export function recordMapVisibility(visibility: MapVisibility) {
  androidLocationDiagnostics.set((state) => ({ ...state, visibility }));
}

export function recordLocationMarker(marker: string) {
  if (androidLocationDiagnostics.get().marker !== marker) androidLocationDiagnostics.set((state) => ({ ...state, marker }));
}

export function recordLocationStatus(status: AndroidLocationStatus | undefined) {
  if (!status || typeof status.fine !== 'boolean') return;
  const { fine, coarse, playServices, fusedStatus, gpsEnabled, networkEnabled, requestStartedAt, firstMeasurementAt, firstSource, firstAccuracy,
    enabled, wifiEnabled, wifiScanAvailable, sdk, settingsResolvable, sent, received } = status;
  const attempts = status.attempts?.map(({ probe, at, source, result }) => ({ probe, at, source, result }));
  androidLocationDiagnostics.set((state) => ({ ...state, status: { fine, coarse, playServices, fusedStatus, gpsEnabled, networkEnabled, requestStartedAt, firstMeasurementAt, firstSource, firstAccuracy, enabled, wifiEnabled, wifiScanAvailable, sdk, settingsResolvable, sent, received, attempts } }));
}

export function recordLocationSample(fix: PositionObservation, receivedAt: number, reason: string, decision?: string, mapAccepted?: boolean) {
  const { at, source, accuracy, cached = false, sequence } = fix;
  androidLocationDiagnostics.set((state) => ({ ...state, samples: [...state.samples.slice(-59), { at, source, accuracy, cached, sequence, receivedAt, ageMs: receivedAt - at, reason, decision, mapAccepted }] }));
}

export const locationDiagnosticsJson = () => JSON.stringify({ format: 2, ...androidLocationDiagnostics.get() }, null, 2);
