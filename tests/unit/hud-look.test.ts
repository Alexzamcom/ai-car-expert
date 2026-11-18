/* Палитра зеркального HUD: «Авто» (ночью — прежняя палитра без изменений, днём — дневная), «Дневной», «Ручной». */
import { describe, it, expect } from 'vitest';
import { hudAppearance, DEFAULT_HUD, DEFAULT_HUD_MANUAL, HUD_COLORS, HUD_DAY, type HudSettings } from '../../src/lib/hud';

const base = (p: Partial<HudSettings> = {}): HudSettings => ({ ...DEFAULT_HUD, ...p });

describe('Палитра HUD', () => {
  it('по умолчанию — «Авто», ручная палитра — стандартная', () => {
    expect(DEFAULT_HUD.look).toBe('auto');
    expect(DEFAULT_HUD.manual).toEqual(DEFAULT_HUD_MANUAL);
  });

  it('«Авто» ночью — ровно прежняя палитра: один цвет, яркость, масштаб и контраст из настроек', () => {
    for (const color of Object.keys(HUD_COLORS) as (keyof typeof HUD_COLORS)[]) {
      const s = base({ color, brightness: 0.55, scale: 1.3, contrast: 'normal' });
      expect(hudAppearance(s, true)).toEqual({
        palette: 'night',
        digits: HUD_COLORS[color][1],
        arrows: HUD_COLORS[color][1],
        digitsScale: 1.3,
        arrowsScale: 1.3,
        brightness: 0.55,
        contrast: 'normal',
      });
    }
  });

  it('«Авто» днём и «Дневной» — дневная палитра: белые цифры, жёлтые указания, полная яркость, не мельче 115%', () => {
    for (const [look, dark] of [['auto', false], ['day', false], ['day', true]] as const) {
      const a = hudAppearance(base({ look, scale: 1 }), dark);
      expect(a).toMatchObject({ palette: 'day', digits: HUD_DAY.digits, arrows: HUD_DAY.arrows, brightness: 1, contrast: 'high' });
      expect(a.digitsScale).toBeCloseTo(1.15);
    }
    expect(hudAppearance(base({ look: 'day', scale: 1.5 }), false).arrowsScale).toBe(1.5);
  });

  it('«Ручной» — свои цвета, размеры и яркость днём и ночью одинаково', () => {
    const manual = { digits: '#ff5a5a', arrows: '#39ff88', digitsScale: 1.6, arrowsScale: 0.8, brightness: 0.5 };
    for (const dark of [true, false]) {
      expect(hudAppearance(base({ look: 'manual', manual, contrast: 'high' }), dark)).toEqual({ palette: 'manual', ...manual, contrast: 'high' });
    }
  });

  it('ручная палитра не влияет на ночную, и наоборот', () => {
    const s = base({ look: 'auto', color: 'amber', manual: { ...DEFAULT_HUD_MANUAL, digits: '#ff0000' } });
    expect(hudAppearance(s, true).digits).toBe(HUD_COLORS.amber[1]);
    expect(hudAppearance({ ...s, look: 'manual' }, true).digits).toBe('#ff0000');
  });

  it('повреждённые сохранённые значения — безопасные: цвет по умолчанию, размеры и яркость в пределах', () => {
    const a = hudAppearance(base({ look: 'manual', manual: { digits: 'red', arrows: '#12345', digitsScale: 9, arrowsScale: -1, brightness: Number.NaN } }), true);
    expect(a).toMatchObject({ digits: DEFAULT_HUD_MANUAL.digits, arrows: DEFAULT_HUD_MANUAL.arrows, digitsScale: 1.8, arrowsScale: 0.7, brightness: 0.9 });
  });

  it('старые сохранённые настройки без палитры (до обновления) — «Авто» с прежним видом', () => {
    const old = { ...DEFAULT_HUD, color: 'green' } as Partial<HudSettings>;
    delete old.look;
    delete old.manual;
    const s = { ...DEFAULT_HUD, ...old } as HudSettings; // так дополняет хранилище (store.readStorage)
    expect(hudAppearance(s, true)).toMatchObject({ palette: 'night', digits: HUD_COLORS.green[1] });
    const bare = old as HudSettings; // даже без дополнения — без ошибок
    expect(hudAppearance(bare, true).palette).toBe('night');
  });
});
