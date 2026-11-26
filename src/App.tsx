import { activePlannedTrip, plannedRoute, plannerViewport, positionMode, type PlannerLaunch } from './lib/routePlanner';
import { watchAndroidViewport } from './lib/androidViewport';
import { nativePosition, usesAndroidNativePosition } from './lib/geo/nativePosition';
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
import { startGeo, restartGeo, geoStore, setAndroidGeoExperiment, changePositionMode, trustedPlannerPosition } from './lib/nav';
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
  useEffect(() => {
    if (!androidDriving) return;
    const root = document.documentElement;
    const dispose = watchAndroidViewport(() => {
      const viewport = window.visualViewport;
      root.style.setProperty('--android-viewport-height', `${Math.round(viewport?.height ?? innerHeight)}px`);
      root.style.setProperty('--android-viewport-width', `${Math.round(viewport?.width ?? innerWidth)}px`);
    });
    return () => {
      dispose();
      root.style.removeProperty('--android-viewport-height');
      root.style.removeProperty('--android-viewport-width');
    };
  }, []);
  const [restoredPlanner] = useState(() => {
    try {
      return androidDriving && Capacitor.isPluginAvailable('TripSensors') &&
        (!!activePlannedTrip.get().position || localStorage.getItem('ace:planner-open') === '1' && !!plannedRoute.get().route);
    } catch { return false; }
  });
  const [autonomous, setAutonomous] = useState(restoredPlanner);
  const [planner, setPlanner] = useState<PlannerLaunch | undefined>(restoredPlanner ? {} : undefined);
  const [androidMenu, setAndroidMenu] = useState(false);
  const openAutonomy = Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('TripSensors')
    ? () => { setAndroidMenu(false); setAutonomous(true); } : undefined;
  const openPlanner = androidDriving && openAutonomy ? (launch: PlannerLaunch = {}) => {
    if (launch.rejectGps) changePositionMode(true);
    const state = navStore.get();
    const destination = launch.destination ?? (launch.rejectGps ? state.dest ?? undefined : undefined);
    if (launch.destination) {
      const positioning = positionMode.get();
      const actual = positioning.manual ? plannerViewport(positioning, null, []).point : trustedPlannerPosition();
      plannedRoute.set({ from: actual ? { ...actual, name: 'Моё местоположение', address: '', id: 'position' } : null,
        to: launch.destination, route: null });
    }
    setPlanner({ ...launch, destination, route: launch.rejectGps ? state.route ?? undefined : undefined });
    setAndroidMenu(false);
    closePage();
    setAutonomous(true);
  } : undefined;
  useEffect(() => { setAndroidGeoExperiment(autonomous && !planner); }, [autonomous, planner]);
  useEffect(() => {
    try { localStorage.setItem('ace:planner-open', planner ? '1' : '0'); } catch { /* storage unavailable */ }
  }, [planner]);
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
      else if (usesAndroidNativePosition() && geoStore.get().status === 'denied') {
        void nativePosition.diagnostics().then((status) => {
          if (status.fine || status.coarse) startGeo();
        }).catch(() => {});
      }
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
            ? <Suspense fallback={null}><AutonomousNavigation launch={planner} close={() => { setAndroidGeoExperiment(false); setAutonomous(false); setPlanner(undefined); }} /></Suspense>
            : <Navigation onAutonomy={openAutonomy} onPlanner={openPlanner} androidMenu={androidMenu} onAndroidMenu={() => { if (androidMenu) closePage(); setAndroidMenu(!androidMenu); }} />}
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
