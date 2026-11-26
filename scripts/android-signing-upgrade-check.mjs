import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { _android as android } from 'playwright';

const [baseline, update] = process.argv.slice(2);
assert(baseline && update);
const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8', timeout: 90_000 }).trim();
assert.match(adb('get-serialno'), /^emulator-\d+$/, 'This test clears the app on a disposable emulator only');
const app = 'com.aicarexpert.app';
const activity = app + '/.MainActivity';
let [device] = await android.devices();
assert(device);
const open = async () => {
  adb('shell', 'am', 'start', '-W', '-n', activity);
  const webview = await device.webView({ pkg: app }, { timeout: 60_000 });
  const page = await webview.page();
  await page.waitForFunction(() => location.origin === 'https://localhost' && !!document.querySelector('.app'));
  return page;
};

try {
  assert.match(adb('install', '--no-streaming', '-g', baseline), /^Success\s*$/m);
  let page = await open();
  const snapshot = await page.evaluate(async () => {
    const items = {
      'ace:places': [{ id: 'upgrade-home', name: 'Upgrade fixture', label: 'Upgrade fixture', lat: 48.53, lon: 35.87, placeType: 'home', address: '', savedAt: 123 }],
      'ace:hud': { style: 'game', mirror: true },
      'ace:settings': { speechLang: 'uk-UA' },
    };
    for (const [key, value] of Object.entries(items)) localStorage.setItem(key, JSON.stringify(value));
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('ace-offline-maps', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('regions', { keyPath: 'name' });
        req.result.createObjectStore('resources');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['regions', 'resources'], 'readwrite');
      tx.objectStore('regions').put({
        name: 'Upgrade fixture', id: 'upgrade', center: { lat: 48.53, lon: 35.87 },
        bounds: [35, 48, 36, 49], bytes: 3, updated: 123, graph: ['graph/test'],
        style: { version: 8, sources: {}, layers: [] },
      });
      tx.objectStore('resources').put(new Uint8Array([1, 3, 9]).buffer, 'upgrade/graph/test');
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    return items;
  });
  await device.close();
  adb('shell', 'am', 'force-stop', app);
  assert.match(adb('install', '--no-streaming', '-r', update), /^Success\s*$/m);
  console.log('adb install -r accepted the updated APK under the same test certificate.');
  [device] = await android.devices();
  assert(device);
  page = await open();
  const restored = await page.evaluate(async (keys) => {
    const data = Object.fromEntries(keys.map((key) => [key, JSON.parse(localStorage.getItem(key))]));
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('ace-offline-maps', 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const read = (store, key) => new Promise((resolve, reject) => {
      const req = db.transaction(store).objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const region = await read('regions', 'Upgrade fixture');
    const bytes = [...new Uint8Array(await read('resources', 'upgrade/graph/test'))];
    db.close();
    return { data, region, bytes };
  }, Object.keys(snapshot));
  for (const [key, value] of Object.entries(snapshot)) {
    if (Array.isArray(value)) assert.deepEqual(restored.data[key], value);
    else for (const [field, expected] of Object.entries(value)) assert.equal(restored.data[key]?.[field], expected);
  }
  assert.equal(restored.region?.id, 'upgrade');
  assert.deepEqual(restored.bytes, [1, 3, 9]);
  console.log('Baseline → update, same test signer: adb install -r preserved offline store, places and preferences.');
} finally {
  await device.close();
  adb('uninstall', app);
}
