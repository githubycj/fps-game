// ===== 程序化写实士兵：分段建模 + 关节树 + 双骨骼 IK + 战术动作 =====
// 契约见 REMAKE_SPEC.md §6.3：
//   createCharacter({ color, team, variant }) -> { root, head, update(state, dt), attachWeapon(group), dispose() }
// 约定：
//   * 模型面朝 -Z，脚底 y = 0，身高约 1.8m；root 的 yaw 由外部（main.js）设置。
//   * 武器小组直接挂在 root 的 weaponParent 上，本地只绕 X 轴旋转 pitch（+ 后坐），
//     从而保证「枪口方向 = root yaw + pitch」，绝不斜举/倒持。
//   * 双手通过两骨 IK 吸附到武器 userData.rightGrip / leftGrip（缺失时用备用点）。
//   * 每个可见关节只挂 1 个合并 Mesh，且共用同一个顶点色材质 —— 每角色 12 个 draw call。
//   * update 内复用临时向量/四元数/矩阵，不分配临时对象；dt 钳制，死亡后静止。

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------------------
// 尺寸常量（单位 m）
// ---------------------------------------------------------------------------
const HIP_Y = 0.965;          // 髋关节高度（站立）
const WAIST_Y = 0.10;         // 髋 -> 脊柱
const CHEST_Y = 0.215;        // 脊柱 -> 胸
const NECK_Y = 0.215;         // 胸 -> 颈
const HEAD_Y = 0.085;         // 颈 -> 头
const SHOULDER_X = 0.20;      // 肩关节左右偏移
const SHOULDER_Y = 0.165;     // 肩关节相对胸骨高度
const UPPER_ARM_LEN = 0.30;   // 上臂（肩 -> 肘）
const FOREARM_LEN = 0.28;     // 前臂（肘 -> 腕）
const ARM_REACH = (UPPER_ARM_LEN + FOREARM_LEN) * 0.96; // 手臂有效可及半径（留肘部弯曲余量）
const THIGH_LEN = 0.47;       // 大腿（髋 -> 膝）
const SHIN_LEN = 0.43;        // 小腿（膝 -> 踝）
const ANKLE_Y = 0.057;        // 站立时踝关节离地高度（= 鞋底厚度）
const FOOT_X = 0.115;         // 双脚横向间距
const RELOAD_TIME = 2.0;      // 换弹循环时长（秒）

// 每角色最多 12 个 draw call：髋 / 胸 / 头 / 双侧大腿 / 双侧小腿 / 双侧上臂 / 双侧前臂 / 双靴（InstancedMesh）
const MAX_DRAW_CALLS = 12;

// ---------------------------------------------------------------------------
// 顶点色材质（所有角色共享；颜色写进几何体顶点色，因此每关节只需 1 个材质/1 次绘制）
// 注意：共享材质在 dispose 时不能释放，避免影响其它角色。
// ---------------------------------------------------------------------------
const CHARACTER_MATERIAL = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.74,
  metalness: 0.18,
});

// 队伍色：只用在这三处 —— 上臂臂章、头盔条纹、背包指示灯
const TEAM_COLORS = {
  alpha: 0x3fc9dd, // 蓝青
  bravo: 0xe2613a, // 红橙
};

// ---------------------------------------------------------------------------
// 调色板：主色灰绿/沙色迷彩，队伍色只做点缀
// ---------------------------------------------------------------------------
function makePalette(teamKey, variant, color) {
  let uniform = 0x6b6d59;
  let uniformDark = 0x545645;
  let vest = 0x7d7b62;
  let vestDark = 0x5e5c49;
  let helmet = 0x8b8569;
  let pack = 0x5c5c47;
  if (variant === 1) {
    // 沙色变体
    uniform = 0x908a70;
    uniformDark = 0x6f6b56;
    vest = 0x9a9275;
    vestDark = 0x726d57;
    helmet = 0xa49b7b;
    pack = 0x7b755b;
  } else if (variant === 2) {
    // 深灰绿变体
    uniform = 0x5b6150;
    uniformDark = 0x464b3e;
    vest = 0x696d54;
    vestDark = 0x4f523e;
    helmet = 0x75785e;
    pack = 0x4e5340;
  }
  const patch = new THREE.Color(color);
  patch.lerp(new THREE.Color(0x8a8166), 0.45); // 个人色做旧，避免霓虹感
  return {
    uniform,
    uniformDark,
    vest,
    vestDark,
    pouch: 0x8b8265,
    belt: 0x46433a,
    dark: 0x35362f,
    boot: 0x3d392f,
    bootDark: 0x2f2c25,
    sole: 0x26241f,
    glove: 0x30322c,
    helmet,
    helmetDark: 0x6b6650,
    mask: 0x4b4d42,
    maskDark: 0x383a32,
    visor: 0x2b3a3d,
    metal: 0x6a6e70,
    skin: 0x9c7f60,
    pack,
    packDark: 0x46483a,
    laces: 0x22211c,
    team: TEAM_COLORS[teamKey],
    patch: patch.getHex(),
  };
}

// ---------------------------------------------------------------------------
// 几何体工具：建几何 -> 变换 -> 刷顶点色 -> 放进关节桶
// ---------------------------------------------------------------------------
const _geoEuler = new THREE.Euler();
const _geoMatrix = new THREE.Matrix4();
const _geoColor = new THREE.Color();

function paintGeometry(geo, hex) {
  _geoColor.set(hex);
  const count = geo.attributes.position.count;
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    arr[i * 3] = _geoColor.r;
    arr[i * 3 + 1] = _geoColor.g;
    arr[i * 3 + 2] = _geoColor.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function placeGeometry(geo, x, y, z, rx = 0, ry = 0, rz = 0) {
  _geoEuler.set(rx, ry, rz);
  _geoMatrix.makeRotationFromEuler(_geoEuler);
  _geoMatrix.setPosition(x, y, z);
  geo.applyMatrix4(_geoMatrix);
  return geo;
}

function addBox(bucket, w, h, d, hex, x, y, z, rx = 0, ry = 0, rz = 0) {
  bucket.push(paintGeometry(placeGeometry(new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz), hex));
}

function addCyl(bucket, rTop, rBottom, height, segments, hex, x, y, z, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.CylinderGeometry(rTop, rBottom, height, segments);
  bucket.push(paintGeometry(placeGeometry(g, x, y, z, rx, ry, rz), hex));
}

function addSphere(bucket, radius, wSeg, hSeg, hex, x, y, z, sx = 1, sy = 1, sz = 1) {
  const g = new THREE.SphereGeometry(radius, wSeg, hSeg);
  g.scale(sx, sy, sz);
  bucket.push(paintGeometry(placeGeometry(g, x, y, z), hex));
}

function mergeBucket(list) {
  if (!list || list.length === 0) return null;
  if (list.length === 1) return list[0];
  let merged = null;
  try {
    merged = mergeGeometries(list, false);
  } catch (err) {
    merged = null;
  }
  if (!merged) {
    // 极端兜底：合并失败就只留第一块，保证不崩溃
    for (let i = 1; i < list.length; i++) list[i].dispose();
    return list[0];
  }
  for (const g of list) g.dispose();
  return merged;
}

// ---------------------------------------------------------------------------
// 士兵几何体：按关节桶组装（头盔/护目镜/面罩、防弹背心/弹匣袋、护膝护肘、战术靴、背包、手套、腰带）
// ---------------------------------------------------------------------------
function buildBodyParts(C, variant) {
  const b = {
    hips: [],
    chest: [],
    head: [],
    thighL: [],
    thighR: [],
    shinL: [],
    shinR: [],
    armUpperL: [],
    armUpperR: [],
    armForeL: [],
    armForeR: [],
  };

  // ---------- 髋部 / 腰带 ----------
  addBox(b.hips, 0.30, 0.17, 0.21, C.uniformDark, 0, -0.01, 0);
  addBox(b.hips, 0.33, 0.06, 0.225, C.belt, 0, 0.055, 0);
  addBox(b.hips, 0.055, 0.045, 0.02, C.metal, 0, 0.055, -0.118);
  addBox(b.hips, 0.16, 0.10, 0.05, C.vestDark, 0, -0.03, -0.105); // 前挡片
  addBox(b.hips, 0.12, 0.08, 0.05, C.pouch, 0, 0.0, 0.115);       // 后腰包
  for (const s of [-1, 1]) {
    addBox(b.hips, 0.085, 0.10, 0.065, C.pouch, s * 0.19, -0.01, 0.01); // 侧腰弹匣袋
  }
  if (variant === 2) addBox(b.hips, 0.10, 0.07, 0.06, C.dark, 0.16, -0.03, -0.10); // 变体：腰侧手枪套

  // ---------- 胸部 / 防弹背心 / 背包 ----------
  addBox(b.chest, 0.30, 0.19, 0.20, C.uniform, 0, -0.03, 0);          // 下腹
  addBox(b.chest, 0.33, 0.28, 0.215, C.uniform, 0, 0.10, 0);          // 胸廓
  addBox(b.chest, 0.365, 0.235, 0.075, C.vest, 0, 0.095, -0.125);     // 前防弹插板
  addBox(b.chest, 0.35, 0.26, 0.07, C.vestDark, 0, 0.10, 0.115);      // 后插板
  for (let i = -1; i <= 1; i++) {
    addBox(b.chest, 0.085, 0.105, 0.055, C.pouch, i * 0.105, 0.0, -0.175);  // 胸前弹匣袋
    addBox(b.chest, 0.09, 0.03, 0.06, C.vestDark, i * 0.105, 0.065, -0.176); // 袋盖
  }
  addBox(b.chest, 0.12, 0.06, 0.05, C.pouch, 0.125, 0.165, -0.15);    // 杂物袋
  addBox(b.chest, 0.07, 0.11, 0.05, C.pouch, -0.155, 0.13, -0.145);   // 电台袋
  for (const s of [-1, 1]) {
    addBox(b.chest, 0.06, 0.25, 0.045, C.vestDark, s * 0.105, 0.15, -0.11); // 肩带
  }
  addBox(b.chest, 0.19, 0.06, 0.19, C.uniformDark, 0, 0.255, 0);      // 领口
  addCyl(b.chest, 0.055, 0.06, 0.10, 8, C.skin, 0, 0.27, 0.005);      // 脖颈
  for (const s of [-1, 1]) {
    addBox(b.chest, 0.13, 0.075, 0.20, C.vestDark, s * 0.205, 0.165, 0, 0, 0, s * 0.22); // 肩甲
  }
  // 背包
  addBox(b.chest, 0.27, 0.31, 0.13, C.pack, 0, 0.11, 0.235);
  addBox(b.chest, 0.275, 0.06, 0.145, C.packDark, 0, 0.285, 0.235);
  for (const s of [-1, 1]) {
    addBox(b.chest, 0.055, 0.13, 0.10, C.packDark, s * 0.165, 0.075, 0.235);
  }
  addCyl(b.chest, 0.008, 0.008, 0.24, 5, C.metal, -0.115, 0.35, 0.245); // 电台天线
  // 背包小灯（队伍色 2/3）
  for (const s of [-1, 1]) {
    addBox(b.chest, 0.022, 0.04, 0.014, C.team, s * 0.095, 0.165, 0.303);
  }
  // 个人色贴布（ID 识别，不参与队伍色）
  addBox(b.chest, 0.05, 0.032, 0.012, C.patch, 0.115, 0.19, -0.172);
  if (variant === 1) addBox(b.chest, 0.06, 0.09, 0.04, C.pouch, -0.17, 0.02, -0.14); // 变体：副弹药包

  // ---------- 头部：面罩 / 护目镜 / 头盔 ----------
  addBox(b.head, 0.155, 0.17, 0.165, C.mask, 0, 0.07, 0);             // 头/头套
  addBox(b.head, 0.135, 0.075, 0.05, C.maskDark, 0, 0.035, -0.075);   // 下半脸面罩
  addBox(b.head, 0.08, 0.05, 0.045, C.dark, 0, 0.015, -0.095);        // 呼吸器主体
  addCyl(b.head, 0.022, 0.022, 0.03, 8, C.metal, 0, 0.005, -0.117, Math.PI / 2, 0, 0);
  addBox(b.head, 0.17, 0.065, 0.025, C.dark, 0, 0.105, -0.082);       // 护目镜框
  addBox(b.head, 0.155, 0.05, 0.03, C.visor, 0, 0.105, -0.094);       // 镜片
  for (const s of [-1, 1]) {
    addBox(b.head, 0.025, 0.035, 0.16, C.dark, s * 0.085, 0.10, 0.01); // 镜腿
    addBox(b.head, 0.03, 0.055, 0.06, C.dark, s * 0.13, 0.075, 0.005); // 耳麦
  }
  addBox(b.head, 0.17, 0.025, 0.03, C.dark, 0, 0.10, 0.09);           // 后绑带
  // 头盔（压扁球体）+ 盔檐 + 导轨 + NVG 座
  addSphere(b.head, 0.13, 14, 10, C.helmet, 0, 0.115, 0.005, 1.06, 0.88, 1.16);
  addBox(b.head, 0.235, 0.025, 0.07, C.helmetDark, 0, 0.062, -0.115);
  for (const s of [-1, 1]) {
    addBox(b.head, 0.02, 0.03, 0.16, C.dark, s * 0.135, 0.12, 0.005);
  }
  addBox(b.head, 0.045, 0.04, 0.03, C.metal, 0, 0.155, -0.12);
  addCyl(b.head, 0.028, 0.028, 0.035, 8, C.visor, 0, 0.155, -0.145, Math.PI / 2, 0, 0);
  // 头盔队伍色条纹（三段贴弧面，队伍色 1/3）
  addBox(b.head, 0.032, 0.012, 0.11, C.team, 0, 0.231, 0.005);
  addBox(b.head, 0.032, 0.012, 0.07, C.team, 0, 0.219, -0.105, -0.5, 0, 0);
  addBox(b.head, 0.032, 0.012, 0.07, C.team, 0, 0.219, 0.115, 0.5, 0, 0);
  if (variant === 2) addBox(b.head, 0.09, 0.03, 0.02, C.helmetDark, 0, 0.19, 0.125); // 变体：盔后配重块

  // ---------- 双腿 ----------
  for (const s of [-1, 1]) {
    const thighBucket = s < 0 ? b.thighL : b.thighR;
    const shinBucket = s < 0 ? b.shinL : b.shinR;
    // 大腿
    addCyl(thighBucket, 0.075, 0.067, 0.40, 8, C.uniform, 0, -0.235, 0);
    addBox(thighBucket, 0.132, 0.04, 0.135, C.belt, 0, -0.30, 0);          // 大腿绑带
    addBox(thighBucket, 0.075, 0.12, 0.06, C.pouch, s * 0.095, -0.27, 0.005); // 腿包
    addBox(thighBucket, 0.118, 0.095, 0.10, C.dark, 0, -0.43, -0.045);     // 护膝
    addBox(thighBucket, 0.09, 0.03, 0.03, C.metal, 0, -0.43, -0.10);       // 护膝扣
    // 小腿
    addCyl(shinBucket, 0.062, 0.048, 0.36, 8, C.uniformDark, 0, -0.20, 0);
    addBox(shinBucket, 0.088, 0.24, 0.05, C.dark, 0, -0.19, -0.055);       // 护胫
    addBox(shinBucket, 0.105, 0.09, 0.125, C.boot, 0, -0.385, -0.01);      // 靴筒
    addBox(shinBucket, 0.11, 0.025, 0.12, C.bootDark, 0, -0.415, -0.005);  // 靴口
    addBox(shinBucket, 0.115, 0.02, 0.115, C.belt, 0, -0.34, 0);           // 绑带
  }

  // ---------- 双臂 ----------
  for (const s of [-1, 1]) {
    const upperBucket = s < 0 ? b.armUpperL : b.armUpperR;
    const foreBucket = s < 0 ? b.armForeL : b.armForeR;
    // 上臂
    addCyl(upperBucket, 0.055, 0.047, 0.27, 8, C.uniform, 0, -0.145, 0);
    addBox(upperBucket, 0.095, 0.075, 0.11, C.vestDark, 0, -0.005, 0);     // 肩甲片
    addCyl(upperBucket, 0.059, 0.059, 0.045, 8, C.team, 0, -0.205, 0);     // 队伍色臂章（2/3）
    addBox(upperBucket, 0.088, 0.06, 0.085, C.dark, 0, -0.275, 0.008);     // 护肘
    // 前臂 + 手套
    addCyl(foreBucket, 0.043, 0.036, 0.24, 8, C.uniformDark, 0, -0.125, 0);
    addBox(foreBucket, 0.078, 0.04, 0.078, C.belt, 0, -0.245, 0);          // 腕带
    addBox(foreBucket, 0.075, 0.095, 0.10, C.glove, 0, -0.30, -0.005);     // 手套
    addBox(foreBucket, 0.068, 0.035, 0.055, C.dark, 0, -0.335, -0.045, 0.5, 0, 0); // 手指（半握）
  }

  return b;
}

// 战术靴（以踝关节为原点；两脚共用同一几何体，用 InstancedMesh 合成 1 次 draw call）
function buildFootGeometry(C) {
  const list = [];
  addBox(list, 0.115, 0.05, 0.30, C.sole, 0, -0.032, -0.055);   // 鞋底
  addBox(list, 0.11, 0.075, 0.24, C.boot, 0, 0.005, -0.045);    // 靴身
  addBox(list, 0.10, 0.06, 0.10, C.bootDark, 0, -0.008, -0.155); // 鞋头包
  addBox(list, 0.095, 0.05, 0.07, C.sole, 0, -0.024, 0.085);    // 后跟
  addBox(list, 0.08, 0.012, 0.09, C.laces, 0, 0.043, -0.06);    // 鞋带面
  addBox(list, 0.10, 0.02, 0.06, C.bootDark, 0, 0.037, 0.055);  // 靴口后帮
  return mergeBucket(list);
}

// ---------------------------------------------------------------------------
// 动画/IK 临时量（模块级复用，避免每帧分配）
// ---------------------------------------------------------------------------
const DOWN = new THREE.Vector3(0, -1, 0);
const AXIS_X = new THREE.Vector3(1, 0, 0);
const ONE = new THREE.Vector3(1, 1, 1);

const _ikDir = new THREE.Vector3();
const _ikPole = new THREE.Vector3();
const _ikReach = new THREE.Vector3();
const _ikElbow = new THREE.Vector3();
const _ikDirA = new THREE.Vector3();
const _ikDirB = new THREE.Vector3();
const _ikWrist = new THREE.Vector3();
const _ikQa = new THREE.Quaternion();
const _ikQb = new THREE.Quaternion();
const _ikQp = new THREE.Quaternion();
const _ikLowerQuat = new THREE.Quaternion();

const _rootQ = new THREE.Quaternion();
const _hipsQ = new THREE.Quaternion();
const _chestQ = new THREE.Quaternion();
const _qTmp = new THREE.Quaternion();
const _toeQ = new THREE.Quaternion();
const _footQ = new THREE.Quaternion();
const _rootInv = new THREE.Matrix4();
const _footMat = new THREE.Matrix4();
const _instMat = new THREE.Matrix4();
const _rootLocal = new THREE.Vector3();
const _thighPos = new THREE.Vector3();
const _shoulderPos = new THREE.Vector3();
const _gripR = new THREE.Vector3();
const _gripL = new THREE.Vector3();
const _reloadLocal = new THREE.Vector3();
const _reloadWorld = new THREE.Vector3();
const _armTarget = new THREE.Vector3();
const _wristOffset = new THREE.Vector3();
const _weaponQ = new THREE.Quaternion();
const _weaponAxis = new THREE.Vector3();
const _fitDir = new THREE.Vector3();
const _poleV = new THREE.Vector3();
const _hipToTarget = new THREE.Vector3();
const _footPos = new THREE.Vector3();
const _footQuat = new THREE.Quaternion();

/**
 * 两骨 IK：把 upperJoint/lowerJoint 的世界朝向解算到 target。
 * 余弦定理求肘/膝位置，pole 向量控制弯曲方向，避免翻肘/反关节。
 * @returns {THREE.Quaternion} lowerJoint 的世界四元数（供脚掌/手部朝向使用）
 */
function solveTwoBoneIK(upperJoint, lowerJoint, parentWorldQuat, rootPos, target, poleDir, lenA, lenB) {
  _ikDir.copy(target).sub(rootPos);
  let dist = _ikDir.length();
  if (dist < 1e-5) {
    _ikDir.set(0, -1, 0);
    dist = 1e-5;
  } else {
    _ikDir.multiplyScalar(1 / dist);
  }
  const maxDist = (lenA + lenB) * 0.999;
  const minDist = Math.abs(lenA - lenB) + 0.02;
  if (dist > maxDist) dist = maxDist;
  else if (dist < minDist) dist = minDist;

  // 余弦定理：肩/髋处的夹角
  let cosA = (lenA * lenA + dist * dist - lenB * lenB) / (2 * lenA * dist);
  cosA = Math.max(-1, Math.min(1, cosA));
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));

  // pole 正交化：只保留垂直于「根->目标」方向的分量
  _ikPole.copy(poleDir).addScaledVector(_ikDir, -poleDir.dot(_ikDir));
  if (_ikPole.lengthSq() < 1e-6) {
    _ikPole.set(0, 0, -1).addScaledVector(_ikDir, -_ikDir.z);
    if (_ikPole.lengthSq() < 1e-6) _ikPole.set(0, -1, 0).addScaledVector(_ikDir, _ikDir.y);
  }
  _ikPole.normalize();

  // 肘/膝世界位置 + 可达末端位置
  _ikElbow.copy(rootPos).addScaledVector(_ikDir, lenA * cosA).addScaledVector(_ikPole, lenA * sinA);
  _ikReach.copy(rootPos).addScaledVector(_ikDir, dist);
  _ikDirA.copy(_ikElbow).sub(rootPos).normalize();
  _ikDirB.copy(_ikReach).sub(_ikElbow).normalize();
  _ikWrist.copy(_ikElbow).addScaledVector(_ikDirB, lenB);

  // 世界朝向：让关节局部 -Y 指向上段/下段方向
  _ikQa.setFromUnitVectors(DOWN, _ikDirA);
  _ikQb.setFromUnitVectors(DOWN, _ikDirB);

  _ikQp.copy(parentWorldQuat).invert();
  upperJoint.quaternion.copy(_ikQp).multiply(_ikQa);
  _ikQp.copy(_ikQa).invert();
  lowerJoint.quaternion.copy(_ikQp).multiply(_ikQb);

  _ikLowerQuat.copy(_ikQb);
  return _ikLowerQuat;
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/**
 * 握持点超出臂展时，沿武器 +Z 轴（枪口反向）把目标滑到可达位置。
 * 保证长枪（狙击/霰弹）的左手不会悬空，而是贴着枪身向后滑到弹匣/机匣位置。
 */
function fitGripToArmReach(target, shoulderPos, axis, reach) {
  _fitDir.copy(target).sub(shoulderPos);
  const distSq = _fitDir.lengthSq();
  if (distSq <= reach * reach) return;
  const da = _fitDir.dot(axis);
  const disc = da * da - (distSq - reach * reach);
  if (disc <= 0) return;
  const t = da - Math.sqrt(disc);
  if (t > 0) target.addScaledVector(axis, t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothTo(cur, target, rate, dt) {
  return cur + (target - cur) * (1 - Math.exp(-rate * dt));
}

// ---------------------------------------------------------------------------
// 角色
// ---------------------------------------------------------------------------
const STATE_KEYS = [
  'speed', 'grounded', 'alive', 'aiming', 'pitch', 'stance', 'sprint', 'firing', 'reloading', 'hitAt',
];

/**
 * 创建角色。
 * @param {{ color?: number, team?: string, variant?: number }} opts
 *   color   个人识别色（仅用于胸前小贴布，不影响队伍色）
 *   team    'alpha'(蓝青) / 'bravo'(红橙)；也兼容 'ally'/'enemy'/'blue'/'red'
 *   variant 0..2 外观变体（迷彩深浅、背包/套件细节）
 * @returns {{ root: THREE.Group, head: THREE.Group, update: Function, attachWeapon: Function, dispose: Function, joints: object }}
 */
export function createCharacter(opts = {}) {
  const options = opts || {};
  const color = options.color != null ? options.color : 0x8899aa;
  const rawTeam = String(options.team != null ? options.team : 'alpha').toLowerCase();
  const teamKey = (rawTeam === 'bravo' || rawTeam === 'enemy' || rawTeam === 'red' || rawTeam === 'b')
    ? 'bravo'
    : 'alpha';
  const variant = ((Number(options.variant) | 0) % 3 + 3) % 3;
  const C = makePalette(teamKey, variant, color);
  const buckets = buildBodyParts(C, variant);

  const ownedGeometries = [];
  const root = new THREE.Group();
  root.name = 'characterRoot';

  // ------------------------------------------------------------------
  // 关节树：root -> body -> 髋 -> 脊柱 -> 胸 -> 颈 -> 头；双腿/双臂分支
  // 只有「可见关节」挂合并 Mesh（12 次绘制）；其它关节是纯旋转 Group
  // ------------------------------------------------------------------
  const joints = {};
  function joint(parent, name, x, y, z) {
    const g = new THREE.Group();
    g.name = name;
    g.position.set(x, y, z);
    parent.add(g);
    joints[name] = g;
    return g;
  }

  function attachMesh(jointGroup, geometry, name) {
    if (!geometry) return null;
    const mesh = new THREE.Mesh(geometry, CHARACTER_MATERIAL);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    jointGroup.add(mesh);
    ownedGeometries.push(geometry);
    return mesh;
  }

  const body = new THREE.Group();
  body.name = 'body';
  root.add(body);

  const hips = joint(body, 'hips', 0, HIP_Y, 0);
  attachMesh(hips, mergeBucket(buckets.hips), 'hipsMesh');

  const waist = joint(hips, 'waist', 0, WAIST_Y, 0);
  const chest = joint(waist, 'chest', 0, CHEST_Y, 0);
  attachMesh(chest, mergeBucket(buckets.chest), 'chestMesh');

  const neck = joint(chest, 'neck', 0, NECK_Y, 0);
  const head = joint(neck, 'head', 0, HEAD_Y, 0);
  attachMesh(head, mergeBucket(buckets.head), 'headMesh');

  // 双腿：髋 -> 膝 -> 踝/脚掌
  const legs = [];
  for (const entry of [['L', -1, 0], ['R', 1, Math.PI]]) {
    const suffix = entry[0];
    const side = entry[1];
    const thigh = joint(hips, 'thigh' + suffix, side * 0.11, -0.035, 0);
    attachMesh(thigh, mergeBucket(side < 0 ? buckets.thighL : buckets.thighR), 'thighMesh' + suffix);
    const knee = joint(thigh, 'knee' + suffix, 0, -THIGH_LEN, 0);
    attachMesh(knee, mergeBucket(side < 0 ? buckets.shinL : buckets.shinR), 'shinMesh' + suffix);
    const ankle = joint(knee, 'ankle' + suffix, 0, -SHIN_LEN, 0);
    legs.push({
      side,
      suffix,
      thigh,
      knee,
      ankle,
      instIndex: suffix === 'L' ? 0 : 1,
      phaseOffset: entry[2],
    });
  }

  // 双臂：肩 -> 肘 -> 腕/手（手套几何合并进前臂，手腕关节保留用于关节树完整性）
  const arms = [];
  for (const entry of [['L', -1], ['R', 1]]) {
    const suffix = entry[0];
    const side = entry[1];
    const shoulder = joint(chest, 'shoulder' + suffix, side * SHOULDER_X, SHOULDER_Y, 0);
    attachMesh(shoulder, mergeBucket(side < 0 ? buckets.armUpperL : buckets.armUpperR), 'armUpperMesh' + suffix);
    const elbow = joint(shoulder, 'elbow' + suffix, 0, -UPPER_ARM_LEN, 0);
    attachMesh(elbow, mergeBucket(side < 0 ? buckets.armForeL : buckets.armForeR), 'armForeMesh' + suffix);
    const wrist = joint(elbow, 'wrist' + suffix, 0, -FOREARM_LEN, 0);
    arms.push({ side, suffix, shoulder, elbow, wrist });
  }

  // 双脚：合并成 1 个 InstancedMesh（2 个实例 = 左右脚），每帧写入踝关节世界矩阵
  const footGeometry = buildFootGeometry(C);
  if (footGeometry) ownedGeometries.push(footGeometry);
  const feet = new THREE.InstancedMesh(footGeometry, CHARACTER_MATERIAL, 2);
  feet.name = 'feet';
  feet.castShadow = true;
  feet.receiveShadow = true;
  feet.frustumCulled = false;
  feet.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  root.add(feet);
  {
    _footMat.makeTranslation(-FOOT_X, ANKLE_Y, 0);
    feet.setMatrixAt(0, _footMat);
    _footMat.makeTranslation(FOOT_X, ANKLE_Y, 0);
    feet.setMatrixAt(1, _footMat);
    feet.instanceMatrix.needsUpdate = true;
  }

  // 武器父节点：直接挂在 root 上；武器本地只绕 X 轴旋转（pitch/后坐），保证枪口方向正确
  const weaponParent = new THREE.Group();
  weaponParent.name = 'weaponParent';
  weaponParent.position.set(0.09, 1.305, -0.18);
  root.add(weaponParent);

  // ------------------------------------------------------------------
  // 武器握持点约定（见报告）：
  //   weapon.userData.rightGrip / leftGrip : THREE.Vector3（武器局部坐标，原点=握把，-Z=枪口）
  //   weapon.userData.kind                 : 'pistol'|'smg'|'ak47'|'shotgun'|'sniper'
  // 缺失时使用下面的备用握持点（保证任何武器都能正确持握）。
  // ------------------------------------------------------------------
  const gripRight = new THREE.Vector3(0, -0.01, -0.02);
  const gripLeft = new THREE.Vector3(-0.01, 0.005, -0.30);
  let weaponNode = null;

  function readVec3(value, out, fallbackX, fallbackY, fallbackZ) {
    if (value && typeof value.x === 'number' && typeof value.y === 'number' && typeof value.z === 'number') {
      out.set(value.x, value.y, value.z);
    } else {
      out.set(fallbackX, fallbackY, fallbackZ);
    }
  }

  function attachWeapon(group) {
    if (weaponNode && weaponNode.parent) weaponNode.parent.remove(weaponNode);
    let next = group || null;
    // 同一个武器 Group 实例只能挂到一个父节点上。main.js 会按武器种类缓存模型并复用，
    // 这里在检测到它已被其它角色占用时克隆一份（几何/材质共享，userData 保持原引用），
    // 保证每个远程角色都能拿到枪。
    if (next && next.parent && next.parent !== weaponParent) {
      next = next.clone(true);
      next.userData = group.userData;
    }
    weaponNode = next;
    if (!weaponNode) return;
    const ud = weaponNode.userData || {};
    const kind = typeof ud.kind === 'string' ? ud.kind : 'rifle';
    // 右手握把：默认接近武器原点
    readVec3(ud.rightGrip, gripRight, 0, -0.01, -0.02);
    // 左手护木：不同枪长度不同；手枪双手并拢
    let leftZ = -0.30;
    if (kind === 'pistol') leftZ = -0.06;
    else if (kind === 'smg') leftZ = -0.22;
    else if (kind === 'shotgun') leftZ = -0.29;
    else if (kind === 'sniper') leftZ = -0.32;
    readVec3(ud.leftGrip, gripLeft, kind === 'pistol' ? -0.025 : -0.01, 0.005, leftZ);

    // 武器归零，由 update 每帧写 pitch；保证不继承任何斜置旋转
    weaponNode.position.set(0, 0, 0);
    weaponNode.rotation.set(0, 0, 0);
    weaponNode.quaternion.set(0, 0, 0, 1);
    weaponParent.add(weaponNode);
  }

  // ------------------------------------------------------------------
  // 动画运行时状态
  // ------------------------------------------------------------------
  const state = {
    speed: 0,
    grounded: true,
    alive: true,
    aiming: false,
    pitch: 0,
    stance: 'stand',
    sprint: false,
    firing: false,
    reloading: false,
    hitAt: undefined,
  };

  let time = 0;
  let phase = variant * 1.9 + (teamKey === 'bravo' ? 1.1 : 0); // 步态相位（确定性错开）
  let breath = variant * 2.3;
  let landTimer = 0;
  let wasGrounded = true;
  let wasFiring = false;
  let deathT = 0;
  const deathDir = variant % 2 === 0 ? 1 : -1;
  let lastHitAt = -1;
  let flinch = 0;
  let recoil = 0;   // 平滑的「正在开火」系数
  let kick = 0;     // 单次后坐冲击
  let reloadT = 0;
  const flinchDir = variant % 2 === 0 ? -1 : 1;

  let crouchBlend = 0;
  let slideBlend = 0;
  let sprintBlend = 0;
  let aimBlend = 0;
  let airBlend = 0;
  let reloadBlend = 0;
  let gunBlend = 0;

  const weaponPos = new THREE.Vector3(0.09, 1.305, -0.18);
  let disposed = false;

  // 换弹左手关键帧（相对左手握持点的武器局部位移；0..1 为 2s 循环）
  // 卸弹匣 -> 取出旧弹匣 -> 拿新弹匣 -> 插入 -> 拍实 -> 拉栓 -> 回握把
  const RELOAD_KEYS = [
    [0.00, 0.00, 0.00, 0.00],
    [0.16, 0.00, -0.22, -0.02],
    [0.32, 0.00, -0.32, 0.05],
    [0.44, 0.00, -0.36, 0.13],
    [0.56, 0.00, -0.31, 0.10],
    [0.70, 0.00, -0.21, 0.02],
    [0.79, 0.00, -0.17, 0.00],
    [0.87, 0.00, 0.05, 0.10],
    [0.94, 0.00, 0.05, 0.30],
    [1.00, 0.00, 0.00, 0.00],
  ];

  function updateReloadPoint(t01) {
    let i = 0;
    while (i < RELOAD_KEYS.length - 2 && t01 > RELOAD_KEYS[i + 1][0]) i++;
    const a = RELOAD_KEYS[i];
    const b = RELOAD_KEYS[i + 1];
    const span = Math.max(1e-4, b[0] - a[0]);
    let k = clamp((t01 - a[0]) / span, 0, 1);
    k = k * k * (3 - 2 * k); // smoothstep
    _reloadLocal.set(
      lerp(a[1], b[1], k),
      lerp(a[2], b[2], k),
      lerp(a[3], b[3], k)
    );
    _reloadLocal.add(gripLeft); // 相对左手握持点
    return _reloadLocal;
  }

  function resetDeathPose() {
    body.position.set(0, 0, 0);
    body.rotation.set(0, 0, 0);
    hips.rotation.set(0, 0, 0);
    waist.rotation.set(0, 0, 0);
    chest.rotation.set(0, 0, 0);
    neck.rotation.set(0, 0, 0);
    head.rotation.set(0, 0, 0);
    for (const leg of legs) {
      leg.thigh.rotation.set(0, 0, 0);
      leg.knee.rotation.set(0, 0, 0);
      leg.ankle.rotation.set(0, 0, 0);
    }
    for (const arm of arms) {
      arm.shoulder.rotation.set(0, 0, 0);
      arm.elbow.rotation.set(0, 0, 0);
      arm.wrist.rotation.set(0, 0, 0);
    }
    if (weaponNode) weaponNode.rotation.set(0, 0, 0);
  }

  // 死亡：侧倒 + 关节松垂；body 绕 root 原点旋转，整体抬高避免穿地
  function applyDeathPose(d) {
    deathT = Math.min(1, deathT + d * 2.0);
    const k = 1 - (1 - deathT) * (1 - deathT); // easeOut
    body.rotation.set(0.10 * k, 0, deathDir * 1.42 * k);
    body.position.y = 0.16 * k;
    hips.position.y = HIP_Y;
    hips.rotation.set(0.15 * k, 0, 0);
    waist.rotation.set(-0.12 * k, 0.15 * k * deathDir, 0);
    chest.rotation.set(-0.22 * k, 0.18 * k * deathDir, 0.08 * k * deathDir);
    neck.rotation.set(0.12 * k, 0, 0);
    head.rotation.set(0.18 * k, 0.25 * k * deathDir, 0.12 * k * deathDir);
    // 四肢松垂（不再走 IK，避免关节锁死）
    const armPose = [
      [arms[0], 0.85, 0.25, 0.55],
      [arms[1], 0.65, -0.35, 0.35],
    ];
    for (const item of armPose) {
      const arm = item[0];
      arm.shoulder.rotation.set(item[1] * k, 0, item[2] * k);
      arm.elbow.rotation.set(item[3] * k, 0, 0);
      arm.wrist.rotation.set(0, 0, 0);
    }
    const legPose = [
      [legs[0], 0.30, 0.08, -0.55],
      [legs[1], 0.55, -0.05, -0.75],
    ];
    for (const item of legPose) {
      const leg = item[0];
      leg.thigh.rotation.set(item[1] * k, 0, item[2] * k);
      leg.knee.rotation.set(item[3] * k, 0, 0);
      leg.ankle.rotation.set(0.20 * k, 0, 0);
    }
    // 武器掉在身侧地上
    weaponParent.position.set(deathDir * 0.42, 0.02 + 0.10 * k, -0.55);
    if (weaponNode) weaponNode.rotation.set(0.2 * k, 0, 0);

    // 同步双脚实例矩阵（跟随死亡姿态，不穿地）
    root.updateMatrixWorld(true);
    _rootInv.copy(root.matrixWorld).invert();
    for (const leg of legs) {
      leg.ankle.getWorldPosition(_footPos);
      leg.ankle.getWorldQuaternion(_footQuat);
      _footMat.compose(_footPos, _footQuat, ONE);
      _instMat.copy(_rootInv).multiply(_footMat);
      feet.setMatrixAt(leg.instIndex, _instMat);
    }
    feet.instanceMatrix.needsUpdate = true;
  }

  // ------------------------------------------------------------------
  // 每帧更新
  // ------------------------------------------------------------------
  function update(nextState, dt) {
    if (disposed) return;
    if (nextState) {
      for (let i = 0; i < STATE_KEYS.length; i++) {
        const key = STATE_KEYS[i];
        if (nextState[key] !== undefined) state[key] = nextState[key];
      }
    }
    const d = Math.min(Math.max(dt || 0, 0), 0.05); // dt 钳制，避免切页后跳变
    time += d;

    const speed = clamp(Number(state.speed) || 0, 0, 14);
    const pitch = clamp(Number(state.pitch) || 0, -1.5, 1.5);
    const grounded = state.grounded !== false;
    const aiming = !!state.aiming;

    // ---- 死亡：侧倒，播完后完全静止 ----
    if (!state.alive) {
      if (deathT < 1) applyDeathPose(d);
      return;
    }
    if (deathT > 0) {
      deathT = 0;
      resetDeathPose();
    }

    // ---- 受击 flinch（hitAt 变化触发一次；0 视为“无受击”哨兵值）----
    if (state.hitAt !== undefined && state.hitAt !== 0 && state.hitAt !== lastHitAt) {
      lastHitAt = state.hitAt;
      flinch = 1;
    }
    flinch = Math.max(0, flinch - d * 5.0);

    // ---- 开火后坐 ----
    const firing = !!state.firing;
    if (firing && !wasFiring) kick = Math.min(1, kick + 1);
    wasFiring = firing;
    recoil = smoothTo(recoil, firing ? 1 : 0, firing ? 30 : 12, d);
    kick = Math.max(0, kick - d * 7.5);

    // ---- 落地缓冲 ----
    if (grounded && !wasGrounded) landTimer = 0.22;
    wasGrounded = grounded;
    landTimer = Math.max(0, landTimer - d);
    const landK = landTimer > 0 ? landTimer / 0.22 : 0;
    const landDip = Math.sin(landK * Math.PI) * 0.16;

    // ---- 状态混合（平滑过渡，避免姿态跳变）----
    const crouched = state.stance === 'crouch';
    const moving = grounded && speed > 0.35;
    const sliding = crouched && grounded && speed > 5.0;
    const sprinting = !!state.sprint && moving && speed > 4.2;
    crouchBlend = smoothTo(crouchBlend, crouched ? 1 : 0, 12, d);
    slideBlend = smoothTo(slideBlend, sliding ? 1 : 0, sliding ? 18 : 9, d);
    sprintBlend = smoothTo(sprintBlend, sprinting ? 1 : 0, 10, d);
    aimBlend = smoothTo(aimBlend, aiming ? 1 : 0, 10, d);
    airBlend = smoothTo(airBlend, grounded ? 0 : 1, 15, d);
    reloadBlend = smoothTo(reloadBlend, state.reloading ? 1 : 0, 16, d);
    gunBlend = smoothTo(gunBlend, weaponNode ? 1 : 0, 8, d);
    if (state.reloading) {
      reloadT = (reloadT + d) % RELOAD_TIME;
    } else if (reloadBlend < 0.02) {
      reloadT = 0;
    }

    // ---- 步态相位 ----
    const amp = clamp(speed / 8.4, 0, 1);
    const gaitAmp = clamp(speed / 5.4, 0, 1.35);
    const gaitW = clamp(speed / 2.0, 0, 1); // 静止时完全消除抬脚/脚尖动作，保证双脚踩实
    if (moving) {
      phase += d * (2.4 + speed * 1.75) * (0.85 + 0.15 * sprintBlend);
    } else {
      phase += d * 1.1;
    }
    breath += d * (1.5 + amp * 1.5);

    const strideZ = clamp(0.05 + speed * 0.033, 0, 0.32) * Math.min(1, gaitAmp);
    const liftH = (0.045 + amp * 0.06 + sprintBlend * 0.02) * Math.min(1, gaitAmp + 0.2);
    const bob = Math.sin(phase * 2) * 0.012 * amp * (moving ? 1 : 0);

    // ---- 髋部高度：蹲/滑铲/移动压缩/落地缓冲/呼吸起伏（脚部 IK 可达性补偿）----
    let hipY = HIP_Y;
    hipY = lerp(hipY, 0.48, crouchBlend);
    hipY = lerp(hipY, 0.34, slideBlend);
    hipY -= (0.02 + amp * 0.03) * (moving ? 1 : 0) * (1 - slideBlend);
    hipY -= landDip;
    hipY += Math.sin(breath) * 0.006 * (moving ? 0 : 1);
    hipY += bob;
    hipY -= 0.02 * airBlend;

    // ---- 身体姿态 ----
    body.position.set(0, 0, 0);
    body.rotation.set(0.16 * slideBlend, 0, 0); // 滑铲上身后仰
    hips.position.y = hipY;
    hips.rotation.set(
      0.10 * crouchBlend + 0.20 * slideBlend - 0.05 * sprintBlend + 0.02 * amp,
      0.05 * Math.sin(phase) * amp * (moving ? 1 : 0) * (1 - slideBlend),
      0
    );

    const look = pitch;
    const gaitTwist = Math.sin(phase) * amp * (moving ? 1 : 0) * (1 - slideBlend);
    waist.rotation.set(
      -0.02 - 0.20 * crouchBlend + 0.32 * slideBlend + look * 0.10 - 0.04 * aimBlend,
      0.06 * gaitTwist - 0.08 * gunBlend,
      0.02 * Math.sin(phase) * slideBlend
    );
    chest.rotation.set(
      -0.05 - 0.30 * crouchBlend + 0.40 * slideBlend - 0.22 * sprintBlend
        + look * 0.12 - 0.10 * aimBlend + Math.sin(breath) * 0.006,
      -0.10 * aimBlend - 0.04 * gaitTwist + 0.14 * slideBlend - 0.14 * gunBlend,
      0.10 * flinch * flinchDir + 0.02 * Math.sin(time * 0.7)
    );
    neck.rotation.set(
      look * 0.18 + 0.10 * sprintBlend - 0.10 * slideBlend + 0.10 * crouchBlend,
      0.06 * gunBlend,
      0
    );
    head.rotation.set(
      look * 0.52 + 0.08 * aimBlend + 0.12 * sprintBlend - 0.15 * slideBlend + 0.24 * crouchBlend - flinch * 0.15,
      0.03 * gaitTwist + 0.22 * gunBlend,
      0.06 * flinch * flinchDir
    );

    // ---- 武器父节点：跟随躯干高度/蹲姿/冲刺收枪（只平移，不改变枪口朝向）----
    const hipDelta = hipY - HIP_Y;
    let wx = 0.09 - 0.02 * aimBlend;
    let wy = 1.305 + hipDelta * 0.92 + 0.085 * aimBlend
      - 0.10 * sprintBlend - 0.06 * slideBlend - 0.02 * reloadBlend;
    // 瞄准时枪托贴肩（更靠近身体）；向下瞄时再收一点，避免左手够不到长枪护木
    let wz = -0.18 + 0.06 * aimBlend + 0.04 * sprintBlend + 0.05 * slideBlend
      + 0.06 * clamp(-pitch, 0, 1);
    const wlk = 1 - Math.exp(-12 * d);
    weaponPos.x += (wx - weaponPos.x) * wlk;
    weaponPos.y += (wy - weaponPos.y) * wlk;
    weaponPos.z += (wz - weaponPos.z) * wlk;
    weaponParent.position.copy(weaponPos);
    weaponParent.position.z += 0.03 * kick; // 后坐后移
    if (weaponNode) {
      // 关键：武器本地只绕 X 轴旋转 —— 枪口方向 = root yaw + pitch（开火时叠加后坐抖动）
      const gunPitch = pitch + 0.045 * recoil + 0.09 * kick + Math.sin(time * 62) * 0.006 * recoil;
      weaponNode.rotation.set(gunPitch, 0, 0);
      weaponNode.position.set(0, 0, 0);
    }

    // 后坐/受击叠加到躯干
    chest.rotation.x += 0.03 * recoil + 0.05 * kick;
    waist.rotation.x += 0.015 * recoil;
    head.rotation.x -= 0.05 * kick;

    // ---- 刷新世界矩阵后用世界空间做 IK ----
    root.updateMatrixWorld(true);
    root.getWorldQuaternion(_rootQ);
    hips.getWorldQuaternion(_hipsQ);
    chest.getWorldQuaternion(_chestQ);
    _rootInv.copy(root.matrixWorld).invert();

    // ---- 双腿 IK + 脚掌贴地 ----
    for (const leg of legs) {
      const side = leg.side;
      const lp = phase + leg.phaseOffset;
      // 步幅：-Z 为前；sin<0 时段为摆动相（抬脚），其余为支撑相（踩实）
      let tz = -Math.cos(lp) * strideZ * (1 - 0.4 * crouchBlend);
      let ty = ANKLE_Y + Math.max(0, -Math.sin(lp)) * liftH * gaitW;
      tz -= 0.16 * crouchBlend;
      // 滑铲：前腿伸出、后腿收在身体下方（不放到身后，避免膝盖折到地面以下）
      tz = lerp(tz, side < 0 ? -0.56 : -0.02, slideBlend);
      ty = lerp(ty, ANKLE_Y + 0.012, slideBlend);
      // 空中：收腿
      tz = lerp(tz, side < 0 ? -0.34 : 0.14, airBlend);
      ty = lerp(ty, hipY - (side < 0 ? 0.40 : 0.32), airBlend);

      _rootLocal.set(side * (FOOT_X + 0.012 * crouchBlend + 0.03 * slideBlend), ty, tz);
      root.localToWorld(_rootLocal);
      leg.thigh.getWorldPosition(_thighPos);
      // 膝盖极向量：朝身体前方；正交化后禁止向下（否则蹲/滑铲时膝盖会扎进地面）
      _poleV.set(side * 0.08, 0, -1).applyQuaternion(_rootQ).normalize();
      _hipToTarget.copy(_rootLocal).sub(_thighPos);
      const hipToTargetLen = _hipToTarget.length();
      if (hipToTargetLen > 1e-4) _hipToTarget.multiplyScalar(1 / hipToTargetLen);
      else _hipToTarget.set(0, -1, 0);
      _poleV.addScaledVector(_hipToTarget, -_poleV.dot(_hipToTarget));
      if (_poleV.y < 0.02) {
        _poleV.y = 0.02;
        _poleV.addScaledVector(_hipToTarget, -_poleV.dot(_hipToTarget));
      }
      if (_poleV.lengthSq() < 1e-8) _poleV.set(0, 0, -1);
      _poleV.normalize();
      const shinQuat = solveTwoBoneIK(
        leg.thigh, leg.knee, _hipsQ, _thighPos, _rootLocal, _poleV, THIGH_LEN, SHIN_LEN
      );
      // 脚掌世界朝向：站立/支撑相保持水平；摆动相抬脚尖（静止与滑铲时不乱翘）
      const swing = Math.max(0, -Math.sin(lp));
      const toeAngle = swing * 0.55 * gaitW * (1 - 0.6 * airBlend) * (1 - slideBlend)
        + 0.12 * slideBlend - 0.15 * airBlend;
      _toeQ.setFromAxisAngle(AXIS_X, toeAngle);
      _footQ.copy(_rootQ).multiply(_toeQ);
      leg.ankle.quaternion.copy(_qTmp.copy(shinQuat).invert()).multiply(_footQ);
      // 写入 InstancedMesh（root 空间）
      _footMat.compose(_ikWrist, _footQ, ONE);
      _instMat.copy(_rootInv).multiply(_footMat);
      feet.setMatrixAt(leg.instIndex, _instMat);
    }
    feet.instanceMatrix.needsUpdate = true;

    // ---- 双臂 IK：双手吸附到武器握持点（无武器时自然下垂/低上位）----
    const hasWeapon = !!weaponNode;
    if (hasWeapon) {
      _gripR.copy(gripRight).applyMatrix4(weaponNode.matrixWorld);
      _gripL.copy(gripLeft).applyMatrix4(weaponNode.matrixWorld);
      weaponNode.getWorldQuaternion(_weaponQ);
      // 武器 +Z 轴（枪口反向，指向射手）——握持点超出臂展时沿它后滑，让手始终贴在枪身上
      _weaponAxis.set(0, 0, 1).applyQuaternion(_weaponQ);
      if (reloadBlend > 0.001) {
        // 换弹：左手离开护木去操作弹匣/拉栓
        const t01 = (reloadT % RELOAD_TIME) / RELOAD_TIME;
        const rp = updateReloadPoint(t01);
        _reloadWorld.copy(rp).applyMatrix4(weaponNode.matrixWorld);
        _gripL.lerp(_reloadWorld, reloadBlend);
      }
    }

    for (const arm of arms) {
      const side = arm.side;
      arm.shoulder.getWorldPosition(_shoulderPos);
      if (hasWeapon) {
        // 手腕落在握持点后方约 5cm，让半握手套正好包住握把
        _armTarget.copy(side > 0 ? _gripR : _gripL);
        // 若握持点超出臂展（长枪护木较远），沿枪身向后滑动到可达位置：手不悬空、贴着枪
        fitGripToArmReach(_armTarget, _shoulderPos, _weaponAxis, ARM_REACH);
        _wristOffset.copy(_shoulderPos).sub(_armTarget);
        const wl = _wristOffset.length();
        if (wl > 1e-3) _wristOffset.multiplyScalar(1 / wl);
        else _wristOffset.set(0, 0, 1);
        _armTarget.addScaledVector(_wristOffset, 0.05);
      } else {
        // 无武器：走动时手臂反相摆动，待机自然下垂，瞄准时收拢到低上位
        const swingArm = Math.sin(phase + (side > 0 ? 0 : Math.PI)) * 0.16 * gaitAmp;
        _rootLocal.set(
          side * (0.23 + Math.max(0, -swingArm) * 0.10),
          0.93 + Math.sin(breath) * 0.01 - Math.abs(swingArm) * 0.10 - 0.20 * aimBlend,
          -0.08 + swingArm - 0.18 * aimBlend
        );
        root.localToWorld(_rootLocal);
        _armTarget.copy(_rootLocal);
      }
      // 肘部极向量：向后下方外撇；瞄准时收得更紧
      _poleV.set(side * (1.0 - 0.15 * aimBlend), -0.55 - 0.35 * aimBlend, 0.50 - 0.15 * aimBlend);
      _poleV.applyQuaternion(_rootQ).normalize();
      solveTwoBoneIK(
        arm.shoulder, arm.elbow, _chestQ, _shoulderPos, _armTarget, _poleV, UPPER_ARM_LEN, FOREARM_LEN
      );
    }
  }

  // 枪口世界坐标（远程玩家枪口焰/弹壳定位用）
  const _muzzleWorld = new THREE.Vector3();
  function getWeaponMuzzleWorld(out) {
    const v = out || _muzzleWorld;
    if (!weaponNode) {
      root.getWorldPosition(v);
      v.y += 1.35;
      return v;
    }
    const ud = weaponNode.userData || {};
    if (ud.muzzle && typeof ud.muzzle.x === 'number') v.copy(ud.muzzle);
    else v.set(0, 0.05, -0.9);
    weaponNode.localToWorld(v);
    return v;
  }

  // ------------------------------------------------------------------
  // 释放（几何体独享；材质是模块级共享缓存，不释放）
  // ------------------------------------------------------------------
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (weaponNode && weaponNode.parent) weaponNode.parent.remove(weaponNode);
    weaponNode = null;
    if (root.parent) root.parent.remove(root);
    for (const g of ownedGeometries) g.dispose();
    ownedGeometries.length = 0;
  }

  // 对外接口（额外暴露 joints/body/weaponParent 便于调用方调试，不影响契约）
  return {
    root,
    head,
    update,
    attachWeapon,
    getWeaponMuzzleWorld,
    dispose,
    // 便于测试/调试：关节引用、姿态层、武器父节点、当前状态
    body,
    joints,
    weaponParent,
    state,
    maxDrawCalls: MAX_DRAW_CALLS,
  };
}

export default createCharacter;
