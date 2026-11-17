/* 3D-машинка как пользовательский WebGL-слой MapLibre: несколько сотен треугольников, один проход, без библиотек.
   Размер постоянный в пикселях экрана (как в навигаторах), курс — от севера по часовой, наклон и поворот карты — от MapLibre. */
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
varying vec3 vNor; varying float vMat; varying float vZ;
void main(){ vNor = aNor; vMat = aMat; vZ = aPos.z; gl_Position = uMvp * vec4(aPos, 1.0); }`;

const FS = `
precision mediump float;
varying vec3 vNor; varying float vMat; varying float vZ;
uniform vec3 uBody; uniform vec4 uMats[7];
void main(){
  vec3 n = normalize(vNor);
  int m = int(vMat + 0.5);
  vec4 mc = uMats[0];
  for (int i = 1; i < 7; i++) if (i == m) mc = uMats[i];
  vec3 base = m == 0 ? uBody : mc.rgb;
  if (mc.a > 0.5) { gl_FragColor = vec4(base, 1.0); return; }
  // Свет в координатах модели: сзади-сверху-слева — машинка одинаково читается при любом курсе.
  vec3 L = normalize(vec3(-0.35, -0.45, 0.82));
  vec3 H = normalize(L + normalize(vec3(0.0, -0.6, 0.8)));
  float diff = max(dot(n, L), 0.0);
  float gloss = (m == 0 || m == 1) ? 1.0 : 0.25;
  float spec = pow(max(dot(n, H), 0.0), 28.0) * 0.35 * gloss;
  // Затенение снизу (у порогов темнее) — объём без дорогих эффектов.
  float ao = mix(0.62, 1.0, smoothstep(0.3, 1.2, vZ));
  vec3 col = base * (0.36 + 0.7 * diff) * ao + spec;
  // Стёкла: отражение неба сверху.
  if (m == 1) col += vec3(0.16, 0.2, 0.26) * max(n.z, 0.0);
  gl_FragColor = vec4(col, 1.0);
}`;

const SHADOW_VS = `
attribute vec2 aUv; uniform mat4 uMvp; varying vec2 vUv;
void main(){ vUv = aUv; gl_Position = uMvp * vec4(aUv.x * 1.55, aUv.y * 2.95, 0.02, 1.0); }`;
const SHADOW_FS = `
precision mediump float; varying vec2 vUv; uniform float uAlpha;
void main(){ float d = length(vUv); gl_FragColor = vec4(0.0, 0.0, 0.0, uAlpha * (1.0 - smoothstep(0.25, 1.0, d))); }`;

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

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export interface Car3dLayer extends CustomLayerInterface {
  /** Ошибка WebGL — вызывающий переключается на плоскую машинку. */
  failed: boolean;
}

export function createCar3dLayer(get: () => Car3dState | null, opts: { model?: CarModelId; sizePx?: () => number; onError?: (e: unknown) => void } = {}): Car3dLayer {
  const mesh: CarMesh = CAR_MODELS[opts.model ?? 'suv'].build();
  const count = mesh.positions.length / 3;
  let map: MlMap | null = null;
  let prog: WebGLProgram | null = null;
  let shadow: WebGLProgram | null = null;
  let vbo: WebGLBuffer | null = null;
  let sbo: WebGLBuffer | null = null;
  const mats = new Float32Array(Object.keys(MAT_COLOR).flatMap((k) => MAT_COLOR[Number(k)]));

  const layer: Car3dLayer = {
    id: 'car-3d',
    type: 'custom',
    renderingMode: '3d',
    failed: false,
    onAdd(m, gl) {
      map = m;
      try {
        const g = gl as WebGLRenderingContext;
        prog = compile(g, VS, FS);
        shadow = compile(g, SHADOW_VS, SHADOW_FS);
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
      const sizePx = opts.sizePx?.() ?? 60;
      // Постоянный размер на экране: длина модели = sizePx пикселей.
      const k = (sizePx * metersPerPixel(st.lat, map.getZoom())) / mesh.length;
      const unit = mc.meterInMercatorCoordinateUnits() * k;
      // mainMatrix переводит координаты Меркатора 0…1 в экранные (для проекции Меркатора).
      const main = (args.defaultProjectionData?.mainMatrix ?? args.modelViewProjectionMatrix) as unknown as ArrayLike<number>;
      const mvp = mul4(main, modelMatrix(mc.x, mc.y, st.heading, unit));

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
      // Кузов
      g.disable(g.BLEND);
      g.enable(g.DEPTH_TEST);
      g.depthFunc(g.LEQUAL);
      g.depthMask(true);
      g.useProgram(prog);
      g.uniformMatrix4fv(g.getUniformLocation(prog, 'uMvp'), false, mvp);
      g.uniform3fv(g.getUniformLocation(prog, 'uBody'), st.color);
      g.uniform4fv(g.getUniformLocation(prog, 'uMats'), mats);
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
      map = null;
    },
  };
  return layer;
}
