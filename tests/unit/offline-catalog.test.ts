import { describe, expect, it } from 'vitest';
import { rankSettlements, settlementPackage, type Settlement } from '../../src/lib/geo/settlements';
import { validateOfflinePackage, verifyRegionIdentity, type OfflinePackage } from '../../src/lib/offlinePackageFormat';

const city: Settlement = {
  id: 'osm-N-10', lat: 48.53, lon: 35.87, name: 'Павлоград', region: 'Дніпропетровська область', country: 'Україна',
  countryCode: 'UA', address: 'Дніпропетровська область · Україна', aliases: ['Pavlograd', 'Pavlohrad'],
  packages: { 25: 'regions/osm-N-10/25/manifest.json' },
};
const paligrad = { geometry: { coordinates: [21.52, 41.82] as [number, number] }, properties: {
  name: 'Paligrad', osm_type: 'W', osm_id: 10, osm_value: 'village', country: 'North Macedonia', countrycode: 'MK' } };
const checksum = 'a'.repeat(64);
const manifest: OfflinePackage = {
  version: 1, engine: 'valhalla-3.9', bounds: [35, 48, 36, 49], center: city, settlementId: city.id,
  radiusKm: 25, dataDate: '2026-01-01', style: { version: 8, sources: {}, layers: [] },
  chunks: [{ path: 'data-0.bin', bytes: 6, sha256: checksum }],
  assets: ['addresses.json', 't/12/10/10', 'graph/2/000/798/623.gph'].map((path, index) =>
    ({ path, bytes: 2, chunk: 0, offset: index * 2, sha256: checksum })),
};

describe('published offline map catalogue', () => {
  it('uses the same typed OSM identity for name, coordinates and package, across search languages', () => {
    for (const query of ['Павлоград', 'Pavlograd', 'Pavlohrad']) {
      expect(rankSettlements(query, [city], [paligrad])).toEqual([city, expect.objectContaining({ id: 'osm-W-10', countryCode: 'MK' })]);
    }
    expect(settlementPackage(city, 25)).toContain('/osm-N-10/25/manifest.json');
    expect(settlementPackage(city, 10)).toBeNull();
    expect(settlementPackage({ ...city, id: 'osm-W-10' }, 25)).toBeNull();
  });
  it('rejects a manifest for a different place, centre or radius and invalid chunk layouts', () => {
    expect(validateOfflinePackage(manifest)).toBe(manifest);
    expect(() => verifyRegionIdentity(manifest, 'osm-W-10', city, 25)).toThrow();
    expect(() => verifyRegionIdentity(manifest, city.id, { ...city, lon: 21.52 }, 25)).toThrow();
    expect(() => verifyRegionIdentity(manifest, city.id, city, 10)).toThrow();
    expect(() => validateOfflinePackage({ ...manifest, chunks: [{ ...manifest.chunks![0], sha256: 'invalid' }] })).toThrow();
    expect(() => validateOfflinePackage({ ...manifest, assets: manifest.assets.map((a) => ({ ...a, offset: 1 })) })).toThrow();
  });
});
