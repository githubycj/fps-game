// ===== 本地玩家：输入 / 客户端预测移动 / 体力与姿态 / 开镜 / 武器状态机 / 后坐力 =====
// 移动与地形碰撞全部走 shared/world.js（与服务器同源），保证预测一致。
import * as THREE from 'three';
import {
  WORLD, heightAt, movePlayerHorizontal, stepPlayerPhysics, applyJump, surfaceAt, groundHeightAt,
} from '../shared/world.js';
import {
  weaponOf, WEAPON_ORDER, STARTING_WEAPONS, currentSpread,
} from '../shared/weapons.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const STEP = 0.05;           // 固定物理步长（50ms）
const BASE_FOV = 75;

// 确定性伪随机（后坐力弹道用，便于玩家学习压枪）
function h1(n) {
  let x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export class LocalPlayer {
  constructor(camera, net) {
    this.camera = camera;
    this.net = net;

    // ---- 位置与物理 ----
    this.pos = new THREE.Vector3(0, 0, 0);
    this.prevPos = new THREE.Vector3(0, 0, 0);
    this.serverPos = null;
    this.vy = 0;
    this.grounded = true;
    this.acc = 0;
    this.speed = 0;
    this.stepDist = 0;

    // ---- 视角 ----
    this.yaw = 0;
    this.pitch = 0;
    this.sens = 0.0022 * ((typeof window !== 'undefined' && window.__settings && Number(window.__settings.sens)) || 1);
    this.locked = false;
    this.alive = true;
    this.hp = WORLD.maxHp;
    this.team = 'alpha';

    // ---- 姿态 / 体力 ----
    this.keys = new Set();
    this.jumpHeld = false;
    this.aiming = false;
    this.adsAmount = 0;
    this.scopeActive = false;
    this.sprinting = false;
    this.sliding = false;
    this.stance = 'stand';
    this.stamina = WORLD.staminaMax;
    this.slideUntil = 0;
    this.slideReadyAt = 0;
    this.regenAt = 0;
    this.sprintFireBlockUntil = 0;
    this._crouchPrev = false;
    this._wasSprinting = false;
    this.eye = WORLD.eyeHeight;
    this.bobPhase = 0;
    this.breathPhase = Math.random() * 10;

    // ---- 相机效果 ----
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.shakePitch = 0;
    this.shakeYaw = 0;
    this.shakeAmount = 0;
    this.landDip = 0;
    this.landTimer = 0;
    this.wasGrounded = true;
    this.hurtFlash = 0;

    // ---- 武器系统 ----
    this.owned = {};
    for (const id of STARTING_WEAPONS) this.owned[id] = true;
    this.ammo = {};
    for (const id of STARTING_WEAPONS) {
      const w = weaponOf(id);
      this.ammo[id] = { mag: w.magSize, reserve: w.reserveStart };
    }
    this.weapon = 'pistol';
    this.reloadUntil = 0;
    this.reloadTotal = 0;
    this.swapUntil = 0;
    this.semiLatch = false;
    this.burst = 0;
    this.shotIndex = 0;
    this.spreadHeat = 0;
    this.lastFire = 0;
    this.lastShotAt = 0;
    this.lastDryFire = 0;
    this.onFootstep = null;   // main.js 注入：(surface, speed, sprint) => void

    // ---- 调试/表现 ----
    this.lastFireResult = null;
  }

  // ---------- 基础 ----------
  weaponDef() { return weaponOf(this.weapon); }

  ammoOf() {
    if (!this.ammo[this.weapon]) {
      const w = this.weaponDef();
      this.ammo[this.weapon] = { mag: w.magSize, reserve: w.reserveStart };
    }
    return this.ammo[this.weapon];
  }

  reset(spawn, team = 'alpha') {
    const y = groundHeightAt(spawn.x, spawn.z, 0);
    this.pos.set(spawn.x, y, spawn.z);
    this.prevPos.copy(this.pos);
    this.vy = 0;
    this.grounded = true;
    this.team = team;
    this.yaw = Math.atan2(spawn.x, spawn.z);
    this.pitch = 0;
    this.serverPos = null;
    this.alive = true;
    this.hp = WORLD.maxHp;
    this.aiming = false;
    this.adsAmount = 0;
    this.scopeActive = false;
    this.sprinting = false;
    this.sliding = false;
    this.stance = 'stand';
    this.stamina = WORLD.staminaMax;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.shakeAmount = 0;
    this.landTimer = 0;
    this.burst = 0;
    this.shotIndex = 0;
    this.spreadHeat = 0;
    this.semiLatch = false;
    this.acc = 0;
    // 武器：死亡不没收，弹药补满
    for (const id of Object.keys(this.owned)) {
      const w = weaponOf(id);
      this.ammo[id] = { mag: w.magSize, reserve: w.reserveStart };
    }
    this.weapon = this.owned.pistol ? 'pistol' : (Object.keys(this.owned)[0] || 'pistol');
    this.reloadUntil = 0;
    this.swapUntil = 0;
  }

  // ---------- 鼠标 ----------
  onMouseMove(dx, dy) {
    // 开镜时按 FOV 比例降低灵敏度（真实光学放大后视角更细腻）
    const w = this.weaponDef();
    const fov = BASE_FOV + (w.adsFov - BASE_FOV) * this.adsAmount;
    const scale = fov / BASE_FOV;
    this.yaw -= dx * this.sens * scale;
    this.pitch -= dy * this.sens * scale;
    this.pitch = clamp(this.pitch, -1.5, 1.5);
  }

  // 实际瞄准方向 = 基础视角 + 后坐力累积（玩家下拉鼠标即为压枪）
  aimYaw() { return this.yaw + this.recoilYaw; }
  aimPitch() { return clamp(this.pitch + this.recoilPitch, -1.55, 1.55); }

  isMoving() {
    for (const k of this.keys) {
      if (k === 'KeyW' || k === 'KeyS' || k === 'KeyA' || k === 'KeyD' ||
        k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight') return true;
    }
    return false;
  }

  moveInput() {
    let mx = 0, mz = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) mz += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) mz -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mx += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) mx -= 1;
    const len = Math.hypot(mx, mz);
    if (len > 1) { mx /= len; mz /= len; }
    return { mx, mz, len: Math.min(len, 1) };
  }

  // ---------- 姿态 / 体力（每渲染帧） ----------
  canAim() { return !this.sliding && !this.sprinting; }

  tickStance(dt) {
    const t = now();
    const { mz } = this.moveInput();
    const crouchHeld = this.keys.has('KeyC') || this.keys.has('ControlLeft') || this.keys.has('ControlRight');
    const crouchPressed = crouchHeld && !this._crouchPrev;
    this._crouchPrev = crouchHeld;
    const shift = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');

    // 冲刺：按住 Shift + 向前移动 + 不在开镜/滑铲 + 有体力
    this.sprinting = !!(
      shift && mz > 0.1 && !this.aiming && !this.sliding &&
      this.grounded && this.alive && this.stamina > 1
    );

    // 滑铲：冲刺中按下蹲
    if (crouchPressed && this.sprinting && this.grounded && t >= this.slideReadyAt && this.alive) {
      this.sliding = true;
      this.slideUntil = t + WORLD.slideDuration * 1000;
      this.slideReadyAt = t + (WORLD.slideCooldown + WORLD.slideDuration) * 1000;
      this.aiming = false;
      this.sprintFireBlockUntil = this.slideUntil + 120;
    }
    if (this.sliding && (t >= this.slideUntil || !this.grounded || !this.alive)) this.sliding = false;

    if (this.sliding) this.stance = 'slide';
    else if (crouchHeld) this.stance = 'crouch';
    else this.stance = 'stand';

    // 体力
    if (this.sprinting) {
      this.stamina = Math.max(0, this.stamina - WORLD.sprintDrain * dt);
      this.regenAt = t + WORLD.staminaRegenDelay * 1000;
    } else if (t > this.regenAt) {
      this.stamina = Math.min(WORLD.staminaMax, this.stamina + WORLD.staminaRegen * dt);
    }

    // 疾跑停下后短暂收枪（不能立刻精准射击）
    if (!this.sprinting && this._wasSprinting) this.sprintFireBlockUntil = t + 170;
    this._wasSprinting = this.sprinting;

    // 开镜过渡
    const canAim = this.aiming && this.canAim();
    const w = this.weaponDef();
    const rate = 1 / Math.max(0.05, w.adsTime * 0.55);
    this.adsAmount = clamp(this.adsAmount + ((canAim ? 1 : 0) - this.adsAmount) * Math.min(1, rate * dt), 0, 1);
    this.scopeActive = w.sightType === 'scope' && this.adsAmount > 0.8;

    // 眼睛高度平滑（蹲起过渡）
    const targetEye = this.stance === 'slide' ? WORLD.slideEyeHeight
      : this.stance === 'crouch' ? WORLD.crouchEyeHeight
        : WORLD.eyeHeight;
    this.eye += (targetEye - this.eye) * Math.min(1, 14 * dt);
  }

  // 当前散布（弧度，半角）
  currentSpreadRad() {
    const w = this.weaponDef();
    return currentSpread(w, {
      moving: this.isMoving() && this.grounded,
      ads: this.adsAmount > 0.6,
      shots: Math.floor(this.spreadHeat),
      sprinting: this.sprinting,
      crouched: this.stance === 'crouch',
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

  // ---------- 输入上报（30Hz，与渲染解耦） ----------
  sendInput() {
    if (!this.locked || !this.alive) return;
    const { mx, mz } = this.moveInput();
    this.net.send({
      t: 'input', seq: this.seq = (this.seq || 0) + 1,
      yaw: this.yaw, pitch: this.pitch,     // 基础视角（移动方向用，不含后坐力）
      mx, mz,
      jump: this.jumpHeld,
      sprint: this.sprinting,
      crouch: this.stance === 'crouch' || this.stance === 'slide',
      aim: this.aiming,
    });
  }

  // ---------- 固定步长物理 ----------
  stepFrame(dt) {
    // 姿态/冲刺/开镜过渡按渲染帧推进（物理步内部只读取当前姿态）
    this.tickStance(dt);
    this.acc = Math.min(this.acc + Math.min(dt, 0.25), 0.4);
    let n = 0;
    while (this.acc >= STEP && n < 8) {
      this.prevPos.copy(this.pos);
      this.updatePhysics(STEP);
      this.acc -= STEP;
      n++;
    }
    this.tickTimers(dt);
  }

  updatePhysics(dt) {
    // shared 物理函数直接读写 body 的 x/y/z/vy/grounded/stance，
    // 而 LocalPlayer 用 pos(Vector3) 存位置，所以这里做一次显式桥接。
    const b = this._body || (this._body = {});
    b.x = this.pos.x; b.y = this.pos.y; b.z = this.pos.z;
    b.vy = this.vy; b.grounded = this.grounded; b.stance = this.stance;
    b.radius = WORLD.playerRadius;

    if (this.locked && this.alive) {
      const { mx, mz, len } = this.moveInput();
      this.speed = 0;
      if (len > 0.01 && !this.sliding) {
        const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
        let fx = -sin * mz + cos * mx;
        let fz = -cos * mz - sin * mx;
        const fl = Math.hypot(fx, fz);
        if (fl > 1) { fx /= fl; fz /= fl; }
        const w = this.weaponDef();
        let spd = this.stance === 'crouch' ? WORLD.crouchSpeed : WORLD.walkSpeed;
        if (this.sprinting) spd = WORLD.sprintSpeed;
        if (this.stance === 'crouch' && this.sprinting) spd = WORLD.crouchSpeed;
        if (this.aiming && this.adsAmount > 0.2) spd *= WORLD.adsSpeedMult;
        spd *= w.moveSpeedMult;
        const px = b.x, pz = b.z;
        movePlayerHorizontal(b, fx * spd * dt, fz * spd * dt);
        this.speed = Math.hypot(b.x - px, b.z - pz) / Math.max(dt, 1e-4);
      } else if (this.sliding) {
        const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
        const spd = WORLD.slideSpeed;
        const px = b.x, pz = b.z;
        movePlayerHorizontal(b, -sin * spd * dt, -cos * spd * dt);
        this.speed = Math.hypot(b.x - px, b.z - pz) / Math.max(dt, 1e-4);
      }

      // 跳跃
      if (this.jumpHeld && b.grounded && !this.sliding) {
        if (applyJump(b)) {
          this.stamina = Math.max(0, this.stamina - WORLD.jumpStaminaCost);
          this.regenAt = now() + WORLD.staminaRegenDelay * 1000;
        }
      }

      stepPlayerPhysics(b, dt);

      // 落地缓冲
      if (b.grounded && !this.wasGrounded) {
        this.landTimer = 0.16;
        this.landDip = 0.09;
      }
      this.wasGrounded = b.grounded;

      // 脚步
      if (b.grounded && this.speed > 0.7) {
        this.stepDist += this.speed * dt;
        const stride = this.sprinting ? 1.55 : this.stance === 'crouch' ? 2.6 : 2.15;
        if (this.stepDist > stride) {
          this.stepDist = 0;
          if (this.onFootstep) this.onFootstep(surfaceAt(b.x, b.z), this.speed, this.sprinting);
        }
      }
    } else {
      this.speed *= 0.85;
      stepPlayerPhysics(b, dt);
    }

    // 写回
    this.pos.set(b.x, b.y, b.z);
    this.vy = b.vy;
    this.grounded = b.grounded;

    // 服务器对账：小偏差忽略、中等平滑修正、大偏差快照
    if (this.serverPos) {
      const err = new THREE.Vector3().subVectors(this.serverPos, this.pos);
      const eLen = err.length();
      if (eLen > 2.5 || Math.abs(err.y) > 1.4) {
        this.pos.copy(this.serverPos);
        this.prevPos.copy(this.pos);
        this.vy = 0;
      } else if (eLen > 0.35) {
        this.pos.addScaledVector(err, Math.min(1, 3.5 * dt));
      }
    }
  }

  // 计时器：后坐力恢复 / 散布回落 / 换弹完成 / 镜头抖动
  tickTimers(dt) {
    const t = now();
    const w = this.weaponDef();

    const decay = Math.exp(-w.recoil.recovery * dt);
    this.recoilPitch *= decay;
    this.recoilYaw *= decay;
    if (Math.abs(this.recoilPitch) < 1e-5) this.recoilPitch = 0;
    if (Math.abs(this.recoilYaw) < 1e-5) this.recoilYaw = 0;

    this.spreadHeat *= Math.exp(-w.spreadRecover * dt);
    if (this.spreadHeat < 0.05) this.spreadHeat = 0;

    if (t - this.lastShotAt > 450) this.burst = 0;

    // 镜头抖动（开火/受击）
    this.shakeAmount *= Math.exp(-9 * dt);
    if (this.shakeAmount < 0.0005) this.shakeAmount = 0;
    this.breathPhase += dt * 1.15;

    // 落地下沉恢复
    if (this.landTimer > 0) this.landTimer = Math.max(0, this.landTimer - dt);
    this.landDip += (0 - this.landDip) * Math.min(1, 10 * dt);

    // 换弹完成 → 本地补弹（服务器权威值随后覆盖）
    if (this.reloadUntil > 0 && t >= this.reloadUntil) {
      const a = this.ammoOf();
      const need = w.magSize - a.mag;
      const take = a.reserve === Infinity ? need : Math.min(need, a.reserve);
      a.mag += take;
      if (a.reserve !== Infinity) a.reserve -= take;
      this.reloadUntil = 0;
    }

    // 受击红闪衰减
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 2.5);
  }

  // ---------- 渲染相机 ----------
  renderCamera(dt) {
    const alpha = clamp(this.acc / STEP, 0, 1);
    const x = this.prevPos.x + (this.pos.x - this.prevPos.x) * alpha;
    const y = this.prevPos.y + (this.pos.y - this.prevPos.y) * alpha;
    const z = this.prevPos.z + (this.pos.z - this.prevPos.z) * alpha;

    // 视角摇晃：走路轻微上下 + 横向摆动；开镜时几乎锁定
    const moveAmt = clamp(this.speed / WORLD.sprintSpeed, 0, 1) * (this.grounded ? 1 : 0.2);
    this.bobPhase += dt * (4.2 + this.speed * 0.9);
    const aimLock = 1 - this.adsAmount * 0.85;
    const bobY = Math.sin(this.bobPhase * 2) * 0.010 * moveAmt * aimLock;
    const bobX = Math.cos(this.bobPhase) * 0.012 * moveAmt * aimLock;
    const roll = Math.cos(this.bobPhase) * 0.0035 * moveAmt * aimLock;

    // 开镜呼吸摆动（狙击镜真实感）
    let breathPitch = 0, breathYaw = 0;
    if (this.scopeActive) {
      breathPitch = Math.sin(this.breathPhase * 0.9) * 0.0016 + Math.sin(this.breathPhase * 2.7) * 0.0005;
      breathYaw = Math.sin(this.breathPhase * 0.55 + 1.2) * 0.0019;
    }

    this.shakePitch = Math.sin(this.breathPhase * 71.3) * this.shakeAmount;
    this.shakeYaw = Math.cos(this.breathPhase * 67.7) * this.shakeAmount * 0.8;

    this.camera.position.set(x + bobX, y + this.eye - this.landDip + bobY, z);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(
      clamp(this.pitch + this.recoilPitch + this.shakePitch + breathPitch, -1.55, 1.55),
      this.yaw + this.recoilYaw + this.shakeYaw + breathYaw,
      roll,
    );

    // FOV：开镜平滑过渡（狙击枪真实放大）
    const w = this.weaponDef();
    const targetFov = BASE_FOV + (w.adsFov - BASE_FOV) * Math.min(1, this.adsAmount * 1.06);
    if (Math.abs(this.camera.fov - targetFov) > 0.02) {
      this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, 16 * dt);
      this.camera.updateProjectionMatrix();
    }
  }

  // ---------- 开火 ----------
  tryFire() {
    const t = now();
    if (!this.alive || !this.locked) return null;
    const w = this.weaponDef();
    if (t < this.swapUntil) return null;
    if (this.reloadUntil > 0) return null;
    if (this.sliding) return null;
    if (t < this.sprintFireBlockUntil) return null;
    if (t - this.lastFire < w.fireInterval * 1000) return null;
    if (w.fireMode === 'semi' && this.semiLatch) return null;

    const a = this.ammoOf();
    if (a.mag <= 0) { this.dryFire(); return null; }

    a.mag -= 1;
    this.lastFire = t;
    this.lastShotAt = t;
    if (w.fireMode === 'semi') this.semiLatch = true;

    // 后坐力：基础抬枪 × 连发递增 + 确定性水平摆动（可学习压枪）
    const ramp = 1 + Math.min(this.burst, w.recoil.maxRamp) * w.recoil.ramp;
    const i = this.shotIndex++;
    const rp = w.recoil.pitch * ramp * (0.9 + h1(i) * 0.2);
    const ry = w.recoil.yaw * ramp * (Math.sin(i * 1.7) * 0.75 + (h1(i * 3 + 1) - 0.5) * 1.1);
    this.recoilPitch += rp;
    this.recoilYaw += ry;
    this.burst += 1;
    this.spreadHeat = Math.min(this.spreadHeat + 1, 30);
    this.shakeAmount = Math.min(0.02, this.shakeAmount + w.recoil.shake * 0.6);

    const result = {
      weapon: this.weapon,
      spread: this.currentSpreadRad(),
      recoil: { pitch: rp, yaw: ry },
      ads: this.adsAmount,
    };
    this.lastFireResult = result;
    this.net.send({ t: 'shoot', yaw: this.aimYaw(), pitch: this.aimPitch() });

    if (a.mag <= 0) this.requestReload();   // 打空自动换弹
    return result;
  }

  dryFire() {
    const t = now();
    if (t - this.lastDryFire < 600) return;
    this.lastDryFire = t;
    this.lastFire = t;
    this.net.send({ t: 'shoot', yaw: this.aimYaw(), pitch: this.aimPitch() });
    this.requestReload();
  }

  addShake(amount) { this.shakeAmount = Math.min(0.045, this.shakeAmount + amount); }
  hurt(amount = 0.02) { this.hurtFlash = 1; this.addShake(amount); }

  // ---------- 换弹 / 切枪 ----------
  requestReload() {
    const t = now();
    if (this.reloadUntil > 0) return false;
    const w = this.weaponDef();
    const a = this.ammoOf();
    if (a.mag >= w.magSize) return false;
    if (!(a.reserve > 0)) return false;
    const empty = a.mag <= 0;
    this.reloadTotal = (empty ? w.reloadEmptyTime : w.reloadTime) * 1000;
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
    this.reloadUntil = 0;
    this.burst = 0;
    this.shotIndex = 0;
    this.spreadHeat = 0;
    this.semiLatch = false;
    this.swapUntil = t + w.swapTime * 1000;
    this.net.send({ t: 'switch', weapon: id });
    return true;
  }

  cycleWeapon(dir = 1) {
    const list = WEAPON_ORDER.filter((id) => this.owned[id]);
    if (list.length < 2) return false;
    const i = list.indexOf(this.weapon);
    const next = list[(i + dir + list.length) % list.length];
    return this.requestSwitch(next);
  }

  onTriggerUp() { this.semiLatch = false; }

  // ---------- 服务器状态同步 ----------
  setServerState(me) {
    this.serverPos = new THREE.Vector3(me.x, me.y, me.z);
    const wasAlive = this.alive;
    this.alive = me.alive;
    this.hp = me.hp;
    this.syncWeaponFromServer(me);
    if (me.alive && !wasAlive) this.reset({ x: me.x, z: me.z }, me.team || this.team);
  }

  syncWeaponFromServer(me) {
    if (me.owned) {
      this.owned = {};
      for (const id of me.owned) {
        this.owned[id] = true;
        if (!this.ammo[id]) {
          const w = weaponOf(id);
          this.ammo[id] = { mag: w.magSize, reserve: w.reserveStart };
        }
      }
    }
    if (me.weapon && me.weapon !== this.weapon) {
      this.weapon = me.weapon;
      this.burst = 0;
      this.shotIndex = 0;
      this.spreadHeat = 0;
    }
    if (me.ammo) {
      const a = this.ammoOf();
      const recentShot = now() - this.lastFire < 120;
      if (!recentShot || me.ammo.mag < a.mag) a.mag = me.ammo.mag;
      a.reserve = me.ammo.reserve < 0 ? Infinity : me.ammo.reserve;
    }
  }
}

export { BASE_FOV };
