/* Собственная облегчённая 3D-модель автомобиля (без сторонних моделей и лицензий).
   Строится кодом из простых тел: кузов (профиль с фасками), кабина со стёклами, крыша, стойки, колёса, фары, фонари.
   Оси модели: x — вправо, y — вперёд (нос), z — вверх; единицы — метры. Реестр моделей — для других автомобилей. */

/** Материалы: цвет кузова задаётся настройкой, остальные — фиксированные; светящиеся не затеняются. */
export const MAT = {
  body: 0,
  glass: 1,
  tire: 2,
  rim: 3,
  headlight: 4,
  taillight: 5,
  trim: 6,
} as const;
export type MatId = (typeof MAT)[keyof typeof MAT];

/** RGB материалов (кроме кузова) и признак свечения. */
export const MAT_COLOR: Record<number, [number, number, number, number]> = {
  [MAT.body]: [1, 1, 1, 0],
  [MAT.glass]: [0.09, 0.12, 0.16, 0],
  [MAT.tire]: [0.07, 0.07, 0.08, 0],
  [MAT.rim]: [0.62, 0.65, 0.69, 0],
  [MAT.headlight]: [1.0, 0.97, 0.86, 1],
  [MAT.taillight]: [0.95, 0.13, 0.12, 1],
  [MAT.trim]: [0.12, 0.13, 0.15, 0],
};

export interface CarMesh {
  /** xyz на вершину */
  positions: Float32Array;
  /** нормаль на вершину */
  normals: Float32Array;
  /** материал на вершину */
  materials: Float32Array;
  /** длина модели, м (для масштаба) */
  length: number;
  width: number;
  height: number;
}

type V3 = [number, number, number];

export class Builder {
  pos: number[] = [];
  nor: number[] = [];
  mat: number[] = [];
  tri(a: V3, b: V3, c: V3, m: number) {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(...n) || 1;
    n = [n[0] / l, n[1] / l, n[2] / l];
    for (const p of [a, b, c]) {
      this.pos.push(...p);
      this.nor.push(...n);
      this.mat.push(m);
    }
  }
  /** Четырёхугольник a-b-c-d (против часовой стрелки, если смотреть снаружи). */
  quad(a: V3, b: V3, c: V3, d: V3, m: number) {
    this.tri(a, b, c, m);
    this.tri(a, c, d, m);
  }
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, m: number) {
    const P = (x: number, y: number, z: number): V3 => [x, y, z];
    this.quad(P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1), m); // верх
    this.quad(P(x0, y1, z0), P(x1, y1, z0), P(x1, y0, z0), P(x0, y0, z0), m); // низ
    this.quad(P(x0, y1, z0), P(x0, y1, z1), P(x1, y1, z1), P(x1, y1, z0), m); // перед
    this.quad(P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1), P(x0, y0, z0), m); // зад
    this.quad(P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1), P(x1, y0, z0), m); // право
    this.quad(P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0), m); // лево
  }
  /** Выпуклый профиль в плоскости (y, z), вытянутый по x от -w/2 до w/2. Профиль — против часовой стрелки. */
  extrude(profile: [number, number][], w: number, m: number) {
    const h = w / 2;
    const L = profile.map(([y, z]): V3 => [-h, y, z]);
    const R = profile.map(([y, z]): V3 => [h, y, z]);
    for (let i = 1; i < profile.length - 1; i++) {
      this.tri(R[0], R[i], R[i + 1], m); // правый борт
      this.tri(L[0], L[i + 1], L[i], m); // левый борт
    }
    for (let i = 0; i < profile.length; i++) {
      const j = (i + 1) % profile.length;
      this.quad(L[i], L[j], R[j], R[i], m);
    }
  }
  /** Колесо: цилиндр по оси x. */
  wheel(cx: number, cy: number, cz: number, r: number, w: number, seg = 12) {
    const x0 = cx - w / 2;
    const x1 = cx + w / 2;
    const outer = cx > 0 ? x1 : x0;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      const p = (x: number, a: number, rr = r): V3 => [x, cy + Math.cos(a) * rr, cz + Math.sin(a) * rr];
      this.quad(p(x0, a0), p(x0, a1), p(x1, a1), p(x1, a0), MAT.tire);
      // Наружный диск
      if (outer === x1) this.tri([x1, cy, cz], p(x1, a0, r * 0.62), p(x1, a1, r * 0.62), MAT.rim);
      else this.tri([x0, cy, cz], p(x0, a1, r * 0.62), p(x0, a0, r * 0.62), MAT.rim);
    }
  }
  build(length: number, width: number, height: number): CarMesh {
    return { positions: new Float32Array(this.pos), normals: new Float32Array(this.nor), materials: new Float32Array(this.mat), length, width, height };
  }
}

/** Современный компактный кроссовер ~4,5 × 1,9 × 1,65 м. */
export function buildSuv(): CarMesh {
  const b = new Builder();
  const W = 1.9;
  // Кузов: профиль сбоку (y вперёд, z вверх), фаски капота и багажника.
  b.extrude(
    [
      [-2.25, 0.36],
      [2.25, 0.36],
      [2.3, 0.62],
      [2.22, 0.86],
      [1.25, 1.06],
      [-2.12, 1.08],
      [-2.26, 0.95],
    ],
    W,
    MAT.body,
  );
  // Кабина: стёкла (лобовое наклонено сильнее заднего).
  b.extrude(
    [
      [-2.02, 1.06],
      [1.2, 1.06],
      [0.42, 1.6],
      [-1.86, 1.62],
    ],
    1.72,
    MAT.glass,
  );
  // Крыша и рейлинги.
  b.box(-0.82, 0.82, -1.86, 0.4, 1.6, 1.67, MAT.body);
  b.box(-0.8, -0.72, -1.7, 0.2, 1.67, 1.71, MAT.trim);
  b.box(0.72, 0.8, -1.7, 0.2, 1.67, 1.71, MAT.trim);
  // Стойки B и C — окраска кузова поверх стёкол.
  for (const s of [-1, 1]) {
    b.box(s * 0.87 - 0.02, s * 0.87 + 0.02, -0.55, -0.42, 1.06, 1.6, MAT.body);
    b.box(s * 0.86 - 0.02, s * 0.86 + 0.02, -1.95, -1.7, 1.06, 1.6, MAT.body);
  }
  // Бамперы и пороги — тёмный пластик.
  b.box(-0.93, 0.93, 2.02, 2.32, 0.34, 0.5, MAT.trim);
  b.box(-0.93, 0.93, -2.3, -2.0, 0.34, 0.52, MAT.trim);
  b.box(-0.97, -0.93, -1.2, 1.2, 0.34, 0.46, MAT.trim);
  b.box(0.93, 0.97, -1.2, 1.2, 0.34, 0.46, MAT.trim);
  // Фары и задние фонари (светятся).
  // Зеркально по x: [внутренний, внешний] край для правой стороны, для левой — отражение.
  const pair = (x0: number, x1: number, f: (a: number, b: number) => void) => {
    f(x0, x1);
    f(-x1, -x0);
  };
  pair(0.6, 0.86, (a, c) => b.box(a, c, 2.24, 2.31, 0.72, 0.8, MAT.headlight));
  pair(0.6, 0.88, (a, c) => b.box(a, c, -2.28, -2.22, 0.82, 0.93, MAT.taillight));
  b.box(-0.6, 0.6, -2.27, -2.23, 0.86, 0.89, MAT.taillight); // светящаяся полоса между фонарями
  // Колёса.
  for (const y of [1.42, -1.38]) for (const s of [-1, 1]) b.wheel(s * 0.83, y, 0.36, 0.36, 0.26);
  return b.build(4.6, W, 1.71);
}

/** Реестр моделей: позже — седан, хэтчбек, пикап. */
export const CAR_MODELS = { suv: { name: 'Кроссовер', build: buildSuv } } as const;
export type CarModelId = keyof typeof CAR_MODELS;
