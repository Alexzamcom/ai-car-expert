/* Прототип навигации на MapLibre GL: карта по движению, наклон 3D, векторные тайлы OpenFreeMap (бесплатно, без ключа).
   Рабочую навигацию (Leaflet) не заменяет. Использует общие модули приложения: фильтр GPS и курс, камеру, машинку, тему,
   маршрут и голосовые подсказки — та же логика, другой движок отрисовки.
   ?sim=1 — демонстрационная поездка (без GPS); ?style=<url> — другой стиль; ?hud=1 — счётчик кадров. */
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, Map as MlMap, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import '../styles/global.css';
import './lab.css';
import { startTheme, themeStore, THEMES } from '../lib/theme';
import { settingsStore } from '../lib/state';
import { carSvg, unwrapAngle } from '../lib/carMarker';
import { followZoom, lookAheadOffset, CAMERA_MODE_LABEL, type CameraMode } from '../lib/camera';
import { updateHeading, type HeadingState, geoStore, navStore, startGeo, restartGeo, restoreNavSession, setNavigationVoice, navLang, readLastPos } from '../lib/nav';
import { stepText, stepIcon, fmtDistance, fmtDuration, haversine, type LatLon } from '../lib/routing';
import { DEMO_ROUTE, demoFix, pointAt } from './demo';

maplibregl.setWorkerUrl(workerUrl);
startTheme();

const params = new URLSearchParams(location.search);
const SIM = params.has('sim');
const STYLE_URL = params.get('style') ?? 'https://tiles.openfreemap.org/styles/positron';
const PITCH = 50;

/* ---------- Разметка ---------- */
const root = document.getElementById('lab')!;
root.innerHTML = `
  <div id="map" class="lab-map"></div>
  <div class="lab-top">
    <a class="lab-back" href="./" aria-label="Вернуться в приложение">‹</a>
    <div class="lab-maneuver" role="status"><div class="lab-man-dist"></div><div class="lab-man-text"></div></div>
  </div>
  <div class="lab-hud" hidden></div>
  <div class="lab-bottom">
    <button class="lab-follow btn btn-primary" hidden>Следовать</button>
    <div class="lab-bar">
      <div class="lab-eta"><strong></strong><span></span></div>
      <div class="lab-modes" role="radiogroup" aria-label="Ориентация карты">
        <button data-mode="course" role="radio">${CAMERA_MODE_LABEL.course}</button>
        <button data-mode="north" role="radio">${CAMERA_MODE_LABEL.north}</button>
      </div>
      <button class="lab-voice" aria-label="Голосовые подсказки"></button>
    </div>
  </div>`;
const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;

/* ---------- Карта ---------- */
const start = SIM ? DEMO_ROUTE[0] : (readLastPos() ?? DEMO_ROUTE[0]);
const map: MlMap = new maplibregl.Map({
  container: 'map',
  style: STYLE_URL,
  center: [start.lon, start.lat],
  zoom: 16,
  pitch: 0,
  attributionControl: { compact: true },
  maxPitch: 70,
  fadeDuration: 150,
});

/** Ночь: та же векторная карта в тёмной палитре (меняем цвета слоёв, данные не трогаем). */
function nightPalette(style: StyleSpecification) {
  for (const l of style.layers) {
    const id = l.id;
    const paint = ((l as { paint?: Record<string, unknown> }).paint ??= {});
    if (l.type === 'background') paint['background-color'] = '#0b0f14';
    else if (l.type === 'fill') paint['fill-color'] = /water/.test(id) ? '#0f1b27' : /park|wood|grass|landcover|landuse/.test(id) ? '#10171c' : /building/.test(id) ? '#161d25' : '#0e1318';
    else if (l.type === 'line') {
      if (/water|river|stream|canal/.test(id)) paint['line-color'] = '#0f1b27';
      else if (/casing/.test(id)) paint['line-color'] = '#0b0f14';
      else if (/boundary|admin/.test(id)) paint['line-color'] = '#2b3440';
      else if (/motorway|trunk|primary/.test(id)) paint['line-color'] = '#3b4654';
      else paint['line-color'] = '#262e37';
    } else if (l.type === 'symbol') {
      paint['text-color'] = '#8d99a8';
      paint['text-halo-color'] = '#0b0f14';
    }
  }
  return style;
}

function routeCoords(): LatLon[] {
  if (SIM) return DEMO_ROUTE;
  return navStore.get().route?.coords ?? [];
}

function addRoute() {
  const t = THEMES[themeStore.get().active];
  const data = { type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: routeCoords().map((c) => [c.lon, c.lat]) } };
  if (map.getSource('route')) (map.getSource('route') as GeoJSONSource).setData(data);
  else {
    map.addSource('route', { type: 'geojson', data });
    const before = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
    map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': t['route-casing'], 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 6, 18, 22] } }, before);
    map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': t.route, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 4, 18, 15] } }, before);
  }
  map.setPaintProperty('route-casing', 'line-color', t['route-casing']);
  map.setPaintProperty('route-line', 'line-color', t.route);
}

/** Тема: для ночи — тот же стиль в тёмной палитре. */
function applyTheme() {
  const night = themeStore.get().active === 'night';
  map.setStyle(STYLE_URL, { diff: false, transformStyle: (_prev, next) => (night ? nightPalette(structuredClone(next)) : next) });
}
map.on('style.load', addRoute);
let themeApplied = themeStore.get().active;
if (themeApplied === 'night') applyTheme();
themeStore.subscribe(() => {
  if (themeStore.get().active === themeApplied) return;
  themeApplied = themeStore.get().active;
  applyTheme();
});
navStore.subscribe(() => map.isStyleLoaded() && addRoute());

/* ---------- Машинка ---------- */
const carEl = document.createElement('div');
carEl.className = 'lab-car';
const paintCar = () => (carEl.innerHTML = carSvg(settingsStore.get().carColor, 34));
paintCar();
settingsStore.subscribe(paintCar);
// rotationAlignment 'map': поворот задаётся курсом относительно севера, карта поворачивается сама — без двойного вращения.
const carMarker = new maplibregl.Marker({ element: carEl, rotationAlignment: 'map', pitchAlignment: 'map' });

/* ---------- Камера ---------- */
let mode: CameraMode = 'course';
let lastAuto: CameraMode = 'course';
let userZoom = false;

function setMode(m: CameraMode) {
  mode = m;
  if (m !== 'free') {
    lastAuto = m;
    userZoom = false;
  }
  root.querySelectorAll<HTMLButtonElement>('.lab-modes button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
  $('.lab-follow').hidden = m !== 'free';
  if (m !== 'free') follow(true);
}
root.querySelectorAll<HTMLButtonElement>('.lab-modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode as CameraMode)));
$('.lab-follow').addEventListener('click', () => setMode(lastAuto));
// Жест пользователя (сдвиг, поворот двумя пальцами, наклон) — свободный обзор до нажатия «Следовать».
for (const ev of ['dragstart', 'rotatestart', 'pitchstart'] as const) map.on(ev, (e) => (e as { originalEvent?: Event }).originalEvent && mode !== 'free' && setMode('free'));
map.on('zoomstart', (e) => (e as { originalEvent?: Event }).originalEvent && (userZoom = true));
// Пока пальцы на карте, автоматическая камера не двигается — иначе она перебивает жест пользователя.
let touching = 0;
const canvasBox = map.getCanvasContainer();
canvasBox.addEventListener('touchstart', (e) => (touching = e.touches.length), { passive: true });
canvasBox.addEventListener('touchend', (e) => (touching = e.touches.length), { passive: true });
canvasBox.addEventListener('touchcancel', () => (touching = 0), { passive: true });

/* ---------- Плавное движение машинки между точками GPS (раз в ~1 с) ---------- */
let from: LatLon | null = null;
let to: LatLon | null = null;
let t0 = 0;
let dur = 1000;
let headingShown = 0;
let headingTarget: number | null = null;
let speedKmh: number | null = null;
let zoomBandShown: number | null = null;

function carPos(now: number): LatLon | null {
  if (!to) return null;
  if (!from) return to;
  const k = Math.min(1, (now - t0) / dur);
  return { lat: from.lat + (to.lat - from.lat) * k, lon: from.lon + (to.lon - from.lon) * k };
}

function follow(immediate = false) {
  if (!to || mode === 'free' || touching > 0) return;
  const size = map.getContainer().getBoundingClientRect();
  const course = mode === 'course';
  const heading = headingTarget ?? map.getBearing();
  const band = followZoom(speedKmh);
  const zoom = userZoom ? map.getZoom() : band;
  zoomBandShown = band;
  // По движению: машинка в нижней трети, карта повёрнута по курсу. Север сверху: упреждение по ходу движения.
  const offset: [number, number] = course ? [0, size.height * 0.24] : (lookAheadOffset(heading, size.width, size.height).map((v) => -v) as [number, number]);
  map.easeTo({
    center: [to.lon, to.lat],
    bearing: course ? heading : 0,
    pitch: course ? PITCH : 0,
    zoom,
    offset,
    duration: immediate ? 600 : dur,
    easing: (x) => x,
    essential: true,
  });
}

function onFix(pos: LatLon, heading: number | null, speed: number | null) {
  const now = performance.now();
  from = carPos(now) ?? pos;
  to = pos;
  t0 = now;
  speedKmh = speed;
  if (heading != null) headingTarget = heading;
  if (!carMarker.getLngLat?.() || !(carMarker as unknown as { _map?: unknown })._map) carMarker.setLngLat([pos.lon, pos.lat]).addTo(map);
  follow();
}

/* ---------- Кадры: машинка, курс, счётчик производительности ---------- */
const frames: number[] = [];
let lastFrame = performance.now();
function frame(now: number) {
  frames.push(now - lastFrame);
  if (frames.length > 600) frames.shift();
  lastFrame = now;
  const p = carPos(now);
  if (p) carMarker.setLngLat([p.lon, p.lat]);
  if (headingTarget != null) {
    // Поворот машинки — по кратчайшей дуге и с ограниченной скоростью: без рывков и «кувырков».
    const target = unwrapAngle(headingShown, headingTarget);
    headingShown += Math.max(-6, Math.min(6, (target - headingShown) * 0.15));
    carMarker.setRotation(headingShown);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function stats() {
  const recent = frames.slice(-300).filter((f) => f > 0 && f < 1000);
  const avg = recent.reduce((a, b) => a + b, 0) / Math.max(1, recent.length);
  const sorted = [...recent].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  return { fps: avg ? Math.round(1000 / avg) : 0, p95ms: Math.round(p95), longFrames: recent.filter((f) => f > 50).length, frames: recent.length };
}
if (params.has('hud')) {
  const hud = $('.lab-hud');
  hud.hidden = false;
  setInterval(() => {
    const s = stats();
    hud.textContent = `${s.fps} к/с · p95 ${s.p95ms} мс · ${CAMERA_MODE_LABEL[mode]} · ${Math.round(map.getBearing())}°`;
  }, 500);
}

/* ---------- Голос и нижняя полоса ---------- */
const voiceBtn = $('.lab-voice');
const paintVoice = () => {
  const on = settingsStore.get().speakNavigation;
  voiceBtn.classList.toggle('is-muted', !on);
  voiceBtn.setAttribute('aria-pressed', String(!on));
  voiceBtn.innerHTML = on
    ? '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></svg>'
    : '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 9l5 6M21 9l-5 6"/></svg>';
};
paintVoice();
settingsStore.subscribe(paintVoice);
voiceBtn.addEventListener('click', () => setNavigationVoice(!settingsStore.get().speakNavigation));

function paintInfo(remainingM: number | null, remainingS: number | null, maneuver: { dist: string; text: string } | null) {
  $('.lab-eta strong').textContent = remainingS != null ? new Date(Date.now() + remainingS * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—';
  $('.lab-eta span').textContent = remainingM != null && remainingS != null ? `${fmtDistance(remainingM)} · ${fmtDuration(remainingS)}` : SIM ? 'Демонстрация' : 'Постройте маршрут в приложении';
  $('.lab-man-dist').textContent = maneuver?.dist ?? '';
  $('.lab-man-text').textContent = maneuver?.text ?? (SIM ? 'Демонстрационная поездка · центр Киева' : 'Ожидаю GPS и маршрут…');
}

/* ---------- Источник позиции ---------- */
let hs: HeadingState = { heading: null, anchor: null, at: null };
if (SIM) {
  const total = DEMO_ROUTE.slice(1).reduce((a, c, i) => a + haversine(DEMO_ROUTE[i], c), 0);
  const t0sim = Date.now();
  let i = 0;
  const tick = () => {
    const f = demoFix(i, { start: t0sim });
    const road = pointAt(DEMO_ROUTE, i * (45 / 3.6));
    hs = updateHeading(hs, f, { bearing: road.bearing, offRouteM: 3 });
    onFix({ lat: f.lat, lon: f.lon }, hs.heading, 45);
    const left = Math.max(0, total - i * (45 / 3.6));
    paintInfo(left, left / (45 / 3.6), { dist: '', text: 'Демонстрационная поездка · центр Киева' });
    i = f.done ? 0 : i + 1;
  };
  map.once('load', () => {
    tick();
    setInterval(tick, 1000);
  });
} else {
  startGeo();
  restoreNavSession();
  geoStore.subscribe(() => {
    const g = geoStore.get();
    if (g.lat == null || g.lon == null) return;
    if (to && to.lat === g.lat && to.lon === g.lon) return;
    onFix({ lat: g.lat, lon: g.lon }, g.heading, g.speedKmh);
    const n = navStore.get();
    const p = n.progress;
    const step = n.route && p ? n.route.steps[p.stepIndex] : null;
    const remainS = n.route && p ? n.route.duration * (p.remainingM / Math.max(1, n.route.distance)) : null;
    paintInfo(p?.remainingM ?? null, remainS, step && p ? { dist: fmtDistance(p.toStepM, navLang()), text: `${stepText(step, navLang())}` } : null);
    void stepIcon;
  });
  // Возврат из другого приложения: свежая позиция и камера.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      restartGeo();
      follow(true);
    }
  });
}
setMode('course');

/* Для автоматических проверок и замеров. */
declare global {
  interface Window {
    __lab: unknown;
  }
}
window.__lab = {
  stats,
  setMode,
  state: () => {
    const p = to ? map.project([to.lon, to.lat]) : null;
    const r = map.getContainer().getBoundingClientRect();
    return { mode, bearing: map.getBearing(), pitch: map.getPitch(), heading: headingTarget, carShown: headingShown, car: p ? { x: p.x / r.width, y: p.y / r.height } : null, zoomBand: zoomBandShown };
  },
  map,
};
