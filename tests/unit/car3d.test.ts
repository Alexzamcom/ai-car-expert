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
    expect(new Set(m.materials)).toEqual(new Set(Object.values(MAT)));
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
