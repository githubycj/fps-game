// ===== 武器视图模型（程序化拼装，第一人称与第三人称共用）=====
// 局部约定：握把位于原点，枪口朝 -Z，上为 +Y。

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const geoCache = new Map();
const matCache = new Map();

function boxGeo(w, h, d) {
  const key = `b${w}|${h}|${d}`;
  let g = geoCache.get(key);
  if (!g) { g = new THREE.BoxGeometry(w, h, d); geoCache.set(key, g); }
  return g;
}
function cylGeo(r, len, seg = 10) {
  const key = `c${r}|${len}|${seg}`;
  let g = geoCache.get(key);
  if (!g) { g = new THREE.CylinderGeometry(r, r, len, seg); geoCache.set(key, g); }
  return g;
}

function std(color, roughness = 0.5, metalness = 0.4, emissive = 0, emissiveIntensity = 0) {
  const key = `s${color}|${roughness}|${metalness}|${emissive}|${emissiveIntensity}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness, metalness, emissive, emissiveIntensity });
    matCache.set(key, m);
  }
  return m;
}
function basic(color) {
  const key = `g${color}`;
  let m = matCache.get(key);
  if (!m) { m = new THREE.MeshBasicMaterial({ color }); matCache.set(key, m); }
  return m;
}

const MAT = {
  metal: () => std(0x39404f, 0.35, 0.78),
  dark: () => std(0x22262f, 0.55, 0.5),
  poly: () => std(0x4d5464, 0.7, 0.2),
  wood: () => std(0x8a6a3a, 0.75, 0.05),
  glass: () => std(0x8fd8ff, 0.1, 0.6, 0x2a6a90, 0.8),
};

// 构建器：在 group 上拼装盒子/圆柱
function makeBuilder(g) {
  const box = (w, h, d, x, y, z, mat = MAT.metal(), rx = 0, rz = 0) => {
    const o = new THREE.Mesh(boxGeo(w, h, d), mat);
    o.position.set(x, y, z);
    if (rx) o.rotation.x = rx;
    if (rz) o.rotation.z = rz;
    g.add(o);
    return o;
  };
  const cyl = (r, len, x, y, z, mat = MAT.metal(), seg = 10) => {
    const o = new THREE.Mesh(cylGeo(r, len, seg), mat);
    o.rotation.x = Math.PI / 2;
    o.position.set(x, y, z);
    g.add(o);
    return o;
  };
  return { box, cyl };
}

// ---------- 各武器 ----------
function buildPistol(g, accent) {
  const { box, cyl } = makeBuilder(g);
  const dark = MAT.dark(), poly = MAT.poly(), metal = MAT.metal();
  box(0.075, 0.085, 0.42, 0, 0.045, -0.32, metal);                 // 套筒
  for (let i = 0; i < 4; i++) box(0.078, 0.05, 0.012, 0, 0.045, -0.14 - i * 0.028, dark); // 套筒齿纹
  box(0.07, 0.07, 0.34, 0, -0.045, -0.28, poly);                   // 枪身
  cyl(0.022, 0.18, 0, 0.04, -0.56);                                // 枪管
  cyl(0.026, 0.05, 0, 0.04, -0.65, dark);                          // 枪口
  box(0.012, 0.03, 0.02, 0, 0.098, -0.5, dark);                    // 准星
  box(0.014, 0.026, 0.014, -0.024, 0.096, -0.14, dark);            // 照门
  box(0.014, 0.026, 0.014, 0.024, 0.096, -0.14, dark);
  box(0.052, 0.012, 0.1, 0, -0.082, -0.27, dark);                  // 扳机护圈
  box(0.012, 0.032, 0.012, 0, -0.055, -0.26, dark);                // 扳机
  box(0.055, 0.16, 0.08, 0, -0.14, -0.2, poly, 0.28);              // 握把
  box(0.058, 0.1, 0.05, 0, -0.15, -0.19, dark, 0.28);              // 握把贴片
  box(0.05, 0.03, 0.07, 0, -0.225, -0.185, dark);                  // 弹匣底板
  box(0.012, 0.014, 0.06, 0.04, -0.02, -0.18, dark);               // 滑套释放
  box(0.05, 0.02, 0.1, 0, -0.075, -0.45, dark);                    // 下导轨
  box(0.014, 0.014, 0.014, 0, 0.05, -0.56, basic(accent));         // 光纤准心
  return new THREE.Vector3(0, 0.04, -0.68);
}

function buildSmg(g, accent) {
  const { box, cyl } = makeBuilder(g);
  const dark = MAT.dark(), poly = MAT.poly(), metal = MAT.metal();
  box(0.068, 0.11, 0.34, 0, 0.02, -0.22, metal);                   // 机匣
  box(0.05, 0.03, 0.22, 0, 0.085, -0.2, dark);                     // 顶部导轨
  for (let i = 0; i < 4; i++) box(0.056, 0.012, 0.02, 0, 0.104, -0.28 + i * 0.06, dark);
  cyl(0.02, 0.3, 0, 0.015, -0.55, metal);                          // 短枪管
  cyl(0.03, 0.09, 0, 0.015, -0.72, dark);                          // 消焰器
  for (let i = 0; i < 3; i++) box(0.056, 0.012, 0.012, 0, 0.015, -0.73 + i * 0.03, dark);
  box(0.05, 0.07, 0.16, 0, -0.02, -0.42, poly);                    // 护木
  box(0.042, 0.05, 0.05, 0, -0.075, -0.36, dark);                  // 前握把
  box(0.055, 0.24, 0.075, 0, -0.16, -0.16, dark, 0.1);             // 长弹匣
  box(0.05, 0.02, 0.06, 0, -0.29, -0.14, poly);
  box(0.05, 0.14, 0.07, 0, -0.12, -0.05, poly, 0.22);              // 握把
  box(0.052, 0.09, 0.05, 0, -0.13, -0.04, dark, 0.22);
  box(0.012, 0.014, 0.014, 0, -0.06, -0.02, dark);                 // 扳机
  box(0.036, 0.012, 0.06, 0, -0.05, -0.06, dark);
  // 伸缩托：细管 + 托板
  cyl(0.016, 0.16, -0.022, 0.005, 0.06, dark);
  cyl(0.016, 0.16, 0.022, 0.005, 0.06, dark);
  box(0.07, 0.09, 0.03, 0, 0.005, 0.16, dark);
  // 红点镜
  box(0.045, 0.045, 0.07, 0, 0.115, -0.24, dark);
  box(0.034, 0.034, 0.008, 0, 0.115, -0.278, MAT.glass());
  box(0.05, 0.016, 0.09, 0, 0.09, -0.24, basic(accent));           // 镜座发光条
  return new THREE.Vector3(0, 0.015, -0.78);
}

function buildRifle(g, accent) {
  const { box, cyl } = makeBuilder(g);
  const dark = MAT.dark(), wood = MAT.wood(), metal = MAT.metal();
  box(0.075, 0.09, 0.5, 0, 0.02, -0.32, metal);                    // 机匣
  box(0.062, 0.03, 0.34, 0, 0.085, -0.3, dark);                    // 防尘盖
  for (let i = 0; i < 5; i++) box(0.07, 0.012, 0.02, 0, 0.105, -0.44 + i * 0.07, dark);
  cyl(0.024, 0.5, 0, 0.02, -0.85);                                 // 枪管
  cyl(0.016, 0.34, 0, 0.072, -0.62);                               // 气导管
  box(0.04, 0.06, 0.05, 0, 0.065, -0.78, dark);                    // 气块
  cyl(0.03, 0.09, 0, 0.02, -1.08, dark);                           // 枪口制退器
  box(0.07, 0.012, 0.06, 0, 0.02, -1.08, dark);
  box(0.022, 0.05, 0.02, 0, 0.1, -0.9, dark);                      // 准星
  box(0.012, 0.03, 0.02, 0.024, 0.09, -0.9, dark);
  box(0.07, 0.08, 0.26, 0, -0.01, -0.6, wood);                     // 护木
  box(0.062, 0.03, 0.2, 0, -0.055, -0.6, dark);
  box(0.06, 0.16, 0.09, 0, -0.12, -0.3, dark, 0.18);               // 弧形弹匣（两段）
  box(0.055, 0.12, 0.08, 0, -0.235, -0.255, dark, 0.42);
  box(0.05, 0.16, 0.07, 0, -0.13, -0.12, wood, 0.3);               // 握把
  box(0.05, 0.012, 0.09, 0, -0.085, -0.2, dark);                   // 扳机护圈
  box(0.012, 0.03, 0.012, 0, -0.055, -0.2, dark);
  box(0.05, 0.09, 0.3, 0, -0.015, 0.2, wood);                      // 枪托
  box(0.05, 0.12, 0.02, 0, -0.02, 0.36, dark);                     // 托底板
  box(0.03, 0.02, 0.07, 0.055, 0.05, -0.2, metal);                 // 拉机柄
  box(0.078, 0.012, 0.2, 0, 0.045, -0.3, basic(accent));           // 侧发光条
  return new THREE.Vector3(0, 0.02, -1.14);
}

function buildShotgun(g, accent) {
  const { box, cyl } = makeBuilder(g);
  const dark = MAT.dark(), wood = MAT.wood(), metal = MAT.metal();
  cyl(0.028, 0.86, 0, 0.025, -0.5, metal, 12);                     // 粗枪管
  cyl(0.032, 0.12, 0, 0.025, -0.96, dark, 12);                     // 喉缩
  cyl(0.022, 0.7, 0, -0.03, -0.42, dark, 10);                      // 管式弹仓
  box(0.085, 0.1, 0.32, 0, 0.0, -0.18, metal);                     // 机匣
  box(0.06, 0.02, 0.24, 0, 0.06, -0.18, dark);                     // 机匣顶
  box(0.012, 0.024, 0.02, 0, 0.08, -0.86, dark);                   // 准星珠
  box(0.09, 0.09, 0.24, 0, -0.045, -0.34, wood);                   // 泵动护木
  box(0.094, 0.03, 0.1, 0, -0.02, -0.3, dark);                     // 护木箍
  box(0.055, 0.15, 0.08, 0, -0.13, -0.06, wood, 0.26);             // 握把
  box(0.012, 0.03, 0.012, 0, -0.06, -0.1, dark);                   // 扳机
  box(0.05, 0.014, 0.07, 0, -0.085, -0.08, dark);                  // 扳机护圈
  box(0.07, 0.11, 0.3, 0, -0.03, 0.24, wood);                      // 木托
  box(0.075, 0.14, 0.03, 0, -0.05, 0.4, dark);                     // 托底橡胶
  box(0.05, 0.03, 0.1, 0, 0.055, -0.16, basic(accent));            // 机匣顶部发光条
  return new THREE.Vector3(0, 0.025, -1.04);
}

function buildSniper(g, accent) {
  const { box, cyl } = makeBuilder(g);
  const dark = MAT.dark(), poly = MAT.poly(), metal = MAT.metal();
  cyl(0.022, 1.1, 0, 0.02, -0.72, metal, 12);                      // 长枪管
  cyl(0.028, 0.1, 0, 0.02, -1.3, dark, 12);                        // 枪口制退器
  for (let i = 0; i < 3; i++) box(0.05, 0.01, 0.012, 0, 0.02, -1.28 + i * 0.03, dark);
  box(0.07, 0.09, 0.46, 0, 0.0, -0.3, metal);                      // 机匣
  box(0.05, 0.03, 0.34, 0, 0.06, -0.28, dark);                     // 顶部导轨
  // 狙击镜（镜筒 + 前后镜片 + 镜桥）
  cyl(0.036, 0.34, 0, 0.14, -0.34, dark, 14);
  cyl(0.042, 0.06, 0, 0.14, -0.52, dark, 14);
  cyl(0.03, 0.01, 0, 0.14, -0.55, MAT.glass(), 14);
  cyl(0.03, 0.01, 0, 0.14, -0.16, MAT.glass(), 14);
  box(0.03, 0.07, 0.06, 0, 0.09, -0.42, dark);                     // 镜桥
  box(0.03, 0.07, 0.06, 0, 0.09, -0.2, dark);
  box(0.03, 0.02, 0.09, 0, 0.085, -0.3, basic(accent));
  box(0.05, 0.02, 0.12, 0.028, 0.03, -0.16, dark);                 // 拉机柄
  box(0.05, 0.05, 0.05, 0.028, 0.0, -0.14, metal);
  box(0.055, 0.13, 0.07, 0, -0.13, -0.12, poly, 0.2);              // 握把
  box(0.012, 0.028, 0.012, 0, -0.06, -0.16, dark);                 // 扳机
  box(0.046, 0.012, 0.07, 0, -0.085, -0.14, dark);
  box(0.05, 0.14, 0.07, 0, -0.11, -0.02, dark, 0.06);              // 弹匣
  box(0.07, 0.1, 0.34, 0, -0.02, 0.26, poly);                      // 枪托
  box(0.06, 0.09, 0.1, 0, 0.03, 0.14, dark);                       // 托腮板
  box(0.075, 0.13, 0.03, 0, -0.03, 0.44, dark);                    // 橡胶托底
  // 两脚架
  for (const s of [-1, 1]) box(0.014, 0.24, 0.014, s * 0.04, -0.14, -0.78, dark, 0, s * 0.22);
  return new THREE.Vector3(0, 0.02, -1.36);
}

const BUILDERS = {
  pistol: buildPistol,
  smg: buildSmg,
  ak47: buildRifle,
  shotgun: buildShotgun,
  sniper: buildSniper,
};

// 发光配色（与曳光弹颜色呼应）
const ACCENT = {
  pistol: 0x7fd4ff,
  smg: 0x8fe8ff,
  ak47: 0xffb066,
  shotgun: 0xffd9a0,
  sniper: 0xd8b0ff,
};

// 第三人称/地面道具用：先砍细节，再把剩余部件合并成单个 Mesh（多材质 groups）
function mergeToSingleMesh(g) {
  const perMat = new Map();
  for (const m of g.children.slice()) {
    m.updateMatrix();
    const geo = m.geometry.clone();
    geo.applyMatrix4(m.matrix);
    if (!perMat.has(m.material)) perMat.set(m.material, []);
    perMat.get(m.material).push(geo);
  }
  const geos = [];
  const mats = [];
  for (const [mat, gs] of perMat) {
    geos.push(gs.length === 1 ? gs[0] : mergeGeometries(gs, false));
    mats.push(mat);
  }
  if (!geos.length) return;
  const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, true);
  const mesh = new THREE.Mesh(merged, mats.length === 1 ? mats[0] : mats);
  mesh.castShadow = true;
  for (const m of g.children.slice()) g.remove(m);
  g.add(mesh);
}

// 简化模式：只保留体积最大的若干主体部件（去掉齿纹/螺丝/导轨等细节）
// 用于第三人称与地面道具，控制同屏 draw call
function keepLargest(g, n) {
  const kids = g.children.slice();
  const scored = kids.map((m) => {
    const p = m.geometry.parameters || {};
    const v = p.radiusTop != null
      ? Math.PI * p.radiusTop * p.radiusTop * (p.height || 0)
      : (p.width || 0) * (p.height || 0) * (p.depth || 0);
    return { m, v };
  });
  scored.sort((a, b) => b.v - a.v);
  const keep = new Set(scored.slice(0, n).map((o) => o.m));
  for (const m of kids) if (!keep.has(m)) g.remove(m);
}

/**
 * 创建武器模型
 * @param {string} kind 武器 id
 * @param {{ firstPerson?: boolean, simple?: boolean }} opts
 *   firstPerson：视图模型会缩小，避免挡住视野
 *   simple：只保留主体部件（第三人称/地面道具使用）
 * @returns {THREE.Group} group.userData.muzzle 为枪口局部坐标
 */
export function createWeaponModel(kind, opts = {}) {
  const build = BUILDERS[kind] || BUILDERS.pistol;
  const g = new THREE.Group();
  const muzzle = build(g, ACCENT[kind] ?? 0x7fd4ff);
  g.userData.muzzle = muzzle;
  g.userData.kind = kind;
  if (opts.simple) {
    keepLargest(g, 8);
    mergeToSingleMesh(g);
  }
  if (opts.firstPerson) {
    // 视图模型：整体缩小，枪口不至于顶到近裁剪面
    const s = kind === 'sniper' ? 0.52 : kind === 'shotgun' || kind === 'ak47' ? 0.6 : 0.68;
    g.scale.setScalar(s);
  }
  return g;
}

export const MUZZLE_FALLBACK = new THREE.Vector3(0, 0, -0.9);
