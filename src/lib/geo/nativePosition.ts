import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { AndroidLocationStatus } from './locationDiagnostics';
import type { MotionObservation, PositionObservation } from './hybridPosition';

interface NativeLocation {
  start(options: { ask: boolean }): Promise<AndroidLocationStatus>;
  exportDiagnostics(options: { json: string }): Promise<void>;
  resolveLocationSettings(): Promise<AndroidLocationStatus>;
  diagnostics(): Promise<AndroidLocationStatus>;
  copyDiagnostics(options: { json: string }): Promise<void>;
  acknowledge(options: { sequence: number }): Promise<void>;
  refresh(): Promise<AndroidLocationStatus>;
  stop(): Promise<void>;
  addListener(event: 'position', fn: (sample: PositionObservation) => void): Promise<PluginListenerHandle>;
  addListener(event: 'locationStatus', fn: (status: AndroidLocationStatus) => void): Promise<PluginListenerHandle>;
  addListener(event: 'motion', fn: (sample: MotionObservation) => void): Promise<PluginListenerHandle>;
}

export const nativePosition = registerPlugin<NativeLocation>('NativePosition');
export const usesAndroidNativePosition = () => Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('NativePosition');

export const usesNativePosition = () => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('NativePosition');
