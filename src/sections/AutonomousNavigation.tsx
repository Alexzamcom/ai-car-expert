import { useEffect, useRef, useState } from 'react';
import type { PluginListenerHandle } from '@capacitor/core';
import { autonomyMap } from '../lib/autonomy/map';
import { Estimator, type Estimate, type Measurement, type Origin, type Variant } from '../lib/autonomy/estimator';
import { createTrip, deleteTrip, recentTrips, record, replay, saveTrip, type GpsScenario, type Trip } from '../lib/autonomy/trip';
import { tripSensors } from '../lib/autonomy/native';
import { cumulative, fetchRoute, haversine, routeProgress, stepOffsets, stepText, type LatLon, type Route } from '../lib/routing';
import { MapLibreMap, type MapApi } from './MapLibreMap';

type Stage = 'origin' | 'destination' | 'ready' | 'driving' | 'paused' | 'correct' | 'feedback' | 'archive';
const ISSUES = ['Отставание', 'Забегание вперёд', 'Неправильный поворот', 'Съезд с дороги'];
const VARIANTS: Variant[] = ['inertial', 'road', 'hybrid'];
const MODES: Record<Variant, string> = { inertial: 'Инерциальный', road: 'С дорожной привязкой', hybrid: 'С относительным GPS' };
const MAX_GUIDANCE_ERROR_M = 45;

export function AutonomousNavigation({ close }: { close(): void }) {
  const api = useRef<MapApi | null>(null);
  const ui = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<Stage>('origin');
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [heading, setHeading] = useState('0');
  const [consent, setConsent] = useState(false);
  const [gps, setGps] = useState(false);
  const [follow, setFollow] = useState(true);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
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
      if (accepting.current && Date.now() - lastMotion.current > 2500) pause('Датчики перестали обновляться. После остановки уточните точку и направление.');
    }, 1000);
    const checkpoint = window.setInterval(() => void persist(), 30_000);
    document.addEventListener('visibilitychange', hide);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      clearInterval(health);
      clearInterval(checkpoint);
      routeAbort.current?.abort();
      foreground.current = false;
      void stopNative();
      void persist();
      autonomyMap.set({ position: null, route: null, destination: null, progress: null });
    };
  }, []);

  function selectOrigin() {
    const position = api.current?.center?.();
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
      void persist();
      setStage('paused');
    } else {
      autonomyMap.set({ position: new Estimator(anchor, [], 'road').state, route: null, destination: null, progress: null });
      setStage('destination');
    }
  }

  async function selectDestination() {
    const target = api.current?.center?.();
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
      setRoute(selected);
      const cum = cumulative(selected.coords);
      cached.current = { cum, offsets: stepOffsets(selected, cum) };
      currentRoute.current = selected;
      autonomyMap.set({ ...autonomyMap.get(), route: selected, destination: target });
      api.current?.fitPoints(selected.coords, ui.current);
      setStage('ready');
    } catch {
      if (!request.signal.aborted) setMessage('Маршрут недоступен. Для его построения нужны сеть и работающий маршрутизатор.');
    } finally { if (!request.signal.aborted) setBusy(false); }
  }

  async function start() {
    if (!origin || !route || busy) return;
    const variant = gps ? 'hybrid' : 'road';
    const first = !engine.current;
    if (first) {
      const anchor = { ...origin, at: Date.now() };
      engine.current = new Estimator(anchor, route.coords, variant);
      if (consent) trip.current = createTrip(anchor, route, variant);
    }
    setBusy(true);
    setMessage('');
    foreground.current = true;
    try {
      listeners.current.push(await tripSensors.addListener('motion', (sample) => accepting.current && update({ type: 'motion', sample })));
      listeners.current.push(await tripSensors.addListener('gps', (sample) => accepting.current && update({ type: 'gps', sample: { ...sample, speed: sample.speed ?? null } })));
      listeners.current.push(await tripSensors.addListener('failure', ({ message: reason }) => pause(reason)));
      if (!foreground.current) {
        await stopNative();
        return;
      }
      await tripSensors.start({ gps });
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

  async function finish() {
    setBusy(true);
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
  const step = progress && route?.steps[progress.stepIndex];
  return (
    <div className="navigation">
      <MapLibreMap apiRef={api} uiEl={ui} autonomous follow={stage === 'driving' && follow} guiding={stage === 'driving'} onUserMove={() => setFollow(false)} />
      {selecting && <div className="autonomy-crosshair" aria-hidden="true">⌖</div>}
      <div className="autonomy-panel" ref={ui}>
        <strong>Навигация без GPS · эксперимент</strong>
        {message && <div role="status">{message}</div>}
        {(stage === 'origin' || stage === 'correct') && <>
          <p>Только после остановки. Переместите карту, чтобы поставить прицел на нужную полосу.</p>
          <label>Курс автомобиля · север 0°, восток 90° <input type="number" min="0" max="359" value={heading} onChange={(e) => setHeading(e.target.value)} /></label>
          <button className="btn btn-primary" onClick={selectOrigin}>{stage === 'correct' ? 'Подтвердить коррекцию' : 'Установить автомобиль'}</button>
        </>}
        {stage === 'origin' && <><button className="btn" onClick={() => void openArchive()}>Записи поездок</button><button className="btn" onClick={close}>Назад</button></>}
        {stage === 'destination' && <>
          <p>Поставьте прицел на пункт назначения.</p>
          <button className="btn btn-primary" disabled={busy} onClick={() => void selectDestination()}>Построить маршрут сюда</button>
          <button className="btn" disabled={busy} onClick={() => setStage('origin')}>Изменить старт</button>
        </>}
        {stage === 'ready' && <>
          <p>Начните с полной остановки. Закрепите телефон и первые секунды плавно разгоняйтесь по прямой для калибровки.</p>
          <label><input type="checkbox" checked={gps} onChange={(e) => setGps(e.target.checked)} /> Разрешить относительные GPS-измерения</label>
          <label><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Записать поездку локально, включая координаты GPS при включённом GPS</label>
          <button className="btn btn-primary" disabled={busy} onClick={() => void start()}>Начать поездку без GPS</button>
          <button className="btn" disabled={busy} onClick={close}>Отмена</button>
        </>}
        {stage === 'driving' && estimate && <>
          <div>Оценка скорости {Math.round(estimate.speed * 3.6)} км/ч · неопределённость около {Math.ceil(estimate.uncertainty)} м</div>
          <div>GPS { { disabled: 'выключен', waiting: 'не используется', rejected: 'отклонён', relative: 'относительная помощь' }[estimate.gps] }</div>
          {trip.current?.truncated && <div>Достигнут предел записи.</div>}
          {step ? <div>Предполагаемый манёвр · {stepText(step)} · около {Math.round(progress.toStepM)} м</div>
            : <div>Недостаточно уверенности для указаний о повороте.</div>}
          {!follow && <button className="btn" onClick={() => setFollow(true)}>К машине</button>}
          <button className="btn" disabled={!stationary} onClick={() => { pause('Подтвердите точку только на остановке.'); setStage('correct'); setHeading(String(Math.round(estimate.heading) % 360)); }}>Уточнить после остановки</button>
          <button className="btn" onClick={() => pause('Для коррекции и возобновления дождитесь полной остановки.')}>Пауза</button>
          <button className="btn" disabled={busy} onClick={() => void finish()}>Завершить поездку</button>
        </>}
        {stage === 'paused' && <>
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
            <button className="btn" onClick={() => void tripSensors.exportTrip({ data: JSON.stringify(entry) }).catch(() => setMessage('Экспорт не удался'))}>Экспорт</button>
            <button className="btn" onClick={() => void deleteTrip(entry.id).then(openArchive).catch(() => setMessage('Удаление не удалось'))}>Удалить</button>
          </div>)}
          {result && <div style={{ whiteSpace: 'pre-line' }}>{result}</div>}
          <button className="btn" onClick={() => setStage('origin')}>Назад</button>
        </>}
      </div>
    </div>
  );
}
