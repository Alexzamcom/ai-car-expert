import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { MotionObservation, PositionObservation } from './hybridPosition';

interface NativeLocation {
  start(options: { ask: boolean }): Promise<void>;
  stop(): Promise<void>;
  addListener(event: 'position', fn: (sample: PositionObservation) => void): Promise<PluginListenerHandle>;
  addListener(event: 'motion', fn: (sample: MotionObservation) => void): Promise<PluginListenerHandle>;
}

export const nativePosition = registerPlugin<NativeLocation>('NativePosition');
export const usesAndroidNativePosition = () => Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('NativePosition');
