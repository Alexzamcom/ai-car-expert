import { Capacitor } from '@capacitor/core';
import { downloadNavigationPackage, initializeOfflineMaps, offlineRegions, searchOfflineAddresses } from './lib/offlineMaps';
import { iosOffline, offlineFiles } from './lib/iosOfflineFiles';
import { fetchRoutes } from './lib/routing';
import { plannerViewport } from './lib/routePlanner';
import { validateOfflinePackage } from './lib/offlinePackageFormat';

const smoke = window as Window & { __aceIOSRun?: (stage: string) => void; __aceIOSResult?: string };
const fixture = new URL('./ios-smoke-data/', location.href);
const packageOrigin = 'https://ace-ios-fixture.invalid/';
let started = false;

smoke.__aceIOSRun = (stage) => {
  if (started) return;
  started = true;
  void run(stage).then((result) => { smoke.__aceIOSResult = JSON.stringify({ ok: true, ...result }); },
    (error) => { smoke.__aceIOSResult = JSON.stringify({ ok: false, error: String(error), stack: error?.stack }); });
};

async function run(stage: string) {
  if (Capacitor.getPlatform() !== 'ios' || !iosOffline() ||
      !Capacitor.isPluginAvailable('NativePosition') || !Capacitor.isPluginAvailable('TripSensors')) {
    throw new Error('iOS Capacitor plugins unavailable');
  }
  const original = window.fetch.bind(window);
  let externalRequests = 0;
  window.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.href.startsWith(packageOrigin) && stage === 'install') {
      return original(new URL(url.pathname.slice(1), fixture), init);
    }
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      externalRequests++;
      return Promise.reject(new Error('External fetch disabled in iOS simulator check'));
    }
    return original(input, init);
  };
  await initializeOfflineMaps();
  if (stage === 'install') {
    const response = await original(new URL('manifest.json', fixture));
    const manifest = validateOfflinePackage(await response.json());
    if (!manifest.center) throw new Error('Fixture lacks its settlement center');
    await downloadNavigationPackage('Павлоград', manifest.center, 25, packageOrigin + 'manifest.json', manifest, () => {});
    localStorage.setItem('ace:ios-smoke-persisted', 'true');
  } else if (localStorage.getItem('ace:ios-smoke-persisted') !== 'true') {
    throw new Error('WebView settings were lost after reinstalling the application');
  }
  const [region] = offlineRegions.get();
  if (!region?.graph?.length || !(await offlineFiles.regions()).entries.some(({ id }) => id === region.id)) {
    throw new Error('Persistent offline package is unavailable');
  }
  const anchor = plannerViewport({ manual: true, rechecking: false, point: null }, { lat: -12, lon: -77 }, [region]);
  if (anchor.source !== 'region') throw new Error('Manual picker has no installed region');
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
  const from = (await searchOfflineAddresses('Соборна вулиця 93/2'))[0];
  const to = (await searchOfflineAddresses('вулиця Незалежності 156'))[0];
  if (!from || !to) throw new Error('Offline address index did not resolve both addresses');
  externalRequests = 0;
  const distances = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const [route] = await fetchRoutes(from, to);
    if (route.coords.length < 3 || route.steps.length < 2 || !route.offlineGraph) throw new Error('Invalid offline route');
    distances.push(route.distance);
  }
  if (externalRequests !== 0) throw new Error('Offline routing made an external request');
  return { stage, region: region.name, graphTiles: region.graph.length, distances, externalRequests };
}
