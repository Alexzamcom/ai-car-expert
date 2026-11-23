/* 3D-машинка как пользовательский WebGL-слой MapLibre: несколько сотен треугольников, один проход, без библиотек.
   Размер в обычном режиме постоянный, в игровом зависит от масштаба, курс — от севера по часовой, наклон и поворот карты — от MapLibre. */
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from 'maplibre-gl';
import { MercatorCoordinate } from 'maplibre-gl';
import { CAR_MODELS, MAT_COLOR, type CarModelId, type CarMesh } from './mesh';

export interface Car3dState {
  lon: number;
  lat: number;
  /** Курс, градусы от севера по часовой. */
  heading: number;
  /** Цвет кузова, RGB 0…1. */
  color: [number, number, number];
}

const VS = `
attribute vec3 aPos; attribute vec3 aNor; attribute float aMat;
uniform mat4 uMvp;
varying vec3 vNor; varying float vMat; varying vec3 vPos;
void main(){ vNor = aNor; vMat = aMat; vPos = aPos; gl_Position = uMvp * vec4(aPos, 1.0); }`;

/* Освещение в координатах модели: ключевой свет сзади-сверху-слева (машинка одинаково читается при любом курсе),
   направление на камеру uView — из поворота и наклона карты; отражения — простое «небо/земля» по отражённому лучу. */
const FS = `
precision mediump float;
varying vec3 vNor; varying float vMat; varying vec3 vPos;
uniform vec3 uBody; uniform vec4 uMats[8]; uniform vec3 uView; uniform float uNight;
vec3 env(vec3 r){
  vec3 sky = mix(vec3(0.62, 0.70, 0.80), vec3(0.95, 0.97, 1.0), smoothstep(0.0, 0.8, r.z));
  vec3 ground = vec3(0.16, 0.17, 0.19);
  return mix(ground, sky, smoothstep(-0.15, 0.12, r.z));
}
void main(){
  vec3 n = normalize(vNor);
  int m = int(vMat + 0.5);
  vec4 mc = uMats[0];
  for (int i = 1; i < 8; i++) if (i == m) mc = uMats[i];
  vec3 base = m == 0 ? uBody : mc.rgb;
  // Светодиодные полосы рисуются по поверхности кузова (чётко при любой сетке): фонари сзади во всю ширину, фары спереди.
  if (m == 0) {
    if ((n.y < -0.35 && vPos.z > 0.855 && vPos.z < 0.905) || (vPos.y < -1.98 && abs(vPos.x) > 0.6 && vPos.z > 0.8 && vPos.z < 0.95 && n.y < 0.2)) { mc = uMats[5]; base = mc.rgb; }
    else if (n.y > 0.3 && vPos.z > 0.712 && vPos.z < 0.742 && abs(vPos.x) < 0.88) { mc = uMats[4]; base = mc.rgb; }
    else {
      // Тёмные накладки: арки колёс (оси 1.42 и −1.40 м, радиус 0.37) и пороги.
      float arch = min(length(vec2(vPos.y - 1.42, vPos.z - 0.37)), length(vec2(vPos.y + 1.40, vPos.z - 0.37)));
      if ((arch < 0.5 && abs(n.x) > 0.25) || vPos.z < 0.42) { m = 6; mc = uMats[6]; base = mc.rgb; }
    }
  }
  // Остекление: стойка D цвета кузова (наклонная граница), панорамная крыша — по нормали (плавные границы).
  if (m == 1 || m == 7) {
    if (vPos.y < -1.42 - 0.35 * (vPos.z - 1.05) && abs(n.x) > 0.5 && n.z < 0.8) { m = 0; base = uBody; mc = uMats[0]; }
    else {
      // Плавный переход стекло → панорамная крыша (без «ступенек» сетки).
      float roof = smoothstep(0.78, 0.9, n.z);
      base = mix(uMats[1].rgb, uMats[7].rgb, roof);
      m = roof > 0.5 ? 7 : 1;
    }
  }
  // Фары и фонари светятся.
  if (mc.a > 0.5) { gl_FragColor = vec4(min(base * (1.15 + 0.35 * uNight) + 0.08, 1.0), 1.0); return; }
  vec3 V = normalize(uView);
  vec3 Lk = normalize(vec3(-0.35, -0.45, 0.82));
  vec3 Lf = normalize(vec3(0.6, 0.3, 0.5));
  float diff = max(dot(n, Lk), 0.0) * 0.75 + max(dot(n, Lf), 0.0) * 0.25;
  float hemi = 0.5 + 0.5 * n.z;
  float ao = mix(0.55, 1.0, smoothstep(0.25, 1.05, vPos.z));
  vec3 H = normalize(Lk + V);
  float fres = pow(1.0 - max(dot(n, V), 0.0), 3.0);
  vec3 R = reflect(-V, n);
  vec3 col;
  if (m == 0) {
    // Кузов: краска + лак — мягкий блик и отражение неба по краям.
    float spec = pow(max(dot(n, H), 0.0), 48.0) * 0.55;
    col = base * (0.24 + 0.5 * diff + 0.16 * hemi) * ao;
    col = mix(col, env(R) * 0.92, 0.06 + 0.3 * fres) + spec;
  } else if (m == 1 || m == 7) {
    // Стёкла и панорамная крыша: тёмные, с отражением неба.
    float spec = pow(max(dot(n, H), 0.0), 80.0) * 0.9;
    col = base * (0.5 + 0.5 * diff) + env(R) * (m == 7 ? 0.28 : 0.22) * (0.35 + 0.65 * fres) + spec;
  } else if (m == 3) {
    // Диски — металл.
    float spec = pow(max(dot(n, H), 0.0), 30.0) * 0.6;
    col = base * (0.35 + 0.5 * diff) + env(R) * 0.25 + spec;
  } else {
    col = base * (0.45 + 0.55 * diff) * ao + pow(max(dot(n, H), 0.0), 16.0) * 0.06;
  }
  // Ночью кузов чуть темнее и холоднее (как под лунным светом), но остаётся хорошо заметным; фары — ярче.
  col = mix(col, col * vec3(0.72, 0.78, 0.92), uNight);
  gl_FragColor = vec4(col, 1.0);
}`;

const SHADOW_VS = `
attribute vec2 aUv; uniform mat4 uMvp; varying vec2 vUv;
void main(){ vUv = aUv; gl_Position = uMvp * vec4(aUv.x * 1.35, aUv.y * 2.75, 0.02, 1.0); }`;
/* Мягкая тень: широкий полупрозрачный ореол + плотная контактная тень под колёсами. */
const SHADOW_FS = `
precision mediump float; varying vec2 vUv; uniform float uAlpha;
void main(){
  vec2 q = abs(vUv);
  float box = length(max(q - vec2(0.55, 0.7), 0.0)) + min(max(q.x - 0.55, q.y - 0.7), 0.0);
  float soft = 1.0 - smoothstep(-0.35, 0.6, box);
  float contact = 1.0 - smoothstep(-0.32, 0.02, box);
  gl_FragColor = vec4(0.0, 0.0, 0.0, uAlpha * (0.55 * soft + 0.45 * contact));
}`;

/* Ночь («Игровая 3D»): свет фар и задних огней на земле — плоские прямоугольники в координатах машинки
   (поворачиваются вместе с ней), мягкое аддитивное свечение без расчёта освещения сцены. */
const GLOW_VS = `
attribute vec2 aUv; uniform mat4 uMvp; uniform vec4 uRect; varying vec2 vUv;
void main(){ vUv = aUv * 0.5 + 0.5; vec2 p = mix(uRect.xy, uRect.zw, vUv); gl_Position = uMvp * vec4(p, 0.03, 1.0); }`;
const GLOW_FS = `
precision mediump float; varying vec2 vUv; uniform float uKind; uniform float uAlpha;
void main(){
  float x = vUv.x * 2.0 - 1.0; // поперёк машинки −1…1
  float t = vUv.y;             // вдоль: фары — от бампера вперёд (0→1), огни — от кормы назад (1→0)
  if (uKind < 0.5) {
    // Ближний свет: два луча расходятся и сливаются, к краю пятна гаснут.
    float spread = 0.3 + 0.75 * t;
    float beam = max(1.0 - smoothstep(0.1 * spread, 0.7 * spread, abs(x - 0.3 * (1.0 - t))),
                     1.0 - smoothstep(0.1 * spread, 0.7 * spread, abs(x + 0.3 * (1.0 - t))));
    float a = beam * pow(1.0 - t, 1.25) * smoothstep(0.0, 0.05, t);
    gl_FragColor = vec4(vec3(1.0, 0.9, 0.68) * a * uAlpha, 1.0);
  } else {
    // Задние огни: узкое красное свечение за кормой.
    float a = (1.0 - smoothstep(0.35, 1.0, abs(x))) * pow(t, 2.2);
    gl_FragColor = vec4(vec3(1.0, 0.12, 0.08) * a * uAlpha, 1.0);
  }
}`;

function compile(gl: WebGLRenderingContext, vs: string, fs: string) {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
  return p;
}

/** a × b для матриц 4×4 по столбцам. */
export function mul4(a: ArrayLike<number>, b: ArrayLike<number>): Float32Array {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let v = 0;
    for (let k = 0; k < 4; k++) v += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = v;
  }
  return o;
}

/** Метров на пиксель экрана (тайлы MapLibre 512 px). */
export const metersPerPixel = (lat: number, zoom: number) => (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);

export const ANDROID_CAR_LENGTH_M = 4.8;
export const carWorldUnit = (metersToMercator: number, lengthM: number, meshLength: number) =>
  metersToMercator * lengthM / meshLength;

/** Ширина кузова в CSS-пикселях. Широкий экран ограничен его высотой. */
export function gameCarWidthPx(zoom: number, width: number, height: number): number {
  const smooth = (value: number) => {
    const t = Math.max(0, Math.min(1, value));
    return t * t * (3 - 2 * t);
  };
  const share = 0.19 + 0.06 * smooth((zoom - 15.2) / 2) + 0.07 * smooth((zoom - 17.2) / 1.8);
  return share * Math.min(width, height * 1.95);
}

/** Крайние вершины кузова и колёс в 26 направлениях. Углы прямоугольного
 * бокса завышали бы размер: над капотом и багажником таких вершин нет. */
function meshOutline(positions: Float32Array): [number, number, number][] {
  const indices = new Set<number>();
  for (const x of [-1, 0, 1]) {
    for (const y of [-1, 0, 1]) {
      for (const z of [-1, 0, 1]) {
        if (!x && !y && !z) continue;
        let best = 0;
        let distance = -Infinity;
        for (let i = 0; i < positions.length; i += 3) {
          const dot = x * positions[i] + y * positions[i + 1] + z * positions[i + 2];
          if (dot > distance) {
            best = i;
            distance = dot;
          }
        }
        indices.add(best);
      }
    }
  }
  return [...indices].map((i) => [positions[i], positions[i + 1], positions[i + 2]]);
}

function projectedSize(m: Float32Array, outline: [number, number, number][], width: number, height: number) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y, z] of outline) {
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (w <= 0) return null;
    const px = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    const py = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    minX = Math.min(minX, px);
    maxX = Math.max(maxX, px);
    minY = Math.min(minY, py);
    maxY = Math.max(maxY, py);
  }
  return { width: (maxX - minX) * width / 2, height: (maxY - minY) * height / 2 };
}

/**
 * Матрица модели (по столбцам): поворот на курс, масштаб, перенос в координаты Меркатора.
 * Ось y модели (нос) → курс: север — это −y Меркатора, восток — +x.
 */
export function modelMatrix(mx: number, my: number, headingDeg: number, unit: number): Float32Array {
  const h = (headingDeg * Math.PI) / 180;
  const c = Math.cos(h);
  const s = Math.sin(h);
  return new Float32Array([c * unit, s * unit, 0, 0, s * unit, -c * unit, 0, 0, 0, 0, unit, 0, mx, my, 0, 1]);
}

/**
 * Направление на камеру в координатах модели: камера сзади-сверху от центра карты по её повороту (bearing) и наклону.
 * Модель: y — нос (курс heading), x — вправо, z — вверх.
 */
export function viewDir(bearingDeg: number, pitchDeg: number, headingDeg: number): [number, number, number] {
  const b = (bearingDeg * Math.PI) / 180;
  const p = (Math.max(pitchDeg, 1) * Math.PI) / 180;
  // На камеру в осях восток/север/вверх.
  const e = -Math.sin(b) * Math.sin(p);
  const n = -Math.cos(b) * Math.sin(p);
  const u = Math.cos(p);
  const h = (headingDeg * Math.PI) / 180;
  return [e * Math.cos(h) - n * Math.sin(h), e * Math.sin(h) + n * Math.cos(h), u];
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export interface Car3dLayer extends CustomLayerInterface {
  /** Ошибка WebGL — вызывающий переключается на плоскую машинку. */
  failed: boolean;
  renderedBounds: { width: number; height: number } | null;
}

export function createCar3dLayer(
  get: () => Car3dState | null,
  opts: { model?: CarModelId; sizePx?: () => number; gameSize?: () => boolean; lengthM?: number; onError?: (e: unknown) => void; night?: () => boolean } = {},
): Car3dLayer {
  const mesh: CarMesh = CAR_MODELS[opts.model ?? 'ev'].build();
  const count = mesh.positions.length / 3;
  const outline = meshOutline(mesh.positions);
  let map: MlMap | null = null;
  let prog: WebGLProgram | null = null;
  let shadow: WebGLProgram | null = null;
  let glow: WebGLProgram | null = null;
  let vbo: WebGLBuffer | null = null;
  let sbo: WebGLBuffer | null = null;
  const mats = new Float32Array(Object.keys(MAT_COLOR).flatMap((k) => MAT_COLOR[Number(k)]));

  const layer: Car3dLayer = {
    id: 'car-3d',
    type: 'custom',
    renderingMode: '3d',
    failed: false,
    renderedBounds: null,
    onAdd(m, gl) {
      map = m;
      try {
        const g = gl as WebGLRenderingContext;
        prog = compile(g, VS, FS);
        shadow = compile(g, SHADOW_VS, SHADOW_FS);
        glow = compile(g, GLOW_VS, GLOW_FS);
        const data = new Float32Array(count * 7);
        for (let i = 0; i < count; i++) {
          data.set(mesh.positions.subarray(i * 3, i * 3 + 3), i * 7);
          data.set(mesh.normals.subarray(i * 3, i * 3 + 3), i * 7 + 3);
          data[i * 7 + 6] = mesh.materials[i];
        }
        vbo = g.createBuffer();
        g.bindBuffer(g.ARRAY_BUFFER, vbo);
        g.bufferData(g.ARRAY_BUFFER, data, g.STATIC_DRAW);
        sbo = g.createBuffer();
        g.bindBuffer(g.ARRAY_BUFFER, sbo);
        g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), g.STATIC_DRAW);
      } catch (e) {
        layer.failed = true;
        opts.onError?.(e);
      }
    },
    render(gl, args: CustomRenderMethodInput) {
      const st = get();
      if (!st || !map || !prog || !shadow || layer.failed) return;
      const g = gl as WebGLRenderingContext;
      const mc = MercatorCoordinate.fromLngLat([st.lon, st.lat], 0);
      const zoom = map.getZoom();
      const baseUnit = mc.meterInMercatorCoordinateUnits() * metersPerPixel(st.lat, zoom) / mesh.length;
      const main = (args.defaultProjectionData?.mainMatrix ?? args.modelViewProjectionMatrix) as unknown as ArrayLike<number>;
      const game = opts.lengthM == null && opts.gameSize?.();
      const { clientWidth: width, clientHeight: height } = map.getCanvas();
      const targetWidth = game ? gameCarWidthPx(zoom, width, height) : 0;
      let unit = opts.lengthM == null
        ? baseUnit * (game ? targetWidth * 1.9 : (opts.sizePx?.() ?? 60))
        : carWorldUnit(mc.meterInMercatorCoordinateUnits(), opts.lengthM, mesh.length);
      let mvp = mul4(main, modelMatrix(mc.x, mc.y, st.heading, unit));
      layer.renderedBounds = null;
      if (game && targetWidth > 0) {
        // Единый масштаб по всем осям. На широком экране ограничиваем также
        // высоту силуэта, чтобы он оставлял перед капотом обзор дороги.
        for (let pass = 0; pass < 4; pass++) {
          const bounds = projectedSize(mvp, outline, width, height);
          const ratio = bounds
            ? Math.min(targetWidth / bounds.width, height * 0.62 / bounds.height)
            : 0.5;
          if (Math.abs(1 - ratio) < 0.002) break;
          unit *= Math.max(0.35, Math.min(3, ratio));
          mvp = mul4(main, modelMatrix(mc.x, mc.y, st.heading, unit));
        }
      }
      if (game || opts.lengthM != null) layer.renderedBounds = projectedSize(mvp, outline, width, height);

      g.clear(g.DEPTH_BUFFER_BIT);
      g.disable(g.CULL_FACE);
      // Тень
      g.useProgram(shadow);
      g.enable(g.BLEND);
      g.blendFunc(g.SRC_ALPHA, g.ONE_MINUS_SRC_ALPHA);
      g.disable(g.DEPTH_TEST);
      g.uniformMatrix4fv(g.getUniformLocation(shadow, 'uMvp'), false, mvp);
      g.uniform1f(g.getUniformLocation(shadow, 'uAlpha'), 0.55);
      g.bindBuffer(g.ARRAY_BUFFER, sbo);
      const aUv = g.getAttribLocation(shadow, 'aUv');
      g.enableVertexAttribArray(aUv);
      g.vertexAttribPointer(aUv, 2, g.FLOAT, false, 8, 0);
      g.drawArrays(g.TRIANGLES, 0, 6);
      g.disableVertexAttribArray(aUv);
      const night = !!opts.night?.() && !!glow;
      if (night && glow) {
        // Свет фар (~9 м вперёд от бампера, расходится до ±3.4 м) и красные огни за кормой — аддитивно.
        g.useProgram(glow);
        g.blendFunc(g.ONE, g.ONE);
        g.uniformMatrix4fv(g.getUniformLocation(glow, 'uMvp'), false, mvp);
        const aG = g.getAttribLocation(glow, 'aUv');
        g.enableVertexAttribArray(aG);
        g.vertexAttribPointer(aG, 2, g.FLOAT, false, 8, 0);
        for (const [kind, rect, alpha] of [
          [0, [-3.4, 2.2, 3.4, 11.5], 0.7],
          [1, [-1.1, -3.6, 1.1, -2.25], 0.5],
        ] as const) {
          g.uniform1f(g.getUniformLocation(glow, 'uKind'), kind);
          g.uniform4fv(g.getUniformLocation(glow, 'uRect'), rect as unknown as number[]);
          g.uniform1f(g.getUniformLocation(glow, 'uAlpha'), alpha);
          g.drawArrays(g.TRIANGLES, 0, 6);
        }
        g.disableVertexAttribArray(aG);
        g.blendFunc(g.SRC_ALPHA, g.ONE_MINUS_SRC_ALPHA);
      }
      // Кузов
      g.disable(g.BLEND);
      g.enable(g.DEPTH_TEST);
      g.depthFunc(g.LEQUAL);
      g.depthMask(true);
      g.useProgram(prog);
      g.uniformMatrix4fv(g.getUniformLocation(prog, 'uMvp'), false, mvp);
      g.uniform3fv(g.getUniformLocation(prog, 'uBody'), st.color);
      g.uniform4fv(g.getUniformLocation(prog, 'uMats'), mats);
      g.uniform3fv(g.getUniformLocation(prog, 'uView'), viewDir(map.getBearing(), map.getPitch(), st.heading));
      g.uniform1f(g.getUniformLocation(prog, 'uNight'), night ? 1 : 0);
      g.bindBuffer(g.ARRAY_BUFFER, vbo);
      const aPos = g.getAttribLocation(prog, 'aPos');
      const aNor = g.getAttribLocation(prog, 'aNor');
      const aMat = g.getAttribLocation(prog, 'aMat');
      for (const [loc, n, off] of [[aPos, 3, 0], [aNor, 3, 12], [aMat, 1, 24]] as const) {
        g.enableVertexAttribArray(loc);
        g.vertexAttribPointer(loc, n, g.FLOAT, false, 28, off);
      }
      g.drawArrays(g.TRIANGLES, 0, count);
      for (const loc of [aPos, aNor, aMat]) g.disableVertexAttribArray(loc);
    },
    onRemove(_m, gl) {
      const g = gl as WebGLRenderingContext;
      if (vbo) g.deleteBuffer(vbo);
      if (sbo) g.deleteBuffer(sbo);
      if (prog) g.deleteProgram(prog);
      if (shadow) g.deleteProgram(shadow);
      if (glow) g.deleteProgram(glow);
      layer.renderedBounds = null;
      map = null;
    },
  };
  return layer;
}
