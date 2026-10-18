// ===== 战斗特效（对象池化粒子系统，无弹道光束）=====
// 契约：REMAKE_SPEC.md §6.5
// 设计要点：
// - 绝对没有任何沿弹道飞行的高亮束状特效；弹道反馈只靠枪口焰、弹壳、烟尘、命中粒子、弹着点。
// - 所有粒子系统 / 枪口焰 / 弹壳 / 脉冲点光都从池中复用，场景里只保留活跃对象，update 回收。
// - 粒子系统池上限 MAX_SYSTEMS = 256；低画质减少粒子数量、关闭脉冲点光。
// - 枪口焰 40~70ms，短促星形 sprite + 沿枪管方向的锥形火舌 + 点光 + 少量烟。
// - 弹壳为小黄铜盒，抛物线 + 翻滚；落地后轻微弹跳再消失。
// - impact 按 surface 区分：草/泥 → 土尘 + 草屑；石/混凝土 → 火花 + 石屑；木 → 木屑；金属 → 火花。
// - 血雾为红色点粒子（爆头更多更红），血滴受重力下落。
// - Node 环境 import / 构造 / update 不抛错（无 document 时跳过程序化贴图）。

import * as THREE from 'three';

const MAX_SYSTEMS = 256;   // 粒子系统池上限（契约要求）
const MAX_FLASHES = 10;    // 同时存在的枪口焰对象上限
const MAX_SHELLS = 16;     // 弹壳池上限
const MAX_LIGHTS = 3;      // 常驻点光池数量（复用以避免灯光数量变化导致 shader 重编译）
const CAP = 48;            // 单个粒子系统容量

// 常用临时向量（单线程使用，避免每次分配）
const _up = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3(0, 0, -1);
const _tmpDir = new THREE.Vector3();
const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();

function isVec3(v) {
  return !!v && typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number';
}

// 归一化方向；非法输入回落到 fallback（兼容旧调用 / 缺参，绝不抛错）
function normalizeDir(v, fallback) {
  if (isVec3(v)) {
    _tmpDir.set(v.x, v.y, v.z);
    if (_tmpDir.lengthSq() > 1e-10) return _tmpDir.clone().normalize();
  }
  return fallback.clone();
}

// 均匀球面随机方向
function randUnit(out) {
  const u = Math.random() * 2 - 1;
  const a = Math.random() * Math.PI * 2;
  const s = Math.sqrt(Math.max(0, 1 - u * u));
  out.set(s * Math.cos(a), u, s * Math.sin(a));
  return out;
}

// 程序化枪口焰贴图（无外部资源；Node 环境返回 null，由纯色 sprite 兜底）
function makeFlashTexture() {
  if (typeof document === 'undefined') return null;
  try {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const g = c.getContext('2d');
    if (!g) return null;
    // 中心亮核
    const grad = g.createRadialGradient(32, 32, 1, 32, 32, 30);
    grad.addColorStop(0, 'rgba(255,255,240,1)');
    grad.addColorStop(0.25, 'rgba(255,225,160,0.95)');
    grad.addColorStop(0.6, 'rgba(255,160,60,0.35)');
    grad.addColorStop(1, 'rgba(255,120,30,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    // 星芒：4 长 + 4 短
    g.translate(32, 32);
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4 + (i % 2 ? 0.22 : 0);
      const len = i % 2 === 0 ? 30 : 16;
      g.rotate(a);
      const spike = g.createLinearGradient(0, 0, len, 0);
      spike.addColorStop(0, 'rgba(255,240,200,0.95)');
      spike.addColorStop(1, 'rgba(255,170,70,0)');
      g.fillStyle = spike;
      g.beginPath();
      g.moveTo(0, -1.6);
      g.lineTo(len, 0);
      g.lineTo(0, 1.6);
      g.closePath();
      g.fill();
      g.rotate(-a);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  } catch {
    return null;
  }
}

// 枪口焰参数：不同枪型的焰口大小、持续时长（40~70ms）、点光强度。
// 尺寸刻意偏小：第一人称枪口离相机约 0.5m，过大的 sprite 会遮挡视野中心。
const FLASH_KINDS = {
  pistol: { life: 0.045, size: 0.16, light: 5, distance: 5.5, color: 0xffd28a, smoke: 3 },
  smg: { life: 0.04, size: 0.15, light: 4.5, distance: 5, color: 0xffd28a, smoke: 3 },
  ak47: { life: 0.055, size: 0.22, light: 8, distance: 7.5, color: 0xffc070, smoke: 4 },
  shotgun: { life: 0.07, size: 0.32, light: 12, distance: 9, color: 0xffb050, smoke: 6 },
  sniper: { life: 0.06, size: 0.28, light: 10, distance: 9, color: 0xffc880, smoke: 5 },
};

// 弹壳尺寸倍率（基准几何 12mm × 12mm × 22mm 的黄铜盒）
const SHELL_SCALE = {
  pistol: 1.0,
  smg: 0.95,
  ak47: 1.25,
  shotgun: 1.8,
  sniper: 1.5,
};

// 弹着 impact 倍率：大威力武器尘土/火花更多
const KIND_SCALE = {
  pistol: 0.85,
  smg: 0.9,
  ak47: 1.0,
  shotgun: 1.5,
  sniper: 1.8,
};

// surface 别名归一（shared/world.js 用 grass|road|dirt|rock，其余模块可能传 stone/concrete/wood/metal）
const SURFACE_ALIAS = {
  grass: 'grass',
  dirt: 'dirt',
  mud: 'dirt',
  sand: 'dirt',
  road: 'road',
  gravel: 'road',
  stone: 'stone',
  rock: 'stone',
  concrete: 'stone',
  brick: 'stone',
  wood: 'wood',
  plank: 'wood',
  metal: 'metal',
  steel: 'metal',
  water: 'dirt',
};

// 弹着粒子分层配置（NORMAL = 普通混合灰尘/碎屑；ADD = 加色火花）
const IMPACT = {
  grass: [
    {
      color: 0x9b8f5f, count: 9, size: 0.14, life: 0.6, speed: 2.2, spread: 1.5,
      gravity: 1.2, drag: 0.965, grow: 2.4, opacity: 0.42, blending: THREE.NormalBlending,
    },
    {
      color: 0x5a7a36, count: 6, size: 0.06, life: 0.5, speed: 3.0, spread: 1.8,
      gravity: 7, drag: 0.99, grow: 0, opacity: 0.9, blending: THREE.NormalBlending,
    },
  ],
  dirt: [
    {
      color: 0x8a6a44, count: 11, size: 0.15, life: 0.65, speed: 2.4, spread: 1.6,
      gravity: 1.0, drag: 0.965, grow: 2.6, opacity: 0.45, blending: THREE.NormalBlending,
    },
    {
      color: 0x6b5236, count: 5, size: 0.055, life: 0.45, speed: 3.2, spread: 1.7,
      gravity: 8, drag: 0.99, grow: 0, opacity: 0.9, blending: THREE.NormalBlending,
    },
  ],
  road: [
    {
      color: 0x91846e, count: 12, size: 0.14, life: 0.6, speed: 2.6, spread: 1.6,
      gravity: 1.2, drag: 0.965, grow: 2.4, opacity: 0.42, blending: THREE.NormalBlending,
    },
    {
      color: 0x746b5d, count: 5, size: 0.05, life: 0.4, speed: 3.4, spread: 1.6,
      gravity: 8, drag: 0.99, grow: 0, opacity: 0.9, blending: THREE.NormalBlending,
    },
  ],
  stone: [
    {
      color: 0x9a9a94, count: 5, size: 0.1, life: 0.4, speed: 1.8, spread: 1.2,
      gravity: 1.0, drag: 0.97, grow: 1.8, opacity: 0.35, blending: THREE.NormalBlending,
    },
    {
      color: 0xffce7a, count: 14, size: 0.04, life: 0.28, speed: 7, spread: 2.2,
      gravity: 5, drag: 0.985, grow: 0, opacity: 1, blending: THREE.AdditiveBlending,
    },
    {
      color: 0x8b877f, count: 6, size: 0.05, life: 0.5, speed: 3.5, spread: 1.6,
      gravity: 9, drag: 0.995, grow: 0, opacity: 0.9, blending: THREE.NormalBlending,
    },
  ],
  wood: [
    {
      color: 0x9a7443, count: 10, size: 0.05, life: 0.6, speed: 3.0, spread: 1.8,
      gravity: 8, drag: 0.995, grow: 0, opacity: 0.9, blending: THREE.NormalBlending,
    },
    {
      color: 0xa8977a, count: 4, size: 0.1, life: 0.4, speed: 1.5, spread: 1.0,
      gravity: 1.0, drag: 0.97, grow: 1.8, opacity: 0.3, blending: THREE.NormalBlending,
    },
  ],
  metal: [
    {
      color: 0xffd27a, count: 18, size: 0.038, life: 0.3, speed: 8, spread: 2.4,
      gravity: 6, drag: 0.99, grow: 0, opacity: 1, blending: THREE.AdditiveBlending,
    },
    {
      color: 0x7f7f82, count: 3, size: 0.08, life: 0.3, speed: 1.5, spread: 0.8,
      gravity: 1.0, drag: 0.97, grow: 1.5, opacity: 0.3, blending: THREE.NormalBlending,
    },
  ],
};

// ---------- 单个粒子系统（池对象） ----------
class ParticleSystem {
  constructor() {
    this.pos = new Float32Array(CAP * 3);
    this.vel = new Float32Array(CAP * 3);
    this.geo = new THREE.BufferGeometry();
    this.attr = new THREE.BufferAttribute(this.pos, 3);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.attr);
    this.geo.setDrawRange(0, 0);
    this.mat = new THREE.PointsMaterial({
      size: 0.12,
      color: 0xffffff,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      sizeAttenuation: true,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.visible = false;
    // 运行状态
    this.active = false;
    this.count = 0;
    this.life = 0;
    this.maxLife = 1;
    this.baseOpacity = 1;
    this.baseSize = 0.1;
    this.grow = 0;
    this.gravity = 0;
    this.drag = 0.96;
    this.rise = 0;
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ---------- 战斗特效管理器 ----------
export class Effects {
  constructor(scene, renderer) {
    this.scene = scene || null;
    this.renderer = renderer || null;
    this.disposed = false;

    this.systems = [];          // 所有粒子系统池对象
    this.activeSystems = [];    // 活跃粒子系统（按生成顺序）
    this.flashPool = [];        // 枪口焰池
    this.activeFlashes = [];
    this.shellPool = [];        // 弹壳池
    this.activeShells = [];
    this.lightPool = [];        // 常驻点光池
    this.lightsReady = false;

    this.flashTexture = null;
    this.flashTexTried = false;
    this.shellGeo = null;
    this.shellMat = null;

    this.quality = 'high';
    this.qMul = 1;
    this.lightsOn = true;

    this._detectQuality(renderer);
    this.setQuality(this.quality);
  }

  // 依据 renderer 判断是否为软件渲染，软渲染直接低画质
  _detectQuality(renderer) {
    let level = 'high';
    try {
      if (renderer && typeof renderer.getContext === 'function') {
        const gl = renderer.getContext();
        const ext = gl && typeof gl.getExtension === 'function'
          ? gl.getExtension('WEBGL_debug_renderer_info')
          : null;
        const name = ext && gl && typeof gl.getParameter === 'function'
          ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '')
          : '';
        if (/swiftshader|software|llvmpipe|basic render/i.test(name)) level = 'low';
      }
    } catch { /* 忽略 */ }
    this.quality = level;
  }

  // 画质分档：低档粒子数量大幅减少且关闭脉冲点光
  setQuality(level) {
    const map = {
      low: { mul: 0.35, lights: false },
      medium: { mul: 0.65, lights: false },
      high: { mul: 1.0, lights: true },
      ultra: { mul: 1.25, lights: true },
    };
    let key = 'high';
    if (typeof level === 'number') {
      const arr = ['low', 'medium', 'high', 'ultra'];
      key = arr[Math.max(0, Math.min(3, level | 0))];
    } else if (typeof level === 'string') {
      const k = level.toLowerCase();
      if (map[k]) key = k;
      else if (k === 'auto') key = 'high';
    }
    const q = map[key];
    this.quality = key;
    this.qMul = q.mul;
    this.lightsOn = q.lights;
  }

  // ---------- 粒子系统池 ----------

  _acquireSystem() {
    for (let i = 0; i < this.systems.length; i++) {
      if (!this.systems[i].active) return this.systems[i];
    }
    if (this.systems.length < MAX_SYSTEMS) {
      const s = new ParticleSystem();
      this.systems.push(s);
      return s;
    }
    // 池满：回收最老的活跃系统，保证特效仍然可见
    const old = this.activeSystems.shift();
    if (old) this._releaseSystem(old);
    return old || null;
  }

  _releaseSystem(s) {
    s.active = false;
    s.points.visible = false;
    if (this.scene && s.points.parent === this.scene) this.scene.remove(s.points);
    const i = this.activeSystems.indexOf(s);
    if (i >= 0) this.activeSystems.splice(i, 1);
    s.geo.setDrawRange(0, 0);
  }

  // 通用粒子爆发：origin 起点、normal 主方向、其余为视觉参数
  _emit(o) {
    if (this.disposed) return null;
    const count = Math.max(1, Math.min(
      CAP,
      Math.round((o.count || 8) * this.qMul * (o.scale || 1))
    ));
    const sys = this._acquireSystem();
    if (!sys) return null;
    const origin = isVec3(o.origin) ? o.origin : { x: 0, y: 0, z: 0 };
    const normal = normalizeDir(o.normal, _up);

    sys.active = true;
    sys.count = count;
    sys.life = sys.maxLife = o.life || 0.5;
    sys.baseOpacity = o.opacity == null ? 0.8 : o.opacity;
    sys.baseSize = o.size || 0.1;
    sys.grow = o.grow || 0;
    sys.gravity = o.gravity || 0;
    sys.drag = o.drag == null ? 0.96 : o.drag;
    sys.rise = o.rise || 0;
    sys.mat.color.set(o.color == null ? 0xffffff : o.color);
    sys.mat.size = sys.baseSize;
    sys.mat.opacity = sys.baseOpacity;
    sys.mat.blending = o.blending == null ? THREE.AdditiveBlending : o.blending;

    const pos = sys.pos;
    const vel = sys.vel;
    const speed = o.speed == null ? 3 : o.speed;
    const spread = o.spread == null ? 1 : o.spread;
    const jitter = o.jitter == null ? 0.04 : o.jitter;
    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      // 起点轻微抖动，避免所有粒子从同一像素出发
      pos[i3] = origin.x + (Math.random() - 0.5) * jitter;
      pos[i3 + 1] = origin.y + (Math.random() - 0.5) * jitter;
      pos[i3 + 2] = origin.z + (Math.random() - 0.5) * jitter;
      randUnit(_tmpA);
      // 主方向 + 随机扩散，形成锥形喷射
      const along = 0.35 + Math.random() * 0.85;
      vel[i3] = normal.x * speed * along + _tmpA.x * spread * (0.3 + Math.random());
      vel[i3 + 1] = normal.y * speed * along + _tmpA.y * spread * (0.3 + Math.random());
      vel[i3 + 2] = normal.z * speed * along + _tmpA.z * spread * (0.3 + Math.random());
    }
    sys.attr.needsUpdate = true;
    sys.geo.setDrawRange(0, count);
    sys.points.visible = true;
    if (this.scene && sys.points.parent !== this.scene) this.scene.add(sys.points);
    this.activeSystems.push(sys);
    return sys;
  }

  // ---------- 枪口焰池 ----------

  _acquireFlash() {
    for (let i = 0; i < this.flashPool.length; i++) {
      if (!this.flashPool[i].active) return this.flashPool[i];
    }
    if (this.flashPool.length < MAX_FLASHES) {
      const f = this._createFlash();
      this.flashPool.push(f);
      return f;
    }
    const old = this.activeFlashes.shift();
    if (old) this._releaseFlash(old);
    return old || null;
  }

  _getFlashTexture() {
    if (!this.flashTexTried) {
      this.flashTexTried = true;
      this.flashTexture = makeFlashTexture();
    }
    return this.flashTexture;
  }

  _createFlash() {
    const group = new THREE.Group();
    const spriteMat = new THREE.SpriteMaterial({
      map: this._getFlashTexture(),
      color: 0xffd9a0,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.setScalar(0.35);
    group.add(sprite);
    // 方向性火舌：沿枪管方向的开口锥体（只在枪口处 0.3m 内，不沿弹道延伸）
    const coneGeo = new THREE.ConeGeometry(0.07, 0.3, 6, 1, true);
    const coneMat = new THREE.MeshBasicMaterial({
      color: 0xffb45e,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const cone = new THREE.Mesh(coneGeo, coneMat);
    group.add(cone);
    return {
      group,
      sprite,
      cone,
      life: 0,
      maxLife: 1,
      size: 0.4,
      active: false,
    };
  }

  _releaseFlash(f) {
    f.active = false;
    if (this.scene && f.group.parent === this.scene) this.scene.remove(f.group);
    const i = this.activeFlashes.indexOf(f);
    if (i >= 0) this.activeFlashes.splice(i, 1);
  }

  // ---------- 弹壳池 ----------

  _createShell() {
    if (!this.shellGeo) this.shellGeo = new THREE.BoxGeometry(0.012, 0.012, 0.022);
    if (!this.shellMat) {
      this.shellMat = new THREE.MeshStandardMaterial({
        color: 0xc9a227,
        metalness: 0.9,
        roughness: 0.34,
        emissive: 0x120d02,
        emissiveIntensity: 0.4,
      });
    }
    const mesh = new THREE.Mesh(this.shellGeo, this.shellMat);
    mesh.frustumCulled = false;
    return {
      mesh,
      vel: new THREE.Vector3(),
      spin: new THREE.Vector3(),
      life: 0,
      floorY: 0.03,
      active: false,
    };
  }

  _acquireShell() {
    for (let i = 0; i < this.shellPool.length; i++) {
      if (!this.shellPool[i].active) return this.shellPool[i];
    }
    if (this.shellPool.length < MAX_SHELLS) {
      const s = this._createShell();
      this.shellPool.push(s);
      return s;
    }
    const old = this.activeShells.shift();
    if (old) this._releaseShell(old);
    return old || null;
  }

  _releaseShell(s) {
    s.active = false;
    if (this.scene && s.mesh.parent === this.scene) this.scene.remove(s.mesh);
    const i = this.activeShells.indexOf(s);
    if (i >= 0) this.activeShells.splice(i, 1);
  }

  // ---------- 常驻点光池（避免灯光数量变化导致 shader 重编译） ----------

  _ensureLights() {
    if (this.lightsReady) return true;
    this.lightsReady = true;
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const light = new THREE.PointLight(0xffc070, 0, 8, 2);
      light.position.set(0, -999, 0);
      // 注意：不常驻场景；使用时临时 add、熄灭后 remove，保证场景对象数可回到基线。
      this.lightPool.push({ light, life: 0, maxLife: 1, peak: 0, active: false });
    }
    return true;
  }

  // 脉冲点光：枪口焰 / 石与金属弹着的瞬时照明
  _pulseLight(position, color, intensity, life, distance) {
    if (!this.lightsOn) return;
    if (!this._ensureLights()) return;
    let slot = null;
    for (let i = 0; i < this.lightPool.length; i++) {
      if (!this.lightPool[i].active) { slot = this.lightPool[i]; break; }
    }
    if (!slot) {
      // 全忙：复用剩余寿命最短的
      for (let i = 0; i < this.lightPool.length; i++) {
        if (!slot || this.lightPool[i].life < slot.life) slot = this.lightPool[i];
      }
    }
    if (!slot) return;
    slot.active = true;
    slot.life = slot.maxLife = Math.max(0.02, life);
    slot.peak = intensity;
    slot.light.color.set(color);
    slot.light.distance = distance || 6;
    slot.light.position.set(position.x, position.y, position.z);
    slot.light.intensity = intensity;
    if (this.scene && slot.light.parent !== this.scene) this.scene.add(slot.light);
  }

  // ---------- 对外特效接口 ----------

  // 枪口焰：短促（40~70ms）星形 sprite + 方向性火舌 + 点光 + 少量烟。
  // direction 为枪管朝向（世界坐标），kind 为武器 id。
  muzzleFlash(position, direction, kind) {
    if (this.disposed) return;
    const pos = isVec3(position) ? position : { x: 0, y: 0, z: 0 };
    const dir = normalizeDir(direction, _fwd);
    const key = String(kind || '').toLowerCase();
    const k = FLASH_KINDS[key] || FLASH_KINDS.pistol;
    const life = Math.max(0.04, Math.min(0.07, k.life)); // 契约：40~70ms

    const f = this._acquireFlash();
    if (!f) return;
    f.active = true;
    f.life = f.maxLife = life;
    f.size = k.size;
    // 位置略沿枪管前移，避免焰体贴在枪口模型里
    f.group.position.set(
      pos.x + dir.x * 0.03,
      pos.y + dir.y * 0.03,
      pos.z + dir.z * 0.03
    );
    // 锥体几何默认朝 +Y，旋转到枪管方向；sprite 始终面向相机
    f.cone.quaternion.setFromUnitVectors(_up, dir);
    f.cone.position.set(dir.x * 0.16, dir.y * 0.16, dir.z * 0.16);
    f.cone.scale.setScalar(0.6 + k.size);
    f.sprite.position.set(dir.x * 0.05, dir.y * 0.05, dir.z * 0.05);
    f.sprite.scale.setScalar(k.size);
    f.sprite.material.color.set(k.color);
    f.sprite.material.opacity = 1;
    f.cone.material.color.set(k.color);
    f.cone.material.opacity = 0.9;
    if (this.scene) this.scene.add(f.group);
    this.activeFlashes.push(f);

    // 点光：照亮周围墙体/地面，但不参与着色器重编译（常驻灯池）
    _tmpA.set(pos.x + dir.x * 0.06, pos.y + dir.y * 0.06, pos.z + dir.z * 0.06);
    this._pulseLight(_tmpA, k.color, k.light, life * 1.2, k.distance);

    // 枪口烟：少量灰色慢速上浮粒子（普通混合，避免发亮）
    this._emit({
      origin: {
        x: pos.x + dir.x * 0.1,
        y: pos.y + dir.y * 0.1,
        z: pos.z + dir.z * 0.1,
      },
      normal: dir,
      count: k.smoke,
      color: 0x8f8a80,
      size: 0.08,
      life: 0.6,
      speed: 0.45,
      spread: 0.4,
      gravity: -0.4,
      drag: 0.955,
      grow: 2.4,
      opacity: 0.24,
      blending: THREE.NormalBlending,
      jitter: 0.05,
    });
  }

  // 抛壳：direction 为抛壳方向（Lead 传枪身右方向），小黄铜盒抛物 + 翻滚。
  shellEject(position, direction, kind) {
    if (this.disposed) return;
    const pos = isVec3(position) ? position : { x: 0, y: 0, z: 0 };
    const dir = normalizeDir(direction, _up);
    const key = String(kind || '').toLowerCase();
    const scale = SHELL_SCALE[key] || 1.0;

    const s = this._acquireShell();
    if (!s) return;
    s.active = true;
    s.mesh.scale.setScalar(scale);
    s.mesh.position.set(pos.x, pos.y, pos.z);
    s.mesh.rotation.set(
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2
    );
    // 主要向右抛出 + 向上 + 轻微前后随机；水平方向取 dir 的水平分量
    const hx = dir.x;
    const hz = dir.z;
    const throwSpeed = 1.7 + Math.random() * 1.3;
    s.vel.set(
      hx * throwSpeed + (Math.random() - 0.5) * 0.5,
      1.8 + Math.random() * 1.2,
      hz * throwSpeed + (Math.random() - 0.5) * 0.5
    );
    s.spin.set(
      (Math.random() - 0.5) * 24,
      (Math.random() - 0.5) * 24,
      (Math.random() - 0.5) * 24
    );
    s.life = 1.4 + Math.random() * 0.6;
    s.floorY = 0.03;
    if (this.scene) this.scene.add(s.mesh);
    this.activeShells.push(s);
  }

  // 弹着：按 surface 切换尘土/草屑/火花/石屑/木屑/金属火花。
  // normal 为弹着面法线，kind 为武器 id。
  impact(point, normal, surface, kind) {
    if (this.disposed) return;
    const pos = isVec3(point) ? point : { x: 0, y: 0, z: 0 };
    const n = normalizeDir(normal, _up);
    const sKey = SURFACE_ALIAS[String(surface || '').toLowerCase()] || 'dirt';
    const layers = IMPACT[sKey] || IMPACT.dirt;
    const scale = KIND_SCALE[String(kind || '').toLowerCase()] || 1;
    const origin = {
      x: pos.x + n.x * 0.02,
      y: pos.y + n.y * 0.02,
      z: pos.z + n.z * 0.02,
    };
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      this._emit({
        origin,
        normal: n,
        count: layer.count,
        scale,
        color: layer.color,
        size: layer.size,
        life: layer.life,
        speed: layer.speed,
        spread: layer.spread,
        gravity: layer.gravity,
        drag: layer.drag,
        grow: layer.grow,
        opacity: layer.opacity,
        blending: layer.blending,
        jitter: 0.03,
      });
    }
    // 石头/金属：短促火花照明（低画质关闭）
    if ((sKey === 'stone' || sKey === 'metal') && this.lightsOn) {
      this._pulseLight(_tmpB.copy(pos).addScaledVector(n, 0.08), 0xffd8a0, 2.2, 0.05, 4);
    }
  }

  // 血雾：红点粒子 + 受重力血滴；爆头数量更多、更红、更持久。
  bloodImpact(point, direction, headshot) {
    if (this.disposed) return;
    const pos = isVec3(point) ? point : { x: 0, y: 0, z: 0 };
    const dir = normalizeDir(direction, _fwd);
    const head = !!headshot;
    const origin = { x: pos.x, y: pos.y, z: pos.z };
    // 血雾：细小红点沿弹道喷出并迅速扩散
    this._emit({
      origin,
      normal: dir,
      count: head ? 24 : 13,
      color: head ? 0xa51c14 : 0x8a1a12,
      size: head ? 0.08 : 0.055,
      life: head ? 0.75 : 0.55,
      speed: 2.6,
      spread: 1.6,
      gravity: 0.6,
      drag: 0.93,
      grow: 2.6,
      opacity: 0.85,
      blending: THREE.NormalBlending,
      jitter: 0.06,
    });
    // 血滴：受重力下落，落地前消失
    this._emit({
      origin,
      normal: dir,
      count: head ? 14 : 8,
      color: 0x6e0f0c,
      size: head ? 0.07 : 0.055,
      life: 0.9,
      speed: 3.0,
      spread: 1.2,
      gravity: 9.8,
      drag: 0.995,
      grow: 0,
      opacity: 0.95,
      blending: THREE.NormalBlending,
      jitter: 0.08,
    });
  }

  // ---------- 每帧更新与回收 ----------

  update(dt, camera) {
    if (this.disposed) return;
    // 限制单帧步长，避免掉帧时粒子瞬移
    const step = Math.min(Math.max(Number(dt) || 0, 0), 0.1);

    // 粒子系统
    for (let i = this.activeSystems.length - 1; i >= 0; i--) {
      const s = this.activeSystems[i];
      s.life -= step;
      if (s.life <= 0) {
        this._releaseSystem(s);
        continue;
      }
      const n = s.count;
      const pos = s.pos;
      const vel = s.vel;
      const damp = Math.pow(Math.max(0.01, s.drag), step * 60);
      for (let k = 0; k < n; k++) {
        const k3 = k * 3;
        vel[k3] *= damp;
        vel[k3 + 1] = vel[k3 + 1] * damp - s.gravity * step;
        vel[k3 + 2] *= damp;
        pos[k3] += vel[k3] * step;
        pos[k3 + 1] += vel[k3 + 1] * step;
        pos[k3 + 2] += vel[k3 + 2] * step;
      }
      s.attr.needsUpdate = true;
      const t = Math.max(0, s.life / s.maxLife);
      // 后 30% 寿命淡出（PointsMaterial 只能整体透明，用整团淡出模拟消散）
      s.mat.opacity = s.baseOpacity * Math.min(1, t / 0.7);
      if (s.grow) s.mat.size = s.baseSize * (1 + (1 - t) * s.grow);
    }

    // 枪口焰
    for (let i = this.activeFlashes.length - 1; i >= 0; i--) {
      const f = this.activeFlashes[i];
      f.life -= step;
      if (f.life <= 0) {
        this._releaseFlash(f);
        continue;
      }
      const t = Math.max(0, f.life / f.maxLife); // 1 → 0
      const k = Math.min(1, t * 1.8);
      f.sprite.material.opacity = k * 0.95;
      f.cone.material.opacity = k * 0.8;
      f.sprite.scale.setScalar(f.size * (0.8 + (1 - t) * 0.6));
      f.cone.scale.setScalar(0.85 + (1 - t) * 0.6);
    }

    // 弹壳：重力 + 翻滚 + 简易地面弹跳
    for (let i = this.activeShells.length - 1; i >= 0; i--) {
      const s = this.activeShells[i];
      s.life -= step;
      if (s.life <= 0) {
        this._releaseShell(s);
        continue;
      }
      s.vel.y -= 9.8 * step;
      s.mesh.position.addScaledVector(s.vel, step);
      s.mesh.rotation.x += s.spin.x * step;
      s.mesh.rotation.y += s.spin.y * step;
      s.mesh.rotation.z += s.spin.z * step;
      // 地形起伏忽略（弹壳寿命很短），以 y≈0 作为地面近似
      if (s.mesh.position.y < s.floorY && s.vel.y < 0) {
        s.mesh.position.y = s.floorY;
        s.vel.y *= -0.32;
        s.vel.x *= 0.6;
        s.vel.z *= 0.6;
        s.spin.multiplyScalar(0.55);
        if (Math.abs(s.vel.y) < 0.2) {
          s.vel.set(0, 0, 0);
          s.spin.set(0, 0, 0);
        }
      }
    }

    // 脉冲点光衰减
    for (let i = 0; i < this.lightPool.length; i++) {
      const l = this.lightPool[i];
      if (!l.active) continue;
      l.life -= step;
      if (l.life <= 0) {
        l.active = false;
        l.light.intensity = 0;
        l.light.position.set(0, -999, 0);
        if (this.scene && l.light.parent === this.scene) this.scene.remove(l.light);
        continue;
      }
      const k = l.life / l.maxLife;
      l.light.intensity = l.peak * k * k;
    }

    // camera 参数保留给后续按距离做 LOD 裁剪使用（当前粒子数量已受池上限约束）
    void camera;
  }

  // 活跃特效对象数（粒子系统 + 枪口焰 + 弹壳 + 点亮中的点光），供自动化测试断言
  count() {
    let lights = 0;
    for (let i = 0; i < this.lightPool.length; i++) if (this.lightPool[i].active) lights++;
    return this.activeSystems.length + this.activeFlashes.length
      + this.activeShells.length + lights;
  }

  // 释放全部 GPU/CPU 资源并从场景移除（幂等）
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const remove = (obj) => {
      if (this.scene && obj && obj.parent === this.scene) this.scene.remove(obj);
    };
    for (let i = 0; i < this.activeSystems.length; i++) remove(this.activeSystems[i].points);
    for (let i = 0; i < this.activeFlashes.length; i++) remove(this.activeFlashes[i].group);
    for (let i = 0; i < this.activeShells.length; i++) remove(this.activeShells[i].mesh);
    for (let i = 0; i < this.lightPool.length; i++) remove(this.lightPool[i].light);
    // 粒子系统
    for (let i = 0; i < this.systems.length; i++) {
      remove(this.systems[i].points);
      this.systems[i].dispose();
    }
    // 枪口焰（每个对象的几何/材质独立）
    for (let i = 0; i < this.flashPool.length; i++) {
      const f = this.flashPool[i];
      remove(f.group);
      f.sprite.material.dispose();
      f.cone.geometry.dispose();
      f.cone.material.dispose();
    }
    // 弹壳（共享几何/材质）
    for (let i = 0; i < this.shellPool.length; i++) remove(this.shellPool[i].mesh);
    if (this.shellGeo) {
      this.shellGeo.dispose();
      this.shellGeo = null;
    }
    if (this.shellMat) {
      this.shellMat.dispose();
      this.shellMat = null;
    }
    if (this.flashTexture) {
      this.flashTexture.dispose();
      this.flashTexture = null;
    }
    for (let i = 0; i < this.lightPool.length; i++) {
      const light = this.lightPool[i].light;
      if (typeof light.dispose === 'function') light.dispose();
    }
    this.systems = [];
    this.activeSystems = [];
    this.flashPool = [];
    this.activeFlashes = [];
    this.shellPool = [];
    this.activeShells = [];
    this.lightPool = [];
    this.lightsReady = false;
  }
}
