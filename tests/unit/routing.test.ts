import { describe, it, expect } from 'vitest';
import osrm from '../fixtures/osrm-route.json';
import { parseOsrm, stepText, fmtDistance, fmtDuration, routeProgress, haversine, stepIcon } from '../../src/lib/routing';

const route = parseOsrm(osrm);

describe('parseOsrm', () => {
  it('разбирает геометрию и шаги', () => {
    expect(route.coords).toHaveLength(10);
    expect(route.coords[0]).toEqual({ lat: 55.757, lon: 37.6156 });
    expect(route.steps.map((s) => s.type)).toEqual(['depart', 'turn', 'roundabout', 'arrive']);
    expect(route.distance).toBe(2420);
  });
  it('сообщает об отсутствии маршрута', () => {
    expect(() => parseOsrm({ code: 'NoRoute' })).toThrow('Маршрут не найден');
  });
  it('промежуточный «arrive» становится waypoint', () => {
    const two = { code: 'Ok', routes: [{ ...osrm.routes[0], legs: [osrm.routes[0].legs[0], osrm.routes[0].legs[0]] }] };
    const r = parseOsrm(two);
    expect(r.steps.filter((s) => s.type === 'waypoint')).toHaveLength(1);
    expect(r.steps[r.steps.length - 1].type).toBe('arrive');
  });
});

describe('stepText', () => {
  it('русский', () => {
    expect(stepText(route.steps[1], 'ru')).toBe('Поверните направо на Садовая-Триумфальная улица');
    expect(stepText(route.steps[2], 'ru')).toBe('На кольце 2-й съезд на Краснопролетарская улица');
    expect(stepText(route.steps[3], 'ru')).toBe('Вы прибыли');
  });
  it('украинский', () => {
    expect(stepText(route.steps[1], 'uk')).toBe('Поверніть праворуч на Садовая-Триумфальная улица');
    expect(stepText(route.steps[3], 'uk')).toBe('Ви прибули');
  });
  it('иконки манёвров', () => {
    expect(stepIcon(route.steps[1])).toBe('arrowRight');
    expect(stepIcon(route.steps[2])).toBe('roundabout');
    expect(stepIcon(route.steps[3])).toBe('flag');
  });
});

describe('форматирование', () => {
  it('расстояние', () => {
    expect(fmtDistance(35)).toBe('40 м');
    expect(fmtDistance(230)).toBe('250 м');
    expect(fmtDistance(1450)).toBe('1,4 км');
    expect(fmtDistance(23400)).toBe('23 км');
  });
  it('время', () => {
    expect(fmtDuration(330)).toBe('6 мин');
    expect(fmtDuration(3900)).toBe('1 ч 5 мин');
    expect(fmtDuration(600, 'uk')).toBe('10 хв');
  });
});

describe('routeProgress', () => {
  it('в начале маршрута следующий манёвр — поворот направо', () => {
    const p = routeProgress(route, route.coords[0]);
    expect(p.stepIndex).toBe(1);
    expect(p.offRouteM).toBeLessThan(1);
    expect(p.toStepM).toBeGreaterThan(800);
    expect(Math.abs(p.remainingM - p.toStepM - (p.remainingM - p.toStepM))).toBe(0);
  });
  it('после поворота следующий манёвр — кольцо', () => {
    const p = routeProgress(route, route.coords[5]);
    expect(p.stepIndex).toBe(2);
  });
  it('у финиша остаётся мало', () => {
    const p = routeProgress(route, route.coords[9]);
    expect(p.remainingM).toBeLessThan(5);
  });
  it('определяет сход с маршрута', () => {
    const away = { lat: 55.757, lon: 37.64 };
    const p = routeProgress(route, away);
    expect(p.offRouteM).toBeGreaterThan(1000);
  });
  it('haversine ~ 1 градус широты = 111 км', () => {
    expect(haversine({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeGreaterThan(110_000);
    expect(haversine({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeLessThan(112_000);
  });
});
