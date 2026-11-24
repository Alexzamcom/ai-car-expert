import { expect, it } from 'vitest';
import { locationDiagnosticsJson, recordLocationSample, recordLocationStatus } from '../../src/lib/geo/locationDiagnostics';

it('exports bounded Android location metadata even for rejected fixes, omitting location and motion', () => {
  recordLocationStatus({ fine: true, coarse: true, playServices: 0, fusedStatus: 'watching', gpsEnabled: false, networkEnabled: true });
  for (let i = 0; i < 70; i++) recordLocationSample({
    source: 'network', cached: true, accuracy: 380, lat: 12.34567, lon: 45.6789, speed: 20, heading: 45, at: i,
  }, 1234, 'Недостаточная заявленная точность');
  const json = locationDiagnosticsJson();
  const payload = JSON.parse(json);
  expect(payload.samples).toHaveLength(60);
  expect(payload.samples.at(-1)).toEqual({
    source: 'network', accuracy: 380, cached: true, at: 69, receivedAt: 1234, ageMs: 1165, reason: 'Недостаточная заявленная точность',
  });
  expect(payload.status).toMatchObject({ playServices: 0, networkEnabled: true });
  expect(json).not.toMatch(/latitude|longitude|"lat"|"lon"|"speed"|"heading"|12\.34567|45\.6789/);
});
