// ===== 本地玩家：输入、预测移动、碰撞、武器状态机、后坐力 =====
import * as THREE from 'three';
import { WORLD, weaponOf, WEAPON_ORDER, STARTING_WEAPONS, currentSpread, stepPlayerPhysics } from '../shared/map.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

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
    this.aiming = false;
    this.started = false;

    // ---- 武器系统 ----
    this.owned = {};
    for (const id of STARTING_WEAPONS) this.owned[id] = true;
    this.ammo = {};
    for (const id of STARTING_WEAPONS) {
      const w = weaponOf(id);
      this.ammo[id] = { mag: w.magSize, reserve: w.reserveStart };
    }
    this.weapon = 'pistol';
    this.reloadUntil = 0;     // 本地 performance.now() 时间戳
    this.swapUntil = 0;
    this.reloadTotal = 0;     // 换弹总时长（用于进度条）
    this.semiLatch = false;   // 半自动：按下后需松开才能再击发
    this.burst = 0;           // 连发计数（后坐力递增）
    this.spreadHeat = 0;      // 散布热度
    this.recoilPitch = 0;     // 后坐力累积（叠加在视角上）
    this.recoilYaw = 0;
    this.lastShotAt = 0;
    this.lastDryFire = 0;
    this.speed = 0;           // 水平速度（供动画用）
  }

  weaponDef() { return weaponOf(this.weapon); }

  ammoOf() {
    if (!this.ammo[this.weapon]) {
      const w = this.weaponDef();
      this.ammo[this.weapon] = { mag: w.magSize, reserve: w.reserveStart };
    }
    return this.ammo[this.weapon];
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
    this.aiming = false;
    // 武器：死亡不没收，但弹药补满
    for (const id of Object.keys(this.owned)) {
      const w = weaponOf(id);
      this.ammo[id] = { mag: w.magSize, reserve: w.reserveStart };
    }
    this.weapon = this.owned.pistol ? 'pistol' : Object.keys(this.owned)[0] || 'pistol';
    this.reloadUntil = 0;
    this.swapUntil = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.burst = 0;
    this.spreadHeat = 0;
    this.semiLatch = false;
  }

  onMouseMove(dx, dy) {
    this.yaw -= dx * this.sens;
    this.pitch -= dy * this.sens;
    this.pitch = clamp(this.pitch, -1.5, 1.5);
  }

  // 瞄准方向 = 基础视角 + 后坐力偏移（上报给服务器，因此压枪可抵消）
  aimYaw() { return this.yaw + this.recoilYaw; }
  aimPitch() { return clamp(this.pitch + this.recoilPitch, -1.5, 1.5); }

  isMoving() {
    for (const k of this.keys) {
      if (k === 'KeyW' || k === 'ArrowUp' || k === 'KeyS' || k === 'ArrowDown' ||
          k === 'KeyA' || k === 'ArrowLeft' || k === 'KeyD' || k === 'ArrowRight') return true;
    }
    return false;
  }

  // 当前散布（弧度，半角），供准星扩散显示
  currentSpreadRad() {
    const w = this.weaponDef();
    return currentSpread(w, {
      moving: this.isMoving() && this.grounded,
      ads: this.aiming,
      shots: Math.floor(this.spreadHeat),
    });
  }

  reloadProgress() {
    if (this.reloadUntil <= 0) return 0;
    const left = this.reloadUntil - now();
    return clamp(1 - left / Math.max(1, this.reloadTotal), 0, 1);
  }

  swapProgress() {
    if (this.swapUntil <= 0) return 0;
    const w = this.weaponDef();
    return clamp(1 - (this.swapUntil - now()) / Math.max(1, w.swapTime * 1000), 0, 1);
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
    this.net.send({
      t: 'input', seq: this.seq++,
      yaw: this.aimYaw(), pitch: this.aimPitch(),
      mx, mz, jump: this.jumpHeld, aim: this.aiming,
    });
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
    this.tickTimers(dt);
  }

  // 计时器推进（后坐力恢复、换弹、切枪、连发重置）按渲染帧平滑进行
  tickTimers(dt) {
    const t = now();
    const w = this.weaponDef();

    // 后坐力恢复（指数回落，玩家下拉鼠标即"压枪"）
    const decay = Math.exp(-w.recoil.recovery * dt);
    this.recoilPitch *= decay;
    this.recoilYaw *= decay;
    if (Math.abs(this.recoilPitch) < 1e-5) this.recoilPitch = 0;
    if (Math.abs(this.recoilYaw) < 1e-5) this.recoilYaw = 0;

    // 散布热度回落
    this.spreadHeat *= Math.exp(-w.spreadRecover * dt);
    if (this.spreadHeat < 0.05) this.spreadHeat = 0;

    // 停火 450ms 后连发计数归零
    if (t - this.lastShotAt > 450) this.burst = 0;

    // 换弹完成 → 本地补弹（服务器权威值随后覆盖）
    if (this.reloadUntil > 0 && t >= this.reloadUntil) {
      const a = this.ammoOf();
      const need = w.magSize - a.mag;
      const take = a.reserve === Infinity ? need : Math.min(need, a.reserve);
      a.mag += take;
      if (a.reserve !== Infinity) a.reserve -= take;
      this.reloadUntil = 0;
    }
  }

  update(dt) {
    if (this.locked && this.alive) {
      let mx = 0, mz = 0;
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) mz += 1;
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) mz -= 1;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mx += 1;
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) mx -= 1;
      const len = Math.hypot(mx, mz);
      if (len > 1) { mx /= len; mz /= len; }

      // 朝向基底：yaw 决定前后左右
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      let fx = -sin * mz + cos * mx;
      let fz = -cos * mz - sin * mx;
      const fl = Math.hypot(fx, fz);
      if (fl > 1) { fx /= fl; fz /= fl; }

      const prevX = this.pos.x, prevZ = this.pos.z;
      const spd = WORLD.moveSpeed
        * (this.aiming ? WORLD.aimSpeedMult : 1)
        * weaponOf(this.weapon).moveSpeedMult;
      this.pos.x += fx * spd * dt;
      this.pos.z += fz * spd * dt;

      if (this.grounded && this.jumpHeld) { this.vy = WORLD.jumpSpeed; this.grounded = false; }

      // 3D 平台物理（共享，与服务器一致）：水平推挤 + 重力 + 落地/撞头 + 地面
      const body = { x: this.pos.x, y: this.pos.y, z: this.pos.z, vy: this.vy, grounded: this.grounded };
      stepPlayerPhysics(body, dt);
      this.pos.set(body.x, body.y, body.z);
      this.vy = body.vy;
      this.grounded = body.grounded;

      this.speed = Math.hypot(this.pos.x - prevX, this.pos.z - prevZ) / Math.max(dt, 1e-4);
    } else {
      this.speed *= 0.85;
    }

    // 与服务器对账：小偏差忽略（避免移动抖动）、中等缓慢修正、大偏差快照（重生/瞬移）
    if (this.serverPos) {
      const err = new THREE.Vector3().subVectors(this.serverPos, this.pos);
      const eLen = err.length();
      if (eLen > 2.5) {
        this.pos.copy(this.serverPos);
        this.prevPos.copy(this.pos); // 快照时同步插值起点，避免瞬移扫过
      } else if (eLen > 0.4) this.pos.addScaledVector(err, Math.min(1, 2.5 * dt));
    }
  }

  // 渲染相机：在前后两个物理状态之间按帧插值，消除 20Hz 跳变（移动不卡顿）
  renderCamera() {
    const alpha = Math.max(0, Math.min(1, (this.acc || 0) / 0.05));
    const x = this.prevPos.x + (this.pos.x - this.prevPos.x) * alpha;
    const y = this.prevPos.y + (this.pos.y - this.prevPos.y) * alpha;
    const z = this.prevPos.z + (this.pos.z - this.prevPos.z) * alpha;
    this.camera.position.set(x, y + WORLD.eyeHeight, z);
    // 后坐力叠加在相机上（抬枪 + 水平抖动）
    this.camera.rotation.set(clamp(this.pitch + this.recoilPitch, -1.5, 1.5), this.yaw + this.recoilYaw, 0);
  }

  // ---------- 开火 ----------
  tryFire() {
    const t = now();
    if (!this.alive || !this.locked) return false;
    const w = this.weaponDef();
    if (t < this.swapUntil) return false;              // 切枪硬直
    if (this.reloadUntil > 0) return false;            // 换弹中
    if (t - this.lastFire < w.fireInterval * 1000) return false;
    if (w.fireMode === 'semi' && this.semiLatch) return false;  // 半自动：需松开再按

    const a = this.ammoOf();
    if (a.mag <= 0) { this.dryFire(); return false; }

    a.mag -= 1;
    this.lastFire = t;
    this.lastShotAt = t;
    if (w.fireMode === 'semi') this.semiLatch = true;

    // 后坐力：基础抬枪 × 连发递增，水平随机抖动
    const stack = Math.min(this.burst, w.recoil.maxRamp);
    const mult = 1 + w.recoil.ramp * stack;
    this.recoilPitch += w.recoil.pitch * mult;
    this.recoilYaw += (Math.random() * 2 - 1) * w.recoil.yaw * mult;
    this.burst += 1;
    this.spreadHeat = Math.min(this.spreadHeat + 1, 30);

    this.net.send({ t: 'shoot', yaw: this.aimYaw(), pitch: this.aimPitch() });

    if (a.mag <= 0) this.requestReload();   // 打空自动换弹
    return true;
  }

  // 空枪：告知服务器（触发自动换弹），本地做节流避免连点刷音效
  dryFire() {
    const t = now();
    if (t - this.lastDryFire < 600) return;
    this.lastDryFire = t;
    this.lastFire = t;
    this.net.send({ t: 'shoot', yaw: this.aimYaw(), pitch: this.aimPitch() });
    this.requestReload();
  }

  // ---------- 换弹 / 切枪 ----------
  requestReload() {
    const t = now();
    if (this.reloadUntil > 0) return false;
    const w = this.weaponDef();
    const a = this.ammoOf();
    if (a.mag >= w.magSize) return false;
    if (!(a.reserve > 0)) return false;
    this.reloadTotal = w.reloadTime * 1000;
    this.reloadUntil = t + this.reloadTotal;
    this.net.send({ t: 'reload' });
    return true;
  }

  requestSwitch(id) {
    const t = now();
    if (!this.owned[id] || id === this.weapon) return false;
    if (t < this.swapUntil) return false;
    const w = weaponOf(id);
    this.weapon = id;
    this.reloadUntil = 0;      // 切枪打断换弹
    this.burst = 0;
    this.spreadHeat = 0;
    this.semiLatch = false;
    this.swapUntil = t + w.swapTime * 1000;
    this.net.send({ t: 'switch', weapon: id });
    return true;
  }

  // 滚轮 / Q 键循环切换已持有的武器
  cycleWeapon(dir = 1) {
    const list = WEAPON_ORDER.filter((id) => this.owned[id]);
    if (list.length < 2) return false;
    const i = list.indexOf(this.weapon);
    const next = list[(i + dir + list.length) % list.length];
    return this.requestSwitch(next);
  }

  onTriggerUp() { this.semiLatch = false; }

  // 服务器权威状态同步（弹药/持有/武器）
  syncWeaponFromServer(me) {
    if (me.owned) {
      this.owned = {};
      for (const id of me.owned) this.owned[id] = true;
      for (const id of me.owned) {
        if (!this.ammo[id]) {
          const w = weaponOf(id);
          this.ammo[id] = { mag: w.magSize, reserve: w.reserveStart };
        }
      }
    }
    if (me.weapon && me.weapon !== this.weapon) {
      this.weapon = me.weapon;
      this.burst = 0;
      this.spreadHeat = 0;
    }
    if (me.ammo) {
      const a = this.ammoOf();
      const recentShot = now() - this.lastFire < 120;
      // 刚开火时不采用服务器回弹的更大值，避免弹药数字跳变
      if (!recentShot || me.ammo.mag < a.mag) a.mag = me.ammo.mag;
      a.reserve = me.ammo.reserve < 0 ? Infinity : me.ammo.reserve;
    }
  }
}
