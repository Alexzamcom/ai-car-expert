import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { THEMES, contrast, over, computeTheme, type ThemeName } from '../../src/lib/theme';
import { sunTimes, daylight } from '../../src/lib/sun';
import { parseCommand } from '../../src/lib/voiceCommands';

const names: ThemeName[] = ['day', 'night'];
const surfaces = ['bg', 'bg-2', 'panel', 'panel-2', 'panel-3'] as const;

describe('контраст тем (WCAG)', () => {
  for (const n of names) {
    const t = THEMES[n];
    it(`${n}: основной и вторичный текст ≥ 4,5:1 на всех поверхностях`, () => {
      for (const s of surfaces) for (const fg of ['text', 'text-2', 'muted'] as const) {
        expect(contrast(t[fg], t[s]), `${fg} на ${s}`).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`${n}: акцент и статусы читаемы как текст на панелях`, () => {
      for (const s of ['panel', 'panel-2', 'bg-2'] as const) for (const fg of ['accent', 'ok', 'warn', 'danger'] as const) {
        expect(contrast(t[fg], t[s]), `${fg} на ${s}`).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`${n}: текст на кнопках с акцентом ≥ 4,5:1`, () => {
      expect(contrast(t['accent-ink'], t.accent)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['accent-ink'], t['accent-2'])).toBeGreaterThanOrEqual(3); // градиент кнопки микрофона (значок)
    });
    it(`${n}: значки «выключено» и рамки элементов управления заметны (≥ 3:1 для значков)`, () => {
      expect(contrast(t['icon-off'], t.bg)).toBeGreaterThanOrEqual(3);
    });
    it(`${n}: текст поверх карты читаем`, () => {
      const overlay = over(t.overlay, t['map-bg']);
      for (const fg of ['text', 'muted', 'accent'] as const) expect(contrast(t[fg], overlay), fg).toBeGreaterThanOrEqual(4.5);
    });
    it(`${n}: белый значок на кнопке YouTube Music`, () => {
      expect(contrast('#ffffff', t.ytm)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${n}: белый текст подсказки манёвра`, () => {
      expect(contrast('#ffffff', t.maneuver)).toBeGreaterThanOrEqual(4.5);
      expect(contrast('#ffffff', t['maneuver-2'])).toBeGreaterThanOrEqual(4.5);
    });
  }
  it('темы определяют одинаковый набор токенов', () => {
    expect(Object.keys(THEMES.day).sort()).toEqual(Object.keys(THEMES.night).sort());
  });
});

describe('стили без «зашитых» цветов', () => {
  const css = fs.readFileSync('src/styles/global.css', 'utf8');
  it('запасные значения :root не ссылаются сами на себя', () => {
    const root = css.slice(0, css.indexOf('* { box-sizing'));
    for (const m of root.matchAll(/--([a-z0-9-]+):\s*var\(--([a-z0-9-]+)\)/g)) expect(m[1]).not.toBe(m[2]);
  });
  it('после :root цвета берутся из токенов темы', () => {
    const body = css.slice(css.indexOf('* { box-sizing'));
    const literals = [...new Set(body.match(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}\b/g) ?? [])].sort();
    // белый на цветном фоне (манёвр, метки, переключатель) и цвета меток POI одинаковы в обеих темах
    expect(literals).toEqual(['#5c9dff', '#fff', '#ff8a5c', 'rgba(255, 255, 255, 0.14)'].sort());
  });
  it('карта не использует CARTO, атрибуция OSM не скрыта', () => {
    const nav = fs.readFileSync('src/sections/Navigation.tsx', 'utf8');
    expect(nav).not.toMatch(/cartocdn/);
    expect(nav).toContain('https://tile.openstreetmap.org/{z}/{x}/{y}.png');
    expect(nav).toContain('openstreetmap.org/copyright');
    expect(css).not.toMatch(/leaflet-control-attribution[^}]*display:\s*none/);
    expect(css).not.toMatch(/leaflet-control-attribution[^}]*visibility:\s*hidden/);
  });
});

describe('восход и закат', () => {
  const minutes = (d: Date) => d.getUTCHours() * 60 + d.getUTCMinutes();
  it('Москва, 21 июня: восход ≈ 00:44 UTC, закат ≈ 18:18 UTC', () => {
    const t = sunTimes(new Date('2026-06-21T12:00:00Z'), 55.7558, 37.6173);
    if (t.kind !== 'normal') throw new Error(t.kind);
    expect(Math.abs(minutes(t.sunrise) - (0 * 60 + 44))).toBeLessThanOrEqual(6);
    expect(Math.abs(minutes(t.sunset) - (18 * 60 + 18))).toBeLessThanOrEqual(6);
  });
  it('Москва, 21 декабря: восход ≈ 05:58 UTC, закат ≈ 12:57 UTC', () => {
    const t = sunTimes(new Date('2026-12-21T09:00:00Z'), 55.7558, 37.6173);
    if (t.kind !== 'normal') throw new Error(t.kind);
    expect(Math.abs(minutes(t.sunrise) - (5 * 60 + 58))).toBeLessThanOrEqual(6);
    expect(Math.abs(minutes(t.sunset) - (12 * 60 + 57))).toBeLessThanOrEqual(6);
  });
  it('Киев, равноденствие: день ≈ 12 ч 10 мин', () => {
    const t = sunTimes(new Date('2026-03-20T10:00:00Z'), 50.45, 30.52);
    if (t.kind !== 'normal') throw new Error(t.kind);
    const len = (t.sunset.valueOf() - t.sunrise.valueOf()) / 60000;
    expect(len).toBeGreaterThan(12 * 60);
    expect(len).toBeLessThan(12 * 60 + 25);
  });
  it('Мурманск: полярный день и полярная ночь', () => {
    expect(sunTimes(new Date('2026-06-21T12:00:00Z'), 68.97, 33.08).kind).toBe('polar-day');
    expect(sunTimes(new Date('2026-12-21T12:00:00Z'), 68.97, 33.08).kind).toBe('polar-night');
  });
  it('следующее переключение', () => {
    const evening = daylight(new Date('2026-11-09T15:00:00Z'), 55.7558, 37.6173); // 18:00 по Москве
    expect(evening.day).toBe(false);
    expect(evening.next?.to).toBe('day');
    const noon = daylight(new Date('2026-11-09T09:00:00Z'), 55.7558, 37.6173);
    expect(noon.day).toBe(true);
    expect(noon.next?.to).toBe('night');
  });
});

describe('выбор темы', () => {
  const moscow = { lat: 55.7558, lon: 37.6173 };
  it('ручной режим не зависит от солнца', () => {
    expect(computeTheme('night', new Date('2026-06-21T09:00:00Z'), moscow, false)).toMatchObject({ active: 'night', reason: 'manual' });
    expect(computeTheme('day', new Date('2026-12-21T20:00:00Z'), moscow, true)).toMatchObject({ active: 'day', reason: 'manual' });
  });
  it('авто с координатами — по солнцу', () => {
    expect(computeTheme('auto', new Date('2026-11-09T09:00:00Z'), moscow, true)).toMatchObject({ active: 'day', reason: 'sun' });
    expect(computeTheme('auto', new Date('2026-11-09T18:00:00Z'), moscow, false)).toMatchObject({ active: 'night', reason: 'sun' });
  });
  it('авто без координат — по теме устройства', () => {
    expect(computeTheme('auto', new Date(), null, true)).toMatchObject({ active: 'night', reason: 'system' });
    expect(computeTheme('auto', new Date(), null, false)).toMatchObject({ active: 'day', reason: 'system' });
  });
  it('голосовые команды ru/uk', () => {
    const cmd = (s: string) => {
      const c = parseCommand(s);
      return c.kind === 'tool' ? [c.name, c.args] : ['ask'];
    };
    expect(cmd('включи ночной режим')).toEqual(['set_theme', { mode: 'night' }]);
    expect(cmd('дневная тема')).toEqual(['set_theme', { mode: 'day' }]);
    expect(cmd('тема автоматически')).toEqual(['set_theme', { mode: 'auto' }]);
    expect(cmd('увімкни нічну тему')).toEqual(['set_theme', { mode: 'night' }]);
    expect(cmd('режим работы климата')).toEqual(['ask']);
  });
});
