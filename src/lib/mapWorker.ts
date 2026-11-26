import { Capacitor } from '@capacitor/core';

let worker: Promise<string> | undefined;
export function mapWorkerUrl(): Promise<string> {
  return worker ??= import('maplibre-gl/dist/maplibre-gl-worker.mjs?url').then(async ({ default: url }) => {
    if (Capacitor.getPlatform() !== 'ios') return url;
    const response = await fetch(url);
    if (!response.ok) throw new Error('MapLibre worker is unavailable');
    return URL.createObjectURL(new Blob([await response.text()], { type: 'text/javascript' }));
  }).catch((error) => { worker = undefined; throw error; });
}
