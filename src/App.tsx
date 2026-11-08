import { useEffect } from 'react';
import { StatusBar } from './components/StatusBar';
import { Dock } from './components/Dock';
import { Pane } from './components/Pane';
import { VoiceOverlay } from './components/VoiceOverlay';
import { Toasts } from './components/Toasts';
import { useStore } from './lib/store';
import { layoutStore, settingsStore } from './lib/state';
import { setKeepAwake, retryWakeLockOnGesture } from './lib/wakeLock';
import { startGeo } from './lib/nav';

export function App() {
  const layout = useStore(layoutStore);
  const settings = useStore(settingsStore);

  useEffect(() => {
    document.documentElement.dataset.scale = settings.textScale;
  }, [settings.textScale]);

  useEffect(() => {
    setKeepAwake(settings.keepAwake);
  }, [settings.keepAwake]);

  useEffect(() => {
    // Wake Lock на iPadOS требует жеста пользователя.
    const onTouch = () => retryWakeLockOnGesture();
    window.addEventListener('pointerdown', onTouch, { passive: true });
    // Если доступ к геопозиции уже выдан — сразу начинаем отслеживание.
    navigator.permissions
      ?.query({ name: 'geolocation' as PermissionName })
      .then((p) => p.state === 'granted' && startGeo())
      .catch(() => {});
    return () => window.removeEventListener('pointerdown', onTouch);
  }, []);

  const { primary, secondary, maximized } = layout;
  const split = secondary != null && maximized == null;
  const showPrimary = maximized !== 'secondary';
  const showSecondary = secondary != null && maximized !== 'primary';

  return (
    <div className="app">
      <StatusBar />
      <main className={`panes ${split ? 'is-split' : 'is-single'}`}>
        {showPrimary && (
          <Pane key={primary} section={primary} role="primary" maximized={maximized === 'primary'} hasPartner={secondary != null} />
        )}
        {showSecondary && secondary && (
          <Pane key={secondary} section={secondary} role="secondary" maximized={maximized === 'secondary'} hasPartner />
        )}
      </main>
      <Dock />
      <VoiceOverlay />
      <Toasts />
    </div>
  );
}
