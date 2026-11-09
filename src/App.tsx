import { useEffect } from 'react';
import { StatusBar } from './components/StatusBar';
import { Dock } from './components/Dock';
import { Panel } from './components/Panel';
import { PageSheet } from './components/PageSheet';
import { VoiceOverlay } from './components/VoiceOverlay';
import { Toasts } from './components/Toasts';
import { Navigation } from './sections/Navigation';
import { useStore } from './lib/store';
import { layoutStore, settingsStore, closePage } from './lib/state';
import { setKeepAwake, retryWakeLockOnGesture } from './lib/wakeLock';
import { startGeo } from './lib/nav';
import { restorePlayer } from './lib/player';

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
    const onTouch = () => retryWakeLockOnGesture();
    window.addEventListener('pointerdown', onTouch, { passive: true });
    navigator.permissions
      ?.query({ name: 'geolocation' as PermissionName })
      .then((p) => p.state === 'granted' && startGeo())
      .catch(() => {});
    restorePlayer();
    // ?mode=car — запуск из автоматизации «Подключено к Bluetooth автомобиля»: сразу экран вождения.
    if (new URLSearchParams(location.search).get('mode') === 'car') closePage();
    return () => window.removeEventListener('pointerdown', onTouch);
  }, []);

  return (
    <div className="app">
      <StatusBar />
      <main className={`drive order-${layout.order} panel-${layout.panelMode}`}>
        {/* Карта не размонтируется: маршрут и ведение продолжают работать в любом разделе. */}
        <div className="drive-map">
          <Navigation />
        </div>
        <Panel />
        {layout.page && <PageSheet page={layout.page} />}
      </main>
      <Dock />
      <VoiceOverlay />
      <Toasts />
    </div>
  );
}
