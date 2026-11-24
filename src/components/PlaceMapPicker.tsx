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
      const settled = () => {
        setSelectable(view.getZoom() >= 12);
        const { lat, lng } = view.getCenter();
        const nextStyle = styleAt({ lat, lon: lng });
        if (style !== nextStyle) {
          style = nextStyle;
          view.setStyle(style);
        }
      };
      view.on('moveend', settled);
      view.once('load', settled);
      const resize = () => view.resize();
      const observer = new ResizeObserver(resize);
      observer.observe(element.current);
      const unwatch = watchAndroidViewport(resize);
      addEventListener('online', settled);
      addEventListener('offline', settled);
      cleanup = () => {
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
          const point = map.current?.getCenter().wrap();
          if (point) confirm({ lat: point.lat, lon: point.lng });
        }}>Подтвердить</button>
      </div>
    </div>, document.body,
  );
}
