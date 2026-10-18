// ===== 开镜 / 第一人称武器与手臂姿态控制器 =====
// 关键点：开镜不是"摆一个遮罩"，而是把武器上的 sightPoint 精确对齐到相机中心，
// 并让枪身 -Z 与视线同向 —— 这样机械瞄具 / 红点 / 狙击镜才真正可用。
// 另外提供程序化第一人称手臂（双骨 IK），避免"悬浮枪"穿帮。
import * as THREE from 'three';
import { WORLD } from '../shared/world.js';
import { weaponOf } from '../shared/weapons.js';

// 腰射姿态（相机局部坐标）；长枪更靠下前方
const HIP_POS = {
  pistol: [0.205, -0.225, -0.52],
  smg: [0.195, -0.220, -0.50],
  ak47: [0.185, -0.215, -0.49],
  shotgun: [0.190, -0.225, -0.47],
  sniper: [0.180, -0.210, -0.48],
};
const HIP_ROT = {
  pistol: [0.02, -0.06, 0.015],
  smg: [0.02, -0.055, 0.012],
  ak47: [0.025, -0.05, 0.010],
  shotgun: [0.03, -0.05, 0.010],
  sniper: [0.02, -0.04, 0.008],
};

// 开镜时眼睛到瞄具的距离（相机局部 z 绝对值）
// 需要留出足够的余量，否则枪托/机匣会穿过近裁剪面变成黑色大块。
const ADS_EYE_RELIEF = 0.75;

// 第一人称手臂尺寸（相机局部，米）
const ARM = {
  upperLen: 0.30,
  foreLen: 0.27,
  // 肩点放低、放前，避免上臂贴着近裁剪面显得巨大
  shoulderR: new THREE.Vector3(0.33, -0.46, -0.28),
  shoulderL: new THREE.Vector3(-0.29, -0.48, -0.27),
  poleR: new THREE.Vector3(0.58, -0.66, -0.30),
  poleL: new THREE.Vector3(-0.54, -0.70, -0.32),
};

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _UP = new THREE.Vector3(0, 1, 0);

function makeArmMaterial(color, extra = {}) {
  return new THREE.MeshLambertMaterial({ color, ...extra });
}

function makeBoneMesh(mat, radius) {
  const geo = new THREE.CylinderGeometry(radius * 0.82, radius, 1, 7, 1, false);
  geo.translate(0, 0.5, 0);
  return new THREE.Mesh(geo, mat);
}

function orientBone(mesh, from, to) {
  _v1.subVectors(to, from);
  const len = Math.max(1e-4, _v1.length());
  mesh.position.copy(from);
  mesh.scale.set(1, len, 1);
  _q1.setFromUnitVectors(_UP, _v1.multiplyScalar(1 / len));
  mesh.quaternion.copy(_q1);
}

export class ScopeController {
  constructor(camera) {
    this.camera = camera;
    this.guns = {};
    this.active = null;
    this.kind = 'pistol';
    this.adsVisual = 0;
    this.scopeActive = false;
    this._adsPos = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._gripR = new THREE.Vector3(0, -0.01, -0.02);
    this._gripL = new THREE.Vector3(-0.01, 0.005, -0.3);
    this._arms = this._buildArms();
    if (camera) camera.add(this._arms.group);
  }

  // ---------- 程序化第一人称手臂 ----------
  _buildArms() {
    const group = new THREE.Group();
    group.name = 'fpArms';
    const sleeveMat = makeArmMaterial(0x6a7052, { dithering: true });
    const cuffMat = makeArmMaterial(0x4b4f3a, { dithering: true });
    const gloveMat = makeArmMaterial(0x6f6350, { dithering: true });
    const sleeve = (radius) => makeBoneMesh(sleeveMat, radius);
    const cuff = (radius) => makeBoneMesh(cuffMat, radius);

    const mk = () => {
      const upper = sleeve(0.032);
      const fore = sleeve(0.026);
      const cuffMesh = cuff(0.029);
      const handGeo = new THREE.BoxGeometry(0.05, 0.055, 0.085);
      handGeo.translate(0, 0.026, 0);
      const hand = new THREE.Mesh(handGeo, gloveMat);
      group.add(upper, fore, cuffMesh, hand);
      return { upper, fore, cuff: cuffMesh, hand };
    };
    const rig = { group, right: mk(), left: mk() };
    group.traverse((o) => { if (o.isMesh) o.renderOrder = 2; });
    return rig;
  }

  _solveArm(arm, shoulder, target, pole, gunQuat) {
    _v1.subVectors(target, shoulder);
    let d = _v1.length();
    const L1 = ARM.upperLen, L2 = ARM.foreLen;
    d = Math.max(0.12, Math.min(L1 + L2 - 0.02, d));
    _v2.copy(_v1).normalize();
    // 肘部：余弦定理 + pole 方向正交化
    const cosA = Math.max(-1, Math.min(1, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d)));
    const a1 = Math.acos(cosA);
    _v3.subVectors(pole, shoulder);
    _v3.addScaledVector(_v2, -_v3.dot(_v2));
    if (_v3.lengthSq() < 1e-6) _v3.set(0, -1, 0);
    _v3.normalize();
    const sinA = Math.sin(a1);
    _v4.copy(shoulder)
      .addScaledVector(_v2, Math.cos(a1) * L1)
      .addScaledVector(_v3, sinA * L1);
    // 上臂 / 前臂 / 手套
    orientBone(arm.upper, shoulder, _v4);
    const wrist = _v2.clone().multiplyScalar(d).add(shoulder);
    orientBone(arm.fore, _v4, wrist);
    // 袖口：靠近腕部的一小段
    const cuffFrom = _v4.clone().lerp(wrist, 0.72);
    orientBone(arm.cuff, cuffFrom, wrist);
    arm.hand.position.copy(wrist);
    arm.hand.quaternion.copy(gunQuat);
    // 掌心略向枪身内侧
    arm.hand.rotateX(-0.15);
  }

  _updateArms(gun) {
    const rig = this._arms;
    if (!gun) { rig.group.visible = false; return; }
    gun.updateMatrix();
    const ud = gun.userData || {};
    if (ud.rightGrip) this._gripR.copy(ud.rightGrip); else this._gripR.set(0, -0.01, -0.02);
    if (ud.leftGrip) this._gripL.copy(ud.leftGrip); else this._gripL.set(-0.01, 0.005, -0.3);
    // 握持点从武器 local → 相机 local
    this._gripR.applyMatrix4(gun.matrix);
    this._gripL.applyMatrix4(gun.matrix);
    const handQuat = gun.quaternion;
    this._solveArm(rig.right, ARM.shoulderR, this._gripR, ARM.poleR, handQuat);
    this._solveArm(rig.left, ARM.shoulderL, this._gripL, ARM.poleL, handQuat);
    rig.group.visible = true;
  }

  register(kind, group) {
    this.guns[kind] = group;
    if (!this.active) this.setWeapon(kind);
  }

  setWeapon(kind) {
    this.kind = kind;
    const next = this.guns[kind] || null;
    for (const g of Object.values(this.guns)) g.visible = false;
    this.active = next;
  }

  /**
   * 每帧更新第一人称武器姿态。
   * @param {number} dt
   * @param {object} s { player, elapsed }
   */
  update(dt, s) {
    const gun = this.active;
    if (!gun) {
      if (this._arms) this._arms.group.visible = false;
      return { visible: false, scopeActive: false };
    }
    const p = s.player;
    const kind = this.kind;
    const w = weaponOf(kind);
    const ads = p.adsAmount;
    this.adsVisual = ads;
    this.scopeActive = !!p.scopeActive;
    // 开镜时把视图模型缩小（真实游戏常见做法），避免枪托/机匣贴脸占满屏幕
    if (gun.userData._baseScale == null) gun.userData._baseScale = gun.scale.x;
    const scale = gun.userData._baseScale * (1 - ads * 0.45);
    gun.scale.setScalar(scale);

    // ---- 开镜位置：让 sightPoint 落在相机局部 (0,0,-d) ----
    const sp = gun.userData.sightPoint || this._tmp.set(0, 0.05, -0.2);
    this._adsPos.set(
      -sp.x * scale,
      -sp.y * scale,
      -ADS_EYE_RELIEF - sp.z * scale,
    );

    const hip = HIP_POS[kind] || HIP_POS.pistol;
    const hrot = HIP_ROT[kind] || HIP_ROT.pistol;
    const t = s.elapsed;

    // ---- 腰射位与开镜位混合 ----
    let px = hip[0] + (this._adsPos.x - hip[0]) * ads;
    let py = hip[1] + (this._adsPos.y - hip[1]) * ads;
    let pz = hip[2] + (this._adsPos.z - hip[2]) * ads;
    let rx = hrot[0] * (1 - ads);
    let ry = hrot[1] * (1 - ads);
    let rz = hrot[2] * (1 - ads);

    // ---- 呼吸/手臂微晃（开镜时明显减小） ----
    const sway = 1 - ads * 0.88;
    px += Math.sin(t * 1.35) * 0.0045 * sway;
    py += Math.sin(t * 2.1 + 1.4) * 0.0035 * sway;
    pz += Math.sin(t * 1.55 + 0.7) * 0.004 * sway;
    rx += Math.sin(t * 1.9 + 0.3) * 0.006 * sway;
    ry += Math.sin(t * 1.15 + 2.1) * 0.005 * sway;

    // ---- 行走摆动 ----
    const walk = Math.min(p.speed / WORLD.sprintSpeed, 1) * (p.grounded ? 1 : 0.25);
    const wBob = walk * (1 - ads * 0.75);
    px += Math.cos(p.bobPhase) * 0.018 * wBob;
    py += Math.abs(Math.sin(p.bobPhase)) * 0.014 * wBob - wBob * 0.007;
    rz += Math.cos(p.bobPhase) * 0.012 * wBob;

    // ---- 换弹 / 切枪动作 ----
    const rp = p.reloadProgress ? p.reloadProgress() : 0;
    const sp2 = p.swapProgress ? p.swapProgress() : 0;
    const reloadDip = rp > 0 ? Math.sin(Math.min(1, rp) * Math.PI) : 0;
    const swapDip = sp2 > 0 && sp2 < 1 ? (1 - sp2) : 0;
    py -= reloadDip * 0.16 + swapDip * 0.30;
    pz += reloadDip * 0.05 + swapDip * 0.10;
    rx += reloadDip * 0.55 + swapDip * 0.85;
    rz += reloadDip * 0.42 + swapDip * 0.35;
    ry += reloadDip * 0.20 + swapDip * 0.12;

    // ---- 冲刺/滑铲收枪 ----
    if (p.sprinting) {
      const sprintK = Math.min(1, p.speed / (WORLD.sprintSpeed * 0.6));
      px += 0.05 * sprintK;
      py -= 0.10 * sprintK;
      pz += 0.06 * sprintK;
      rx += 0.42 * sprintK;
      ry -= 0.30 * sprintK;
      rz += 0.22 * sprintK;
    }
    if (p.sliding) {
      px += 0.04;
      py -= 0.16;
      rx += 0.55;
      rz += 0.12;
    }

    // ---- 后坐力：枪身后座 + 抬枪口 ----
    const kick = Math.min(0.07, (p.recoilPitch || 0) * 0.45);
    pz += kick * 0.55;
    py += kick * 0.10;
    rx += kick * 1.45;

    gun.position.set(px, py, pz);
    gun.rotation.set(rx, ry, rz);
    gun.visible = !this.scopeActive && (p.alive !== false);
    // 开镜时隐藏程序化手臂（粗糙的方块手会挡住机瞄），只保留枪身与瞄准具
    const armsOn = gun.visible && ads < 0.5;
    if (this._arms) this._arms.group.visible = armsOn;
    if (armsOn) this._updateArms(gun);

    // 红点：仅在开镜时可见（其余时间保留镜片暗玻璃，避免穿帮）
    const dot = gun.userData.redDot;
    if (dot) dot.visible = ads > 0.12 && !this.scopeActive;

    return { visible: gun.visible, scopeActive: this.scopeActive, ads };
  }
}
