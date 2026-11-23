/* HUD — проекция навигации на лобовое стекло (iPad/телефон под стеклом, изображение отражается).
   Пользуется тем же ведением, что и карта: GPS, маршрут, перестроение, голос и кнопка звука — общие.
   Отрисовывает только упрощённую картинку: чёрный фон, яркие линии, крупные символы. */
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { geoStore, navStore, navLang, setNavigationVoice, readNavSession, visibleRouteCoords } from '../lib/nav';
import { settingsStore } from '../lib/state';
import { themeStore } from '../lib/theme';
import { setKeepAwake } from '../lib/wakeLock';
import { stepIcon, stepText, fmtDistance, fmtDuration, type LatLon, type Route } from '../lib/routing';
import { unwrapAngle } from '../lib/carMarker';
import {
  hudSettingsStore,
  hudUiStore,
  closeHud,
  HUD_MODES,
  HUD_COLORS,
  HUD_LOOKS,
  hudAppearance,
  hudShowsSpeed,
  reliableSpeed,
  hudRangeM,
  routeInCarFrame,
  toCarFrame,
  type HudMode,
  type HudColor,
  type HudLook,
} from '../lib/hud';
import { Icon } from '../components/Icon';
import '../styles/hud.css';
import { androidDriving, maneuverNotice } from '../lib/androidDriving';
import { Capacitor } from '@capacitor/core';
import { autonomyMap } from '../lib/autonomy/map';
import { tripSensors } from '../lib/autonomy/native';
import { displayStore } from '../lib/matching/display';

const HudMap = lazy(() => import('./HudMap').then((m) => ({ default: m.HudMap })));

const eta = (sec: number) => new Date(Date.now() + sec * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

export function Hud({ autonomous = false }: { autonomous?: boolean }) {
  const ui = useStore(hudUiStore);
  const s = useStore(hudSettingsStore);
  const nav = useStore(navStore);

  // Маршрут завершён или сброшен (и восстанавливать нечего) — HUD закрывается сам, карта возвращается.
  useEffect(() => {
    if (!autonomous && ui.active && nav.status === 'idle' && !readNavSession()) closeHud();
  }, [autonomous, ui.active, nav.status]);

  // Экран не гаснет — по возможности (Wake Lock); гарантировать это веб-приложение не может.
  useEffect(() => {
    if (!ui.active) return;
    setKeepAwake(true);
    const native = Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('TripSensors');
    if (native) void tripSensors.setHudAwake({ enabled: true }).catch(() => {});
    return () => {
      if (native) void tripSensors.setHudAwake({ enabled: false }).catch(() => {});
      setKeepAwake(settingsStore.get().keepAwake);
    };
  }, [ui.active]);

  useEffect(() => {
    document.documentElement.classList.toggle('hud-on', ui.active);
  }, [ui.active]);

  if (!ui.active) return null;
  if (!s.warned) return <HudWarning />;
  return <HudScreen autonomous={autonomous} />;
}

/** Первое включение: безопасность и ограничения. */
function HudWarning() {
  return (
    <div className="hud hud-warning" role="dialog" aria-modal="true" aria-label="HUD: перед первым включением">
      <div className="hud-warning-card">
        <h2>
          <Icon name="alert" /> HUD — перед первым включением
        </h2>
        <ul>
          <li>Положите устройство устойчиво, вне зоны подушек безопасности и так, чтобы оно не закрывало обзор и не съезжало при торможении.</li>
          <li>Настраивайте HUD только на стоянке. За рулём — только взгляд на дорогу.</li>
          <li>На многослойном лобовом стекле изображение двоится (два отражения) — это свойство стекла. Помогает режим «Минимальный» и крупный масштаб.</li>
          <li>Днём на солнце отражение почти не видно; HUD рассчитан на сумерки и ночь.</li>
          <li>Системную яркость экрана приложение менять не может — уменьшите её сами. Яркость оформления HUD регулируется в настройках.</li>
          <li>Не выключать экран приложение может только «по возможности»: на части iPhone и iPad экран всё равно может погаснуть. Следите за нагревом устройства под стеклом.</li>
        </ul>
        <div className="hud-warning-actions">
          <button className="btn btn-lg" onClick={closeHud}>
            Отмена
          </button>
          <button className="btn btn-lg btn-primary" onClick={() => hudSettingsStore.set((x) => ({ ...x, warned: true }))}>
            Понятно, включить HUD
          </button>
        </div>
      </div>
    </div>
  );
}

function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

function HudScreen({ autonomous }: { autonomous: boolean }) {
  const s = useStore(hudSettingsStore);
  const ordinary = useStore(navStore);
  const experiment = useStore(autonomyMap);
  const nav = autonomous ? { ...ordinary, route: experiment.route, progress: experiment.progress,
    status: 'guiding', rerouting: false } : ordinary;
  const geo = useStore(geoStore);
  const voiceOn = useStore(settingsStore).speakNavigation;
  const [controls, setControls] = useState(false);
  const hideTimer = useRef(0);
  useTick(1000); // свежесть скорости и время прибытия
  const lang = navLang();
  // Оформление: ночью в «Авто» — прежняя палитра без изменений; днём — дневная; «Ручной» — свои цвета и размеры.
  const dark = useStore(themeStore).active === 'night';
  const look = hudAppearance(s, dark);
  const color = look.arrows;
  const manual = look.palette === 'manual';

  const showControls = () => {
    setControls(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setControls(false), 6000);
  };
  useEffect(() => () => clearTimeout(hideTimer.current), []);
  const set = (patch: Partial<typeof s>) => {
    hudSettingsStore.set((x) => ({ ...x, ...patch }));
    showControls();
  };

  const reliable = autonomous ? (experiment.position?.uncertainty ?? Infinity) <= 45 :
    reliableSpeed(geo) != null || !!(geo.updated && Date.now() - geo.updated < 3500 && !geo.held && (geo.accuracy ?? Infinity) <= 50);
  const cue = androidDriving && nav.status === 'guiding' ? maneuverNotice(nav.route, nav.progress,
    autonomous ? (experiment.position?.speed ?? 0) * 3.6 : geo.speedKmh, reliable && (nav.progress?.offRouteM ?? Infinity) <= 35) : null;
  const step = androidDriving ? cue?.step : nav.route && nav.progress ? nav.route.steps[nav.progress.stepIndex] : null;
  const remainingS = nav.route && nav.progress ? nav.route.duration * (nav.progress.remainingM / Math.max(1, nav.route.distance)) : null;
  const position = experiment.position;
  const speed = autonomous ? position && position.uncertainty <= 120 ? Math.round(position.speed * 3.6) : null : reliableSpeed(geo);
  const withSpeed = autonomous || androidDriving || hudShowsSpeed(s.mode, s);
  const arrived = nav.status === 'arrived';
  const status = nav.rerouting ? 'Перестраиваю маршрут…' : nav.status === 'routing' ? 'Восстанавливаю маршрут…' : arrived ? 'Вы прибыли' : !nav.route ? 'Нет маршрута' : autonomous && !nav.progress ? 'Положение уточняется' : null;

  const maneuver = step && nav.progress && !arrived && (
    <div className={`hud-maneuver ${cue?.urgent ? 'is-urgent' : ''}`}>
      <Icon name={stepIcon(step)} size="1em" stroke={2.6} />
      <div>
        <div className="hud-dist">{androidDriving && cue ? cue.distance == null ? 'Уточняем' : cue.distance < 10 ? 'Сейчас' : fmtDistance(cue.distance, lang) : fmtDistance(nav.progress.toStepM, lang)}</div>
        {s.mode !== 'minimal' && <div className="hud-instr">{stepText(step, lang)}</div>}
      </div>
    </div>
  );
  const etaRow = s.showEta && remainingS != null && nav.progress && !arrived && (
    <div className="hud-eta">
      <strong>{eta(remainingS)}</strong>
      <span>
        {fmtDistance(nav.progress.remainingM, lang)} · {fmtDuration(remainingS, lang)}
      </span>
    </div>
  );
  const speedEl = withSpeed && (
    <div className={`hud-speed ${speed == null ? 'is-unknown' : ''}`} aria-label={speed == null ? 'Скорость: данных недостаточно' : `Скорость ${speed} км/ч`}>
      <strong>{speed ?? '—'}</strong>
      <span>км/ч</span>
    </div>
  );

  return (
    <div
      className={`hud mode-${s.mode} contrast-${look.contrast}`}
      style={{
        ['--hud-color' as string]: color,
        ['--hud-digits' as string]: look.digits,
        ['--hud-scale' as string]: String(look.arrowsScale),
        ['--hud-scale-num' as string]: String(look.digitsScale),
      }}
      data-mode={s.mode}
      data-palette={look.palette}
      data-mirror={s.mirror ? '1' : '0'}
      onClick={showControls}
    >
      <div className={`hud-stage ${s.mirror ? 'is-mirrored' : ''}`} style={{ opacity: androidDriving && look.palette === 'day' ? s.brightness : look.brightness }} data-testid="hud-stage">
        {!autonomous && s.mode === 'map' ? (
          <Suspense fallback={null}>
            <HudMap color={color} />
          </Suspense>
        ) : !autonomous && s.mode !== 'minimal' ? (
          <HudRoute route={nav.route} color={color} />
        ) : null}
        <div className="hud-layer">
          <div className="hud-top">{status ? <div className="hud-status">{status}</div> : maneuver}{autonomous && position && <div className="hud-status">±{Math.ceil(position.uncertainty)} м</div>}</div>
          {s.mode === 'minimal' && !status && step && <div className="hud-big-arrow" aria-hidden="true"><Icon name={stepIcon(step)} size="1em" stroke={2.4} /></div>}
          <div className="hud-bottom">
            {etaRow || <span />}
            {speedEl}
          </div>
        </div>
      </div>

      {/* Управление — не зеркалится: читается на самом устройстве. Выход — одно касание. */}
      <button
        className="hud-exit"
        onClick={(e) => {
          e.stopPropagation();
          closeHud();
        }}
        aria-label="Выйти из HUD"
      >
        <Icon name="close" size="1.6rem" />
      </button>
      {controls && (
        <div className="hud-controls" onClick={(e) => (e.stopPropagation(), showControls())} role="toolbar" aria-label="Настройки HUD">
          <div className="hud-chips">
            {!autonomous && HUD_MODES.map((m) => (
              <button key={m.id} className={`hud-chip ${s.mode === m.id ? 'is-active' : ''}`} onClick={() => set({ mode: m.id as HudMode })} aria-pressed={s.mode === m.id}>
                {m.label}
              </button>
            ))}
          </div>
          <div className="hud-chips">
            <button className={`hud-chip ${s.mirror ? 'is-active' : ''}`} onClick={() => set({ mirror: !s.mirror })} aria-pressed={s.mirror}>
              <Icon name="swap" /> Зеркально
            </button>
            {!autonomous && <button className="hud-chip" onClick={() => setNavigationVoice(!voiceOn)} aria-pressed={!voiceOn} aria-label={voiceOn ? 'Выключить голосовые подсказки' : 'Включить голосовые подсказки'}>
              <Icon name={voiceOn ? 'speaker' : 'speakerOff'} /> {voiceOn ? 'Звук' : 'Без звука'}
            </button>}
            {/* Яркость и цвет: в «Ручном» — ручной палитры, иначе — обычной (ночной), как раньше. Дневная палитра фиксирована. */}
            <button
              className="hud-chip"
              onClick={() => (manual ? set({ manual: { ...s.manual, brightness: Math.max(0.3, +(look.brightness - 0.1).toFixed(2)) } }) : set({ brightness: Math.max(0.3, +(s.brightness - 0.1).toFixed(2)) }))}
              aria-label="Темнее"
            >
              <Icon name="moon" /> −
            </button>
            <button
              className="hud-chip"
              onClick={() => (manual ? set({ manual: { ...s.manual, brightness: Math.min(1, +(look.brightness + 0.1).toFixed(2)) } }) : set({ brightness: Math.min(1, +(s.brightness + 0.1).toFixed(2)) }))}
              aria-label="Ярче"
            >
              <Icon name="sun" /> +
            </button>
            {(Object.keys(HUD_COLORS) as HudColor[]).map((c) => {
              const active = manual ? s.manual.arrows === HUD_COLORS[c][1] : s.color === c;
              return (
                <button
                  key={c}
                  className={`hud-swatch ${active ? 'is-active' : ''}`}
                  style={{ background: HUD_COLORS[c][1] }}
                  onClick={() => (manual ? set({ manual: { ...s.manual, arrows: HUD_COLORS[c][1] } }) : set({ color: c }))}
                  aria-label={`Цвет: ${HUD_COLORS[c][0]}`}
                  aria-pressed={active}
                />
              );
            })}
          </div>
          <div className="hud-chips" role="radiogroup" aria-label="Палитра HUD">
            {HUD_LOOKS.map((l) => (
              <button key={l.id} role="radio" className={`hud-chip ${s.look === l.id ? 'is-active' : ''}`} onClick={() => set({ look: l.id as HudLook })} aria-checked={s.look === l.id}>
                {l.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- Упрощённая движущаяся карта (режимы «Маршрут» и «Маршрут + скорость») ---------- */

const CAR_Y = 0.8; // машинка — внизу экрана

/** Маршрут в координатах автомобиля: впереди — вверх. SVG обновляется в requestAnimationFrame без перерисовки React. */
function HudRoute({ route, color }: { route: Route | null; color: string }) {
  const svg = useRef<SVGSVGElement>(null);
  const road = useRef<SVGPathElement>(null);
  const line = useRef<SVGPathElement>(null);
  const turn = useRef<SVGCircleElement>(null);
  const carG = useRef<SVGGElement>(null);
  const routeRef = useRef(route);
  routeRef.current = route;

  useEffect(() => {
    let from: LatLon | null = null;
    let to: LatLon | null = null;
    let t0 = 0;
    let heading: number | null = null;
    let headingShown = 0;
    let range = 300;
    let last = '';
    const onGeo = () => {
      const g = displayStore.get(); // отображаемая позиция (привязка к дороге)
      if (g.lat == null || g.lon == null) return;
      const fix = geoStore.get();
      if (androidDriving && !to && (fix.held || (fix.accuracy ?? Infinity) > 50 || Date.now() - (fix.updated ?? 0) > 5000)) return;
      if (to && to.lat === g.lat && to.lon === g.lon && heading === g.heading) return;
      const now = performance.now();
      from = pos(now) ?? { lat: g.lat, lon: g.lon };
      to = { lat: g.lat, lon: g.lon };
      t0 = now;
      if (g.heading != null) {
        if (heading == null) headingShown = g.heading;
        heading = g.heading;
      }
    };
    const pos = (now: number): LatLon | null => {
      if (!to) return null;
      if (!from) return to;
      const k = Math.min(1, (now - t0) / 1000);
      return { lat: from.lat + (to.lat - from.lat) * k, lon: from.lon + (to.lon - from.lon) * k };
    };
    onGeo();
    const unsub = displayStore.subscribe(onGeo);
    let raf = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const r = routeRef.current;
      const car = pos(now);
      const box = svg.current?.getBoundingClientRect();
      if (!r || !car || !box || !box.width) return;
      if (heading != null) {
        const target = unwrapAngle(headingShown, heading);
        headingShown += Math.max(-5, Math.min(5, (target - headingShown) * 0.12));
      }
      const p = navStore.get().progress;
      const want = hudRangeM(geoStore.get().speedKmh, p?.toStepM ?? null);
      range += (want - range) * 0.04;
      const h = ((headingShown % 360) + 360) % 360;
      const scale = (box.height * CAR_Y * 0.92) / range; // px на метр
      const cx = box.width / 2;
      const cy = box.height * CAR_Y;
      const coords = visibleRouteCoords();
      const ahead = routeInCarFrame(coords, 0, car, h, range);
      const xy = ([x, y]: [number, number]) => `${(cx + x * scale).toFixed(1)} ${(cy - y * scale).toFixed(1)}`;
      const d = ahead.length >= 2 ? `M ${ahead.map(xy).join(' L ')}` : '';
      const step = p ? r.steps[p.stepIndex] : null;
      const tp = step ? toCarFrame(step.location, car, h) : null;
      const key = d + (tp ? tp.join() : '');
      if (key === last) return;
      last = key;
      line.current?.setAttribute('d', d);
      carG.current?.setAttribute('transform', `translate(${cx.toFixed(1)} ${cy.toFixed(1)})`);
      carG.current?.removeAttribute('visibility');
      road.current?.setAttribute('d', d);
      if (turn.current) {
        turn.current.style.display = tp && Math.hypot(tp[0], tp[1]) < range * 1.6 && step?.type !== 'depart' ? '' : 'none';
        if (tp) {
          turn.current.setAttribute('cx', (cx + tp[0] * scale).toFixed(1));
          turn.current.setAttribute('cy', (cy - tp[1] * scale).toFixed(1));
        }
      }
      (window as unknown as { __aceHud?: unknown }).__aceHud = { mode: 'route', heading: h, range, points: ahead.length, first: coords[0] ? [coords[0].lon, coords[0].lat] : null };
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      unsub();
    };
  }, []);

  return (
    <svg ref={svg} className="hud-route" aria-hidden="true">
      <path ref={road} className="hud-road" fill="none" stroke={color} />
      <path ref={line} className="hud-line" fill="none" stroke={color} />
      <circle ref={turn} className="hud-turn" r="9" fill="#000" stroke={color} />
      <g ref={carG} className="hud-car" visibility={androidDriving ? "hidden" : undefined}>
        <path d="M0 -22 L15 16 L0 8 L-15 16 Z" fill={color} />
      </g>
    </svg>
  );
}
