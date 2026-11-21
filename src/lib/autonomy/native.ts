import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { Fix, Motion } from './estimator';

interface TripSensorsPlugin {
  start(options: { gps: boolean }): Promise<void>;
  startGps(): Promise<void>;
  stop(): Promise<void>;
  exportTrip(options: { data: string }): Promise<void>;
  addListener(name: 'motion', callback: (data: Motion) => void): Promise<PluginListenerHandle>;
  addListener(name: 'gps', callback: (data: Fix) => void): Promise<PluginListenerHandle>;
  addListener(name: 'failure', callback: (data: { message: string }) => void): Promise<PluginListenerHandle>;
}
export const tripSensors = registerPlugin<TripSensorsPlugin>('TripSensors');
