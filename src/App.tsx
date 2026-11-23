import { usesAndroidNativePosition } from './lib/geo/nativePosition';
import { lazy, Suspense, useEffect, useState } from 'react';
import { androidDriving } from './lib/androidDriving';
import { Capacitor } from '@capacitor/core';
import { StatusBar } from './components/StatusBar';
import { Dock } from './components/Dock';
import { Panel } from './components/Panel';
import { PageSheet } from './components/PageSheet';
import { VoiceOverlay } from './components/VoiceOverlay';
import { Toasts } from './components/Toasts';
import { PlaceEditor } from './components/MyPlaces';
import { Navigation } from './sections/Navigation';
import { useStore } from './lib/store';
import { layoutStore, settingsStore, closePage, driveUiStore } from './lib/state';
import { setKeepAwake, retryWakeLockOnGesture } from './lib/wakeLock';
import { startGeo, restartGeo, geoStore, setAndroidGeoExperiment } from './lib/nav';
import { restorePlayer } from './lib/player';
import { chatgptReturnMessage } from './lib/chatgpt';
import { takeReturn } from './lib/handoff';
import { restoreNavSession, navStore } from './lib/nav';
import { Hud } from './sections/Hud';
import { hudUiStore, hudActiveNow, closeHud } from './lib/hud';
import { YouTubeMusicFallback } from './components/YouTubeMusic';
import { ytmFallbackStore } from './lib/music/youtube';
import { openSection, toast } from './lib/state';
import { activeReminders, isDue, reminderLabel } from './lib/reminders';

const AutonomousNavigation = lazy(() => import('./sections/AutonomousNavigation').then((m) => ({ default: m.AutonomousNavigation })));

export function App() {
  const [autonomous, setAutonomous] = useState(false);
  const [androidMenu, setAndroidMenu] = useState(false);
  const openAutonomy = Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('TripSensors')
    ? () => { setAndroidMenu(false); setAutonomous(true); } : undefined;
  useEffect(() => { setAndroidGeoExperiment(autonomous); }, [autonomous]);
  const layout = useStore(layoutStore);
  const settings = useStore(settingsStore);
  const ui = useStore(driveUiStore);
  const hud = useStore(hudUiStore).active;

  // Сервисные напоминания со сроком — один раз при запуске.
  useEffect(() => {
    const t = setTimeout(() => {
      const due = activeReminders().filter((r) => isDue(r));
      if (due.length) toast(`Напоминание: ${reminderLabel(due[0])}${due.length > 1 ? ` и ещё ${due.length - 1}` : ''}. Раздел «Сервис».`, 'warn');
    }, 3000);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.scale = settings.textScale;
  }, [settings.textScale]);

  useEffect(() => {
    setKeepAwake(settings.keepAwake);
  }, [settings.keepAwake]);

  useEffect(() => {
    const onTouch = () => retryWakeLockOnGesture();
    window.addEventListener('pointerdown', onTouch, { passive: true });
    if (usesAndroidNativePosition()) startGeo();
    else navigator.permissions
      ?.query({ name: 'geolocation' as PermissionName })
      .then((p) => p.state === 'granted' && startGeo())
      .catch(() => {});
    restorePlayer();
    // ?mode=car — запуск из автоматизации «Подключено к Bluetooth автомобиля»: сразу экран вождения.
    if (new URLSearchParams(location.search).get('mode') === 'car') closePage();
    // Возврат из ChatGPT (или другого приложения): подтверждаем, что маршрут и музыка на месте.
    restoreNavSession();
    // HUD восстанавливается вместе с маршрутом, если был открыт недавно (iPadOS выгрузил приложение).
    if (hudUiStore.get().active && !hudActiveNow()) closeHud();
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      // После фона iOS может отдать старую точку: перезапускаем слежение за свежей.
      if (geoStore.get().status !== 'denied' && geoStore.get().status !== 'idle') restartGeo();
      const h = takeReturn();
      if (!h) return;
      if (h.app === 'chatgpt') toast(chatgptReturnMessage(h), 'ok');
      else {
        // Из YouTube Music сразу возвращаемся к карте; приложение не знает, что играет в YouTube Music.
        ytmFallbackStore.set(false);
        openSection('navigation');
        const route = navStore.get().dest ? 'Карта и маршрут на месте.' : 'Карта на месте.';
        toast(`С возвращением. ${route} Что играет в YouTube Music, AI Car Expert не видит — управление в YouTube Music или кнопками автомобиля.`, 'ok');
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onVisible);
    return () => {
      window.removeEventListener('pointerdown', onTouch);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onVisible);
    };
  }, []);

  return (
    <div className={`app ${ui.minimal ? 'is-minimal' : ''} ${hud ? 'is-hud' : ''} ${autonomous ? 'is-autonomous' : ''} ${androidDriving ? 'android-drive' : ''} ${androidMenu ? 'android-menu-open' : ''}`}>
      {!autonomous && !androidDriving && <StatusBar />}
      <main className={`drive order-${layout.order} panel-${layout.panelMode}`}>
        {/* Карта не размонтируется: маршрут и ведение продолжают работать в любом разделе. */}
        <div className="drive-map">
          {autonomous
            ? <Suspense fallback={null}><AutonomousNavigation close={() => setAutonomous(false)} /></Suspense>
            : <Navigation onAutonomy={openAutonomy} androidMenu={androidMenu} onAndroidMenu={() => { if (androidMenu) closePage(); setAndroidMenu(!androidMenu); }} />}
        </div>
        {!autonomous && (!androidDriving || androidMenu) && <Panel />}
        {!autonomous && layout.page && <PageSheet page={layout.page} />}
      </main>
      {!autonomous && (!androidDriving || androidMenu) && <Dock />}
      <VoiceOverlay />
      <YouTubeMusicFallback />
      <PlaceEditor />
      <Toasts />
      <Hud autonomous={autonomous} />
    </div>
  );
}
