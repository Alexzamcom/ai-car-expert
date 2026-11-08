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
  addRecent,
  toggleFavorite,
  routeLinks,
  distanceKm,
  type Place,
} from '../lib/nav';

const DEFAULT_CENTER: L.LatLngTuple = [55.7539, 37.6208];

const meIcon = L.divIcon({ className: 'map-me', html: '<div class="map-me-dot"><div class="map-me-cone"></div></div>', iconSize: [28, 28], iconAnchor: [14, 14] });
const destIcon = L.divIcon({ className: 'map-dest', html: '<div class="map-dest-pin"></div>', iconSize: [36, 46], iconAnchor: [18, 44] });

export function Navigation() {
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const meMarker = useRef<L.Marker | null>(null);
  const destMarker = useRef<L.Marker | null>(null);
  const geo = useStore(geoStore);
  const navQuery = useStore(navQueryStore);
  const favorites = useStore(favoritesStore);
  const recents = useStore(recentsStore);

  const [follow, setFollow] = useState(true);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Place[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dest, setDest] = useState<Place | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  // Инициализация карты
  useEffect(() => {
    if (!mapEl.current || map.current) return;
    const m = L.map(mapEl.current, { zoomControl: false, attributionControl: true }).setView(DEFAULT_CENTER, 13);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      subdomains: 'abcd',
      attribution: '© OpenStreetMap, © CARTO',
    }).addTo(m);
    m.on('dragstart', () => setFollow(false));
    map.current = m;
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(mapEl.current);
    startGeo();
    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
      meMarker.current = null;
      destMarker.current = null;
    };
  }, []);

  // Позиция пользователя
  useEffect(() => {
    const m = map.current;
    if (!m || geo.lat == null || geo.lon == null) return;
    const ll: L.LatLngTuple = [geo.lat, geo.lon];
    if (!meMarker.current) meMarker.current = L.marker(ll, { icon: meIcon, interactive: false }).addTo(m);
    else meMarker.current.setLatLng(ll);
    const el = meMarker.current.getElement()?.querySelector<HTMLElement>('.map-me-cone');
    if (el) {
      el.style.display = geo.heading != null ? 'block' : 'none';
      el.style.transform = `rotate(${geo.heading ?? 0}deg)`;
    }
    if (follow) m.setView(ll, Math.max(m.getZoom(), 15), { animate: true });
  }, [geo.lat, geo.lon, geo.heading, follow]);

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
      const near = geo.lat != null && geo.lon != null ? { lat: geo.lat, lon: geo.lon } : undefined;
      const r = await searchPlaces(q, near);
      setResults(r);
      if (!r.length) setError('Ничего не найдено');
      else if (pickFirst) selectPlace(r[0]);
    } catch (e) {
      setError(navigator.onLine ? (e as Error).message : 'Нет подключения к интернету');
    } finally {
      setSearching(false);
    }
  }

  function selectPlace(p: Place) {
    setDest(p);
    setPanelOpen(false);
    setFollow(false);
    addRecent(p);
    const m = map.current;
    if (!m) return;
    if (!destMarker.current) destMarker.current = L.marker([p.lat, p.lon], { icon: destIcon }).addTo(m);
    else destMarker.current.setLatLng([p.lat, p.lon]);
    if (geo.lat != null && geo.lon != null) {
      m.fitBounds(L.latLngBounds([geo.lat, geo.lon], [p.lat, p.lon]), { padding: [80, 80], maxZoom: 16 });
    } else m.setView([p.lat, p.lon], 15);
  }

  function clearDest() {
    setDest(null);
    destMarker.current?.remove();
    destMarker.current = null;
    setFollow(true);
  }

  const zoom = (d: number) => map.current?.setZoom((map.current?.getZoom() ?? 13) + d);
  const isFav = dest ? favorites.some((f) => f.lat === dest.lat && f.lon === dest.lon) : false;
  const dist = dest && geo.lat != null && geo.lon != null ? distanceKm({ lat: geo.lat, lon: geo.lon }, dest) : null;

  return (
    <div className="section navigation">
      <div ref={mapEl} className="map" />

      <form
        className="map-search"
        onSubmit={(e) => {
          e.preventDefault();
          void runSearch(query);
          (document.activeElement as HTMLElement | null)?.blur();
        }}
      >
        <Icon name="search" size="1.6rem" />
        <input
          className="map-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setPanelOpen(true)}
          placeholder="Куда едем?"
          enterKeyHint="search"
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
            aria-label="Очистить"
          >
            <Icon name="close" />
          </button>
        )}
      </form>

      {panelOpen && (
        <div className="map-panel">
          {searching && <div className="list-note">Поиск…</div>}
          {error && <div className="list-note text-warn">{error}</div>}
          {results?.map((p) => (
            <button key={p.id} className="place-row" onClick={() => selectPlace(p)}>
              <Icon name="gps" size="1.6rem" />
              <span>
                <strong>{p.name}</strong>
                <small>{p.address}</small>
              </span>
            </button>
          ))}
          {!results && (
            <>
              {favorites.length > 0 && <div className="list-head">Избранное</div>}
              {favorites.map((p) => (
                <button key={p.id} className="place-row" onClick={() => selectPlace(p)}>
                  <Icon name="star" size="1.6rem" />
                  <span>
                    <strong>{p.name}</strong>
                    <small>{p.address}</small>
                  </span>
                </button>
              ))}
              {recents.length > 0 && <div className="list-head">Недавние</div>}
              {recents.map((p) => (
                <button key={p.id + p.lat} className="place-row" onClick={() => selectPlace(p)}>
                  <Icon name="calendar" size="1.6rem" />
                  <span>
                    <strong>{p.name}</strong>
                    <small>{p.address}</small>
                  </span>
                </button>
              ))}
              {!favorites.length && !recents.length && (
                <div className="list-note">Введите адрес или название места, либо скажите «Маршрут до …»</div>
              )}
            </>
          )}
        </div>
      )}

      <div className="map-controls">
        <button className="map-ctl" onClick={() => zoom(1)} aria-label="Приблизить">
          <Icon name="plus" size="1.8rem" />
        </button>
        <button className="map-ctl" onClick={() => zoom(-1)} aria-label="Отдалить">
          <span className="map-minus" />
        </button>
        <button
          className={`map-ctl ${follow ? 'is-active' : ''}`}
          onClick={() => {
            setFollow(true);
            startGeo();
            if (geo.lat != null && geo.lon != null) map.current?.setView([geo.lat, geo.lon], 16);
          }}
          aria-label="Моё местоположение"
        >
          <Icon name="locate" size="1.8rem" />
        </button>
      </div>

      <div className="map-speed">
        <span className="map-speed-value">{geo.speedKmh != null ? Math.round(geo.speedKmh) : '—'}</span>
        <span className="map-speed-unit">км/ч GPS</span>
      </div>

      {geo.status === 'denied' && (
        <div className="map-banner">
          <Icon name="alert" /> Нет доступа к геопозиции. Разрешите его: Настройки iPad → Конфиденциальность → Службы геолокации.
        </div>
      )}

      {dest && (
        <div className="dest-card">
          <div className="dest-head">
            <div>
              <div className="dest-name">{dest.name}</div>
              <div className="muted">
                {dest.address}
                {dist != null && ` · ${dist < 10 ? dist.toFixed(1) : Math.round(dist)} км по прямой`}
              </div>
            </div>
            <button className="icon-btn" onClick={() => toggleFavorite(dest)} aria-label="Избранное">
              <Icon name="star" filled={isFav} className={isFav ? 'text-accent' : ''} />
            </button>
            <button className="icon-btn" onClick={clearDest} aria-label="Сбросить">
              <Icon name="close" />
            </button>
          </div>
          <div className="dest-note">Пошаговая навигация откроется в выбранном приложении:</div>
          <div className="dest-actions">
            {routeLinks(dest).map((l) => (
              <a key={l.id} className="btn btn-lg" href={l.href} target="_blank" rel="noreferrer">
                <Icon name="navigate" /> {l.label}
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
