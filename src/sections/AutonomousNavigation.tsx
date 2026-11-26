import { RoutePlanner } from '../components/RoutePlanner';
import { activePlannedTrip, plannerViewport, rememberPlannedRoute, rememberRoutingRegion, plannedRoute, positionMode, setManualPoint, type Endpoint, type PlannerLaunch } from '../lib/routePlanner';
import { coordsPlace } from '../lib/geo/geocode';
import { useEffect, useRef, useState } from 'react';
import type { PluginListenerHandle } from '@capacitor/core';
import { autonomyMap } from '../lib/autonomy/map';
import { Estimator, type Estimate, type Fix, type Measurement, type Origin, type Variant } from '../lib/autonomy/estimator';
import { createTrip, deleteTrip, recentTrips, record, replay, saveTrip, type GpsScenario, type Trip } from '../lib/autonomy/trip';
import { tripSensors } from '../lib/autonomy/native';
import { cumulative, fetchRoute, fetchRoutes, haversine, routeProgress, stepOffsets, stepText, type LatLon, type Route } from '../lib/routing';
import { androidDriving, maneuverNotice } from '../lib/androidDriving';
import { closeHud, openHud } from '../lib/hud';
import { consistentPair, courseBetween, goodFix, roadAnchor } from '../lib/autonomy/gnss';
import { PlaceMapPicker } from '../components/PlaceMapPicker';
import { placesStore } from '../lib/places';
import { useStore } from '../lib/store';
import { offlineRegions, regionAt, searchOfflineAddresses } from '../lib/offlineMaps';
import type { Place } from '../lib/geo/geocode';
import { changePositionMode, geoStore, navLang, setAndroidGeoExperiment, trustedPlannerPosition } from '../lib/nav';
import { routingEvent } from '../lib/offlineRouter';
import { openSection } from '../lib/state';
import { settingsStore } from '../lib/state';
import { speak } from '../lib/speech';
import { MapLibreMap, type MapApi } from './MapLibreMap';

type Stage = 'plan' | 'confirm' | 'origin' | 'destination' | 'ready' | 'driving' | 'paused' | 'correct' | 'feedback' | 'archive';
const ISSUES = ['Отставание', 'Забегание вперёд', 'Неправильный поворот', 'Съезд с дороги'];
const VARIANTS: Variant[] = ['inertial', 'road', 'hybrid'];
const MODES: Record<Variant, string> = { inertial: 'Инерциальный', road: 'С дорожной привязкой', hybrid: 'С относительным GPS', adaptive: 'Гибридный', gps: 'Обычный' };
const MAX_GUIDANCE_ERROR_M = 45;

export function AutonomousNavigation({ close, launch }: { close(): void; launch?: PlannerLaunch }) {
  const api = useRef<MapApi | null>(null);
  const ui = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<Stage>(launch ? 'plan' : 'origin');
  const [recovering, setRecovering] = useState(() => !!launch && !!activePlannedTrip.get().position && !!plannedRoute.get().route);
  const restoringPosition = useRef(false);
  const [router, setRouter] = useState<'local' | 'online'>();
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [heading, setHeading] = useState('0');
  const [consent, setConsent] = useState(false);
  const [variant, setVariant] = useState<Variant>('road');
  const [showTools, setShowTools] = useState(false);
  const [sensorStatus, setSensorStatus] = useState(false);
  const bootstrap = useRef<() => void>(() => {});
  const mode = useRef<Variant>('road');
  const [follow, setFollow] = useState(true);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [plannerPicker, setPlannerPicker] = useState<{ field: Endpoint | 'position'; center: LatLon | null }>();
  const [regionField, setRegionField] = useState<Endpoint | 'position' | null>(launch?.rejectGps ? 'position' : null);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const plan = useStore(plannedRoute);
  const positioning = useStore(positionMode);
  useStore(geoStore);
  const actualPosition = positioning.manual ? plannerViewport(positioning, null, []).point : trustedPlannerPosition();
  const [pointPicker, setPointPicker] = useState(false);
  const [address, setAddress] = useState('');
  const [addresses, setAddresses] = useState<Place[]>([]);
  const savedPlaces = useStore(placesStore);
  const downloaded = useStore(offlineRegions);
  const rerouteEvidence = useRef({ count: 0, at: 0 });
  const announced = useRef('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [archive, setArchive] = useState<Trip[]>([]);
  const [scenario, setScenario] = useState<GpsScenario>('recorded');
  const [result, setResult] = useState('');
  const [stars, setStars] = useState(0);
  const [issues, setIssues] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [actual, setActual] = useState<LatLon>();
  const trip = useRef<Trip | null>(null);
  const engine = useRef<Estimator | null>(null);
  const routeAbort = useRef<AbortController | null>(null);
  const listeners = useRef<PluginListenerHandle[]>([]);
  const foreground = useRef(false);
  const foregroundResume = useRef<() => void>(() => {});
  const deferredResume = useRef<Promise<void> | null>(null);
  const accepting = useRef(false);
  const pending = useRef(Promise.resolve());
  const updateAt = useRef(0);
  const lastMotion = useRef(0);
  const stillSince = useRef<number | null>(null);
  const [stationary, setStationary] = useState(false);
  const cached = useRef<{ cum: number[]; offsets: number[] } | undefined>(undefined);
  const currentRoute = useRef<Route | null>(null);
  const segment = useRef(0);

  useEffect(() => {
    if (!launch) return;
    if (launch.rejectGps && launch.route && launch.destination) {
      const first = launch.route.coords[0];
      if (first) plannedRoute.set({ from: coordsPlace(first), to: launch.destination, route: launch.route });
    }
  }, [launch]);

  useEffect(() => {
    if (!launch || stage !== 'plan' && stage !== 'confirm') return;
    const shown = actualPosition ? new Estimator({ position: actualPosition, heading: 0, at: Date.now() }, [], 'road').state : null;
    autonomyMap.set({ position: shown, route: plan.route, destination: plan.route ? plan.to : null, progress: null });
  }, [launch, stage, plan, actualPosition?.lat, actualPosition?.lon]);

  useEffect(() => {
    if (regionField === 'position' && launch?.rejectGps && downloaded.length) chooseOnMap('position');
  }, [launch, downloaded]);

  function openRegion(field: Endpoint | 'position', region: (typeof downloaded)[number]) {
    rememberRoutingRegion(region.name);
    setPlannerPicker({ field, center: region.center });
    setRegionField(null);
    routingEvent({ cameraSource: 'region', settlement: region.settlementId, radiusKm: region.radiusKm });
  }

  function chooseOnMap(field: Endpoint | 'position') {
    const anchor = plannerViewport(positioning, trustedPlannerPosition(), downloaded);
    if (anchor.source === 'choose' && downloaded.length > 1) {
      setRegionField(field);
      return;
    }
    if (anchor.region) {
      const endpoint = field === 'to' ? plan.to ?? plan.from : null;
      if (!endpoint || regionAt(endpoint)?.id !== anchor.region.id) return openRegion(field, anchor.region);
      setPlannerPicker({ field, center: endpoint });
      setRegionField(null);
      routingEvent({ cameraSource: 'planned-endpoint-in-region', settlement: anchor.region.settlementId });
      return;
    }
    // Keep an intentionally chosen start in view when setting a destination without a fix/region.
    const endpoint = field === 'to' ? plan.to : null;
    const anchorRegion = anchor.point && regionAt(anchor.point);
    const center = endpoint && anchorRegion && regionAt(endpoint)?.id === anchorRegion.id
      ? endpoint : anchor.point;
    setPlannerPicker({ field, center });
    setRegionField(null);
    routingEvent({ cameraSource: anchor.point ? anchor.source : 'overview' });
  }

  async function buildPlan(onlineOnly = false) {
    const { from, to } = plannedRoute.get();
    if (!from || !to || routeAbort.current) return;
    if (haversine(from, to) < 20) { setMessage('Выберите точки на расстоянии не менее 20 м.'); return; }
    const request = new AbortController();
    routeAbort.current = request;
    setMessage('');
    setBusy(true);
    try {
      const [selected] = await fetchRoutes(from, to, { signal: request.signal, onlineOnly, confirmOnline: downloaded.some((region) => region.graph?.length),
        onOnlineRequest: (count) => routingEvent({ router: 'online', externalRequests: count }),
        onRouter: (source) => {
          setRouter(source);
          routingEvent({ router: source, online: navigator.onLine, positionMode: positionMode.get().manual ? 'manual' : 'auto' });
        } });
      if (request.signal.aborted) return;
      plannedRoute.set({ from, to, route: selected });
      rememberPlannedRoute(from, to, selected);
      setRecovering(false);
      requestAnimationFrame(() => api.current?.fitPoints(selected.coords, ui.current));
    } catch (error) {
      if (!request.signal.aborted) setMessage(error instanceof Error ? error.message : 'Маршрут не найден.');
    } finally {
      if (routeAbort.current === request) {
        routeAbort.current = null;
        setBusy(false);
        setRouter(undefined);
      }
    }
  }

  function beginPlannedTrip(confirm: boolean) {
    const { from, to, route: selected } = plannedRoute.get();
    if (!from || !to || !selected) return;
    const fix = trustedPlannerPosition();
    if (!confirm && (!fix || haversine(fix, from) > 50)) {
      setAwaitingConfirmation(true);
      setStage('confirm');
      return;
    }
    const position = fix && !confirm ? fix : from;
    if (confirm) {
      changePositionMode(true);
      setManualPoint(position);
    }
    const direction = selected.coords.length > 1 ? courseBetween(selected.coords[0], selected.coords[1]) : 0;
    const anchor = { position, heading: direction, at: Date.now() };
    const source = confirm ? 'road' : 'adaptive';
    setOrigin(anchor);
    setVariant(source);
    prepareRoute(selected, to);
    setAwaitingConfirmation(false);
    void start(anchor, selected, source);
  }

  function persist() {
    const entry = trip.current;
    if (!entry) return pending.current;
    const snapshot = { ...entry, frames: entry.frames.slice() };
    pending.current = pending.current.then(() => saveTrip(snapshot)).catch(() => setMessage('Не удалось сохранить запись в хранилище устройства'));
    return pending.current;
  }

  function update(input: Measurement) {
    if (!engine.current) return;
    const next = engine.current.update(input);
    if (trip.current) record(trip.current, input, next);
    const now = Date.now();
    if (input.type === 'motion') {
      lastMotion.current = now;
      stillSince.current = next.stopped ? stillSince.current ?? now : null;
      if (now - updateAt.current < 200 && !next.event) return;
    }
    updateAt.current = now;
    setEstimate(next);
    setStationary(stillSince.current != null && now - stillSince.current > 1500);
    const activeRoute = currentRoute.current;
    const p = activeRoute && next.uncertainty <= MAX_GUIDANCE_ERROR_M
      ? routeProgress(activeRoute, next, cached.current, segment.current) : null;
    if (p && p.offRouteM <= 20) segment.current = p.segIndex;
    if (foreground.current && input.type === 'gps' && p && next.gps === 'trusted' && next.source === 'gnss') {
      const evidence = rerouteEvidence.current;
      evidence.count = p.offRouteM > Math.max(45, next.uncertainty * 2) ? evidence.count + 1 : 0;
      if (activeRoute && evidence.count >= 3 && now - evidence.at > 20_000 && !routeAbort.current) {
        evidence.at = now;
        evidence.count = 0;
        void reroute(next, activeRoute);
      }
    }
    if (foreground.current && p && p.offRouteM <= 20) {
      const prompt = maneuverNotice(activeRoute, p, next.speed * 3.6, true);
      const key = `${p.stepIndex}:${prompt?.urgent ?? false}`;
      if (prompt && announced.current !== key && settingsStore.get().speakNavigation) {
        announced.current = key;
        speak(stepText(prompt.step, navLang()), settingsStore.get().speechLang);
      }
    }
    autonomyMap.set({ position: next, route: activeRoute, destination: activeRoute?.coords.at(-1) ?? null, progress: p && p.offRouteM <= 20 ? p : null });
  }

  async function stopNative() {
    accepting.current = false;
    const handles = listeners.current.splice(0);
    let timer: number | undefined;
    await Promise.race([
      Promise.allSettled([tripSensors.stop(), ...handles.map((listener) => listener.remove())]),
      new Promise<void>((resolve) => { timer = window.setTimeout(resolve, 2000); }),
    ]);
    clearTimeout(timer);
  }

  function pause(reason: string) {
    if (!foreground.current) return;
    foreground.current = false;
    accepting.current = false;
    stillSince.current = null;
    closeHud();
    update({ type: 'pause', at: Date.now() });
    setStage('paused');
    setMessage(reason);
    void stopNative();
    void persist();
  }

  foregroundResume.current = () => {
    if (currentRoute.current && engine.current) void start(origin, currentRoute.current, mode.current);
  };

  useEffect(() => {
    const hide = () => {
      if (document.visibilityState !== 'visible') {
        if (!accepting.current) return;
        foreground.current = false;
        accepting.current = false;
        stillSince.current = null;
        update({ type: 'pause', at: Date.now() });
        deferredResume.current = stopNative();
        void persist();
        return;
      }
      const stopped = deferredResume.current;
      if (stopped) void stopped.then(() => {
        if (deferredResume.current !== stopped || document.visibilityState !== 'visible') return;
        deferredResume.current = null;
        foregroundResume.current();
      });
    };
    const restart = () => {
      deferredResume.current = null;
      foreground.current = false;
      routeAbort.current?.abort();
      bootstrap.current();
      closeHud();
      void stopNative();
      void persist();
    };
    const health = window.setInterval(() => {
      if (!accepting.current) return;
      const now = Date.now();
      const live = now - lastMotion.current <= 2500;
      setSensorStatus(live);
      if (mode.current === 'adaptive' || mode.current === 'gps') update({ type: 'tick', at: now });
      else if (!live) pause('Датчики перестали обновляться. После остановки уточните точку и направление.');
    }, 1000);
    const checkpoint = window.setInterval(() => void persist(), 30_000);
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('ace:restart', restart);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('ace:restart', restart);
      deferredResume.current = null;
      clearInterval(health);
      clearInterval(checkpoint);
      bootstrap.current();
      routeAbort.current?.abort();
      closeHud();
      foreground.current = false;
      void stopNative();
      void persist();
      autonomyMap.set({ position: null, route: null, destination: null, progress: null });
    };
  }, []);

  function selectOrigin(position = api.current?.center?.()) {
    const direction = Number(heading);
    if (!position || Math.abs(position.lat) >= 85 || !heading.trim() || !Number.isFinite(direction) || direction < 0 || direction >= 360) {
      setMessage('Выберите точку карты и направление от 0 до 359°');
      return;
    }
    const anchor = { position, heading: direction, at: Date.now() };
    setOrigin(anchor);
    setMessage('');
    if (stage === 'correct') {
      segment.current = 0;
      if (launch && positioning.manual) setManualPoint(position);
      update({ type: 'correction', ...anchor });
      const active = currentRoute.current;
      if (active && routeProgress(active, position).offRouteM > 45) void reroute(position, active);
      void persist();
      setStage('paused');
    } else {
      autonomyMap.set({ position: new Estimator(anchor, [], 'road').state, route: null, destination: null, progress: null });
      setStage('destination');
    }
  }

  function locateOrigin() {
    if (!navigator.geolocation || busy) return;
    setBusy(true);
    setMessage('Проверяем последовательность GNSS-точек…');
    let previous: Fix | undefined;
    let consecutive = 0;
    let watch: number | undefined;
    let done = false;
    const stop = () => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      if (watch != null) navigator.geolocation.clearWatch(watch);
    };
    bootstrap.current = stop;
    const fail = () => {
      if (done) return;
      stop();
      setBusy(false);
      setMessage('Надёжный старт GNSS не подтверждён. Укажите точку и курс вручную.');
    };
    const timeout = window.setTimeout(fail, 15_000);
    watch = navigator.geolocation.watchPosition(({ coords, timestamp }) => {
      const fix: Fix = { lat: coords.latitude, lon: coords.longitude, accuracy: coords.accuracy, speed: coords.speed, at: timestamp };
      const plausible = goodFix(fix, Date.now());
      if (previous && fix.at === previous.at) return;
      const pair = plausible && previous && consistentPair(previous, fix);
      consecutive = pair ? consecutive + 1 : plausible ? 1 : 0;
      const course = coords.heading != null && Number.isFinite(coords.heading) && (coords.speed ?? 0) > 2
        ? coords.heading : pair && previous && haversine(previous, fix) >= 6 ? courseBetween(previous, fix) : undefined;
      previous = plausible ? fix : undefined;
      if (done || consecutive < 3) return;
      stop();
      setBusy(false);
      const roads = api.current?.roadsNear?.(fix) ?? [];
      const snapped = roadAnchor(fix, roads, course);
      if (!snapped) {
        api.current?.centerOn(fix, 17);
        setMessage('Подходящая дорога не подтверждена. Проверьте точку и курс вручную.');
        return;
      }
      const anchor = { position: snapped.point, heading: course ?? snapped.course, at: Date.now() };
      setOrigin(anchor);
      setHeading(String(Math.round(anchor.heading) % 360));
      setVariant('adaptive');
      setMessage('');
      autonomyMap.set({ position: new Estimator(anchor, [], 'adaptive').state, route: null, destination: null, progress: null });
      api.current?.centerOn(anchor.position, 17);
      setStage('destination');
    }, fail, { enableHighAccuracy: true, maximumAge: 0, timeout: 12_000 });
  }

  function prepareRoute(selected: Route, destination: LatLon) {
    setRoute(selected);
    const cum = cumulative(selected.coords);
    cached.current = { cum, offsets: stepOffsets(selected, cum) };
    currentRoute.current = selected;
    autonomyMap.set({ ...autonomyMap.get(), route: selected, destination });
    api.current?.fitPoints(selected.coords, ui.current);
    setStage('ready');
  }

  function useSavedRoute() {
    try {
      const stored = JSON.parse(localStorage.getItem('ace:offline-autonomy-route') ?? 'null') as { route: Route; destination: LatLon; at: number } | null;
      if (!stored || !origin || Date.now() - stored.at > 6 * 3600_000 ||
        routeProgress(stored.route, origin.position).offRouteM > 35) {
        setMessage('Ранее построенный маршрут недоступен или старт слишком далеко от него.');
        return;
      }
      setMessage('');
      prepareRoute(stored.route, stored.destination);
    } catch {
      setMessage('Ранее построенный маршрут недоступен.');
    }
  }

  async function reroute(position: LatLon, active: Route) {
    const target = active.coords.at(-1);
    if (!target || routeAbort.current) return;
    const request = new AbortController();
    routeAbort.current = request;
    try {
      const selected = await fetchRoute(position, target, request.signal);
      if (request.signal.aborted || currentRoute.current !== active) return;
      segment.current = 0;
      announced.current = '';
      const cum = cumulative(selected.coords);
      cached.current = { cum, offsets: stepOffsets(selected, cum) };
      currentRoute.current = selected;
      engine.current?.setRoute(selected.coords);
      setRoute(selected);
      if (launch) plannedRoute.set((previous) => ({ ...previous, route: selected }));
      autonomyMap.set({ ...autonomyMap.get(), route: selected, destination: target, progress: null });
      setMessage('Маршрут перестроен');
    } catch (error) {
      if (!request.signal.aborted) setMessage(error instanceof Error ? error.message : 'Перестроение недоступно');
    } finally { if (routeAbort.current === request) routeAbort.current = null; }
  }

  async function selectDestination(target = api.current?.center?.()) {
    if (routeAbort.current) return;
    if (!target || !origin || haversine(origin.position, target) < 20) {
      setMessage('Выберите пункт назначения дальше 20 м');
      return;
    }
    const request = new AbortController();
    routeAbort.current = request;
    setBusy(true);
    setMessage('');
    try {
      const selected = await fetchRoute(origin.position, target, request.signal);
      if (request.signal.aborted) return;
      prepareRoute(selected, target);
      if (androidDriving && selected.coords.length <= 20_000) {
        try { localStorage.setItem('ace:offline-autonomy-route', JSON.stringify({ route: selected, destination: target, at: Date.now() })); } catch { /* Storage can be disabled. */ }
      }
    } catch (error) {
      if (!request.signal.aborted) setMessage(error instanceof Error ? error.message : 'Маршрут недоступен.');
    } finally {
      if (routeAbort.current === request) {
        routeAbort.current = null;
        setBusy(false);
        setRouter(undefined);
      }
    }
  }

  async function start(anchorInput = origin, selectedRoute = route, source = variant) {
    if (!anchorInput || !selectedRoute || busy) return;
    if (launch) setAndroidGeoExperiment(true);
    const gps = !positionMode.get().manual && (source === 'adaptive' || source === 'hybrid' || source === 'gps');
    mode.current = gps ? source : 'road';
    const first = !engine.current;
    if (first) {
      const anchor = { ...anchorInput, at: Date.now() };
      engine.current = new Estimator(anchor, selectedRoute.coords, mode.current);
      if (consent) trip.current = createTrip(anchor, selectedRoute, mode.current);
    }
    engine.current?.setVariant(mode.current);
    setBusy(true);
    setMessage('');
    foreground.current = true;
    try {
      listeners.current.push(await tripSensors.addListener('motion', (sample) => accepting.current && update({ type: 'motion', sample })));
      listeners.current.push(await tripSensors.addListener('gps', (sample) => accepting.current && mode.current !== 'road' && mode.current !== 'inertial' && update({ type: 'gps', sample: { ...sample, speed: sample.speed ?? null } })));
      listeners.current.push(await tripSensors.addListener('failure', ({ message: reason }) => pause(reason)));
      if (!foreground.current) {
        await stopNative();
        return;
      }
      await tripSensors.start({ gps, allowGpsOnly: gps && (source === 'adaptive' || source === 'gps') });
      if (!foreground.current || document.visibilityState !== 'visible') {
        await stopNative();
        return;
      }
      lastMotion.current = Date.now();
      accepting.current = true;
      setEstimate(engine.current?.state ?? null);
      setFollow(true);
      setStage('driving');
      if (launch && first) activePlannedTrip.set({ position: { ...anchorInput.position, heading: anchorInput.heading } });
      void persist();
      if (gps) void tripSensors.startGps().catch(() => setMessage('Относительные GPS-измерения недоступны. Продолжаем по датчикам.'));
    } catch (error) {
      foreground.current = false;
      await stopNative();
      if (first) {
        engine.current = null;
        trip.current = null;
      }
      setMessage(error instanceof Error ? error.message : 'Датчики недоступны');
    } finally { setBusy(false); }
  }

  function changeMode(next: Variant) {
    if (positionMode.get().manual && next !== 'road') {
      setMessage('Сначала включите автоматическое местоположение в меню карты.');
      return;
    }
    const usedGps = mode.current !== 'road' && mode.current !== 'inertial';
    setVariant(next);
    mode.current = next;
    engine.current?.setVariant(next);
    if (engine.current) {
      const position = engine.current.state;
      setEstimate(position);
      autonomyMap.set({ ...autonomyMap.get(), position });
    }
    if (!accepting.current || usedGps === (next !== 'road')) return;
    const request = next === 'road' ? tripSensors.stopGps() : tripSensors.startGps();
    void request.catch(() => setMessage(next === 'road' ? 'GPS исключён из расчёта позиции.' : 'Спутниковый источник недоступен.'));
  }

  async function findAddress(event: React.FormEvent) {
    event.preventDefault();
    try {
      const found = await searchOfflineAddresses(address);
      setAddresses(found);
      setMessage(found.length ? '' : 'Адрес не найден в скачанных пакетах.');
    } catch { setMessage('Не удалось прочитать локальный адресный индекс.'); }
  }

  async function finish() {
    deferredResume.current = null;
    routeAbort.current?.abort();
    if (launch) activePlannedTrip.set({ position: null });
    setBusy(true);
    closeHud();
    foreground.current = false;
    await stopNative();
    if (trip.current) trip.current.ended = Date.now();
    void persist();
    setFollow(false);
    setStage('feedback');
    setBusy(false);
  }

  async function saveFeedback() {
    const entry = trip.current;
    if (entry) {
      entry.feedback = { stars, errors: issues, comment, actual, endpointErrorM: actual && estimate ? haversine(actual, estimate) : undefined };
      await persist();
    }
    close();
  }

  async function openArchive() {
    try {
      setArchive(await recentTrips());
      setStage('archive');
      setResult('');
    } catch { setMessage('Локальные записи недоступны'); }
  }

  function compare(entry: Trip) {
    try {
      const base = replay(entry, entry.variant, 'recorded').endpoint;
      setResult(VARIANTS.map((variant) => {
        const end = replay(entry, variant, scenario).endpoint;
        const actualPoint = entry.feedback?.actual;
        return `${MODES[variant]}: ${Math.round(haversine(end, actualPoint ?? base))} м ${actualPoint ? 'от точки водителя' : 'от исходного воспроизведения'}`;
      }).join('\n'));
    } catch { setMessage('Запись не удалось воспроизвести'); }
  }

  const selecting = stage === 'origin' || stage === 'destination' || stage === 'correct' || stage === 'feedback';
  const progress = stage === 'driving' && estimate && estimate.uncertainty <= MAX_GUIDANCE_ERROR_M
    ? autonomyMap.get().progress : null;
  const cue = androidDriving ? maneuverNotice(route, progress, (estimate?.speed ?? 0) * 3.6, !!progress) : null;
  const step = androidDriving ? cue?.step : progress && route?.steps[progress.stepIndex];
  const modeSelect = <label>Режим <select value={variant} onChange={(event) => changeMode(event.target.value as Variant)}>
    {androidDriving && <option value="gps">Обычный · подтверждённый GPS</option>}
    {!androidDriving && <option value="hybrid">Только относительная GPS-помощь</option>}
    <option value="adaptive">Гибридный · GPS и датчики</option>
    <option value="road">Автономный · без GPS</option>
  </select></label>;
  return (
    <div className="navigation">
      <MapLibreMap apiRef={api} uiEl={ui} autonomous follow={stage === 'driving' && follow} guiding={stage === 'driving'} onUserMove={() => setFollow(false)} />
      {plannerPicker && <PlaceMapPicker route={restoringPosition.current ? plan.route?.coords : undefined} regions={downloaded} onRegionChange={(region) => rememberRoutingRegion(region.name)} start={plannerPicker.center} cancel={() => { restoringPosition.current = false; setPlannerPicker(undefined); }} confirm={(point) => {
        const field = plannerPicker.field;
        setPlannerPicker(undefined);
        if (field === 'position') {
          if (restoringPosition.current && plan.route && plan.to) {
            restoringPosition.current = false;
            const progress = routeProgress(plan.route, point);
            if (progress.offRouteM > 45) {
              setMessage('Выбранная точка вне сохранённого маршрута. Выберите точку на маршруте или завершите предыдущую поездку.');
              return;
            }
            const coords = plan.route.coords;
            const heading = courseBetween(coords[progress.segIndex], coords[progress.segIndex + 1]);
            const anchor = { position: point, heading, at: Date.now() };
            setMessage('');
            const source = positionMode.get().manual ? 'road' : 'adaptive';
            if (source === 'road') setManualPoint(point);
            setOrigin(anchor);
            setVariant(source);
            prepareRoute(plan.route, plan.to);
            segment.current = progress.segIndex;
            setRecovering(false);
            void start(anchor, plan.route, source);
            return;
          }
          setManualPoint(point);
          api.current?.centerOn(point, 16);
          if (!plannedRoute.get().from) plannedRoute.set((previous) => ({ ...previous, from: { ...coordsPlace(point), name: 'Ручная позиция' } }));
        } else {
          plannedRoute.set((previous) => ({ ...previous, [field]: { ...coordsPlace(point), name: field === 'from' ? 'Старт на карте' : 'Финиш на карте' }, route: null }));
        }
      }} />}
      {pointPicker && <PlaceMapPicker start={api.current?.center?.() ?? null} cancel={() => setPointPicker(false)}
        confirm={(point) => { setPointPicker(false); if (stage === 'destination') void selectDestination(point); else selectOrigin(point); }} />}
      {selecting && <div className="autonomy-crosshair" aria-hidden="true">⌖</div>}
      <div className={`autonomy-panel ${launch && (stage === 'plan' || stage === 'confirm') ? 'route-planner-panel' : ''} ${stage === 'driving' && !showTools ? 'autonomy-compact' : ''}`} ref={ui}>
        <strong>{launch && (stage === 'plan' || stage === 'confirm') ? 'Маршрут' : 'Навигация без GPS · эксперимент'}</strong>
        {launch && (stage === 'plan' || stage === 'confirm') && <>
          {positioning.manual && <details className="route-planner-position">
            <summary>{positioning.point ? `Ручная позиция · ${new Date(positioning.point.at).toLocaleString('ru')}` : 'GPS отключён · укажите положение автомобиля'}</summary>
            <div className="route-planner-status">
              <button className="btn" disabled={busy} onClick={() => chooseOnMap('position')}>Указать местоположение</button>
              <button className="btn" disabled={busy} onClick={() => { setRegionField(null); changePositionMode(false); }}>Включить автоматическое местоположение</button>
            </div>
          </details>}
          {regionField && <label>Скачанная карта <select defaultValue="" onChange={(event) => {
            const region = downloaded.find((item) => item.id === event.target.value);
            if (!region) return;
            openRegion(regionField, region);
          }}><option value="">Выберите регион</option>{downloaded.map((region) => <option key={region.id} value={region.id}>{region.name}</option>)}</select></label>}
          {recovering && stage === 'plan' && <div role="status">
            <p>Предыдущая поездка не завершена. Для продолжения подтвердите текущее положение.</p>
            <button className="btn" onClick={() => { restoringPosition.current = true; chooseOnMap('position'); }}>Уточнить и продолжить</button>
            <button className="btn" onClick={() => {
              activePlannedTrip.set({ position: null });
              restoringPosition.current = false;
              setRegionField(null);
              setMessage('');
              setRecovering(false);
            }}>Завершить предыдущую поездку</button>
          </div>}
          {busy && router && <p role="status">{router === 'local'
            ? navLang() === 'uk' ? 'Побудова маршруту за офлайн-картою' : 'Построение маршрута по офлайн-карте'
            : 'Построение маршрута онлайн'} <button className="btn" onClick={() => routeAbort.current?.abort()}>Отмена</button></p>}
          {!recovering && stage === 'plan' && <RoutePlanner actual={actualPosition} pick={chooseOnMap} build={() => void buildPlan()} busy={busy} ready={!!plan.route} />}
          {!recovering && stage === 'plan' && plan.route && <label><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Записать поездку локально</label>}
          {!recovering && stage === 'plan' && plan.route && <button className="btn btn-primary" disabled={busy} onClick={() => beginPlannedTrip(false)}>Начать поездку</button>}
          {awaitingConfirmation && stage === 'confirm' && <>
            <p>Вы сейчас находитесь в точке «{plan.from?.name}»? Подтвердите её только после остановки.</p>
            <button className="btn btn-primary" onClick={() => beginPlannedTrip(true)}>Подтвердить фактическую позицию</button>
            <button className="btn" onClick={() => { setStage('plan'); setAwaitingConfirmation(false); }}>Вернуться к маршруту</button>
          </>}
          {(message.includes('покрытия') || message.includes('Valhalla не нашёл проезда')) && navigator.onLine && <button className="btn" onClick={() => void buildPlan(true)}>Построить онлайн</button>}
          {(message.includes('покрытия') || message.includes('Обновите скачанную карту')) && <button className="btn" onClick={() => { close(); openSection('settings'); }}>Офлайн-карты</button>}
          <button className="btn" onClick={close}>Назад</button>
        </>}
        {message && <div role="status">{message}</div>}
        {(stage === 'origin' || stage === 'correct') && <>
          <p>Только после остановки. Переместите карту, чтобы поставить прицел на нужную полосу.</p>
          <label>Курс автомобиля · север 0°, восток 90° <input type="number" min="0" max="359" value={heading} onChange={(e) => setHeading(e.target.value)} /></label>
          <button className="btn" disabled={busy} onClick={() => setPointPicker(true)}>Указать старт на карте</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => selectOrigin()}>{stage === 'correct' ? 'Подтвердить коррекцию' : 'Установить автомобиль'}</button>
        </>}
        {stage === 'origin' && <>{androidDriving && downloaded.length > 0 && <label>Открыть скачанную карту <select defaultValue=""
          onChange={(event) => { const area = downloaded.find((item) => item.id === event.target.value); if (area) api.current?.centerOn(area.center, 15); }}>
          <option value="">Выберите регион</option>{downloaded.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}
        </select></label>}{savedPlaces.length > 0 && <label>Старт из сохранённых мест <select defaultValue=""
          onChange={(event) => { const place = savedPlaces.find((item) => item.id === event.target.value); if (place) selectOrigin(place); }}>
          <option value="">Выберите место</option>{savedPlaces.map((place) => <option key={place.id} value={place.id}>{place.name}</option>)}
        </select></label>}<button className="btn btn-primary" disabled={busy} onClick={locateOrigin}>Определить старт по GNSS</button><button className="btn" onClick={() => void openArchive()}>Записи поездок</button><button className="btn" onClick={close}>Назад</button></>}
        {stage === 'destination' && <>
          {androidDriving && <button className="btn" disabled={busy} onClick={useSavedRoute}>Использовать сохранённый маршрут</button>}
          <form onSubmit={findAddress}>
            <label>Офлайн-адрес <input value={address} onChange={(event) => { setAddress(event.target.value); setAddresses([]); }} /></label>
            <button className="btn" disabled={busy || address.trim().length < 2}>Найти офлайн</button>
          </form>
          {addresses.map((place) => <button className="btn" key={place.id} disabled={busy} onClick={() => void selectDestination(place)}>{place.name} · {place.address}</button>)}
          <button className="btn" disabled={busy} onClick={() => setPointPicker(true)}>Указать назначение на карте</button>
          <p>Поставьте прицел на пункт назначения.</p>
          <button className="btn btn-primary" disabled={busy} onClick={() => void selectDestination()}>Построить маршрут сюда</button>
          <button className="btn" disabled={busy} onClick={() => setStage('origin')}>Изменить старт</button>
        </>}
        {stage === 'ready' && <>
          <p>Начните с полной остановки. Закрепите телефон и первые секунды плавно разгоняйтесь по прямой для калибровки.</p>
          {!positioning.manual && modeSelect}
          <label><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Записать поездку локально, включая координаты GPS при включённом GPS</label>
          <button className="btn btn-primary" disabled={busy} onClick={() => void start()}>{variant === 'road' ? 'Начать поездку без GPS' : 'Начать поездку'}</button>
          <button className="btn" disabled={busy} onClick={close}>Отмена</button>
        </>}
        {stage === 'driving' && estimate && <>
          <div>Оценка скорости {Math.round(estimate.speed * 3.6)} км/ч · ±{Math.ceil(estimate.uncertainty)} м</div>
          {step && progress ? <div>{stepText(step)} · около {Math.round(cue?.distance ?? progress.toStepM)} м</div>
            : !progress ? <div>Положение для указаний не подтверждено</div> : null}
          <button className="btn btn-primary" onClick={openHud}>HUD</button>
          <button className="btn" aria-expanded={showTools} onClick={() => setShowTools(!showTools)}>Меню поездки</button>
          {showTools && <>
          {androidDriving && modeSelect}
          <div>GPS { { disabled: 'выключен', waiting: 'ожидание', rejected: 'отклонён', relative: 'относительная помощь', trusted: 'подтверждён' }[estimate.gps] } · датчики {sensorStatus ? 'активны' : 'нет свежих данных'}</div>
          <div>Источник { { gnss: 'GNSS', hybrid: 'гибрид', inertial: 'инерция' }[estimate.source] }</div>
          <div>Расстояние · GPS {Math.round(estimate.distance.gps)} м · датчики {Math.round(estimate.distance.sensors)} м · итог {Math.round(estimate.distance.fused)} м</div>
          {trip.current?.truncated && <div>Достигнут предел записи.</div>}
          {!follow && <button className="btn" onClick={() => setFollow(true)}>К машине</button>}
          {launch && !positioning.manual && <button className="btn" onClick={() => {
            changePositionMode(true);
            setVariant('road');
            mode.current = 'road';
            pause('GPS отключён. После остановки уточните положение.');
          }}>GPS показывает неверное местоположение</button>}
          <button className="btn" disabled={!stationary} onClick={() => { pause('Подтвердите точку только на остановке.'); setStage('correct'); setHeading(String(Math.round(estimate.heading) % 360)); }}>Уточнить после остановки</button>
          <button className="btn" onClick={() => pause('Для коррекции и возобновления дождитесь полной остановки.')}>Пауза</button>
          <button className="btn" disabled={busy} onClick={() => void finish()}>Завершить поездку</button>
          </>}
        </>}
        {stage === 'paused' && <>
          {androidDriving && modeSelect}
          <button className="btn btn-primary" disabled={busy} onClick={() => void start()}>Продолжить с остановки</button>
          <button className="btn" disabled={busy} onClick={() => setStage('correct')}>Уточнить точку на остановке</button>
          <button className="btn" disabled={busy} onClick={() => void finish()}>Завершить поездку</button>
        </>}
        {stage === 'feedback' && <>
          <p>Насколько точно работала навигация?</p>
          <div>{[1, 2, 3, 4, 5].map((n) => <button className="btn" key={n} aria-label={`Оценка ${n} из 5`} aria-pressed={stars === n} onClick={() => setStars(n)}>{n <= stars ? '★' : '☆'}</button>)}</div>
          {ISSUES.map((issue) => <label key={issue}><input type="checkbox" checked={issues.includes(issue)} onChange={() => setIssues((old) => old.includes(issue) ? old.filter((v) => v !== issue) : [...old, issue])} /> {issue}</label>)}
          <input placeholder="Комментарий" value={comment} maxLength={1000} onChange={(e) => setComment(e.target.value)} />
          <button className="btn" onClick={() => setActual(api.current?.center?.())}>Указать фактический финиш под прицелом</button>
          {actual && estimate && <div>Оценка расхождения с точкой водителя · {Math.round(haversine(actual, estimate))} м</div>}
          <button className="btn btn-primary" onClick={() => void saveFeedback()}>{trip.current ? 'Сохранить и выйти' : 'Выйти без записи'}</button>
        </>}
        {stage === 'archive' && <>
          <label>Воспроизведение <select value={scenario} onChange={(e) => setScenario(e.target.value as GpsScenario)}>
            <option value="recorded">Как записано</option><option value="blackout">Потеря GPS</option><option value="frozen">Неподвижная ложная точка</option><option value="jump">Скачок координат</option><option value="smooth">Плавная ложная позиция</option>
          </select></label>
          {!archive.length && <p>Записей пока нет.</p>}
          {archive.map((entry) => <div key={entry.id}>
            <div>{new Date(entry.origin.at).toLocaleString()} · {entry.algorithm}</div>
            <button className="btn" onClick={() => compare(entry)}>Сравнить</button>
            <button className="btn" onClick={() => void tripSensors.exportTrip({ data: JSON.stringify(entry) }).catch(() => setMessage('Экспорт не удался'))}>Поделиться отчётом</button>
            <button className="btn" onClick={() => void deleteTrip(entry.id).then(openArchive).catch(() => setMessage('Удаление не удалось'))}>Удалить</button>
          </div>)}
          {result && <div style={{ whiteSpace: 'pre-line' }}>{result}</div>}
          <button className="btn" onClick={() => setStage('origin')}>Назад</button>
        </>}
      </div>
    </div>
  );
}
