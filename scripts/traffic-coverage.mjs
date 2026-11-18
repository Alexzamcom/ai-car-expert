// Ежемесячная проверка: появились ли живые пробки по Украине у TomTom, HERE, Azure Maps и Google.
// Читает только публичные страницы покрытия (без ключей и платных API). Для каждой таблицы сверяет контрольную
// страну (Польша — пробки есть): если она не нашлась, значит изменилась вёрстка страницы — это тоже повод для уведомления.
//
//   node scripts/traffic-coverage.mjs [--notify]      (--notify — завести issue в GitHub при изменениях; нужны GITHUB_TOKEN и GITHUB_REPOSITORY)
import fs from 'node:fs';

export const SOURCES = [
  { id: 'tomtom', name: 'TomTom Traffic API (TomTom Maps)', url: 'https://docs.tomtom.com/traffic-api/documentation/tomtom-maps/v1/product-information/market-coverage', kind: 'listed' },
  { id: 'tomtom-orbis', name: 'TomTom Traffic API (Orbis Maps)', url: 'https://docs.tomtom.com/traffic-api/documentation/tomtom-orbis-maps/v1/product-information/market-coverage', kind: 'listed' },
  { id: 'here', name: 'HERE Traffic API v7', url: 'https://docs.here.com/traffic-api/docs/traffic-coverage-information', kind: 'column', column: /^flow$/i },
  { id: 'azure', name: 'Azure Maps Traffic', url: 'https://learn.microsoft.com/en-us/azure/azure-maps/traffic-coverage', kind: 'column', column: /^flow$/i },
  { id: 'google', name: 'Google Maps Platform (Traffic Layer)', url: 'https://developers.google.com/maps/coverage', kind: 'column', column: /^traffic layer$/i },
];

/** Ожидаемое сейчас (ноябрь 2026): пробок по Украине нет ни у кого. Отличие — повод для уведомления. */
export const BASELINE = { tomtom: 'no', 'tomtom-orbis': 'no', here: 'no', azure: 'no', google: 'no' };

const decode = (s) =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x2714;|&#10004;/g, '✔')
    .replace(/&#x2713;|&#10003;/g, '✓')
    .replace(/\s+/g, ' ')
    .trim();

/** Отметка «есть» в ячейке: галочки и кружки всех поставщиков (в т. ч. иконкой с подписью). */
export function isYes(cellHtml) {
  const t = decode(cellHtml);
  if (/[✔✓✅⬤●]/.test(t)) return true;
  return /(aria-label|title|alt)="(yes|available|supported|check)/i.test(cellHtml) || /check(mark)?-?icon|icon-check/i.test(cellHtml);
}

/** Все строки HTML-таблиц: { header, cells(html), texts } — header из первой строки своей таблицы. */
export function tableRows(html) {
  const out = [];
  for (const table of html.match(/<table[\s\S]*?<\/table>/gi) || []) {
    const trs = table.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    if (!trs.length) continue;
    const header = (trs[0].match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) || []).map(decode);
    for (const tr of trs.slice(1)) {
      const cells = (tr.match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) || []).map((c) => c.replace(/^<t[hd][^>]*>|<\/t[hd]>$/gi, ''));
      out.push({ header, cells, texts: cells.map(decode) });
    }
  }
  return out;
}

// Название страны без сносок: «Ukraine 1», «Ukraine¹», «Ukraine *» → «ukraine».
const norm = (s) => s.toLowerCase().replace(/ü/g, 'u').replace(/[\s\d*¹²³†‡]+$/u, '').trim();

/**
 * Статус страны у источника: 'yes' — пробки есть, 'no' — нет (страны нет в таблице или отметки нет), 'unknown' — таблица не разобрана.
 * kind 'listed': страна в таблице покрытия трафика = поддерживается (TomTom: «если страны нет в таблицах — не поддерживается»).
 * kind 'column': отметка в нужной колонке строки страны (для таблиц с несколькими странами в строке — относительно ячейки страны).
 */
export function countryStatus(html, source, country) {
  const rows = tableRows(html);
  if (!rows.length) return { status: 'unknown', detail: 'таблиц на странице не найдено' };
  for (const r of rows) {
    const i = r.texts.findIndex((t) => norm(t) === norm(country));
    if (i < 0) continue;
    if (source.kind === 'listed') {
      const marks = r.cells.slice(i + 1, i + 4).filter(isYes).length;
      return { status: marks > 0 ? 'yes' : 'no', detail: `в таблице: ${r.texts.slice(i, i + 4).join(' | ')}` };
    }
    // Колонка по заголовку: сдвиг от ячейки страны (страна — в колонке «Country/Region/Market»).
    const ci = r.header.findIndex((h) => /country|region|market/i.test(h) && !/code/i.test(h));
    const col = r.header.findIndex((h) => source.column.test(h));
    if (col < 0) return { status: 'unknown', detail: `нет колонки ${source.column} в заголовке: ${r.header.join(' | ')}` };
    const cell = r.cells[i + (col - (ci >= 0 ? ci : 0))];
    if (cell == null) return { status: 'no', detail: `строка без ячейки «${r.header[col]}»: ${r.texts.join(' | ')}` };
    return { status: isYes(cell) ? 'yes' : 'no', detail: `${r.header[col]}: «${decode(cell) || '∅'}» — ${r.texts.join(' | ')}` };
  }
  return { status: 'no', detail: 'страны нет в таблице' };
}

/** Проверка одного источника: Украина и контрольная Польша (у неё пробки есть у всех). */
export function evaluate(html, source) {
  const ua = countryStatus(html, source, 'Ukraine');
  const pl = countryStatus(html, source, 'Poland');
  if (pl.status !== 'yes') return { id: source.id, status: 'unknown', ukraine: ua, control: pl, note: 'контрольная страна (Польша) не распознана — страница изменилась' };
  return { id: source.id, status: ua.status, ukraine: ua, control: pl };
}

/** Что изменилось относительно ожидаемого. */
export function changes(results, baseline = BASELINE) {
  return results.filter((r) => r.status !== (baseline[r.id] ?? 'no'));
}

async function fetchHtml(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

async function notify(diff, results) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return console.log('Уведомление не отправлено: нет GITHUB_TOKEN/GITHUB_REPOSITORY');
  const api = (p, init = {}) => fetch(`https://api.github.com/repos/${repo}${p}`, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const sig = diff.map((d) => `${d.id}:${d.status}`).sort().join(',');
  const title = `Пробки: покрытие Украины изменилось (${sig})`;
  const open = await (await api('/issues?state=open&per_page=100')).json();
  if (Array.isArray(open) && open.some((i) => i.title === title)) return console.log('Такое уведомление уже открыто:', title);
  const lines = results.map((r) => `| ${SOURCES.find((s) => s.id === r.id).name} | **${r.status}** (ожидалось ${BASELINE[r.id]}) | ${r.ukraine?.detail ?? ''} |${r.note ? ` ${r.note}` : ''}`);
  const body = [
    'Ежемесячная проверка покрытия живых пробок по Украине нашла изменения.',
    '',
    '| Источник | Статус | Украина |',
    '|---|---|---|',
    ...lines,
    '',
    '`yes` — пробки по Украине появились: можно вернуться к интеграции (сервер пробок готов, `server/traffic-proxy`).',
    '`unknown` — страница изменилась, проверку нужно обновить (`scripts/traffic-coverage.mjs`).',
    '',
    'Источники:',
    ...SOURCES.map((s) => `- [${s.name}](${s.url})`),
  ].join('\n');
  const r = await api('/issues', { method: 'POST', body: JSON.stringify({ title, body }) });
  console.log('Уведомление (issue):', r.status, (await r.json()).html_url ?? '');
}

async function main() {
  const results = [];
  for (const s of SOURCES) {
    try {
      results.push(evaluate(await fetchHtml(s.url), s));
    } catch (e) {
      results.push({ id: s.id, status: 'unknown', note: `страница недоступна: ${e.message}` });
    }
  }
  const diff = changes(results);
  const rows = results.map((r) => `| ${SOURCES.find((s) => s.id === r.id).name} | ${r.status} | ${BASELINE[r.id]} | ${(r.ukraine?.detail ?? r.note ?? '').slice(0, 160)} | ${(r.control?.detail ?? '').slice(0, 80)} |`);
  const report = ['## Живые пробки по Украине', '', '| Источник | Сейчас | Ожидалось | Украина | Польша (контроль) |', '|---|---|---|---|---|', ...rows, '', diff.length ? `**Изменения: ${diff.map((d) => d.id).join(', ')}**` : 'Без изменений: пробок по Украине по-прежнему нет.'].join('\n');
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');
  if (diff.length && process.argv.includes('--notify')) await notify(diff, results);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
