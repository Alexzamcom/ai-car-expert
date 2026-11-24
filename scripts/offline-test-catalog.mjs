import { createHash } from 'node:crypto';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function regionalFixture(initial, assets, center, name) {
  const id = 'osm-N-57';
  const chunks = Object.entries(assets).map(([, bytes]) => bytes);
  return {
    id,
    catalog: { settlements: [{ ...center, id, name, region: 'Область', country: 'Україна', countryCode: 'UA',
      address: 'Область · Україна', aliases: ['Pavlohrad', 'Pavlograd'],
      packages: { 25: `regions/${id}/25/manifest.json` } }] },
    manifest: { ...initial, settlementId: id, radiusKm: 25, center, dataDate: '2026-01-01',
      chunks: chunks.map((bytes, index) => ({ path: `data-${index}.bin`, bytes: bytes.length, sha256: hash(bytes) })),
      assets: Object.entries(assets).map(([path, bytes], index) => ({ path, bytes: bytes.length, sha256: hash(bytes), chunk: index, offset: 0 })) },
    chunks,
  };
}
