/* Стилизованный электрокроссовер — собственная процедурная модель (без сторонних моделей и лицензий).

   Кузов и остекление строятся «лофтом»: по длине машины — сечения-суперэллипсы (скруглённые прямоугольники),
   ширина и высота сечений меняются плавно, нормали — сглаженные по сетке. Отсюда округлые пропорции без сотен
   ручных вершин. Детали отмечаются материалом по положению на поверхности: светодиодная полоса фонарей сзади,
   тонкая полоса фар спереди, тёмная накладка по низу и в арках, панорамная крыша, стойки цвета кузова.
   Арки — углубления поверхности (без вырезов), в них видны колёса.
   Оси: x — вправо, y — вперёд, z — вверх; метры. */
import { Builder, MAT, type CarMesh } from './mesh';

type V3 = [number, number, number];

const L = 4.62;
const HALF_L = L / 2;
const W = 1.94;
const Z0 = 0.3; // низ кузова (клиренс)
const WHEEL_R = 0.37;
const WHEEL_W = 0.27;
const AXLES = [1.42, -1.4];

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Суперэллипс: «округлый квадрат» с показателем n (2 — эллипс, больше — квадратнее). */
const se = (v: number, n: number) => Math.sign(v) * Math.abs(v) ** (2 / n);

/** Полуширина кузова в плане: скруглённые нос (острее) и корма. */
function halfWidth(y: number) {
  const t = y / HALF_L;
  const n = t > 0 ? 4.2 : 6;
  return (W / 2) * (1 - Math.abs(t) ** n) ** (1 / n);
}

/** Верх нижней части кузова (линия капота — пояс — крышка багажника). */
function beltZ(y: number) {
  const hood = 0.78 + 0.22 * smooth(2.3, 1.15, y); // капот: нос ниже, к лобовому стеклу выше
  const tail = 1.02 - 0.08 * smooth(-2.05, -2.31, y); // корма слегка скруглена вниз
  return y > 0 ? Math.min(hood, 1.0 + 0.02 * (1 - y / HALF_L)) : tail;
}

/** Низ кузова: подрезан у бамперов (свесы). */
function bottomZ(y: number) {
  return Z0 + 0.08 * smooth(1.9, 2.31, y) + 0.12 * smooth(-1.95, -2.31, y);
}

/** Углубление арки: 0 вне арки, 1 внутри (по сечению y–z). */
function archDepth(y: number, z: number) {
  let d = 0;
  for (const ay of AXLES) {
    const r = Math.hypot(y - ay, z - WHEEL_R);
    d = Math.max(d, 1 - smooth(WHEEL_R + 0.05, WHEEL_R + 0.13, r));
  }
  return d;
}

/** Расширение «плеч» над колёсами — объёмные борта. */
function fender(y: number, z: number) {
  let f = 0;
  for (const ay of AXLES) f = Math.max(f, Math.exp(-(((y - ay) / 0.55) ** 2)));
  return 0.035 * f * Math.exp(-(((z - 0.72) / 0.22) ** 2));
}

/** Сетка точек «кольцо × станция» → треугольники со сглаженными нормалями. */
function loft(b: Builder, rings: V3[][], closedRing: boolean, mat: (p: V3, n: V3) => number, center: (i: number) => V3) {
  const S = rings.length;
  const M = rings[0].length;
  const at = (i: number, j: number) => rings[clamp(i, 0, S - 1)][closedRing ? (j + M) % M : clamp(j, 0, M - 1)];
  const normal = (i: number, j: number): V3 => {
    const a = at(i + 1, j);
    const c = at(i - 1, j);
    const d = at(i, j + 1);
    const e = at(i, j - 1);
    const u: V3 = [a[0] - c[0], a[1] - c[1], a[2] - c[2]];
    const v: V3 = [d[0] - e[0], d[1] - e[1], d[2] - e[2]];
    let n: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const p = at(i, j);
    const o = center(i);
    // Наружу — от оси сечения.
    if (n[0] * (p[0] - o[0]) + n[1] * (p[1] - o[1]) + n[2] * (p[2] - o[2]) < 0) n = [-n[0], -n[1], -n[2]];
    const l = Math.hypot(...n) || 1;
    return [n[0] / l, n[1] / l, n[2] / l];
  };
  const N: V3[][] = rings.map((r, i) => r.map((_, j) => normal(i, j)));
  const jEnd = closedRing ? M : M - 1;
  for (let i = 0; i < S - 1; i++) {
    for (let j = 0; j < jEnd; j++) {
      const j1 = (j + 1) % M;
      const q: [V3, V3, V3, V3] = [rings[i][j], rings[i + 1][j], rings[i + 1][j1], rings[i][j1]];
      const qn: [V3, V3, V3, V3] = [N[i][j], N[i + 1][j], N[i + 1][j1], N[i][j1]];
      const cpos: V3 = [(q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2, (q[0][2] + q[2][2]) / 2];
      const cn: V3 = [(qn[0][0] + qn[2][0]) / 2, (qn[0][1] + qn[2][1]) / 2, (qn[0][2] + qn[2][2]) / 2];
      const m = mat(cpos, cn);
      // Порядок вершин — против часовой снаружи (для единообразия; отсечение граней в слое выключено).
      b.triN(q[0], q[1], q[2], qn[0], qn[1], qn[2], m);
      b.triN(q[0], q[2], q[3], qn[0], qn[2], qn[3], m);
    }
  }
}

/** Неравномерные станции по длине: гуще у носа, кормы и арок — гладкие скругления. */
function stations(y0: number, y1: number, n: number, ends = 2.2) {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    // Сгущение к концам: синусоидальное распределение.
    const s = 0.5 - 0.5 * Math.cos(Math.PI * t);
    out.push(y0 + (y1 - y0) * (t + (s - t) * (ends - 1) * 0.5));
  }
  return out;
}

export function buildEv(): CarMesh {
  const b = new Builder();

  /* ---------- Нижняя часть кузова ---------- */
  const RING = 30;
  const ys = stations(-HALF_L + 0.004, HALF_L - 0.004, 34);
  const body: V3[][] = ys.map((y) => {
    const hw = halfWidth(y);
    const z0 = bottomZ(y);
    const z1 = beltZ(y);
    // Торцы скруглены и по высоте («подушка»): сечение у самого носа и кормы сходится, без плоской заглушки.
    const t = y / HALF_L;
    const m = t > 0 ? 7 : 12;
    const endK = (1 - Math.abs(t) ** m) ** (1 / m);
    const zc = (z0 + z1) / 2;
    const hh = ((z1 - z0) / 2) * (0.35 + 0.65 * endK);
    const ring: V3[] = [];
    for (let j = 0; j < RING; j++) {
      const a = (j / RING) * Math.PI * 2;
      const z = zc + hh * se(Math.sin(a), 4.2);
      let x = hw * se(Math.cos(a), 3.4);
      x *= 1 + fender(y, z);
      // Арка: поверхность уходит внутрь, открывая колесо.
      const arch = archDepth(y, z);
      if (arch > 0 && Math.abs(x) > 0.3) x = Math.sign(x) * (Math.abs(x) - 0.17 * arch);
      ring.push([x, y, z]);
    }
    return ring;
  });
  loft(
    b,
    body,
    true,
    (p, n) => {
      const [, y, z] = p;
      // Светодиодные полосы фонарей и фар рисуются шейдером по поверхности (car3d/layer.ts) — чёткие при любой сетке.
      // Тёмная накладка: низ, пороги, арки.
      // Накладки арок и порогов рисует шейдер (плавные границы); здесь — только днище и пороги снизу.
      if (z < bottomZ(y) + 0.05 || (n[2] < -0.5 && z < 0.6)) return MAT.trim;
      return MAT.body;
    },
    (i) => [0, ys[i], (bottomZ(ys[i]) + beltZ(ys[i])) / 2],
  );
  // Торцы (нос и корма) закрыты — у самых краёв кольца крошечные, но закрываем веером.
  for (const end of [0, body.length - 1]) {
    const r = body[end];
    const c: V3 = [0, r[0][1], (bottomZ(r[0][1]) + beltZ(r[0][1])) / 2];
    const n: V3 = [0, end === 0 ? -1 : 1, 0];
    for (let j = 0; j < r.length; j++) {
      const lowEdge = Math.min(r[j][2], r[(j + 1) % r.length][2]) < bottomZ(r[0][1]) + 0.1;
      b.triN(c, r[j], r[(j + 1) % r.length], n, n, n, lowEdge ? MAT.trim : MAT.body);
    }
  }

  /* ---------- Остекление и крыша (панорамная) ---------- */
  const CY0 = -2.02; // задняя кромка (пятая дверь)
  const CY1 = 1.18; // основание лобового стекла
  const cys = stations(CY0, CY1, 22, 1.6);
  // Крыша — плавная дуга; лобовое и заднее стекло задаются высотой кабины над поясом (cabinH).
  const roofZ = (y: number) => 1.6 - 0.04 * ((y + 0.4) / 1.6) ** 2;
  const cabinH = (y: number) => {
    const front = smooth(CY1, 0.05, y);
    const rear = 0.25 + 0.75 * smooth(CY0, -1.25, y);
    return Math.max(0.004, (roofZ(y) - beltZ(y)) * front * rear);
  };
  const CR = 16;
  const cabin: V3[][] = cys.map((y) => {
    const zb = beltZ(y) - 0.005;
    const h = cabinH(y);
    const wb = halfWidth(y) * 0.93;
    const ring: V3[] = [];
    for (let j = 0; j <= CR; j++) {
      const a = (j / CR) * Math.PI; // от правого борта через крышу к левому
      const u = se(Math.cos(a), 3.2);
      const v = Math.abs(se(Math.sin(a), 3.2));
      const tumble = 1 - 0.17 * v; // завал боковин внутрь к крыше
      ring.push([wb * tumble * u, y, zb + h * v]);
    }
    return ring;
  });
  loft(
    b,
    cabin,
    false,
    (p, n) => {
      const [x, y, z] = p;
      const y01 = (y - CY0) / (CY1 - CY0);
      const hw = halfWidth(y) * 0.93 * 0.83;
      // Рейлинги/кант крыши и стойки — цвет кузова; середина крыши — тёмное панорамное стекло.
      if (n[2] > 0.82 && Math.abs(x) > hw * 0.82 && y01 > 0.12 && y01 < 0.82) return MAT.body;
      if (n[2] > 0.82 && y01 > 0.12 && y01 < 0.84) return MAT.roof;
      // Стойка C/D и задняя «плавник»-панель — цвет кузова.
      // Узкая стойка B.
      if (y > -0.12 && y < 0.02 && Math.abs(n[0]) > 0.6 && z < 1.5) return MAT.trim;
      return MAT.glass;
    },
    (i) => [0, cys[i], beltZ(cys[i])],
  );

  /* ---------- Фары ---------- */
  // Тонкая светящаяся полоса фар — отдельной деталью чуть перед поверхностью носа (видна и вблизи, и издалека).
  const noseY = (x: number, z: number) => {
    // ищем переднюю точку поверхности кузова на высоте z для данного x — по станциям
    let best = 0;
    for (let i = body.length - 1; i > 0; i--) {
      const ring = body[i];
      const inside = ring.some((p) => Math.abs(p[2] - z) < 0.06 && Math.abs(p[0]) >= Math.abs(x));
      if (inside) {
        best = ring[0][1];
        break;
      }
    }
    return best;
  };
  for (const s of [-1, 1]) {
    const pts: V3[] = [];
    for (let k = 0; k <= 6; k++) {
      const x = s * (0.12 + (0.7 * k) / 6);
      pts.push([x, noseY(x, 0.73) + 0.012, 0.73]);
    }
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k];
      const c = pts[k + 1];
      const up: V3 = [0, 1, 0];
      b.triN([a[0], a[1], a[2] - 0.016], [c[0], c[1], c[2] - 0.016], [c[0], c[1], c[2] + 0.016], up, up, up, MAT.headlight);
      b.triN([a[0], a[1], a[2] - 0.016], [c[0], c[1], c[2] + 0.016], [a[0], a[1], a[2] + 0.016], up, up, up, MAT.headlight);
    }
  }

  /* ---------- Колёса ---------- */
  for (const y of AXLES)
    for (const s of [-1, 1]) {
      const hw = halfWidth(y);
      b.wheelEv(s * (hw - 0.1 - WHEEL_W / 2), y, WHEEL_R, WHEEL_R, WHEEL_W);
    }

  return b.build(L, W + 0.07, roofZ(0));
}
