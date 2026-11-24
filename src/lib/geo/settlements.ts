import { fetchJson } from './http';
import { PHOTON, photonToPlace } from './geocode';

export async function searchSettlements(query: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ q: query.trim(), limit: '15' });
  for (const type of ['city', 'town', 'village', 'hamlet']) params.append('osm_tag', `place:${type}`);
  const data = await fetchJson<{ features: Parameters<typeof photonToPlace>[0][] }>(`${PHOTON}/api/?${params}`,
    { service: 'Photon', timeoutMs: 12_000, signal });
  return (data.features ?? []).map(photonToPlace).filter(({ lat, lon }) => Number.isFinite(lat) && Number.isFinite(lon));
}
