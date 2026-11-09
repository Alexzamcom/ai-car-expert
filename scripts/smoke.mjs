// Smoke-тест интерфейса: node scripts/smoke.mjs <url> [папка] [--mock]
// --mock: внешние сервисы (маршруты, адреса, объекты, каталог радио) подменяются данными
//         из tests/fixtures — проверка детерминирована. Без --mock — реальные сервисы.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const args = process.argv.slice(2);
const MOCK = args.includes('--mock');
const [url = 'http://localhost:4173/', out = 'smoke'] = args.filter((a) => !a.startsWith('--'));
fs.mkdirSync(out, { recursive: true });
const fixture = (f) => fs.readFileSync(path.resolve('tests/fixtures', f), 'utf8');

const results = [];
const check = (name, ok, info = '') => {
  results.push({ name, ok: Boolean(ok), info });
  console.log(`${ok ? '✓' : '✗'} ${name}${info ? ` — ${info}` : ''}`);
};
// Сбои внешних сервисов (тайлы, потоки) видны в отчёте, но не валят проверку.
const SOFT = new Set(['Тайлы карты', 'Радио играет', 'Маршрут (реальный сервис)', 'АЗС по пути (реальный сервис)', 'Каталог радио (реальный сервис)']);

const ROUTE_POS = [
  { latitude: 55.757, longitude: 37.6156 },
  { latitude: 55.763, longitude: 37.608 },
  { latitude: 55.769, longitude: 37.6 },
];

async function mockNetwork(ctx) {
  // ChatGPT открывается во внешнем окне; в тесте отвечает заглушка (реальный сервис не нагружаем).
  await ctx.route('https://chatgpt.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>ChatGPT stub</title>' }));
  if (!MOCK) return;
  const json = (body) => ({ status: 200, contentType: 'application/json', body, headers: { 'Access-Control-Allow-Origin': '*' } });
  await ctx.route('**/router.project-osrm.org/**', (r) => r.fulfill(json(fixture('osrm-route.json'))));
  await ctx.route('**/nominatim.openstreetmap.org/**', (r) => r.fulfill(json(fixture('nominatim.json'))));
  await ctx.route('**/overpass-api.de/**', (r) => r.fulfill(json(fixture('overpass-fuel.json'))));
  await ctx.route('**/*.api.radio-browser.info/**', (r) =>
    r.fulfill(json(r.request().url().includes('/json/servers') ? JSON.stringify([{ name: 'de1.api.radio-browser.info' }]) : fixture('radio-browser.json'))),
  );
}

/** Пересечения элементов поверх карты и горизонтальная прокрутка страницы. */
async function layoutProblems(page) {
  return page.evaluate(() => {
    const problems = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) problems.push(`горизонтальная прокрутка ${document.documentElement.scrollWidth}>${innerWidth}`);
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden' ? r : null;
    };
    // Кнопки карты проверяем по отдельности: контейнер мог быть меньше вылезших из него кнопок.
    const sel = ['.map-search', '.maneuver', '.map-ctl', '.map-speed', '.route-card', '.poi-card', '.geo-chip'];
    const rects = sel.flatMap((s) => [...document.querySelectorAll(s)].map((el) => [s, vis(el)])).filter(([, r]) => r);
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const [a, ra] = rects[i];
        const [b, rb] = rects[j];
        const ix = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const iy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (ix > 2 && iy > 2) problems.push(`${a} перекрывает ${b}`);
      }
    // Элементы карты не выходят за её пределы.
    const map = document.querySelector('.drive-map')?.getBoundingClientRect();
    if (map) for (const [s, r] of rects) if (r.right > map.right + 2 || r.left < map.left - 2 || r.bottom > map.bottom + 2) problems.push(`${s} выходит за карту`);
    // Кнопки дока и заголовок панели помещаются.
    for (const el of document.querySelectorAll('.dock > *, .panel-head, .statusbar')) {
      const r = el.getBoundingClientRect();
      if (r.right > innerWidth + 1 || r.left < -1) problems.push(`${el.className} за краем экрана`);
    }
    for (const el of document.querySelectorAll('.panel-head, .page-head, .statusbar')) {
      if (el.scrollWidth > el.clientWidth + 2) problems.push(`${el.className.split(' ')[0]} не помещается (${el.scrollWidth}>${el.clientWidth})`);
    }
    return problems;
  });
}

/** Кнопка ChatGPT: видна, помещается, подсказка о возврате, открытие в новом окне, возврат, без iframe. */
async function checkChatGpt(name, ctx, page) {
  const btn = page.locator('.dock [aria-label="Открыть ChatGPT"]');
  const box = await btn.boundingBox();
  const vp = page.viewportSize();
  check(`${name}: кнопка ChatGPT на главном экране`, box && box.width >= 44 && box.height >= 44 && box.x >= 0 && box.x + box.width <= vp.width + 1, box ? `${Math.round(box.width)}×${Math.round(box.height)}` : 'нет');
  check(`${name}: ChatGPT без iframe`, (await page.locator('iframe').count()) === 0);
  await btn.click();
  const link = page.locator('.cg-sheet a:has-text("Открыть ChatGPT")');
  const sheetOk = (await link.count()) === 1 && (await link.getAttribute('href')) === 'https://chatgpt.com/' && (await link.getAttribute('target')) === '_blank';
  const sheetPr = await page.evaluate(() => {
    const r = document.querySelector('.cg-sheet')?.getBoundingClientRect();
    return r ? r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1 : false;
  });
  check(`${name}: подсказка о возврате перед первым открытием`, sheetOk && sheetPr && (await page.locator('.cg-return li').count()) > 0);
  const [popup] = await Promise.all([ctx.waitForEvent('page', { timeout: 10000 }), link.click()]);
  await popup.waitForLoadState().catch(() => {});
  check(`${name}: ChatGPT открывается в новом окне, AI Car Expert остаётся`, popup.url().startsWith('https://chatgpt.com/') && page.url().includes(new URL(url).host), popup.url());
  await popup.close();
  await page.waitForTimeout(1700);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(300);
  const back = (await page.locator('.toast').allTextContents()).join(' ');
  check(`${name}: возвращение — сообщение и сохранённое состояние`, back.includes('С возвращением') && (await page.locator('.drive-map .leaflet-container').count()) === 1, back.slice(0, 60));
  const tag = await page.locator('.dock [aria-label="Открыть ChatGPT"]').evaluate((el) => `${el.tagName}|${el.getAttribute('href')}|${el.getAttribute('target')}`);
  check(`${name}: повторное нажатие открывает ChatGPT сразу`, tag === 'A|https://chatgpt.com/|_blank', tag);
}

/** Переключить тему кнопкой в статус-баре до нужного режима (без перезагрузки). */
async function setThemeMode(page, mode) {
  for (let i = 0; i < 3; i++) {
    const cur = await page.evaluate(() => JSON.parse(localStorage.getItem('ace:settings') || '{}').theme ?? 'auto');
    if (cur === mode) return;
    await page.click('.sb-theme');
    await page.waitForTimeout(150);
  }
}

const bgLuminance = (page) =>
  page.evaluate(() => {
    const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  });

/** Обе темы: переключение без перезагрузки, внешний вид, наложения, ночной фильтр карты. */
async function checkThemes(name, page, out, slug) {
  const marker = await page.evaluate(() => (window.__aceMarker = Math.random()));
  for (const mode of ['day', 'night']) {
    await setThemeMode(page, mode);
    const switching = await page.evaluate(() => document.documentElement.classList.contains('theme-switching'));
    await page.waitForTimeout(700);
    const active = await page.evaluate(() => document.documentElement.dataset.theme);
    const lum = await bgLuminance(page);
    const filter = await page.evaluate(() => getComputedStyle(document.querySelector('.leaflet-tile-pane')).filter);
    const pr = await layoutProblems(page);
    const ok = active === mode && (mode === 'day' ? lum > 0.8 : lum < 0.1) && (mode === 'night' ? filter.includes('invert') : filter === 'none');
    check(`${name}: тема «${mode === 'day' ? 'День' : 'Ночь'}»`, ok && !pr.length, `${active}, яркость фона ${lum.toFixed(2)}${pr.length ? '; ' + pr.join('; ') : ''}${switching ? ', плавно' : ''}`);
    await page.screenshot({ path: `${out}/theme-${slug}-${mode}.png` });
  }
  const same = await page.evaluate((m) => window.__aceMarker === m, marker);
  check(`${name}: тема меняется без перезагрузки`, same);
}

const browser = await chromium.launch();
const errors = [];
const tileHosts = new Set();
let cartoRequests = 0;

async function newPage(device, extra = {}) {
  const ctx = await browser.newContext({
    ...device,
    locale: 'ru-RU',
    geolocation: { latitude: 55.757, longitude: 37.6156, accuracy: 10 },
    permissions: ['geolocation'],
    ...extra,
  });
  await mockNetwork(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (/\/\d+\/\d+\/\d+(@2x)?\.png$/.test(u.pathname)) tileHosts.add(u.hostname);
    if (u.hostname.includes('cartocdn') || u.hostname.includes('carto.com')) cartoRequests++;
  });
  return { ctx, page };
}

try {
  /* ---------- iPad Pro 12,9″ вертикально ---------- */
  const ipad = {
    viewport: { width: 1024, height: 1366 },
    deviceScaleFactor: 2,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  };
  const { ctx, page } = await newPage(ipad);
  const res = await page.goto(url, { waitUntil: 'networkidle' });
  check('Страница открывается', res?.ok(), `HTTP ${res?.status()}`);
  check('Заголовок', (await page.title()) === 'AI Car Expert');
  const manifest = await page.evaluate(async () => {
    const r = await fetch(document.querySelector('link[rel=manifest]').href);
    return r.ok ? r.json() : null;
  });
  check('Манифест PWA', manifest?.name === 'AI Car Expert');
  const sw = await page.evaluate(() =>
    Promise.race([navigator.serviceWorker.ready.then((r) => Boolean(r.active)), new Promise((r) => setTimeout(() => r(false), 15000))]),
  );
  check('Service worker активен', sw === true);

  await page.waitForSelector('.drive-map .leaflet-container', { timeout: 15000 });
  check('Главный экран: карта и панель', (await page.locator('.drive-map').isVisible()) && (await page.locator('.panel').isVisible()));
  const mapBox = await page.locator('.drive-map').boundingBox();
  check('Карта — крупнейший элемент экрана', mapBox && mapBox.height > 600, `${Math.round(mapBox?.height ?? 0)} px`);
  check('Профиль Peugeot 3008 по умолчанию', (await page.locator('.sb-vehicle-text strong').textContent())?.includes('Peugeot 3008'));
  await page.waitForTimeout(2500);
  check('Тайлы карты', (await page.locator('.leaflet-tile-loaded').count()) > 0);
  let problems = await layoutProblems(page);
  check('iPad: без наложений', !problems.length, problems.join('; '));
  await page.screenshot({ path: `${out}/01-ipad-home.png` });

  // Маршрут
  await page.fill('#map-search', 'Театр Сатиры');
  await page.press('#map-search', 'Enter');
  const firstResult = page.locator('.map-panel .place-row').first();
  await firstResult.waitFor({ timeout: 15000 }).catch(() => {});
  const haveResults = (await page.locator('.map-panel .place-row').count()) > 0;
  check(MOCK ? 'Поиск адреса' : 'Поиск адреса (реальный сервис)', haveResults);
  if (haveResults) {
    await firstResult.click();
    await page.waitForSelector('.route-card .btn-primary, .route-card .text-warn', { timeout: 20000 }).catch(() => {});
    const routed = (await page.locator('.route-card .btn-primary').count()) > 0;
    check(MOCK ? 'Маршрут построен' : 'Маршрут (реальный сервис)', routed, (await page.locator('.route-card .muted.small').first().textContent().catch(() => '')) ?? '');
    problems = await layoutProblems(page);
    check('Карточка маршрута без наложений', !problems.length, problems.join('; '));
    await page.screenshot({ path: `${out}/02-ipad-route.png` });
    if (routed) {
      await page.click('.route-card .btn-primary');
      await page.waitForSelector('.maneuver', { timeout: 5000 });
      const instr = await page.locator('.maneuver-instr').textContent();
      check('Ведение: манёвр показан', Boolean(instr), instr);
      if (MOCK) check('Ведение: первый манёвр — поворот направо', instr?.includes('направо'), instr);
      await ctx.setGeolocation({ ...ROUTE_POS[1], accuracy: 10 });
      await page.waitForTimeout(800);
      check('Статус-бар показывает прибытие', await page.locator('.sb-route').isVisible());
      await page.click('.route-guiding button[aria-label="АЗС по пути"]');
      await page.waitForSelector('.poi-card .place-row, .poi-card .text-warn', { timeout: 45000 }).catch(() => {});
      const poiCount = await page.locator('.poi-card .place-row').count();
      const poiErr = poiCount ? '' : ((await page.locator('.poi-card .text-warn').first().textContent().catch(() => '')) ?? '');
      check(MOCK ? 'АЗС по пути' : 'АЗС по пути (реальный сервис)', poiCount > 0, `найдено ${poiCount}${poiErr ? ` — ${poiErr}` : ''}`);
      problems = await layoutProblems(page);
      check('Ведение и список АЗС без наложений', !problems.length, problems.join('; '));
      await page.screenshot({ path: `${out}/03-ipad-guiding-fuel.png` });
      if (poiCount) {
        await page.locator('.poi-card .place-row').first().click();
        await page.waitForTimeout(800);
        check('Остановка добавлена в маршрут', (await page.locator('.maneuver, .via-line').count()) > 0);
      }
      await page.locator('.route-guiding .btn-danger').click().catch(() => {});
    }
  }

  // Панели
  for (const [label, sel] of [
    ['Музыка и радио', '.now-playing'],
    ['Помощник Grok', '.composer'],
    ['Приложения', '.app-grid'],
    ['Поездка', '.trip-stats'],
  ]) {
    await page.click(`.panel-tabs [aria-label="${label}"]`);
    check(`Вкладка «${label}»`, await page.locator(sel).first().isVisible());
  }
  const before = (await page.locator('.panel').boundingBox()).height;
  await page.click('.panel-actions [aria-label="Развернуть панель"]');
  const expanded = (await page.locator('.panel').boundingBox()).height;
  await page.click('.panel-actions [aria-label="Уменьшить панель"]');
  await page.click('.panel-actions [aria-label="Свернуть панель"]');
  const collapsed = (await page.locator('.panel').boundingBox()).height;
  check('Панель разворачивается и сворачивается', expanded > before && collapsed < before, `${Math.round(collapsed)} < ${Math.round(before)} < ${Math.round(expanded)}`);
  await page.click('.panel-actions [aria-label="Показать панель"]');
  const mapY1 = (await page.locator('.drive-map').boundingBox()).y;
  await page.click('.panel-actions [aria-label="Поменять карту и панель местами"]');
  const mapY2 = (await page.locator('.drive-map').boundingBox()).y;
  check('Карта и панель переставляются', mapY2 > mapY1);
  await page.click('.panel-actions [aria-label="Поменять карту и панель местами"]');

  // Помощник без Grok
  await page.click('.panel-tabs [aria-label="Помощник Grok"]');
  const ask = async (q) => {
    const n = await page.locator('.msg-assistant .msg-bubble').count();
    await page.fill('#assistant-input', q);
    await page.click('.composer button[type=submit]');
    await page.waitForFunction((k) => document.querySelectorAll('.msg-assistant .msg-bubble').length > k, n, { timeout: 15000 });
    return page.locator('.msg-assistant .msg-bubble').last().innerText();
  };
  check('Помощник: код ошибки', (await ask('Что значит P0420?')).includes('каталитического'));
  check('Помощник: не изображает управление климатом', (await ask('включи кондиционер')).includes('не могу'));
  const auto = await ask('Как работает AUTO на климате?');
  check('Помощник: знает про AUTO климата Peugeot', auto.includes('AUTO'), auto.slice(0, 80));
  const oil = await ask('Какое масло нужно для моего двигателя?');
  check('Помощник: предупреждает о неподтверждённых данных', oil.includes('проверить'), oil.slice(0, 80));
  await page.screenshot({ path: `${out}/04-ipad-assistant.png` });

  // Дополнительные разделы
  for (const title of ['Мой автомобиль', 'Справочник', 'Сервис и обслуживание', 'Диагностика OBD-II', 'Настройки']) {
    await page.click('.dock [aria-label="Ещё разделы"]');
    await page.click(`.more-item:has-text("${title}")`);
    // Раздел должен быть сверху: точка в центре заголовка принадлежит самому разделу.
    const onTop = await page.evaluate(() => {
      const r = document.querySelector('.page-back').getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.page-sheet') != null;
    });
    const ok = onTop && (await page.locator('.page-title').textContent())?.includes(title);
    problems = await layoutProblems(page);
    check(`Раздел «${title}»`, ok && !problems.length, problems.join('; '));
    if (title === 'Мой автомобиль') await page.screenshot({ path: `${out}/05-ipad-vehicle.png` });
    await page.click('.page-back');
  }

  // Радио
  await page.click('.panel-tabs [aria-label="Музыка и радио"]');
  await page.click('.tab:has-text("Найти")');
  await page.click('.panel .chips .chip:has-text("Украина")');
  // Ждём результат именно в панели музыки (на карте может остаться чужое сообщение об ошибке).
  await page.waitForSelector('.panel .media .station-grid .station, .panel .media .list-note.text-warn', { timeout: 30000 }).catch(() => {});
  const found = await page.locator('.panel .media .station-grid .station').count();
  const radioErr = found ? '' : ((await page.locator('.panel .media .list-note.text-warn').first().textContent().catch(() => '')) ?? '');
  check(MOCK ? 'Каталог радио: только HTTPS MP3/AAC' : 'Каталог радио (реальный сервис)', MOCK ? found === 2 : found > 0, `станций: ${found}${radioErr ? ` — ${radioErr}` : ''}`);
  await page.click('.tab:has-text("Мои станции")');
  await page.locator('.station-main').first().click();
  await page
    .waitForFunction(() => document.querySelector('.np-info .eyebrow')?.textContent === 'Сейчас играет', null, { timeout: 15000 })
    .catch(() => {});
  check('Радио играет', (await page.locator('.np-info .eyebrow').textContent()) === 'Сейчас играет');
  await page.screenshot({ path: `${out}/06-ipad-media.png` });

  // Карта: OpenStreetMap с атрибуцией, без CARTO
  const attr = await page.evaluate(() => {
    const el = document.querySelector('.leaflet-control-attribution');
    const r = el?.getBoundingClientRect();
    const st = el && getComputedStyle(el);
    return { text: el?.textContent ?? '', visible: !!r && r.width > 40 && r.height > 8 && st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0.5, link: el?.querySelector('a[href*="openstreetmap.org/copyright"]') != null };
  });
  check('Атрибуция OpenStreetMap видна', attr.visible && attr.link && attr.text.includes('OpenStreetMap'), attr.text.trim());

  // Темы (iPad вертикально), авто по солнцу и сохранение выбора
  await page.click('.dock [aria-label="Ещё разделы"]');
  await page.click('.more-item:has-text("Настройки")');
  const status = (await page.locator('#theme-status').textContent()) ?? '';
  check('Тема «Авто» по восходу и закату при наличии геопозиции', status.includes('солнца'), status.slice(0, 90));
  await page.click('.page-back');
  await checkThemes('iPad', page, out, 'ipad');
  await setThemeMode(page, 'day');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  check('Выбранная тема сохраняется после перезапуска', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'day');
  await page.waitForSelector('.drive-map .leaflet-container');

  // ChatGPT по подписке (iPad вертикально)
  await checkChatGpt('iPad', ctx, page);

  // Горизонтальная ориентация iPad
  await page.setViewportSize({ width: 1366, height: 1024 });
  await page.waitForTimeout(500);
  const m = await page.locator('.drive-map').boundingBox();
  const p = await page.locator('.panel').boundingBox();
  check('iPad горизонтально: карта и панель рядом', m && p && Math.abs(m.y - p.y) < 5 && p.x > m.x);
  problems = await layoutProblems(page);
  check('iPad горизонтально: без наложений', !problems.length, problems.join('; '));
  await checkThemes('iPad горизонтально', page, out, 'ipad-landscape');
  await page.screenshot({ path: `${out}/07-ipad-landscape.png` });
  await ctx.close();

  /* ---------- Телефоны ---------- */
  for (const [name, dev] of [
    ['iPhone 15', devices['iPhone 15']],
    ['iPhone 15 горизонтально', devices['iPhone 15 landscape']],
    ['Pixel 7', devices['Pixel 7']],
  ]) {
    const { ctx: c, page: ph } = await newPage(dev);
    await ph.goto(url, { waitUntil: 'networkidle' });
    await ph.waitForSelector('.drive-map .leaflet-container');
    await ph.waitForTimeout(600);
    let pr = await layoutProblems(ph);
    check(`${name}: главный экран без наложений`, !pr.length, pr.join('; '));
    await ph.fill('#map-search', 'Театр Сатиры');
    await ph.press('#map-search', 'Enter');
    await ph.locator('.map-panel .place-row').first().click({ timeout: 15000 }).catch(() => {});
    await ph.waitForSelector('.route-card', { timeout: 15000 }).catch(() => {});
    await ph.waitForTimeout(500);
    pr = await layoutProblems(ph);
    check(`${name}: маршрут без наложений`, !pr.length, pr.join('; '));
    const slug = name.replace(/\s+/g, '-').toLowerCase();
    await ph.screenshot({ path: `${out}/08-${slug}.png` });
    await ph.click('.dock [aria-label="Ещё разделы"]');
    await ph.click('.more-item:has-text("Настройки")');
    pr = await layoutProblems(ph);
    check(`${name}: раздел поверх карты`, !pr.length, pr.join('; '));
    await ph.click('.page-back');
    await checkChatGpt(name, c, ph);
    await checkThemes(name, ph, out, slug);
    await c.close();
  }

  for (const scheme of ['light', 'dark']) {
    const cx = await browser.newContext({ viewport: { width: 1024, height: 1366 }, colorScheme: scheme, locale: 'ru-RU' });
    await mockNetwork(cx);
    const px = await cx.newPage();
    await px.goto(url, { waitUntil: 'networkidle' });
    const th = await px.evaluate(() => document.documentElement.dataset.theme);
    check(`Без геопозиции «Авто» следует теме устройства (${scheme})`, th === (scheme === 'light' ? 'day' : 'night'), th);
    await cx.close();
  }

  check('Тайлы карты только OpenStreetMap', [...tileHosts].every((h) => h === 'tile.openstreetmap.org') && cartoRequests === 0, [...tileHosts].join(', ') || 'запросов тайлов не было');

  check('Нет ошибок JavaScript', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('Сценарий выполнен', false, String(e).split('\n')[0]);
} finally {
  await browser.close();
}

fs.writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok && !SOFT.has(r.name));
console.log(`\nПройдено ${results.filter((r) => r.ok).length}/${results.length}, обязательных провалов: ${failed.length}`);
process.exit(failed.length ? 1 : 0);
