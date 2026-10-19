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

// 开镜时眼睛到瞄具的距离（按枪型分别设置：机瞄要贴近照门才真实，红点/手枪稍远）
const ADS_CONFIG = {
  // 眼距（relief）= 眼睛到镜片的距离。
  // 注意：不要把枪"怼到脸上"来放大镜片——那会让枪托/机匣穿过近裁剪面（看起来像穿模）。
  // 这里保持 0.24~0.26m 的真实眼距，靠"镜片本身做大 + 镜片内 PiP 放大"来获得大视野。
  pistol: { relief: 0.26, scale: 0.90 },
  smg: { relief: 0.24, scale: 0.90 },
  ak47: { relief: 0.23, scale: 0.95 },
  shotgun: { relief: 0.26, scale: 0.90 },
  sniper: { relief: 0.24, scale: 0.90 },
};

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
const _shoulderR = new THREE.Vector3();
const _shoulderL = new THREE.Vector3();
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
    const gloveMat = makeArmMaterial(0x4b4d3f, { dithering: true });
    const sleeve = (radius) => makeBoneMesh(sleeveMat, radius);
    const cuff = (radius) => makeBoneMesh(cuffMat, radius);

    const mk = () => {
      const upper = sleeve(0.032);
      const fore = sleeve(0.026);
      const cuffMesh = cuff(0.029);
      const handGeo = new THREE.BoxGeometry(0.034, 0.042, 0.062);
      handGeo.translate(0, 0.020, 0);
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
    let L1 = ARM.upperLen, L2 = ARM.foreLen;
    // 开镜时枪会前移到瞄准位置，手臂需要略微"拉伸"才能一直握住枪；
    // 允许有限度的动态延长，避免手掌脱离握把（视觉上远好于悬空）。
    const reach = L1 + L2 - 0.02;
    if (d > reach) {
      const k = Math.min(1.6, d / reach);
      L1 *= k; L2 *= k;
    }
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
    // 手掌不要和枪身重叠：向外侧 + 向下偏移，开镜时偏移更大（避免挡住照门/红点）
    const ads = this.adsVisual || 0;
    const side = arm === this._arms.right ? 1 : -1;
    arm.hand.position.set(
      wrist.x + side * (0.022 + ads * 0.018),
      wrist.y - (0.024 + ads * 0.016),
      wrist.z + 0.004 + ads * 0.004,
    );
    arm.hand.quaternion.copy(gunQuat);
    arm.hand.rotateZ(side * 0.22);
    arm.hand.rotateX(-0.18);
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
    // 开镜时肩膀随枪前倾（模拟抵肩），让手臂自然够到前移后的握把
    const ads = this.adsVisual || 0;
    _shoulderR.copy(ARM.shoulderR); _shoulderR.z -= ads * 0.30; _shoulderR.y -= ads * 0.04;
    _shoulderL.copy(ARM.shoulderL); _shoulderL.z -= ads * 0.24; _shoulderL.y -= ads * 0.03;
    this._solveArm(rig.right, _shoulderR, this._gripR, ARM.poleR, handQuat);
    this._solveArm(rig.left, _shoulderL, this._gripL, ARM.poleL, handQuat);
    rig.group.visible = true;
  }

  register(kind, group) {
    this.guns[kind] = group;
    this._bindOptics(group);
    if (!this.active) this.setWeapon(kind);
  }

  // 把光学 shader 绑定到镜片平面（RDS 类瞄具）
  _bindOptics(group) {
    const lens = group && group.userData ? group.userData.redDot : null;
    if (!lens || !lens.userData || !lens.userData.isOpticLens) return;
    if (!this.optics) return;
    // 不能直接 clone()：three 的 cloneUniforms 会拒绝克隆 RenderTarget 纹理，导致镜片全黑。
    // 这里手工构造材质，共享同一张场景贴图，但每个瞄具拥有独立的 uniform 值。
    const src = this.optics.material;
    const hex = lens.userData.reticleColor;
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uScene: { value: this.optics.rt.texture },
        uOpacity: { value: 0 },
        uAspect: { value: 1 },
        uReticleColor: { value: new THREE.Color(typeof hex === 'number' ? hex : 0xff3b2a) },
        uBarrel: { value: src.uniforms.uBarrel.value },
        uSoftness: { value: src.uniforms.uSoftness.value },
        uDotOffset: { value: new THREE.Vector2(0, 0) },
        uDotSize: { value: src.uniforms.uDotSize.value },
      },
      vertexShader: src.vertexShader,
      fragmentShader: src.fragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      toneMapped: true,
    });
    lens.material.dispose();
    lens.material = mat;
  }

  setWeapon(kind) {
    this.kind = kind;
    const next = this.guns[kind] || null;
    for (const g of Object.values(this.guns)) g.visible = false;
    this.active = next;
  }

  /**
   * 计算镜片内 PiP 相机应使用的 FOV（度）。
   * 物理关系：镜片在眼睛看来占的角直径 = 2·atan(r_world / relief)，
   * 要让镜片内的画面放大 M 倍，镜内呈现的世界视场角就必须 = 角直径 / M。
   * 返回 0 表示当前武器没有光学镜片（不需要 PiP）。
   */
  opticCameraFov() {
    const gun = this.active;
    if (!gun || !gun.userData) return 0;
    const lens = gun.userData.redDot;
    const mag = gun.userData.opticMagnification || 0;
    if (!lens || !lens.userData || !lens.userData.isOpticLens || mag <= 1) return 0;
    const cfg = ADS_CONFIG[this.kind] || ADS_CONFIG.pistol;
    const rWorld = (lens.userData.lensRadius || 0.01) * gun.scale.x;
    const relief = Math.max(0.05, cfg.relief || 0.26);
    const halfAngRad = Math.atan2(rWorld, relief);
    const lensAngularDeg = (halfAngRad * 2 * 180) / Math.PI;
    // 镜内视场 = 镜片角直径 / 放大倍率（11.4° 一类的小 FOV，才是真正的"M 倍放大"）
    return Math.max(4, Math.min(60, lensAngularDeg / mag));
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
    const cfg = ADS_CONFIG[kind] || ADS_CONFIG.pistol;
    // 开镜只做轻微缩放（保持真实瞄具尺寸），主要靠相机贴近照门/红点实现瞄准
    if (gun.userData._baseScale == null) gun.userData._baseScale = gun.scale.x;
    const scale = gun.userData._baseScale * (1 - ads * (1 - cfg.scale));
    gun.scale.setScalar(scale);

    // ---- 开镜位置：让 sightPoint 落在相机局部 (0,0,-relief) ----
    const sp = gun.userData.sightPoint || this._tmp.set(0, 0.05, -0.2);
    this._adsPos.set(
      -sp.x * scale,
      -sp.y * scale,
      -cfg.relief - sp.z * scale,
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
    // 开镜时手臂必须继续跟随枪身（否则会出现"枪和手分离"）；只有狙击镜隐藏枪身时一起隐藏
    const armsOn = gun.visible;
    if (this._arms) this._arms.group.visible = armsOn;
    if (armsOn) this._updateArms(gun);

    // 光学镜片：开镜量决定不透明度；镜片随开镜略微放大、更贴近眼睛（凑近镜筒的真实感）
    const dot = gun.userData.redDot;
    if (dot) {
      dot.visible = ads > 0.02 && !this.scopeActive;
      if (dot.userData && dot.userData.isOpticLens) {
        const mat = dot.material;
        if (mat && mat.uniforms && mat.uniforms.uOpacity) {
          mat.uniforms.uOpacity.value = Math.min(1, Math.max(0, (ads - 0.05) / 0.85));

          // ---- 红点视差摆动 ----
          // 真实红点：镜片里的亮点会随呼吸/走动在窗口内轻微游走（视差），
          // 但镜片中心（= 相机正前方 = 弹道方向）恒定不变，所以瞄准点不受影响。
          const moveAmt = Math.min(1, (p.speed || 0) / WORLD.sprintSpeed);
          const breath = Math.sin(t * 1.7) * 0.5 + Math.sin(t * 3.1 + 1.2) * 0.28;
          const walkX = Math.cos(p.bobPhase || 0) * 0.012 * moveAmt;
          const walkY = Math.abs(Math.sin(p.bobPhase || 0)) * 0.010 * moveAmt;
          const swayX = (breath * 0.008 + walkX) * (1 - ads * 0.25);
          const swayY = (Math.sin(t * 2.3 + 0.7) * 0.007 + walkY) * (1 - ads * 0.25);
          mat.uniforms.uDotOffset.value.set(swayX, swayY);
        }
      }
    }

    return { visible: gun.visible, scopeActive: this.scopeActive, ads };
  }
}
