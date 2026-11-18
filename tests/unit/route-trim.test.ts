/* Пройденная часть маршрута: граница «пройдено / осталось» — движение, остановка, шум GPS, потеря сигнала,
   съезд с маршрута, разворот, петли маршрута, перестроение; обрезка ломаной только для отрисовки. */
import { describe, it, expect } from 'vitest';
import { RouteTrimmer, remainingCoords, BACK_JITTER_M, CONFIRM } from '../../src/lib/routeTrim';
import { cumulative, routeProgress, type Route } from '../../src/lib/routing';

const route = {};
const step = (tr: RouteTrimmer, along: number, t: number, o: { off?: number; speed?: number | null; r?: object } = {}) =>
  tr.update({ route: o.r ?? route, along, offRouteM: o.off ?? 3, t: t * 1000, speed: o.speed === undefined ? 14 : o.speed });

describe('Граница пройденного маршрута', () => {
  it('движение вперёд: граница идёт за машиной', () => {
    const tr = new RouteTrimmer();
    step(tr, 0, 0);
    let cut = 0;
    for (let t = 1; t <= 10; t++) cut = step(tr, t * 14, t);
    expect(cut).toBe(140);
  });

  it('остановка и шум GPS: линия не «отрастает» назад', () => {
    const tr = new RouteTrimmer();
    step(tr, 0, 0);
    for (let t = 1; t <= 5; t++) step(tr, t * 14, t);
    // стоим: прогресс прыгает ±10 м
    for (let t = 6; t < 30; t++) expect(step(tr, 70 + (t % 2 ? -12 : 8), t, { speed: 0 })).toBeGreaterThanOrEqual(70);
  });

  it('откат назад меньше порога никогда не показывается, даже много раз подряд', () => {
    const tr = new RouteTrimmer();
    step(tr, 0, 0);
    step(tr, 30, 1);
    step(tr, 60, 2);
    for (let t = 3; t < 3 + CONFIRM * 3; t++) expect(step(tr, 60 - (BACK_JITTER_M - 1), t)).toBe(60);
  });

  it('потеря сигнала: после паузы граница догоняет машину (скачок правдоподобен для времени без точек)', () => {
    const tr = new RouteTrimmer();
    step(tr, 0, 0);
    step(tr, 14, 1);
    // 8 с без точек на 14 м/с — следующая точка на 126 м дальше
    expect(step(tr, 140, 9)).toBe(140);
  });

  it('маршрут проходит рядом сам с собой: одиночный скачок далеко вперёд не принимается, подтверждённый — принимается', () => {
    const tr = new RouteTrimmer();
    step(tr, 0, 0);
    step(tr, 14, 1);
    expect(step(tr, 900, 2)).toBe(14); // проекция «перепрыгнула» на дальний участок петли
    expect(step(tr, 28, 3)).toBe(28); // следующая точка — снова на месте
    // устойчиво далеко вперёд (например, срезали по другой дороге и вернулись на маршрут дальше)
    step(tr, 900, 4);
    step(tr, 912, 5);
    expect(step(tr, 924, 6)).toBe(924);
  });

  it('съезд с маршрута: граница замирает — ничего лишнего не скрывается до перестроения', () => {
    const tr = new RouteTrimmer();
    step(tr, 0, 0);
    step(tr, 100, 7);
    for (let t = 8; t < 15; t++) expect(step(tr, 100 + t * 20, t, { off: 80 })).toBe(100);
  });

  it('разворот на маршруте (маршрут сам возвращается назад): после подтверждения нужный участок снова виден', () => {
    const tr = new RouteTrimmer();
    step(tr, 0, 0);
    for (let t = 1; t <= 20; t++) step(tr, t * 14, t);
    expect(tr.value).toBe(280);
    // устойчиво оказались на 150 м — показываем маршрут от 150 м
    step(tr, 150, 21);
    step(tr, 152, 22);
    expect(step(tr, 154, 23)).toBe(154);
  });

  it('перестроение (новый маршрут): граница с начала нового маршрута', () => {
    const tr = new RouteTrimmer();
    step(tr, 0, 0);
    step(tr, 300, 20);
    const r2 = {};
    expect(step(tr, 5, 21, { r: r2 })).toBe(5);
    expect(step(tr, 19, 22, { r: r2 })).toBe(19);
  });
});

describe('Оставшаяся часть ломаной (только для отрисовки)', () => {
  const coords = [
    { lat: 55.75, lon: 37.62 },
    { lat: 55.751, lon: 37.62 },
    { lat: 55.751, lon: 37.622 },
    { lat: 55.752, lon: 37.622 },
  ];
  const cum = cumulative(coords);

  it('первая точка — точно на границе, дальше — исходные вершины', () => {
    const r = remainingCoords(coords, cum, cum[1] / 2);
    expect(r).toHaveLength(4);
    expect(r[0].lat).toBeCloseTo(55.7505, 6);
    expect(r[0].lon).toBeCloseTo(37.62, 6);
    expect(r.slice(1)).toEqual(coords.slice(1));
  });
  it('граница за поворотом: ломаная начинается на втором участке', () => {
    const from = cum[1] + (cum[2] - cum[1]) * 0.25;
    const r = remainingCoords(coords, cum, from);
    expect(r).toHaveLength(3);
    expect(r[0].lat).toBeCloseTo(55.751, 6);
    expect(r[0].lon).toBeCloseTo(37.6205, 6);
  });
  it('в начале — маршрут целиком; в конце — только финиш', () => {
    expect(remainingCoords(coords, cum, 0)).toBe(coords);
    expect(remainingCoords(coords, cum, cum[3] + 10)).toEqual([coords[3]]);
  });
  it('исходный маршрут не меняется (по нему считаются подсказки)', () => {
    const before = JSON.stringify(coords);
    remainingCoords(coords, cum, 50);
    expect(JSON.stringify(coords)).toBe(before);
  });
  it('с прогрессом навигации: перекрёсток и поворот — граница у машины, а не на ближайшей точке соседней ветки', () => {
    const r: Route = { coords, distance: cum[3], duration: 100, steps: [] } as unknown as Route;
    // машина на втором участке (после поворота), прогресс считается от предыдущего участка
    const p = routeProgress(r, { lat: 55.75101, lon: 37.621 }, undefined, 1);
    const along = cum[3] - p.remainingM;
    expect(along).toBeGreaterThan(cum[1]);
    expect(along).toBeLessThan(cum[2]);
    const shown = remainingCoords(coords, cum, along);
    expect(shown[0].lon).toBeCloseTo(37.621, 4);
  });
});
