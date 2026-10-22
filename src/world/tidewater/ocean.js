// ===== 潮汐湾 · 海面 =====
// 便宜但好看的海面（不用 FFT / 不用后期反射）：
//   · 顶点着色器：4 组 Gerstner 波叠加（方向/波长/陡度各不同），近岸按水深压平避免浪尖穿沙；
//   · 片元着色器：水深 lerp 浅水翠绿 → 深水青蓝，极浅处透出沙色；菲涅尔反射天空色；
//     太阳镜面高光（窄光斑 + 宽反光）；近岸白沫带（水深 < ~2.6m）+ 浪峰白沫，泡沫用滚动噪声；
//   · 沙滩冲浪线：沿 MAP_EXTRAS.shoreline 采样点生成一条会"冲上来又退回去"的白沫带；
//   · 雾：手工实现与场景 FogExp2 完全一致的雾模型，保证海天线与天空/远景无缝；
//   · 低档：网格变稀、泡沫细节关闭、波幅略降。
//
// 地形高度用一张烘焙的高度图（tanh 压缩编码，近水线精度约 0.1m）在着色器里采样，
// 用于：水深着色 / 白沫带 / 岸上片元剔除。高度图完全由 shared/active.js 的 heightAt 生成。
import * as THREE from 'three';
import {
  WORLD, SUN, MAP_EXTRAS, heightAt as sharedHeightAt,
} from '../../../shared/active.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const TAU = Math.PI * 2;

// ---------- 高度图烘焙 ----------
// R：高度，tanh 压缩成 0..1（近水线精度 ~0.1m，白沫带/水线才准）
// G：到水线的最近距离 / SHORE_MAX（0..1）——沙滩很平（2°），只靠水深定白沫带会宽到 30m，
//    用"离水线多远"来控制冲浪白沫才准。
const HEIGHT_TANH = 14;
const SHORE_MAX = 40;
function bakeHeightMap(sample, half, size, seaLevel, shore) {
  const pad = 28;
  const span = (half + pad) * 2;
  const data = new Uint8Array(size * size * 4);
  const nShore = shore ? shore.length : 0;
  const far2 = SHORE_MAX * SHORE_MAX;
  let minH = Infinity, maxH = -Infinity;
  for (let j = 0; j < size; j++) {
    const z = -half - pad + ((j + 0.5) / size) * span;
    for (let i = 0; i < size; i++) {
      const x = -half - pad + ((i + 0.5) / size) * span;
      const h = sample(x, z) - seaLevel;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
      const t = clamp(0.5 + 0.5 * Math.tanh(h / HEIGHT_TANH), 0, 1);
      // 最近岸线采样点的距离（71 个点，够用且比逐像素求根便宜）
      let d2 = far2;
      for (let k = 0; k < nShore; k++) {
        const dx = x - shore[k].x;
        const dz = z - shore[k].z;
        const dd = dx * dx + dz * dz;
        if (dd < d2) d2 = dd;
      }
      const dist = Math.min(SHORE_MAX, Math.sqrt(d2));
      const k = (j * size + i) * 4;
      data[k] = Math.round(t * 255);
      data[k + 1] = Math.round((dist / SHORE_MAX) * 255);
      data[k + 2] = 0;
      data[k + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;   // 数据贴图，不能被当成 sRGB 颜色
  tex.needsUpdate = true;
  return {
    tex,
    rect: new THREE.Vector4(-half - pad, -half - pad, 1 / span, 1 / span),
    minH, maxH, size,
  };
}

// ---------- 泡沫噪声贴图（CPU 生成，可无缝平铺）----------
function makeFoamTexture(size = 128) {
  const data = new Uint8Array(size * size * 4);
  const hash = (ix, iy, seed) => {
    let h = (Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263) + Math.imul(seed | 0, 2246822519)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
  // 周期 value noise：整数坐标按 period 取模，保证四边无缝
  const pnoise = (x, y, period, seed) => {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const w = (a) => ((a % period) + period) % period;
    const a = hash(w(ix), w(iy), seed);
    const b = hash(w(ix + 1), w(iy), seed);
    const c = hash(w(ix), w(iy + 1), seed);
    const d = hash(w(ix + 1), w(iy + 1), seed);
    const ab = a + (b - a) * ux;
    const cd = c + (d - c) * ux;
    return ab + (cd - ab) * uy;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      // 三倍频叠加 + 脊状变换（1-|2n-1|）得到"泡沫丝/网眼"的观感
      let n = 0, amp = 0.55, per = 6;
      for (let o = 0; o < 4; o++) {
        n += pnoise(u * per, v * per, per, 101 + o * 37) * amp;
        amp *= 0.55;
        per *= 2;
      }
      const ridge = 1 - Math.abs(2 * n - 1);
      const fine = pnoise(u * 24, v * 24, 24, 909);
      let val = ridge * 0.72 + n * 0.28;
      val = val * 0.85 + fine * 0.15;
      val = Math.pow(clamp(val, 0, 1), 1.25);
      const k = (y * size + x) * 4;
      data[k] = Math.round(val * 255);
      data[k + 1] = Math.round(clamp(n * 1.15, 0, 1) * 255);
      data[k + 2] = Math.round(fine * 255);
      data[k + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ---------- 非均匀海面网格：近处密、远处稀（静态，不跟随相机）----------
function buildAxis(min, max, step, farDist, growth = 1.62, maxLayers = 14) {
  const n = Math.max(1, Math.round((max - min) / step));
  const arr = [];
  for (let i = 0; i <= n; i++) arr.push(min + (i / n) * (max - min));
  const left = [], right = [];
  let cur = (max - min) / n, sum = 0;
  while (sum < farDist && left.length < maxLayers) {
    cur *= growth;
    sum += cur;
    left.push(min - sum);
    right.push(max + sum);
  }
  return left.reverse().concat(arr, right);
}

// ---------- 岸线采样：优先用 MAP_EXTRAS.shoreline，缺失时按 heightAt 反解 ----------
function deriveShoreline(sample, half, extras) {
  const ex = extras || {};
  const src = ex.shoreline && Array.isArray(ex.shoreline.samples) ? ex.shoreline.samples : null;
  if (src && src.length >= 3) {
    const out = [];
    for (const s of src) {
      if (s && Number.isFinite(s.x) && Number.isFinite(s.z)) out.push({ x: s.x, z: s.z });
    }
    if (out.length >= 3) return out;
  }
  const out = [];
  for (let x = -half; x <= half; x += 4) {
    let prevZ = -half, prevH = sample(x, prevZ);
    let lo = null, hi = null;
    for (let z = -half + 2; z <= half; z += 2) {
      const h = sample(x, z);
      if (prevH > 0 && h <= 0) { lo = prevZ; hi = z; break; }
      prevZ = z; prevH = h;
    }
    if (lo == null) continue;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) * 0.5;
      if (sample(x, mid) > 0) lo = mid; else hi = mid;
    }
    out.push({ x, z: (lo + hi) * 0.5 });
  }
  return out;
}

// =====================================================================
// 海面着色器
// =====================================================================
const OCEAN_VERT = /* glsl */`
precision highp float;

uniform float uTime;
uniform float uSeaLevel;
uniform float uWaveAmp;
uniform sampler2D uHeightMap;
uniform vec4 uMapRect;        // x0, z0, 1/spanX, 1/spanZ

varying vec3 vWorld;
varying vec3 vNormal;
varying float vDepth;         // 水深（正 = 水面以下）
varying float vCrest;         // 归一化波峰高度

// tanh 压缩解码：t∈[0,1] → 高度
float decodeH(float t) {
  float x = clamp(t * 2.0 - 1.0, -0.9995, 0.9995);
  return 14.0 * 0.5 * log((1.0 + x) / (1.0 - x));
}

// x = 地形高度，y = 到水线的距离（m）
vec2 terrainInfo(vec2 xz) {
  vec2 uv = (xz - uMapRect.xy) * uMapRect.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec2(-60.0, 40.0);  // 地图外 = 深海
  vec4 t = texture2D(uHeightMap, uv);
  return vec2(decodeH(t.r) + uSeaLevel, t.g * 40.0);
}

// 单组 Gerstner 波：累加竖直位移 / 水平位移 / 高度梯度
void gerstner(vec2 p, float t, vec2 dir, float wl, float amp, float steep,
              inout vec3 disp, inout vec2 grad) {
  vec2 d = normalize(dir);
  float k = 6.2831853 / wl;
  float c = sqrt(9.81 / k);              // 深水相速度
  float f = k * (dot(d, p) - c * 0.62 * t);
  float s = sin(f);
  float co = cos(f);
  float a = amp * steep;
  disp.x += d.x * a * co;
  disp.z += d.y * a * co;
  disp.y += amp * s;
  grad += d * (amp * k * co);
}

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec2 p0 = wp.xz;

  float th0 = terrainInfo(p0).x;
  float depth0 = max(0.0, uSeaLevel - th0);
  // 近岸压平：水浅时波幅降到 22%，避免浪尖戳穿沙滩
  float shoreK = mix(0.22, 1.0, smoothstep(0.0, 7.0, depth0));
  float amp = uWaveAmp * shoreK;

  vec3 disp = vec3(0.0);
  vec2 grad = vec2(0.0);
  gerstner(p0, uTime, vec2(0.86, 0.51), 46.0, 0.40 * amp, 0.34, disp, grad);   // 长涌浪
  gerstner(p0, uTime, vec2(0.62, -0.78), 27.0, 0.24 * amp, 0.30, disp, grad);  // 斜向次浪
  gerstner(p0, uTime, vec2(-0.93, 0.36), 17.0, 0.14 * amp, 0.26, disp, grad);  // 短浪
  gerstner(p0, uTime, vec2(0.24, 0.97), 10.5, 0.07 * amp, 0.22, disp, grad);   // 细碎涟漪

  vec3 world = wp.xyz + disp;
  vWorld = world;
  vNormal = normalize(vec3(-grad.x, 1.0, -grad.y));
  vDepth = max(0.0, uSeaLevel - terrainInfo(world.xz).x);
  vCrest = clamp(disp.y / max(0.0001, amp * 0.82), -1.0, 1.0);

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const OCEAN_FRAG = /* glsl */`
precision highp float;

uniform float uTime;
uniform float uSeaLevel;
uniform float uFoamStrength;
uniform float uDetail;
uniform float uSpecPower;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform vec3 uSandColor;
uniform vec3 uFoamColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform sampler2D uFoamTex;
uniform sampler2D uHeightMap;
uniform vec4 uMapRect;

varying vec3 vWorld;
varying vec3 vNormal;
varying float vDepth;
varying float vCrest;

// tanh 压缩解码（与顶点着色器一致）
float decodeH(float t) {
  float x = clamp(t * 2.0 - 1.0, -0.9995, 0.9995);
  return 14.0 * 0.5 * log((1.0 + x) / (1.0 - x));
}
// x = 地形高度，y = 到水线的距离（m）
vec2 terrainInfo(vec2 xz) {
  vec2 uv = (xz - uMapRect.xy) * uMapRect.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec2(-60.0, 40.0);
  vec4 t = texture2D(uHeightMap, uv);
  return vec2(decodeH(t.r) + uSeaLevel, t.g * 40.0);
}

void main() {
  // 岸上（地形高于海面）不画水：用高度图精确切出水线，避免水面盖住干沙滩
  vec2 ti = terrainInfo(vWorld.xz);
  float th = ti.x;
  float shoreDist = ti.y;
  if (th > 0.22) discard;
  // 1 = 水下，0 = 岸上（水线处整体淡出）
  float waterMask = 1.0 - smoothstep(-0.18, 0.18, th);

  vec3 N = normalize(vNormal);

  // ---- 细节法线：三层正弦扰动（比法线贴图便宜，远处自动被雾吃掉）----
  vec2 rp = vWorld.xz;
  float t = uTime;
  vec2 dn = vec2(
    sin(rp.x * 0.72 + t * 1.9) + sin(rp.x * 1.63 - rp.y * 0.51 + t * 2.7) * 0.6
      + sin(rp.y * 2.9 + t * 3.1) * 0.35,
    sin(rp.y * 0.68 - t * 1.7) + sin(rp.y * 1.51 + rp.x * 0.43 - t * 2.3) * 0.6
      + sin(rp.x * 3.1 - t * 2.9) * 0.35
  ) * (0.072 * uDetail);
  N = normalize(N + vec3(dn.x, 0.0, dn.y));

  vec3 V = normalize(cameraPosition - vWorld);
  float depth = max(0.0, vDepth);

  // ---- 水体颜色：极浅透沙色 → 浅水翠绿 → 深水青蓝 ----
  vec3 body = mix(uShallowColor, uDeepColor, smoothstep(0.4, 16.0, depth));
  body = mix(uSandColor, body, smoothstep(0.0, 2.6, depth));

  // ---- 菲涅尔：掠射角反射天空 ----
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
  fres = 0.02 + 0.98 * fres;
  vec3 R = reflect(-V, N);
  vec3 skyCol = mix(uSkyHorizon, uSkyZenith, clamp(R.y * 1.7, 0.0, 1.0));
  vec3 col = mix(body, skyCol, fres * 0.9);

  // ---- 太阳：窄镜面光斑（碎光）+ 宽反光 ----
  vec3 Hv = normalize(uSunDir + V);
  float nh = max(dot(N, Hv), 0.0);
  col += uSunColor * pow(nh, uSpecPower) * 2.4;
  col += uSunColor * pow(nh, 18.0) * 0.10;

  // ---- 白沫：近岸带（水深）+ 浪峰，泡沫用两层滚动噪声 ----
  vec2 fuv = vWorld.xz * 0.12;
  float f1 = texture2D(uFoamTex, fuv + vec2(t * 0.010, t * 0.006)).r;
  float f2 = texture2D(uFoamTex, fuv * 2.3 - vec2(t * 0.016, -t * 0.012)).r;
  float lace = f1 * 0.62 + f2 * 0.48;
  // 冲浪白沫按"离水线的距离"控制（沙滩很平，只按水深会铺出 30m 宽的白带）
  float shoreBand = 1.0 - smoothstep(1.0, 7.5, shoreDist);
  float foam = smoothstep(0.42, 0.92, shoreBand * (0.35 + lace * 1.15)) * uFoamStrength;
  foam += smoothstep(0.74, 1.0, vCrest) * 0.18 * smoothstep(0.3, 0.75, lace)
        * smoothstep(1.5, 6.0, depth);
  foam = clamp(foam, 0.0, 1.0) * waterMask;
  col = mix(col, uFoamColor, foam);

  // ---- 雾：与场景 FogExp2 同模型（1 - exp(-(d·density)²)）----
  float dist = length(cameraPosition - vWorld);
  float fogF = 1.0 - exp(-(dist * uFogDensity) * (dist * uFogDensity));
  col = mix(col, uFogColor, fogF);

  // ---- 透明度：浅水透出沙底，深水不透明；白沫不透明；水线处整体淡出 ----
  float alpha = mix(0.42, 0.97, smoothstep(0.0, 5.0, depth));
  alpha = max(alpha, foam);
  alpha *= waterMask;
  alpha = mix(alpha, 1.0, fogF * 0.85);

  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// =====================================================================
// 沙滩冲浪线（沿岸线的一条会涌动的白沫带）
// =====================================================================
const SURF_VERT = /* glsl */`
precision highp float;
uniform float uTime;
uniform float uSweep;
attribute vec2 aDir;      // 朝海方向（xz）
attribute float aPhase;   // 沿岸相位（每列不同，形成推进的浪）
attribute float aAcross;  // 横向位置 0..1（0=岸上, 1=海里）
varying float vAcross;
varying float vPhase;
varying vec2 vWorldXZ;

void main() {
  vec3 p = position;
  // 冲上来又退回去：整体沿岸线朝海/朝岸往复
  float w = sin(uTime * 0.62 + aPhase) * 0.5 + 0.5;
  p.xz += aDir * ((w - 0.35) * uSweep);
  vAcross = aAcross;
  vPhase = aPhase;
  vWorldXZ = p.xz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const SURF_FRAG = /* glsl */`
precision highp float;
uniform float uTime;
uniform float uOpacity;
uniform sampler2D uFoamTex;
uniform vec3 uFoamColor;
varying float vAcross;
varying float vPhase;
varying vec2 vWorldXZ;

void main() {
  // 横断面上的白沫带：中间最亮，两侧淡出
  float band = smoothstep(0.04, 0.46, vAcross) * (1.0 - smoothstep(0.48, 0.88, vAcross));
  // 沿岸推进的浪头：相位差形成一条条涌上的浪
  float pulse = 0.45 + 0.55 * sin(uTime * 1.15 + vPhase * 3.1);
  float n = texture2D(uFoamTex, vWorldXZ * 0.11 + vec2(uTime * 0.012, uTime * 0.008)).r;
  float n2 = texture2D(uFoamTex, vWorldXZ * 0.29 - vec2(uTime * 0.02, -uTime * 0.013)).r;
  float lace = n * 0.6 + n2 * 0.5;
  float a = band * (0.35 + lace * 1.25) * (0.45 + pulse * 0.75) * uOpacity;
  gl_FragColor = vec4(uFoamColor, clamp(a, 0.0, 0.92));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------- 画质档 → 海面参数（网格密度 / 高度图分辨率 / 泡沫细节）----------
function tierOf(p) {
  const seg = (p && p.terrainSegments) || 176;
  const q = seg >= 160 ? 'ultra' : seg >= 140 ? 'high' : seg >= 120 ? 'medium' : 'low';
  return {
    quality: q,
    mapSize: q === 'ultra' ? 384 : q === 'high' ? 320 : q === 'medium' ? 256 : 192,
    denseStep: q === 'low' ? 7.5 : q === 'medium' ? 5.6 : q === 'high' ? 4.5 : 3.6,
    detail: q === 'low' ? 0.45 : q === 'medium' ? 0.75 : 1,
    foam: q === 'low' ? 0.85 : q === 'medium' ? 0.95 : 1,
    amp: q === 'low' ? 0.75 : q === 'medium' ? 0.9 : 1,
    spec: q === 'low' ? 120 : q === 'medium' ? 180 : 240,
    surfOpacity: q === 'low' ? 0.35 : q === 'medium' ? 0.4 : 0.45,
    sweep: q === 'low' ? 1.2 : 2.0,
    foamSize: q === 'low' ? 64 : 128,
  };
}

// =====================================================================
// 主入口
// =====================================================================
export function createOcean({ preset, anisotropy = 1, extras, heightAt } = {}) {
  const p = preset || {};
  const ex = extras || MAP_EXTRAS || {};
  const sample = typeof heightAt === 'function' ? heightAt : sharedHeightAt;
  const H = (x, z) => {
    const h = typeof sample === 'function' ? sample(x, z) : 0;
    return Number.isFinite(h) ? h : 0;
  };
  const half = WORLD.half;
  const seaLevel = Number.isFinite(ex.seaLevel) ? ex.seaLevel : 0;
  const tier = tierOf(p);
  const quality = tier.quality;

  const group = new THREE.Group();
  group.name = 'ocean';
  const disposables = [];

  // ---------- 1) 岸线（优先用 MAP_EXTRAS.shoreline 的真实水线采样）----------
  const shoreline = deriveShoreline(H, half, ex);

  // ---------- 2) 高度图（高度 + 到水线距离，供水深着色 / 白沫带 / 岸上剔除）----------
  const mapSize = tier.mapSize;
  const baked = bakeHeightMap(H, half, mapSize, seaLevel, shoreline);
  disposables.push(baked.tex);

  // ---------- 3) 泡沫噪声 ----------
  const foamTex = makeFoamTexture(tier.foamSize);
  disposables.push(foamTex);

  // ---------- 4) 海面网格 ----------
  const denseStep = tier.denseStep;
  const xAxis = buildAxis(-half - 60, half + 60, denseStep, 1350);
  const zAxis = buildAxis(-half * 0.45, half + 130, denseStep, 1350);
  const nx = xAxis.length, nz = zAxis.length;
  const verts = nx * nz;
  const positions = new Float32Array(verts * 3);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = (j * nx + i) * 3;
      positions[k] = xAxis[i];
      positions[k + 1] = 0;
      positions[k + 2] = zAxis[j];
    }
  }
  const index = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let t = 0;
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      index[t++] = a; index[t++] = c; index[t++] = b;
      index[t++] = b; index[t++] = c; index[t++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeBoundingSphere();
  disposables.push(geo);

  // ---------- 4) 太阳 / 天空 / 雾（全部来自 shared 的 SUN）----------
  const sunDir = new THREE.Vector3(
    (SUN && SUN.dir && SUN.dir[0]) || -0.30,
    (SUN && SUN.dir && SUN.dir[1]) || 0.86,
    (SUN && SUN.dir && SUN.dir[2]) || 0.41
  ).normalize();
  const fogFar = (SUN && SUN.fogFar) || 700;
  const fogDensity = Math.sqrt(2.3) / Math.max(40, fogFar);   // 与 lighting.js 的 FogExp2 换算一致

  const uniforms = {
    uTime: { value: 0 },
    uSeaLevel: { value: seaLevel },
    uWaveAmp: { value: tier.amp },
    uHeightMap: { value: baked.tex },
    uMapRect: { value: baked.rect },
    uFoamTex: { value: foamTex },
    uFoamStrength: { value: tier.foam },
    uDetail: { value: tier.detail },
    uSpecPower: { value: tier.spec },
    uSunDir: { value: sunDir },
    uSunColor: { value: new THREE.Color((SUN && SUN.color) || 0xfff2dd) },
    uSkyZenith: { value: new THREE.Color(0x4c80b8) },
    uSkyHorizon: { value: new THREE.Color(0xc6d7e4) },
    uDeepColor: { value: new THREE.Color(0x0b4a66) },
    uShallowColor: { value: new THREE.Color(0x27a99b) },
    uSandColor: { value: new THREE.Color(0x79bfa4) },
    uFoamColor: { value: new THREE.Color(0xeaf6f2) },
    uFogColor: { value: new THREE.Color((SUN && SUN.fogColor) || 0xbcd6dd) },
    uFogDensity: { value: fogDensity },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: OCEAN_VERT,
    fragmentShader: OCEAN_FRAG,
    transparent: true,
    depthWrite: true,
    depthTest: true,
    side: THREE.DoubleSide,
    fog: false,
  });
  disposables.push(material);

  const water = new THREE.Mesh(geo, material);
  water.name = 'oceanSurface';
  water.position.y = seaLevel;
  water.frustumCulled = false;
  water.renderOrder = 1;
  water.matrixAutoUpdate = false;
  water.updateMatrix();
  group.add(water);

  // ---------- 6) 沙滩冲浪线 ----------
  let surf = null;
  if (shoreline.length >= 3) {
    const ROWS = 4;         // 横断排数
    const WIDTH = 3.2;      // 冲浪带宽度（m）
    const n = shoreline.length;
    const pos = new Float32Array(n * ROWS * 3);
    const dirs = new Float32Array(n * ROWS * 2);
    const phases = new Float32Array(n * ROWS);
    const across = new Float32Array(n * ROWS);
    for (let i = 0; i < n; i++) {
      const s = shoreline[i];
      // 朝海方向 = 地形下坡方向（梯度反方向）
      const eps = 1.5;
      const hx = H(s.x + eps, s.z) - H(s.x - eps, s.z);
      const hz = H(s.x, s.z + eps) - H(s.x, s.z - eps);
      let dx = -hx, dz = -hz;
      let l = Math.hypot(dx, dz);
      if (l < 1e-4) { dx = 0; dz = 1; l = 1; }   // 平坦处默认朝 +z（南侧是海）
      dx /= l; dz /= l;
      const phase = s.x * 0.055 + s.z * 0.031;
      for (let r = 0; r < ROWS; r++) {
        const v = r / (ROWS - 1);                 // 0=岸上 1=海里
        const off = (v - 0.42) * WIDTH;
        const px = s.x + dx * off;
        const pz = s.z + dz * off;
        const k = (i * ROWS + r);
        pos[k * 3] = px;
        pos[k * 3 + 1] = H(px, pz) + 0.07;        // 贴着沙面，稍抬避免 z-fighting
        pos[k * 3 + 2] = pz;
        dirs[k * 2] = dx;
        dirs[k * 2 + 1] = dz;
        phases[k] = phase;
        across[k] = v;
      }
    }
    const idx = [];
    for (let i = 0; i < n - 1; i++) {
      for (let r = 0; r < ROWS - 1; r++) {
        const a = i * ROWS + r, b = a + 1, c = a + ROWS, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const sgeo = new THREE.BufferGeometry();
    sgeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    sgeo.setAttribute('aDir', new THREE.BufferAttribute(dirs, 2));
    sgeo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    sgeo.setAttribute('aAcross', new THREE.BufferAttribute(across, 1));
    sgeo.setIndex(idx);
    sgeo.computeBoundingSphere();
    disposables.push(sgeo);

    const surfUniforms = {
      uTime: uniforms.uTime,
      uSweep: { value: tier.sweep },
      uOpacity: { value: tier.surfOpacity },
      uFoamTex: { value: foamTex },
      uFoamColor: { value: new THREE.Color(0xf2fbf7) },
    };
    const surfMat = new THREE.ShaderMaterial({
      uniforms: surfUniforms,
      vertexShader: SURF_VERT,
      fragmentShader: SURF_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      fog: false,
    });
    disposables.push(surfMat);
    surf = new THREE.Mesh(sgeo, surfMat);
    surf.name = 'oceanSurfLine';
    surf.frustumCulled = false;
    surf.renderOrder = 2;
    surf.matrixAutoUpdate = false;
    surf.updateMatrix();
    group.add(surf);
  }

  // ---------- 6) 逐帧 ----------
  let time = 0;
  function update(dt) {
    const step = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0.016;
    time += step;
    uniforms.uTime.value = time;
  }

  // 只改着色器强度参数；网格密度/高度图分辨率变化需要重建（装配层负责重建）
  function setQuality(next) {
    const t = tierOf(next || {});
    uniforms.uDetail.value = t.detail;
    uniforms.uFoamStrength.value = t.foam;
    uniforms.uWaveAmp.value = t.amp;
    uniforms.uSpecPower.value = t.spec;
  }

  function dispose() {
    group.remove(...group.children);
    if (group.parent) group.parent.remove(group);
    for (const d of disposables) if (d && d.dispose) d.dispose();
  }

  const triangles = index.length / 3;
  return {
    group,
    water,
    surf,
    material,
    uniforms,
    shoreline,
    raycastTargets: [],     // 水面不参与射线（子弹入水不做判定）
    heightMap: baked.tex,
    update,
    setQuality,
    dispose,
    triangleCount: () => triangles,
    stats: () => ({
      drawCalls: group.children.length,
      triangles: triangles + (surf ? surf.geometry.index.count / 3 : 0),
      grid: nx + 'x' + nz,
      heightMap: baked.size,
      quality,
      shorelineSamples: shoreline.length,
      heightRange: [Number(baked.minH.toFixed(2)), Number(baked.maxH.toFixed(2))],
    }),
  };
}

export default createOcean;
