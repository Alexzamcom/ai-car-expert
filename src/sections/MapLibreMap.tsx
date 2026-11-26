import { plannerViewport, positionMode } from '../lib/routePlanner';
import { mapLocationStore, MAP_LOCATION_STALE_MS } from '../lib/geo/mapLocation';
import { usesAndroidNativePosition } from '../lib/geo/nativePosition';
import { recordLocationMarker, recordMapVisibility } from '../lib/geo/locationDiagnostics';
import { watchAndroidViewport } from '../lib/androidViewport';
/* Карта навигации на MapLibre GL: векторная карта, поворот по движению, наклон 3D, 3D-машинка.
   Только отрисовка и камера: GPS, маршрут, остановки, перестроение, поиск и интерфейс поверх карты — общие
   с картой Leaflet (резервный движок), поэтому смена движка не пересоздаёт маршрут. */
import { useEffect, useRef, type MutableRefObject } from 'react';
import type { GeoJSONSource, Map as MlMap, Marker } from 'maplibre-gl';
import { useStore } from '../lib/store';
import { geoStore, navStore, poiStore, pickStore, pickPoint, selectRoute, addStop, placeFromPoi, readLastPos, trustedPlannerPosition, navLang, visibleRouteCoords } from '../lib/nav';
import { settingsStore, toast } from '../lib/state';
import { themeStore, THEMES } from '../lib/theme';
import { DEFAULT_STYLE_URL, paletteTransform, gameImage, type MapPalette } from '../lib/mapStyle';
import { carSvg, unwrapAngle, CAR_COLORS } from '../lib/carMarker';
import { ANDROID_CAR_LENGTH_M, createCar3dLayer, hexToRgb } from '../lib/car3d/layer';
import { androidChasePose, autoZoom, lookAheadOffset, effectiveNavCamera, maneuverLift, navCameraPose, gameFollowZoom, LiftFilter } from '../lib/camera';
import { hudUiStore } from '../lib/hud';
import { engineFallback } from '../lib/mapEngine';
import { mapDiag, diagModeStore, mapPositionStore, mapCameraStore } from '../lib/diag';
import { displayStore, setRoadProvider } from '../lib/matching/display';
import { EMPTY_OFFLINE_STYLE, initializeOfflineMaps, offlineRegions, regionAt, offlineStatus, offlineStyleFor, registerOfflineProtocol } from '../lib/offlineMaps';
import { VehicleAnimation } from '../lib/vehicleAnimation';
import { androidDriving, ANDROID_OVERVIEW } from '../lib/androidDriving';
import { courseBetween, headingDelta } from '../lib/autonomy/gnss';
import { autonomyMap } from '../lib/autonomy/map';
import type { RoadLine } from '../lib/matching/matcher';
import { LongPressDetector } from '../lib/geo/longpress';
import { cumulative, haversine, projectOnSegment, type LatLon } from '../lib/routing';

export interface MapApi {
  /** Показать точки целиком, не заходя под поиск, кнопки и карточки. */
  fitPoints(points: LatLon[], ui: HTMLElement | null): void;
  centerOn(p: LatLon, zoom?: number): void;
  panTo(p: LatLon): void;
  contains(p: LatLon, pad?: number): boolean;
  resize(): void;
  resumeFollow?(): void;
  zoomBy?(amount: number): void;
  center?(): LatLon;
  roadsNear?(p: LatLon): LatLon[][];
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

export function MapLibreMap(p: { apiRef: MutableRefObject<MapApi | null>; uiEl: MutableRefObject<HTMLDivElement | null>; follow: boolean; guiding: boolean; onUserMove: () => void; autonomous?: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const follow = useRef(p.follow);
  const guiding = useRef(p.guiding);
  const onUserMove = useRef(p.onUserMove);
  follow.current = p.follow;
  guiding.current = p.guiding;
  onUserMove.current = p.onUserMove;
  const drawMapPosition = useRef<() => void>(() => {});
  const camera = useRef<(immediate?: boolean) => void>(() => {});
  const settings = useStore(settingsStore);

  useEffect(() => {
    let disposed = false;
    const cleanups: (() => void)[] = [];
    const fail = (reason: string) => {
      if (disposed) return;
      if (p.autonomous) toast(`Экспериментальная карта недоступна: ${reason}`, 'warn');
      else engineFallback(reason, (t) => toast(t, 'warn'));
    };
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
      if (androidDriving) {
        registerOfflineProtocol(ml.addProtocol);
        await initializeOfflineMaps().catch(() => {});
        if (disposed || !el.current) return;
      }
      const manual = positionMode.get();
      const anchor = androidDriving && (p.autonomous || manual.manual || manual.rechecking)
        ? plannerViewport(manual, trustedPlannerPosition(), offlineRegions.get()) : undefined;
      const last = anchor ? anchor.point : readLastPos();
      const area = androidDriving && (!navigator.onLine || manual.manual) ? (last ? regionAt(last) : undefined) ?? (anchor ? anchor.region : offlineRegions.get()[0]) : undefined;
      const cachedViewport = last && (!area || regionAt(last)) ? last : undefined;
      const start = cachedViewport ?? area?.center ?? (androidDriving ? ANDROID_OVERVIEW : DEFAULT_CENTER);
      const styleUrl = DEFAULT_STYLE_URL;
      // Палитра: «Игровая 3D» — всегда светлая пастельная; обычная карта — день/ночь по теме.
      // «Игровая 3D» — тоже день/ночь по той же теме (авто по солнцу или вручную): светлая миниатюра или ночной город.
      const palette = (): MapPalette => {
        const dark = themeStore.get().active === 'night';
        if (isGame()) return dark ? 'game-night' : 'game';
        return dark ? 'night' : 'day';
      };
      // Слабое устройство (мало ядер) — ночью без пятен света фонарей; окна, свечение дорог и фары остаются.
      const lite = androidDriving || (navigator.hardwareConcurrency ?? 8) <= 4;
      const styleOf = (p: MapPalette) => ({ diff: false, transformStyle: paletteTransform(p, { lite }) });
      const LABEL: Record<MapPalette, string> = { day: 'день', night: 'ночная палитра', hud: 'HUD', game: 'игровая 3D', 'game-night': 'игровая 3D, ночь' };
      const isGame = () => androidDriving || !!p.autonomous || settingsStore.get().mapLook === 'game';
      let map: MlMap;
      try {
        map = new ml.Map({
          container: el.current,
          style: androidDriving ? EMPTY_OFFLINE_STYLE : styleUrl,
          center: [start.lon, start.lat],
          zoom: cachedViewport ? 15 : area ? 13 : androidDriving ? 2 : 13,
          // Авторы данных (OpenMapTiles, участники OpenStreetMap) указаны в самом стиле OpenFreeMap.
          attributionControl: { compact: true },
          maxPitch: 70,
          trackResize: !androidDriving,
          fadeDuration: 150,
          canvasContextAttributes: { antialias: true },
        });
      } catch {
        // Нет WebGL или он отключён/исчерпан (на iOS — слишком много контекстов).
        return fail('WebGL недоступен');
      }
      const ordinaryMap = () => androidDriving && !p.autonomous && usesAndroidNativePosition() && (!guiding.current || positionMode.get().manual);
      const dotEl = document.createElement('div');
      dotEl.className = 'ml-user-location';
      dotEl.setAttribute('aria-label', 'Местоположение на карте');
      const dot = new ml.Marker({ element: dotEl });
      let dotAdded = false;
      let centered = false;
      let centeredFresh = false;
      drawMapPosition.current = () => {
        const manual = positionMode.get();
        const position = ordinaryMap() ? manual.manual ? manual.point : mapLocationStore.get() : null;
        if (!position) {
          if (dotAdded) dot.remove();
          dotAdded = false;
          drawAcc();
          return;
        }
        const stale = Date.now() - position.at > MAP_LOCATION_STALE_MS;
        if (!dotAdded || dot.getLngLat().lat !== position.lat || dot.getLngLat().lng !== position.lon) dot.setLngLat([position.lon, position.lat]);
        if (!dotAdded) dot.addTo(map);
        if (!dotAdded) map.triggerRepaint();
        dotAdded = true;
        dotEl.classList.toggle('is-last-known', stale);
        dotEl.setAttribute('aria-label', manual.manual ? 'Последняя ручная позиция' : stale ? 'Последняя известная позиция' : 'Приблизительное местоположение');
        if (follow.current && (!centered || !stale && !centeredFresh) && !navStore.get().dest) {
          centered = true;
          centeredFresh ||= !stale;
          const zoom = Math.max(map.getZoom(), ('accuracy' in position && Number(position.accuracy) > 250) ? 14 : 16);
          map.jumpTo({ center: [position.lon, position.lat], zoom });
        }
        drawAcc();
      };
      cleanups.push(() => dot.remove(), mapLocationStore.subscribe(() => drawMapPosition.current()), positionMode.subscribe(() => drawMapPosition.current()));
      /* Диагностика жизненного цикла: создание/удаление, смена и загрузка стиля, ошибки, потеря WebGL, кадры. */
      mapDiag.create();
      if (androidDriving && !p.autonomous) recordLocationMarker('waiting-for-display-position');
      map.on('style.load', () => mapDiag.styleLoad());
      const canvas = map.getCanvas();
      const onLost = () => mapDiag.contextLost();
      const onRestored = () => mapDiag.contextRestored();
      canvas.addEventListener('webglcontextlost', onLost);
      canvas.addEventListener('webglcontextrestored', onRestored);
      let frames = 0;
      const cameraSnapshot = () => ({
        target: followTarget ? { ...androidChasePose(followTarget.speed, followTarget.lift, followTarget.landscape, map.getMaxPitch()), bearing: carNow?.heading ?? map.getBearing() } : null,
        applied: { pitch: map.getPitch(), zoom: map.getZoom(), bearing: map.getBearing() },
        following: follow.current && touching === 0 && !pointerHeld,
        toStepM: (p.autonomous ? autonomyMap.get() : navStore.get()).progress?.toStepM ?? null,
      });
      map.on('render', () => frames++);
      const fpsTimer = setInterval(() => {
        mapDiag.fps(frames);
        frames = 0;
        if (androidDriving && diagModeStore.get().on) mapCameraStore.set(cameraSnapshot());
        if (!p.autonomous && diagModeStore.get().on && carNow && to) {
          mapPositionStore.set({ marker: { lat: carNow.lat, lon: carNow.lon }, target: to,
            following: follow.current && touching === 0 && !hudUiStore.get().active, motion: androidDriving ? motionPeaks : undefined });
        }
        if (androidDriving && !p.autonomous) {
          const point = ordinaryMap() ? positionMode.get().manual ? positionMode.get().point : mapLocationStore.get() : carNow;
          const origin = canvas.getBoundingClientRect();
          const projected = point && map.project([point.lon, point.lat]);
          const x = projected ? origin.left + projected.x : -1;
          const y = projected ? origin.top + projected.y : -1;
          const inViewport = !!projected && x >= Math.max(0, origin.left) && y >= Math.max(0, origin.top) &&
            x < Math.min(innerWidth, origin.right) && y < Math.min(innerHeight, origin.bottom);
          const top = inViewport ? document.elementFromPoint(x, y) : null;
          const covered = inViewport && (hudUiStore.get().active || !map.getContainer().contains(top));
          const drawable = ordinaryMap() ? dotAdded : !!car3d.renderedBounds || carEl.isConnected;
          const visible = inViewport && !covered && drawable && getComputedStyle(map.getContainer()).visibility !== 'hidden';
          const at = ordinaryMap() ? point && 'at' in point ? Number(point.at) : null : geoStore.get().fixAt;
          recordMapVisibility({ visible, inViewport, covered, ageMs: at == null ? null : Date.now() - at,
            ...cameraSnapshot().applied, following: follow.current, guiding: guiding.current });
          recordLocationMarker(!point ? 'waiting-for-display-position' : covered ? 'marker-covered' : !inViewport ? 'marker-outside-viewport'
            : ordinaryMap() ? drawable ? 'ordinary-marker-visible' : 'ordinary-marker-awaits-render'
            : car3d.renderedBounds ? '3d-marker-rendered' : carEl.isConnected ? 'flat-marker-on-map' : '3d-marker-awaits-render');
          if (ordinaryMap() && dotAdded && at != null) {
            const stale = Date.now() - at > MAP_LOCATION_STALE_MS;
            dotEl.classList.toggle('is-last-known', stale);
            dotEl.setAttribute('aria-label', stale ? 'Последняя известная позиция' : 'Приблизительное местоположение');
          }
        }
        motionPeaks = { modelM: 0, modelDeg: 0, centerM: 0, cameraDeg: 0 };
      }, 1000);
      cleanups.push(() => {
        clearInterval(fpsTimer);
        canvas.removeEventListener('webglcontextlost', onLost);
        canvas.removeEventListener('webglcontextrestored', onRestored);
      });
      // Стиль карты не загрузился (нет связи с сервером карты и нет кеша) — резервная карта.
      let styleLoaded = false;
      let local = androidDriving && (!navigator.onLine || manual.manual && !!area);
      let selectedSource: unknown;
      let selectedPalette: MapPalette | undefined;
      const setBase = () => {
        const center = map.getCenter();
        const fallback = local ? offlineStyleFor({ lat: center.lat, lon: center.lng }) : undefined;
        const source = fallback?.style ?? styleUrl;
        const look = palette();
        if (source === selectedSource && look === selectedPalette) return;
        selectedSource = source;
        selectedPalette = look;
        if (androidDriving) offlineStatus.set({ local, region: fallback?.region ?? null });
        map.setStyle(source, styleOf(look));
      };
      const switchLocal = (value: boolean) => {
        if (disposed || !androidDriving || value === local) return;
        local = value;
        setBase();
      };
      map.once('style.load', () => (styleLoaded = true));
      map.on('error', (e) => {
        mapDiag.error(String((e.error as Error | undefined)?.message ?? e.error ?? 'неизвестно'));
        // Ошибки отдельных тайлов, значков и шрифтов — не повод уходить с карты; важен только сам стиль.
        const url = (e.error as { url?: string } | undefined)?.url;
        if (androidDriving) {
          const error = e.error as { status?: number; message?: string } | undefined;
          if (!navigator.onLine || url?.includes('/styles/') || !error?.status && /network|fetch/i.test(error?.message ?? '')) switchLocal(true);
          return;
        }
        if (styleLoaded || (url && !url.includes('/styles/'))) return;
        console.warn('MapLibre', e.error);
        fail('не загрузился стиль карты');
      });
      const styleTimer = setTimeout(() => {
        if (!styleLoaded) {
          if (androidDriving) switchLocal(true);
          else fail('сервер карты не отвечает');
        }
      }, 25_000);
      cleanups.push(() => clearTimeout(styleTimer));
      if (androidDriving) {
        const offline = () => switchLocal(true);
        const online = () => switchLocal(false);
        window.addEventListener('offline', offline);
        window.addEventListener('online', online);
        let probe: AbortController | null = null;
        const retry = setInterval(() => {
          if (!local || !navigator.onLine || probe) return;
          probe = new AbortController();
          const wait = setTimeout(() => probe?.abort(), 5000);
          void fetch(styleUrl, { signal: probe.signal, cache: 'no-store' })
            .then((result) => { if (result.ok) switchLocal(false); })
            .catch(() => {}).finally(() => { clearTimeout(wait); probe = null; });
        }, 30_000);
        // Route framing can cross into another installed region immediately after
        // startup. setBase already avoids reloading the same style.
        map.on('moveend', () => { if (local) setBase(); });
        cleanups.push(offlineRegions.subscribe(() => { if (local) setBase(); }), () => {
          window.removeEventListener('offline', offline);
          window.removeEventListener('online', online);
          clearInterval(retry);
          probe?.abort();
        });
        setBase();
      } else if (palette() !== 'day') {
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
        drawRoute(true);
        // Источник маршрута создан заново (загрузка или смена стиля) — данные отправляются сразу, без ожидания сдвига.
        drawAcc();
        syncCar();
      };
      map.on('style.load', addLayers);
      // Стиль перезагружается только при смене палитры (день ⇄ ночь ⇄ «Игровая 3D»), а не на каждое изменение темы
      // или настроек. В «Игровой 3D» палитра одна, поэтому смена темы стиль не трогает.
      let appliedPalette = palette();
      const normalFov = map.getVerticalFieldOfView();
      const applyFov = () => {
        const fov = isGame() ? 42 : normalFov;
        if (map.getVerticalFieldOfView() !== fov) map.setVerticalFieldOfView(fov);
      };
      applyFov();
      const restyle = (why: string) => {
        if (palette() === appliedPalette) return;
        appliedPalette = palette();
        mapDiag.setStyle(`${why} → ${appliedPalette}`);
        if (androidDriving) setBase();
        else map.setStyle(styleUrl, styleOf(appliedPalette));
        camera.current(true);
      };
      cleanups.push(themeStore.subscribe(() => restyle('тема')), settingsStore.subscribe(() => restyle('вид карты')));

      let shownCoords: LatLon[] | undefined;
      const drawRoute = (force = false) => {
        const s = navStore.get();
        const src = map.getSource('route') as GeoJSONSource | undefined;
        const experimental = p.autonomous ? autonomyMap.get() : null;
        const coords = experimental ? experimental.route?.coords ?? [] : visibleRouteCoords(s);
        if (src && (force || coords !== shownCoords)) {
          src.setData(coords.length >= 2 ? line(coords) : empty);
          shownCoords = coords;
        }
        const alts = experimental || s.status === 'guiding' ? [] : s.routes.map((r, i) => ({ r, i })).filter(({ i }) => i !== s.routeIndex);
        (map.getSource('alts') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: alts.map(({ r, i }) => line(r.coords, { idx: i })) });
        markers.dest = syncMarker(markers.dest, experimental ? experimental.destination : s.dest, 'dest');
        markers.via = syncMarker(markers.via, experimental ? null : s.via, 'via');
      };
      let accShown = 0;
      const drawAcc = () => {
        const g = geoStore.get();
        const browsing = ordinaryMap() ? mapLocationStore.get() : null;
        const src = map.getSource('acc') as GeoJSONSource | undefined;
        const show = !p.autonomous && !ordinaryMap() && g.lat != null && g.lon != null && ((g.accuracy ?? 0) > 30 || g.nativeTrust === 'network');
        src?.setData(browsing ? circle(browsing, browsing.accuracy) : show ? circle({ lat: g.lat!, lon: g.lon! }, g.accuracy!) : empty);
        accShown = src ? browsing?.accuracy ?? (show ? g.accuracy! : 0) : 0;
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
      if (p.autonomous) {
        let previous = autonomyMap.get();
        cleanups.push(autonomyMap.subscribe(() => {
          const next = autonomyMap.get();
          if (next.route !== previous.route || next.destination !== previous.destination) drawRoute();
          previous = next;
        }));
      }
      else cleanups.push(navStore.subscribe(() => drawRoute()), poiStore.subscribe(drawPoi), pickStore.subscribe(drawPick));
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
        if (!p.autonomous && diagModeStore.get().on && g.lat != null && g.lon != null) rawMarker.setLngLat([g.lon, g.lat]).addTo(map);
        else rawMarker.remove();
      };
      cleanups.push(geoStore.subscribe(drawRaw), diagModeStore.subscribe(drawRaw), () => rawMarker.remove());
      drawRaw();

      /* ---------- Машинка: 3D-слой или плоская; плавно между точками GPS ---------- */
      let carNow: { lon: number; lat: number; heading: number } | null = null;
      const androidBody = hexToRgb('#f7f8fa');
      const car3d = createCar3dLayer(
        () => (carNow && !ordinaryMap() ? { ...carNow, color: androidDriving ? androidBody : hexToRgb(CAR_COLORS[settingsStore.get().carColor]?.[1] ?? '#f7f8fa') } : null),
        {
          gameSize: isGame,
          lengthM: androidDriving ? ANDROID_CAR_LENGTH_M : undefined,
          roofColor: androidDriving ? androidBody : undefined,
          sizePx: () => Math.min(76, Math.max(50, Math.min(innerWidth, innerHeight) * 0.095)),
          // Фары и задние огни — только в ночной «Игровой 3D».
          night: () => appliedPalette === 'game-night',
        },
      );
      const carEl = document.createElement('div');
      carEl.className = 'ml-car';
      const flatMarker = new ml.Marker({ element: carEl, rotationAlignment: 'map', pitchAlignment: 'map' });
      const use3d = () => (androidDriving || p.autonomous || settingsStore.get().carStyle !== 'flat') && !car3d.failed;
      const paintFlat = () => (carEl.innerHTML = carSvg(androidDriving ? 'white' : settingsStore.get().carColor, 32));
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
      const animation = new VehicleAnimation();
      let raf = 0;
      let followTarget: { speed: number | null; lift: number; height: number; landscape: boolean } | null = null;
      let cameraTime = 0;
      let recoveringCenter = false;
      let motionDiag = { modelM: 0, centerM: 0, cameraDeg: 0, modelDeg: 0 };
      let motionPeaks = { ...motionDiag };
      const frame = (now: number) => {
        const androidPose = androidDriving ? animation.frame(now) : null;
        const pos = androidDriving ? androidPose : carPos(now);
        const dt = Math.min(350, Math.max(0, now - (cameraTime || now)));
        cameraTime = now;
        // Пока открыт HUD, основная карта скрыта — не тратим на неё кадры.
        if (ordinaryMap() && carEl.isConnected) flatMarker.remove();
        if (pos && !ordinaryMap() && !hudUiStore.get().active) {
          if (androidPose) headingShown = androidPose.heading;
          else if (headingTarget != null) {
            const target = unwrapAngle(headingShown, headingTarget);
            headingShown += Math.max(-6, Math.min(6, (target - headingShown) * 0.15));
          }
          const next = { lon: pos.lon, lat: pos.lat, heading: ((headingShown % 360) + 360) % 360 };
          const changed = !carNow || next.lon !== carNow.lon || next.lat !== carNow.lat || Math.abs(next.heading - carNow.heading) > 0.01;
          if (androidDriving) {
            const previous = carNow;
            const center = map.getCenter();
            const yaw = map.getBearing();
            motionDiag = {
              modelM: previous ? haversine(previous, next) : 0,
              modelDeg: previous ? Math.abs(headingDelta(next.heading, previous.heading)) : 0,
              centerM: 0, cameraDeg: 0,
            };
            if (followTarget && follow.current && guiding.current && touching === 0 && !pointerHeld) {
              const height = lift.update(followTarget.lift, dt / 1000);
              const followPose = androidChasePose(followTarget.speed, height, followTarget.landscape, map.getMaxPitch());
              const blend = 1 - Math.exp(-dt / 290);
              const pitchStep = (followPose.pitch - map.getPitch()) * blend;
              const pitch = map.getPitch() + Math.max(-3, Math.min(3, pitchStep));
              const zoom = map.getZoom() + (followPose.zoom - map.getZoom()) * blend;
              const yawStep = headingDelta(next.heading, yaw);
              const bearing = yaw + yawStep * blend;
              const top = map.getPadding().top ?? 0;
              const padding = top + (2 * followTarget.height * followPose.offset - top) * blend;
              motionDiag.centerM = haversine({ lat: center.lat, lon: center.lng }, next);
              motionDiag.cameraDeg = Math.abs(yawStep * blend);
              if (motionDiag.centerM > 30) recoveringCenter = true;
              if (motionDiag.centerM < 0.6) recoveringCenter = false;
              const centerTarget: [number, number] = recoveringCenter
                ? [center.lng + headingDelta(next.lon, center.lng) * blend, center.lat + (next.lat - center.lat) * blend]
                : [next.lon, next.lat];
              if (motionDiag.centerM > 0.015 || motionDiag.cameraDeg > 0.015 || Math.abs(pitch - map.getPitch()) > 0.015 ||
                Math.abs(zoom - map.getZoom()) > 0.002 || Math.abs(padding - top) > 0.3) {
                map.jumpTo({ center: centerTarget, bearing, pitch, zoom, padding: { top: padding, bottom: 0, left: 0, right: 0 } });
              }
            }
          }
          if (androidDriving) motionPeaks = {
            modelM: Math.max(motionPeaks.modelM, motionDiag.modelM), modelDeg: Math.max(motionPeaks.modelDeg, motionDiag.modelDeg),
            centerM: Math.max(motionPeaks.centerM, motionDiag.centerM), cameraDeg: Math.max(motionPeaks.cameraDeg, motionDiag.cameraDeg),
          };
          if (changed || !androidDriving) carNow = next;
          const flatOn = !!(flatMarker as unknown as { _map?: unknown })._map;
          if (use3d()) {
            if (flatOn) flatMarker.remove();
            if (changed || !androidDriving) map.triggerRepaint();
          } else {
            flatMarker.setLngLat([pos.lon, pos.lat]).setRotation(headingShown);
            if (!flatOn) flatMarker.addTo(map);
            if (androidDriving && !p.autonomous && changed) recordLocationMarker('flat-marker-on-map');
          }
        }
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
      cleanups.push(() => cancelAnimationFrame(raf));

      /* ---------- Камера ---------- */
      let touching = 0;
      let pointerHeld = false;
      let userZoom = false;
      const box = map.getCanvasContainer();
      const onTouch = (e: TouchEvent) => (touching = e.touches.length);
      box.addEventListener('touchstart', onTouch, { passive: true });
      box.addEventListener('touchend', onTouch, { passive: true });
      const clearTouch = () => { touching = 0; pointerHeld = false; };
      const holdPointer = () => { pointerHeld = true; };
      if (androidDriving) {
        box.addEventListener('pointerdown', holdPointer);
        window.addEventListener('pointerup', clearTouch);
        window.addEventListener('pointercancel', clearTouch);
      }
      const interrupt = () => {
        if (androidDriving) follow.current = false;
        onUserMove.current();
      };
      box.addEventListener('touchcancel', clearTouch, { passive: true });
      window.addEventListener('orientationchange', clearTouch);
      window.addEventListener('blur', clearTouch);
      cleanups.push(() => {
        box.removeEventListener('touchstart', onTouch);
        box.removeEventListener('touchend', onTouch);
        box.removeEventListener('touchcancel', clearTouch);
        window.removeEventListener('orientationchange', clearTouch);
        window.removeEventListener('blur', clearTouch);
        box.removeEventListener('pointerdown', holdPointer);
        window.removeEventListener('pointerup', clearTouch);
        window.removeEventListener('pointercancel', clearTouch);
      });
      if (androidDriving) map.on('movestart', (e) => { if (e.originalEvent && follow.current) interrupt(); });
      for (const ev of ['dragstart', 'rotatestart', 'pitchstart'] as const) map.on(ev, (e) => {
        if ((e as { originalEvent?: Event }).originalEvent && follow.current) interrupt();
      });
      map.on('zoomstart', (e) => {
        if (!(e as { originalEvent?: Event }).originalEvent) return;
        userZoom = true;
        if (androidDriving && follow.current) interrupt();
      });

      // Динамическая камера: подъём перед поворотом сглаживается во времени (без рывков при смене манёвра, перестроении, потере GPS).
      const lift = new LiftFilter();
      let liftAt = 0;
      let camStyle: 'normal' | 'game' | 'dynamic' = 'normal';
      camera.current = (immediate = false) => {
        if (ordinaryMap() || !to || !follow.current || touching > 0 || hudUiStore.get().active) return;
        const size = map.getContainer().getBoundingClientRect();
        const experimental = p.autonomous ? autonomyMap.get() : null;
        const speedKmh = experimental ? (experimental.position?.speed ?? 0) * 3.6 : geoStore.get().speedKmh;
        if (!guiding.current) {
          followTarget = null;
          if (androidDriving) lift.reset();
          // «Игровая 3D»: и без маршрута — наклон, чтобы был виден объём города.
          map.easeTo({ center: [to.lon, to.lat], zoom: Math.max(map.getZoom(), isGame() ? 16 : 15), bearing: isGame() ? map.getBearing() : 0, pitch: isGame() ? GAME_IDLE_PITCH : 0, ...(androidDriving ? { padding: { top: 0, bottom: 0, left: 0, right: 0 } } : {}), duration: immediate ? 500 : moveMs, easing: (x) => x });
          return;
        }
        const course = androidDriving || p.autonomous || settingsStore.get().cameraMode === 'course';
        const n = experimental ?? navStore.get();
        const heading = headingTarget ?? map.getBearing();
        // Камера по движению: обычная (прежняя), игровая (вид сзади) или динамическая (подъём перед поворотом —
        // по расстоянию до манёвра из прогресса вдоль маршрута, не по ближайшей точке GPS).
        camStyle = androidDriving || p.autonomous ? 'dynamic' : effectiveNavCamera(settingsStore.get().navCamera, isGame());
        const step = n.route && n.progress ? n.route.steps[n.progress.stepIndex] : null;
        const target = course && camStyle === 'dynamic' ? maneuverLift(step, n.progress?.toStepM, speedKmh) : 0;
        if (androidDriving) {
          followTarget = { speed: speedKmh, lift: target, height: size.height, landscape: size.width > size.height };
          return;
        }
        const now = performance.now();
        const l = lift.update(target, liftAt ? (now - liftAt) / 1000 : 0);
        liftAt = now;
        const pose = navCameraPose(camStyle, {
          baseZoom: camStyle === 'normal'
            ? autoZoom(speedKmh, n.progress?.toStepM ?? null) + (isGame() ? GAME_ZOOM_BONUS : 0)
            : isGame() ? gameFollowZoom(speedKmh) : autoZoom(speedKmh, null),
          normalPitch: isGame() ? GAME_PITCH : PITCH,
          lift: l,
          maxPitch: map.getMaxPitch(),
          landscape: size.width > size.height,
          gameLook: isGame(),
        });
        const zoom = userZoom ? map.getZoom() : pose.zoom;
        const offset: [number, number] = course ? [0, size.height * pose.offset] : (lookAheadOffset(heading, size.width, size.height).map((v) => -v) as [number, number]);
        map.easeTo({ center: [to.lon, to.lat], bearing: course ? heading : 0, pitch: course ? pose.pitch : isGame() ? GAME_IDLE_PITCH : 0, zoom, offset, duration: immediate ? 600 : androidDriving ? Math.max(450, moveMs) : moveMs, easing: (x) => x, essential: true });
      };
      cleanups.push(
        settingsStore.subscribe(() => { applyFov(); camera.current(true); }),
        // Выход из HUD — карта сразу на месте машинки.
        hudUiStore.subscribe(() => !hudUiStore.get().active && (map.resize(), camera.current(true))),
        // Круг точности — вокруг сырой точки GPS; машинка и камера — по отображаемой позиции (привязка к дороге).
        geoStore.subscribe(drawAcc),
        ...(androidDriving ? [(p.autonomous ? autonomyMap : navStore).subscribe(() => camera.current())] : []),
        (p.autonomous ? autonomyMap : displayStore).subscribe(() => {
          const g = p.autonomous ? autonomyMap.get().position : displayStore.get();
          if (!g) {
            to = from = carNow = null;
            animation.clear();
            flatMarker.remove();
            map.triggerRepaint();
            return;
          }
          if (g.lat == null || g.lon == null) return;
          if (!to && androidDriving && !p.autonomous) {
            if ((geoStore.get().accuracy ?? Infinity) > 50 && geoStore.get().nativeTrust !== 'network') {
              recordLocationMarker('display-position-not-accurate-enough');
              return;
            }
            if (follow.current && !ordinaryMap()) map.jumpTo({ center: [g.lon, g.lat], zoom: 16 });
          }
          const now = performance.now();
          if (androidDriving) {
            const gps = geoStore.get();
            const nav = p.autonomous ? autonomyMap.get() : navStore.get();
            const { progress, route } = nav;
            const i = progress?.segIndex;
            let segment = i != null && route && progress && progress.offRouteM < 15 ? route.coords.slice(i, i + 2) : [];
            if (gps.nativeTrust == null && i != null && route && segment.length === 2 && route.coords[i + 2]) {
              const pos = { lat: g.lat, lon: g.lon };
              const [a, b] = segment;
              const c = route.coords[i + 2];
              if (projectOnSegment(pos, a, b).dist > projectOnSegment(pos, b, c).dist + 2) segment = [b, c];
            }
            const speed = p.autonomous ? (autonomyMap.get().position?.speed ?? 0) : gps.speedKmh == null ? null : gps.speedKmh / 3.6;
            const estimated = gps.nativeTrust != null && gps.nativeTrust !== 'confirmed';
            const reliable = p.autonomous || (!guiding.current && gps.nativeTrust === 'network') || (estimated && (gps.accuracy ?? Infinity) <= 150) || (!gps.held && (gps.accuracy ?? Infinity) <= 50 && Date.now() - (gps.updated ?? 0) <= 5000);
            animation.receive({ lat: g.lat, lon: g.lon, heading: g.heading, speedMps: speed, reliable,
              predict: !p.autonomous && !(gps.nativeTrust != null && guiding.current) && displayStore.get().mode !== 'predicted',
              roadHeading: (p.autonomous || gps.nativeTrust == null) && guiding.current && (speed ?? 0) > 1.5 && segment.length === 2 && haversine(segment[0], segment[1]) > 2
                ? courseBetween(segment[0], segment[1]) : null }, now);
          }
          if (to && to.lat === g.lat && to.lon === g.lon && headingTarget === g.heading) return;
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
        const style = map.getStyle();
        const sources = new Set(style?.layers.flatMap((layer) =>
          'source-layer' in layer && layer['source-layer'] === 'transportation' && 'source' in layer && style.sources[layer.source]?.type === 'vector'
            ? [layer.source] : []) ?? []);
        const out: BoxedLine[] = [];
        const seen = new Set<string>();
        for (const f of [...sources].flatMap((source) => map.querySourceFeatures(source, { sourceLayer: 'transportation' }))) {
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
      // Не используем снимок старого стиля/набора тайлов после загрузки новой дороги.
      map.on('style.load', () => { roadCache = null; });
      map.on('sourcedata', (event) => {
        if ((event.tile || event.sourceDataType === 'content') && event.source?.type === 'vector') roadCache = null;
      });
      if (!p.autonomous) setRoadProvider((pt, r) => {
        if (!roadCache || performance.now() - roadCache.at > 3000) roadCache = { at: performance.now(), lines: loadRoads() };
        const dLat = r / 111_320;
        const dLon = r / (111_320 * Math.cos((pt.lat * Math.PI) / 180));
        return roadCache.lines.filter((l) => l.box[0] <= pt.lat + dLat && l.box[2] >= pt.lat - dLat && l.box[1] <= pt.lon + dLon && l.box[3] >= pt.lon - dLon);
      });
      if (!p.autonomous) cleanups.push(() => setRoadProvider(null));

      /* ---------- Долгое нажатие и правый клик — выбор точки ---------- */
      const lp = new LongPressDetector({
        delay: 600,
        tolerance: 10,
        onLongPress: (x, y) => {
          const r = box.getBoundingClientRect();
          const ll = map.unproject([x - r.left, y - r.top]);
          navigator.vibrate?.(25);
          if (!p.autonomous) void pickPoint({ lat: ll.lat, lon: ll.lng });
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
        if (!p.autonomous) void pickPoint({ lat: e.lngLat.lat, lon: e.lngLat.lng });
      });

      /* ---------- API для общего интерфейса навигации ---------- */
      const api: MapApi = {
        fitPoints(points, ui) {
          if (!points.length) return;
          const b = new ml.LngLatBounds();
          points.forEach((q) => b.extend([q.lon, q.lat]));
          const box2 = map.getContainer().getBoundingClientRect();
          const r = (sel: string) => ui?.querySelector<HTMLElement>(sel)?.getBoundingClientRect();
          const top = ui?.matches('.autonomy-panel') ? ui.getBoundingClientRect() : r('.map-top');
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
        resumeFollow() {
          map.stop();
          userZoom = false;
          clearTouch();
          follow.current = true;
          recoveringCenter = true;
          camera.current(true);
        },
        zoomBy(amount) {
          interrupt();
          map.easeTo({ zoom: map.getZoom() + amount, duration: 220 });
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
        roadsNear(p) {
          return loadRoads().filter(({ box }) => p.lat >= box[1] - 0.00045 && p.lat <= box[3] + 0.00045 &&
            p.lon >= box[0] - 0.001 && p.lon <= box[2] + 0.001).flatMap((line) =>
              line.oneway === 1 ? [line.coords] : line.oneway === -1 ? [line.coords.slice().reverse()] : [line.coords, line.coords.slice().reverse()]);
        },
        center() {
          const center = map.getCenter().wrap();
          return { lat: center.lat, lon: center.lng };
        },
        resize() {
          map.resize();
        },
      };
      p.apiRef.current = api;
      if (p.autonomous && !guiding.current) {
        const preview = autonomyMap.get().route;
        if (preview) api.fitPoints(preview.coords, p.uiEl.current);
      }
      const resizeMap = () => {
        if (androidDriving && hudUiStore.get().active) return;
        map.resize();
        if (isGame() && guiding.current) camera.current(true);
      };
      const ro = new ResizeObserver(resizeMap);
      ro.observe(el.current);
      if (androidDriving) cleanups.push(watchAndroidViewport(resizeMap));
      cleanups.push(() => ro.disconnect());

      // Для автоматических проверок.
      (window as unknown as { __aceMap?: unknown }).__aceMap = {
        engine: 'maplibre',
        map,
        frameClock: { set: ml.setNow, restore: ml.restoreNow },
        state: () => {
          const r = map.getContainer().getBoundingClientRect();
          const visiblePoint = ordinaryMap() ? positionMode.get().manual ? positionMode.get().point : mapLocationStore.get() : carNow;
          const c = visiblePoint ? map.project([visiblePoint.lon, visiblePoint.lat]) : null;
          return {
            motion: androidDriving ? motionDiag : undefined,
            offline: androidDriving ? offlineStatus.get() : undefined,
            bearing: map.getBearing(),
            pitch: map.getPitch(),
            zoom: map.getZoom(),
            heading: headingTarget,
            car: c ? { x: c.x / r.width, y: c.y / r.height } : null,
            car3d: use3d() && !!map.getLayer('car-3d'),
            experimentalEstimate: p.autonomous ? autonomyMap.get().position : undefined,
            carLengthM: androidDriving ? ANDROID_CAR_LENGTH_M : null,
            carWidthShare: car3d.renderedBounds && r.width > 0 ? car3d.renderedBounds.width / r.width : null,
            carHeightShare: car3d.renderedBounds && r.height > 0 ? car3d.renderedBounds.height / r.height : null,
            display: (({ mode, lineId, shift, lat, lon, reason }) => ({ mode, lineId, shift, lat, lon, reason }))(displayStore.get()),
            look: settingsStore.get().mapLook,
            camera: {
              style: guiding.current ? camStyle : effectiveNavCamera(settingsStore.get().navCamera, isGame()),
              lift: +lift.value.toFixed(3),
              ...cameraSnapshot(),
              fov: map.getVerticalFieldOfView(),
              toStepM: navStore.get().progress?.toStepM ?? null,
              step: (() => {
                const n = navStore.get();
                const st = n.route && n.progress ? n.route.steps[n.progress.stepIndex] : null;
                return st ? `${st.type}${st.modifier ? ' ' + st.modifier : ''}` : null;
              })(),
            },
            gameLayers: ['game-buildings', 'game-roofs', 'game-trees'].filter((id) => !!map.getLayer(id)),
            palette: appliedPalette,
            nightLayers: ['game-road-glow', 'game-road-sheen', 'game-lamps'].filter((id) => !!map.getLayer(id)),
            windows: !!map.getLayer('game-buildings') && !!map.getPaintProperty('game-buildings', 'fill-extrusion-pattern'),
            styleReady: !!(map as unknown as { style?: { _loaded?: boolean } }).style?._loaded,
            raw: { lat: geoStore.get().lat, lon: geoStore.get().lon },
            nativePosition: { source: geoStore.get().source, trust: geoStore.get().nativeTrust, speedSource: geoStore.get().speedSource, reason: geoStore.get().nativeReason, status: geoStore.get().status, error: geoStore.get().lastError?.message },
            accuracyCircle: accShown,
            routePoints: (p.autonomous ? autonomyMap.get().route : navStore.get().route)?.coords.length ?? 0,
            routeTrim: (() => {
              const s = navStore.get();
              const c = shownCoords ?? [];
              const first = c[0] ? [c[0].lon, c[0].lat] : null;
              return { cut: Math.round(s.routeCutM), total: Math.round(cumulative(s.route?.coords ?? []).at(-1) ?? 0), shownPoints: c.length, first };
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
        mapPositionStore.set(null);
        mapCameraStore.set(null);
        map.remove();
        mapRef.current = null;
      });
      // Начальное состояние (маршрут, метки, позиция) — сразу после загрузки.
      if (!p.autonomous) {
        drawPoi();
        drawPick();
      }
      const d = displayStore.get();
      const geo = geoStore.get();
      const g = p.autonomous ? autonomyMap.get().position : androidDriving && (geo.accuracy ?? Infinity) > 50 && geo.nativeTrust !== 'network' ? null :
        d.lat != null ? d : geo;
      if (g && g.lat != null && g.lon != null) {
        to = { lat: g.lat, lon: g.lon };
        headingTarget = g.heading;
        headingShown = g.heading ?? 0;
        if (androidDriving) animation.receive({ lat: g.lat, lon: g.lon, heading: g.heading, speedMps: null, reliable: true }, performance.now());
        if (!ordinaryMap() && (!p.autonomous || guiding.current || !autonomyMap.get().route)) {
          map.jumpTo({ center: [g.lon, g.lat] });
        }
        camera.current(true);
      }
      drawMapPosition.current();
    })();
    return () => {
      disposed = true;
      drawMapPosition.current = () => {};
      if (androidDriving && !p.autonomous) recordLocationMarker('map-not-ready');
      cleanups.forEach((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Следование и режим ведения от общего интерфейса.
  useEffect(() => {
    drawMapPosition.current();
    camera.current(true);
  }, [p.follow, p.guiding, settings.cameraMode]);

  return <div ref={el} className="map ml-map" />;
}
