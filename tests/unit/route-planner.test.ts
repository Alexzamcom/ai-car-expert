import { afterEach, describe, expect, it } from 'vitest';
import { geoStore, handleFix, trustedPlannerPosition, __resetGeo } from '../../src/lib/nav';
import { positionMode, recoveryNearManual } from '../../src/lib/routePlanner';

const pavlohrad = { lat: 48.53, lon: 35.87 };
const otherContinent = { lat: -4, lon: 28 };
const initial = { manual: false, rechecking: false, point: null };

afterEach(() => {
  positionMode.set(initial);
  __resetGeo();
});

describe('manual route start and GNSS hand-back', () => {
  it('keeps manual position isolated from incoming fixes', () => {
    const now = Date.now();
    const point = { ...pavlohrad, at: now };
    positionMode.set({ manual: true, rechecking: false, point });
    handleFix({ ...otherContinent, accuracy: 7, speed: 0, heading: null, timestamp: now }, now);
    expect(geoStore.get().lat).toBeNull();
    expect(positionMode.get().point).toEqual(point);
    expect(trustedPlannerPosition(now)).toBeNull();
  });

  it('requires fresh fixes near an independent manual anchor after hand-back', () => {
    const now = Date.now();
    const anchor = { ...pavlohrad, at: now };
    expect(recoveryNearManual(otherContinent, anchor, now + 5000)).toBe(false);
    expect(recoveryNearManual({ lat: 48.531, lon: 35.871 }, anchor, now + 5000)).toBe(true);
    positionMode.set({ manual: false, rechecking: true, point: anchor });
    expect(trustedPlannerPosition(now)).toBeNull();
  });
});
