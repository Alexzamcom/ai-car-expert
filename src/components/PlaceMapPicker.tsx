import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Map as MapLibre } from 'maplibre-gl';
import type { LatLon } from '../lib/routing';
import { DEFAULT_STYLE_URL } from '../lib/mapStyle';
import { EMPTY_OFFLINE_STYLE, initializeOfflineMaps, offlineRegions, offlineStyleFor, registerOfflineProtocol } from '../lib/offlineMaps';
import { watchAndroidViewport } from '../lib/androidViewport';
import { Icon } from './Icon';

export function PlaceMapPicker({ start, cancel, confirm }: { start: LatLon | null; cancel: () => void; confirm: (point: LatLon) => void }) {
  const element = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibre | null>(null);
  const initial = useRef(start);
  const selected = useRef<LatLon | null>(null);
  const pending = useRef<LatLon | null>(null);
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
      const styleAt = (point: LatLon) => navigator.onLine ? DEFAULT_STYLE_URL : offlineStyleFor(point)?.style ?? EMPTY_OFFLINE_STYLE;
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
      let tapTimer: ReturnType<typeof setTimeout> | undefined;
      const cancelTap = () => {
        clearTimeout(tapTimer);
        tapTimer = undefined;
        pending.current = null;
      };
      const interrupt = () => {
        cancelTap();
        selected.current = null;
      };
      const canvas = view.getCanvasContainer();
      const multiTouch = (event: TouchEvent) => { if (event.touches.length > 1) interrupt(); };
      canvas.addEventListener('touchstart', multiTouch, { passive: true });
      canvas.addEventListener('touchcancel', interrupt, { passive: true });
      view.on('click', (event) => {
        if (!ready || view.isMoving() || event.originalEvent.button !== 0) return;
        cancelTap();
        const point = event.lngLat.wrap();
        pending.current = { lat: point.lat, lon: point.lng };
        // MapLibre's double-tap recognizer allows 500 ms between taps.
        tapTimer = setTimeout(() => {
          selected.current = pending.current;
          pending.current = null;
          if (selected.current) view.easeTo({ center: [selected.current.lon, selected.current.lat], duration: 240 });
        }, 520);
      });
      view.on('dblclick', interrupt);
      view.on('movestart', (event) => { if (event.originalEvent) interrupt(); });
      view.on('moveend', settled);
      view.once('load', () => { ready = true; settled(); });
      const resize = () => view.resize();
      const observer = new ResizeObserver(resize);
      observer.observe(element.current);
      const unwatch = watchAndroidViewport(resize);
      addEventListener('online', settled);
      addEventListener('offline', settled);
      cleanup = () => {
        cancelTap();
        selected.current = null;
        canvas.removeEventListener('touchstart', multiTouch);
        canvas.removeEventListener('touchcancel', interrupt);
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
      <div className="place-map-picker-pin" aria-hidden="true"><Icon name="locate" size="2.5rem" /></div>
      <div className="place-map-picker-actions">
        {failed && <div role="status">Карта недоступна</div>}
        <button type="button" className="btn" onClick={cancel}>Отмена</button>
        <button type="button" className="btn btn-primary" disabled={failed || !selectable} onClick={() => {
          const tapped = pending.current ?? selected.current;
          if (tapped) return confirm(tapped);
          const point = map.current?.getCenter().wrap();
          if (point) confirm({ lat: point.lat, lon: point.lng });
        }}>Подтвердить</button>
      </div>
    </div>, document.body,
  );
}
