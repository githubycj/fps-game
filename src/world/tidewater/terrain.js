// ===== 潮汐湾 · 海岛地形 =====
// 依据 shared/active.js 的 heightAt 采样生成海岛网格（纯函数，与碰撞/物理逐位一致）：
//   · 内圈：可玩区 WORLD.size × WORLD.size，按画质档分段（默认 176 段 ≈ 1.8m/格），
//     切成 4×4 分块做视锥剔除，法线由高度场中心差分求出（分块边界逐位一致，无光照接缝）。
//   · 外圈：地图外的远景地形。南侧（+z）是海，海床继续下沉被海面遮住；
//     其余三面岛体延续并抬升，收住地平线。
//   · 顶点色分层：湿沙 / 干沙 / 沙丘草 / 草地 / 岩石 / 海床；水线附近压深做湿沙带，
//     水下随深度压暗偏青（水体本身的颜色由 ocean.js 负责）。
// 本模块不复制任何地图常量，高度/表面类型全部来自 shared/active.js。
import * as THREE from 'three';
import {
  WORLD, MAP_EXTRAS, heightAt as sharedHeightAt, terrainNormal as sharedTerrainNormal,
  surfaceAt, valueNoise,
} from '../../../shared/active.js';
import { makeGroundNormalTexture, makeGroundDetailTexture } from '../textures.js';

// ---------- 小工具（避免依赖其它模块的私有实现）----------
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
// sRGB 十六进制 → 线性工作空间（顶点色在线性空间参与光照）
function lin(hex) { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; }
function mix3(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// 共享数据的安全包装：地图数据未就绪/异常时退化为有限值，保证场景不崩
function makeSampler(fn) {
  return (x, z) => {
    const h = typeof fn === 'function' ? fn(x, z) : 0;
    return Number.isFinite(h) ? h : 0;
  };
}
const NOISE = typeof valueNoise === 'function' ? valueNoise : () => 0.5;
const SURFACE = typeof surfaceAt === 'function' ? surfaceAt : () => 'grass';

// ---------- 调色板（热带海岛：暖白沙 / 橄榄草 / 灰岩 / 青墨海床）----------
const PAL = {
  sandDry: lin(0xd8c295),      // 干沙（日照下偏暖亮；热带强光下不能再亮，否则过曝发白）
  sandWet: lin(0x9d8660),      // 湿沙（贴水线，更深更饱和）
  sandShell: lin(0xe8dfc6),    // 碎贝壳 / 珊瑚屑
  bedShallow: lin(0xc0b08a),   // 浅水海床（仍透出沙色）
  bedDeep: lin(0x46564f),      // 深水海床（墨绿）
  bedAlgae: lin(0x55663f),     // 礁盘藻类
  bedTint: lin(0x2c5a60),      // 深水偏青的压暗色
  grassA: lin(0x6c7f41),       // 海岸草（黄绿）
  grassB: lin(0x8b954f),
  grassDry: lin(0xa99c60),     // 枯黄草
  grassDark: lin(0x49592e),
  rock: lin(0x8b8478),         // 灰岩 / 海蚀崖
  rockDark: lin(0x625c53),
  dirt: lin(0xa89272),         // 村广场夯土
  dirtDark: lin(0x84725a),
};

// 每个顶点的颜色：高度分层 + 坡度露岩 + 噪声斑块 + surfaceAt 提示（村路/沙滩）
const _rgb = [0, 0, 0];
function computeColor(x, z, h, slope, out) {
  const n1 = NOISE(x * 0.028 + 11.3, z * 0.028 - 7.7);   // 大尺度色块
  const n2 = NOISE(x * 0.11 - 3.1, z * 0.11 + 5.9);      // 中尺度
  const n3 = NOISE(x * 0.47 + 8.6, z * 0.47 - 4.2);      // 细节
  const n4 = NOISE(x * 1.9 - 2.4, z * 1.9 + 9.1);        // 高频（碎石/泡沫）

  // ---- 沙：干沙 ↔ 湿沙（越贴水线越深）----
  let sand = mix3(PAL.sandDry, PAL.sandWet, smoothstep(1.6, 0.02, h));
  sand = mix3(sand, PAL.sandShell, Math.max(0, n3 - 0.62) * 0.7);

  // ---- 海床：浅水仍是亮沙，深处转墨绿 ----
  const depth = Math.max(0, -h);
  let bed = mix3(PAL.bedShallow, PAL.bedDeep, smoothstep(0.3, 18, depth));
  bed = mix3(bed, PAL.bedAlgae, Math.max(0, n2 - 0.48) * 0.6 * smoothstep(0.8, 6, depth));

  // ---- 草地 ----
  let grass = mix3(PAL.grassA, PAL.grassB, n1);
  grass = mix3(grass, PAL.grassDry, n2 * 0.5);
  grass = mix3(grass, PAL.grassDark, Math.max(0, n3 - 0.6) * 0.9);

  // ---- 岩石 ----
  const rock = mix3(PAL.rock, PAL.rockDark, n3 * 0.6 + n4 * 0.3);
  // ---- 夯土 / 碎石 ----
  const dirt = mix3(PAL.dirt, PAL.dirtDark, n3 * 0.5 + n4 * 0.4);

  // ---- 高度分层：海床 → 湿沙 → 干沙 → 草地（用噪声扰动边界，避免等高线感）----
  let col;
  if (h < 0) col = mix3(bed, sand, smoothstep(-0.06, -1.8, h));
  else col = mix3(sand, grass, smoothstep(2.0, 5.4, h + (n1 - 0.5) * 1.8));

  // ---- 坡度露岩（陡坡 / 海蚀崖 / 山脊）+ 高处偏岩 ----
  let rockMix = smoothstep(0.26, 0.6, slope) * 0.92;
  rockMix = Math.min(1, rockMix + smoothstep(0.55, 0.82, slope) * 0.2);
  rockMix = Math.max(rockMix, smoothstep(26, 52, h + (n1 - 0.5) * 8) * 0.55);
  if (rockMix > 0.002) col = mix3(col, rock, rockMix);

  // ---- surfaceAt 提示：村广场夯土 / 指定沙滩 / 岩面（5 点抖动采样做自然毛边）----
  if (h > 0.35) {
    let wDirt = 0, wSand = 0, wRock = 0;
    const jx = (NOISE(x * 0.8 + 21.7, z * 0.8 - 13.1) - 0.5) * 1.4;
    const jz = (NOISE(x * 0.8 - 9.3, z * 0.8 + 17.9) - 0.5) * 1.4;
    const OFF = [[0, 0], [0.9, 0.5], [-0.8, 0.6], [0.4, -0.9], [-0.6, -0.7]];
    for (let i = 0; i < OFF.length; i++) {
      const s = SURFACE(x + OFF[i][0] + jx, z + OFF[i][1] + jz);
      if (s === 'dirt' || s === 'road') wDirt++;
      else if (s === 'sand') wSand++;
      else if (s === 'rock') wRock++;
    }
    const inv = 1 / OFF.length;
    const fade = smoothstep(0.35, 1.2, h);    // 水线附近不做人工地面
    if (wDirt > 0) col = mix3(col, dirt, wDirt * inv * fade);
    if (wSand > 0) col = mix3(col, sand, wSand * inv * fade);
    if (wRock > 0) col = mix3(col, rock, wRock * inv * fade);
  }

  // ---- 水下压暗偏青：海床不要过亮，否则透过水面会"发白" ----
  if (depth > 0.2) col = mix3(col, PAL.bedTint, smoothstep(0.6, 14, depth) * 0.42);

  // ---- 细节明暗（大面积单色最容易显假）----
  const shade = 0.9 + n3 * 0.14 + n4 * 0.04;
  out[0] = col[0] * shade;
  out[1] = col[1] * shade;
  out[2] = col[2] * shade;
  return out;
}

// 地图外远景地形高度：南侧（+z）延续海床沉入水下，其余三面抬升收住地平线
function farHeight(x, z, half, sample) {
  if (Math.abs(x) <= half && Math.abs(z) <= half) return sample(x, z);
  const cx = clamp(x, -half, half);
  const cz = clamp(z, -half, half);
  const base = sample(cx, cz);
  const dOut = Math.max(Math.abs(x) - half, Math.abs(z) - half);
  if (z > half) {
    // 南侧是大海：海床继续下潜（会被海面遮住，只需保证不露出水面）
    const d = z - half;
    let h = base - d * 0.26;
    h += (NOISE(x * 0.02 + 3.1, z * 0.02 - 8.4) * 2 - 1) * 3.2 * smoothstep(0, 40, d);
    return Math.max(-80, h);
  }
  // 北 / 东 / 西：岛体延续 + 缓坡抬升 + 远景丘陵噪声
  let h = base + 30 * Math.pow(clamp(dOut / 150, 0, 1), 1.5);
  h += (NOISE(x * 0.0115 + 5.1, z * 0.0115 - 3.7) * 2 - 1) * 11 * smoothstep(0, 55, dOut);
  h += (NOISE(x * 0.03 - 7.3, z * 0.03 + 1.9) * 2 - 1) * 2.4 * smoothstep(0, 22, dOut);
  return h;
}

// 外圈远景采样距离（地图边界外的米数）：由近到远的稀疏层
const OUTER_DIST = [6, 15, 27, 43, 64, 92, 128, 172, 226, 290];

// 高度场网格步长（shared 的 heightAt 是 1.25m 网格 + 双线性插值）。
// 地形网格顶点间距必须是它的整数倍，否则会跨插值单元采样 → 细小的三角形走样。
const HEIGHT_CELL = 1.25;
function snapSegments(want) {
  const size = WORLD.size || WORLD.half * 2;
  const maxSeg = Math.round(size / HEIGHT_CELL);      // 320 / 1.25 = 256
  let best = maxSeg;
  let bestDiff = Infinity;
  for (const d of [1, 2, 4, 8, 16]) {
    const seg = Math.round(maxSeg / d);
    if (seg < 48) break;
    const diff = Math.abs(seg - want);
    if (diff < bestDiff) { bestDiff = diff; best = seg; }
  }
  return best;
}

// heightAt 可选：自测时注入合成高度场（正式运行不传，用 shared/active.js 的 heightAt）
export function createTerrain({ preset, anisotropy = 1, extras, heightAt } = {}) {
  const p = preset || {};
  const ex = extras || MAP_EXTRAS || {};
  const H = makeSampler(typeof heightAt === 'function' ? heightAt : sharedHeightAt);
  const half = WORLD.half;
  const segments = snapSegments(Math.max(48, Math.min(256, p.terrainSegments || 176)));
  const step = (half * 2) / segments;
  const N = segments + 1;
  const NORMAL_FN = typeof sharedTerrainNormal === 'function' ? sharedTerrainNormal : null;

  const disposables = [];
  const group = new THREE.Group();
  group.name = 'terrain';

  // ---------- 材质：顶点色 + 程序化细节贴图 + 法线 ----------
  const normalTex = makeGroundNormalTexture(anisotropy);
  const detailTex = makeGroundDetailTexture(anisotropy);
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    map: detailTex || null,
    roughness: 0.94,
    metalness: 0.0,
    normalMap: normalTex || null,
    normalScale: new THREE.Vector2(0.35, 0.35),
    dithering: true,
    envMapIntensity: 0.55,
  });
  if (normalTex) disposables.push(normalTex);
  if (detailTex) disposables.push(detailTex);
  disposables.push(material);

  // ================= 一、高度场缓存（全图一次采样，分块共享）=================
  const heights = new Float32Array(N * N);
  const colors = new Float32Array(N * N * 3);
  const normals = new Float32Array(N * N * 3);
  for (let j = 0; j < N; j++) {
    const z = -half + j * step;
    for (let i = 0; i < N; i++) {
      heights[j * N + i] = H(-half + i * step, z);
    }
  }
  // 法线：优先用地图的解析地形法线（与物理/命中一致且平滑），缺失时退化为高度场中心差分
  for (let j = 0; j < N; j++) {
    const z = -half + j * step;
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      let nx, ny, nz;
      if (NORMAL_FN) {
        const n = NORMAL_FN(-half + i * step, z);
        nx = n && Number.isFinite(n.x) ? n.x : 0;
        ny = n && Number.isFinite(n.y) ? n.y : 1;
        nz = n && Number.isFinite(n.z) ? n.z : 0;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
      } else {
        const iL = i > 0 ? i - 1 : i;
        const iR = i < segments ? i + 1 : i;
        const jU = j > 0 ? j - 1 : j;
        const jD = j < segments ? j + 1 : j;
        const dx = (iR - iL) * step || step;
        const dz = (jD - jU) * step || step;
        const dhdx = (heights[j * N + iR] - heights[j * N + iL]) / dx;
        const dhdz = (heights[jD * N + i] - heights[jU * N + i]) / dz;
        nx = -dhdx; ny = 1; nz = -dhdz;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
      }
      normals[k * 3] = nx;
      normals[k * 3 + 1] = ny;
      normals[k * 3 + 2] = nz;
      const slope = clamp(1 - ny, 0, 1);
      computeColor(-half + i * step, z, heights[k], slope, _rgb);
      colors[k * 3] = _rgb[0];
      colors[k * 3 + 1] = _rgb[1];
      colors[k * 3 + 2] = _rgb[2];
    }
  }

  // ================= 二、内圈：4×4 分块（视锥剔除）=================
  const CHUNK = 4;
  const chunkSeg = Math.ceil(segments / CHUNK);
  const innerMeshes = [];
  let innerTriangles = 0;
  for (let cj = 0; cj < CHUNK; cj++) {
    for (let ci = 0; ci < CHUNK; ci++) {
      const i0 = ci * chunkSeg;
      const j0 = cj * chunkSeg;
      const i1 = Math.min(segments, i0 + chunkSeg);
      const j1 = Math.min(segments, j0 + chunkSeg);
      const w = i1 - i0, h = j1 - j0;
      if (w <= 0 || h <= 0) continue;
      const vn = (w + 1) * (h + 1);
      const positions = new Float32Array(vn * 3);
      const cols = new Float32Array(vn * 3);
      const norms = new Float32Array(vn * 3);
      const uvs = new Float32Array(vn * 2);
      for (let jj = 0; jj <= h; jj++) {
        const gz = j0 + jj;
        for (let ii = 0; ii <= w; ii++) {
          const gx = i0 + ii;
          const gk = gz * N + gx;
          const k = jj * (w + 1) + ii;
          const idx = k * 3;
          positions[idx] = -half + gx * step;
          positions[idx + 1] = heights[gk];
          positions[idx + 2] = -half + gz * step;
          cols[idx] = colors[gk * 3];
          cols[idx + 1] = colors[gk * 3 + 1];
          cols[idx + 2] = colors[gk * 3 + 2];
          norms[idx] = normals[gk * 3];
          norms[idx + 1] = normals[gk * 3 + 1];
          norms[idx + 2] = normals[gk * 3 + 2];
          const uv = k * 2;
          // 贴图尺度放大到 5m/tile：沙滩上细节纹理的斜向条纹不会变成"灯芯绒"
          uvs[uv] = positions[idx] / 5.0;
          uvs[uv + 1] = positions[idx + 2] / 5.0;
        }
      }
      const index = new Uint32Array(w * h * 6);
      let t = 0;
      for (let jj = 0; jj < h; jj++) {
        for (let ii = 0; ii < w; ii++) {
          const a = jj * (w + 1) + ii;
          const b = a + 1;
          const c = a + (w + 1);
          const d = c + 1;
          index[t++] = a; index[t++] = c; index[t++] = b;
          index[t++] = b; index[t++] = c; index[t++] = d;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(norms, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      geo.setIndex(new THREE.BufferAttribute(index, 1));
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
      disposables.push(geo);
      const mesh = new THREE.Mesh(geo, material);
      mesh.name = 'tideTerrainChunk_' + ci + '_' + cj;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      innerMeshes.push(mesh);
      group.add(mesh);
      innerTriangles += w * h * 2;
    }
  }

  // ================= 三、外圈：远景地形（内圈挖空，与内圈共享边界顶点）=================
  const layers = Math.max(3, Math.min(OUTER_DIST.length, p.outerMilestones || 7));
  const outerD = OUTER_DIST.slice(0, layers);
  const negAxis = outerD.map((d) => -half - d).reverse();
  const posAxis = outerD.map((d) => half + d);
  const innerAxis = [];
  for (let i = 0; i <= segments; i++) innerAxis.push(-half + i * step);
  const axis = negAxis.concat(innerAxis, posAxis);
  const m = axis.length;
  const off = negAxis.length;
  const oPos = new Float32Array(m * m * 3);
  const oCol = new Float32Array(m * m * 3);
  const oUv = new Float32Array(m * m * 2);
  for (let j = 0; j < m; j++) {
    const z = axis[j];
    for (let i = 0; i < m; i++) {
      const x = axis[i];
      const idx = (j * m + i) * 3;
      const h = farHeight(x, z, half, H);
      oPos[idx] = x;
      oPos[idx + 1] = h;
      oPos[idx + 2] = z;
      // 坡度用有限差分（外圈顶点稀疏，直接用 farHeight 采样即可）
      const d = Math.max(step, 1);
      const hx = farHeight(x + d, z, half, H) - farHeight(x - d, z, half, H);
      const hz = farHeight(x, z + d, half, H) - farHeight(x, z - d, half, H);
      const inv = 1 / Math.hypot(-hx / (2 * d), 1, -hz / (2 * d));
      computeColor(x, z, h, clamp(1 - inv, 0, 1), _rgb);
      // 远景压暗一点点，和主区域区分（雾会进一步融合）
      oCol[idx] = _rgb[0] * 0.95;
      oCol[idx + 1] = _rgb[1] * 0.96;
      oCol[idx + 2] = _rgb[2] * 0.98;
      const uv = (j * m + i) * 2;
      oUv[uv] = x / 5.0;
      oUv[uv + 1] = z / 5.0;
    }
  }
  const oIndex = [];
  for (let j = 0; j < m - 1; j++) {
    for (let i = 0; i < m - 1; i++) {
      const innerCell = i >= off && i < off + segments && j >= off && j < off + segments;
      if (innerCell) continue;
      const a = j * m + i, b = a + 1, c = a + m, d = c + 1;
      oIndex.push(a, c, b, b, c, d);
    }
  }
  const outerGeo = new THREE.BufferGeometry();
  outerGeo.setAttribute('position', new THREE.BufferAttribute(oPos, 3));
  outerGeo.setAttribute('color', new THREE.BufferAttribute(oCol, 3));
  outerGeo.setAttribute('uv', new THREE.BufferAttribute(oUv, 2));
  outerGeo.setIndex(oIndex);
  outerGeo.computeVertexNormals();
  outerGeo.computeBoundingSphere();
  disposables.push(outerGeo);
  const outerMesh = new THREE.Mesh(outerGeo, material);
  outerMesh.name = 'tideTerrainOuter';
  outerMesh.receiveShadow = false;
  outerMesh.castShadow = false;
  outerMesh.matrixAutoUpdate = false;
  outerMesh.updateMatrix();
  group.add(outerMesh);

  const outerTriangles = oIndex.length / 3;

  // ---------- 对外接口 ----------
  let currentPreset = p;
  function setQuality(next) {
    currentPreset = next || currentPreset;
    const shadows = !!(currentPreset && currentPreset.shadows);
    for (const mesh of innerMeshes) mesh.receiveShadow = shadows;
  }
  // 地形是静态的：update 只保留接口（Lead 的装配层会统一调用）
  function update() { /* 静态地形，无需逐帧更新 */ }

  function dispose() {
    group.remove(...innerMeshes, outerMesh);
    if (group.parent) group.parent.remove(group);
    for (const d of disposables) if (d && d.dispose) d.dispose();
  }

  return {
    group,
    material,
    innerMeshes,
    outerMesh,
    raycastTargets: innerMeshes,
    update,
    setQuality,
    dispose,
    triangleCount: () => innerTriangles + outerTriangles,
    stats: () => ({
      drawCalls: innerMeshes.length + 1,
      triangles: innerTriangles + outerTriangles,
      segments,
      half,
      seaLevel: Number.isFinite(ex.seaLevel) ? ex.seaLevel : 0,
    }),
  };
}

export default createTerrain;
