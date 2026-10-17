// ===== 程序化角色模型：分段人形 + 骨骼式关节动画 =====
// 约定：模型面朝 -Z（与服务器 yaw 约定一致）；脚底 y=0，身高约 1.8m。
// 结构：root（外部设位置/朝向） → body（姿态：倒地/下蹲） → hips → 躯干/四肢关节树
// 性能：每个关节的部件按材质合并为单个 Mesh（多材质 groups），把 draw call 压到关节数量级。

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------- 材质缓存（同色同参数在所有角色间共享） ----------
const matCache = new Map();

function stdMat(color, opts = {}) {
  const key = `s${color}|${opts.roughness ?? 0.6}|${opts.metalness ?? 0.2}|${opts.emissive ?? 0}|${opts.emissiveIntensity ?? 0}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      roughness: opts.roughness ?? 0.6,
      metalness: opts.metalness ?? 0.2,
      emissive: opts.emissive ?? 0x000000,
      emissiveIntensity: opts.emissiveIntensity ?? 0,
    });
    matCache.set(key, m);
  }
  return m;
}

function basicMat(color) {
  const key = `b${color}`;
  let m = matCache.get(key);
  if (!m) { m = new THREE.MeshBasicMaterial({ color }); matCache.set(key, m); }
  return m;
}

const PALETTE = {
  armor: 0xe9eef6,   // 主装甲（浅）
  armorDark: 0xc3ccdb,
  suit: 0x49536b,    // 战术服（深）
  dark: 0x2c3346,    // 装备/靴/护具
};

const MAT = { ARMOR: 0, ARMOR_D: 1, SUIT: 2, DARK: 3, TEAM: 4, GLOW: 5 };

// ---------- 角色 ----------
export function createCharacter({ color = 0x7fc4f5 } = {}) {
  const root = new THREE.Group();
  const body = new THREE.Group();      // 姿态层（倒地/下蹲偏移）
  root.add(body);

  const MATS = [
    stdMat(PALETTE.armor, { roughness: 0.5, metalness: 0.3 }),
    stdMat(PALETTE.armorDark, { roughness: 0.55, metalness: 0.28 }),
    stdMat(PALETTE.suit, { roughness: 0.85, metalness: 0.08 }),
    stdMat(PALETTE.dark, { roughness: 0.7, metalness: 0.35 }),
    stdMat(color, { roughness: 0.45, metalness: 0.3, emissive: color, emissiveIntensity: 0.4 }),
    basicMat(color),
  ];

  // 部件先记录规格，构建结束后按关节合并成 Mesh
  const specs = new Map();   // 关节 Group -> 部件规格数组

  // 关节：只做旋转的空 Group，子件相对它偏移
  function joint(parent, x, y, z) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    parent.add(g);
    specs.set(g, []);
    return g;
  }

  // 部件：记录到所属关节（w/h/d、位置、材质索引、旋转）
  function part(parent, w, h, d, x, y, z, mat, rx = 0, rz = 0) {
    const list = specs.get(parent);
    if (list) list.push({ w, h, d, x, y, z, mat, rx, rz });
  }

  // 髋部（人体中轴，y≈0.92）
  const hips = joint(body, 0, 0.92, 0);
  part(hips, 0.42, 0.22, 0.26, 0, 0.0, 0, MAT.DARK);              // 骨盆护具
  part(hips, 0.30, 0.10, 0.20, 0, -0.06, 0.06, MAT.TEAM);         // 腿挂

  // 腿：髋 → 大腿 → 膝 → 小腿 → 脚
  const legs = {};
  for (const [name, s] of [['L', -1], ['R', 1]]) {
    const hip = joint(hips, s * 0.13, -0.08, 0);
    part(hip, 0.18, 0.46, 0.20, 0, -0.23, 0, MAT.SUIT);           // 大腿
    part(hip, 0.20, 0.11, 0.22, 0, -0.42, 0.01, MAT.DARK);        // 护膝
    const knee = joint(hip, 0, -0.46, 0);
    part(knee, 0.16, 0.42, 0.18, 0, -0.21, 0, MAT.SUIT);          // 小腿
    part(knee, 0.18, 0.10, 0.30, 0, -0.38, 0.04, MAT.DARK);       // 战术靴
    part(knee, 0.17, 0.05, 0.06, 0, -0.30, 0.10, MAT.TEAM);       // 靴扣
    legs[name] = { hip, knee };
  }

  // 躯干：腰 → 胸（含肩甲/背包）
  const waist = joint(hips, 0, 0.08, 0);
  part(waist, 0.40, 0.26, 0.25, 0, 0.13, 0, MAT.SUIT);            // 腹
  part(waist, 0.44, 0.08, 0.28, 0, 0.02, 0, MAT.DARK);            // 腰带

  const chest = joint(waist, 0, 0.30, 0);
  part(chest, 0.46, 0.36, 0.28, 0, 0.15, 0, MAT.ARMOR);           // 胸甲
  part(chest, 0.34, 0.24, 0.12, 0, 0.13, 0.15, MAT.TEAM);         // 胸挂弹匣袋
  part(chest, 0.10, 0.10, 0.05, 0, 0.22, 0.18, MAT.GLOW);         // 胸灯
  part(chest, 0.34, 0.36, 0.15, 0, 0.13, -0.22, MAT.DARK);        // 背包
  part(chest, 0.10, 0.14, 0.08, -0.11, 0.10, -0.30, MAT.TEAM);    // 背包指示灯
  part(chest, 0.10, 0.14, 0.08, 0.11, 0.10, -0.30, MAT.TEAM);
  for (const s of [-1, 1]) {
    part(chest, 0.22, 0.15, 0.32, s * 0.28, 0.30, 0, MAT.TEAM, 0, s * 0.34);   // 倾斜肩甲
  }

  // 头：颈 → 头盔 + 护目镜
  const neck = joint(chest, 0, 0.36, 0);
  part(neck, 0.14, 0.09, 0.14, 0, 0.04, 0, MAT.DARK);
  const head = joint(neck, 0, 0.11, 0);
  part(head, 0.25, 0.24, 0.27, 0, 0.12, 0, MAT.ARMOR);            // 头盔
  part(head, 0.27, 0.06, 0.12, 0, 0.21, -0.03, MAT.ARMOR_D);      // 盔檐
  part(head, 0.21, 0.08, 0.04, 0, 0.14, 0.135, MAT.GLOW);         // 护目镜（发光）
  part(head, 0.08, 0.07, 0.06, -0.13, 0.11, 0.02, MAT.DARK);      // 耳侧通讯器
  part(head, 0.05, 0.03, 0.10, 0.13, 0.15, 0.02, MAT.DARK);       // 天线座

  // 手臂：肩 → 上臂 → 肘 → 前臂 → 手（右手为持枪手）
  const arms = {};
  for (const [name, s] of [['L', -1], ['R', 1]]) {
    const shoulder = joint(chest, s * 0.27, 0.28, 0);
    part(shoulder, 0.14, 0.30, 0.15, 0, -0.15, 0, MAT.ARMOR);     // 上臂
    part(shoulder, 0.15, 0.07, 0.16, 0, -0.03, 0, MAT.ARMOR_D);   // 臂环
    const elbow = joint(shoulder, 0, -0.30, 0);
    part(elbow, 0.12, 0.28, 0.13, 0, -0.14, 0, MAT.SUIT);         // 前臂
    part(elbow, 0.13, 0.09, 0.14, 0, -0.02, 0, MAT.DARK);         // 护腕
    const hand = joint(elbow, 0, -0.28, 0);
    part(hand, 0.11, 0.11, 0.13, 0, -0.04, 0.02, MAT.DARK);       // 手/手套
    arms[name] = { shoulder, elbow, hand };
  }

  // ---------- 合并：每个关节一个 Mesh（按材质分组） ----------
  const _euler = new THREE.Euler();
  const _m4 = new THREE.Matrix4();
  for (const [group, list] of specs) {
    if (!list.length) continue;
    const perMat = new Map();
    for (const p of list) {
      const g = new THREE.BoxGeometry(p.w, p.h, p.d);
      _euler.set(p.rx, 0, p.rz);
      _m4.makeRotationFromEuler(_euler);
      _m4.setPosition(p.x, p.y, p.z);
      g.applyMatrix4(_m4);
      if (!perMat.has(p.mat)) perMat.set(p.mat, []);
      perMat.get(p.mat).push(g);
    }
    const geos = [];
    const mats = [];
    for (const [mi, gs] of perMat) {
      geos.push(gs.length === 1 ? gs[0] : mergeGeometries(gs, false));
      mats.push(MATS[mi]);
    }
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, true);
    const mesh = new THREE.Mesh(merged, mats.length === 1 ? mats[0] : mats);
    mesh.castShadow = true;
    group.add(mesh);
  }

  // ---------- 动画状态 ----------
  let phase = Math.random() * Math.PI * 2;   // 步态相位（错开，避免整齐划一）
  let breath = Math.random() * Math.PI * 2;
  let landTimer = 0;
  let wasGrounded = true;
  let deathT = 0;
  let deathDir = 1;
  let weaponNode = null;

  const state = { speed: 0, grounded: true, alive: true, aiming: false, dt: 0 };

  // 持枪手挂载武器模型（武器局部约定：握把在原点，枪口朝 -Z）
  function attachWeapon(group) {
    if (weaponNode && weaponNode.parent) weaponNode.parent.remove(weaponNode);
    weaponNode = group || null;
    if (weaponNode) {
      weaponNode.position.set(0, -0.06, 0.02);
      // 手臂各段已前倾，这里反向补偿让枪口保持水平朝前
      weaponNode.rotation.set(-1.42, 0, 0);
      arms.R.hand.add(weaponNode);
    }
  }

  const easeOut = (t) => 1 - (1 - t) * (1 - t);

  function update(st, dt) {
    Object.assign(state, st);
    const d = Math.min(dt, 0.1);

    // ---- 死亡：侧倒 + 下沉 ----
    if (!state.alive) {
      if (deathT === 0) deathDir = Math.random() < 0.5 ? -1 : 1;
      deathT = Math.min(1, deathT + d * 2.4);
      const k = easeOut(deathT);
      body.rotation.z = k * (Math.PI / 2) * deathDir;
      body.position.y = -0.62 * k;
      // 四肢松垂
      arms.L.shoulder.rotation.x = 0.6 * k;
      arms.R.shoulder.rotation.x = 0.4 * k;
      arms.L.elbow.rotation.x = 0.3 * k;
      arms.R.elbow.rotation.x = 0.3 * k;
      legs.L.hip.rotation.x = -0.3 * k;
      legs.R.hip.rotation.x = 0.2 * k;
      legs.L.knee.rotation.x = -0.5 * k;
      legs.R.knee.rotation.x = -0.3 * k;
      return;
    }
    if (deathT > 0) {   // 重生：复位
      deathT = 0;
      body.rotation.z = 0;
      body.position.y = 0;
    }

    // ---- 落地缓冲 ----
    if (state.grounded && !wasGrounded) landTimer = 0.18;
    wasGrounded = state.grounded;
    if (landTimer > 0) landTimer = Math.max(0, landTimer - d);
    const landDip = landTimer > 0 ? Math.sin((landTimer / 0.18) * Math.PI) * 0.14 : 0;

    // ---- 步态 ----
    const sp = Math.min(Math.max(state.speed || 0, 0), 14);
    const moving = sp > 0.4 && state.grounded;
    const amp = Math.min(sp / 9, 1);
    breath += d * 1.6;
    if (moving) phase += d * (3.2 + sp * 0.85);
    else phase += d * 1.2;

    const swing = Math.sin(phase) * 0.72 * amp;
    const bob = moving ? Math.abs(Math.sin(phase)) * 0.045 * amp : Math.sin(breath) * 0.012;

    body.position.y = -landDip + bob;
    waist.rotation.y = -Math.sin(phase) * 0.10 * amp;   // 躯干随步伐轻扭
    waist.rotation.x = 0.06 * amp + (state.aiming ? 0.05 : 0);

    // 腿
    if (!state.grounded) {
      // 空中：前腿收、后腿蹬
      legs.L.hip.rotation.x = 0.55;
      legs.L.knee.rotation.x = -0.95;
      legs.R.hip.rotation.x = -0.30;
      legs.R.knee.rotation.x = -0.45;
    } else {
      legs.L.hip.rotation.x = swing;
      legs.R.hip.rotation.x = -swing;
      legs.L.knee.rotation.x = -0.12 - Math.max(0, swing) * 0.95 - amp * 0.08;
      legs.R.knee.rotation.x = -0.12 - Math.max(0, -swing) * 0.95 - amp * 0.08;
    }

    // 手臂：持枪姿态 + 走动摆臂
    const aim = state.aiming ? 1 : 0;
    const walkArm = Math.sin(phase + Math.PI) * 0.28 * amp;
    // 右手（持枪手）：上臂略前，前臂端平
    arms.R.shoulder.rotation.x = 0.34 + walkArm * 0.35 - aim * 0.06;
    arms.R.shoulder.rotation.z = -0.16 + aim * 0.10;
    arms.R.elbow.rotation.x = 1.16 + aim * 0.06;
    arms.R.elbow.rotation.z = 0.10 - aim * 0.06;
    // 左手：扶护木，ADS 时收拢
    arms.L.shoulder.rotation.x = 0.72 + walkArm * 0.3 + aim * 0.16;
    arms.L.shoulder.rotation.z = 0.42 - aim * 0.30;
    arms.L.elbow.rotation.x = 1.24 + aim * 0.14;
    arms.L.elbow.rotation.z = -0.34 + aim * 0.26;

    // 头：跑步轻晃，ADS 微前倾
    head.rotation.x = -0.04 * amp + aim * 0.06;
    head.rotation.y = Math.sin(phase) * 0.03 * amp;
  }

  return { root, body, head, joints: { hips, waist, chest, ...legs, ...arms }, attachWeapon, update, state };
}
