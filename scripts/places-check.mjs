// «Мои места» в браузере с постоянным профилем (как установленное приложение): добавление по GPS, из поиска адресов
// и из карточки точки, переименование, удаление, маршрут в одно касание, закрытие и повторный запуск браузера,
// восстановление из резервной копии после очистки localStorage, перенос прежних «Дом/Работа».
//
//   node scripts/places-check.mjs <url> <папка> [--mock]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const args = process.argv.slice(2);
const [url = 'http://localhost:4173/', out = 'places-check'] = args.filter((a) => !a.startsWith('--'));
const MOCK = args.includes('--mock');
fs.mkdirSync(out, { recursive: true });
const F = (n) => fs.readFileSync(new URL(`../tests/fixtures/${n}`, import.meta.url), 'utf8');
const json = (b) => ({ status: 200, contentType: 'application/json', body: b });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const DEVICES = [
  ['iPad', { ...devices['iPad Pro 11'], viewport: { width: 1024, height: 1366 } }],
  ['iPhone 15', devices['iPhone 15']],
  ['Pixel 7', devices['Pixel 7']],
];
const GPS = { latitude: 48.4668, longitude: 35.0459, accuracy: 8 };

async function open(dir, dev) {
  const { defaultBrowserType: _b, ...opts } = dev;
  const ctx = await chromium.launchPersistentContext(dir, { ...opts, geolocation: GPS, permissions: ['geolocation'], serviceWorkers: 'block' });
  await ctx.route(/openfreemap|\.pbf/, (r) => r.fulfill({ status: 204 }));
  if (MOCK) {
    await ctx.route('**/nominatim.openstreetmap.org/**', (r) => r.fulfill(json(F(r.request().url().includes('/reverse') ? 'nominatim-reverse.json' : 'nominatim.json'))));
    await ctx.route('**/photon.komoot.io/**', (r) => r.fulfill(json('{"features":[]}')));
    for (const h of ['**/routing.openstreetmap.de/**', '**/router.project-osrm.org/**']) await ctx.route(h, (r) => r.fulfill(json(F('osrm-route.json'))));
  }
  // Карта Leaflet — проверяются места, а не движок карты (быстрее на CI без видеокарты). Места не трогаем.
  await ctx.addInitScript(() => {
    const s = JSON.parse(localStorage.getItem('ace:settings') || '{}');
    localStorage.setItem('ace:settings', JSON.stringify({ ...s, mapEngine: 'leaflet', mapEngineExplicit: true }));
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector('#map-search', { timeout: 30000 }).catch(() => {});
  return { ctx, page };
}

const panel = async (page) => {
  // Пустой поиск — панель показывает «Мои места», а не результаты прошлого поиска.
  await page.fill('#map-search', '').catch(() => {});
  await page.evaluate(() => document.querySelector('#map-search')?.focus());
  await page.click('#map-search').catch(() => {});
  await page.waitForSelector('.my-places', { timeout: 8000 }).catch(() => {});
};
const rows = (page) => page.evaluate(() => [...document.querySelectorAll('.my-place')].map((r) => r.querySelector('strong')?.textContent));
const saved = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('ace:places') || 'null'));
const click = (page, sel, text) => page.evaluate(([s, t]) => [...document.querySelectorAll(s)].find((b) => !t || b.textContent.includes(t))?.click(), [sel, text]);
const setLabel = async (page, v) => {
  await page.fill('.place-editor input[aria-label="Название места"]', v);
};
const saveEditor = async (page) => {
  await page.waitForFunction(() => !document.querySelector('.place-editor-actions .btn-primary')?.disabled, null, { timeout: 15000 }).catch(() => {});
  await click(page, '.place-editor-actions .btn-primary', 'Сохранить');
  await page.waitForSelector('.place-editor', { state: 'detached', timeout: 5000 }).catch(() => {});
};

async function runDevice(name, dev) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-places-'));
  let { ctx, page } = await open(dir, dev);
  await panel(page);
  const addVisible = await page.locator('.my-places-add').isVisible().catch(() => false);
  check(`${name}: кнопка «+ Добавить место» видна в панели поиска`, addVisible);

  // 1. По текущему GPS, тип «Гараж»
  await page.click('.my-places-add');
  await page.waitForSelector('.place-editor', { timeout: 5000 });
  await click(page, '.place-editor [role=radio]', 'Гараж');
  await click(page, '.place-editor .btn', 'Текущее местоположение');
  await page.waitForFunction(() => /\d+\.\d{5}, \d+\.\d{5}/.test(document.querySelector('[data-testid=place-point]')?.textContent ?? ''), null, { timeout: 15000 }).catch(() => {});
  await saveEditor(page);
  // 2. Из поиска адресов в редакторе, своё название
  await panel(page);
  await page.click('.my-places-add');
  await setLabel(page, 'Дача');
  await page.fill('.place-editor input[aria-label="Найти адрес для места"]', 'Театр Сатиры');
  await page.press('.place-editor input[aria-label="Найти адрес для места"]', 'Enter');
  await page.waitForSelector('.place-editor-found .place-row', { timeout: 20000 }).catch(() => {});
  await click(page, '.place-editor-found .place-row');
  await saveEditor(page);
  // 3. Из карточки точки (поиск на карте → точка → «В мои места»), тип «Дом»
  await page.fill('#map-search', 'Театр Сатиры');
  await page.press('#map-search', 'Enter');
  await page.waitForSelector('.map-panel .place-row', { timeout: 20000 }).catch(() => {});
  await click(page, '.map-panel .place-row');
  await page.waitForSelector('.pick-card', { timeout: 10000 }).catch(() => {});
  await click(page, '.pick-card .btn', 'В мои места');
  await page.waitForSelector('.place-editor', { timeout: 5000 }).catch(() => {});
  await click(page, '.place-editor [role=radio]', 'Дом');
  await saveEditor(page);
  // Карточка точки остаётся (можно сразу построить маршрут); закрываем её — на телефоне поиск скрыт, пока она открыта.
  await click(page, '.pick-card .btn', 'Отмена');
  await panel(page);
  const r1 = await rows(page);
  const s1 = await saved(page);
  check(
    `${name}: места по GPS, из поиска и из карточки точки; свои названия и типы`,
    r1.join('|') === 'Дом|Гараж|Дача' && s1?.length === 3 && s1.some((p) => p.placeType === 'garage') && s1.some((p) => p.placeType === 'home'),
    JSON.stringify(r1),
  );
  await page.screenshot({ path: `${out}/places-${name.replace(/\W+/g, '-')}.png` });

  // 4. Переименование и удаление
  await click(page, '.my-place .icon-btn[aria-label="Изменить: Дача"]');
  await page.waitForSelector('.place-editor', { timeout: 5000 }).catch(() => {});
  await setLabel(page, 'Дача у реки');
  await saveEditor(page);
  await panel(page);
  await click(page, '.my-place .icon-btn[aria-label="Изменить: Гараж"]');
  await page.waitForSelector('.place-editor', { timeout: 5000 }).catch(() => {});
  await click(page, '.place-editor-actions .btn', 'Удалить');
  await click(page, '.place-editor-actions .btn', 'Точно удалить');
  await page.waitForSelector('.place-editor', { state: 'detached', timeout: 5000 }).catch(() => {});
  await panel(page);
  const r2 = await rows(page);
  check(`${name}: переименование и удаление`, r2.join('|') === 'Дом|Дача у реки', JSON.stringify(r2));

  // 5. Маршрут в одно касание
  await click(page, '.my-place-go', 'Дом');
  await page.waitForSelector('.route-card .dest-name', { timeout: 15000 }).catch(() => {});
  const dest = await page.locator('.route-card .dest-name').textContent().catch(() => null);
  check(`${name}: маршрут к месту в одно касание`, dest === 'Дом', String(dest));
  await click(page, '.route-card .icon-btn[aria-label="Сбросить маршрут"]');

  // 6. Закрытие и повторный запуск браузера (как закрыть и открыть приложение)
  await ctx.close();
  ({ ctx, page } = await open(dir, dev));
  await panel(page);
  const r3 = await rows(page);
  check(`${name}: после закрытия и повторного запуска места на месте`, r3.join('|') === 'Дом|Дача у реки', JSON.stringify(r3));
  const homeBtn = await page.locator('.home-work button:has-text("Домой")').isVisible().catch(() => false);
  check(`${name}: «Домой» в одно касание после перезапуска`, homeBtn);

  // 7. localStorage очищен (например, другим приложением на том же адресе) — восстановление из резервной копии
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#map-search', { timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => (JSON.parse(localStorage.getItem('ace:places') || '[]') ?? []).length === 2, null, { timeout: 10000 }).catch(() => {});
  await panel(page);
  const r4 = await rows(page);
  const note = await page.locator('.my-places-note').textContent().catch(() => '');
  check(`${name}: после очистки localStorage — места восстановлены из резервной копии, с уведомлением`, r4.join('|') === 'Дом|Дача у реки' && /восстановлены/.test(note ?? ''), JSON.stringify({ r4, note }));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

async function runMigration() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-places-m-'));
  let { ctx, page } = await open(dir, DEVICES[0][1]);
  // Данные прежней версии: только «Дом/Работа» и «Избранное», нового списка ещё нет.
  await page.evaluate(() => {
    localStorage.removeItem('ace:places');
    localStorage.setItem('ace:saved-places', JSON.stringify({ home: { id: 'h', name: 'ул. Шевченко, 5', address: 'Днепр', lat: 48.46, lon: 35.04 }, work: null }));
    localStorage.setItem('ace:favorites', JSON.stringify([{ id: 'f', name: 'Шиномонтаж', address: '', lat: 48.5, lon: 35.1 }]));
  });
  // Резервная копия от первого запуска пуста — перенос должен идти из прежних ключей.
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#map-search', { timeout: 30000 }).catch(() => {});
  await panel(page);
  const r = await rows(page);
  const s = await saved(page);
  check('Обновление приложения: прежние «Дом» и «Избранное» перенесены в «Мои места», ничего не потеряно', r.join('|') === 'Дом|Шиномонтаж' && s?.[0]?.placeType === 'home', JSON.stringify(r));
  // Повторная загрузка (ещё одно «обновление») не перезаписывает список
  await page.evaluate(() => localStorage.setItem('ace:places', JSON.stringify([...JSON.parse(localStorage.getItem('ace:places')), { id: 'x', name: 'СТО', address: '', lat: 48.6, lon: 35.2, placeType: 'service', label: 'СТО', savedAt: 1 }])));
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#map-search', { timeout: 30000 }).catch(() => {});
  await panel(page);
  const r2 = await rows(page);
  check('Повторный запуск после обновления — список не перезаписывается прежними данными', r2.join('|') === 'Дом|СТО|Шиномонтаж', JSON.stringify(r2));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

try {
  for (const [name, dev] of DEVICES) await runDevice(name, dev).catch((e) => check(`${name}: сценарий выполнен`, false, String(e).slice(0, 300)));
  await runMigration().catch((e) => check('Перенос: сценарий выполнен', false, String(e).slice(0, 300)));
} finally {
  const failed = results.filter((r) => !r.ok);
  console.log(`\nПройдено ${results.length - failed.length}/${results.length}, провалов: ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
}
