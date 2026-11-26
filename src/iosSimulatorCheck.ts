import { Capacitor } from '@capacitor/core';
import { downloadNavigationPackage, initializeOfflineMaps, offlineRegions, searchOfflineAddresses } from './lib/offlineMaps';
import { iosOffline, offlineFiles } from './lib/iosOfflineFiles';
import { fetchRoutes } from './lib/routing';
import { plannedRoute, plannerViewport } from './lib/routePlanner';
import { placesStore, savePlace } from './lib/places';
import { hudSettingsStore } from './lib/hud';
import { navStore } from './lib/nav';
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
      if (/route\/v1|nominatim|photon|valhalla|geocod/i.test(url.href)) externalRequests++;
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
    savePlace({ ...manifest.center, name: 'iOS fixture', placeType: 'home', label: 'iOS fixture' });
    hudSettingsStore.set((s) => ({ ...s, style: 'game', mirror: true }));
  } else if (!placesStore.get().some((place) => place.label === 'iOS fixture') ||
      hudSettingsStore.get().style !== 'game' || !hudSettingsStore.get().mirror || !plannedRoute.get().route?.offlineGraph) {
    throw new Error('Saved place, HUD settings or route lost after reinstalling the application');
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
  window.dispatchEvent(new Event('offline'));
  externalRequests = 0;
  const distances = [];
  let selected: Awaited<ReturnType<typeof fetchRoutes>>[number] | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const [route] = await fetchRoutes(from, to);
    if (route.coords.length < 3 || route.steps.length < 2 || !route.offlineGraph) throw new Error('Invalid offline route');
    distances.push(route.distance);
    selected = route;
  }
  if (externalRequests !== 0) throw new Error('Offline routing made an external request');
  if (!selected) throw new Error('No selected route');
  plannedRoute.set({ from, to, route: selected });
  navStore.set((state) => ({ ...state, status: 'preview', dest: to, route: selected ?? null, routes: selected ? [selected] : [] }));
  const rendered = await drawPreview(from);
  return { stage, region: region.name, graphTiles: region.graph.length, distances, externalRequests, rendered };
}

async function drawPreview(from: { lat: number; lon: number }) {
  const view = window as Window & { __aceMap?: { map: {
    jumpTo(at: { center: [number, number]; zoom: number }): void;
    getLayer(id: string): unknown;
    queryRenderedFeatures(options: { layers: string[] }): unknown[];
  } } };
  for (let attempt = 0; attempt < 30 && !view.__aceMap; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const map = view.__aceMap?.map;
  if (!map) return false;
  map.jumpTo({ center: [from.lon, from.lat], zoom: 15 });
  for (let attempt = 0; attempt < 40; attempt++) {
    if (map.getLayer('route-line') && map.queryRenderedFeatures({ layers: ['route-line'] }).length) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
