import { locateOnAndroid } from '../lib/nav';
import { usesAndroidNativePosition } from '../lib/geo/nativePosition';
import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { offlineStatus } from '../lib/offlineMaps';
import { androidDriving, ANDROID_OVERVIEW, maneuverNotice } from '../lib/androidDriving';
import { CONTROLS_IDLE_MS, verticalSwipe } from '../lib/drivingControls';
import type { MapApi } from './MapLibreMap';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Icon } from '../components/Icon';
import { useStore } from '../lib/store';
import {
  geoStore,
  startGeo,
  searchPlaces,
  navQueryStore,
  favoritesStore,
  recentsStore,
  toggleFavorite,
  routeLinks,
  navStore,
  setDestination,
  startGuidance,
  stopNavigation,
  poiStore,
  findPoi,
  clearPoi,
  addStop,
  removeStop,
  placeFromPoi,
  geoHelp,
  navLang,
  currentPos,
  readLastPos,
  geoStatusText,
  guidanceStartCount,
  setNavigationVoice,
  pickStore,
  pickPoint,
  cancelPick,
  routeToPick,
  addPickAsStop,
  selectRoute,
  savedPlacesStore,
  setSavedPlace,
  type Place,
  visibleRouteCoords,
} from '../lib/nav';
import { LongPressDetector } from '../lib/geo/longpress';
import { fmtCoords } from '../lib/geo/geocode';
import { carSvg, unwrapAngle, type CarColor } from '../lib/carMarker';
import { lookAheadOffset, speedBand } from '../lib/camera';
import { settingsStore, driveUiStore, setMinimal, openSection } from '../lib/state';
import { startVoice } from '../lib/voice';
import { openHud } from '../lib/hud';
import { displayStore } from '../lib/matching/display';
import { diagModeStore, mapDiag } from '../lib/diag';
import { DiagOverlay } from './DiagOverlay';
import { MyPlacesSection, openPlaceEditor } from '../components/MyPlaces';
import { effectiveEngine, webglAvailable, mapRuntimeStore, engineFallback } from '../lib/mapEngine';
import { stepText, stepIcon, fmtDistance, fmtDuration, haversine } from '../lib/routing';
import { POI_CATEGORIES, type PoiCategory, type Poi } from '../lib/poi';
import { toast } from '../lib/state';
import { themeStore, THEMES } from '../lib/theme';

const DEFAULT_CENTER: L.LatLngTuple = [55.7539, 37.6208];
/** Карта MapLibre загружается только при выборе этого движка (1,5 МБ). */
const MapLibreMap = lazy(() => import('./MapLibreMap').then((m) => ({ default: m.MapLibreMap })));

export const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">Участники OpenStreetMap</a>';

/** Машинка: внешний элемент двигает Leaflet, внутренний (.car-rot) поворачиваем на курс. */
const carIcon = (color: CarColor) =>
  L.divIcon({ className: 'map-car', html: `<div class="car-rot">${carSvg(color)}</div>`, iconSize: [30, 52], iconAnchor: [15, 26] });
const destIcon = L.divIcon({ className: 'map-dest', html: '<div class="map-dest-pin"></div>', iconSize: [36, 46], iconAnchor: [18, 44] });
const pickIcon = L.divIcon({ className: 'map-dest', html: '<div class="map-dest-pin is-pick"></div>', iconSize: [36, 46], iconAnchor: [18, 44] });
const viaIcon = L.divIcon({ className: 'map-dest', html: '<div class="map-dest-pin is-via"></div>', iconSize: [30, 40], iconAnchor: [15, 38] });
const poiIcon = (c: PoiCategory) =>
  L.divIcon({ className: 'map-poi', html: `<div class="map-poi-dot poi-${c}"></div>`, iconSize: [22, 22], iconAnchor: [11, 11] });

const POI_ICONS: Record<PoiCategory, 'fuel' | 'cup' | 'parking' | 'clock'> = { fuel: 'fuel', food: 'cup', parking: 'parking', rest: 'clock' };

/** Сколько показываем весь маршрут после «Поехали», прежде чем камера пойдёт за машиной. */
export const OVERVIEW_MS = 3000;

function eta(sec: number) {
  return new Date(Date.now() + sec * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

/** Показать область так, чтобы её не закрывали поиск сверху, кнопки справа и карточка снизу. */
function fitVisible(m: L.Map, b: L.LatLngBounds, ui: HTMLElement | null) {
  const box = m.getContainer().getBoundingClientRect();
  const r = (sel: string) => ui?.querySelector<HTMLElement>(sel)?.getBoundingClientRect();
  const top = r('.map-top');
  const cards = r('.map-cards');
  const ctl = r('.map-controls');
  const padTop = top && top.height ? top.bottom - box.top + 16 : 40;
  const padBottom = cards && cards.height ? box.bottom - cards.top + 16 : 40;
  const padRight = ctl && ctl.width ? box.right - ctl.left + 12 : 40;
  // Если места почти не осталось (низкий экран) — хотя бы часть карты.
  const free = box.height - padTop - padBottom;
  const k = free < 120 ? 0.4 : 1;
  m.fitBounds(b, { paddingTopLeft: [40, padTop * k], paddingBottomRight: [padRight, padBottom * k], maxZoom: 16 });
}

export function Navigation({ onAutonomy, androidMenu, onAndroidMenu }: {
  onAutonomy?: () => void; androidMenu?: boolean; onAndroidMenu?: () => void;
}) {
  const uiEl = useRef<HTMLDivElement>(null);
  const mapEl = useRef<HTMLDivElement>(null);
  const themeOnly = useRef(false);
  const fitted = useRef<unknown>(null);
  const map = useRef<L.Map | null>(null);
  const layers = useRef<{ me?: L.Marker; acc?: L.Circle; raw?: L.CircleMarker; dest?: L.Marker; via?: L.Marker; pick?: L.Marker; route?: L.LayerGroup; routeLines?: L.Polyline[]; poi?: L.LayerGroup }>({});
  const pick = useStore(pickStore);
  const geo = useStore(geoStore);
  const offline = useStore(offlineStatus);
  const nav = useStore(navStore);
  const poi = useStore(poiStore);
  const navQuery = useStore(navQueryStore);
  const favorites = useStore(favoritesStore);
  const recents = useStore(recentsStore);
  const saved = useStore(savedPlacesStore);
  const theme = useStore(themeStore);
  const settings = useStore(settingsStore);
  const carColor = androidDriving ? 'white' : settings.carColor;
  const runtime = useStore(mapRuntimeStore);
  const disp = useStore(displayStore);
  const diag = useStore(diagModeStore);
  const engine = effectiveEngine(settings.mapEngine, runtime.fallback, webglAvailable());
  // Диагностика: смена движка (в т. ч. резерв MapLibre → Leaflet) записывается в журнал событий карты.
  useEffect(() => mapDiag.event(`движок: ${engine}${runtime.fallback ? ` (резерв: ${runtime.fallback})` : ''}`), [engine, runtime.fallback]);
  const mlApi = useRef<MapApi | null>(null);
  const ui = useStore(driveUiStore);
  const geoStatus = geoStatusText(geo);

  const [follow, setFollow] = useState(true);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Place[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [showSteps, setShowSteps] = useState(false);
  const [showLinks, setShowLinks] = useState(false);
  const guiding = nav.status === 'guiding';
  const lang = navLang();
  const [cueClock, setCueClock] = useState(Date.now);
  useEffect(() => {
    if (!androidDriving || !guiding) return;
    const timer = window.setInterval(() => setCueClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [guiding]);

  // Инициализация карты (Leaflet — резервный движок; MapLibre — отдельный компонент)
  // Геопозиция запускается при открытии карты для любого движка (раньше — только из инициализации Leaflet,
  // и с MapLibre при ещё не выданном разрешении позиция не запрашивалась вовсе).
  useEffect(() => startGeo(), []);

  useEffect(() => {
    if (engine !== 'leaflet' || !mapEl.current || map.current) return;
    // Пока нет точки GPS — карта там, где была последняя точная позиция (машинку по ней не рисуем).
    const last = readLastPos();
    const m = L.map(mapEl.current, { zoomControl: false, attributionControl: true }).setView(last ? [last.lat, last.lon] : androidDriving ? [ANDROID_OVERVIEW.lat, ANDROID_OVERVIEW.lon] : DEFAULT_CENTER, last ? 14 : androidDriving ? 2 : 13);
    // Стандартный слой OpenStreetMap: без ключа, по правилам tile.openstreetmap.org
    // (атрибуция со ссылкой, браузер передаёт Referer). Ночью тайлы затемняются CSS-фильтром.
    // Прежний слой CARTO без договора и ключа отдавал тайлы с надписью «API KEY REQUIRED».
    L.tileLayer(OSM_TILES, { maxZoom: 19, attribution: OSM_ATTRIBUTION }).addTo(m);
    m.on('dragstart', () => setFollow(false));
    map.current = m;

    // Выбор точки: долгое нажатие пальцем (iPad, iPhone, Android) или правый клик мышью.
    const el = mapEl.current;
    const ignore = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('.leaflet-marker-icon, .leaflet-control, .leaflet-interactive');
    const lp = new LongPressDetector({
      delay: 600,
      tolerance: 10,
      onLongPress: (x, y) => {
        const r = el.getBoundingClientRect();
        const ll = m.containerPointToLatLng([x - r.left, y - r.top]);
        navigator.vibrate?.(25);
        void pickPoint({ lat: ll.lat, lon: ll.lng });
      },
    });
    let lastTouch = 0;
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      lastTouch = Date.now();
      if (ignore(e.target)) return lp.reset();
      lp.down(e.pointerId, e.clientX, e.clientY);
    };
    const onMove = (e: PointerEvent) => e.pointerType !== 'mouse' && lp.move(e.pointerId, e.clientX, e.clientY);
    const onUp = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      lastTouch = Date.now();
      lp.up(e.pointerId);
    };
    const onCancel = () => lp.reset();
    // capture: Leaflet останавливает часть событий на своих обработчиках.
    el.addEventListener('pointerdown', onDown, true);
    el.addEventListener('pointermove', onMove, true);
    el.addEventListener('pointerup', onUp, true);
    el.addEventListener('pointercancel', onCancel, true);
    // Касание вторым пальцем без pointer-событий (старый WebKit) — тоже отмена.
    const onTouch = (e: TouchEvent) => e.touches.length > 1 && lp.reset();
    el.addEventListener('touchstart', onTouch, { capture: true, passive: true });
    m.on('zoomstart', () => lp.cancel());
    m.on('contextmenu', (e: L.LeafletMouseEvent) => {
      // На сенсорных экранах системный contextmenu дублирует долгое нажатие — его уже обработали.
      if (Date.now() - lastTouch < 1500 || Date.now() - lp.lastFired < 1500) return;
      void pickPoint({ lat: e.latlng.lat, lon: e.latlng.lng });
    });

    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(mapEl.current);
    return () => {
      ro.disconnect();
      lp.reset();
      el.removeEventListener('pointerdown', onDown, true);
      el.removeEventListener('pointermove', onMove, true);
      el.removeEventListener('pointerup', onUp, true);
      el.removeEventListener('pointercancel', onCancel, true);
      el.removeEventListener('touchstart', onTouch, true);
      m.remove();
      map.current = null;
      layers.current = {};
    };
  }, [engine]);

  // MapLibre: камера при новом маршруте (обзор вариантов) и цели без маршрута; отрисовку делает MapLibreMap.
  const mlFitted = useRef<unknown>(null);
  useEffect(() => {
    if (engine !== 'maplibre') return;
    const api = mlApi.current;
    if (nav.route && nav.status === 'preview' && mlFitted.current !== nav.routes) {
      mlFitted.current = nav.routes;
      setFollow(false);
      requestAnimationFrame(() => mlApi.current?.fitPoints(nav.routes.flatMap((r) => r.coords), uiEl.current));
    } else if (!nav.route && nav.dest && nav.status === 'preview' && api) {
      setFollow(false);
      api.centerOn(nav.dest, 15);
    }
  }, [engine, nav.route, nav.routes, nav.dest, nav.status]);

  // Позиция пользователя: машинка, круг точности, камера
  const carAngle = useRef(0);
  const zoomBand = useRef<number | null>(null);
  useEffect(() => {
    const m = map.current;
    if (!m || geo.lat == null || geo.lon == null || (androidDriving && !layers.current.me && (geo.accuracy ?? Infinity) > 50)) return;
    // Машинка и камера — по отображаемой позиции (привязка к дороге); круг точности — вокруг сырой точки GPS.
    const shown = disp.lat != null && disp.lon != null ? { lat: disp.lat, lon: disp.lon, heading: disp.heading } : geo;
    const raw: L.LatLngTuple = [geo.lat, geo.lon];
    const ll: L.LatLngTuple = [shown.lat!, shown.lon!];
    const l = layers.current;
    if (!l.me) l.me = L.marker(ll, { icon: carIcon(carColor), interactive: false, zIndexOffset: 1000 }).addTo(m);
    else l.me.setLatLng(ll);
    // Круг точности — только когда она заметна: видно, что позиция приблизительная.
    const acc = geo.accuracy ?? 0;
    if (acc > 30) {
      if (!l.acc) l.acc = L.circle(raw, { radius: acc, className: 'map-accuracy', interactive: false, weight: 1 }).addTo(m);
      else l.acc.setLatLng(raw).setRadius(acc);
    } else {
      l.acc?.remove();
      l.acc = undefined;
    }
    // Диагностический режим: сырая точка GPS отдельным маркером.
    if (diag.on) {
      if (!l.raw) l.raw = L.circleMarker(raw, { radius: 7, color: '#fff', weight: 2, fillColor: getComputedStyle(document.documentElement).getPropertyValue('--danger').trim() || 'red', fillOpacity: 1, interactive: false }).addTo(m);
      else l.raw.setLatLng(raw);
    } else {
      l.raw?.remove();
      l.raw = undefined;
    }
    const rot = l.me.getElement()?.querySelector<HTMLElement>('.car-rot');
    if (rot && shown.heading != null) {
      carAngle.current = unwrapAngle(carAngle.current, shown.heading);
      rot.style.transform = `rotate(${carAngle.current}deg)`;
    }
    if (follow) {
      if (!guiding) {
        m.setView(ll, Math.max(m.getZoom(), 15), { animate: true });
      } else {
        // Масштаб — по скорости, но только при смене полосы скорости: щипок пользователя не сбрасываем на каждой точке.
        const band = speedBand(geo.speedKmh);
        const zoom = band !== zoomBand.current ? band : m.getZoom();
        zoomBand.current = band;
        // Упреждение: машинка ниже центра по ходу движения — впереди видно больше дороги.
        let target = L.latLng(ll);
        if (shown.heading != null) {
          const size = m.getSize();
          const [dx, dy] = lookAheadOffset(shown.heading, size.x, size.y);
          target = m.unproject(m.project(target, zoom).add([dx, dy]), zoom);
        }
        // Плавно и линейно, без рывков между точками GPS (раз в ~1 с).
        if (zoom !== m.getZoom()) m.setView(target, zoom, { animate: true });
        else m.panTo(target, { animate: true, duration: 0.9, easeLinearity: 1, noMoveStart: true });
      }
    }
  }, [geo.lat, geo.lon, geo.heading, geo.accuracy, disp.lat, disp.lon, disp.heading, diag.on, follow, guiding, carColor, engine]);

  // Цвет машинки из настроек
  useEffect(() => {
    const me = layers.current.me;
    if (!me) return;
    me.setIcon(carIcon(carColor));
    const rot = me.getElement()?.querySelector<HTMLElement>('.car-rot');
    if (rot) rot.style.transform = `rotate(${carAngle.current}deg)`;
  }, [carColor, engine]);

  // Маршрут, цель и промежуточная точка
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const l = layers.current;
    l.route?.remove();
    l.dest?.remove();
    l.via?.remove();
    l.route = l.dest = l.via = l.routeLines = undefined;
    if (nav.dest) l.dest = L.marker([nav.dest.lat, nav.dest.lon], { icon: destIcon }).addTo(m);
    if (nav.via) l.via = L.marker([nav.via.lat, nav.via.lon], { icon: viaIcon }).addTo(m);
    if (nav.route) {
      const pts = visibleRouteCoords(nav).map((c) => [c.lat, c.lon] as L.LatLngTuple);
      const tk = THEMES[theme.active];
      // Альтернативы — серые линии под основной; нажатие выбирает вариант.
      const alts = nav.status === 'guiding' ? [] : nav.routes.map((r, i) => ({ r, i })).filter(({ i }) => i !== nav.routeIndex);
      const altLines = alts.flatMap(({ r, i }) => {
        const ap = r.coords.map((c) => [c.lat, c.lon] as L.LatLngTuple);
        return [
          L.polyline(ap, { color: tk['route-casing'], weight: 10, opacity: 0.55, className: 'route-alt' }).on('click', () => selectRoute(i)),
          L.polyline(ap, { color: tk.muted, weight: 6, opacity: 0.8, className: 'route-alt' }).on('click', () => selectRoute(i)),
        ];
      });
      l.routeLines = [
        L.polyline(pts, { color: tk['route-casing'], weight: 14, opacity: 0.9, interactive: false, lineCap: 'round', lineJoin: 'round' }),
        L.polyline(pts, { color: tk.route, weight: 9, opacity: 1, interactive: false, className: 'route-main', lineCap: 'round', lineJoin: 'round' }),
      ];
      l.route = L.layerGroup([...altLines, ...l.routeLines]).addTo(m);
      // Камера подстраивается под новый набор вариантов, но не при выборе варианта или смене темы.
      if (nav.status === 'preview' && !themeOnly.current && fitted.current !== nav.routes) {
        fitted.current = nav.routes;
        setFollow(false);
        const b = L.latLngBounds(pts);
        alts.forEach(({ r }) => r.coords.forEach((c) => b.extend([c.lat, c.lon])));
        // Карточка маршрута отрисовывается в этом же кадре — меряем после него.
        requestAnimationFrame(() => fitVisible(m, b, uiEl.current));
      }
    } else if (nav.dest && nav.status === 'preview') {
      setFollow(false);
      m.setView([nav.dest.lat, nav.dest.lon], 15);
    }
    themeOnly.current = false;
  }, [nav.route, nav.routes, nav.routeIndex, nav.dest, nav.via, nav.status, theme.active, engine]);

  useEffect(() => {
    const pts = visibleRouteCoords(nav).map((c) => [c.lat, c.lon] as L.LatLngTuple);
    layers.current.routeLines?.forEach((line) => line.setLatLngs(pts));
  }, [nav.route, nav.routes, nav.routeIndex, nav.dest, nav.via, nav.status, nav.routeCutM, theme.active, engine]);

  // Выбранная точка (долгое нажатие / результат поиска)
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    layers.current.pick?.remove();
    layers.current.pick = undefined;
    if (!pick) return;
    layers.current.pick = L.marker([pick.lat, pick.lon], { icon: pickIcon, interactive: false, zIndexOffset: 900 }).addTo(m);
    if (pick.origin === 'search') {
      setFollow(false);
      m.setView([pick.lat, pick.lon], Math.max(m.getZoom(), 16));
    } else if (!m.getBounds().pad(-0.15).contains([pick.lat, pick.lon])) {
      m.panTo([pick.lat, pick.lon]);
    }
  }, [pick?.lat, pick?.lon, pick?.origin, pick, engine]);

  // Смена темы перерисовывает линию маршрута, но не двигает камеру.
  const prevTheme = useRef(theme.active);
  if (prevTheme.current !== theme.active) {
    prevTheme.current = theme.active;
    themeOnly.current = true;
  }

  // Начало ведения: сначала весь маршрут, затем камера следует за машиной.
  const [overview, setOverview] = useState(false);
  const shownStart = useRef(0);
  useEffect(() => {
    const m = map.current;
    if (!guiding) {
      setOverview(false);
      return;
    }
    // Обзор — только после «Поехали», не после перестроения или добавления остановки.
    if (guidanceStartCount() === shownStart.current) return;
    shownStart.current = guidanceStartCount();
    const r = navStore.get().route;
    if (engine === 'maplibre' && r) {
      if (androidDriving) {
        setFollow(true);
        return;
      }
      setFollow(false);
      setOverview(true);
      const fit = setTimeout(() => {
        mlApi.current?.resize();
        mlApi.current?.fitPoints(r.coords, uiEl.current);
      }, 120);
      const t = setTimeout(() => {
        setOverview(false);
        setFollow(true);
      }, OVERVIEW_MS);
      return () => {
        clearTimeout(t);
        clearTimeout(fit);
      };
    }
    if (!m || !r) {
      setFollow(true);
      return;
    }
    setFollow(false);
    setOverview(true);
    const rb = L.latLngBounds(r.coords.map((c) => [c.lat, c.lon] as L.LatLngTuple));
    // Карта меняет размер при переходе в полный экран — обзор после перестроения раскладки.
    const fit = setTimeout(() => {
      m.invalidateSize();
      fitVisible(m, rb, uiEl.current);
    }, 120);
    const t = setTimeout(() => {
      setOverview(false);
      setFollow(true);
    }, OVERVIEW_MS);
    return () => {
      clearTimeout(t);
      clearTimeout(fit);
    };
  }, [guiding]);

  const showOverview = () => {
    const m = map.current;
    const r = navStore.get().route;
    if (r && engine === 'maplibre') {
      setFollow(false);
      mlApi.current?.fitPoints(r.coords, uiEl.current);
      return;
    }
    if (!m || !r) return;
    setFollow(false);
    fitVisible(m, L.latLngBounds(r.coords.map((c) => [c.lat, c.lon] as L.LatLngTuple)), uiEl.current);
  };
  // Во время перестроения (статус «строю») полноэкранный режим сохраняется.
  const [panelHidden, setPanelHidden] = useState(false);
  const hideControls = () => {
    setPanelHidden(true);
    if (androidDriving && androidMenu) onAndroidMenu?.();
    if (driveUiStore.get().sheet) driveUiStore.set((s) => ({ ...s, sheet: false }));
  };
  const showControls = () => {
    setPanelHidden(false);
    if (ui.minimal) driveUiStore.set((s) => ({ ...s, sheet: true }));
  };
  const revealSwipe = useVerticalSwipe(showControls, () => {});
  const cardSwipe = useVerticalSwipe(() => {}, hideControls);

  useEffect(() => {
    if (!guiding) {
      setPanelHidden(false);
      return;
    }
    if (panelHidden) return;
    let timer: ReturnType<typeof setTimeout>;
    const pointers = new Set<number>();
    const reset = () => {
      clearTimeout(timer);
      if (!pointers.size) timer = setTimeout(hideControls, CONTROLS_IDLE_MS);
    };
    const down = (e: PointerEvent) => {
      pointers.add(e.pointerId);
      reset();
    };
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      reset();
    };
    const blur = () => {
      pointers.clear();
      reset();
    };
    const activity = ['pointermove', 'wheel', 'keydown', 'click'] as const;
    const options = { capture: true, passive: true };
    for (const event of activity) window.addEventListener(event, reset, options);
    window.addEventListener('pointerdown', down, options);
    window.addEventListener('pointerup', up, options);
    window.addEventListener('pointercancel', up, options);
    window.addEventListener('blur', blur);
    reset();
    return () => {
      clearTimeout(timer);
      for (const event of activity) window.removeEventListener(event, reset, true);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('blur', blur);
    };
  }, [guiding, panelHidden, androidMenu]);

  const minimal = !androidDriving && ui.minimal && !!nav.dest && (guiding || nav.status === 'routing');

  const recenter = () => {
    setOverview(false);
    setFollow(true);
    const native = usesAndroidNativePosition();
    if (!native) startGeo();
    else void locateOnAndroid().then((message) => {
      const fix = geoStore.get();
      if (fix.nativeTrust === 'network' && fix.lat != null && fix.lon != null) {
        mlApi.current?.centerOn({ lat: fix.lat, lon: fix.lon }, 15);
      }
      toast(message);
    });
    zoomBand.current = null; // масштаб по скорости — заново
    const target = disp.lat != null && disp.lon != null ? disp : geo;
    if (target.lat != null && target.lon != null) {
      if (engine === 'maplibre' && androidDriving && guiding) mlApi.current?.resumeFollow?.();
      else if (engine === 'maplibre') mlApi.current?.centerOn({ lat: target.lat, lon: target.lon }, guiding ? undefined : 16);
      else map.current?.setView([target.lat, target.lon], guiding ? 17 : 16);
    }
    else if (native) toast('Запрашиваю место у Android…');
    else if (geo.status === 'denied') toast(`Геопозиция запрещена. ${geoHelp()}`, 'warn');
    else toast('Ищу геопозицию…');
  };

  // Объекты по пути
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    layers.current.poi?.remove();
    layers.current.poi = undefined;
    if (!poi.items.length) return;
    layers.current.poi = L.layerGroup(
      poi.items.map((p) =>
        L.marker([p.lat, p.lon], { icon: poiIcon(p.category), title: p.name }).on('click', () => void addStop(placeFromPoi(p))),
      ),
    ).addTo(m);
  }, [poi.items, engine]);

  // Голосовой запрос «маршрут до …»
  useEffect(() => {
    if (!navQuery) return;
    setQuery(navQuery.query);
    void runSearch(navQuery.query, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navQuery?.nonce]);

  async function runSearch(q: string, pickFirst = false) {
    if (!q.trim()) return;
    setSearching(true);
    setError(null);
    setPanelOpen(true);
    try {
      const r = await searchPlaces(q, currentPos() ?? undefined);
      setResults(r);
      if (!r.length) setError('Ничего не найдено');
      else if (pickFirst) selectPlace(r[0]);
    } catch (e) {
      setError(navigator.onLine ? (e as Error).message : 'Нет подключения к интернету');
    } finally {
      setSearching(false);
    }
  }

  /** Результат поиска: точка на карте и карточка с «Маршрут сюда». */
  function showPlace(p: Place) {
    setPanelOpen(false);
    (document.activeElement as HTMLElement | null)?.blur();
    void pickPoint(p, 'search', p);
  }

  function selectPlace(p: Place) {
    setPanelOpen(false);
    setShowSteps(false);
    setShowLinks(false);
    void setDestination(p);
  }

  const zoom = (d: number) => {
    if (engine === 'maplibre') mlApi.current?.zoomBy?.(d);
    else map.current?.setZoom((map.current?.getZoom() ?? 13) + d);
  };
  const isFav = nav.dest ? favorites.some((f) => f.lat === nav.dest!.lat && f.lon === nav.dest!.lon) : false;
  const step = nav.route && nav.progress ? nav.route.steps[nav.progress.stepIndex] : null;
  const next = nav.route && nav.progress ? nav.route.steps[nav.progress.stepIndex + 1] : null;
  const located = geo.lat != null && geo.lon != null && ((geo.accuracy ?? Infinity) <= 50 || geo.nativeTrust === 'network');
  const trustedGeo = located && !geo.held && cueClock - (geo.updated ?? 0) <= 3500;
  const navReliable = trustedGeo && (nav.progress?.offRouteM ?? Infinity) <= 35;
  const cue = androidDriving && guiding ? maneuverNotice(nav.route, nav.progress, geo.speedKmh, navReliable) : null;
  const lastCue = useRef(cue);
  if (cue) lastCue.current = cue;
  const paintedCue = cue ?? lastCue.current;
  const remainingS = nav.route && nav.progress ? nav.route.duration * (nav.progress.remainingM / Math.max(1, nav.route.distance)) : null;
  const straight = nav.dest && geo.lat != null && geo.lon != null ? haversine({ lat: geo.lat, lon: geo.lon }, nav.dest) : null;

  return (
    <div className={`navigation ${guiding ? 'android-guiding' : ''}`} onPointerDownCapture={() => { if (androidDriving && guiding && panelHidden) setPanelHidden(false); }}>
      {engine === 'maplibre' ? (
        <Suspense fallback={<div className="map" />}>
          <MapErrorBoundary>
            <MapLibreMap apiRef={mlApi} uiEl={uiEl} follow={follow} guiding={guiding} onUserMove={() => setFollow(false)} />
          </MapErrorBoundary>
        </Suspense>
      ) : (
        <div ref={mapEl} className="map" />
      )}

      <div
        ref={uiEl}
        className={`map-ui ${(nav.dest && !guiding) || pick ? 'has-dest' : ''} ${nav.dest || poi.category || pick ? 'has-card' : ''} ${minimal ? 'is-minimal' : ''} ${guiding && panelHidden ? 'controls-hidden' : ''}`}
      >
        {/* Верх: поиск или манёвр */}
        <div className="map-top">
          {!androidDriving && onAutonomy && !guiding && !nav.dest && <button className="btn autonomy-entry" onClick={onAutonomy}>GPS показывает неверное местоположение</button>}
          {androidDriving && guiding ? (
            <div className={`android-cue ${cue ? 'is-visible' : ''} ${cue?.urgent ? 'is-urgent' : ''}`} aria-hidden={!cue}>
              {paintedCue && <>
                <Icon name={stepIcon(paintedCue.step)} size="1.65rem" stroke={2.4} />
                <div><strong>{paintedCue.distance == null ? 'Положение уточняется' : paintedCue.distance < 10 ? 'Сейчас' : fmtDistance(paintedCue.distance, lang)}</strong>
                  <span>{stepText(paintedCue.step, lang)}</span></div>
              </>}
            </div>
          ) : minimal && !(step && nav.progress) ? (
            <div className="maneuver" role="status">
              <div className="maneuver-text">
                <div className="maneuver-instr">{nav.rerouting ? 'Перестраиваю маршрут…' : 'Ведение по маршруту'}</div>
              </div>
            </div>
          ) : guiding && step && nav.progress ? (
            <div className="maneuver" role="status">
              <div className="maneuver-icon">
                <Icon name={stepIcon(step)} size="1.85rem" stroke={2.2} />
              </div>
              <div className="maneuver-text">
                <div className="maneuver-dist">{fmtDistance(nav.progress.toStepM, lang)}</div>
                <div className="maneuver-instr">{stepText(step, lang)}</div>
                {next && nav.progress.toStepM < 1000 && (
                  <div className="maneuver-next">
                    Затем: {stepText(next, lang)}
                  </div>
                )}
              </div>
              {nav.rerouting && <span className="badge badge-warn">Перестраиваю…</span>}
              {nav.notice && !nav.rerouting && <span className="badge badge-warn maneuver-notice">{nav.notice}</span>}
            </div>
          ) : (
            <form
              className="map-search"
              onSubmit={(e) => {
                e.preventDefault();
                void runSearch(query);
                (document.activeElement as HTMLElement | null)?.blur();
              }}
            >
              <Icon name="search" size="1.5rem" />
              <input
                id="map-search"
                className="map-search-input"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  // Строка стёрта — снова «Мои места» и подсказки, а не результаты прошлого поиска.
                  if (!e.target.value.trim()) setResults(null);
                }}
                onFocus={() => setPanelOpen(true)}
                placeholder="Куда едем?"
                enterKeyHint="search"
                autoComplete="off"
              />
              {(query || panelOpen) && (
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => {
                    setQuery('');
                    setResults(null);
                    setPanelOpen(false);
                  }}
                  aria-label="Очистить поиск"
                >
                  <Icon name="close" />
                </button>
              )}
            </form>
          )}

          {panelOpen && !guiding && (
            <div className="map-panel">
              {searching && <div className="list-note">Поиск…</div>}
              {error && <div className="list-note text-warn">{error}</div>}
              {results?.map((p) => {
                const d = geo.lat != null && geo.lon != null ? haversine({ lat: geo.lat, lon: geo.lon }, p) : null;
                return (
                  <button key={p.id} className="place-row" onClick={() => showPlace(p)}>
                    <Icon name="gps" size="1.5rem" />
                    <span>
                      <strong>{p.name}</strong>
                      <small>{[p.kind, p.address].filter(Boolean).join(' · ')}</small>
                    </span>
                    {d != null && <small className="place-dist">{fmtDistance(d, lang)}</small>}
                  </button>
                );
              })}
              {!results && !searching && (
                <>
                  {(saved.home || saved.work) && (
                    <div className="home-work">
                      {saved.home && (
                        <button className="btn btn-lg btn-primary" onClick={() => selectPlace(saved.home!)}>
                          <Icon name="home" /> Домой
                        </button>
                      )}
                      {saved.work && (
                        <button className="btn btn-lg" onClick={() => selectPlace(saved.work!)}>
                          <Icon name="flag" /> На работу
                        </button>
                      )}
                    </div>
                  )}
                  <MyPlacesSection onRoute={selectPlace} />
                  <div className="poi-chips">
                    {(Object.keys(POI_CATEGORIES) as PoiCategory[]).map((c) => (
                      <button
                        key={c}
                        className="chip"
                        onClick={() => {
                          setPanelOpen(false);
                          void findPoi(c);
                        }}
                      >
                        <Icon name={POI_ICONS[c]} size="1.2em" /> {POI_CATEGORIES[c].label} рядом
                      </button>
                    ))}
                  </div>
                  {recents.length > 0 && <div className="list-head">Недавние</div>}
                  {recents.map((p) => (
                    <button key={p.id + p.lat} className="place-row" onClick={() => selectPlace(p)}>
                      <Icon name="clock" size="1.5rem" />
                      <span>
                        <strong>{p.name}</strong>
                        <small>{p.address}</small>
                      </span>
                    </button>
                  ))}
                  {!favorites.length && !recents.length && (
                    <div className="list-note">Введите адрес или скажите «Маршрут до …». Или зажмите палец на карте, чтобы выбрать точку.</div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* Справа: управление картой */}
        {(!androidDriving || androidMenu) && <DiagOverlay engine={engine} />}
        {androidDriving && offline.local && (
          <div className="android-offline-tag" role="status">{offline.region ? `Офлайн · ${offline.region}` : 'Нет загруженной карты'}</div>
        )}
        {androidDriving && (guiding && (!trustedGeo || nav.notice) || !guiding && located && !panelOpen && !androidMenu &&
          geo.nativeTrust != null && geo.nativeTrust !== 'confirmed') && <div className="android-position-tag" role="status">
          {guiding && nav.notice ? nav.notice : geo.nativeTrust === 'network' ? 'Приблизительная сетевая позиция' : geo.nativeTrust === 'estimated' ? 'Положение оценено по датчикам' : 'Положение не подтверждено'}
          {onAutonomy && !panelHidden && <button className="btn" onClick={() => {
            const active = navStore.get();
            if (active.route && active.dest && active.route.coords.length <= 20_000) {
              try { localStorage.setItem('ace:offline-autonomy-route', JSON.stringify({ route: active.route, destination: active.dest, at: Date.now() })); }
              catch { /* Keep the normal route if it cannot be handed off. */ return; }
            }
            stopNavigation();
            onAutonomy();
          }}>Старт вручную</button>}
        </div>}
        {androidDriving && !located && !guiding && !nav.dest && !pick && !panelOpen && !androidMenu && (
          <div className="android-locate card-float">
            <strong>Определите местоположение</strong>
            <div><button className="btn btn-primary" onClick={recenter}>Найти меня</button>
              {onAutonomy && <button className="btn" onClick={onAutonomy}>Старт вручную</button>}</div>
          </div>
        )}
        {androidDriving && androidMenu && (
          <div className="android-drive-menu card-float" role="group" aria-label="Дополнительные настройки">
            <button className="btn" onClick={() => openSection('settings')}>Настройки навигации и HUD</button>
            <button className="btn" onClick={() => openSection('diagnostics')}>Диагностика</button>
            {!guiding && onAutonomy && <button className="btn" onClick={onAutonomy}>GPS показывает неверное местоположение</button>}
            {geoStatus && <div>{geoStatus.text}</div>}
          </div>
        )}
        <div className={`map-controls ${androidDriving ? 'android-map-controls' : ''}`}>
          {androidDriving && <button className="map-ctl android-menu-button" onClick={onAndroidMenu} aria-label="Дополнительные настройки" aria-expanded={androidMenu}><Icon name="more" size="1.55rem" /></button>}
          {(!androidDriving || guiding) && <VoiceToggle className="map-ctl voice-ctl" />}
          {guiding && <HudButton className="map-ctl voice-ctl" />}
          {!androidDriving && engine === 'maplibre' && guiding && <CameraModeToggle className="map-ctl voice-ctl" />}
          <button className="map-ctl zoom-ctl" onClick={() => zoom(1)} aria-label="Приблизить">
            <Icon name="plus" size="1.7rem" />
          </button>
          <button className="map-ctl zoom-ctl" onClick={() => zoom(-1)} aria-label="Отдалить">
            <span className="map-minus" />
          </button>
          <button className={`map-ctl ${follow ? 'is-active' : 'recenter-needed'}`} onClick={recenter} aria-label={guiding && !follow ? 'Вернуться к автомобилю' : 'Моё местоположение'}>
            <Icon name="locate" size="1.7rem" />
          </button>
        </div>

        {/* Полноэкранное ведение: только время прибытия, остаток и голос; свайп вверх — панель управления. */}
        {!androidDriving && guiding && panelHidden && (
          <div className="driving-controls-compact">
            <button className="driving-reveal" aria-label="Показать панель управления" aria-expanded={false} onClick={showControls} {...revealSwipe.handlers}>
              <Icon name="chevronUp" size="1.4rem" />
            </button>
            <VoiceToggle className="guide-voice compact-voice" />
          </div>
        )}
        {minimal && nav.route && nav.progress && (
          <GuideBar
            eta={eta(remainingS ?? 0)}
            remaining={fmtDistance(nav.progress.remainingM, lang)}
            duration={fmtDuration(remainingS ?? 0, lang)}
            sheet={ui.sheet}
            hidden={panelHidden}
            onHide={hideControls}
            follow={follow}
            onRecenter={recenter}
            onOverview={showOverview}
          />
        )}

        {androidDriving && guiding && !panelHidden && (
          <div className="android-drive-shortcuts">
            <button className="btn" onClick={stopNavigation}>Завершить маршрут</button>
          </div>
        )}
        {/* Низ: скорость + карточка маршрута / объектов */}
        <div className="map-bottom">
          <div className="map-speed" aria-label="Скорость по GPS">
            <span className="map-speed-value">{geo.speedKmh != null ? `${geo.nativeTrust && geo.nativeTrust !== 'confirmed' ? '≈' : ''}${Math.round(geo.speedKmh)}` : '—'}</span>
            <span className="map-speed-unit">км/ч</span>
          </div>

          <div className="map-cards">
            {!androidDriving && geoStatus && (
              <button className={`geo-chip is-${geoStatus.tone}`} onClick={() => toast(geoStatus.help(), geoStatus.tone)} aria-live="polite">
                <Icon name={geoStatus.tone === 'warn' ? 'alert' : 'gps'} size="1.3em" />
                {geoStatus.text}
              </button>
            )}

            {poi.category && (
              <div className="poi-card card-float">
                <div className="poi-head">
                  <strong>
                    {POI_CATEGORIES[poi.category].label} {poi.mode === 'route' ? 'по маршруту' : 'рядом'}
                  </strong>
                  <span className="spacer" />
                  <button className="icon-btn" onClick={clearPoi} aria-label="Закрыть список">
                    <Icon name="close" />
                  </button>
                </div>
                {poi.loading && <div className="list-note">Ищу…</div>}
                {poi.error && <div className="list-note text-warn">{poi.error}</div>}
                <div className="poi-list">
                  {poi.items.map((p: Poi) => (
                    <button key={p.id} className="place-row" onClick={() => { void addStop(placeFromPoi(p)); clearPoi(); }}>
                      <Icon name={POI_ICONS[p.category]} size="1.5rem" />
                      <span>
                        <strong>{p.name}</strong>
                        <small>
                          {p.alongM != null
                            ? `через ${fmtDistance(Math.max(0, p.alongM))} · ${fmtDistance(p.detourM ?? 0)} от маршрута`
                            : p.distanceM != null
                              ? `${fmtDistance(p.distanceM)} по прямой`
                              : ''}
                          {p.openingHours ? ` · ${p.openingHours}` : ''}
                        </small>
                      </span>
                    </button>
                  ))}
                </div>
                <div className="list-note small">Данные OpenStreetMap: часы работы и цены могут быть неактуальны.</div>
              </div>
            )}

            {pick && (
              <div className="pick-card card-float" role="dialog" aria-label="Выбранная точка">
                <div className="route-head">
                  <div className="route-title">
                    <div className="dest-name">
                      {pick.place ? pick.place.name : pick.loading ? 'Определяю адрес…' : 'Точка на карте'}
                    </div>
                    <div className="muted small">
                      {pick.place?.address || (pick.failed ? 'Адрес не определён · ' : '')}
                      {!pick.place?.address && fmtCoords(pick)}
                    </div>
                    <div className="muted small pick-meta">
                      {pick.place?.address ? `${fmtCoords(pick)}` : ''}
                      {geo.lat != null && geo.lon != null ? `${pick.place?.address ? ' · ' : ''}${fmtDistance(haversine({ lat: geo.lat, lon: geo.lon }, pick), lang)} по прямой` : ''}
                    </div>
                  </div>
                </div>
                <div className="route-actions pick-actions">
                  <button className="btn btn-primary btn-lg" onClick={() => void routeToPick()}>
                    <Icon name="navigate" /> Маршрут сюда
                  </button>
                  {nav.dest && (
                    <button className="btn btn-lg" onClick={() => void addPickAsStop()}>
                      <Icon name="flag" /> Добавить остановку
                    </button>
                  )}
                  <button
                    className="btn btn-lg"
                    onClick={() => openPlaceEditor({ lat: pick.lat, lon: pick.lon, name: pick.place?.name ?? '', address: pick.place?.address ?? '', kind: pick.place?.kind })}
                  >
                    <Icon name="star" /> В мои места
                  </button>
                  <button className="btn btn-lg" onClick={cancelPick}>
                    Отмена
                  </button>
                </div>
              </div>
            )}

            {nav.dest && !poi.category && !pick && (
              <div className={`route-card card-float ${guiding ? 'is-guiding' : ''}`}>
                {guiding && nav.route && nav.progress ? (
                  <div className="route-guiding" {...cardSwipe.handlers}>
                    <button className="driving-hide" onClick={hideControls} aria-label="Скрыть панель управления" aria-expanded>
                      <span />
                    </button>
                    <div className="route-stat">
                      <strong>{eta(remainingS ?? 0)}</strong>
                      <small>прибытие</small>
                    </div>
                    <div className="route-stat">
                      <strong>{fmtDuration(remainingS ?? 0, lang)}</strong>
                      <small>в пути</small>
                    </div>
                    <div className="route-stat">
                      <strong>{fmtDistance(nav.progress.remainingM, lang)}</strong>
                      <small>осталось</small>
                    </div>
                    <span className="spacer" />
                    <VoiceToggle className="icon-btn card-voice" />
                    <HudButton className="icon-btn card-voice" />
                    <button className="btn" onClick={() => setMinimal(true)} aria-label="Полноэкранный режим">
                      <Icon name="expand" /> Полный экран
                    </button>
                    {!follow && (
                      <button className="btn btn-primary" onClick={recenter}>
                        <Icon name="locate" /> {overview ? 'К машине' : 'Вернуться к машине'}
                      </button>
                    )}
                    <button className="btn" onClick={() => void findPoi('fuel')} aria-label="АЗС по пути">
                      <Icon name="fuel" /> АЗС
                    </button>
                    <button className="btn btn-danger" onClick={stopNavigation}>
                      Завершить
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="route-head">
                      <div className="route-title">
                        <div className="dest-name">{nav.dest.name}</div>
                        <div className="muted small">
                          {nav.status === 'routing'
                            ? 'Строю маршрут…'
                            : nav.route
                              ? `${fmtDistance(nav.route.distance, lang)} · ${fmtDuration(nav.route.duration, lang)} · прибытие ${eta(nav.route.duration)}`
                              : straight != null
                                ? `${fmtDistance(straight, lang)} по прямой`
                                : nav.dest.address}
                        </div>
                        <SavedPlaceLinks dest={nav.dest} home={saved.home} work={saved.work} />
                        {nav.via && (
                          <div className="via-line">
                            <Icon name="flag" size="1em" /> через {nav.via.name}
                            <button className="link-btn" onClick={() => void removeStop()}>
                              убрать
                            </button>
                          </div>
                        )}
                      </div>
                      <button className="icon-btn" onClick={() => toggleFavorite(nav.dest!)} aria-label={isFav ? 'Убрать из моих мест' : 'В мои места'}>
                        <Icon name="star" filled={isFav} className={isFav ? 'text-accent' : ''} />
                      </button>
                      <button className="icon-btn" onClick={stopNavigation} aria-label="Сбросить маршрут">
                        <Icon name="close" />
                      </button>
                    </div>
                    {nav.error && <div className="text-warn small route-error">{nav.error}</div>}
                    {nav.routes.length > 1 && nav.status === 'preview' && (
                      <div className="route-alts" role="radiogroup" aria-label="Варианты маршрута">
                        {nav.routes.map((r, i) => (
                          <button
                            key={i}
                            role="radio"
                            aria-checked={i === nav.routeIndex}
                            className={`chip route-alt-chip ${i === nav.routeIndex ? 'is-active' : ''}`}
                            onClick={() => selectRoute(i)}
                          >
                            <strong>{fmtDuration(r.duration, lang)}</strong> · {fmtDistance(r.distance, lang)}
                          </button>
                        ))}
                      </div>
                    )}
                    {nav.status === 'arrived' && <div className="text-ok">Вы прибыли</div>}
                    <div className="route-actions">
                      {nav.route && nav.status !== 'arrived' && (
                        <button className="btn btn-primary btn-lg" onClick={startGuidance}>
                          <Icon name="navigate" /> Поехали
                        </button>
                      )}
                      {nav.route && (
                        <>
                          <button className="btn btn-lg android-route-extra" onClick={() => void findPoi('fuel')}>
                            <Icon name="fuel" /> АЗС по пути
                          </button>
                          <button className="btn btn-lg android-route-extra" onClick={() => void findPoi('rest')}>
                            <Icon name="clock" /> Отдых
                          </button>
                          <button className="btn btn-lg android-route-extra" onClick={() => setShowSteps((v) => !v)}>
                            <Icon name="route" /> Шаги
                          </button>
                        </>
                      )}
                      <button className="btn btn-lg android-route-extra" onClick={() => setShowLinks((v) => !v)}>
                        <Icon name="external" /> Другой навигатор
                      </button>
                    </div>
                    {showLinks && (
                      <div className="ext-links">
                        <p className="muted small">Откроется внешнее приложение — там будут пробки и полноценное ведение. AI Car Expert при этом уйдёт в фон.</p>
                        <div className="ext-grid">
                          {routeLinks(nav.dest).map((l) => (
                            <a key={l.id} className="btn" href={l.href} target="_blank" rel="noreferrer">
                              {l.label}
                            </a>
                          ))}
                        </div>
                      </div>
                    )}
                    {showSteps && nav.route && (
                      <ol className="steps-list">
                        {nav.route.steps.map((st, i) => (
                          <li key={i}>
                            <Icon name={stepIcon(st)} size="1.3em" />
                            <span>{stepText(st, lang)}</span>
                            <small>{st.distance ? fmtDistance(st.distance, lang) : ''}</small>
                          </li>
                        ))}
                      </ol>
                    )}
                    {nav.route && (
                      <div className="muted small">
                        Маршрут по дорогам: {nav.route.source ?? 'OSRM'}, данные OpenStreetMap. Время без учёта пробок.
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const samePlace = (a: Place | null, b: Place) => !!a && Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lon - b.lon) < 1e-5;

/** «Сделать домом / работой»: дальше «едем домой» и кнопка «Домой» — без поиска адреса. */
function SavedPlaceLinks({ dest, home, work }: { dest: Place; home: Place | null; work: Place | null }) {
  const isHome = samePlace(home, dest);
  const isWork = samePlace(work, dest);
  if (isHome || isWork) {
    return (
      <div className="saved-line">
        <Icon name={isHome ? 'home' : 'flag'} size="1em" /> {isHome ? 'Дом' : 'Работа'}
        <button className="link-btn" onClick={() => setSavedPlace(isHome ? 'home' : 'work', null)}>
          убрать
        </button>
      </div>
    );
  }
  return (
    <div className="saved-line">
      <button className="link-btn" onClick={() => { setSavedPlace('home', dest); toast('Сохранено как «Дом». Скажите «едем домой».', 'ok'); }}>
        <Icon name="home" size="1em" /> Сделать домом
      </button>
      <button className="link-btn" onClick={() => { setSavedPlace('work', dest); toast('Сохранено как «Работа». Скажите «поехали на работу».', 'ok'); }}>
        <Icon name="flag" size="1em" /> Сделать работой
      </button>
      <button className="link-btn" onClick={() => openPlaceEditor({ lat: dest.lat, lon: dest.lon, name: dest.name, address: dest.address, kind: dest.kind })}>
        <Icon name="plus" size="1em" /> Другое место…
      </button>
    </div>
  );
}

/** Кнопка голосовых подсказок: перечёркнутый динамик — выключены. Музыку и радио не трогает. */
function VoiceToggle({ className = '' }: { className?: string }) {
  const on = useStore(settingsStore).speakNavigation;
  return (
    <button
      className={`${className} ${on ? '' : 'is-muted'}`}
      onClick={() => setNavigationVoice(!on)}
      aria-pressed={!on}
      aria-label={on ? 'Выключить голосовые подсказки' : 'Включить голосовые подсказки'}
      title={on ? 'Голосовые подсказки включены' : 'Голосовые подсказки выключены'}
    >
      <Icon name={on ? 'speaker' : 'speakerOff'} size="1.6rem" />
    </button>
  );
}

/** Кнопка HUD (проекция на лобовое стекло) — рядом с динамиком во время ведения. */
function HudButton({ className = '' }: { className?: string }) {
  return (
    <button className={`${className} hud-btn`} onClick={openHud} aria-label="Режим HUD — проекция на лобовое стекло" title="HUD">
      <Icon name="hud" size="1.6rem" />
      <span className="cam-label">HUD</span>
    </button>
  );
}

/** Свайп по вертикали на элементе (а не на карте — с жестами карты не конфликтует). */
function useVerticalSwipe(onUp: () => void, onDown: () => void) {
  const start = useRef<{ id: number; x: number; y: number } | null>(null);
  const swiped = useRef(false);
  return {
    handlers: {
      onPointerDown: (e: React.PointerEvent) => {
        start.current = e.isPrimary && e.button === 0 ? { id: e.pointerId, x: e.clientX, y: e.clientY } : null;
        swiped.current = false;
        if (start.current && e.target instanceof Element) e.target.setPointerCapture(e.pointerId);
      },
      onPointerUp: (e: React.PointerEvent) => {
        const initial = start.current;
        start.current = null;
        if (!initial || initial.id !== e.pointerId) return;
        const dir = verticalSwipe(e.clientX - initial.x, e.clientY - initial.y);
        if (!dir) return;
        swiped.current = true;
        if (dir === 'up') onUp();
        else onDown();
      },
      onPointerCancel: () => (start.current = null),
      onClickCapture: (e: React.MouseEvent) => {
        if (!swiped.current || e.detail === 0) return;
        swiped.current = false;
        e.preventDefault();
        e.stopPropagation();
      },
    },
  };
}

function GuideBar(p: { eta: string; remaining: string; duration: string; sheet: boolean; hidden: boolean; onHide: () => void; follow: boolean; onRecenter: () => void; onOverview: () => void }) {
  const open = () => driveUiStore.set((s) => ({ ...s, sheet: true }));
  const close = () => driveUiStore.set((s) => ({ ...s, sheet: false }));
  const barSwipe = useVerticalSwipe(open, p.onHide);
  const sheetSwipe = useVerticalSwipe(() => {}, p.onHide);
  const act = (fn: () => void) => () => {
    close();
    fn();
  };
  return (
    <div className="guide-wrap">
      {!p.follow && !p.sheet && (
        <button className="btn btn-primary recenter-pill" onClick={p.onRecenter}>
          <Icon name="locate" /> К машине
        </button>
      )}
      {p.sheet && !p.hidden && (
        <div className="guide-sheet card-float" role="dialog" aria-label="Управление ведением" {...sheetSwipe.handlers}>
          <button className="guide-grabber" onClick={() => close()} aria-label="Свернуть панель">
            <span />
          </button>
          <div className="guide-sheet-grid">
            {!p.follow && (
              <button className="btn btn-lg btn-primary" onClick={act(p.onRecenter)}>
                <Icon name="locate" /> К машине
              </button>
            )}
            <button className="btn btn-lg" onClick={act(p.onOverview)}>
              <Icon name="route" /> Весь маршрут
            </button>
            <button className="btn btn-lg" onClick={act(() => void findPoi('fuel'))}>
              <Icon name="fuel" /> АЗС по пути
            </button>
            <button className="btn btn-lg" onClick={act(startVoice)}>
              <Icon name="mic" /> Голосовая команда
            </button>
            <button className="btn btn-lg" onClick={act(() => setMinimal(false))}>
              <Icon name="collapse" /> Обычный интерфейс
            </button>
            <button className="btn btn-lg btn-danger" onClick={act(stopNavigation)}>
              <Icon name="close" /> Завершить маршрут
            </button>
          </div>
        </div>
      )}
      <div className="guide-bar card-float" hidden={p.hidden} {...barSwipe.handlers}>
        <button className="guide-grabber" onClick={() => p.sheet ? close() : open()} aria-label={p.sheet ? 'Свернуть панель' : 'Открыть панель управления'} aria-expanded={p.sheet}>
          <span />
        </button>
        <div className="guide-stats" aria-label="Прибытие и остаток пути">
          <strong className="guide-eta">{p.eta}</strong>
          <span>
            {p.remaining} · {p.duration}
          </span>
        </div>
        {effectiveEngine(settingsStore.get().mapEngine, mapRuntimeStore.get().fallback, webglAvailable()) === 'maplibre' && <CameraModeToggle className="guide-voice guide-cam" />}
        <HudButton className="guide-btn guide-cam guide-hud" />
        <VoiceToggle className="guide-voice" />
      </div>
    </div>
  );
}

/** Ориентация карты при ведении (MapLibre): по движению ⇄ север сверху. Свободный обзор — жестом, возврат — «К машине». */
function CameraModeToggle({ className = '' }: { className?: string }) {
  const mode = useStore(settingsStore).cameraMode;
  const course = mode === 'course';
  return (
    <button
      className={`${className} cam-toggle`}
      onClick={() => settingsStore.set((x) => ({ ...x, cameraMode: course ? 'north' : 'course' }))}
      aria-label={course ? 'Карта по движению — переключить на «Север сверху»' : 'Север сверху — переключить на «По движению»'}
      data-mode={mode}
      title={course ? 'По движению' : 'Север сверху'}
    >
      <Icon name={course ? 'navigate' : 'arrowUp'} size="1.5rem" />
      <span className="cam-label">{course ? 'Курс' : 'С'}</span>
    </button>
  );
}

/** Сбой загрузки или отрисовки MapLibre — резервная карта Leaflet; маршрут и ведение общие и не теряются. */
class MapErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(e: unknown) {
    engineFallback(e instanceof Error && /fetch|import|module|chunk/i.test(e.message) ? 'не загрузилась' : 'ошибка отрисовки', (t) => toast(t, 'warn'));
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
