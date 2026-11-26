import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Map as MapLibre } from 'maplibre-gl';
import type { LatLon } from '../lib/routing';
import { DEFAULT_STYLE_URL } from '../lib/mapStyle';
import { EMPTY_OFFLINE_STYLE, initializeOfflineMaps, offlineRegions, offlineStyleFor, regionAt, registerOfflineProtocol, type OfflineRegion } from '../lib/offlineMaps';
import { watchAndroidViewport } from '../lib/androidViewport';
import { Icon } from './Icon';

export function PlaceMapPicker({ start, cancel, confirm, regions, onRegionChange, route }: { start: LatLon | null; cancel: () => void; confirm: (point: LatLon) => void; regions?: OfflineRegion[]; onRegionChange?: (region: OfflineRegion) => void; route?: LatLon[] }) {
  const element = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibre | null>(null);
  const initial = useRef(start);
  const selected = useRef<LatLon | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [selectable, setSelectable] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    void (async () => {
      const ml = await import('maplibre-gl');
      await import('maplibre-gl/dist/maplibre-gl.css');
      ml.setWorkerUrl((await import('maplibre-gl/dist/maplibre-gl-worker.mjs?url')).default);
      registerOfflineProtocol(ml.addProtocol);
      await initializeOfflineMaps().catch(() => {});
      if (disposed || !element.current) return;
      const start = initial.current ?? (!navigator.onLine ? offlineRegions.get()[0]?.center : null);
      const center = start ?? { lat: 0, lon: 0 };
      const styleAt = (point: LatLon) => {
        const region = regionAt(point);
        return region?.graph ? region.style : navigator.onLine ? DEFAULT_STYLE_URL : offlineStyleFor(point)?.style ?? EMPTY_OFFLINE_STYLE;
      };
      let style = styleAt(center);
      const view = new ml.Map({
        container: element.current, style, center: [center.lon, center.lat], zoom: start ? 16 : 2,
        dragRotate: false, pitchWithRotate: false, attributionControl: { compact: true },
      });
      view.touchZoomRotate.disableRotation();
      map.current = view;
      let ready = false;
      const settled = () => {
        setSelectable(ready && view.getZoom() >= 12);

        const { lat, lng } = view.getCenter();
        const nextStyle = styleAt({ lat, lon: lng });
        if (style !== nextStyle) {
          style = nextStyle;
          view.setStyle(style);
        }
      };
      const holder = view.getCanvasContainer();
      let finger: { id: number; x: number; y: number; at: number } | null = null;
      let lastTouch = -Infinity;
      let tapAt = -Infinity;
      let tapX = 0;
      let tapY = 0;
      const interrupt = () => {
        finger = null;
        selected.current = null;
        setAnchor(null);
      };
      const select = (clientX: number, clientY: number) => {
        if (!ready || view.getZoom() < 12) return;
        const bounds = holder.getBoundingClientRect();
        const x = clientX - bounds.left, y = clientY - bounds.top;
        const point = view.unproject([x, y]).wrap();
        selected.current = { lat: point.lat, lon: point.lng };
        setAnchor({ x, y });
      };
      const touchStart = (event: TouchEvent) => {
        lastTouch = performance.now();
        if (event.touches.length !== 1 || (event.target as Element | null)?.closest('.maplibregl-ctrl')) {
          interrupt();
          return;
        }
        const touch = event.touches[0];
        finger = { id: touch.identifier, x: touch.clientX, y: touch.clientY, at: event.timeStamp };
      };
      const touchMove = (event: TouchEvent) => {
        if (!finger) return;
        const touch = event.touches[0];
        if (event.touches.length !== 1 || Math.hypot(touch.clientX - finger.x, touch.clientY - finger.y) > 10) interrupt();
      };
      const touchEnd = (event: TouchEvent) => {
        lastTouch = performance.now();
        const start = finger;
        finger = null;
        if (!start || event.touches.length || event.timeStamp - start.at > 400) return;
        const touch = Array.from(event.changedTouches).find((item) => item.identifier === start.id);
        if (!touch || Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 10) return;
        if (lastTouch - tapAt < 500 && Math.hypot(touch.clientX - tapX, touch.clientY - tapY) < 30) {
          tapAt = -Infinity;
          interrupt(); // MapLibre retains its double-tap zoom.
          return;
        }
        tapAt = lastTouch;
        tapX = touch.clientX;
        tapY = touch.clientY;
        select(tapX, tapY);
      };
      // Like the previous map picker, consume actual screen coordinates and unproject them.
      // Capturing native touch events avoids depending on a synthesized mouse click in WebView.
      const capture = { capture: true, passive: true };
      holder.addEventListener('touchstart', touchStart, capture);
      holder.addEventListener('touchmove', touchMove, capture);
      holder.addEventListener('touchend', touchEnd, capture);
      holder.addEventListener('touchcancel', interrupt, capture);
      view.on('click', ({ originalEvent }) => {
        if (performance.now() - lastTouch >= 750 && originalEvent.button === 0) select(originalEvent.clientX, originalEvent.clientY);
      });
      if (route?.length) view.on('style.load', () => {
        view.addSource('restored-trip', { type: 'geojson', data: {
          type: 'Feature', properties: {}, geometry: {
            type: 'LineString', coordinates: route.map((point) => [point.lon, point.lat]),
          },
        } });
        view.addLayer({ id: 'restored-trip', type: 'line', source: 'restored-trip',
          paint: { 'line-color': '#1285e0', 'line-width': 6 } });
      });
      view.on('dblclick', interrupt);
      view.on('movestart', (event) => { if (event.originalEvent) interrupt(); });
      view.on('moveend', settled);
      view.once('load', () => { ready = true; settled(); });
      const resize = () => {
        view.resize();
        if (selected.current) {
          const point = view.project([selected.current.lon, selected.current.lat]);
          setAnchor({ x: point.x, y: point.y });
        }
      };
      const observer = new ResizeObserver(resize);
      observer.observe(element.current);
      const unwatch = watchAndroidViewport(resize);
      addEventListener('online', settled);
      addEventListener('offline', settled);
      cleanup = () => {
        selected.current = null;
        holder.removeEventListener('touchstart', touchStart, true);
        holder.removeEventListener('touchmove', touchMove, true);
        holder.removeEventListener('touchend', touchEnd, true);
        holder.removeEventListener('touchcancel', interrupt, true);
        removeEventListener('online', settled);
        removeEventListener('offline', settled);
        observer.disconnect();
        unwatch();
        map.current = null;
        view.remove();
      };
    })().catch(() => { if (!disposed) setFailed(true); });
    return () => { disposed = true; cleanup(); };
  }, []);

  useEffect(() => {
    const app = document.querySelector<HTMLElement>('.app');
    const wasInert = app?.hasAttribute('inert');
    app?.setAttribute('inert', '');
    return () => { if (!wasInert) app?.removeAttribute('inert'); };
  }, []);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
    addEventListener('keydown', escape);
    return () => removeEventListener('keydown', escape);
  }, [cancel]);

  return createPortal(
    <div className="place-map-picker" role="dialog" aria-modal="true" aria-label="Выбор места на карте">
      <div ref={element} className="place-map-picker-map" />
      <div className="place-map-picker-pin" style={anchor ? { left: anchor.x, top: anchor.y } : undefined} aria-hidden="true"><Icon name="locate" size="2.5rem" /></div>
      <div className="place-map-picker-actions">
        {!!regions && regions.length > 1 && <select aria-label="Скачанная карта" defaultValue="" onChange={(event) => {
          const region = regions.find((entry) => entry.id === event.target.value);
          if (!region) return;
          selected.current = null;
          setAnchor(null);
          map.current?.jumpTo({ center: [region.center.lon, region.center.lat], zoom: 16 });
          onRegionChange?.(region);
        }}><option value="" disabled>Сменить регион</option>{regions.map((region) => <option key={region.id} value={region.id}>{region.name}</option>)}</select>}
        {route && <span>Укажите текущее положение на маршруте</span>}
        {failed && <div role="status">Карта недоступна</div>}
        <button type="button" className="btn" onClick={cancel}>Отмена</button>
        <button type="button" className="btn btn-primary" disabled={failed || !selectable} onClick={() => {
          const tapped = selected.current;
          if (tapped) return confirm(tapped);
          const point = map.current?.getCenter().wrap();
          if (point) confirm({ lat: point.lat, lon: point.lng });
        }}>Подтвердить</button>
      </div>
    </div>, document.body,
  );
}
