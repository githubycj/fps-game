// ===== 精密武器视图模型（程序化建模；第一人称 / 第三人称 / 地面道具共用）=====
// 唯一契约：REMAKE_SPEC.md §6.2
//
// 局部坐标约定（全部为“未缩放 local”坐标，firstPerson 只改 group.scale）：
//   · 原点 ≈ 握把（右手握持中心），枪口朝 -Z，上为 +Y，右侧为 +X；
//   · userData 里所有 Vector3 都直接对应这里的几何坐标，可与 Object3D.localToWorld 直接配合；
//   · 光学轴（机械瞄准线 / 红点镜光轴 / 狙击镜镜筒轴）严格平行于 -Z，
//     sightPoint 一定落在这条轴上；Lead 把 sightPoint 对齐屏幕中心即完成开镜对齐。
//
// 结构策略：
//   1) 每把枪用 40+ 个部件拼细节（倒角机匣、抛壳口、拉机柄、导轨齿、护木散热孔、
//      弯弹匣、握把防滑纹、枪托/托腮/托底、背带环、枪口装置、各型瞄具）；
//   2) 拼装完成后按材质（金属 / 木 / 聚合物 / 玻璃）合并成 2~4 个 Mesh，
//      顶点色负责每块零件的色差与轻微使用痕迹 —— 细节全保留，draw call 极少；
//   3) 模板（合并后的几何 + 材质 + userData）按 kind 缓存，同一模型多次创建零几何分配；
//      simple=true 走另一份“只保留最大体块”的模板，供第三人称/地面道具。
//
// 不使用任何外部贴图/模型资源；所有纹理感均来自几何、材质与顶点色。

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// ---------------------------------------------------------------------------
// 0. 常量
// ---------------------------------------------------------------------------

export const WEAPON_KIND_LIST = ['pistol', 'smg', 'ak47', 'shotgun', 'sniper'];

// 第一人称整体缩放：枪身不穿帮、不挡准心（狙击长枪略小）
const FPS_SCALE = {
  pistol: 0.75,
  smg: 0.74,
  ak47: 0.72,
  shotgun: 0.70,
  sniper: 0.66,
};

// 兼容旧导入：没有模型时的枪口兜底坐标
export const MUZZLE_FALLBACK = new THREE.Vector3(0, 0, -0.9);

// 颜色板（材质色差：同一种材质家族内用不同明度/色相区分零件）
const COL = {
  steel: 0x5a616b,        // 常规发黑钢
  steelDark: 0x343a41,    // 深色钢（机匣/护木箍）
  steelBlack: 0x1c1f23,   // 抛壳口内腔 / 缝隙
  steelWorn: 0x8b929b,    // 磨亮棱边
  steelBright: 0xbcc3ca,  // 枪机 / 枪管亮面
  brass: 0xc09a4b,        // 黄铜（准星珠/弹壳）
  polymerBlack: 0x26282b, // 黑色聚合物
  polymerGray: 0x3c4044,  // 灰色聚合物
  polymerOd: 0x565b48,    // 橄榄绿聚合物（狙击底盘/枪托）
  polymerTan: 0x8a7a58,   // 沙色聚合物
  bakelite: 0x5d3a23,     // AK 胶木握把
  wood: 0x8a5a2e,         // 枪托木
  woodLight: 0xa2703d,    // 木纹亮部
  woodDark: 0x54351a,     // 木纹暗部
  rubber: 0x17181a,       // 托底橡胶
  glass: 0xa8d8ff,        // 镜片玻璃
  bead: 0xe8f2cc,         // 霰弹枪准星珠
  dotRed: 0xff2f1e,       // 红点
};

// 材质家族 → 合并时的分组（同组共享 1 个材质、1 个 draw call）
const MAT_GROUP = {
  metal: 'metal',
  wood: 'wood',
  polymer: 'polymer',
  glass: 'glass',
};

// ---------------------------------------------------------------------------
// 1. 材质（缓存；顶点色负责零件之间的色差）
// ---------------------------------------------------------------------------

const matCache = new Map();

function getMaterial(group) {
  let m = matCache.get(group);
  if (m) return m;
  if (group === 'metal') {
    // 金属：roughness 0.38 / metalness 0.88（spec: 0.25~0.5 / 0.7~0.95）
    m = new THREE.MeshStandardMaterial({
      vertexColors: true, color: 0xffffff,
      roughness: 0.38, metalness: 0.88, envMapIntensity: 1.15,
    });
  } else if (group === 'wood') {
    m = new THREE.MeshStandardMaterial({
      vertexColors: true, color: 0xffffff,
      roughness: 0.58, metalness: 0.02, envMapIntensity: 0.85,
    });
  } else if (group === 'polymer') {
    m = new THREE.MeshStandardMaterial({
      vertexColors: true, color: 0xffffff,
      roughness: 0.72, metalness: 0.06, envMapIntensity: 0.8,
    });
  } else {
    // 镜片：近乎完全透明（抗反射镀膜），保证透过镜片能清楚看到准星与目标。
    // 注意：透明材质若还不写深度，会"透不出来"——这里同时把 opacity 压到极低、
    // 关闭高光反射（否则低角度会整片泛蓝变暗），并设置极小的渲染顺序避免遮挡红点。
    m = new THREE.MeshBasicMaterial({
      color: 0xeaf6ff,
      transparent: true, opacity: 0.045,
      depthWrite: false, depthTest: true,
      side: THREE.DoubleSide,
      toneMapped: false,
      blending: THREE.NormalBlending,
    });
    m.userData.isLens = true;
  }
  matCache.set(group, m);
  return m;
}

// ---------------------------------------------------------------------------
// 2. 几何缓存 + 基础几何工具
// ---------------------------------------------------------------------------

const geoCache = new Map();

function numKey(...vals) {
  return vals.map((v) => Math.round(v * 1e4) / 1e4).join('_');
}

function cachedGeo(key, make) {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    geoCache.set(key, g);
  }
  return g;
}

function boxGeo(w, h, d) {
  return cachedGeo(`box_${numKey(w, h, d)}`, () => new THREE.BoxGeometry(w, h, d));
}

// 倒角盒：RoundedBoxGeometry（机匣/握把/枪托等主块体）
function rboxGeo(w, h, d, r, seg = 2) {
  const rr = Math.max(0.0008, Math.min(r, Math.min(w, h, d) * 0.48));
  return cachedGeo(`rbox_${numKey(w, h, d, rr, seg)}`,
    () => new RoundedBoxGeometry(w, h, d, Math.max(1, Math.round(seg)), rr));
}

// 圆柱：axis = 'y'（默认）| 'z'（枪管）| 'x'（横销）
function cylGeo(rTop, rBottom, len, seg, axis) {
  return cachedGeo(`cyl_${numKey(rTop, rBottom, len)}_${seg}_${axis}`, () => {
    const g = new THREE.CylinderGeometry(rTop, rBottom, len, seg);
    if (axis === 'z') g.rotateX(Math.PI / 2);
    else if (axis === 'x') g.rotateZ(Math.PI / 2);
    return g;
  });
}

function torusGeo(radius, tube, radialSeg = 8, tubularSeg = 18) {
  return cachedGeo(`torus_${numKey(radius, tube)}_${radialSeg}_${tubularSeg}`,
    () => new THREE.TorusGeometry(radius, tube, radialSeg, tubularSeg));
}

function sphereGeo(radius, ws = 10, hs = 8) {
  return cachedGeo(`sphere_${numKey(radius)}_${ws}_${hs}`,
    () => new THREE.SphereGeometry(radius, ws, hs));
}

// 旋转体：points = [[半径, y], ...]（绕 Y 轴），随后转到 -Z 轴向
function latheGeoZ(points, seg = 16) {
  const key = `lathe_${points.map((p) => numKey(p[0], p[1])).join('~')}_${seg}`;
  return cachedGeo(key, () => {
    const g = new THREE.LatheGeometry(points.map((p) => new THREE.Vector2(p[0], p[1])), seg);
    g.rotateX(Math.PI / 2);
    return g;
  });
}

// 圆角矩形轮廓（Shape / Path 通用）：居中
function traceRoundedRect(path, w, h, r) {
  const x = -w / 2;
  const y = -h / 2;
  const rr = Math.max(0.0005, Math.min(r, Math.min(w, h) * 0.45));
  path.moveTo(x + rr, y);
  path.lineTo(x + w - rr, y);
  path.quadraticCurveTo(x + w, y, x + w, y + rr);
  path.lineTo(x + w, y + h - rr);
  path.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  path.lineTo(x + rr, y + h);
  path.quadraticCurveTo(x, y + h, x, y + h - rr);
  path.lineTo(x, y + rr);
  path.quadraticCurveTo(x, y, x + rr, y);
  path.closePath();
  return path;
}

function roundedRectShape(w, h, r) {
  const s = new THREE.Shape();
  traceRoundedRect(s, w, h, r);
  return s;
}

// 扳机护圈这种“环”形轮廓
function ringShape(outerW, outerH, holeW, holeH, r = 0.01) {
  const shape = roundedRectShape(outerW, outerH, r);
  const hole = new THREE.Path();
  traceRoundedRect(hole, holeW, holeH, r * 0.75);
  shape.holes.push(hole);
  return shape;
}

// 弯弹匣轮廓：x 为“向前”方向（映射到 -Z），y 向下为负
function magShape(wTop, wBot, height, curve) {
  const s = new THREE.Shape();
  const tw = wTop / 2;
  const bw = wBot / 2;
  s.moveTo(-tw, 0);
  s.lineTo(tw, 0);
  s.quadraticCurveTo(tw + curve * 0.45, -height * 0.5, bw + curve, -height);
  s.lineTo(-bw + curve, -height);
  s.quadraticCurveTo(-tw + curve * 0.42, -height * 0.5, -tw, 0);
  s.closePath();
  return s;
}

// 把“侧视轮廓”沿 X 方向挤出成实体（轮廓 x → 世界 -Z，挤出方向 → 世界 X）
function extrudeProfileGeo(key, shape, depth, bevel = 0.0012) {
  return cachedGeo(`prof_${key}_${numKey(depth, bevel)}`, () => {
    const g = new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: bevel > 0,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: 1,
      curveSegments: 6,
      steps: 1,
    });
    g.rotateY(Math.PI / 2);
    g.translate(-depth / 2, 0, 0);
    return g;
  });
}

// ---------------------------------------------------------------------------
// 3. 部件收集器：把所有零件记录成 { geo, matrix, mat, color }，最后统一合并
// ---------------------------------------------------------------------------

class PartBuilder {
  constructor() {
    this.parts = [];
  }

  add(geo, mat, color, pos = [0, 0, 0], rot = [0, 0, 0], major = false) {
    const r = rot || [0, 0, 0];
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0], r[1], r[2], 'XYZ'));
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(pos[0] || 0, pos[1] || 0, pos[2] || 0),
      quat,
      new THREE.Vector3(1, 1, 1),
    );
    this.parts.push({ geo, mat: MAT_GROUP[mat] || 'polymer', color, matrix, major: !!major });
  }

  box(w, h, d, pos, mat, color, rot, major) {
    this.add(boxGeo(w, h, d), mat, color, pos, rot, major);
  }

  rbox(w, h, d, r, pos, mat, color, rot, major) {
    this.add(rboxGeo(w, h, d, r), mat, color, pos, rot, major);
  }

  cylY(r, len, pos, mat, color, seg = 14, major) {
    this.add(cylGeo(r, r, len, seg, 'y'), mat, color, pos, null, major);
  }

  cylY2(rTop, rBottom, len, pos, mat, color, seg = 14, major) {
    this.add(cylGeo(rTop, rBottom, len, seg, 'y'), mat, color, pos, null, major);
  }

  cylZ(r, len, pos, mat, color, seg = 14, major) {
    this.add(cylGeo(r, r, len, seg, 'z'), mat, color, pos, null, major);
  }

  cylZ2(rTop, rBottom, len, pos, mat, color, seg = 14, major) {
    this.add(cylGeo(rTop, rBottom, len, seg, 'z'), mat, color, pos, null, major);
  }

  cylX(r, len, pos, mat, color, seg = 14, major) {
    this.add(cylGeo(r, r, len, seg, 'x'), mat, color, pos, null, major);
  }

  torus(radius, tube, pos, mat, color, rot, major) {
    this.add(torusGeo(radius, tube), mat, color, pos, rot, major);
  }

  sphere(radius, pos, mat, color, seg = 10, major) {
    this.add(sphereGeo(radius, seg, Math.max(6, seg - 2)), mat, color, pos, null, major);
  }

  profile(key, shape, depth, pos, mat, color, rot, major) {
    this.add(extrudeProfileGeo(key, shape, depth), mat, color, pos, rot, major);
  }

  latheZ(key, points, pos, mat, color, seg = 16, major) {
    const geo = cachedGeo(`latheZ_${key}_${seg}`, () => {
      const g = new THREE.LatheGeometry(points.map((p) => new THREE.Vector2(p[0], p[1])), seg);
      g.rotateX(Math.PI / 2);
      return g;
    });
    this.add(geo, mat, color, pos, null, major);
  }
}

// 握把局部坐标 → 世界局部坐标（握把绕 X 轴后倾 angle）
function gripPoint(center, angle, lx, ly, lz) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    center[0] + lx,
    center[1] + c * ly - s * lz,
    center[2] + s * ly + c * lz,
  ];
}

// ---------------------------------------------------------------------------
// 4. 通用细节零件（导轨 / 抛壳口 / 扳机组 / 背带环 / 螺钉）
// ---------------------------------------------------------------------------

// 皮卡汀尼导轨：底座 + 一排梯形齿（齿单独成件，合并后只有 1 个 draw call）
function addRail(b, cfg) {
  const {
    x = 0, y, z, length, width = 0.024,
    baseColor = COL.steelDark, toothColor = COL.steel,
    teeth = 0, major = true,
  } = cfg;
  b.box(width - 0.002, 0.006, length, [x, y, z], 'metal', baseColor, null, major);
  const span = Math.max(0.004, length - 0.008);
  const n = teeth > 0 ? teeth : Math.max(2, Math.floor(span / 0.0125));
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    const tz = z + span / 2 - t * span;
    b.box(width + 0.006, 0.005, Math.min(0.0075, span / n * 0.62), [x, y + 0.0055, tz],
      'metal', toothColor);
    // 齿根两侧的倒角亮边（使用痕迹）
    b.box(width + 0.0065, 0.0012, 0.0018, [x, y + 0.003, tz], 'metal', COL.steelWorn);
  }
}

// 抛壳口：内腔暗面 + 上下亮边 + 露出的枪机/机框
function addEjectionPort(b, cfg) {
  const { x, y, z, h = 0.02, d = 0.06, side = 1, bolt = true } = cfg;
  b.box(0.004, h, d, [x, y, z], 'metal', COL.steelBlack, null, true);
  b.box(0.0024, 0.003, d + 0.008, [x + side * 0.0012, y + h / 2, z], 'metal', COL.steelWorn);
  b.box(0.0024, 0.0026, d + 0.006, [x + side * 0.0012, y - h / 2, z], 'metal', COL.steelWorn);
  if (bolt) {
    b.box(0.0022, h * 0.62, d * 0.24, [x + side * 0.0006, y, z - d * 0.3], 'metal', COL.steelBright);
  }
}

// 扳机护圈（挤出的环形轮廓）+ 扳机 + 扳机轴 + 护圈前缘防滑纹
function addTriggerGroup(b, cfg) {
  const {
    y, z, width = 0.026,
    outerW = 0.098, outerH = 0.060, holeW = 0.074, holeH = 0.040,
    guardMat = 'metal', guardColor = COL.steelDark,
    triggerColor = COL.steelBright, triggerH = 0.028,
  } = cfg;
  const shape = ringShape(outerW, outerH, holeW, holeH, Math.min(outerH, outerW) * 0.16);
  const key = `guard_${numKey(outerW, outerH, holeW, holeH)}`;
  b.profile(key, shape, width, [0, y, z], guardMat, guardColor, null, true);
  // 扳机（略微前倾）
  b.box(0.0075, triggerH, 0.0095, [0, y + 0.012, z + 0.014], 'metal', triggerColor, [-0.24, 0, 0]);
  b.box(0.003, triggerH * 0.62, 0.004, [0, y + 0.012, z + 0.010], 'metal', COL.steelDark);
  // 扳机轴
  b.cylX(0.0032, width + 0.008, [0, y + 0.028, z + 0.020], 'metal', COL.steelWorn);
  // 护圈前缘防滑纹
  b.box(0.0035, 0.0075, 0.012, [0, y - 0.019, z - outerW * 0.42], 'metal', COL.steelWorn);
}

// 背带环：金属环 + 底座
function addSlingLoop(b, pos, cfg = {}) {
  const { radius = 0.011, tube = 0.0022, axis = 'x', base = true } = cfg;
  const rot = axis === 'x' ? [0, Math.PI / 2, 0] : axis === 'y' ? [Math.PI / 2, 0, 0] : [0, 0, 0];
  b.torus(radius, tube, pos, 'metal', COL.steelWorn, rot);
  if (base) {
    b.box(0.012, 0.013, 0.011, [pos[0], pos[1] + radius * 0.55, pos[2]], 'metal', COL.steelDark);
  }
}

// 螺钉 / 销：圆柱 + 一字槽
function addScrew(b, pos, cfg = {}) {
  const { axis = 'x', r = 0.0032, len = 0.006, color = COL.steelWorn } = cfg;
  if (axis === 'x') b.cylX(r, len, pos, 'metal', color);
  else if (axis === 'y') b.cylY(r, len, pos, 'metal', color);
  else b.cylZ(r, len, pos, 'metal', color);
  if (axis === 'x') b.box(len + 0.001, 0.0012, r * 1.05, pos, 'metal', COL.steelBlack);
  else if (axis === 'y') b.box(r * 1.05, len + 0.001, 0.0012, pos, 'metal', COL.steelBlack);
  else b.box(0.0012, r * 1.05, len + 0.001, pos, 'metal', COL.steelBlack);
}

// ---------------------------------------------------------------------------
// 5. 具体武器
// ---------------------------------------------------------------------------

// ---- 5.1 手枪（Glock 风格：聚合物框架 + 钢套筒 + 机械瞄具）----
function buildPistol(b) {
  const A = -0.22;                        // 握把后倾
  const grip = [0, 0.004, -0.002];        // 握把中心（枪身位于握把前上方）

  // 套筒（切角主体 + 前后端倒角）
  b.rbox(0.0305, 0.031, 0.172, 0.0045, [0, 0.0945, -0.104], 'metal', COL.steel, null, true);
  b.rbox(0.0285, 0.026, 0.016, 0.0035, [0, 0.0945, -0.194], 'metal', COL.steel, null, true);
  b.box(0.026, 0.024, 0.004, [0, 0.0945, -0.0165], 'metal', COL.steelDark);          // 尾部底板
  // 套筒后/前防滑齿
  for (let i = 0; i < 6; i++) b.box(0.0312, 0.024, 0.0032, [0, 0.095, -0.024 - i * 0.0072], 'metal', COL.steelWorn);
  for (let i = 0; i < 3; i++) b.box(0.0292, 0.020, 0.0030, [0, 0.095, -0.170 - i * 0.0072], 'metal', COL.steelWorn);
  // 套筒顶部纵向凹槽
  for (const dx of [-0.007, 0, 0.007]) b.box(0.0018, 0.0016, 0.150, [dx, 0.1095, -0.100], 'metal', COL.steelDark);
  // 抛壳口 + 抛壳挺
  addEjectionPort(b, { x: 0.0152, y: 0.099, z: -0.086, h: 0.012, d: 0.046 });
  b.box(0.005, 0.005, 0.022, [0.0155, 0.104, -0.030], 'metal', COL.steelWorn);
  // 枪管 / 枪口冠 / 膛口
  b.cylZ(0.0086, 0.075, [0, 0.0945, -0.205], 'metal', COL.steelBright, 16);
  b.cylZ(0.0098, 0.008, [0, 0.0945, -0.2405], 'metal', COL.steelWorn, 16);
  b.cylZ(0.0054, 0.012, [0, 0.0945, -0.2465], 'metal', COL.steelBlack, 14);
  // 机械瞄具：前准星（立柱 + 光点）
  b.box(0.006, 0.0035, 0.010, [0, 0.1115, -0.178], 'metal', COL.steelDark);
  b.box(0.0036, 0.012, 0.007, [0, 0.120, -0.178], 'metal', COL.steelDark);
  b.sphere(0.0022, [0, 0.1245, -0.180], 'polymer', COL.bead);
  // 机械瞄具：后照门（缺口式）
  b.box(0.0205, 0.0055, 0.013, [0, 0.1148, -0.030], 'metal', COL.steelDark);
  b.box(0.005, 0.009, 0.012, [-0.0078, 0.1215, -0.030], 'metal', COL.steelDark);
  b.box(0.005, 0.009, 0.012, [0.0078, 0.1215, -0.030], 'metal', COL.steelDark);
  b.box(0.0205, 0.0035, 0.012, [0, 0.1178, -0.030], 'metal', COL.steelBlack);
  b.cylX(0.002, 0.020, [0.012, 0.1148, -0.030], 'metal', COL.steelWorn);              // 照门横销

  // 套筒座（聚合物框架）
  b.rbox(0.029, 0.026, 0.190, 0.004, [0, 0.066, -0.082], 'polymer', COL.polymerBlack, null, true);
  b.box(0.025, 0.010, 0.060, [0, 0.0525, -0.140], 'polymer', COL.polymerBlack);       // 下挂导轨
  for (let i = 0; i < 3; i++) b.box(0.027, 0.0042, 0.0075, [0, 0.0458, -0.122 - i * 0.019], 'polymer', COL.polymerGray);
  // 空仓挂机杆 / 分解杆 / 弹匣释放
  b.box(0.0055, 0.009, 0.030, [-0.0162, 0.056, -0.040], 'metal', COL.steelWorn);
  b.box(0.0055, 0.008, 0.024, [-0.0162, 0.070, -0.060], 'metal', COL.steelWorn);
  b.cylX(0.0055, 0.008, [-0.0165, 0.064, -0.020], 'metal', COL.steelBright);
  b.box(0.003, 0.012, 0.016, [-0.0180, 0.064, -0.020], 'metal', COL.steelDark);
  // 扳机护圈 + 扳机
  addTriggerGroup(b, {
    y: 0.0395, z: -0.050, width: 0.021,
    outerW: 0.070, outerH: 0.048, holeW: 0.052, holeH: 0.030,
    guardMat: 'polymer', guardColor: COL.polymerBlack,
  });
  // 海狸尾（套筒座尾部上翘，与握把上端衔接）
  b.rbox(0.028, 0.016, 0.046, 0.005, [0, 0.060, 0.010], 'polymer', COL.polymerBlack);
  b.box(0.0265, 0.003, 0.038, [0, 0.0692, 0.010], 'polymer', COL.polymerGray);

  // 握把（后倾 + 前后握把片 + 手指槽 + 侧面防滑纹）
  b.rbox(0.0305, 0.095, 0.044, 0.009, grip, 'polymer', COL.polymerBlack, [A, 0, 0], true);
  b.rbox(0.028, 0.085, 0.010, 0.004, gripPoint(grip, A, 0, 0.0, -0.022), 'polymer', COL.polymerGray, [A, 0, 0], true);
  b.rbox(0.0275, 0.082, 0.009, 0.004, gripPoint(grip, A, 0, -0.004, 0.026), 'polymer', COL.polymerBlack, [A, 0, 0]);
  for (let i = 0; i < 3; i++) {
    b.box(0.0290, 0.006, 0.009, gripPoint(grip, A, 0, 0.018 - i * 0.026, -0.029), 'polymer', COL.polymerGray, [A, 0, 0]);
  }
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      b.box(0.0022, 0.013, 0.034, gripPoint(grip, A, sx * 0.0156, 0.020 - i * 0.020, 0.002),
        'polymer', COL.polymerGray, [A, 0, 0]);
    }
  }
  // 握把底托 / 弹匣底板 / 挂绳环
  b.rbox(0.0335, 0.011, 0.050, 0.003, gripPoint(grip, A, 0, -0.050, 0.004), 'polymer', COL.polymerGray, [A, 0, 0], true);
  b.box(0.026, 0.012, 0.040, gripPoint(grip, A, 0, -0.045, 0.0), 'metal', COL.steelDark, [A, 0, 0]);
  b.torus(0.007, 0.0018, gripPoint(grip, A, 0, -0.049, 0.028), 'metal', COL.steelWorn, [Math.PI / 2, 0, 0]);
  // 握把销
  b.cylX(0.0028, 0.033, gripPoint(grip, A, 0, -0.010, 0.012), 'metal', COL.steelWorn);

  // 使用痕迹：套筒两侧棱边磨亮
  for (const sx of [-1, 1]) b.box(0.0012, 0.0026, 0.160, [sx * 0.0152, 0.1080, -0.104], 'metal', COL.steelWorn);
  b.box(0.0012, 0.0018, 0.140, [0.0152, 0.0815, -0.100], 'metal', COL.steelWorn);
  // 膛内有弹指示（黄铜小窗）
  b.box(0.0025, 0.004, 0.008, [0.0154, 0.1035, -0.060], 'metal', COL.brass);

  return {
    muzzle: [0, 0.0945, -0.252],
    sightPoint: [0, 0.126, -0.030],
    sightType: 'iron',
    scopeLens: null,
    rightGrip: [0, -0.009, -0.002],
    leftGrip: [-0.014, -0.027, -0.010],
    boltAxis: null,
    sprite: null,
  };
}

// ---- 5.2 冲锋枪（MP5 风格：管状机匣 + 红点镜 + 伸缩托 + 弯弹匣）----
function buildSmg(b) {
  const A = -0.18;
  const grip = [0, -0.002, 0.030];

  // 机匣 / 前节套 / 尾盖 / 弹匣井
  b.rbox(0.054, 0.070, 0.290, 0.010, [0, 0.078, -0.122], 'metal', COL.steel, null, true);
  b.rbox(0.056, 0.062, 0.034, 0.010, [0, 0.076, -0.286], 'metal', COL.steelDark, null, true);
  b.rbox(0.052, 0.060, 0.018, 0.008, [0, 0.078, 0.030], 'metal', COL.steelDark, null, true);
  b.rbox(0.050, 0.030, 0.090, 0.006, [0, 0.033, -0.078], 'metal', COL.steelDark, null, true);
  // 上导轨（红点镜座）
  addRail(b, { y: 0.116, z: -0.110, length: 0.230 });
  // 抛壳口（右侧）
  addEjectionPort(b, { x: 0.0272, y: 0.090, z: -0.150, h: 0.017, d: 0.052 });
  // 左侧拉机柄套筒 + 拉机柄
  b.cylZ(0.0165, 0.150, [-0.013, 0.086, -0.360], 'metal', COL.steelDark, 16);
  b.cylX(0.006, 0.032, [-0.028, 0.086, -0.380], 'metal', COL.steelBright);
  b.rbox(0.018, 0.014, 0.020, 0.004, [-0.040, 0.086, -0.380], 'metal', COL.steelDark);
  b.box(0.004, 0.010, 0.100, [-0.0308, 0.086, -0.080], 'metal', COL.steelBlack);
  // 护木 + 侧面散热孔阵列
  b.rbox(0.052, 0.056, 0.165, 0.012, [0, 0.056, -0.365], 'polymer', COL.polymerBlack, null, true);
  for (const sx of [-1, 1]) {
    for (let r = 0; r < 2; r++) {
      for (let i = 0; i < 3; i++) {
        b.box(0.0025, 0.009, 0.020, [sx * 0.0260, 0.046 + r * 0.018, -0.315 - i * 0.034],
          'metal', COL.steelBlack);
      }
    }
  }
  // 护木下导轨 + 齿
  b.box(0.022, 0.005, 0.110, [0, 0.028, -0.365], 'metal', COL.steelDark);
  for (let i = 0; i < 4; i++) b.box(0.026, 0.004, 0.007, [0, 0.0245, -0.330 - i * 0.022], 'metal', COL.steel);
  // 护木前箍
  b.box(0.050, 0.050, 0.014, [0, 0.058, -0.452], 'metal', COL.steelDark);
  // 枪管 / 枪口装置
  b.cylZ(0.0130, 0.145, [0, 0.078, -0.495], 'metal', COL.steelBright, 16);
  b.cylZ(0.017, 0.012, [0, 0.078, -0.425], 'metal', COL.steelWorn, 16);
  b.cylZ(0.016, 0.052, [0, 0.078, -0.590], 'metal', COL.steelDark, 16);
  b.cylZ(0.0135, 0.020, [0, 0.078, -0.622], 'metal', COL.steelWorn, 16);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    b.box(0.004, 0.010, 0.030, [Math.cos(a) * 0.014, 0.078 + Math.sin(a) * 0.014, -0.592],
      'metal', COL.steelBlack, [0, 0, a]);
  }
  // 前准星（护圈式后备机械瞄具）
  b.box(0.034, 0.020, 0.026, [0, 0.100, -0.456], 'metal', COL.steelDark);
  for (const sx of [-1, 1]) {
    b.box(0.005, 0.028, 0.006, [sx * 0.0115, 0.121, -0.456], 'metal', COL.steelDark);
  }
  b.torus(0.013, 0.0022, [0, 0.132, -0.456], 'metal', COL.steelWorn);
  b.box(0.003, 0.018, 0.004, [0, 0.128, -0.456], 'metal', COL.steelDark);
  // 后照门转鼓（位于导轨后方）
  b.cylX(0.012, 0.020, [0, 0.123, 0.012], 'metal', COL.steelDark);
  b.box(0.004, 0.005, 0.004, [0, 0.135, 0.012], 'metal', COL.steelBlack);

  // 红点镜：大窗口浮点式红点（镜片直径 105mm 观感），中间完全通透
  b.box(0.040, 0.012, 0.052, [0, 0.1265, -0.095], 'metal', COL.steelDark);
  b.cylX(0.004, 0.034, [0, 0.121, -0.072], 'metal', COL.steelWorn);
  b.rbox(0.048, 0.024, 0.040, 0.004, [0, 0.132, -0.095], 'polymer', COL.polymerBlack, null, true);
  // 上下两条横梁（决定镜窗高度 ≈ 0.106）
  b.box(0.100, 0.006, 0.010, [0, 0.2020, -0.095], 'polymer', COL.polymerBlack);
  b.box(0.100, 0.006, 0.010, [0, 0.0960, -0.095], 'polymer', COL.polymerBlack);
  // 左右两根立柱（决定镜窗宽度 ≈ 0.094）
  for (const sx of [-1, 1]) b.box(0.006, 0.112, 0.010, [sx * 0.0470, 0.149, -0.095], 'polymer', COL.polymerBlack);
  // 镜筒前后圆环（托住光学镜片）
  for (const z of [-0.126, -0.064]) b.torus(0.0500, 0.0030, [0, 0.149, z], 'metal', COL.steelDark);
  // 镜片玻璃（真实光学由 optics shader 绘制，这里留一层极淡镀膜底色）
  b.box(0.092, 0.104, 0.0010, [0, 0.149, -0.1255], 'glass', COL.glass);
  b.box(0.090, 0.102, 0.0010, [0, 0.149, -0.0645], 'glass', COL.glass);
  // 顶部/侧面调节旋钮
  b.cylY(0.0090, 0.016, [0, 0.210, -0.095], 'metal', COL.steelWorn, 12);
  b.cylY(0.0065, 0.007, [0, 0.220, -0.095], 'metal', COL.steelDark, 12);
  b.cylX(0.0090, 0.016, [0.054, 0.149, -0.095], 'metal', COL.steelWorn, 12);
  b.cylX(0.0070, 0.011, [-0.054, 0.149, -0.100], 'metal', COL.steelDark, 12);

  // 握把（含防滑纹）
  b.rbox(0.046, 0.095, 0.052, 0.010, grip, 'polymer', COL.polymerBlack, [A, 0, 0], true);
  b.rbox(0.042, 0.084, 0.010, 0.004, gripPoint(grip, A, 0, -0.002, -0.026), 'polymer', COL.polymerGray, [A, 0, 0]);
  b.rbox(0.042, 0.080, 0.010, 0.004, gripPoint(grip, A, 0, -0.002, 0.026), 'polymer', COL.polymerBlack, [A, 0, 0]);
  for (let i = 0; i < 4; i++) {
    b.box(0.047, 0.0035, 0.006, gripPoint(grip, A, 0, 0.028 - i * 0.019, 0.030), 'polymer', COL.polymerGray, [A, 0, 0]);
  }
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      b.box(0.0022, 0.012, 0.032, gripPoint(grip, A, sx * 0.0235, 0.018 - i * 0.020, 0),
        'polymer', COL.polymerGray, [A, 0, 0]);
    }
  }
  b.box(0.040, 0.010, 0.046, gripPoint(grip, A, 0, -0.052, 0.004), 'polymer', COL.polymerGray, [A, 0, 0], true);
  b.torus(0.007, 0.0018, gripPoint(grip, A, 0, -0.052, 0.026), 'metal', COL.steelWorn, [Math.PI / 2, 0, 0]);

  // 扳机组
  addTriggerGroup(b, {
    y: 0.029, z: -0.020, width: 0.026,
    outerW: 0.084, outerH: 0.056, holeW: 0.062, holeH: 0.036,
    guardMat: 'polymer', guardColor: COL.polymerBlack,
  });
  // 弹匣（前弯，ExtrudeGeometry 轮廓）
  b.profile('smg_mag', magShape(0.050, 0.046, 0.200, 0.030), 0.030,
    [0, 0.030, -0.075], 'metal', COL.steelDark, null, true);
  for (let i = 0; i < 3; i++) {
    b.box(0.033, 0.0045, 0.008, [0, -0.030 - i * 0.052, -0.104 - i * 0.0075], 'metal', COL.steelWorn, [0.14, 0, 0]);
  }
  for (const sx of [-1, 1]) {
    b.box(0.0022, 0.150, 0.012, [sx * 0.0160, -0.070, -0.090], 'metal', COL.steel, [0.10, 0, 0]);
  }
  b.box(0.034, 0.009, 0.054, [0, -0.174, -0.105], 'metal', COL.steelDark, null, true);
  // 弹匣卡笋
  b.box(0.010, 0.020, 0.012, [0, 0.026, -0.040], 'metal', COL.steelWorn);

  // 伸缩托（双轨 + 托板 + 托底 + 托腮）
  for (const sx of [-1, 1]) b.cylZ(0.0065, 0.205, [sx * 0.017, 0.086, 0.128], 'metal', COL.steelDark, 10);
  b.box(0.040, 0.036, 0.014, [0, 0.086, 0.036], 'metal', COL.steelDark);
  b.rbox(0.048, 0.094, 0.020, 0.006, [0, 0.064, 0.238], 'polymer', COL.polymerBlack, null, true);
  b.rbox(0.052, 0.100, 0.013, 0.004, [0, 0.064, 0.252], 'polymer', COL.rubber, null, true);
  b.box(0.044, 0.030, 0.012, [0, 0.104, 0.238], 'polymer', COL.polymerBlack);
  // 快慢机 / 保险拨杆
  b.cylX(0.008, 0.012, [-0.029, 0.086, -0.030], 'metal', COL.steelWorn);
  b.box(0.004, 0.009, 0.036, [-0.032, 0.086, -0.014], 'metal', COL.steelWorn);
  // 机匣销钉 / 铭牌
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) addScrew(b, [sx * 0.0270, 0.072, -0.040 - i * 0.075], { axis: 'x', r: 0.0026, len: 0.0055 });
  }
  b.box(0.002, 0.010, 0.040, [0.0274, 0.070, -0.060], 'metal', COL.steelWorn);
  // 背带环（前护木 / 托板下）
  addSlingLoop(b, [0.030, 0.062, -0.318], { radius: 0.010, axis: 'x' });
  addSlingLoop(b, [0, 0.020, 0.250], { radius: 0.010, axis: 'x' });
  // 使用痕迹：机匣棱边高光
  for (const sx of [-1, 1]) b.box(0.0012, 0.0022, 0.240, [sx * 0.0272, 0.112, -0.122], 'metal', COL.steelWorn);
  b.box(0.0012, 0.0018, 0.220, [0.0272, 0.044, -0.122], 'metal', COL.steelWorn);

  return {
    muzzle: [0, 0.078, -0.632],
    sightPoint: [0, 0.149, -0.118],
    sightType: 'reddot',
    scopeLens: null,
    rightGrip: [0, -0.016, 0.042],
    leftGrip: [0, 0.038, -0.365],
    boltAxis: null,
    // 光学镜片：直径 0.105（贴近目镜后约占视野 60%，符合真实红点的"大窗口"观感）
    sprite: { color: COL.dotRed, size: 0.105, position: [0, 0.149, -0.072] },
  };
}

// ---- 5.3 突击步枪（AKM 风格：钢机匣 + 木护木/枪托 + 机械准星）----
function buildAk47(b) {
  const A = -0.24;
  const grip = [0, -0.018, 0.042];

  // 机匣 / 防尘盖 / 尾座
  b.rbox(0.052, 0.078, 0.300, 0.008, [0, 0.070, -0.115], 'metal', COL.steel, null, true);
  b.rbox(0.048, 0.026, 0.245, 0.008, [0, 0.112, -0.145], 'metal', COL.steelDark, null, true);
  for (const dx of [-0.013, 0, 0.013]) b.box(0.0016, 0.0022, 0.200, [dx, 0.1255, -0.145], 'metal', COL.steel);
  b.box(0.030, 0.008, 0.040, [0, 0.108, 0.030], 'metal', COL.steelDark);
  b.cylX(0.008, 0.010, [0, 0.112, 0.036], 'metal', COL.steelWorn);
  // 抛壳口（右侧）+ 拉机柄
  addEjectionPort(b, { x: 0.0265, y: 0.092, z: -0.145, h: 0.020, d: 0.070 });
  b.cylX(0.006, 0.026, [0.040, 0.105, -0.140], 'metal', COL.steelBright);
  b.rbox(0.014, 0.014, 0.020, 0.004, [0.055, 0.105, -0.135], 'metal', COL.steelDark);
  // 快慢机（右侧长杆）
  b.box(0.004, 0.012, 0.140, [0.028, 0.080, 0.000], 'metal', COL.steelWorn, [0, 0, 0]);
  b.cylX(0.007, 0.010, [0.030, 0.080, -0.060], 'metal', COL.steelDark);
  // 左侧光学/瞄具侧轨
  b.box(0.005, 0.022, 0.090, [-0.028, 0.090, -0.060], 'metal', COL.steelDark);
  for (let i = 0; i < 2; i++) addScrew(b, [-0.0305, 0.090, -0.040 - i * 0.040], { axis: 'x', r: 0.002, len: 0.004 });
  // 机械照门（表尺座 + 表尺 + 缺口）
  b.box(0.038, 0.020, 0.030, [0, 0.123, -0.262], 'metal', COL.steelDark);
  b.box(0.028, 0.0045, 0.055, [0, 0.136, -0.232], 'metal', COL.steel, [0.03, 0, 0]);
  for (const sx of [-1, 1]) b.box(0.006, 0.006, 0.008, [sx * 0.009, 0.139, -0.208], 'metal', COL.steelDark);
  b.box(0.018, 0.003, 0.010, [0, 0.1335, -0.208], 'metal', COL.steelBlack);
  b.cylX(0.0022, 0.030, [0, 0.133, -0.262], 'metal', COL.steelWorn);
  // 枪管 / 枪管箍 / 导气箍
  b.cylZ(0.0125, 0.650, [0, 0.100, -0.585], 'metal', COL.steelBright, 16);
  b.cylZ(0.018, 0.030, [0, 0.100, -0.280], 'metal', COL.steelDark, 16);
  b.box(0.034, 0.048, 0.040, [0, 0.114, -0.630], 'metal', COL.steelDark);
  b.box(0.030, 0.020, 0.030, [0, 0.140, -0.640], 'metal', COL.steel, [0.35, 0, 0]);
  // 导气管 + 气孔
  b.cylZ(0.012, 0.310, [0, 0.123, -0.455], 'metal', COL.steelDark, 14);
  b.box(0.004, 0.0025, 0.010, [0.006, 0.1355, -0.470], 'metal', COL.steelBlack);
  b.box(0.004, 0.0025, 0.010, [-0.006, 0.1355, -0.490], 'metal', COL.steelBlack);
  // 上护木（木）
  b.rbox(0.040, 0.028, 0.175, 0.008, [0, 0.124, -0.395], 'wood', COL.wood, null, true);
  b.box(0.042, 0.032, 0.008, [0, 0.124, -0.310], 'metal', COL.steelDark);
  b.box(0.042, 0.032, 0.008, [0, 0.124, -0.480], 'metal', COL.steelDark);
  // 下护木（木 + 掌托 + 木纹）
  b.rbox(0.050, 0.048, 0.220, 0.012, [0, 0.074, -0.390], 'wood', COL.wood, null, true);
  b.rbox(0.046, 0.030, 0.170, 0.012, [0, 0.050, -0.390], 'wood', COL.woodLight, null, true);
  b.box(0.052, 0.004, 0.190, [0, 0.096, -0.390], 'wood', COL.woodDark);
  b.box(0.0018, 0.030, 0.170, [0.0252, 0.078, -0.390], 'wood', COL.woodDark);
  b.box(0.0018, 0.030, 0.170, [-0.0252, 0.078, -0.390], 'wood', COL.woodDark);
  // 护木箍 + 背带环
  b.box(0.052, 0.050, 0.012, [0, 0.078, -0.278], 'metal', COL.steelDark);
  addSlingLoop(b, [0.030, 0.072, -0.286], { radius: 0.010, axis: 'x' });
  // 通条
  b.cylZ(0.004, 0.340, [0, 0.083, -0.700], 'metal', COL.steelDark, 8);
  // 前准星（表尺柱 + 护翼）
  b.box(0.030, 0.036, 0.030, [0, 0.116, -0.800], 'metal', COL.steelDark);
  for (const sx of [-1, 1]) b.box(0.004, 0.026, 0.026, [sx * 0.011, 0.143, -0.800], 'metal', COL.steelDark, [0, 0, sx * 0.10]);
  b.cylY(0.0018, 0.020, [0, 0.132, -0.800], 'metal', COL.steelWorn, 8);
  addScrew(b, [0.019, 0.112, -0.800], { axis: 'x', r: 0.003, len: 0.006 });
  // AKM 斜切枪口制退器
  b.cylZ2(0.0165, 0.0150, 0.060, [0, 0.100, -0.918], 'metal', COL.steelDark, 16);
  b.box(0.020, 0.004, 0.030, [0, 0.115, -0.940], 'metal', COL.steelBlack, [0.62, 0, 0]);
  b.cylZ(0.0120, 0.010, [0, 0.100, -0.950], 'metal', COL.steelBlack, 14);
  // 扳机组
  addTriggerGroup(b, {
    y: 0.020, z: -0.030, width: 0.026,
    outerW: 0.090, outerH: 0.058, holeW: 0.066, holeH: 0.038,
  });
  // 弹匣（弯弹匣，ExtrudeGeometry 轮廓 + 加强筋）
  b.profile('ak_mag', magShape(0.068, 0.062, 0.225, 0.055), 0.032,
    [0, 0.032, -0.100], 'metal', COL.steelDark, null, true);
  for (let i = 0; i < 3; i++) {
    b.box(0.032, 0.005, 0.008, [0, -0.030 - i * 0.062, -0.139 - i * 0.014], 'metal', COL.steelWorn, [0.16, 0, 0]);
  }
  for (const sx of [-1, 1]) {
    b.box(0.0024, 0.170, 0.014, [sx * 0.0165, -0.085, -0.130], 'metal', COL.steel, [0.20, 0, 0]);
  }
  b.box(0.034, 0.010, 0.064, [0, -0.196, -0.155], 'metal', COL.steelDark, null, true);
  b.box(0.010, 0.020, 0.014, [0, 0.026, -0.052], 'metal', COL.steelWorn);
  // 握把（胶木 + 防滑纹）
  b.rbox(0.042, 0.100, 0.056, 0.010, grip, 'wood', COL.bakelite, [A, 0, 0], true);
  b.rbox(0.038, 0.088, 0.010, 0.004, gripPoint(grip, A, 0, 0.0, -0.030), 'wood', COL.bakelite, [A, 0, 0]);
  for (let i = 0; i < 4; i++) {
    b.box(0.043, 0.0035, 0.007, gripPoint(grip, A, 0, 0.030 - i * 0.020, 0.030), 'wood', COL.woodDark, [A, 0, 0]);
  }
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      b.box(0.0022, 0.014, 0.034, gripPoint(grip, A, sx * 0.0215, 0.020 - i * 0.022, 0), 'wood', COL.woodDark, [A, 0, 0]);
    }
  }
  // 枪托（木 + 托底钢板 + 背带环 + 木纹）
  b.box(0.044, 0.050, 0.034, [0, 0.058, 0.048], 'wood', COL.woodDark);           // 机匣→枪托连接舌
  b.rbox(0.048, 0.080, 0.300, 0.012, [0, 0.040, 0.190], 'wood', COL.wood, [0.04, 0, 0], true);
  b.rbox(0.045, 0.030, 0.180, 0.010, [0, 0.078, 0.210], 'wood', COL.woodLight, [0.04, 0, 0]);
  b.box(0.050, 0.105, 0.020, [0, 0.030, 0.348], 'metal', COL.steelDark, [0.04, 0, 0], true);
  b.box(0.052, 0.020, 0.016, [0, 0.080, 0.350], 'metal', COL.steelWorn, [0.04, 0, 0]);
  b.box(0.0016, 0.070, 0.280, [0.0242, 0.042, 0.195], 'wood', COL.woodDark, [0.04, 0, 0]);
  b.box(0.0016, 0.070, 0.280, [-0.0242, 0.042, 0.195], 'wood', COL.woodDark, [0.04, 0, 0]);
  addSlingLoop(b, [-0.026, 0.030, 0.300], { radius: 0.010, axis: 'x' });
  for (const sx of [-1, 1]) addScrew(b, [sx * 0.0255, 0.045, 0.160], { axis: 'x', r: 0.003, len: 0.006 });
  // 机匣铆钉
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      addScrew(b, [sx * 0.0265, 0.050 + (i % 2) * 0.040, -0.050 - i * 0.070], { axis: 'x', r: 0.0026, len: 0.0055 });
    }
  }
  // 防尘盖锁扣
  b.box(0.012, 0.012, 0.020, [0, 0.112, 0.018], 'metal', COL.steelWorn);
  // 使用痕迹：机匣/防尘盖棱边
  for (const sx of [-1, 1]) {
    b.box(0.0012, 0.0022, 0.250, [sx * 0.0262, 0.110, -0.115], 'metal', COL.steelWorn);
    b.box(0.0012, 0.0018, 0.230, [sx * 0.0262, 0.032, -0.115], 'metal', COL.steelWorn);
  }
  b.box(0.048, 0.0012, 0.002, [0, 0.1268, -0.260], 'metal', COL.steelWorn);

  return {
    muzzle: [0, 0.100, -0.955],
    sightPoint: [0, 0.142, -0.208],
    sightType: 'iron',
    scopeLens: null,
    rightGrip: [0, -0.030, 0.052],
    leftGrip: [0, 0.058, -0.390],
    boltAxis: null,
    sprite: null,
  };
}

// ---- 5.4 霰弹枪（泵动 870 风格：木托 + 管式弹仓 + 珠形准星）----
function buildShotgun(b) {
  const A = -0.20;
  const grip = [0, 0.018, 0.062];

  // 机匣 / 抛壳口 / 枪机
  b.rbox(0.056, 0.072, 0.240, 0.010, [0, 0.091, -0.135], 'metal', COL.steel, null, true);
  addEjectionPort(b, { x: 0.0288, y: 0.105, z: -0.150, h: 0.024, d: 0.085 });
  b.cylZ(0.016, 0.050, [0, 0.108, -0.185], 'metal', COL.steelBright, 14);
  b.box(0.0045, 0.020, 0.030, [0.0288, 0.112, -0.210], 'metal', COL.steelBlack);   // 抛壳挺
  // 枪管（粗管 + 顶部瞄准肋 + 散热孔）
  b.cylZ(0.0165, 0.580, [0, 0.112, -0.550], 'metal', COL.steelBright, 18);
  b.box(0.010, 0.004, 0.540, [0, 0.130, -0.550], 'metal', COL.steelDark);
  for (let i = 0; i < 3; i++) b.box(0.005, 0.0025, 0.020, [0, 0.1325, -0.620 - i * 0.080], 'metal', COL.steelBlack);
  // 喉缩（带排气孔）
  b.cylZ(0.0172, 0.040, [0, 0.112, -0.855], 'metal', COL.steelWorn, 16);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    b.box(0.005, 0.005, 0.010, [Math.cos(a) * 0.0165, 0.112 + Math.sin(a) * 0.0165, -0.858],
      'metal', COL.steelBlack, [0, 0, a]);
  }
  b.cylZ(0.0125, 0.006, [0, 0.112, -0.877], 'metal', COL.steelBlack, 14);
  // 珠形准星（黄铜珠 + 底座）—— 光学轴线即“眼-准星珠”连线
  b.box(0.008, 0.004, 0.012, [0, 0.1315, -0.835], 'metal', COL.steelDark);
  b.sphere(0.0042, [0, 0.136, -0.835], 'metal', COL.brass);
  // 管式弹仓 + 端帽 + 背带环
  b.cylZ(0.0135, 0.500, [0, 0.080, -0.520], 'metal', COL.steelDark, 16);
  b.cylZ(0.0155, 0.030, [0, 0.080, -0.778], 'metal', COL.steelWorn, 14);
  b.cylZ(0.0105, 0.014, [0, 0.080, -0.795], 'metal', COL.steelBlack, 12);
  addSlingLoop(b, [0, 0.058, -0.795], { radius: 0.010, axis: 'y' });
  // 枪机连动杆（两根亮钢条）
  for (const sx of [-1, 1]) b.box(0.004, 0.008, 0.360, [sx * 0.020, 0.082, -0.430], 'metal', COL.steelBright);
  // 枪管/弹仓与护木之间的过渡箍
  b.box(0.046, 0.048, 0.022, [0, 0.086, -0.268], 'metal', COL.steelDark);
  // 泵动护木（木 + 防滑槽 + 前后箍）
  b.rbox(0.058, 0.060, 0.240, 0.014, [0, 0.072, -0.415], 'wood', COL.wood, null, true);
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      b.box(0.0025, 0.050, 0.010, [sx * 0.0288, 0.072, -0.375 - i * 0.034], 'wood', COL.woodDark);
    }
  }
  b.box(0.052, 0.050, 0.010, [0, 0.074, -0.523], 'metal', COL.steelDark);
  b.box(0.052, 0.050, 0.012, [0, 0.076, -0.300], 'metal', COL.steelDark);
  // 扳机组（护圈 + 扳机 + 横闩保险）
  addTriggerGroup(b, {
    y: 0.045, z: -0.030, width: 0.026,
    outerW: 0.100, outerH: 0.060, holeW: 0.074, holeH: 0.040,
  });
  b.cylX(0.004, 0.032, [0, 0.070, 0.004], 'metal', COL.steelWorn);
  b.box(0.028, 0.020, 0.060, [0, 0.062, -0.048], 'metal', COL.steelDark);
  // 枪托：腕托 + 托腮 + 托底橡胶（含缓冲垫沟槽）
  b.rbox(0.048, 0.082, 0.140, 0.012, [0, 0.020, 0.062], 'wood', COL.wood, [0.10, 0, 0], true);
  b.rbox(0.050, 0.095, 0.260, 0.014, [0, 0.020, 0.245], 'wood', COL.wood, [0.06, 0, 0], true);
  b.rbox(0.044, 0.030, 0.200, 0.010, [0, 0.082, 0.230], 'wood', COL.woodLight, [0.06, 0, 0]);
  b.rbox(0.052, 0.115, 0.022, 0.006, [0, 0.010, 0.382], 'polymer', COL.rubber, [0.06, 0, 0], true);
  for (let i = 0; i < 3; i++) b.box(0.054, 0.006, 0.008, [0, -0.020 + i * 0.030, 0.390], 'polymer', COL.steelBlack);
  b.box(0.0016, 0.080, 0.280, [0.0248, 0.030, 0.260], 'wood', COL.woodDark, [0.06, 0, 0]);
  b.box(0.0016, 0.080, 0.280, [-0.0248, 0.030, 0.260], 'wood', COL.woodDark, [0.06, 0, 0]);
  addSlingLoop(b, [0, -0.020, 0.300], { radius: 0.010, axis: 'x' });
  for (const sx of [-1, 1]) addScrew(b, [sx * 0.0262, 0.030, 0.170], { axis: 'x', r: 0.003, len: 0.006 });
  // 机匣顶部瞄准槽 + 螺钉
  b.box(0.012, 0.0025, 0.220, [0, 0.125, -0.120], 'metal', COL.steelBlack, null, true);
  for (const sx of [-1, 1]) {
    addScrew(b, [sx * 0.024, 0.112, -0.030], { axis: 'x', r: 0.0032, len: 0.0065 });
    addScrew(b, [sx * 0.024, 0.086, -0.220], { axis: 'x', r: 0.0028, len: 0.006 });
  }
  // 使用痕迹：机匣棱边 + 护木木纹亮线
  for (const sx of [-1, 1]) b.box(0.0012, 0.0022, 0.220, [sx * 0.0282, 0.118, -0.135], 'metal', COL.steelWorn);
  for (const sx of [-1, 1]) b.box(0.0012, 0.0020, 0.220, [sx * 0.0282, 0.056, -0.135], 'metal', COL.steelWorn);
  b.box(0.0016, 0.002, 0.220, [0.0292, 0.072, -0.415], 'wood', COL.woodLight);

  return {
    muzzle: [0, 0.112, -0.880],
    sightPoint: [0, 0.136, -0.060],
    sightType: 'iron',
    scopeLens: null,
    rightGrip: [0, 0.010, 0.075],
    leftGrip: [0, 0.045, -0.415],
    boltAxis: [0, 0, 1],
    sprite: { color: 0xd9f7b4, size: 0.008, position: [0, 0.136, -0.835] },
  };
}

// ---- 5.5 狙击枪（栓动 + 6 倍镜：镜筒/前后镜片/调节旋钮/镜桥/两脚架）----
function buildSniper(b) {
  const A = -0.28;
  const grip = [0, 0.012, 0.050];

  // 机匣 / 枪管（重型自由浮动枪管）
  b.rbox(0.048, 0.078, 0.330, 0.008, [0, 0.100, -0.100], 'metal', COL.steel, null, true);
  b.cylZ(0.0175, 0.680, [0, 0.108, -0.585], 'metal', COL.steelBright, 18);
  b.cylZ2(0.0185, 0.0150, 0.090, [0, 0.108, -0.300], 'metal', COL.steelDark, 16);
  for (const dx of [-0.013, 0, 0.013]) b.box(0.0022, 0.0035, 0.300, [dx, 0.1215, -0.700], 'metal', COL.steelDark); // 枪管开槽
  // 枪口制退器（旋转体 + 侧排气孔 + 前冠）
  b.latheZ('sn_brake', [
    [0, -0.040], [0.021, -0.040], [0.021, 0.020], [0.024, 0.026],
    [0.024, 0.036], [0, 0.036],
  ], [0, 0.108, -0.965], 'metal', COL.steelDark, 16, true);
  for (let i = 0; i < 3; i++) {
    b.box(0.026, 0.006, 0.010, [0, 0.108, -0.980 + i * 0.012], 'metal', COL.steelBlack);
  }
  b.cylZ(0.012, 0.010, [0, 0.108, -1.000], 'metal', COL.steelBlack, 14);
  // 抛壳口 + 枪机（右侧）
  addEjectionPort(b, { x: 0.0252, y: 0.112, z: -0.060, h: 0.022, d: 0.080 });
  b.cylZ(0.012, 0.160, [0, 0.108, -0.050], 'metal', COL.steelBright, 14);
  b.cylZ(0.014, 0.030, [0, 0.108, 0.055], 'metal', COL.steelDark, 14);
  // 拉机柄（后拉 + 球形柄头）
  b.box(0.045, 0.009, 0.012, [0.033, 0.108, 0.000], 'metal', COL.steelWorn, [0, 0.55, 0]);
  b.sphere(0.013, [0.058, 0.098, 0.032], 'metal', COL.steelDark);
  // 机匣顶部导轨 + 镜桥
  addRail(b, { y: 0.145, z: -0.100, length: 0.300, teeth: 14 });
  for (const rz of [-0.230, -0.090]) {
    b.box(0.026, 0.030, 0.020, [0, 0.152, rz], 'metal', COL.steelDark, null, true);
    b.torus(0.0245, 0.0045, [0, 0.170, rz], 'metal', COL.steelDark, null, true);
    for (const sx of [-1, 1]) addScrew(b, [sx * 0.014, 0.152, rz], { axis: 'y', r: 0.0028, len: 0.006 });
  }
  // 6 倍狙击镜：镜筒 / 物镜铃 / 目镜 / 前后镜片 / 内壁 / 变倍环 / 调节旋钮
  b.cylZ(0.0205, 0.250, [0, 0.170, -0.145], 'metal', COL.steelDark, 20);              // 镜筒
  b.cylZ2(0.0290, 0.0210, 0.085, [0, 0.170, -0.310], 'metal', COL.steelDark, 20);     // 物镜铃
  b.cylZ(0.0300, 0.010, [0, 0.170, -0.356], 'metal', COL.steelWorn, 20);               // 物镜前缘
  b.box(0.0025, 0.0022, 0.010, [0, 0.197, -0.356], 'metal', COL.steelWorn);            // 前缘磨亮
  b.cylZ(0.0260, 0.0030, [0, 0.170, -0.362], 'glass', COL.glass, 20, true);            // 前镜片
  b.cylZ(0.0185, 0.240, [0, 0.170, -0.190], 'polymer', COL.polymerBlack, 16);          // 镜筒内壁（暗）
  b.cylZ2(0.0235, 0.0205, 0.074, [0, 0.170, 0.017], 'metal', COL.steelDark, 20);       // 目镜
  b.cylZ(0.0250, 0.010, [0, 0.170, 0.056], 'metal', COL.steelWorn, 20);                // 目镜后缘
  b.cylZ(0.0200, 0.0030, [0, 0.170, 0.061], 'glass', COL.glass, 20, true);             // 后镜片
  b.torus(0.0245, 0.0035, [0, 0.170, 0.050], 'metal', COL.steelDark);                  // 屈光环
  b.cylZ(0.0235, 0.030, [0, 0.170, -0.030], 'metal', COL.steelWorn, 20);               // 变倍环
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    b.box(0.0035, 0.004, 0.026, [Math.cos(a) * 0.0235, 0.170 + Math.sin(a) * 0.0235, -0.030],
      'metal', COL.steelDark, [0, 0, a]);
  }
  b.box(0.014, 0.010, 0.030, [0.030, 0.170, -0.030], 'metal', COL.steelWorn, [0, 0, 0.2]); // 变倍拨杆
  b.cylY(0.0120, 0.018, [0, 0.192, -0.150], 'metal', COL.steelWorn, 14);               // 高低旋钮
  b.cylY(0.0085, 0.014, [0, 0.205, -0.150], 'metal', COL.steelDark, 12);
  b.cylX(0.0120, 0.018, [0.030, 0.170, -0.150], 'metal', COL.steelWorn, 14);           // 风偏旋钮
  b.cylX(0.0090, 0.012, [0.040, 0.170, -0.150], 'metal', COL.steelDark, 12);
  b.cylX(0.0110, 0.014, [-0.030, 0.170, -0.150], 'metal', COL.steelWorn, 14);          // 视差旋钮
  // 枪托（聚合物底盘 + 托腮 + 托底）
  b.rbox(0.042, 0.105, 0.055, 0.010, grip, 'polymer', COL.polymerOd, [A, 0, 0], true);
  b.rbox(0.038, 0.090, 0.010, 0.004, gripPoint(grip, A, 0, 0.0, -0.030), 'polymer', COL.polymerBlack, [A, 0, 0]);
  for (let i = 0; i < 4; i++) {
    b.box(0.043, 0.0035, 0.007, gripPoint(grip, A, 0, 0.032 - i * 0.020, 0.030), 'polymer', COL.polymerBlack, [A, 0, 0]);
  }
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      b.box(0.0022, 0.014, 0.032, gripPoint(grip, A, sx * 0.0215, 0.022 - i * 0.022, 0), 'polymer', COL.polymerBlack, [A, 0, 0]);
    }
  }
  b.rbox(0.050, 0.090, 0.320, 0.012, [0, 0.040, 0.250], 'polymer', COL.polymerOd, [0.05, 0, 0], true);
  b.rbox(0.040, 0.056, 0.085, 0.006, [0, 0.045, 0.070], 'polymer', COL.polymerOd, null, true);  // 底盘连接座（机匣→枪托）
  b.rbox(0.044, 0.032, 0.140, 0.008, [0, 0.098, 0.180], 'polymer', COL.polymerOd, [0.05, 0, 0], true);  // 托腮
  for (const dz of [-0.030, 0.030]) addScrew(b, [0.020, 0.098, 0.180 + dz], { axis: 'y', r: 0.003, len: 0.006 });
  b.rbox(0.052, 0.115, 0.020, 0.006, [0, 0.025, 0.418], 'polymer', COL.rubber, [0.05, 0, 0], true);
  for (let i = 0; i < 3; i++) b.box(0.054, 0.006, 0.008, [0, -0.005 + i * 0.030, 0.426], 'polymer', COL.steelBlack);
  // 前护木 + M-LOK 散热槽 + 下导轨
  b.rbox(0.058, 0.062, 0.340, 0.014, [0, 0.090, -0.440], 'polymer', COL.polymerOd, null, true);
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      b.box(0.0025, 0.010, 0.050, [sx * 0.0288, 0.090, -0.360 - i * 0.070], 'metal', COL.steelBlack);
    }
  }
  b.box(0.022, 0.005, 0.200, [0, 0.058, -0.440], 'metal', COL.steelDark);
  for (let i = 0; i < 5; i++) b.box(0.026, 0.004, 0.007, [0, 0.0545, -0.350 - i * 0.040], 'metal', COL.steel);
  // 两脚架（可折叠：腿 + 脚掌 + 转轴）
  b.box(0.022, 0.016, 0.020, [0, 0.052, -0.600], 'metal', COL.steelDark);
  for (const sx of [-1, 1]) {
    b.box(0.008, 0.110, 0.008, [sx * 0.030, 0.001, -0.600], 'metal', COL.steelDark, [0, 0, sx * 0.46]);
    b.box(0.006, 0.055, 0.006, [sx * 0.053, -0.052, -0.600], 'metal', COL.steelWorn, [0, 0, sx * 0.10]);
    b.box(0.016, 0.010, 0.022, [sx * 0.056, -0.080, -0.600], 'polymer', COL.rubber);
  }
  // AICS 弹匣 + 弹匣卡笋
  b.rbox(0.030, 0.095, 0.075, 0.004, [0, 0.0145, -0.100], 'metal', COL.steelDark, [0.08, 0, 0], true);
  b.box(0.032, 0.008, 0.078, [0, -0.037, -0.100], 'metal', COL.steelDark, [0.08, 0, 0]);
  b.box(0.010, 0.020, 0.012, [0, 0.052, -0.055], 'metal', COL.steelWorn);
  // 扳机组 + 枪托背带环
  addTriggerGroup(b, {
    y: 0.062, z: -0.020, width: 0.026,
    outerW: 0.095, outerH: 0.058, holeW: 0.070, holeH: 0.038,
  });
  b.box(0.012, 0.014, 0.070, [0, 0.062, 0.030], 'metal', COL.steelDark);             // 枪托连接座
  addSlingLoop(b, [0, 0.000, 0.330], { radius: 0.010, axis: 'x' });
  addSlingLoop(b, [-0.032, 0.075, -0.560], { radius: 0.010, axis: 'x' });
  // 机匣螺钉 / 使用痕迹
  for (const sx of [-1, 1]) {
    addScrew(b, [sx * 0.024, 0.075, 0.020], { axis: 'x', r: 0.0032, len: 0.0065 });
    b.box(0.0012, 0.0022, 0.300, [sx * 0.0245, 0.136, -0.100], 'metal', COL.steelWorn);
  }
  b.box(0.0012, 0.0022, 0.300, [0.0245, 0.064, -0.100], 'metal', COL.steelWorn);
  b.box(0.0012, 0.002, 0.180, [0.0298, 0.090, -0.440], 'polymer', COL.polymerBlack);

  return {
    muzzle: [0, 0.108, -1.005],
    sightPoint: [0, 0.170, -0.030],
    sightType: 'scope',
    scopeLens: [0, 0.170, -0.362],
    rightGrip: [0, -0.004, 0.058],
    leftGrip: [0, 0.055, -0.500],
    boltAxis: [0, 0, 1],
    sprite: null,
  };
}

const BUILDERS = {
  pistol: buildPistol,
  smg: buildSmg,
  ak47: buildAk47,
  shotgun: buildShotgun,
  sniper: buildSniper,
};

// ---------------------------------------------------------------------------
// 6. 合并 / 模板缓存
// ---------------------------------------------------------------------------

// 顶点级轻微色差（确定性，用来做金属不均与使用痕迹；禁止 Math.random）
function hash3(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

function paintVertexColor(geo, colorHex) {
  const c = new THREE.Color(colorHex);
  const posAttr = geo.attributes.position;
  const count = posAttr.count;
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const n = 1 + (hash3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)) - 0.5) * 0.055;
    arr[i * 3] = c.r * n;
    arr[i * 3 + 1] = c.g * n;
    arr[i * 3 + 2] = c.b * n;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
}

// 几何体包围盒体积（simple 模式据此只保留最大体块）
function geoVolume(geo) {
  if (!geo.boundingBox) geo.computeBoundingBox();
  const bb = geo.boundingBox;
  return (bb.max.x - bb.min.x) * (bb.max.y - bb.min.y) * (bb.max.z - bb.min.z);
}

// simple 模式：保留体积最大的若干零件（大块体优先）
function pickSimpleParts(parts, keep = 26) {
  const scored = parts.map((p, i) => ({ i, v: geoVolume(p.geo) + (p.major ? 0.0008 : 0) }));
  scored.sort((a, b) => b.v - a.v);
  return scored.slice(0, keep).map((o) => parts[o.i]);
}

// 把零件按材质合并成少量 Mesh；返回 [{ geometry, material }]
function mergeParts(parts, simple) {
  const groups = new Map();
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    // 几何缓存是共享的：先克隆（索引几何先转非索引）再应用变换
    const geo = part.geo.index ? part.geo.toNonIndexed() : part.geo.clone();
    geo.applyMatrix4(part.matrix);
    paintVertexColor(geo, part.color);
    const group = simple && part.mat === 'wood' ? 'polymer' : part.mat;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(geo);
  }
  const meshes = [];
  for (const [group, geos] of groups) {
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (!merged) continue;
    merged.computeBoundingSphere();
    meshes.push({ geometry: merged, material: getMaterial(group) });
  }
  return meshes;
}

// 零件列表缓存（每种枪只拼装一次，complex/simple 共用）
const partsCache = new Map();
function getParts(kind) {
  let entry = partsCache.get(kind);
  if (!entry) {
    const builder = new PartBuilder();
    const meta = BUILDERS[kind](builder);
    entry = { parts: builder.parts, meta };
    partsCache.set(kind, entry);
  }
  return entry;
}

// 模板缓存：key = kind|simple
const templateCache = new Map();
function getTemplate(kind, simple) {
  const key = `${kind}|${simple ? 'simple' : 'full'}`;
  let tpl = templateCache.get(key);
  if (tpl) return tpl;
  const { parts, meta } = getParts(kind);
  const used = simple ? pickSimpleParts(parts) : parts;
  const meshes = mergeParts(used, simple);
  let tri = 0;
  for (const m of meshes) tri += m.geometry.attributes.position.count / 3;
  tpl = {
    meshes,
    meta,
    partCount: used.length,
    totalParts: parts.length,
    triangleCount: tri,
    sprite: simple ? null : meta.sprite,
  };
  templateCache.set(key, tpl);
  return tpl;
}

// ---------------------------------------------------------------------------
// 7. 红点 sprite（程序化 DataTexture，不依赖 DOM，Node 里也能创建）
// ---------------------------------------------------------------------------

let dotTexture = null;
function getDotTexture() {
  if (dotTexture) return dotTexture;
  const size = 32;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size * 2 - 1;
      const dy = (y + 0.5) / size * 2 - 1;
      const r = Math.sqrt(dx * dx + dy * dy);
      // 中心实心亮核 + 柔和光晕
      const core = Math.max(0, 1 - r / 0.20);
      const glow = Math.max(0, 1 - r / 0.95) ** 2;
      const a = Math.min(1, core * core * 1.6 + glow * 0.55);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  dotTexture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  dotTexture.colorSpace = THREE.SRGBColorSpace;
  dotTexture.magFilter = THREE.LinearFilter;
  // 关键：不要生成 mipmap。红点在屏幕上往往只有几像素，
  // 一旦用 mipmap 过滤，亮核会被平均成接近透明，看起来"红点消失"。
  dotTexture.minFilter = THREE.LinearFilter;
  dotTexture.generateMipmaps = false;
  dotTexture.needsUpdate = true;
  return dotTexture;
}

const dotMatCache = new Map();

/**
 * 生成一个红点/光点 Sprite（加法混合，可关闭）。
 * @param {number} color 颜色
 * @param {number} size  sprite 直径（local 单位，未缩放）
 * @returns {THREE.Sprite}
 */
export function makeRedDotSprite(color = COL.dotRed, size = 0.010) {
  // 真实光学瞄具：镜片是一块圆形平面，由 optics.js 的光学 shader 逐像素显示
  // （独立相机渲染的镜内画面 + 桶形畸变 + 边缘色散 + 光学分划），
  // 不再使用"红点贴图 sprite"。size 作为镜片直径。
  const radius = Math.max(0.004, size * 0.5);
  const geo = new THREE.CircleGeometry(radius, 48);
  // 平面的显式材质，单位矩阵占位；真正的 shader 由 optics 绑定
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, depthTest: true,
    toneMapped: false, side: THREE.DoubleSide,
  });
  material.userData.isLens = true;
  dotMatCache.set(`${color}|${size}`, material);
  const mesh = new THREE.Mesh(geo, material);
  // 透明物体中最后绘制（高于枪身、低于 HUD），确保镜片画面不被枪身遮住
  mesh.renderOrder = 900;
  mesh.frustumCulled = false;
  mesh.name = 'redDotSprite';        // 保持既有命名，scope.js 兼容
  mesh.userData.isOpticLens = true;
  mesh.userData.reticleColor = color;
  mesh.userData.lensRadius = radius;
  return mesh;
}

/** 开关红点 sprite（Lead 在非开镜/切枪时可关闭） */
export function setRedDotVisible(group, visible) {
  const sprite = group && group.userData ? group.userData.redDotSprite : null;
  if (sprite) sprite.visible = !!visible;
}

// ---------------------------------------------------------------------------
// 8. 对外工厂
// ---------------------------------------------------------------------------

function toVec3(arr) {
  return arr ? new THREE.Vector3(arr[0], arr[1], arr[2]) : null;
}

/**
 * 创建武器模型。
 * @param {'pistol'|'smg'|'ak47'|'shotgun'|'sniper'} kind 武器 id
 * @param {{ firstPerson?: boolean, simple?: boolean }} opts
 *   firstPerson：整体缩放（0.66~0.75），几何坐标与 userData 保持未缩放一致；
 *   simple：只保留最大体块并合并，供第三人称/地面道具。
 * @returns {THREE.Group} group.userData 见 REMAKE_SPEC.md §6.2
 *
 * 世界坐标用法：userData 里的点是“未缩放 local”坐标，换算世界坐标请直接
 *   group.localToWorld(point.clone())
 * localToWorld 会一并应用 firstPerson 的 group.scale，不需要再手动乘缩放。
 */
export function createWeaponModel(kind, { firstPerson = false, simple = false } = {}) {
  const validKind = BUILDERS[kind] ? kind : 'pistol';
  const tpl = getTemplate(validKind, !!simple);
  const group = new THREE.Group();
  group.name = `weapon_${validKind}${simple ? '_simple' : ''}`;

  for (const m of tpl.meshes) {
    const mesh = new THREE.Mesh(m.geometry, m.material);
    mesh.castShadow = !firstPerson;
    mesh.receiveShadow = false;
    mesh.frustumCulled = !firstPerson;
    // 镜片放在不透明物体之后、红点 sprite 之前渲染，确保"透"得出来
    if (m.material && m.material.userData && m.material.userData.isLens) {
      mesh.renderOrder = 1;
      mesh.name = 'lens';
    }
    group.add(mesh);
  }

  // 红点 / 珠形光点 sprite（只在完整模型里出现；simple 不需要）
  let redDotSprite = null;
  if (tpl.sprite) {
    redDotSprite = makeRedDotSprite(tpl.sprite.color, tpl.sprite.size);
    redDotSprite.position.copy(toVec3(tpl.sprite.position));
    group.add(redDotSprite);
  }

  const meta = tpl.meta;
  const ud = {
    kind: validKind,
    requestedKind: kind,
    sightType: meta.sightType,
    muzzle: toVec3(meta.muzzle),
    sightPoint: toVec3(meta.sightPoint),
    scopeLens: meta.scopeLens ? toVec3(meta.scopeLens) : null,   // 狙击镜前镜片中心（PiP/遮罩定位）
    rightGrip: toVec3(meta.rightGrip),
    leftGrip: toVec3(meta.leftGrip),
    boltAxis: meta.boltAxis ? toVec3(meta.boltAxis) : null,      // 拉栓/泵动方向（单位向量，+Z = 向后）
    // 元信息（便于 Lead 做性能统计/调试）
    partCount: tpl.partCount,
    totalParts: tpl.totalParts,
    triangleCount: tpl.triangleCount,
    drawCalls: tpl.meshes.length + (redDotSprite ? 1 : 0),
    firstPerson: !!firstPerson,
    firstPersonScale: firstPerson ? FPS_SCALE[validKind] : 1,
    redDotSprite,
    redDot: redDotSprite,           // scope.js 约定字段（与 redDotSprite 是同一个对象）
    setRedDotVisible: (v) => { if (redDotSprite) redDotSprite.visible = !!v; },
  };
  group.userData = ud;

  // 第一人称：只缩放 group.scale，几何与 userData 坐标保持未缩放（契约要求）
  if (firstPerson) group.scale.setScalar(FPS_SCALE[validKind]);

  return group;
}
