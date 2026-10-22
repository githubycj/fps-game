// ===== 轻量布娃娃物理：刚体 + 骨骼距离约束（PBD 位置基动力学）=====
// 设计目标（任务 A）：
//   * 不引入任何物理引擎依赖，单文件实现「位置基动力学（PBD）」刚体求解器；
//   * 每个部件 = 一个带朝向的盒子刚体（位置 p / 速度 v / 朝向 q / 角速度 w / 质量 m）；
//   * 重力 -9.8；与地形（heightAt + terrainNormal）碰撞；与静态 AABB（COLLIDERS）碰撞；
//   * 部件之间用距离约束（保持骨骼长度）连成链：hips→torso→head、hips→thigh→shin、
//     torso→upperArm→foreArm，迭代 10 次求解；
//   * 角度/线速度阻尼 + 速度阈值 sleep：倒地后完全停止积分，只剩姿态回写（几乎零开销）；
//   * 同一时刻最多 MAX_ACTIVE_RAGDOLLS(=3) 个布娃娃在跑物理，第 4 个会把最旧的冻结
//     （保留当前倒地姿态、释放物理预算），从而满足「最多同时 3 个，超过就复用最旧的」。
//
// 与 character.js 的契约：
//   parts = [{ name, obj:Object3D, halfExtents:[x,y,z], mass, offset?:[x,y,z] }, ...]
//   obj 的 position/quaternion 由本模块直接读写（进入布娃娃前角色会把这些关节拍平到 root 下，
//   因此 anchor 的逆矩阵一次求解即可把世界姿态写回局部姿态）。
//   本模块只依赖 three 与 shared/world.js，不 import character.js（避免循环依赖）。

import * as THREE from 'three';
import { heightAt, terrainNormal, COLLIDERS } from '../shared/world.js';

// 供其它模块（character.js 掉落武器时）贴合地形使用，避免再单独 import world.js
export { heightAt as groundHeightAt };

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
const GRAVITY = -9.8;              // 重力加速度 m/s²
export const MAX_ACTIVE_RAGDOLLS = 3; // 同时参与物理求解的布娃娃上限
const ITERATIONS = 10;             // PBD 约束/接触迭代次数（契约 8~12）
const MAX_STEP = 1 / 40;           // 单个物理子步上限（大 dt 自动拆子步，防爆）
const LINEAR_DAMP = 0.55;          // 线性阻尼（1/s）
const ANGULAR_DAMP = 2.6;          // 角阻尼（1/s）：让四肢快速停摆，避免"永动机"
const RESTITUTION = 0.25;          // 地面/墙面法向恢复系数
const FRICTION = 0.7;              // 切向摩擦系数
const SLEEP_LIN = 0.18;            // 入睡线速度阈值 m/s
const SLEEP_ANG = 0.55;            // 入睡角速度阈值 rad/s
const SLEEP_TIME = 0.55;           // 低于阈值持续多久后入睡（秒）
const MAX_LIFE = 14;               // 硬性上限：超过这个时间强制入睡，避免极端卡住
const GROUND_DRAG = 0.86;          // 接触地面时每个子步的水平速度衰减（模拟地面摩擦，防止滑出好几米）
const GROUND_ANG_DRAG = 0.90;      // 接触地面时的角速度衰减（防止四肢持续滚动）
const MAX_SPEED = 9;               // 单部件线速度上限（防止约束拉伸把躯干甩飞）
const COLLIDER_RANGE = 9;          // 静态碰撞体粗筛半径（米）
const BOX_CORNERS = [
  [-1, -1, -1], [1, -1, -1], [-1, 1, -1], [1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [-1, 1, 1], [1, 1, 1],
];

// 骨骼链（按部件名）。第三项为约束刚度，第四项 minOnly=true 表示「只推不拉」的弱约束，
// 用来防止头部/双臂穿过躯干，但不会把已经蜷缩的身体强行拉直。
const DEFAULT_LINKS = [
  ['hips', 'torso', 1.0, false],
  ['torso', 'head', 1.0, false],
  ['hips', 'thighL', 1.0, false],
  ['thighL', 'shinL', 1.0, false],
  ['hips', 'thighR', 1.0, false],
  ['thighR', 'shinR', 1.0, false],
  ['torso', 'upperArmL', 1.0, false],
  ['upperArmL', 'foreArmL', 1.0, false],
  ['torso', 'upperArmR', 1.0, false],
  ['upperArmR', 'foreArmR', 1.0, false],
  ['hips', 'head', 0.35, true],
  ['upperArmL', 'upperArmR', 0.12, true],
  ['thighL', 'thighR', 0.12, true],
];

// ---------------------------------------------------------------------------
// 模块级临时量（单线程复用，避免每帧分配）
// ---------------------------------------------------------------------------
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _r = new THREE.Vector3();
const _n = new THREE.Vector3();
const _vp = new THREE.Vector3();
const _vt = new THREE.Vector3();
const _t = new THREE.Vector3();
const _rt = new THREE.Vector3();
const _rn = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _rotQ = new THREE.Quaternion();
const _rotAxis = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _inv = new THREE.Matrix4();

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

// 把世界空间的「角位移向量」（方向=转轴，模长=弧度）叠加到四元数上
function rotateByVector(q, axisAngle) {
  const len = axisAngle.length();
  if (len < 1e-9) return;
  _rotAxis.copy(axisAngle).multiplyScalar(1 / len);
  _rotQ.setFromAxisAngle(_rotAxis, len);
  q.premultiply(_rotQ).normalize();
}

// ---------------------------------------------------------------------------
// 刚体构造
// ---------------------------------------------------------------------------
function makeBody(def, index) {
  if (!def || !def.obj) return null;
  const he = Array.isArray(def.halfExtents) ? def.halfExtents : null;
  const hx = Math.max(0.02, Math.abs((he && he[0]) || 0.08));
  const hy = Math.max(0.02, Math.abs((he && he[1]) || 0.08));
  const hz = Math.max(0.02, Math.abs((he && he[2]) || 0.08));
  const mass = Math.max(0.2, Number(def.mass) || 1);
  const off = Array.isArray(def.offset) ? def.offset : [0, 0, 0];
  // 盒体转动惯量近似：I = m/3 * (hx² + hy² + hz²)
  const inertia = Math.max(1e-3, (mass / 3) * (hx * hx + hy * hy + hz * hz));
  return {
    name: String(def.name || 'part' + index),
    obj: def.obj,
    hx, hy, hz,
    mass,
    invMass: 1 / mass,
    offset: new THREE.Vector3(Number(off[0]) || 0, Number(off[1]) || 0, Number(off[2]) || 0),
    inertia,
    invInertia: 1 / inertia,
    radius: Math.hypot(hx, hy, hz),
    // 物理状态
    p: new THREE.Vector3(),          // 碰撞盒中心（世界坐标）
    v: new THREE.Vector3(),          // 线速度
    q: new THREE.Quaternion(),       // 朝向
    w: new THREE.Vector3(),          // 角速度（世界空间，rad/s）
    pPrev: new THREE.Vector3(),
    qPrev: new THREE.Quaternion(),
    // 接触缓存（每步重新填充，预分配避免 GC）
    contacts: [
      { lx: 0, ly: 0, lz: 0, nx: 0, ny: 1, nz: 0, gy: 0, pen: 0 },
      { lx: 0, ly: 0, lz: 0, nx: 0, ny: 1, nz: 0, gy: 0, pen: 0 },
      { lx: 0, ly: 0, lz: 0, nx: 0, ny: 1, nz: 0, gy: 0, pen: 0 },
      { lx: 0, ly: 0, lz: 0, nx: 0, ny: 1, nz: 0, gy: 0, pen: 0 },
    ],
    contactCount: 0,
    // 最近一次静态碰撞体接触（速度层反弹/摩擦用）
    aabbHit: false,
    aabbN: new THREE.Vector3(0, 1, 0),
    aabbR: new THREE.Vector3(),
    sleepTimer: 0,
  };
}

// ---------------------------------------------------------------------------
// 活跃布娃娃登记表（上限 3，超出冻结最旧的）
// ---------------------------------------------------------------------------
const ACTIVE = [];

function registerRagdoll(rag) {
  const i = ACTIVE.indexOf(rag);
  if (i >= 0) ACTIVE.splice(i, 1);
  while (ACTIVE.length >= MAX_ACTIVE_RAGDOLLS) {
    const oldest = ACTIVE.shift();
    if (oldest && !oldest.disposed) oldest.freeze();
  }
  ACTIVE.push(rag);
}

function unregisterRagdoll(rag) {
  const i = ACTIVE.indexOf(rag);
  if (i >= 0) ACTIVE.splice(i, 1);
}

/** 当前正在跑物理的布娃娃数量（调试/测试用） */
export function activeRagdollCount() {
  return ACTIVE.length;
}

// ---------------------------------------------------------------------------
// Ragdoll
// ---------------------------------------------------------------------------
export class Ragdoll {
  /**
   * @param {Array} parts 部件定义（见文件头契约）
   * @param {{ links?: Array, anchor?: THREE.Object3D }} options
   */
  constructor(parts, options = {}) {
    this.options = options || {};
    this.disposed = false;
    this.settled = false;   // 已入睡：停止积分
    this.frozen = false;    // 被预算挤掉：冻结姿态，不再参与物理
    this.sleepTimer = 0;
    this.time = 0;
    this.bodies = [];
    this.byName = Object.create(null);
    this.constraints = [];
    this.colliders = [];
    this.colliderCenter = new THREE.Vector3(1e9, 1e9, 1e9);
    // 静止后跳过重复写回所需的缓存
    this._anchor = null;
    this._anchorMatrix = new THREE.Matrix4();
    this._written = false;

    const list = Array.isArray(parts) ? parts : [];
    for (let i = 0; i < list.length; i++) {
      const body = makeBody(list[i], i);
      if (!body) continue;
      this.bodies.push(body);
      this.byName[body.name] = body;
    }
    if (this.bodies.length === 0) {
      this.disposed = true;
      return;
    }
    this._readFromObjects();
    this._buildConstraints(this.options.links);
    this._refreshColliders(true);
  }

  /** 是否已经入睡 / 冻结 */
  get isSettled() {
    return this.settled || this.frozen || this.disposed;
  }

  /** 从场景中的 Object3D 读取初始世界姿态（同时把速度清零） */
  _readFromObjects() {
    for (const b of this.bodies) {
      if (!b.obj) continue;
      b.obj.updateWorldMatrix(true, false);
      b.obj.getWorldQuaternion(b.q);
      b.obj.getWorldPosition(_v1);
      // 碰撞盒中心 = 关节世界位置 + 朝向 * 局部偏移
      b.p.copy(_v1).add(_v2.copy(b.offset).applyQuaternion(b.q));
      b.pPrev.copy(b.p);
      b.qPrev.copy(b.q);
      b.v.set(0, 0, 0);
      b.w.set(0, 0, 0);
      b.contactCount = 0;
      b.aabbHit = false;
      b.sleepTimer = 0;
    }
  }

  /** 按名字建立距离约束；rest 长度取当前（站立）姿态下的部件中心距 */
  _buildConstraints(customLinks) {
    this.constraints.length = 0;
    const links = Array.isArray(customLinks) && customLinks.length ? customLinks : DEFAULT_LINKS;
    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      let a = null;
      let b = null;
      let stiff = 1;
      let minOnly = false;
      if (Array.isArray(link)) {
        a = this.byName[link[0]];
        b = this.byName[link[1]];
        if (link[2] != null) stiff = clamp(Number(link[2]) || 0, 0, 1);
        minOnly = !!link[3];
      } else if (link && typeof link === 'object') {
        a = this.byName[link.a];
        b = this.byName[link.b];
        if (link.stiff != null) stiff = clamp(Number(link.stiff) || 0, 0, 1);
        minOnly = !!link.minOnly;
      }
      if (!a || !b || a === b) continue;
      this.constraints.push({ a, b, len: a.p.distanceTo(b.p), stiff, minOnly });
    }
  }

  /**
   * 粗筛附近的静态碰撞体：布娃娃不会跑远，所以按躯干位置缓存一份，
   * 只有躯干移动超过 3m 才重建，避免每帧遍历 280+ 个 AABB。
   */
  _refreshColliders(force) {
    const torso = this.byName.torso || this.bodies[0];
    if (!torso) return;
    if (!force && this.colliderCenter.distanceToSquared(torso.p) < 9) return;
    this.colliderCenter.copy(torso.p);
    this.colliders.length = 0;
    for (let i = 0; i < COLLIDERS.length; i++) {
      const o = COLLIDERS[i];
      if (!o) continue;
      const hw = (o.w || 0) * 0.5;
      const hd = (o.d || 0) * 0.5;
      const dx = Math.max(Math.abs(torso.p.x - o.x) - hw, 0);
      const dz = Math.max(Math.abs(torso.p.z - o.z) - hd, 0);
      if (dx * dx + dz * dz > COLLIDER_RANGE * COLLIDER_RANGE) continue;
      this.colliders.push(o);
    }
  }

  /**
   * 进入布娃娃：施加冲击冲量（按 1/mass 加权，轻的肢体飞得更远）+ 随机角速度。
   * @param {THREE.Vector3|{x,y,z}} impulseDir 冲击方向（子弹前进方向）
   * @param {number} impulseStrength 冲击强度（0~14，1 约为普通步枪命中）
   */
  start(impulseDir, impulseStrength) {
    if (this.disposed) return;
    this.settled = false;
    this.frozen = false;
    this.sleepTimer = 0;
    this.time = 0;
    this._written = false;

    // 以角色当前（站立/死亡）姿态为起点
    this._readFromObjects();
    for (const c of this.constraints) c.len = c.a.p.distanceTo(c.b.p);
    this._refreshColliders(true);

    _v1.set(
      impulseDir && Number.isFinite(impulseDir.x) ? impulseDir.x : 0,
      impulseDir && Number.isFinite(impulseDir.y) ? impulseDir.y : 0,
      impulseDir && Number.isFinite(impulseDir.z) ? impulseDir.z : -1
    );
    if (_v1.lengthSq() < 1e-8) _v1.set(0, 0, -1);
    _v1.normalize();
    const s = clamp(Number(impulseStrength) || 0, 0, 14);

    for (const b of this.bodies) {
      // 1/mass 加权：轻的部件（前臂/头）被冲击带得更快，躯干更"墩"
      const k = clamp(7.5 / b.mass, 0.3, 1.8);
      b.v.addScaledVector(_v1, s * k * 0.45);
      // 少量随机扩散，避免所有部件像一整块钢板平移
      b.v.x += (Math.random() - 0.5) * s * 0.28;
      b.v.y += (Math.random() - 0.5) * s * 0.18 + s * 0.05;
      b.v.z += (Math.random() - 0.5) * s * 0.28;
      if (b.v.lengthSq() > MAX_SPEED * MAX_SPEED) b.v.setLength(MAX_SPEED);
      // 随机角速度：倒地时四肢自然翻卷，不会像棍子一样直立
      const spin = 2.2 + s * 0.9;
      b.w.set(
        (Math.random() - 0.5) * spin,
        (Math.random() - 0.5) * spin,
        (Math.random() - 0.5) * spin
      );
    }

    // 让上半身额外朝冲击方向"折"一下：即使 strength=0 也会软倒而不是笔直站着
    const torso = this.byName.torso;
    const hips = this.byName.hips;
    if (torso) {
      torso.w.x += _v1.z * (1.4 + s * 0.25);
      torso.w.z -= _v1.x * (1.4 + s * 0.25);
    }
    if (hips) {
      hips.w.x += _v1.z * 0.5;
      hips.w.z -= _v1.x * 0.5;
    }

    registerRagdoll(this);
  }

  /** 推进物理并回写部件变换；已入睡/冻结时只回写姿态（保证角色 root 漂移时尸体不跟着走） */
  step(dt) {
    if (this.disposed) return;
    const d = Math.min(Math.max(Number(dt) || 0, 0), 0.1);
    if (d <= 0) return;
    if (this.frozen || this.settled) {
      this._writeBack();
      return;
    }
    this.time += d;
    let remain = d;
    while (remain > 1e-5) {
      const h = Math.min(remain, MAX_STEP);
      this._substep(h);
      remain -= h;
      if (this.settled) break;
    }
    this._writeBack();
  }

  /** 单个物理子步：积分 → 约束/接触迭代 → 速度回写 → 反弹/摩擦 → 睡眠判定 */
  _substep(h) {
    const bodies = this.bodies;

    // 1) 预测位置（半隐式欧拉 + 阻尼）
    for (const b of bodies) {
      b.pPrev.copy(b.p);
      b.qPrev.copy(b.q);
      b.v.y += GRAVITY * h;
      b.v.multiplyScalar(Math.max(0, 1 - LINEAR_DAMP * h));
      b.w.multiplyScalar(Math.max(0, 1 - ANGULAR_DAMP * h));
      b.p.addScaledVector(b.v, h);
      if (b.w.lengthSq() > 1e-10) {
        _q1.set(b.w.x * h * 0.5, b.w.y * h * 0.5, b.w.z * h * 0.5, 1).normalize();
        b.q.premultiply(_q1).normalize();
      }
    }

    // 2) 收集地面接触（每步一次；迭代里只做位置修正，不再重复采样地形）
    this._refreshColliders(false);
    this._collectGroundContacts();

    // 3) PBD 迭代：距离约束 + 地面/墙面接触
    for (let it = 0; it < ITERATIONS; it++) {
      this._solveConstraints();
      this._solveGroundContacts();
      this._solveColliders();
    }

    // 4) 由位置差反推速度（PBD 标准做法，天然得到非弹性响应）
    const invH = 1 / h;
    for (const b of bodies) {
      b.v.subVectors(b.p, b.pPrev).multiplyScalar(invH);
      _q1.copy(b.q).multiply(_q2.copy(b.qPrev).invert());
      if (_q1.w < 0) { _q1.x = -_q1.x; _q1.y = -_q1.y; _q1.z = -_q1.z; _q1.w = -_q1.w; }
      b.w.set(_q1.x * 2 * invH, _q1.y * 2 * invH, _q1.z * 2 * invH);
    }

    // 5) 速度层：法向反弹（0.25）+ 切向摩擦（0.7）
    this._applyContactImpulses();

    // 6) 睡眠判定
    this._updateSleep(h);
  }

  /** 收集每个刚体与地形的接触点（盒子 8 角点中最深的几个） */
  _collectGroundContacts() {
    for (const b of this.bodies) {
      b.contactCount = 0;
      const groundCenter = heightAt(b.p.x, b.p.z);
      if (b.p.y - b.radius > groundCenter + 0.12) continue; // 悬空，跳过
      let count = 0;
      for (let i = 0; i < 8; i++) {
        const c = BOX_CORNERS[i];
        _v1.set(c[0] * b.hx, c[1] * b.hy, c[2] * b.hz).applyQuaternion(b.q).add(b.p);
        const gy = heightAt(_v1.x, _v1.z);
        const pen = gy - _v1.y;
        if (pen <= 0) continue;
        // 只保留最深的 4 个接触点
        if (count < 4) {
          const slot = b.contacts[count++];
          slot.lx = c[0] * b.hx; slot.ly = c[1] * b.hy; slot.lz = c[2] * b.hz;
          const n = terrainNormal(_v1.x, _v1.z);
          slot.nx = n.x; slot.ny = n.y; slot.nz = n.z;
          slot.gy = gy;
          slot.pen = pen;
        } else {
          // 替换掉当前最浅的一个
          let worst = 0;
          for (let k = 1; k < 4; k++) if (b.contacts[k].pen < b.contacts[worst].pen) worst = k;
          if (pen > b.contacts[worst].pen) {
            const slot = b.contacts[worst];
            slot.lx = c[0] * b.hx; slot.ly = c[1] * b.hy; slot.lz = c[2] * b.hz;
            const n = terrainNormal(_v1.x, _v1.z);
            slot.nx = n.x; slot.ny = n.y; slot.nz = n.z;
            slot.gy = gy;
            slot.pen = pen;
          }
        }
      }
      b.contactCount = count;
    }
  }

  /** 位置修正：把刚体沿法线推出穿透，并在接触点产生角修正（让身体自然翻倒） */
  _applyPointCorrection(b, rx, ry, rz, nx, ny, nz, pen) {
    // 有效质量 k = 1/m + (r×n)² / I
    _r.set(rx, ry, rz);
    _n.set(nx, ny, nz);
    _rn.copy(_r).cross(_n);
    const k = b.invMass + _rn.lengthSq() * b.invInertia;
    if (k <= 1e-9) return;
    const lambda = pen / k;
    b.p.addScaledVector(_n, lambda * b.invMass);
    _v3.copy(_rn).multiplyScalar(lambda * b.invInertia);
    rotateByVector(b.q, _v3);
  }

  _solveGroundContacts() {
    for (const b of this.bodies) {
      for (let i = 0; i < b.contactCount; i++) {
        const c = b.contacts[i];
        _v1.set(c.lx, c.ly, c.lz).applyQuaternion(b.q).add(b.p);
        // 用收集时的地面高度近似（迭代中水平位移极小），避免每轮重复采样地形
        const pen = c.gy - _v1.y;
        if (pen <= 1e-4) continue;
        _v2.copy(_v1).sub(b.p);
        this._applyPointCorrection(b, _v2.x, _v2.y, _v2.z, c.nx, c.ny, c.nz, pen);
      }
    }
  }

  /**
   * 静态 AABB 碰撞：把刚体盒子投影到 AABB 的三个世界轴上（近似 SAT），
   * 取重叠最小的轴推出，并在该轴的盒面中心施加角修正。
   */
  _solveColliders() {
    const list = this.colliders;
    if (list.length === 0) return;
    for (const b of this.bodies) {
      b.aabbHit = false;
      _mat.makeRotationFromQuaternion(b.q);
      const e = _mat.elements;
      // 列主序：e[0..2]=第一列，e[4..6]=第二列，e[8..10]=第三列
      const ex = Math.abs(e[0]) * b.hx + Math.abs(e[4]) * b.hy + Math.abs(e[8]) * b.hz;
      const ey = Math.abs(e[1]) * b.hx + Math.abs(e[5]) * b.hy + Math.abs(e[9]) * b.hz;
      const ez = Math.abs(e[2]) * b.hx + Math.abs(e[6]) * b.hy + Math.abs(e[10]) * b.hz;
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        const y0 = o.y0 == null ? -Infinity : o.y0;
        const y1 = o.y1 == null ? Infinity : o.y1;
        if (b.p.y - ey > y1 || b.p.y + ey < y0) continue;
        const oy = (y0 + y1) * 0.5;
        const hhy = (y1 - y0) * 0.5;
        const hw = (o.w || 0) * 0.5;
        const hd = (o.d || 0) * 0.5;
        const dx = b.p.x - o.x;
        const dy = b.p.y - oy;
        const dz = b.p.z - o.z;
        const ox = hw + ex - Math.abs(dx);
        if (ox <= 0) continue;
        const oyy = hhy + ey - Math.abs(dy);
        if (oyy <= 0) continue;
        const oz = hd + ez - Math.abs(dz);
        if (oz <= 0) continue;
        // 最小重叠轴
        let nx = 0, ny = 0, nz = 0, pen = 0, rlen = 0;
        if (ox <= oyy && ox <= oz) {
          nx = dx >= 0 ? 1 : -1; pen = ox; rlen = ex;
        } else if (oyy <= oz) {
          ny = dy >= 0 ? 1 : -1; pen = oyy; rlen = ey;
        } else {
          nz = dz >= 0 ? 1 : -1; pen = oz; rlen = ez;
        }
        // 接触点 = 盒面中心（沿推出轴）
        const rx = nx * rlen;
        const ry = ny * rlen;
        const rz = nz * rlen;
        this._applyPointCorrection(b, rx, ry, rz, nx, ny, nz, pen);
        // 记录给速度层做反弹/摩擦
        b.aabbHit = true;
        b.aabbN.set(nx, ny, nz);
        b.aabbR.set(rx, ry, rz);
      }
    }
  }

  /** 距离约束（PBD）：按质量加权把两个部件拉回骨骼长度 */
  _solveConstraints() {
    const list = this.constraints;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const a = c.a;
      const b = c.b;
      _v1.subVectors(b.p, a.p);
      const dist = _v1.length();
      if (dist < 1e-6) continue;
      const diff = dist - c.len;
      if (c.minOnly && diff >= 0) continue; // 弱约束：只防止穿模，不阻止伸展
      const wSum = a.invMass + b.invMass;
      if (wSum <= 1e-9) continue;
      const k = (diff / dist) * c.stiff / wSum;
      a.p.addScaledVector(_v1, k * a.invMass);
      b.p.addScaledVector(_v1, -k * b.invMass);
    }
  }

  /** 速度层：法向恢复系数 0.25 + 库仑摩擦 0.7（只处理地面接触与最近一次静态碰撞） */
  _applyContactImpulses() {
    for (const b of this.bodies) {
      for (let i = 0; i < b.contactCount; i++) {
        const c = b.contacts[i];
        _r.set(c.lx, c.ly, c.lz).applyQuaternion(b.q);
        _n.set(c.nx, c.ny, c.nz);
        this._resolveVelocity(b, _r, _n);
      }
      if (b.aabbHit) {
        this._resolveVelocity(b, b.aabbR, b.aabbN);
      }
      // 接触地面/墙面时额外拖动：真实布娃娃几乎不会滑行 3~4m，
      // 且纯库仑摩擦在 PBD 里力度不够（法向冲量很小时摩擦上限也小）。
      if (b.contactCount > 0 || b.aabbHit) {
        b.v.x *= GROUND_DRAG;
        b.v.z *= GROUND_DRAG;
        b.w.multiplyScalar(GROUND_ANG_DRAG);
      }
    }
  }

  _resolveVelocity(b, r, n) {
    _vp.copy(b.w).cross(r).add(b.v);      // 接触点速度
    const vn = _vp.dot(n);
    if (vn >= 0) return;
    // 法向冲量（低速不弹，避免静止时抖动）
    _rn.copy(r).cross(n);
    const kn = b.invMass + _rn.lengthSq() * b.invInertia;
    if (kn <= 1e-9) return;
    const e = Math.abs(vn) < 0.6 ? 0 : RESTITUTION;
    const j = (-(1 + e) * vn) / kn;
    b.v.addScaledVector(n, j * b.invMass);
    _v3.copy(r).cross(n).multiplyScalar(j * b.invInertia);
    b.w.add(_v3);
    // 切向摩擦
    _vp.copy(b.w).cross(r).add(b.v);
    _vt.copy(_vp).addScaledVector(n, -_vp.dot(n));
    const vtLen = _vt.length();
    if (vtLen < 1e-4) return;
    _t.copy(_vt).multiplyScalar(1 / vtLen);
    _rt.copy(r).cross(_t);
    const kt = b.invMass + _rt.lengthSq() * b.invInertia;
    if (kt <= 1e-9) return;
    let jt = -vtLen / kt;
    const maxJt = FRICTION * Math.abs(j);
    if (jt < -maxJt) jt = -maxJt;
    b.v.addScaledVector(_t, jt * b.invMass);
    _v3.copy(r).cross(_t).multiplyScalar(jt * b.invInertia);
    b.w.add(_v3);
  }

  /** 速度低于阈值并持续一段时间 → 入睡（倒地后完全停止积分，节省性能） */
  _updateSleep(h) {
    let maxV = 0;
    let maxW = 0;
    let touching = 0;
    for (const b of this.bodies) {
      const vs = b.v.lengthSq();
      const ws = b.w.lengthSq();
      if (vs > maxV) maxV = vs;
      if (ws > maxW) maxW = ws;
      if (b.contactCount > 0 || b.aabbHit) touching++;
    }
    maxV = Math.sqrt(maxV);
    maxW = Math.sqrt(maxW);
    if (this.time > MAX_LIFE || (maxV < SLEEP_LIN && maxW < SLEEP_ANG && touching >= 2)) {
      this.sleepTimer += h;
      if (this.time > MAX_LIFE || this.sleepTimer >= SLEEP_TIME) {
        this.settled = true;
        for (const b of this.bodies) {
          b.v.set(0, 0, 0);
          b.w.set(0, 0, 0);
        }
        unregisterRagdoll(this);
      }
    } else {
      this.sleepTimer = 0;
    }
  }

  /**
   * 把世界姿态写回部件的本地变换（anchor 为所有部件的共同父节点，通常是角色 root）。
   * 已入睡/冻结后姿态不再变化，因此只在首次写入（或 anchor 世界矩阵变了）时重算，
   * 其余帧直接跳过 —— 倒地后的每帧成本几乎为 0。
   */
  _writeBack() {
    const bodies = this.bodies;
    const first = bodies[0] && bodies[0].obj ? bodies[0].obj.parent : null;
    let shared = !!first;
    if (shared) {
      for (let i = 1; i < bodies.length; i++) {
        const obj = bodies[i].obj;
        if (!obj || obj.parent !== first) { shared = false; break; }
      }
    }
    // 已静止：只要 root 没动过就不需要再写（角色 root 每帧仍可能被外部插值移动）
    if (this.isSettled && this._written && shared && this._anchor) {
      this._anchor.updateWorldMatrix(true, false);
      if (this._anchorMatrix.equals(this._anchor.matrixWorld)) return;
    }
    if (shared) {
      first.updateWorldMatrix(true, false);
      _inv.copy(first.matrixWorld).invert();
      _q2.setFromRotationMatrix(_inv);
      for (const b of bodies) {
        if (!b.obj) continue;
        // 碰撞盒中心 → 关节原点
        _v1.copy(b.offset).applyQuaternion(b.q);
        _v2.copy(b.p).sub(_v1).applyMatrix4(_inv);
        _q1.copy(_q2).multiply(b.q);
        b.obj.position.copy(_v2);
        b.obj.quaternion.copy(_q1);
      }
      // 记录 anchor 矩阵，供下次判断是否需要重写
      this._anchor = first;
      this._anchorMatrix.copy(first.matrixWorld);
      this._written = true;
      return;
    }
    // 兜底：部件父节点不同（外部自定义用法）
    for (const b of bodies) {
      const obj = b.obj;
      if (!obj || !obj.parent) continue;
      obj.parent.updateWorldMatrix(true, false);
      _inv.copy(obj.parent.matrixWorld).invert();
      _q2.setFromRotationMatrix(_inv);
      _v1.copy(b.offset).applyQuaternion(b.q);
      _v2.copy(b.p).sub(_v1).applyMatrix4(_inv);
      _q1.copy(_q2).multiply(b.q);
      obj.position.copy(_v2);
      obj.quaternion.copy(_q1);
    }
  }

  /** 冻结：保留当前姿态，释放物理预算（被第 4 个布娃娃挤掉时调用） */
  freeze() {
    this.frozen = true;
    this.settled = true;
    for (const b of this.bodies) {
      b.v.set(0, 0, 0);
      b.w.set(0, 0, 0);
    }
    unregisterRagdoll(this);
  }

  /** 停止并退出活跃列表（角色重生/复用前调用） */
  stop() {
    this.freeze();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    unregisterRagdoll(this);
    this.bodies.length = 0;
    this.constraints.length = 0;
    this.colliders.length = 0;
  }
}

/**
 * 创建布娃娃。
 * @param {Array} parts 部件定义
 * @param {object} options { links, anchor }
 * @returns {Ragdoll}
 */
export function createRagdoll(parts, options = {}) {
  return new Ragdoll(parts, options);
}

export default createRagdoll;
