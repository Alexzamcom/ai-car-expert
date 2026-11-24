import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { usesAndroidNativePosition } from './nativePosition';
import { setAndroidGeoActive } from '../nav';

if (Capacitor.getPlatform() === 'android' && !usesAndroidNativePosition()) {
  let resumed = true;
  const sync = () => setAndroidGeoActive(resumed && document.visibilityState === 'visible');
  document.addEventListener('visibilitychange', sync);
  void App.addListener('appStateChange', ({ isActive }) => {
    resumed = isActive;
    sync();
  });
  sync();
}
