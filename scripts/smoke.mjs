// Smoke-тест интерфейса: node scripts/smoke.mjs <url> [папка для скриншотов]
// Эмулирует iPad Pro 12,9″ (1024×1366, вертикально) и проверяет основные функции.
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const url = process.argv[2] ?? 'http://localhost:4173/';
const out = process.argv[3] ?? 'smoke';
fs.mkdirSync(out, { recursive: true });

const results = [];
const check = (name, ok, info = '') => {
  results.push({ name, ok, info });
  console.log(`${ok ? '✓' : '✗'} ${name}${info ? ` — ${info}` : ''}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1024, height: 1366 },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: false,
  locale: 'ru-RU',
  geolocation: { latitude: 55.7539, longitude: 37.6208 },
  permissions: ['geolocation'],
  userAgent:
    'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
});
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

try {
  const res = await page.goto(url, { waitUntil: 'networkidle' });
  check('Страница открывается', res?.ok() === true, `HTTP ${res?.status()}`);
  check('Заголовок', (await page.title()) === 'AI Car Expert');
  check('HTTPS или localhost', url.startsWith('https://') || url.includes('localhost'));

  const manifest = await page.evaluate(async () => {
    const href = document.querySelector('link[rel=manifest]')?.href;
    const r = await fetch(href);
    return r.ok ? r.json() : null;
  });
  check('Манифест PWA', manifest?.name === 'AI Car Expert', manifest ? `display=${manifest.display}` : '');

  const sw = await page.evaluate(
    () =>
      Promise.race([
        navigator.serviceWorker.ready.then((r) => Boolean(r.active)),
        new Promise((r) => setTimeout(() => r(false), 15000)),
      ]),
  );
  check('Service worker активен', sw === true);

  await page.waitForSelector('.leaflet-container', { timeout: 15000 });
  await page.waitForTimeout(2500);
  const tiles = await page.locator('.leaflet-tile-loaded').count();
  check('Карта и тайлы', tiles > 0, `тайлов: ${tiles}`);
  await page.screenshot({ path: `${out}/01-home.png` });

  const sections = ['Мультимедиа', 'Руководство', 'История обслуживания', 'OBD-диагностика', 'AI-помощник', 'Автомобиль'];
  for (const s of sections) {
    await page.click(`.dock [aria-label="${s}"]`);
    await page.waitForTimeout(250);
    const title = await page.locator('.pane-primary .pane-title').innerText();
    check(`Раздел «${s}»`, title.trim() === s);
  }

  await page.click('.dock [aria-label="AI-помощник"]');
  await page.fill('#assistant-input', 'Что значит P0420?');
  await page.click('.composer button[type=submit]');
  await page.waitForTimeout(400);
  const a1 = await page.locator('.msg-assistant .msg-bubble').last().innerText();
  check('Помощник: код ошибки', a1.includes('каталитического'));
  await page.fill('#assistant-input', 'включи кондиционер');
  await page.click('.composer button[type=submit]');
  await page.waitForTimeout(400);
  const a2 = await page.locator('.msg-assistant .msg-bubble').last().innerText();
  check('Помощник: нет ложного управления климатом', a2.includes('пока недоступно'));
  await page.screenshot({ path: `${out}/02-assistant.png` });

  await page.click('.dock [aria-label="OBD-диагностика"]');
  for (const k of ['P', '0', '1', '7', '1']) await page.locator('.keypad .key', { hasText: new RegExp(`^${k}$`) }).filter({ hasNot: page.locator('[disabled]') }).first().click();
  await page.click('.key-primary');
  check('OBD: расшифровка P0171', (await page.locator('.dtc-desc').innerText()).includes('бедная'));

  await page.click('.dock [aria-label="Мультимедиа"]');
  await page.locator('.station-main').first().click();
  await page.waitForFunction(() => document.querySelector('.np-info .eyebrow')?.textContent === 'Сейчас играет', null, { timeout: 15000 }).catch(() => {});
  const playing = (await page.locator('.np-info .eyebrow').textContent())?.trim() ?? '';
  check('Радио играет', playing === 'Сейчас играет', playing);
  await page.screenshot({ path: `${out}/03-media.png` });

  await page.setViewportSize({ width: 1366, height: 1024 });
  await page.waitForTimeout(400);
  const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.panes')).gridTemplateColumns.split(' ').length);
  check('Горизонтальная ориентация: панели рядом', cols === 2);
  await page.screenshot({ path: `${out}/04-landscape.png` });

  check('Нет ошибок JavaScript', pageErrors.length === 0, pageErrors.join(' | '));
} catch (e) {
  check('Сценарий выполнен', false, String(e));
} finally {
  await browser.close();
}

fs.writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
// Тайлы и радио зависят от внешних сервисов — их сбой не валит проверку, но виден в отчёте.
const soft = new Set(['Карта и тайлы', 'Радио играет']);
const failed = results.filter((r) => !r.ok && !soft.has(r.name));
console.log(`\nПройдено ${results.filter((r) => r.ok).length}/${results.length}, обязательных провалов: ${failed.length}`);
process.exit(failed.length ? 1 : 0);
