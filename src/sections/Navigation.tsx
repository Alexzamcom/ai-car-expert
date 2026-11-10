import { useEffect, useRef, useState } from 'react';
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
  pickStore,
  pickPoint,
  cancelPick,
  routeToPick,
  addPickAsStop,
  selectRoute,
  type Place,
} from '../lib/nav';
import { LongPressDetector } from '../lib/geo/longpress';
import { fmtCoords } from '../lib/geo/geocode';
import { stepText, stepIcon, fmtDistance, fmtDuration, haversine } from '../lib/routing';
import { POI_CATEGORIES, type PoiCategory, type Poi } from '../lib/poi';
import { toast } from '../lib/state';
import { themeStore, THEMES } from '../lib/theme';

const DEFAULT_CENTER: L.LatLngTuple = [55.7539, 37.6208];

export const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">Участники OpenStreetMap</a>';

const meIcon = L.divIcon({ className: 'map-me', html: '<div class="map-me-dot"><div class="map-me-cone"></div></div>', iconSize: [28, 28], iconAnchor: [14, 14] });
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

export function Navigation() {
  const uiEl = useRef<HTMLDivElement>(null);
  const mapEl = useRef<HTMLDivElement>(null);
  const themeOnly = useRef(false);
  const fitted = useRef<unknown>(null);
  const map = useRef<L.Map | null>(null);
  const layers = useRef<{ me?: L.Marker; dest?: L.Marker; via?: L.Marker; pick?: L.Marker; route?: L.LayerGroup; poi?: L.LayerGroup }>({});
  const pick = useStore(pickStore);
  const geo = useStore(geoStore);
  const nav = useStore(navStore);
  const poi = useStore(poiStore);
  const navQuery = useStore(navQueryStore);
  const favorites = useStore(favoritesStore);
  const recents = useStore(recentsStore);
  const theme = useStore(themeStore);

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

  // Инициализация карты
  useEffect(() => {
    if (!mapEl.current || map.current) return;
    const m = L.map(mapEl.current, { zoomControl: false, attributionControl: true }).setView(DEFAULT_CENTER, 13);
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
    startGeo();
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
  }, []);

  // Позиция пользователя
  useEffect(() => {
    const m = map.current;
    if (!m || geo.lat == null || geo.lon == null) return;
    const ll: L.LatLngTuple = [geo.lat, geo.lon];
    if (!layers.current.me) layers.current.me = L.marker(ll, { icon: meIcon, interactive: false, zIndexOffset: 1000 }).addTo(m);
    else layers.current.me.setLatLng(ll);
    const el = layers.current.me.getElement()?.querySelector<HTMLElement>('.map-me-cone');
    if (el) {
      el.style.display = geo.heading != null ? 'block' : 'none';
      el.style.transform = `rotate(${geo.heading ?? 0}deg)`;
    }
    if (follow) m.setView(ll, Math.max(m.getZoom(), guiding ? 17 : 15), { animate: true });
  }, [geo.lat, geo.lon, geo.heading, follow, guiding]);

  // Маршрут, цель и промежуточная точка
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const l = layers.current;
    l.route?.remove();
    l.dest?.remove();
    l.via?.remove();
    l.route = l.dest = l.via = undefined;
    if (nav.dest) l.dest = L.marker([nav.dest.lat, nav.dest.lon], { icon: destIcon }).addTo(m);
    if (nav.via) l.via = L.marker([nav.via.lat, nav.via.lon], { icon: viaIcon }).addTo(m);
    if (nav.route) {
      const pts = nav.route.coords.map((c) => [c.lat, c.lon] as L.LatLngTuple);
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
      l.route = L.layerGroup([
        ...altLines,
        L.polyline(pts, { color: tk['route-casing'], weight: 11, opacity: 0.9, interactive: false }),
        L.polyline(pts, { color: tk.route, weight: 7, opacity: 0.95, interactive: false, className: 'route-main' }),
      ]).addTo(m);
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
  }, [nav.route, nav.routes, nav.routeIndex, nav.dest, nav.via, nav.status, theme.active]);

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
  }, [pick?.lat, pick?.lon, pick?.origin, pick]);

  // Смена темы перерисовывает линию маршрута, но не двигает камеру.
  const prevTheme = useRef(theme.active);
  if (prevTheme.current !== theme.active) {
    prevTheme.current = theme.active;
    themeOnly.current = true;
  }

  // Начало ведения: сначала весь маршрут, затем камера следует за машиной.
  const [overview, setOverview] = useState(false);
  useEffect(() => {
    const m = map.current;
    if (!guiding) {
      setOverview(false);
      return;
    }
    const r = navStore.get().route;
    if (!m || !r) {
      setFollow(true);
      return;
    }
    setFollow(false);
    setOverview(true);
    const rb = L.latLngBounds(r.coords.map((c) => [c.lat, c.lon] as L.LatLngTuple));
    requestAnimationFrame(() => fitVisible(m, rb, uiEl.current));
    const t = setTimeout(() => {
      setOverview(false);
      setFollow(true);
    }, OVERVIEW_MS);
    return () => clearTimeout(t);
  }, [guiding]);

  const recenter = () => {
    setOverview(false);
    setFollow(true);
    startGeo();
    if (geo.lat != null && geo.lon != null) map.current?.setView([geo.lat, geo.lon], guiding ? 17 : 16);
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
  }, [poi.items]);

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

  const zoom = (d: number) => map.current?.setZoom((map.current?.getZoom() ?? 13) + d);
  const isFav = nav.dest ? favorites.some((f) => f.lat === nav.dest!.lat && f.lon === nav.dest!.lon) : false;
  const step = nav.route && nav.progress ? nav.route.steps[nav.progress.stepIndex] : null;
  const next = nav.route && nav.progress ? nav.route.steps[nav.progress.stepIndex + 1] : null;
  const remainingS = nav.route && nav.progress ? nav.route.duration * (nav.progress.remainingM / Math.max(1, nav.route.distance)) : null;
  const straight = nav.dest && geo.lat != null && geo.lon != null ? haversine({ lat: geo.lat, lon: geo.lon }, nav.dest) : null;

  return (
    <div className="navigation">
      <div ref={mapEl} className="map" />

      <div ref={uiEl} className={`map-ui ${(nav.dest && !guiding) || pick ? 'has-dest' : ''} ${nav.dest || poi.category || pick ? 'has-card' : ''}`}>
        {/* Верх: поиск или манёвр */}
        <div className="map-top">
          {guiding && step && nav.progress ? (
            <div className="maneuver" role="status">
              <div className="maneuver-icon">
                <Icon name={stepIcon(step)} size="2.6rem" stroke={2.2} />
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
                onChange={(e) => setQuery(e.target.value)}
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
                  {favorites.length > 0 && <div className="list-head">Избранное</div>}
                  {favorites.map((p) => (
                    <button key={p.id} className="place-row" onClick={() => selectPlace(p)}>
                      <Icon name="star" size="1.5rem" />
                      <span>
                        <strong>{p.name}</strong>
                        <small>{p.address}</small>
                      </span>
                    </button>
                  ))}
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
        <div className="map-controls">
          <button className="map-ctl" onClick={() => zoom(1)} aria-label="Приблизить">
            <Icon name="plus" size="1.7rem" />
          </button>
          <button className="map-ctl" onClick={() => zoom(-1)} aria-label="Отдалить">
            <span className="map-minus" />
          </button>
          <button className={`map-ctl ${follow ? 'is-active' : ''}`} onClick={recenter} aria-label="Моё местоположение">
            <Icon name="locate" size="1.7rem" />
          </button>
        </div>

        {/* Низ: скорость + карточка маршрута / объектов */}
        <div className="map-bottom">
          <div className="map-speed" aria-label="Скорость по GPS">
            <span className="map-speed-value">{geo.speedKmh != null ? Math.round(geo.speedKmh) : '—'}</span>
            <span className="map-speed-unit">км/ч</span>
          </div>

          <div className="map-cards">
            {(geo.status === 'denied' || geo.status === 'unavailable') && !nav.dest && (
              <button className="geo-chip" onClick={() => toast(geoHelp(), 'warn')}>
                <Icon name="alert" size="1.3em" />
                {geo.status === 'denied' ? 'Нет доступа к геопозиции — как включить' : 'Геопозиция недоступна'}
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
                  <button className="btn btn-lg" onClick={cancelPick}>
                    Отмена
                  </button>
                </div>
              </div>
            )}

            {nav.dest && !poi.category && !pick && (
              <div className={`route-card card-float ${guiding ? 'is-guiding' : ''}`}>
                {guiding && nav.route && nav.progress ? (
                  <div className="route-guiding">
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
                        {nav.via && (
                          <div className="via-line">
                            <Icon name="flag" size="1em" /> через {nav.via.name}
                            <button className="link-btn" onClick={() => void removeStop()}>
                              убрать
                            </button>
                          </div>
                        )}
                      </div>
                      <button className="icon-btn" onClick={() => toggleFavorite(nav.dest!)} aria-label="Избранное">
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
                          <button className="btn btn-lg" onClick={() => void findPoi('fuel')}>
                            <Icon name="fuel" /> АЗС по пути
                          </button>
                          <button className="btn btn-lg" onClick={() => void findPoi('rest')}>
                            <Icon name="clock" /> Отдых
                          </button>
                          <button className="btn btn-lg" onClick={() => setShowSteps((v) => !v)}>
                            <Icon name="route" /> Шаги
                          </button>
                        </>
                      )}
                      <button className="btn btn-lg" onClick={() => setShowLinks((v) => !v)}>
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
