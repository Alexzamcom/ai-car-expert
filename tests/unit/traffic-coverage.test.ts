/* Ежемесячная проверка покрытия пробок по Украине: разбор таблиц поставщиков (образцы повторяют вёрстку страниц). */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — модуль на JS без типов
import { SOURCES, BASELINE, evaluate, changes, isYes, tableRows } from '../../scripts/traffic-coverage.mjs';

const src = (id: string) => SOURCES.find((s: { id: string }) => s.id === id);
const table = (header: string[], rows: string[][]) =>
  `<table><thead><tr>${header.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

// TomTom: «если страны нет в таблице — не поддерживается»
const tomtom = (withUa: boolean) =>
  table(['Country', 'ISO code', 'Traffic Incidents API', 'Traffic Flow API'], [['Poland', 'PL/POL', '✔', '✔'], ['Romania', 'RO/ROU', '✔', '✔'], ...(withUa ? [['Ukraine', 'UA/UKR', '✔', '✔']] : [])]);
// HERE: Region(s) | Market | Flow | Incidents
const here = (uaFlow: string | null) => table(['Region(s)', 'Market', 'Flow', 'Incidents'], [['Poland', 'E2305', '✅*', '✅'], ...(uaFlow == null ? [] : [['Ukraine', 'E2X00', uaFlow, '']])]);
// Azure: у Украины — сноска «1» вместо отметок
const azure = (uaCells: string[]) => table(['Country/Region', 'Incidents', 'Flow'], [['Poland', '✓', '✓'], ['Ukraine', ...uaCells]]);
// Google: Region code | Country/Region | … | Traffic Layer | …
const GH = ['Region code', 'Country/Region', 'Map Tiles 2D / 3D', 'Maps 3D (JavaScript, Android, iOS)', 'Geocoding', 'Traffic Layer', 'Driving Directions / Snap to Roads', 'Biking Directions', 'Walking Directions', 'Speed Limits'];
const google = (uaTraffic: string) =>
  table(GH, [['PL', 'Poland', '⬤ / ⬤', '⬤', '⬤', '⬤', '⬤', '⬤', '⬤', '⬤'], ['UA', 'Ukraine', '⬤', '—', '⬤', uaTraffic, '⬤', '—', '⬤', '—']]);

describe('Покрытие пробок по Украине: разбор таблиц', () => {
  it('сейчас (как на страницах сегодня): у всех «нет», контрольная Польша — «есть», изменений нет', () => {
    const results = [evaluate(tomtom(false), src('tomtom')), evaluate(tomtom(false), src('tomtom-orbis')), evaluate(here(null), src('here')), evaluate(azure(['1']), src('azure')), evaluate(google('—'), src('google'))];
    expect(results.map((r) => r.status)).toEqual(['no', 'no', 'no', 'no', 'no']);
    expect(results.every((r) => r.control.status === 'yes')).toBe(true);
    expect(changes(results)).toEqual([]);
  });
  it('Украина появилась — изменение у этого источника', () => {
    expect(evaluate(tomtom(true), src('tomtom')).status).toBe('yes');
    expect(evaluate(here('✅*'), src('here')).status).toBe('yes');
    expect(evaluate(azure(['✓', '✓']), src('azure')).status).toBe('yes');
    expect(evaluate(google('⬤'), src('google')).status).toBe('yes');
    const diff = changes([evaluate(google('⬤'), src('google'))]);
    expect(diff.map((d: { id: string }) => d.id)).toEqual(['google']);
  });
  it('сноска у названия страны («Ukraine<sup>1</sup>», как у Azure) не мешает: появятся отметки — «есть»', () => {
    const t = table(['Country/Region', 'Incidents', 'Flow'], [['Poland', '✓', '✓'], ['Ukraine<sup>1</sup>', '✓', '✓']]);
    expect(evaluate(t, src('azure')).status).toBe('yes');
    const now = table(['Country/Region', 'Incidents', 'Flow'], [['Poland', '✓', '✓'], ['Ukraine<sup>1</sup>']]);
    expect(evaluate(now, src('azure'))).toMatchObject({ status: 'no' });
    expect(evaluate(now, src('azure')).ukraine.detail).not.toBe('страны нет в таблице');
  });
  it('Украина в таблице, но без отметки потока — «нет», а не «есть»', () => {
    expect(evaluate(here(''), src('here')).status).toBe('no');
    expect(evaluate(azure(['✓', '']), src('azure')).status).toBe('no');
  });
  it('страница изменилась (нет таблиц или нет Польши) — «unknown», это тоже уведомление', () => {
    const noTables = evaluate('<div>Coverage moved</div>', src('tomtom'));
    expect(noTables.status).toBe('unknown');
    expect(changes([noTables]).length).toBe(1);
    const noControl = evaluate(table(['Country', 'Flow'], [['Germany', '✔']]), src('here'));
    expect(noControl.status).toBe('unknown');
  });
  it('отметки разных поставщиков и пустые ячейки', () => {
    for (const y of ['✔', '✓', '✅*', '⬤ / ⬤', '<span aria-label="Yes"></span>']) expect(isYes(y)).toBe(true);
    for (const n of ['—', '', '1', '2']) expect(isYes(n)).toBe(false);
  });
  it('ожидаемое состояние — «нет» у всех пяти источников', () => {
    expect(Object.values(BASELINE)).toEqual(['no', 'no', 'no', 'no', 'no']);
    expect(tableRows(tomtom(false)).length).toBe(2);
  });
});
