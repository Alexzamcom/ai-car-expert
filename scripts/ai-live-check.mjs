// Сквозная проверка ИИ-помощника: голос → распознавание → ИИ-прокси → OpenAI → инструмент → действие → голосовой ответ.
//
//   node scripts/ai-live-check.mjs <адрес /chat прокси> [адрес приложения] [папка] [--fake-ai] [--provider=grok]
//
// Приложение — локальная сборка (npm run build && npx vite preview). Распознавание и синтез речи в безголовом
// браузере имитируются (микрофона нет): фраза подаётся в тот же Web Speech API, что на iPad, озвучивание
// перехватывается. Запросы к прокси идут по-настоящему; заголовок Origin подставляется как у опубликованного сайта,
// токен доступа добавляет сетевой прокси среды (в скрипте его нет). Карты, маршруты, POI и каталог радио —
// из tests/fixtures (из этой среды они недоступны; живые сервисы проверяет deploy.yml).
// --fake-ai: вместо прокси отвечает имитация — проверка самого сценария без расходов.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const args = process.argv.slice(2);
const FAKE = args.includes('--fake-ai');
const PROVIDER = (args.find((a) => a.startsWith('--provider=')) ?? '--provider=openai').split('=')[1];
const [proxy = 'https://ai-proxy.test/chat', appUrl = 'http://localhost:4173/', out = 'ai-live'] = args.filter((a) => !a.startsWith('--'));
const ORIGIN = 'https://alexzamcom.github.io';
const proxyHost = new URL(proxy).host;
fs.mkdirSync(out, { recursive: true });
const fixture = (f) => fs.readFileSync(path.resolve('tests/fixtures', f), 'utf8');

/* ---------- Имитация ИИ (только --fake-ai) ---------- */
function fakeAi(body) {
  const msgs = body.messages ?? [];
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
  const uk = /[іїєґ]/i.test(lastUser);
  const usage = { prompt_tokens: 4800, completion_tokens: 30 };
  if (msgs[msgs.length - 1]?.role === 'tool') return { choices: [{ message: { content: uk ? 'Готово, нагадування створено.' : 'Готово.' } }], usage, provider: body.provider, model: 'fake' };
  const call = (name, a) => ({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(a) } }] } }], usage, provider: body.provider, model: 'fake' });
  if (/заправ|бензин|азс/i.test(lastUser)) return call('add_stop', { category: 'fuel' });
  if (/театр/i.test(lastUser)) return call('navigate_to', { destination: 'Театр Сатиры' });
  if (/радио/i.test(lastUser)) return call('play_radio', { station: 'ambient' });
  if (/нагад/i.test(lastUser)) return call('add_reminder', { text: 'Перевірити тиск у шинах', due_date: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10) });
  return { choices: [{ message: { content: 'Обычно 2,3–2,5 бар; точное значение — на табличке в проёме двери.' } }], usage, provider: body.provider, model: 'fake' };
}

/* ---------- Сеть ---------- */
const traffic = []; // запросы к прокси: { body, reply }
async function setupNetwork(ctx) {
  const json = (body) => ({ status: 200, contentType: 'application/json', body, headers: { 'Access-Control-Allow-Origin': '*' } });
  const osrm = (r) => r.fulfill(json(fixture(r.request().url().includes('alternatives=true') ? 'osrm-alternatives.json' : 'osrm-route.json')));
  await ctx.route('**/routing.openstreetmap.de/**', osrm);
  await ctx.route('**/router.project-osrm.org/**', osrm);
  await ctx.route('**/nominatim.openstreetmap.org/**', (r) => r.fulfill(json(fixture(r.request().url().includes('/reverse') ? 'nominatim-reverse.json' : 'nominatim.json'))));
  await ctx.route('**/photon.komoot.io/**', (r) => r.fulfill(json('{"features":[]}')));
  await ctx.route('**/overpass-api.de/**', (r) => r.fulfill(json(fixture('overpass-fuel.json'))));
  await ctx.route('**/*.api.radio-browser.info/**', (r) =>
    r.fulfill(json(r.request().url().includes('/json/servers') ? JSON.stringify([{ name: 'de1.api.radio-browser.info' }]) : fixture('radio-browser.json'))),
  );
  await ctx.route('**/tile.openstreetmap.org/**', (r) => r.fulfill({ status: 204 }));
  // Аудиопотоки радио не скачиваем.
  await ctx.route(/\.(mp3|aac|m3u8?|pls)(\?|$)/i, (r) => r.fulfill({ status: 204 }));
  await ctx.route(`https://${proxyHost}/**`, async (route) => {
    const req = route.request();
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = req.method() === 'POST' ? JSON.parse(req.postData() || '{}') : null;
    let status = 200;
    let reply;
    if (FAKE) {
      reply = req.url().endsWith('/usage') ? { spentUsd: 0, budgetUsd: 4.5, requestsToday: traffic.length, dailyLimit: 150, persistent: true } : fakeAi(body);
    } else {
      // Настоящий прокси. Origin — как у опубликованного приложения; Authorization подставит сетевой прокси среды.
      const res = await route.fetch({ headers: { ...req.headers(), origin: ORIGIN } });
      status = res.status();
      reply = await res.json().catch(() => ({ error: `HTTP ${status}` }));
    }
    if (body) traffic.push({ body, reply, status });
    return route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(reply) });
  });
}

/* ---------- Имитация Web Speech API ---------- */
const SPEECH_SHIM = () => {
  window.__spoken = [];
  window.__utterance = '';
  class FakeRecognition {
    start() {
      setTimeout(() => {
        const text = window.__utterance;
        const results = [Object.assign([{ transcript: text }], { isFinal: true })];
        this.onresult?.({ resultIndex: 0, results });
        setTimeout(() => this.onend?.(), 50);
      }, 400);
    }
    stop() {}
    abort() {}
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
  const synth = {
    speak(u) {
      window.__spoken.push({ text: u.text, lang: u.lang });
      setTimeout(() => u.onend?.(), 30);
    },
    cancel() {},
    getVoices: () => [],
    speaking: false,
    addEventListener() {},
    removeEventListener() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
    }
  };
};

/* ---------- Сценарии ---------- */
const results = [];
const check = (name, ok, info = '') => {
  results.push({ name, ok: Boolean(ok), info });
  console.log(`${ok ? '✓' : '✗'} ${name}${info ? ` — ${info}` : ''}`);
};

async function say(page, text, timeout = 60000) {
  const before = await page.evaluate(() => window.__spoken.length);
  const n = traffic.length;
  await page.evaluate((t) => (window.__utterance = t), text);
  await page.click('.dock [aria-label="Голосовая команда"]');
  await page.waitForFunction((k) => window.__spoken.length > k, before, { timeout }).catch(() => {});
  await page.waitForTimeout(600);
  const spoken = await page.evaluate((k) => window.__spoken.slice(k).map((s) => s.text).join(' | '), before);
  const calls = traffic.slice(n);
  const tools = calls.flatMap((c) => c.reply?.choices?.[0]?.message?.tool_calls?.map((t) => `${t.function.name}(${t.function.arguments})`) ?? []);
  const toolResults = calls.flatMap((c) => (c.body.messages ?? []).filter((m) => m.role === 'tool').map((m) => m.content));
  const errors = calls.filter((c) => c.status !== 200).map((c) => `${c.status} ${c.reply?.error ?? ''}`);
  return { spoken, calls: calls.length, tools, toolResults: [...new Set(toolResults)], errors, models: [...new Set(calls.map((c) => c.reply?.model).filter(Boolean))] };
}

const describe = (r) => `запросов к ИИ: ${r.calls}${r.models.length ? ` (${r.models.join(', ')})` : ''}; инструменты: ${r.tools.join(', ') || '—'}; сказано: «${r.spoken.slice(0, 160)}»${r.errors.length ? `; ошибки: ${r.errors.join('; ')}` : ''}`;

async function newPage(browser, device, speechLang) {
  const ctx = await browser.newContext({
    ...device,
    locale: speechLang,
    geolocation: { latitude: 55.757, longitude: 37.6156, accuracy: 10 },
    permissions: ['geolocation'],
  });
  await setupNetwork(ctx);
  await ctx.addInitScript(SPEECH_SHIM);
  await ctx.addInitScript(
    ([endpoint, provider, lang]) => {
      if (localStorage.getItem('ace:settings')) return;
      // Токен в приложении — заглушка: настоящий подставляет сетевой прокси среды.
      localStorage.setItem('ace:settings', JSON.stringify({ aiEndpoint: endpoint, aiToken: 'set-by-network-proxy', aiProvider: provider, speechLang: lang, aiDailyLimit: 0, aiMonthlyBudgetUsd: 0 }));
    },
    [proxy, PROVIDER, speechLang],
  );
  const page = await ctx.newPage();
  page.on('pageerror', (e) => check('Нет ошибок JavaScript', false, String(e)));
  await page.goto(appUrl, { waitUntil: 'networkidle' });
  await page.waitForSelector('.drive-map .leaflet-container', { timeout: 20000 });
  return { ctx, page };
}

const ipad = { viewport: { width: 1024, height: 1366 }, deviceScaleFactor: 2, hasTouch: true, userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' };

const browser = await chromium.launch();
try {
  /* iPad: русский — маршрут, остановка, радио, вопрос, локальная команда */
  const { ctx, page } = await newPage(browser, ipad, 'ru-RU');
  let r = await say(page, 'Мне нужно в Театр Сатиры в Москве. Построй маршрут и скажи, сколько ехать.');
  const routed = (await page.locator('.route-card .btn-primary').count()) > 0;
  check('iPad · голос → GPT → navigate_to → маршрут на карте → голосовой ответ', routed && r.tools.some((t) => t.startsWith('navigate_to')) && r.spoken.length > 0, describe(r));
  await page.screenshot({ path: `${out}/1-ipad-route.png` });

  r = await say(page, 'Хочу перед театром заскочить на АЗС.');
  const via = await page.locator('.via-line').isVisible().catch(() => false);
  check('iPad · GPT → add_stop → остановка добавлена в маршрут', via && r.tools.some((t) => t.startsWith('add_stop')), describe(r));
  await page.locator('.via-line .link-btn').click().catch(() => {});
  await page.waitForTimeout(800);
  r = await say(page, 'Добавь заправку в маршрут как остановку');
  check('iPad · «добавь заправку в маршрут» — на устройстве, без запроса к ИИ', r.calls === 0 && (await page.locator('.via-line').isVisible().catch(() => false)), describe(r));
  await page.screenshot({ path: `${out}/2-ipad-stop.png` });

  r = await say(page, 'Поставь какое-нибудь спокойное радио, например эмбиент.');
  const radio = r.toolResults.some((t) => /Включаю|Вмикаю/.test(t));
  check('iPad · GPT → play_radio → радио включается', r.tools.some((t) => t.startsWith('play_radio')) && radio, `${describe(r)}; результат: ${r.toolResults.join(' ').slice(0, 120)}`);

  r = await say(page, 'Какое давление в шинах обычно рекомендуют для моей машины зимой?');
  const words = r.spoken.split(/\s+/).filter(Boolean).length;
  check('iPad · вопрос → короткий голосовой ответ без лишних действий', r.calls >= 1 && r.spoken.length > 0 && words <= 60, `${words} слов; ${describe(r)}`);

  r = await say(page, 'ночная тема');
  check('iPad · простая команда — на устройстве, без запроса к ИИ', r.calls === 0 && /ночная/i.test(r.spoken), describe(r));
  await page.screenshot({ path: `${out}/3-ipad-chat.png` });
  await ctx.close();

  /* iPhone: украинский — сервисное напоминание */
  const ph = await newPage(browser, devices['iPhone 15'], 'uk-UA');
  r = await say(ph.page, 'Мені треба через тиждень перевірити тиск у шинах, створи нагадування.');
  const rem = await ph.page.evaluate(() => localStorage.getItem('ace:reminders') ?? '');
  const due = /"dueDate":"\d{4}-\d{2}-\d{2}"/.test(rem);
  check('iPhone · українська → GPT → add_reminder → нагадування з датою збережено', r.tools.some((t) => t.startsWith('add_reminder')) && /шин/i.test(rem) && due, `${describe(r)}; сховище: ${rem.slice(0, 160)}`);
  check('iPhone · відповідь українською', !/[ыэъё]/i.test(r.spoken) && /[іїєґ]|нагадування|створено/i.test(r.spoken), r.spoken.slice(0, 160));
  const r2 = await say(ph.page, 'Нагадай мені завтра заїхати на мийку');
  const rem2 = await ph.page.evaluate(() => localStorage.getItem('ace:reminders') ?? '');
  check('iPhone · «нагадай завтра …» — на пристрої, з датою', r2.calls === 0 && /мийку","dueDate":"\d{4}/.test(rem2), describe(r2));
  await ph.page.screenshot({ path: `${out}/4-iphone-reminder.png` });
  await ph.ctx.close();

  /* Android: маршрут голосом */
  const px = await newPage(browser, devices['Pixel 7'], 'ru-RU');
  r = await say(px.page, 'Отвези меня к Театру Сатиры, пожалуйста, и скажи время прибытия.');
  check('Pixel 7 · голос → GPT → маршрут', (await px.page.locator('.route-card').count()) > 0 && r.tools.some((t) => t.startsWith('navigate_to')), describe(r));
  await px.page.screenshot({ path: `${out}/5-pixel-route.png` });
  await px.ctx.close();
} catch (e) {
  check('Сценарий выполнен', false, String(e).split('\n')[0]);
} finally {
  await browser.close();
}

const tokens = traffic.reduce((a, c) => [a[0] + (c.reply?.usage?.prompt_tokens ?? 0), a[1] + (c.reply?.usage?.completion_tokens ?? 0)], [0, 0]);
console.log(`\nЗапросов к ИИ: ${traffic.length}, токенов: вход ${tokens[0]}, выход ${tokens[1]}${FAKE ? ' (имитация)' : ''}`);
fs.writeFileSync(`${out}/results.json`, JSON.stringify({ fake: FAKE, provider: PROVIDER, results, requests: traffic.length, tokens }, null, 2));
const failed = results.filter((x) => !x.ok);
console.log(`Пройдено ${results.length - failed.length}/${results.length}`);
process.exit(failed.length ? 1 : 0);
