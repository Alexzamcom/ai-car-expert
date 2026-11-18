import { describe, it, expect } from 'vitest';
import { Builder, buildSuv, MAT, CAR_MODELS } from '../../src/lib/car3d/mesh';

/** Доля треугольников, нормаль которых смотрит от центра тела (наружу). */
function outwardShare(b: Builder, c: [number, number, number]) {
  let ok = 0;
  const n = b.pos.length / 9;
  for (let t = 0; t < n; t++) {
    const p = b.pos.slice(t * 9, t * 9 + 9);
    const m = [(p[0] + p[3] + p[6]) / 3 - c[0], (p[1] + p[4] + p[7]) / 3 - c[1], (p[2] + p[5] + p[8]) / 3 - c[2]];
    const nn = b.nor.slice(t * 9, t * 9 + 3);
    if (m[0] * nn[0] + m[1] * nn[1] + m[2] * nn[2] > 0) ok++;
  }
  return ok / n;
}

describe('3D-машинка: геометрия', () => {
  it('куб: все нормали наружу', () => {
    const b = new Builder();
    b.box(-1, 1, -2, 2, 0, 1, MAT.body);
    expect(outwardShare(b, [0, 0, 0.5])).toBe(1);
  });
  it('вытянутый профиль: все нормали наружу', () => {
    const b = new Builder();
    b.extrude([[-2, 0], [2, 0], [2, 1], [-2, 1]], 2, MAT.body);
    expect(outwardShare(b, [0, 0, 0.5])).toBe(1);
  });
  it('колесо: все нормали наружу', () => {
    const b = new Builder();
    b.wheel(0.8, 0, 0.36, 0.36, 0.26);
    expect(outwardShare(b, [0.8, 0, 0.36])).toBe(1);
  });
  it('модель SUV: лёгкая, реалистичные пропорции, все материалы', () => {
    const m = buildSuv();
    const tris = m.positions.length / 9;
    console.info('Треугольников в модели:', tris);
    expect(tris).toBeGreaterThan(150);
    expect(tris).toBeLessThan(800); // лёгкая модель: сотни треугольников
    let minY = Infinity, maxY = -Infinity, maxZ = -Infinity, maxX = -Infinity;
    for (let i = 0; i < m.positions.length; i += 3) {
      maxX = Math.max(maxX, Math.abs(m.positions[i]));
      minY = Math.min(minY, m.positions[i + 1]);
      maxY = Math.max(maxY, m.positions[i + 1]);
      maxZ = Math.max(maxZ, m.positions[i + 2]);
    }
    expect(maxY - minY).toBeCloseTo(4.6, 1); // длина
    expect(maxX * 2).toBeLessThan(2.0); // ширина
    expect(maxZ).toBeLessThan(1.8); // высота
    expect(new Set(m.materials)).toEqual(new Set(Object.values(MAT).filter((v) => v !== MAT.roof))); // у простой модели нет панорамной крыши
    expect(m.normals.length).toBe(m.positions.length);
  });
  it('нос модели — вперёд (+y): фары спереди, фонари сзади', () => {
    const m = buildSuv();
    let head = 0, tail = 0;
    for (let i = 0; i < m.materials.length; i++) {
      if (m.materials[i] === MAT.headlight) head += m.positions[i * 3 + 1];
      if (m.materials[i] === MAT.taillight) tail += m.positions[i * 3 + 1];
    }
    expect(head).toBeGreaterThan(0);
    expect(tail).toBeLessThan(0);
  });
  it('реестр моделей', () => {
    expect(CAR_MODELS.suv.build().length).toBe(4.6);
  });
});

import { buildEv } from '../../src/lib/car3d/ev';
import { viewDir } from '../../src/lib/car3d/layer';
describe('3D-машинка: электрокроссовер', () => {
  const m = buildEv();
  const tris = m.positions.length / 9;
  it('детальнее прежней, но лёгкая для iPad/iPhone', () => {
    console.info('Треугольников в электрокроссовере:', tris);
    expect(tris).toBeGreaterThan(1500);
    expect(tris).toBeLessThan(8000);
  });
  it('пропорции кроссовера: ~4,6 × 1,95 × 1,6 м, нос вперёд', () => {
    let minY = Infinity, maxY = -Infinity, maxZ = -Infinity, maxX = -Infinity;
    for (let i = 0; i < m.positions.length; i += 3) {
      maxX = Math.max(maxX, Math.abs(m.positions[i]));
      minY = Math.min(minY, m.positions[i + 1]);
      maxY = Math.max(maxY, m.positions[i + 1]);
      maxZ = Math.max(maxZ, m.positions[i + 2]);
    }
    expect(maxY - minY).toBeGreaterThan(4.5);
    expect(maxY - minY).toBeLessThan(4.7);
    expect(maxX * 2).toBeLessThan(2.05);
    expect(maxZ).toBeGreaterThan(1.5);
    expect(maxZ).toBeLessThan(1.7);
    let head = 0;
    for (let i = 0; i < m.materials.length; i++) if (m.materials[i] === MAT.headlight) head += m.positions[i * 3 + 1];
    expect(head).toBeGreaterThan(0); // фары спереди
  });
  it('материалы: кузов, стёкла, панорамная крыша, шины, диски, накладки, фары; нормали единичные и наружу', () => {
    const set = new Set(m.materials);
    for (const k of [MAT.body, MAT.glass, MAT.roof, MAT.tire, MAT.rim, MAT.trim, MAT.headlight]) expect(set.has(k)).toBe(true);
    let bad = 0;
    for (let i = 0; i < m.normals.length; i += 3) if (Math.abs(Math.hypot(m.normals[i], m.normals[i + 1], m.normals[i + 2]) - 1) > 1e-3) bad++;
    expect(bad).toBe(0);
    // Кузов: нормали смотрят от продольной оси (сглаженная поверхность без «вывернутых» участков).
    let out = 0, all = 0;
    for (let i = 0; i < m.materials.length; i++) {
      if (m.materials[i] !== MAT.body) continue;
      all++;
      const x = m.positions[i * 3], z = m.positions[i * 3 + 2] - 0.65;
      if (x * m.normals[i * 3] + z * m.normals[i * 3 + 2] > -0.05) out++;
    }
    expect(out / all).toBeGreaterThan(0.97);
  });
  it('колёса видны в арках: протектор снаружи кузова у арки', () => {
    let maxTire = 0;
    for (let i = 0; i < m.materials.length; i++) if (m.materials[i] === MAT.tire) maxTire = Math.max(maxTire, Math.abs(m.positions[i * 3]));
    expect(maxTire).toBeGreaterThan(0.75);
  });
  it('направление на камеру: сзади-сверху при карте «по движению»', () => {
    // Карта повёрнута по курсу машины, наклон 50°: камера сзади (−y) и сверху (+z).
    const [x, y, z] = viewDir(90, 50, 90);
    expect(Math.abs(x)).toBeLessThan(1e-9);
    expect(y).toBeLessThan(-0.7);
    expect(z).toBeGreaterThan(0.6);
  });
  it('по умолчанию — электрокроссовер', () => {
    expect(Object.keys(CAR_MODELS)[0]).toBe('ev');
  });
});
