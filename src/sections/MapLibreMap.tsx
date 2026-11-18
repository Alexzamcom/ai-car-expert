/* Карта навигации на MapLibre GL: векторная карта, поворот по движению, наклон 3D, 3D-машинка.
   Только отрисовка и камера: GPS, маршрут, остановки, перестроение, поиск и интерфейс поверх карты — общие
   с картой Leaflet (резервный движок), поэтому смена движка не пересоздаёт маршрут. */
import { useEffect, useRef, type MutableRefObject } from 'react';
import type { GeoJSONSource, Map as MlMap, Marker } from 'maplibre-gl';
import { useStore } from '../lib/store';
import { geoStore, navStore, poiStore, pickStore, pickPoint, selectRoute, addStop, placeFromPoi, readLastPos, navLang } from '../lib/nav';
import { settingsStore, toast } from '../lib/state';
import { themeStore, THEMES } from '../lib/theme';
import { DEFAULT_STYLE_URL, paletteTransform, gameImage, type MapPalette } from '../lib/mapStyle';
import { carSvg, unwrapAngle, CAR_COLORS } from '../lib/carMarker';
import { createCar3dLayer, hexToRgb } from '../lib/car3d/layer';
import { autoZoom, lookAheadOffset } from '../lib/camera';
import { hudUiStore } from '../lib/hud';
import { engineFallback } from '../lib/mapEngine';
import { mapDiag, diagModeStore } from '../lib/diag';
import { displayStore, setRoadProvider } from '../lib/matching/display';
import type { RoadLine } from '../lib/matching/matcher';
import { LongPressDetector } from '../lib/geo/longpress';
import { cumulative, type LatLon, type Route } from '../lib/routing';
import { RouteTrimmer, remainingCoords } from '../lib/routeTrim';

export interface MapApi {
  /** Показать точки целиком, не заходя под поиск, кнопки и карточки. */
  fitPoints(points: LatLon[], ui: HTMLElement | null): void;
  centerOn(p: LatLon, zoom?: number): void;
  panTo(p: LatLon): void;
  contains(p: LatLon, pad?: number): boolean;
  resize(): void;
}

const PITCH = 50;
/** «Игровая 3D»: камера по движению чуть выше и круче (вид «миниатюры»), без маршрута — тоже с наклоном. */
const GAME_PITCH = 58;
const GAME_IDLE_PITCH = 45;
const GAME_ZOOM_BONUS = 0.3;
const DEFAULT_CENTER: LatLon = { lat: 55.7539, lon: 37.6208 };
const empty = { type: 'FeatureCollection' as const, features: [] };

/** Круг точности как многоугольник (радиус в метрах). */
function circle(p: LatLon, r: number) {
  const pts: number[][] = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    pts.push([p.lon + (r * Math.sin(a)) / (111320 * Math.cos((p.lat * Math.PI) / 180)), p.lat + (r * Math.cos(a)) / 111320]);
  }
  return { type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [pts] } };
}

const line = (coords: LatLon[], props: Record<string, unknown> = {}) => ({
  type: 'Feature' as const,
  properties: props,
  geometry: { type: 'LineString' as const, coordinates: coords.map((c) => [c.lon, c.lat]) },
});

function pinEl(kind: 'dest' | 'via' | 'pick') {
  const el = document.createElement('div');
  el.className = 'map-dest ml-pin';
  el.innerHTML = `<div class="map-dest-pin${kind === 'via' ? ' is-via' : kind === 'pick' ? ' is-pick' : ''}"></div>`;
  return el;
}

export function MapLibreMap(p: { apiRef: MutableRefObject<MapApi | null>; uiEl: MutableRefObject<HTMLDivElement | null>; follow: boolean; guiding: boolean; onUserMove: () => void }) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const follow = useRef(p.follow);
  const guiding = useRef(p.guiding);
  const onUserMove = useRef(p.onUserMove);
  follow.current = p.follow;
  guiding.current = p.guiding;
  onUserMove.current = p.onUserMove;
  const camera = useRef<(immediate?: boolean) => void>(() => {});
  const settings = useStore(settingsStore);

  useEffect(() => {
    let disposed = false;
    const cleanups: (() => void)[] = [];
    const fail = (reason: string) => !disposed && engineFallback(reason, (t) => toast(t, 'warn'));
    void (async () => {
      let ml: typeof import('maplibre-gl');
      let workerUrl: string;
      try {
        ml = await import('maplibre-gl');
        await import('maplibre-gl/dist/maplibre-gl.css');
        workerUrl = (await import('maplibre-gl/dist/maplibre-gl-worker.mjs?url')).default;
      } catch {
        return fail('не загрузилась');
      }
      if (disposed || !el.current) return;
      ml.setWorkerUrl(workerUrl);
      const start = readLastPos() ?? DEFAULT_CENTER;
      const styleUrl = DEFAULT_STYLE_URL;
      // Палитра: «Игровая 3D» — всегда светлая пастельная; обычная карта — день/ночь по теме.
      // «Игровая 3D» — тоже день/ночь по той же теме (авто по солнцу или вручную): светлая миниатюра или ночной город.
      const palette = (): MapPalette => {
        const dark = themeStore.get().active === 'night';
        if (settingsStore.get().mapLook === 'game') return dark ? 'game-night' : 'game';
        return dark ? 'night' : 'day';
      };
      // Слабое устройство (мало ядер) — ночью без пятен света фонарей; окна, свечение дорог и фары остаются.
      const lite = (navigator.hardwareConcurrency ?? 8) <= 4;
      const styleOf = (p: MapPalette) => ({ diff: false, transformStyle: paletteTransform(p, { lite }) });
      const LABEL: Record<MapPalette, string> = { day: 'день', night: 'ночная палитра', hud: 'HUD', game: 'игровая 3D', 'game-night': 'игровая 3D, ночь' };
      const isGame = () => settingsStore.get().mapLook === 'game';
      let map: MlMap;
      try {
        map = new ml.Map({
          container: el.current,
          style: styleUrl,
          center: [start.lon, start.lat],
          zoom: readLastPos() ? 15 : 13,
          // Авторы данных (OpenMapTiles, участники OpenStreetMap) указаны в самом стиле OpenFreeMap.
          attributionControl: { compact: true },
          maxPitch: 70,
          fadeDuration: 150,
          canvasContextAttributes: { antialias: true },
        });
      } catch {
        // Нет WebGL или он отключён/исчерпан (на iOS — слишком много контекстов).
        return fail('WebGL недоступен');
      }
      /* Диагностика жизненного цикла: создание/удаление, смена и загрузка стиля, ошибки, потеря WebGL, кадры. */
      mapDiag.create();
      map.on('style.load', () => mapDiag.styleLoad());
      const canvas = map.getCanvas();
      const onLost = () => mapDiag.contextLost();
      const onRestored = () => mapDiag.contextRestored();
      canvas.addEventListener('webglcontextlost', onLost);
      canvas.addEventListener('webglcontextrestored', onRestored);
      let frames = 0;
      map.on('render', () => frames++);
      const fpsTimer = setInterval(() => {
        mapDiag.fps(frames);
        frames = 0;
      }, 1000);
      cleanups.push(() => {
        clearInterval(fpsTimer);
        canvas.removeEventListener('webglcontextlost', onLost);
        canvas.removeEventListener('webglcontextrestored', onRestored);
      });
      // Стиль карты не загрузился (нет связи с сервером карты и нет кеша) — резервная карта.
      let styleLoaded = false;
      map.once('style.load', () => (styleLoaded = true));
      map.on('error', (e) => {
        mapDiag.error(String((e.error as Error | undefined)?.message ?? e.error ?? 'неизвестно'));
        // Ошибки отдельных тайлов, значков и шрифтов — не повод уходить с карты; важен только сам стиль.
        const url = (e.error as { url?: string } | undefined)?.url;
        if (styleLoaded || (url && !url.includes('/styles/'))) return;
        console.warn('MapLibre', e.error);
        fail('не загрузился стиль карты');
      });
      const styleTimer = setTimeout(() => !styleLoaded && fail('сервер карты не отвечает'), 25_000);
      cleanups.push(() => clearTimeout(styleTimer));
      if (palette() !== 'day') {
        mapDiag.setStyle(`${LABEL[palette()]} при запуске`);
        map.setStyle(styleUrl, styleOf(palette()));
      }
      // Иконка «игрушечного» дерева — рисуется в коде, когда стиль её запросит (без сторонних изображений).
      // Деревья, окна и фонари — рисуются в коде, когда стиль их запросит (без сторонних изображений).
      map.on('styleimagemissing', (e: { id: string }) => {
        if (!e.id.startsWith('game-') || map.hasImage(e.id)) return;
        const img = gameImage(e.id);
        if (img) map.addImage(e.id, img, { pixelRatio: 2 });
      });
      mapRef.current = map;

      /* ---------- Слои маршрута и точности ---------- */
      const addLayers = () => {
        const t = THEMES[themeStore.get().active];
        // Маршрут — под подписями, но над деревьями «Игровой 3D» (их символьные слои начинаются с game-).
        const before = map.getStyle().layers.find((l) => l.type === 'symbol' && !l.id.startsWith('game-'))?.id;
        if (!map.getSource('acc')) map.addSource('acc', { type: 'geojson', data: empty });
        if (!map.getSource('alts')) map.addSource('alts', { type: 'geojson', data: empty });
        if (!map.getSource('route')) map.addSource('route', { type: 'geojson', data: empty });
        const w = (a: number, b: number) => ['interpolate', ['linear'], ['zoom'], 12, a, 18, b] as unknown as number;
        if (!map.getLayer('acc')) map.addLayer({ id: 'acc', type: 'fill', source: 'acc', paint: { 'fill-color': t.accent, 'fill-opacity': 0.12 } }, before);
        if (!map.getLayer('alts')) map.addLayer({ id: 'alts', type: 'line', source: 'alts', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': t.muted, 'line-width': w(4, 12), 'line-opacity': 0.75 } }, before);
        if (!map.getLayer('route-casing')) map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': t['route-casing'], 'line-width': w(7, 24) } }, before);
        if (!map.getLayer('route-line')) map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': t.route, 'line-width': w(4.5, 16) } }, before);
        drawRoute();
        // Источник маршрута создан заново (загрузка или смена стиля) — данные отправляются сразу, без ожидания сдвига.
        sendRoute(performance.now(), true);
        drawAcc();
        syncCar();
      };
      map.on('style.load', addLayers);
      // Стиль перезагружается только при смене палитры (день ⇄ ночь ⇄ «Игровая 3D»), а не на каждое изменение темы
      // или настроек. В «Игровой 3D» палитра одна, поэтому смена темы стиль не трогает.
      let appliedPalette = palette();
      const restyle = (why: string) => {
        if (palette() === appliedPalette) return;
        appliedPalette = palette();
        mapDiag.setStyle(`${why} → ${appliedPalette}`);
        map.setStyle(styleUrl, styleOf(appliedPalette));
        camera.current(true);
      };
      cleanups.push(themeStore.subscribe(() => restyle('тема')), settingsStore.subscribe(() => restyle('вид карты')));

      /* ---------- Пройденная часть маршрута скрывается (только изображение; маршрут для подсказок не меняется) ---------- */
      const trimmer = new RouteTrimmer();
      const TRIM_MS = 900; // граница едет к новой точке так же плавно, как машинка
      let trimRoute: Route | null = null;
      let trimCum: number[] = [];
      let cutFrom = 0;
      let cutTo = 0;
      let cutT0 = 0;
      let cutSent = -1;
      let cutSentAt = 0;
      let routeShown: Route | null = null;
      let routeShownGuiding = false;
      // Последняя отправленная на карту линия маршрута (для диагностики и тестов).
      let routeData: { geometry?: { coordinates: number[][] } } = {};
      const shownCut = (now: number) => cutFrom + (cutTo - cutFrom) * Math.min(1, (now - cutT0) / TRIM_MS);
      const updateTrim = () => {
        const s = navStore.get();
        if (!s.route || s.status !== 'guiding' || !s.progress) return;
        const now = performance.now();
        if (s.route !== trimRoute) {
          trimRoute = s.route;
          trimCum = cumulative(s.route.coords);
          cutFrom = cutTo = 0;
          cutSent = -1;
        }
        const total = trimCum[trimCum.length - 1] ?? 0;
        const kmh = geoStore.get().speedKmh;
        const next = trimmer.update({ route: s.route, along: total - s.progress.remainingM, offRouteM: s.progress.offRouteM, t: now, speed: kmh != null ? kmh / 3.6 : null });
        if (next === cutTo) return;
        // Откат назад (разворот на маршруте) или большой скачок — сразу; обычное движение — плавно.
        cutFrom = next < cutTo || next - cutTo > 120 ? next : shownCut(now);
        cutTo = next;
        cutT0 = now;
      };
      const sendRoute = (now: number, force = false) => {
        const s = navStore.get();
        const src = map.getSource('route') as GeoJSONSource | undefined;
        if (!src) return;
        const guidingRoute = !!s.route && s.status === 'guiding' && s.route === trimRoute;
        if (!guidingRoute) {
          if (force || s.route !== routeShown || routeShownGuiding) {
            const data = s.route ? line(s.route.coords) : empty;
            src.setData(data);
            routeData = data as typeof routeData;
          }
          routeShown = s.route;
          routeShownGuiding = false;
          return;
        }
        const cut = Math.max(0, shownCut(now) - 2); // чуть позади центра машинки — линия уходит под неё
        // Не чаще 5 раз в секунду и только при заметном сдвиге — без лишней работы карты.
        if (!force && routeShown === s.route && routeShownGuiding && (now - cutSentAt < 200 || Math.abs(cut - cutSent) < 1)) return;
        const data = line(remainingCoords(s.route!.coords, trimCum, cut));
        src.setData(data);
        routeData = data as typeof routeData;
        routeShown = s.route;
        routeShownGuiding = true;
        cutSent = cut;
        cutSentAt = now;
      };
      const drawRoute = () => {
        const s = navStore.get();
        updateTrim();
        sendRoute(performance.now(), s.route !== routeShown);
        const alts = s.status === 'guiding' ? [] : s.routes.map((r, i) => ({ r, i })).filter(({ i }) => i !== s.routeIndex);
        (map.getSource('alts') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: alts.map(({ r, i }) => line(r.coords, { idx: i })) });
        markers.dest = syncMarker(markers.dest, s.dest, 'dest');
        markers.via = syncMarker(markers.via, s.via, 'via');
      };
      let accShown = 0;
      const drawAcc = () => {
        const g = geoStore.get();
        const src = map.getSource('acc') as GeoJSONSource | undefined;
        const show = g.lat != null && g.lon != null && (g.accuracy ?? 0) > 30;
        src?.setData(show ? circle({ lat: g.lat!, lon: g.lon! }, g.accuracy!) : empty);
        accShown = src && show ? g.accuracy! : 0;
      };

      /* ---------- Метки: цель, остановка, выбранная точка, объекты по пути ---------- */
      const markers: { dest?: Marker; via?: Marker; pick?: Marker; poi: Marker[] } = { poi: [] };
      const syncMarker = (m: Marker | undefined, pt: LatLon | null, kind: 'dest' | 'via' | 'pick') => {
        if (!pt) {
          m?.remove();
          return undefined;
        }
        const mk = m ?? new ml.Marker({ element: pinEl(kind), anchor: 'bottom' });
        mk.setLngLat([pt.lon, pt.lat]).addTo(map);
        return mk;
      };
      const drawPoi = () => {
        markers.poi.forEach((m) => m.remove());
        markers.poi = poiStore.get().items.map((it) => {
          const d = document.createElement('div');
          d.className = 'map-poi';
          d.innerHTML = `<div class="map-poi-dot poi-${it.category}" title="${it.name.replace(/"/g, '')}"></div>`;
          d.addEventListener('click', (e) => {
            e.stopPropagation();
            void addStop(placeFromPoi(it));
          });
          return new ml.Marker({ element: d }).setLngLat([it.lon, it.lat]).addTo(map);
        });
      };
      const drawPick = () => {
        const pk = pickStore.get();
        markers.pick = syncMarker(markers.pick, pk, 'pick');
        if (pk?.origin === 'search') {
          onUserMove.current();
          map.easeTo({ center: [pk.lon, pk.lat], zoom: Math.max(map.getZoom(), 16), bearing: 0, pitch: 0, duration: 600 });
        } else if (pk && !api.contains(pk, 0.15)) map.panTo([pk.lon, pk.lat]);
      };
      cleanups.push(navStore.subscribe(drawRoute), poiStore.subscribe(drawPoi), pickStore.subscribe(drawPick));
      map.on('click', 'alts', (e) => {
        const idx = Number(e.features?.[0]?.properties?.idx);
        if (Number.isFinite(idx)) selectRoute(idx);
      });

      /* ---------- Диагностический режим: сырая точка GPS отдельным маркером (машинка — скорректированная позиция) ---------- */
      const rawEl = document.createElement('div');
      rawEl.className = 'diag-raw';
      rawEl.title = 'Сырая точка GPS браузера';
      const rawMarker = new ml.Marker({ element: rawEl });
      const drawRaw = () => {
        const g = geoStore.get();
        if (diagModeStore.get().on && g.lat != null && g.lon != null) rawMarker.setLngLat([g.lon, g.lat]).addTo(map);
        else rawMarker.remove();
      };
      cleanups.push(geoStore.subscribe(drawRaw), diagModeStore.subscribe(drawRaw), () => rawMarker.remove());
      drawRaw();

      /* ---------- Машинка: 3D-слой или плоская; плавно между точками GPS ---------- */
      let carNow: { lon: number; lat: number; heading: number } | null = null;
      const car3d = createCar3dLayer(
        () => (carNow ? { ...carNow, color: hexToRgb(CAR_COLORS[settingsStore.get().carColor]?.[1] ?? '#f7f8fa') } : null),
        {
          sizePx: () => Math.min(76, Math.max(50, Math.min(innerWidth, innerHeight) * 0.095)),
          // Фары и задние огни — только в ночной «Игровой 3D».
          night: () => appliedPalette === 'game-night',
        },
      );
      const carEl = document.createElement('div');
      carEl.className = 'ml-car';
      const flatMarker = new ml.Marker({ element: carEl, rotationAlignment: 'map', pitchAlignment: 'map' });
      const use3d = () => settingsStore.get().carStyle !== 'flat' && !car3d.failed;
      const paintFlat = () => (carEl.innerHTML = carSvg(settingsStore.get().carColor, 32));
      paintFlat();
      const syncCar = () => {
        try {
          const has = !!map.getLayer('car-3d');
          if (use3d() && !has) map.addLayer(car3d);
          if (!use3d() && has) map.removeLayer('car-3d');
        } catch {
          /* стиль ещё загружается */
        }
      };
      cleanups.push(settingsStore.subscribe(() => (paintFlat(), syncCar())));

      let from: LatLon | null = null;
      let to: LatLon | null = null;
      let t0 = 0;
      let headingShown = 0;
      let headingTarget: number | null = null;
      // Машинка доезжает до новой точки за время между точками (0,25–1 с), а не всегда за 1 с — без отставания.
      let moveMs = 1000;
      const carPos = (now: number): LatLon | null => {
        if (!to) return null;
        if (!from) return to;
        const k = Math.min(1, (now - t0) / moveMs);
        return { lat: from.lat + (to.lat - from.lat) * k, lon: from.lon + (to.lon - from.lon) * k };
      };
      let raf = 0;
      const frame = (now: number) => {
        const pos = carPos(now);
        // Пока открыт HUD, основная карта скрыта — не тратим на неё кадры.
        if (pos && !hudUiStore.get().active) {
          if (headingTarget != null) {
            const target = unwrapAngle(headingShown, headingTarget);
            headingShown += Math.max(-6, Math.min(6, (target - headingShown) * 0.15));
          }
          carNow = { lon: pos.lon, lat: pos.lat, heading: ((headingShown % 360) + 360) % 360 };
          const flatOn = !!(flatMarker as unknown as { _map?: unknown })._map;
          if (use3d()) {
            if (flatOn) flatMarker.remove();
            map.triggerRepaint();
          } else {
            flatMarker.setLngLat([pos.lon, pos.lat]).setRotation(headingShown);
            if (!flatOn) flatMarker.addTo(map);
          }
        }
        if (trimRoute && routeShownGuiding) sendRoute(now);
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
      cleanups.push(() => cancelAnimationFrame(raf));

      /* ---------- Камера ---------- */
      let touching = 0;
      let userZoom = false;
      const box = map.getCanvasContainer();
      const onTouch = (e: TouchEvent) => (touching = e.touches.length);
      box.addEventListener('touchstart', onTouch, { passive: true });
      box.addEventListener('touchend', onTouch, { passive: true });
      box.addEventListener('touchcancel', () => (touching = 0), { passive: true });
      for (const ev of ['dragstart', 'rotatestart', 'pitchstart'] as const) map.on(ev, (e) => (e as { originalEvent?: Event }).originalEvent && follow.current && onUserMove.current());
      map.on('zoomstart', (e) => (e as { originalEvent?: Event }).originalEvent && (userZoom = true));

      camera.current = (immediate = false) => {
        if (!to || !follow.current || touching > 0 || hudUiStore.get().active) return;
        const size = map.getContainer().getBoundingClientRect();
        const g = geoStore.get();
        if (!guiding.current) {
          // «Игровая 3D»: и без маршрута — наклон, чтобы был виден объём города.
          map.easeTo({ center: [to.lon, to.lat], zoom: Math.max(map.getZoom(), isGame() ? 16 : 15), bearing: isGame() ? map.getBearing() : 0, pitch: isGame() ? GAME_IDLE_PITCH : 0, duration: immediate ? 500 : 900, easing: (x) => x });
          return;
        }
        const course = settingsStore.get().cameraMode === 'course';
        const n = navStore.get();
        const zoom = userZoom ? map.getZoom() : autoZoom(g.speedKmh, n.progress?.toStepM ?? null) + (isGame() ? GAME_ZOOM_BONUS : 0);
        const heading = headingTarget ?? map.getBearing();
        const offset: [number, number] = course ? [0, size.height * 0.24] : (lookAheadOffset(heading, size.width, size.height).map((v) => -v) as [number, number]);
        map.easeTo({ center: [to.lon, to.lat], bearing: course ? heading : 0, pitch: course ? (isGame() ? GAME_PITCH : PITCH) : isGame() ? GAME_IDLE_PITCH : 0, zoom, offset, duration: immediate ? 600 : moveMs, easing: (x) => x, essential: true });
      };
      cleanups.push(
        settingsStore.subscribe(() => camera.current(true)),
        // Выход из HUD — карта сразу на месте машинки.
        hudUiStore.subscribe(() => !hudUiStore.get().active && (map.resize(), camera.current(true))),
        // Круг точности — вокруг сырой точки GPS; машинка и камера — по отображаемой позиции (привязка к дороге).
        geoStore.subscribe(drawAcc),
        displayStore.subscribe(() => {
          const g = displayStore.get();
          if (g.lat == null || g.lon == null) return;
          if (to && to.lat === g.lat && to.lon === g.lon && headingTarget === g.heading) return;
          const now = performance.now();
          from = carPos(now) ?? { lat: g.lat, lon: g.lon };
          to = { lat: g.lat, lon: g.lon };
          if (t0) moveMs = Math.min(1000, Math.max(250, now - t0));
          t0 = now;
          if (g.heading != null) headingTarget = g.heading;
          camera.current();
        }),
      );

      /* ---------- Дороги рядом — для привязки машинки (src/lib/matching) ---------- */
      // Только автомобильные дороги из векторных тайлов, которые карта уже загрузила (без отдельных запросов).
      const ROAD_CLASSES = /^(motorway|trunk|primary|secondary|tertiary|minor|service|busway)$/;
      type BoxedLine = RoadLine & { box: [number, number, number, number] };
      let roadCache: { at: number; lines: BoxedLine[] } | null = null;
      const loadRoads = (): BoxedLine[] => {
        const src = Object.entries(map.getStyle()?.sources ?? {}).find(([, v]) => v.type === 'vector')?.[0];
        if (!src) return [];
        const out: BoxedLine[] = [];
        const seen = new Set<string>();
        for (const f of map.querySourceFeatures(src, { sourceLayer: 'transportation' })) {
          const cls = String(f.properties?.class ?? '');
          if (!ROAD_CLASSES.test(cls)) continue;
          const g = f.geometry;
          const parts = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
          for (const part of parts) {
            if (part.length < 2) continue;
            const coords = part.map(([lon, lat]) => ({ lat, lon }));
            const a = coords[0];
            const b = coords[coords.length - 1];
            // Устойчивый id по геометрии: один и тот же участок между запросами — та же дорога.
            const id = `${cls}:${a.lat.toFixed(5)},${a.lon.toFixed(5)}:${b.lat.toFixed(5)},${b.lon.toFixed(5)}`;
            if (seen.has(id)) continue;
            seen.add(id);
            const lats = coords.map((c) => c.lat);
            const lons = coords.map((c) => c.lon);
            const ow = Number(f.properties?.oneway ?? 0);
            out.push({ id, coords, oneway: ow === 1 ? 1 : ow === -1 ? -1 : 0, kind: 'road', cls, box: [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)] });
          }
        }
        return out;
      };
      setRoadProvider((pt, r) => {
        if (!roadCache || performance.now() - roadCache.at > 3000) roadCache = { at: performance.now(), lines: loadRoads() };
        const dLat = r / 111_320;
        const dLon = r / (111_320 * Math.cos((pt.lat * Math.PI) / 180));
        return roadCache.lines.filter((l) => l.box[0] <= pt.lat + dLat && l.box[2] >= pt.lat - dLat && l.box[1] <= pt.lon + dLon && l.box[3] >= pt.lon - dLon);
      });
      cleanups.push(() => setRoadProvider(null));

      /* ---------- Долгое нажатие и правый клик — выбор точки ---------- */
      const lp = new LongPressDetector({
        delay: 600,
        tolerance: 10,
        onLongPress: (x, y) => {
          const r = box.getBoundingClientRect();
          const ll = map.unproject([x - r.left, y - r.top]);
          navigator.vibrate?.(25);
          void pickPoint({ lat: ll.lat, lon: ll.lng });
        },
      });
      let lastTouch = 0;
      const onDown = (e: PointerEvent) => {
        if (e.pointerType === 'mouse') return;
        lastTouch = Date.now();
        if ((e.target as HTMLElement | null)?.closest?.('.maplibregl-marker, .maplibregl-ctrl')) return lp.reset();
        lp.down(e.pointerId, e.clientX, e.clientY);
      };
      const onMove = (e: PointerEvent) => e.pointerType !== 'mouse' && lp.move(e.pointerId, e.clientX, e.clientY);
      const onUp = (e: PointerEvent) => {
        if (e.pointerType === 'mouse') return;
        lastTouch = Date.now();
        lp.up(e.pointerId);
      };
      const onCancel = () => lp.reset();
      const onTouch2 = (e: TouchEvent) => e.touches.length > 1 && lp.reset();
      box.addEventListener('pointerdown', onDown, true);
      box.addEventListener('pointermove', onMove, true);
      box.addEventListener('pointerup', onUp, true);
      box.addEventListener('pointercancel', onCancel, true);
      box.addEventListener('touchstart', onTouch2, { capture: true, passive: true });
      map.on('movestart', (e) => (e as { originalEvent?: Event }).originalEvent && lp.cancel());
      map.on('contextmenu', (e) => {
        if (Date.now() - lastTouch < 1500 || Date.now() - lp.lastFired < 1500) return;
        void pickPoint({ lat: e.lngLat.lat, lon: e.lngLat.lng });
      });

      /* ---------- API для общего интерфейса навигации ---------- */
      const api: MapApi = {
        fitPoints(points, ui) {
          if (!points.length) return;
          const b = new ml.LngLatBounds();
          points.forEach((q) => b.extend([q.lon, q.lat]));
          const box2 = map.getContainer().getBoundingClientRect();
          const r = (sel: string) => ui?.querySelector<HTMLElement>(sel)?.getBoundingClientRect();
          const top = r('.map-top');
          const cards = r('.map-cards') ?? r('.guide-wrap');
          const ctl = r('.map-controls');
          const pad = {
            top: top && top.height ? Math.max(40, top.bottom - box2.top + 16) : 40,
            bottom: cards && cards.height ? Math.max(40, box2.bottom - cards.top + 16) : 40,
            left: 40,
            right: ctl && ctl.width ? Math.max(40, box2.right - ctl.left + 12) : 40,
          };
          if (pad.top + pad.bottom > box2.height - 120) pad.top = pad.bottom = Math.max(20, (box2.height - 120) / 2);
          map.fitBounds(b, { padding: pad, maxZoom: 16, bearing: 0, pitch: 0, duration: 600 });
        },
        centerOn(q, zoom) {
          map.easeTo({ center: [q.lon, q.lat], zoom: zoom ?? map.getZoom(), duration: 500 });
          userZoom = false;
          setTimeout(() => camera.current(true), 520);
        },
        panTo(q) {
          map.panTo([q.lon, q.lat]);
        },
        contains(q, padFrac = 0) {
          const c = map.getContainer().getBoundingClientRect();
          const pt = map.project([q.lon, q.lat]);
          return pt.x > c.width * padFrac && pt.x < c.width * (1 - padFrac) && pt.y > c.height * padFrac && pt.y < c.height * (1 - padFrac);
        },
        resize() {
          map.resize();
        },
      };
      p.apiRef.current = api;
      const ro = new ResizeObserver(() => map.resize());
      ro.observe(el.current);
      cleanups.push(() => ro.disconnect());

      // Для автоматических проверок.
      (window as unknown as { __aceMap?: unknown }).__aceMap = {
        engine: 'maplibre',
        map,
        state: () => {
          const r = map.getContainer().getBoundingClientRect();
          const c = carNow ? map.project([carNow.lon, carNow.lat]) : null;
          return {
            bearing: map.getBearing(),
            pitch: map.getPitch(),
            zoom: map.getZoom(),
            heading: headingTarget,
            car: c ? { x: c.x / r.width, y: c.y / r.height } : null,
            car3d: use3d() && !!map.getLayer('car-3d'),
            display: (({ mode, lineId, shift, lat, lon, reason }) => ({ mode, lineId, shift, lat, lon, reason }))(displayStore.get()),
            look: settingsStore.get().mapLook,
            gameLayers: ['game-buildings', 'game-roofs', 'game-trees'].filter((id) => !!map.getLayer(id)),
            palette: appliedPalette,
            nightLayers: ['game-road-glow', 'game-road-sheen', 'game-lamps'].filter((id) => !!map.getLayer(id)),
            windows: !!map.getLayer('game-buildings') && !!map.getPaintProperty('game-buildings', 'fill-extrusion-pattern'),
            styleReady: !!(map as unknown as { style?: { _loaded?: boolean } }).style?._loaded,
            raw: { lat: geoStore.get().lat, lon: geoStore.get().lon },
            accuracyCircle: accShown,
            routePoints: navStore.get().route?.coords.length ?? 0,
            routeTrim: (() => {
              const c = routeData.geometry?.coordinates ?? [];
              return { cut: Math.round(cutTo), total: Math.round(trimCum[trimCum.length - 1] ?? 0), shownPoints: c.length, first: c[0] ?? null };
            })(),
            lang: navLang(),
          };
        },
      };
      cleanups.push(() => {
        lp.reset();
        box.removeEventListener('pointerdown', onDown, true);
        box.removeEventListener('pointermove', onMove, true);
        box.removeEventListener('pointerup', onUp, true);
        box.removeEventListener('pointercancel', onCancel, true);
        box.removeEventListener('touchstart', onTouch2, true);
        markers.poi.forEach((m) => m.remove());
        p.apiRef.current = null;
        delete (window as unknown as { __aceMap?: unknown }).__aceMap;
        mapDiag.remove();
        map.remove();
        mapRef.current = null;
      });
      // Начальное состояние (маршрут, метки, позиция) — сразу после загрузки.
      drawPoi();
      drawPick();
      const d = displayStore.get();
      const g = d.lat != null ? d : geoStore.get();
      if (g.lat != null && g.lon != null) {
        to = { lat: g.lat, lon: g.lon };
        headingTarget = g.heading;
        headingShown = g.heading ?? 0;
        map.jumpTo({ center: [g.lon, g.lat] });
      }
    })();
    return () => {
      disposed = true;
      cleanups.forEach((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Следование и режим ведения от общего интерфейса.
  useEffect(() => {
    camera.current(true);
  }, [p.follow, p.guiding, settings.cameraMode]);

  return <div ref={el} className="map ml-map" />;
}
