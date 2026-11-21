/* Камера ведения: обычная, игровая (вид сзади), динамическая (подъём перед поворотами, плавный возврат). */
import { describe, it, expect } from 'vitest';
import { effectiveNavCamera, maneuverLift, navCameraPose, gameFollowZoom, LiftFilter } from '../../src/lib/camera';

const turn = { type: 'turn', modifier: 'right' };

describe('Выбор камеры', () => {
  it('по умолчанию: «Игровая 3D» — динамическая, обычная карта — обычная; выбор пользователя — главный', () => {
    expect(effectiveNavCamera(null, true)).toBe('dynamic');
    expect(effectiveNavCamera(undefined, false)).toBe('normal');
    expect(effectiveNavCamera('game', false)).toBe('game');
    expect(effectiveNavCamera('normal', true)).toBe('normal');
  });
});

describe('Подъём перед манёвром', () => {
  it('поворот: начинается за ~150 м, полный к 40 м, плавно', () => {
    expect(maneuverLift(turn, 400)).toBe(0);
    expect(maneuverLift(turn, 150)).toBe(0);
    const a = maneuverLift(turn, 120);
    const b = maneuverLift(turn, 80);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(maneuverLift(turn, 40)).toBe(1);
    expect(maneuverLift(turn, 5)).toBe(1);
  });
  it('прямо через перекрёсток и продолжение дороги — без подъёма', () => {
    expect(maneuverLift({ type: 'continue', modifier: 'straight' }, 50)).toBe(0);
    expect(maneuverLift({ type: 'new name' }, 50)).toBe(0);
    expect(maneuverLift({ type: 'turn', modifier: 'straight' }, 50)).toBe(0);
    expect(maneuverLift({ type: 'depart' }, 10)).toBe(0);
  });
  it('сложные узлы (кольцо, съезд, развилка) — выше и раньше; плавные повороты — слабее', () => {
    expect(maneuverLift({ type: 'roundabout', modifier: 'right' }, 40)).toBeCloseTo(1.3);
    expect(maneuverLift({ type: 'off ramp', modifier: 'slight right' }, 200)).toBeGreaterThan(0);
    expect(maneuverLift({ type: 'turn', modifier: 'slight left' }, 40)).toBeCloseTo(0.6);
  });
  it('на скорости подъём начинается раньше (≈ за 7 с), в городе — за 150 м', () => {
    expect(maneuverLift(turn, 250, 30)).toBe(0);
    expect(maneuverLift(turn, 200, 110)).toBeGreaterThan(0);
    expect(maneuverLift(turn, 500, 200)).toBe(0); // не дальше 400 м
  });
  it('нет данных о манёвре — без подъёма', () => {
    expect(maneuverLift(null, 50)).toBe(0);
    expect(maneuverLift(turn, null)).toBe(0);
    expect(maneuverLift(turn, Number.NaN)).toBe(0);
  });
});

describe('Плавность подъёма и возврата', () => {
  it('подъём и возврат постепенные; возврат медленнее подъёма', () => {
    const f = new LiftFilter();
    const up1 = f.update(1, 1);
    expect(up1).toBeGreaterThan(0.4);
    expect(up1).toBeLessThan(0.8);
    for (let i = 0; i < 10; i++) f.update(1, 1);
    expect(f.value).toBeCloseTo(1, 2);
    const down1 = 1 - f.update(0, 1);
    expect(down1).toBeLessThan(up1); // вниз за ту же секунду — меньше, чем вверх
  });
  it('долгая пауза (потеря GPS) — шаг ограничен, без рывка', () => {
    const f = new LiftFilter();
    expect(f.update(1, 60)).toBeLessThan(0.6);
  });
  it('стоим перед поворотом — значение не дрожит', () => {
    const f = new LiftFilter();
    for (let i = 0; i < 20; i++) f.update(1, 1);
    const v = f.value;
    for (let i = 0; i < 20; i++) f.update(1, 1);
    expect(f.value).toBe(v);
  });
});

describe('Ракурс', () => {
  const base = { baseZoom: 16.6, normalPitch: 50, lift: 0 };
  it('обычная — прежние наклон, масштаб и положение машинки', () => {
    expect(navCameraPose('normal', base)).toEqual({ pitch: 50, zoom: 16.6, offset: 0.24 });
  });
  it('игровая — круче наклон, ближе, машинка ниже; не выше предела карты', () => {
    const p = navCameraPose('game', base);
    expect(p.pitch).toBeGreaterThanOrEqual(58);
    expect(p.pitch).toBeLessThanOrEqual(60); // круче — заметно больше тайлов у горизонта
    expect(p.zoom).toBeGreaterThan(16.6);
    expect(p.offset).toBeGreaterThan(0.24);
    expect(navCameraPose('game', { ...base, maxPitch: 55 }).pitch).toBe(55);
  });
  it('игровая настройка держит машинку в нижней трети в обеих ориентациях', () => {
    const portrait = navCameraPose('dynamic', { ...base, gameLook: true });
    const landscape = navCameraPose('dynamic', { ...base, gameLook: true, landscape: true });
    expect(portrait).toMatchObject({ pitch: 64, offset: 0.24 });
    expect(landscape).toMatchObject({ pitch: 62, offset: 0.21 });
    const turn = navCameraPose('dynamic', { ...base, gameLook: true, lift: 1 });
    expect(turn.pitch).toBeLessThan(portrait.pitch);
    expect(turn.offset).toBeLessThan(portrait.offset);
  });
  it('игровой масштаб плавно отдаляется с ростом скорости', () => {
    expect(gameFollowZoom(null)).toBeCloseTo(16.6);
    expect(gameFollowZoom(120)).toBeCloseTo(14.6);
    for (let speed = 0; speed < 130; speed++) {
      const step = gameFollowZoom(speed) - gameFollowZoom(speed + 1);
      expect(step).toBeGreaterThanOrEqual(0);
      expect(step).toBeLessThan(0.05);
    }
  });
  it('динамическая: без поворота — как игровая; перед поворотом — выше, дальше, машинка ближе к центру', () => {
    expect(navCameraPose('dynamic', base)).toEqual(navCameraPose('game', base));
    const lifted = navCameraPose('dynamic', { ...base, lift: 1 });
    const chase = navCameraPose('game', base);
    expect(lifted.pitch).toBeLessThan(chase.pitch - 10);
    expect(lifted.zoom).toBeLessThan(chase.zoom);
    expect(lifted.offset).toBeLessThan(chase.offset);
    expect(navCameraPose('dynamic', { ...base, lift: 1.3 }).pitch).toBeLessThan(lifted.pitch);
  });
});
