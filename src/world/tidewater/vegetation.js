// ===== 潮汐湾 · 植被 =====
// 全部程序化几何 + InstancedMesh，顶点着色器风摆（共享一套 wind uniform）：
//   · 棕榈 PALM：弯曲锥形树干（带环纹明暗）+ 羽状叶冠（9 片带中脉折角的叶片）
//   · 阔叶树 BROADLEAF：圆柱树干 + 三团错开的树冠（兼容旧数据的 pine/oak）
//   · 灌木 BUSH：两团压扁的球
//   · 沙丘草 DUNE GRASS：交叉面片草簇（视觉装饰，无碰撞），按沙地/沙滩高度带确定性散布
// 布局数据全部来自 shared/active.js 的 TREES（不自己造树位）；沙丘草用固定种子采样，
// 与静态碰撞体避让，禁止 Math.random 参与布局。
import * as THREE from 'three';
import {
  WORLD, TREES, MAP_EXTRAS, COLLIDERS,
  heightAt as sharedHeightAt, surfaceAt, terrainNormal, valueNoise, mulberry32,
} from '../../../shared/active.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// 共享数据安全包装（高度采样器可由调用方注入，自测用）
function makeSampler(fn) {
  return (x, z) => {
    const h = typeof fn === 'function' ? fn(x, z) : 0;
    return Number.isFinite(h) ? h : 0;
  };
}
const NOISE = typeof valueNoise === 'function' ? valueNoise : () => 0.5;
const SURFACE = typeof surfaceAt === 'function' ? surfaceAt : () => 'grass';
const NORMAL = typeof terrainNormal === 'function' ? terrainNormal : () => ({ x: 0, y: 1, z: 0 });
const COLLIDER_LIST = Array.isArray(COLLIDERS) ? COLLIDERS : [];
// mulberry32 兜底（地图数据未导出时仍能确定性散布）
const RNG = typeof mulberry32 === 'function' ? mulberry32 : (seed) => {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// ---------- 风摆 uniform（所有植被材质共享同一份对象，update 只改一次）----------
function makeWindUniforms() {
  return {
    uTime: { value: 0 },
    uGust: { value: 1 },
    uPlayer: { value: new THREE.Vector3(0, 0, 0) },
    uWindDir: { value: new THREE.Vector2(0.82, 0.57).normalize() },
    uFadeStart: { value: 30 },
    uFadeEnd: { value: 52 },
  };
}

const GLSL_BLADE_PROJECT = /* glsl */`
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  vec3 instPos = instanceMatrix[3].xyz;
  float instDist = length(cameraPosition.xz - instPos.xz);
  float lod = 1.0 - smoothstep(uFadeStart, uFadeEnd, instDist);
  mvPosition.xz *= lod;                        // 远处收缩到根部（不渲染细叶）
  float hgt = clamp(position.y * uHeightInv, 0.0, 1.0);
  float phase = instPos.x * 0.41 + instPos.z * 0.33;
  float breeze = sin(uTime * 1.35 + phase) * 0.085 + sin(uTime * 2.61 + phase * 1.7) * 0.045;
  vec2 windOff = uWindDir * (breeze * hgt * hgt * uAmp * uGust);
  // 玩家经过时把草压开
  vec2 toP = instPos.xz - uPlayer.xz;
  float pd = max(length(toP), 0.0001);
  float push = 1.0 - clamp(pd / 2.4, 0.0, 1.0);
  push = push * push * 0.5;
  windOff += (toP / pd) * (push * hgt * hgt);
  mvPosition = instanceMatrix * mvPosition;
  mvPosition.xyz += vec3(windOff.x, 0.0, windOff.y);
#endif
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;
`;

const GLSL_CANOPY_PROJECT = /* glsl */`
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  vec3 instPos = instanceMatrix[3].xyz;
  float hgt = clamp(position.y * uHeightInv, 0.0, 1.0);
  float phase = instPos.x * 0.083 + instPos.z * 0.067;
  float breeze = sin(uTime * 0.82 + phase) * 0.6 + sin(uTime * 1.57 + phase * 0.8) * 0.25;
  mvPosition = instanceMatrix * mvPosition;
  mvPosition.xyz += vec3(uWindDir.x, 0.0, uWindDir.y) * (breeze * hgt * hgt * uAmp * uGust * 0.35);
#endif
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;
`;

// 给标准材质注入风摆顶点位移（不改 three 的光照/雾/阴影代码）
// upNormal：双面叶片/草叶强制用"朝上"的法线受光。
// 否则背面片元的法线会被 three 翻转成朝下，整片叶子发黑（草叶、棕榈羽叶必须开）。
function injectWind(material, wind, { mode = 'blade', amp = 1, heightInv = 1, key = '', upNormal = false } = {}) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = wind.uTime;
    shader.uniforms.uGust = wind.uGust;
    shader.uniforms.uPlayer = wind.uPlayer;
    shader.uniforms.uWindDir = wind.uWindDir;
    shader.uniforms.uFadeStart = wind.uFadeStart;
    shader.uniforms.uFadeEnd = wind.uFadeEnd;
    shader.uniforms.uAmp = { value: amp };
    shader.uniforms.uHeightInv = { value: heightInv };
    shader.vertexShader = 'uniform float uTime;\nuniform float uGust;\nuniform vec3 uPlayer;\n' +
      'uniform vec2 uWindDir;\nuniform float uFadeStart;\nuniform float uFadeEnd;\n' +
      'uniform float uAmp;\nuniform float uHeightInv;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      mode === 'blade' ? GLSL_BLADE_PROJECT : GLSL_CANOPY_PROJECT
    );
    if (upNormal) {
      // normal_fragment_begin 里已声明 normal，这里覆盖掉背面翻转
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        '#include <normal_fragment_begin>\n  normal = normalize( vNormal );'
      );
    }
  };
  material.customProgramCacheKey = () => 'tidewind_' + mode + '_' + key;
}

// ================= 几何生成 =================
// 棕榈树干：沿二次曲线弯曲的锥形管，顶点色做环纹明暗
function makePalmTrunkGeometry(height = 8.4) {
  const RINGS = 10, RAD = 7;
  const bendX = 0.20 * height;
  const pos = [], nor = [], col = [], idx = [];
  for (let r = 0; r <= RINGS; r++) {
    const t = r / RINGS;
    const y = t * height;
    const bx = bendX * t * t;
    // 底部粗、向上收细，并带轻微起伏（棕榈的环状叶痕）
    const radius = 0.34 * (1 - t * 0.66) + 0.03 + 0.012 * Math.sin(t * 26.0);
    for (let a = 0; a <= RAD; a++) {
      const ang = (a / RAD) * Math.PI * 2;
      const cx = Math.cos(ang), cz = Math.sin(ang);
      pos.push(cx * radius + bx, y, cz * radius);
      nor.push(cx, 0.18, cz);
      const shade = 0.66 + t * 0.3 + 0.07 * Math.sin(t * 34.0);
      col.push(shade, shade * 0.94, shade * 0.84);
    }
  }
  const rowLen = RAD + 1;
  for (let r = 0; r < RINGS; r++) {
    for (let a = 0; a < RAD; a++) {
      const p0 = r * rowLen + a, p1 = p0 + 1;
      const q0 = p0 + rowLen, q1 = q0 + 1;
      idx.push(p0, q0, p1, p1, q0, q1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

// 棕榈叶冠：每片叶是一条带中脉折角的锥形带（左/中/右三列顶点），先上扬再下垂
function makePalmCrownGeometry({ height = 8.4, fronds = 11, seg = 5, len = 4.6, width = 0.62 } = {}) {
  const bendX = 0.20 * height;
  const pos = [], nor = [], col = [], idx = [];
  for (let f = 0; f < fronds; f++) {
    const yaw = (f / fronds) * Math.PI * 2 + (f % 2) * 0.29;
    const droop = 0.55 + 0.55 * ((f * 0.37) % 1);
    const dirX = Math.cos(yaw), dirZ = Math.sin(yaw);
    const px = -dirZ, pz = dirX;                     // 叶片横向
    const base = pos.length / 3;
    for (let s = 0; s <= seg; s++) {
      const t = s / seg;
      const along = t * len;
      // 叶轴：中段上扬、末端下垂
      const up = Math.sin(t * Math.PI * 0.72) * 1.15 - droop * t * t * 1.6;
      const w = width * Math.sin(Math.min(1, t * 1.32) * Math.PI) * (1 - t * 0.2) + 0.025;
      const cx = bendX + dirX * along;
      const cz = dirZ * along;
      const cy = height + up;
      // 中脉略抬 → 叶片有 V 形折角，受光有层次
      const fold = w * 0.34;
      const shadeTip = 0.72 + t * 0.5;
      const shadeEdge = shadeTip * 0.82;
      // 左
      pos.push(cx + px * w, cy, cz + pz * w);
      nor.push(0.0, 1.0, 0.0);
      col.push(shadeEdge, shadeEdge * 1.06, shadeEdge * 0.72);
      // 中（略高）
      pos.push(cx, cy + fold, cz);
      nor.push(0.0, 1.0, 0.0);
      col.push(shadeTip * 0.94, shadeTip * 1.02, shadeTip * 0.66);
      // 右
      pos.push(cx - px * w, cy, cz - pz * w);
      nor.push(0.0, 1.0, 0.0);
      col.push(shadeEdge, shadeEdge * 1.06, shadeEdge * 0.72);
    }
    for (let s = 0; s < seg; s++) {
      const a = base + s * 3, b = a + 1, c = a + 2;
      const d = base + (s + 1) * 3, e = d + 1, f2 = d + 2;
      idx.push(a, d, b, b, d, e);
      idx.push(b, e, c, c, e, f2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();          // 叶面朝向不一致，用面法线更自然
  geo.computeBoundingSphere();
  return geo;
}

// 树干（单位圆柱，底部在 y=0）
function makeTrunkGeometry() {
  const g = new THREE.CylinderGeometry(0.16, 0.26, 1, 7, 1, false);
  g.translate(0, 0.5, 0);
  return g;
}

// 简易几何合并（保留 position/normal，烘焙纵向明暗到顶点色）
function mergeShaded(geos) {
  const posArr = [], norArr = [], colArr = [];
  let minY = Infinity, maxY = -Infinity;
  for (const g of geos) {
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const span = Math.max(0.001, maxY - minY);
  for (const g of geos) {
    const p = g.getAttribute('position');
    const nAttr = g.getAttribute('normal');
    const index = g.getIndex();
    const emit = (vi) => {
      const y = p.getY(vi);
      const t = (y - minY) / span;
      const shade = 0.62 + t * 0.5;
      posArr.push(p.getX(vi), y, p.getZ(vi));
      norArr.push(nAttr.getX(vi), nAttr.getY(vi), nAttr.getZ(vi));
      colArr.push(shade, shade, shade);
    };
    if (index) for (let i = 0; i < index.count; i++) emit(index.getX(i));
    else for (let i = 0; i < p.count; i++) emit(i);
    g.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(norArr, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colArr, 3));
  geo.computeBoundingSphere();
  return geo;
}

// 阔叶树冠：三团错开的球（单位米）
function makeBroadleafCanopyGeometry() {
  const parts = [];
  const specs = [
    { x: 0, y: 4.1, z: 0, r: 2.25, sx: 1.18, sy: 0.88, sz: 1.06 },
    { x: 1.4, y: 3.6, z: 0.55, r: 1.55, sx: 1, sy: 0.82, sz: 1 },
    { x: -1.25, y: 4.7, z: -0.6, r: 1.45, sx: 1, sy: 0.9, sz: 1 },
  ];
  for (const s of specs) {
    const g = new THREE.IcosahedronGeometry(s.r, 1);
    g.scale(s.sx, s.sy, s.sz);
    g.translate(s.x, s.y, s.z);
    parts.push(g);
  }
  return mergeShaded(parts);
}

// 灌木：两团压扁的球
function makeBushGeometry() {
  const parts = [];
  const g1 = new THREE.IcosahedronGeometry(0.78, 1);
  g1.scale(1.12, 0.74, 1.0);
  g1.translate(0, 0.5, 0);
  parts.push(g1);
  const g2 = new THREE.IcosahedronGeometry(0.56, 0);
  g2.scale(1.0, 0.8, 1.0);
  g2.translate(0.62, 0.4, 0.18);
  parts.push(g2);
  return mergeShaded(parts);
}

// 沙丘草簇：4 片交叉的锥形条带（8 个三角形）
function makeDuneGrassGeometry(height = 0.8) {
  const pos = [], nor = [], col = [], idx = [];
  const BLADES = 4;
  for (let b = 0; b < BLADES; b++) {
    const ang = (b / BLADES) * Math.PI + 0.35;
    const dx = Math.cos(ang), dz = Math.sin(ang);
    const px = -dz * 0.16, pz = dx * 0.16;
    const base = pos.length / 3;
    const hh = height * (0.7 + 0.3 * ((b * 0.41) % 1));
    const lean = 0.18;
    // 两个三角形组成一片草叶（底宽顶窄）
    pos.push(-px, 0, -pz); nor.push(0, 1, 0); col.push(0.72, 0.76, 0.5);
    pos.push(px, 0, pz); nor.push(0, 1, 0); col.push(0.72, 0.76, 0.5);
    pos.push(dx * lean, hh, dz * lean); nor.push(0, 1, 0); col.push(1.0, 0.98, 0.7);
    idx.push(base, base + 1, base + 2);
    // 第二片（错开 90°，让草簇有体积）
    const ang2 = ang + Math.PI * 0.5;
    const ex = Math.cos(ang2) * 0.14, ez = Math.sin(ang2) * 0.14;
    pos.push(-ex, 0, -ez); nor.push(0, 1, 0); col.push(0.68, 0.72, 0.46);
    pos.push(ex, 0, ez); nor.push(0, 1, 0); col.push(0.68, 0.72, 0.46);
    pos.push(dx * lean * 0.8, hh * 0.85, dz * lean * 0.8); nor.push(0, 1, 0); col.push(0.94, 0.92, 0.66);
    idx.push(base + 3, base + 4, base + 5);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

// 是否压在静态碰撞体上（树/草避让；粗判即可）
function makeBlocker() {
  const res = 2;
  const N = Math.ceil(WORLD.size / res) + 2;
  const grid = new Uint8Array(N * N);
  for (const o of COLLIDER_LIST) {
    if (!o || o.kind === 'boundary') continue;
    const i0 = Math.floor((o.x - o.w / 2 + WORLD.half) / res);
    const i1 = Math.floor((o.x + o.w / 2 + WORLD.half) / res);
    const j0 = Math.floor((o.z - o.d / 2 + WORLD.half) / res);
    const j1 = Math.floor((o.z + o.d / 2 + WORLD.half) / res);
    for (let j = Math.max(0, j0); j <= Math.min(N - 1, j1); j++) {
      for (let i = Math.max(0, i0); i <= Math.min(N - 1, i1); i++) grid[j * N + i] = 1;
    }
  }
  return (x, z) => {
    const i = Math.floor((x + WORLD.half) / res);
    const j = Math.floor((z + WORLD.half) / res);
    if (i < 0 || j < 0 || i >= N || j >= N) return true;
    return grid[j * N + i] === 1;
  };
}

// ================= 主入口 =================
// trees / heightAt 可选：自测时注入合成布局与高度场（正式运行不传，用 shared/active.js）
export function createVegetation({ preset, anisotropy = 1, extras, trees, heightAt } = {}) {
  const p = preset || {};
  const ex = extras || MAP_EXTRAS || {};
  const H = makeSampler(typeof heightAt === 'function' ? heightAt : sharedHeightAt);
  const half = WORLD.half;
  const group = new THREE.Group();
  group.name = 'vegetation';
  const disposables = [];
  const wind = makeWindUniforms();
  wind.uFadeStart.value = (p.grassFade && p.grassFade[0]) || 30;
  wind.uFadeEnd.value = (p.grassFade && p.grassFade[1]) || 52;

  // ---------- 布局数据分类（TREES 由 map-data 提供，客户端不自己造树位）----------
  const source = Array.isArray(trees) ? trees : (Array.isArray(TREES) ? TREES : []);
  const treeList = source.filter((t) => t && Number.isFinite(t.x) && Number.isFinite(t.z));
  const palms = [], broadleaf = [], bushes = [], duneEntries = [];
  for (const t of treeList) {
    const type = String(t.type || '').toLowerCase();
    if (type === 'palm') palms.push(t);
    else if (type === 'bush' || type === 'shrub') bushes.push(t);
    else if (type === 'dunegrass' || type === 'dune' || type === 'dunegrass0') duneEntries.push(t);
    else broadleaf.push(t);      // broadleaf / oak / pine / 未知类型 → 阔叶树
  }

  const treeY = (t) => (Number.isFinite(t.y) ? t.y : H(t.x, t.z));
  const treeScale = (t) => (Number.isFinite(t.scale) && t.scale > 0.1 ? t.scale : 1);

  // ---------- 材质 ----------
  const barkMat = new THREE.MeshLambertMaterial({ color: 0x9a8265, vertexColors: true, dithering: true });
  // 棕榈羽叶是单层面片：双面渲染 + 朝上法线，从下面看也不会发黑
  const leafMat = new THREE.MeshLambertMaterial({
    color: 0xffffff, vertexColors: true, dithering: true, side: THREE.DoubleSide,
  });
  injectWind(leafMat, wind, { mode: 'canopy', amp: 0.3, heightInv: 1 / 10, key: 'palm', upNormal: true });
  const broadLeafMat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, dithering: true });
  injectWind(broadLeafMat, wind, { mode: 'canopy', amp: 0.32, heightInv: 1 / 9, key: 'broad' });
  const bushMat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, dithering: true });
  injectWind(bushMat, wind, { mode: 'canopy', amp: 0.12, heightInv: 1 / 1.5, key: 'bush' });
  const duneMat = new THREE.MeshLambertMaterial({
    vertexColors: true, side: THREE.DoubleSide, dithering: true,
  });
  injectWind(duneMat, wind, { mode: 'blade', amp: 1.15, heightInv: 1 / 0.8, key: 'dune', upNormal: true });
  disposables.push(barkMat, leafMat, broadLeafMat, bushMat, duneMat);

  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3();
  const _c = new THREE.Color();
  const _c2 = new THREE.Color();
  const treeMeshes = [];

  function makeInstanced(geo, mat, list, name, fill, castShadow) {
    if (!list.length) return null;
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    mesh.name = name;
    mesh.castShadow = !!castShadow;
    mesh.receiveShadow = true;
    for (let i = 0; i < list.length; i++) fill(mesh, list[i], i);
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
    disposables.push(mesh);
    treeMeshes.push(mesh);
    return mesh;
  }

  // ---------- 棕榈 ----------
  const PALM_H = 8.4;
  const palmTrunkGeo = makePalmTrunkGeometry(PALM_H);
  const palmCrownGeo = makePalmCrownGeometry({ height: PALM_H });
  disposables.push(palmTrunkGeo, palmCrownGeo);
  const palmTrunks = makeInstanced(palmTrunkGeo, barkMat, palms, 'palmTrunks', (mesh, t, i) => {
    const sc = treeScale(t);
    _p.set(t.x, treeY(t) - 0.12, t.z);
    _e.set(0, t.rot || 0, 0);
    _q.setFromEuler(_e);
    _s.set(sc, sc * (0.92 + 0.16 * ((t.scale || 1) % 0.4)), sc);
    _m.compose(_p, _q, _s);
    mesh.setMatrixAt(i, _m);
  }, !!p.treeShadows);
  makeInstanced(palmCrownGeo, leafMat, palms, 'palmCrowns', (mesh, t, i) => {
    const sc = treeScale(t);
    _p.set(t.x, treeY(t) - 0.12, t.z);
    _e.set(0, t.rot || 0, 0);
    _q.setFromEuler(_e);
    _s.set(sc, sc, sc);
    _m.compose(_p, _q, _s);
    mesh.setMatrixAt(i, _m);
    // 叶色差异：偏黄绿 ↔ 深绿（sRGB → 线性，乘到顶点色上）
    const v = clamp(((t.rot || 0) * 0.159) % 1, 0, 1);
    _c.set(0xa9c25c).lerp(_c2.set(0x79a04a), v);
    mesh.setColorAt(i, _c);
  }, !!p.treeShadows);

  // ---------- 阔叶树 ----------
  const trunkGeo = makeTrunkGeometry();
  const broadCanopyGeo = makeBroadleafCanopyGeometry();
  disposables.push(trunkGeo, broadCanopyGeo);
  makeInstanced(trunkGeo, barkMat, broadleaf, 'treeTrunks', (mesh, t, i) => {
    const sc = treeScale(t);
    _p.set(t.x, treeY(t) - 0.15, t.z);
    _e.set(0, t.rot || 0, 0);
    _q.setFromEuler(_e);
    _s.set(sc * 1.25, sc * 3.6, sc * 1.25);
    _m.compose(_p, _q, _s);
    mesh.setMatrixAt(i, _m);
  }, !!p.treeShadows);
  makeInstanced(broadCanopyGeo, broadLeafMat, broadleaf, 'treeCanopies', (mesh, t, i) => {
    const sc = treeScale(t);
    _p.set(t.x, treeY(t) - 0.15, t.z);
    _e.set(0, t.rot || 0, 0);
    _q.setFromEuler(_e);
    _s.set(sc, sc, sc);
    _m.compose(_p, _q, _s);
    mesh.setMatrixAt(i, _m);
    const v = clamp(((t.rot || 0) * 0.213) % 1, 0, 1);
    _c.set(0x6f8a44).lerp(_c2.set(0x93a95c), v);
    mesh.setColorAt(i, _c);
  }, !!p.treeShadows);

  // ---------- 灌木 ----------
  const bushGeo = makeBushGeometry();
  disposables.push(bushGeo);
  const bushLimit = Math.max(1, Math.floor(bushes.length * (p.bushes != null ? p.bushes : 1)));
  const bushMesh = makeInstanced(bushGeo, bushMat, bushes.slice(0, bushLimit), 'bushes', (mesh, t, i) => {
    const sc = treeScale(t);
    _p.set(t.x, treeY(t) - 0.06, t.z);
    _e.set(0, t.rot || 0, 0);
    _q.setFromEuler(_e);
    _s.set(sc * 1.1, sc * 0.95, sc * 1.1);
    _m.compose(_p, _q, _s);
    mesh.setMatrixAt(i, _m);
    const v = clamp(((t.rot || 0) * 0.271) % 1, 0, 1);
    _c.set(0x4a6434).lerp(_c2.set(0x6f8845), v);
    mesh.setColorAt(i, _c);
  }, !!p.treeShadows);

  // ---------- 沙丘草（视觉装饰，无碰撞）----------
  // 优先用 TREES 里的 'dunegrass' 布点（map-data 提供，纯视觉无碰撞体）；
  // 数据里没有时按"沙滩高度带 + 固定种子"确定性散布兜底（禁止 Math.random 参与布局）。
  const duneGeo = makeDuneGrassGeometry(0.8);
  disposables.push(duneGeo);
  const blocked = makeBlocker();
  const duneRand = RNG(20261022);
  const duneDensity = clamp(0.25 + (p.grassDensity != null ? p.grassDensity : 0.45), 0, 1);
  const dunePlacements = [];
  if (duneEntries.length) {
    for (const t of duneEntries) {
      dunePlacements.push({
        x: t.x, y: treeY(t), z: t.z,
        scale: treeScale(t) * 0.95,
        yaw: Number.isFinite(t.rot) ? t.rot : 0,
      });
    }
  } else {
    const duneCap = Math.round(4200 * duneDensity);
    const STEP = 2.2;
    for (let z = -half + 2; z < half - 2; z += STEP) {
      for (let x = -half + 2; x < half - 2; x += STEP) {
        if (dunePlacements.length >= duneCap) break;
        const jx = x + (duneRand() - 0.5) * STEP * 0.9;
        const jz = z + (duneRand() - 0.5) * STEP * 0.9;
        const h = H(jx, jz);
        if (h < 0.55 || h > 5.2) continue;
        const surf = SURFACE(jx, jz);
        const isSand = surf === 'sand' || surf === 'dune' || surf === 'beach';
        // 高度带兜底：贴海面的低洼沙地也算（数据里没有 'sand' 时仍能长草）
        if (!isSand && h > 3.4) continue;
        if (blocked(jx, jz)) continue;
        const n = NORMAL(jx, jz);
        if (1 - (n.y || 1) > 0.42) continue;               // 陡坡不长草
        const patch = 0.45 + NOISE(jx * 0.11 + 3.7, jz * 0.11 - 8.2) * 0.5;
        if (duneRand() > patch) continue;
        dunePlacements.push({ x: jx, y: h, z: jz, scale: 0.65 + duneRand() * 0.8, yaw: duneRand() * Math.PI * 2 });
      }
    }
  }
  const duneMesh = makeInstanced(duneGeo, duneMat, dunePlacements, 'duneGrass', (mesh, g, i) => {
    _p.set(g.x, g.y - 0.04, g.z);
    _e.set(0, g.yaw, 0);
    _q.setFromEuler(_e);
    _s.set(g.scale, g.scale * (0.85 + 0.35 * (g.yaw % 0.4)), g.scale);
    _m.compose(_p, _q, _s);
    mesh.setMatrixAt(i, _m);
    _c.set(0x9fae62).lerp(_c2.set(0xc9c07e), clamp((g.scale - 0.6) / 0.8, 0, 1));
    mesh.setColorAt(i, _c);
  }, false);
  if (duneMesh) duneMesh.frustumCulled = false;

  // ---------- 逐帧 ----------
  let time = 0;
  function update(dt, ctx) {
    const step = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0.016;
    time += step;
    wind.uTime.value = time;
    // 阵风：低频起伏（纯视觉，不参与布局确定性）
    wind.uGust.value = 0.72 + 0.24 * Math.sin(time * 0.23) + 0.12 * Math.sin(time * 0.61 + 1.3);
    let px = null, py = 0, pz = 0;
    if (ctx && Number.isFinite(ctx.x)) { px = ctx.x; py = ctx.y || 0; pz = ctx.z; }        // Vector3
    else if (ctx && ctx.playerPos && Number.isFinite(ctx.playerPos.x)) {
      px = ctx.playerPos.x; py = ctx.playerPos.y || 0; pz = ctx.playerPos.z;
    } else if (ctx && ctx.camera && ctx.camera.position) {
      px = ctx.camera.position.x; pz = ctx.camera.position.z;
    }
    if (px != null) wind.uPlayer.value.set(px, py, pz);
  }

  function setQuality(next) {
    const np = next || {};
    wind.uFadeStart.value = (np.grassFade && np.grassFade[0]) || 30;
    wind.uFadeEnd.value = (np.grassFade && np.grassFade[1]) || 52;
    const shadows = !!np.treeShadows;
    for (const m of treeMeshes) m.castShadow = shadows;
    if (bushMesh) {
      const n = Math.max(1, Math.floor(bushes.length * (np.bushes != null ? np.bushes : 1)));
      bushMesh.count = Math.min(n, bushMesh.instanceMatrix.count);
    }
    if (duneMesh) {
      const dens = clamp(0.25 + (np.grassDensity != null ? np.grassDensity : 0.45), 0, 1);
      duneMesh.count = Math.max(0, Math.min(dunePlacements.length, Math.round(dunePlacements.length * (dens / duneDensity))));
    }
  }

  function dispose() {
    if (group.parent) group.parent.remove(group);
    for (const d of disposables) if (d && d.dispose) d.dispose();
  }

  // 首帧按当前档位设置数量（灌木比例 / 沙丘草密度）
  setQuality(p);

  const stats = () => {
    let tris = 0, draws = 0;
    for (const m of group.children) {
      if (!m.isInstancedMesh) continue;
      draws++;
      const idx = m.geometry.index;
      const per = idx ? idx.count / 3 : m.geometry.getAttribute('position').count / 3;
      tris += per * m.count;
    }
    return {
      drawCalls: draws,
      triangles: Math.round(tris),
      palms: palms.length,
      broadleaf: broadleaf.length,
      bushes: bushes.length,
      duneGrass: dunePlacements.length,
    };
  };

  return {
    group,
    wind,
    palms,
    broadleaf,
    bushes,
    dunePlacements,
    treeMeshes,
    update,
    setQuality,
    dispose,
    raycastTargets: [],
    stats,
  };
}

export default createVegetation;
