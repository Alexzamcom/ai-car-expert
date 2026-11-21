// npx vite-node scripts/replay-trip.ts trip.json [reference.json]
import { readFileSync } from 'node:fs';
import { replay, type GpsScenario, type Trip } from '../src/lib/autonomy/trip';
import type { Variant } from '../src/lib/autonomy/estimator';
import { haversine, type LatLon } from '../src/lib/routing';

const [path, referencePath] = process.argv.slice(2);
if (!path) throw new Error('Usage: npx vite-node scripts/replay-trip.ts trip.json [reference.json]');
const trip = JSON.parse(readFileSync(path, 'utf8')) as Trip;
const reference = referencePath ? JSON.parse(readFileSync(referencePath, 'utf8')) as { at: number; position: LatLon }[] : [];
reference.sort((a, b) => a.at - b.at);
const variants: Variant[] = ['inertial', 'road', 'hybrid'];
const scenarios: GpsScenario[] = ['recorded', 'blackout', 'frozen', 'jump', 'smooth'];
console.table(variants.flatMap((variant) => scenarios.map((scenario) => {
  const out = replay(trip, variant, scenario, reference);
  return { variant, scenario, paired: out.referenceCount, rmsM: out.rmsM?.toFixed(2) ?? '—',
    userEndpointM: trip.feedback?.actual ? haversine(out.endpoint, trip.feedback.actual).toFixed(2) : '—',
    estimatedUncertaintyM: out.endpoint.uncertainty.toFixed(2) };
})));
