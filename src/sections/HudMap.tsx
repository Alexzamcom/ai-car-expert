/* HUD «Полная карта»: отдельная неинтерактивная карта MapLibre — чёрный фон, дороги и перекрёстки,
   яркий маршрут, машинка; всегда по движению, с наклоном. Маршрут и GPS — общие с навигацией. */
import { useEffect, useRef } from 'react';
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import { geoStore, navStore, readLastPos } from '../lib/nav';
import { DEFAULT_STYLE_URL, paletteTransform } from '../lib/mapStyle';
import { autoZoom } from '../lib/camera';
import { displayStore } from '../lib/matching/display';
import { mapDiag } from '../lib/diag';
import { unwrapAngle } from '../lib/carMarker';
import type { LatLon } from '../lib/routing';

const PITCH = 45;
const empty = { type: 'FeatureCollection' as const, features: [] };

export function HudMap({ color }: { color: string }) {
  const el = useRef<HTMLDivElement>(null);
  const colorRef = useRef(color);
  colorRef.current = color;
  const mapRef = useRef<MlMap | null>(null);

  useEffect(() => {
    let disposed = false;
    const cleanups: (() => void)[] = [];
    void (async () => {
      const ml = await import('maplibre-gl');
      await import('maplibre-gl/dist/maplibre-gl.css');
      const workerUrl = (await import('maplibre-gl/dist/maplibre-gl-worker.mjs?url')).default;
      if (disposed || !el.current) return;
      ml.setWorkerUrl(workerUrl);
      const g0 = geoStore.get();
      const start = g0.lat != null && g0.lon != null ? { lat: g0.lat, lon: g0.lon } : (readLastPos() ?? { lat: 55.7539, lon: 37.6208 });
      const map = new ml.Map({
        container: el.current,
        // Сначала пустой чёрный стиль, затем векторный в палитре HUD — без вспышки светлой карты.
        style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#000' } }] },
        center: [start.lon, start.lat],
        zoom: 16,
        pitch: PITCH,
        bearing: g0.heading ?? 0,
        interactive: false,
        attributionControl: false,
        maxPitch: 60,
        fadeDuration: 0,
      });
      mapRef.current = map;
      mapDiag.create('HUD-карта');
      const restyle = () => map.setStyle(DEFAULT_STYLE_URL, { diff: false, transformStyle: paletteTransform('hud', { roadColor: '#8d969f' }) });
      restyle();

      const addLayers = () => {
        if (!map.getSource('route')) map.addSource('route', { type: 'geojson', data: empty });
        const w = (a: number, b: number) => ['interpolate', ['linear'], ['zoom'], 12, a, 18, b] as unknown as number;
        if (!map.getLayer('hud-route')) map.addLayer({ id: 'hud-route', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': colorRef.current, 'line-width': w(5, 18) } });
        drawRoute();
      };
      map.on('style.load', addLayers);
      const drawRoute = () => {
        const r = navStore.get().route;
        (map.getSource('route') as GeoJSONSource | undefined)?.setData(
          r ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: r.coords.map((c) => [c.lon, c.lat]) } } : empty,
        );
      };
      let lastRoute = navStore.get().route;
      cleanups.push(
        navStore.subscribe(() => {
          if (navStore.get().route !== lastRoute) {
            lastRoute = navStore.get().route;
            drawRoute();
          }
        }),
      );

      // Машинка — светлая стрелка в цвете HUD, лежит на карте.
      const carEl = document.createElement('div');
      carEl.className = 'hud-map-car';
      carEl.innerHTML = '<svg viewBox="-20 -24 40 44" width="44" height="48"><path d="M0 -22 L15 16 L0 8 L-15 16 Z" fill="currentColor"/></svg>';
      const marker = new ml.Marker({ element: carEl, rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat([start.lon, start.lat]).addTo(map);

      let from: LatLon | null = null;
      let to: LatLon | null = null;
      let t0 = 0;
      let heading = g0.heading;
      let headingShown = g0.heading ?? 0;
      const pos = (now: number): LatLon | null => {
        if (!to) return null;
        if (!from) return to;
        const k = Math.min(1, (now - t0) / 1000);
        return { lat: from.lat + (to.lat - from.lat) * k, lon: from.lon + (to.lon - from.lon) * k };
      };
      const camera = (immediate = false) => {
        if (!to) return;
        const g = geoStore.get();
        const h = map.getContainer().clientHeight;
        map.easeTo({
          center: [to.lon, to.lat],
          bearing: heading ?? map.getBearing(),
          pitch: PITCH,
          zoom: autoZoom(g.speedKmh, navStore.get().progress?.toStepM ?? null),
          offset: [0, h * 0.28],
          duration: immediate ? 0 : 1000,
          easing: (x) => x,
          essential: true,
        });
      };
      const onGeo = () => {
        const g = displayStore.get(); // отображаемая позиция (привязка к дороге)
        if (g.lat == null || g.lon == null) return;
        if (to && to.lat === g.lat && to.lon === g.lon && heading === g.heading) return;
        const now = performance.now();
        const first = !to;
        from = pos(now) ?? { lat: g.lat, lon: g.lon };
        to = { lat: g.lat, lon: g.lon };
        t0 = now;
        if (g.heading != null) heading = g.heading;
        camera(first);
      };
      onGeo();
      cleanups.push(displayStore.subscribe(onGeo));

      let raf = 0;
      const frame = (now: number) => {
        raf = requestAnimationFrame(frame);
        const p = pos(now);
        if (!p) return;
        if (heading != null) {
          const target = unwrapAngle(headingShown, heading);
          headingShown += Math.max(-6, Math.min(6, (target - headingShown) * 0.15));
        }
        marker.setLngLat([p.lon, p.lat]).setRotation(headingShown);
      };
      raf = requestAnimationFrame(frame);
      cleanups.push(() => cancelAnimationFrame(raf));
      const onResize = () => (map.resize(), camera(true));
      window.addEventListener('resize', onResize);
      cleanups.push(() => window.removeEventListener('resize', onResize));

      (window as unknown as { __aceHud?: unknown }).__aceHud = {
        mode: 'map',
        map,
        state: () => ({ bearing: map.getBearing(), pitch: map.getPitch(), zoom: map.getZoom(), heading, route: !!navStore.get().route, loaded: !!map.getLayer('hud-route') }),
      };
    })();
    return () => {
      disposed = true;
      cleanups.forEach((f) => f());
      if (mapRef.current) mapDiag.remove('HUD-карта');
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // Смена цвета HUD — без пересоздания карты.
  useEffect(() => {
    const m = mapRef.current;
    if (m?.getLayer('hud-route')) m.setPaintProperty('hud-route', 'line-color', color);
  }, [color]);

  return <div ref={el} className="hud-map" style={{ color }} />;
}
