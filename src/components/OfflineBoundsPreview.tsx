import { useEffect, useRef } from 'react';
import type { Map as LibreMap } from 'maplibre-gl';
import { DEFAULT_STYLE_URL } from '../lib/mapStyle';
import type { RegionBounds } from '../lib/offlinePackageFormat';

export function OfflineBoundsPreview({ bounds }: { bounds: RegionBounds }) {
  const el = useRef<HTMLDivElement>(null);
  const [west, south, east, north] = bounds;
  useEffect(() => {
    let disposed = false;
    let map: LibreMap | undefined;
    void import('maplibre-gl').then((ml) => {
      if (disposed || !el.current) return;
      map = new ml.Map({ container: el.current, style: DEFAULT_STYLE_URL, interactive: false,
        attributionControl: { compact: true }, bounds: [west, south, east, north], fitBoundsOptions: { padding: 20, animate: false } });
      map.once('load', () => {
        if (!map || disposed) return;
        map.addSource('coverage', { type: 'geojson', data: { type: 'Feature', properties: {},
          geometry: { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] } } });
        map.addLayer({ id: 'coverage-fill', type: 'fill', source: 'coverage', paint: { 'fill-color': '#087bdb', 'fill-opacity': 0.16 } });
        map.addLayer({ id: 'coverage-line', type: 'line', source: 'coverage', paint: { 'line-color': '#087bdb', 'line-width': 2 } });
      });
    }).catch(() => {});
    return () => { disposed = true; map?.remove(); };
  }, [west, south, east, north]);
  return <div ref={el} role="img" aria-label="Границы скачиваемой области" style={{ height: 174, borderRadius: 12, overflow: 'hidden' }} />;
}
