// ===== 本地玩家：输入、预测移动、碰撞、与服务器对账 =====
import * as THREE from 'three';
import { WORLD, WEAPONS, stepPlayerPhysics } from '../shared/map.js';

export class LocalPlayer {
  constructor(camera, net) {
    this.camera = camera;
    this.net = net;
    this.pos = new THREE.Vector3(0, 0, 0);
    this.prevPos = new THREE.Vector3(0, 0, 0);
    this.vy = 0;
    this.grounded = true;
    this.yaw = 0;
    this.pitch = 0;
    this.serverPos = null; // 服务器权威位置（用于对账）
    this.keys = new Set();
    this.jumpHeld = false;
    this.shooting = false;
    this.lastFire = 0;
    this.seq = 0;
    this.inputTimer = 0;
    this.sens = 0.0022;
    this.locked = false;
    this.alive = true;
    this.hp = WORLD.maxHp;
    this.weapon = 'pistol';
    this.aiming = false;
    this.started = false;
  }

  reset(spawn) {
    this.pos.set(spawn.x, 0, spawn.z);
    this.prevPos.copy(this.pos);
    this.vy = 0;
    this.grounded = true;
    this.yaw = Math.atan2(spawn.x, spawn.z);
    this.pitch = 0;
    this.serverPos = null;
    this.alive = true;
    this.hp = WORLD.maxHp;
    this.weapon = 'pistol';
    this.aiming = false;
  }

  onMouseMove(dx, dy) {
    this.yaw -= dx * this.sens;
    this.pitch -= dy * this.sens;
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch));
  }

  // 实时上报输入（独立 30Hz 定时器调用，与渲染帧率解耦）
  sendInput() {
    if (!this.locked || !this.alive) return;
    let mx = 0, mz = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) mz += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) mz -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mx += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) mx -= 1;
    const len = Math.hypot(mx, mz);
    if (len > 1) { mx /= len; mz /= len; }
    this.net.send({ t: 'input', seq: this.seq++, yaw: this.yaw, pitch: this.pitch, mx, mz, jump: this.jumpHeld, aim: this.aiming });
  }

  // 固定时间步累加器：无论帧率多低，物理都按 50ms 步长推进，避免低帧率慢动作
  stepFrame(dt) {
    this.acc = (this.acc || 0) + Math.min(dt, 0.25);
    const STEP = 0.05;
    let n = 0;
    while (this.acc >= STEP && n < 8) {
      this.prevPos.copy(this.pos);
      this.update(STEP);
      this.acc -= STEP;
      n++;
    }
  }

  update(dt) {
    // ???????????????????????
    if (this.locked && this.alive) {
      let mx = 0, mz = 0;
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) mz += 1;
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) mz -= 1;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mx += 1;
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) mx -= 1;
      const len = Math.hypot(mx, mz);
      if (len > 1) { mx /= len; mz /= len; }

      // ???????????
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      let fx = -sin * mz + cos * mx;
      let fz = -cos * mz - sin * mx;
      const fl = Math.hypot(fx, fz);
      if (fl > 1) { fx /= fl; fz /= fl; }

      this.pos.x += fx * WORLD.moveSpeed * dt;
      this.pos.z += fz * WORLD.moveSpeed * dt;

      if (this.grounded && this.jumpHeld) { this.vy = WORLD.jumpSpeed; this.grounded = false; }

      // 3D 平台物理（共享，与服务器一致）：水平推挤 + 重力 + 落地/撞头 + 地面
      const body = { x: this.pos.x, y: this.pos.y, z: this.pos.z, vy: this.vy, grounded: this.grounded };
      stepPlayerPhysics(body, dt);
      this.pos.set(body.x, body.y, body.z);
      this.vy = body.vy;
      this.grounded = body.grounded;


    }

    // 与服务器对账：小偏差忽略（避免移动抖动）、中等缓慢修正、大偏差快照（重生/瞬移）
    if (this.serverPos) {
      const err = new THREE.Vector3().subVectors(this.serverPos, this.pos);
      const eLen = err.length();
      if (eLen > 2.5) {
        this.pos.copy(this.serverPos);
        this.prevPos.copy(this.pos); // 快照时同步插值起点，避免瞬移扫过
      }
      else if (eLen > 0.4) this.pos.addScaledVector(err, Math.min(1, 2.5 * dt));
    }
  }

  // 渲染相机：在前后两个物理状态之间按帧插值，消除 20Hz 跳变（移动不卡顿）
  renderCamera() {
    const alpha = Math.max(0, Math.min(1, (this.acc || 0) / 0.05));
    const x = this.prevPos.x + (this.pos.x - this.prevPos.x) * alpha;
    const y = this.prevPos.y + (this.pos.y - this.prevPos.y) * alpha;
    const z = this.prevPos.z + (this.pos.z - this.prevPos.z) * alpha;
    this.camera.position.set(x, y + WORLD.eyeHeight, z);
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }

  tryFire(now) {
    if (!this.alive || !this.locked) return false;
    const wpn = WEAPONS[this.weapon] || WEAPONS.pistol;
    if (now - this.lastFire < wpn.fireInterval * 1000) return false;
    this.lastFire = now;
    this.net.send({ t: 'shoot', yaw: this.yaw, pitch: this.pitch });
    return true;
  }
}
