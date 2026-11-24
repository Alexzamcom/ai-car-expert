import { useEffect, useRef, useState } from 'react';
import type { PluginListenerHandle } from '@capacitor/core';
import { autonomyMap } from '../lib/autonomy/map';
import { Estimator, type Estimate, type Fix, type Measurement, type Origin, type Variant } from '../lib/autonomy/estimator';
import { createTrip, deleteTrip, recentTrips, record, replay, saveTrip, type GpsScenario, type Trip } from '../lib/autonomy/trip';
import { tripSensors } from '../lib/autonomy/native';
import { cumulative, fetchRoute, haversine, routeProgress, stepOffsets, stepText, type LatLon, type Route } from '../lib/routing';
import { androidDriving, maneuverNotice } from '../lib/androidDriving';
import { closeHud, openHud } from '../lib/hud';
import { consistentPair, courseBetween, goodFix, roadAnchor } from '../lib/autonomy/gnss';
import { PlaceMapPicker } from '../components/PlaceMapPicker';
import { placesStore } from '../lib/places';
import { useStore } from '../lib/store';
import { offlineRegions, searchOfflineAddresses } from '../lib/offlineMaps';
import type { Place } from '../lib/geo/geocode';
import { navLang } from '../lib/nav';
import { settingsStore } from '../lib/state';
import { speak } from '../lib/speech';
import { MapLibreMap, type MapApi } from './MapLibreMap';

type Stage = 'origin' | 'destination' | 'ready' | 'driving' | 'paused' | 'correct' | 'feedback' | 'archive';
const ISSUES = ['Отставание', 'Забегание вперёд', 'Неправильный поворот', 'Съезд с дороги'];
const VARIANTS: Variant[] = ['inertial', 'road', 'hybrid'];
const MODES: Record<Variant, string> = { inertial: 'Инерциальный', road: 'С дорожной привязкой', hybrid: 'С относительным GPS', adaptive: 'Гибридный', gps: 'Обычный' };
const MAX_GUIDANCE_ERROR_M = 45;

export function AutonomousNavigation({ close }: { close(): void }) {
  const api = useRef<MapApi | null>(null);
  const ui = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<Stage>('origin');
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
  const accepting = useRef(false);
  const pending = useRef(Promise.resolve());
  const updateAt = useRef(0);
  const lastMotion = useRef(0);
  const stillSince = useRef<number | null>(null);
  const [stationary, setStationary] = useState(false);
  const cached = useRef<{ cum: number[]; offsets: number[] } | undefined>(undefined);
  const currentRoute = useRef<Route | null>(null);
  const segment = useRef(0);

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
    await Promise.allSettled([tripSensors.stop(), ...handles.map((listener) => listener.remove())]);
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

  useEffect(() => {
    const hide = () => {
      if (document.visibilityState !== 'visible') pause('Поездка приостановлена. После остановки уточните точку и направление.');
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
    return () => {
      document.removeEventListener('visibilitychange', hide);
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
      autonomyMap.set({ ...autonomyMap.get(), route: selected, destination: target, progress: null });
      setMessage('Маршрут перестроен');
    } catch (error) {
      if (!request.signal.aborted) setMessage(error instanceof Error ? error.message : 'Перестроение недоступно');
    } finally { if (routeAbort.current === request) routeAbort.current = null; }
  }

  async function selectDestination(target = api.current?.center?.()) {
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
      prepareRoute(selected, target);
      if (androidDriving && selected.coords.length <= 20_000) {
        try { localStorage.setItem('ace:offline-autonomy-route', JSON.stringify({ route: selected, destination: target, at: Date.now() })); } catch { /* Storage can be disabled. */ }
      }
    } catch (error) {
      if (!request.signal.aborted) setMessage(error instanceof Error ? error.message : 'Маршрут недоступен.');
    } finally {
      if (routeAbort.current === request) routeAbort.current = null;
      if (!request.signal.aborted) setBusy(false);
    }
  }

  async function start() {
    if (!origin || !route || busy) return;
    const gps = variant === 'adaptive' || variant === 'hybrid' || variant === 'gps';
    mode.current = variant;
    const first = !engine.current;
    if (first) {
      const anchor = { ...origin, at: Date.now() };
      engine.current = new Estimator(anchor, route.coords, variant);
      if (consent) trip.current = createTrip(anchor, route, variant);
    }
    engine.current?.setVariant(variant);
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
      await tripSensors.start({ gps, allowGpsOnly: variant === 'adaptive' || variant === 'gps' });
      if (!foreground.current || document.visibilityState !== 'visible') {
        await stopNative();
        return;
      }
      lastMotion.current = Date.now();
      accepting.current = true;
      setEstimate(engine.current?.state ?? null);
      setFollow(true);
      setStage('driving');
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
    const usedGps = mode.current !== 'road' && mode.current !== 'inertial';
    setVariant(next);
    mode.current = next;
    engine.current?.setVariant(next);
    if (engine.current) setEstimate(engine.current.state);
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
      {pointPicker && <PlaceMapPicker start={api.current?.center?.() ?? null} cancel={() => setPointPicker(false)}
        confirm={(point) => { setPointPicker(false); if (stage === 'destination') void selectDestination(point); else selectOrigin(point); }} />}
      {selecting && <div className="autonomy-crosshair" aria-hidden="true">⌖</div>}
      <div className={`autonomy-panel ${stage === 'driving' && !showTools ? 'autonomy-compact' : ''}`} ref={ui}>
        <strong>Навигация без GPS · эксперимент</strong>
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
          {modeSelect}
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
