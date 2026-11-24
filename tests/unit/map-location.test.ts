import { describe, expect, it } from 'vitest';
import { HybridPosition, type PositionObservation } from '../../src/lib/geo/hybridPosition';
import { MAP_LOCATION_STALE_MS, selectMapLocation } from '../../src/lib/geo/mapLocation';

const now = 1_800_000_000_000;
const gps: PositionObservation = { at: now - 9, source: 'gps', accuracy: 24, lat: 48.46, lon: 35.04, sequence: 10 };

describe('ordinary map location', () => {
  it('shows the first Note 9 fix independently of confirmation and retains the latest fix through silence', () => {
    const hybrid = new HybridPosition();
    expect(hybrid.update({ kind: 'position', data: gps }, now)).toBeNull();
    const first = selectMapLocation(null, gps, now);
    expect(first).toMatchObject({ accuracy: 24, at: now - 9 });
    const second = selectMapLocation(first, { ...gps, at: now + 909, sequence: 12 }, now + 1000);
    const third = selectMapLocation(second, { ...gps, source: 'fused', accuracy: 28, at: now + 1967, sequence: 15 }, now + 2000);
    expect(third).toMatchObject({ source: 'fused', accuracy: 28 });
    const later = now + 60_000;
    expect(later - third!.at).toBeGreaterThan(MAP_LOCATION_STALE_MS);
    for (const age of [14_000, 38_000, 5 * 60 * 60_000]) {
      const old = { ...gps, at: later - age, cached: age > 60_000 };
      expect(selectMapLocation(third, old, later)).toBe(third);
      expect(hybrid.update({ kind: 'position', data: old }, later)).toBeNull();
    }
  });

  it('accepts a newer approximate network position but rejects mock, rejected and implausible jumps', () => {
    const network = { ...gps, source: 'network' as const, accuracy: 380 };
    expect(selectMapLocation(null, network, now)).toMatchObject({ source: 'network', accuracy: 380 });
    expect(selectMapLocation(null, { ...gps, mock: true }, now)).toBeNull();
    expect(selectMapLocation(null, gps, now, true)).toBeNull();
    const previous = selectMapLocation(null, gps, now);
    expect(selectMapLocation(previous, { ...gps, at: now + 1000, lat: 55.75 }, now + 1000)).toBe(previous);
  });
});
