// ===== 血液喷溅 + 地面/墙面贴花（程序化纹理，无外部资源）=====
// 契约（任务 B）：
//   createBloodFX(scene, renderer) -> { spawnBloodImpact(position, direction, severity), update(dt), dispose() }
//
// 设计要点：
//   * 喷溅粒子：从命中点沿子弹前进方向锥形喷出 8~24 个粒子，受重力，落地即消失；
//     颜色为低饱和暗红（#6e1a15 ~ #8c2b20），NormalBlending，不用加法混合，避免"荧光血"。
//   * 贴花：粒子落地 / 命中点附近有墙面时生成。程序化 Canvas 纹理（不规则血泊 + 随机小飞溅点），
//     贴地时 y+0.01 并按地形法线贴合；墙面贴花朝向墙面法线（含向下流淌的血痕）。
//   * 池化：贴花最多 MAX_DECALS=48 个，超出复用最旧的；每张独立材质以便单独淡入/淡出。
//   * 防 z-fighting：polygonOffset + depthWrite:false + 沿法线偏移 1~2cm。
//   * Node 环境（无 document）不生成纹理也不抛错：退化为纯色贴花，import/构造/update 全部安全。
//
// 与 effects.js 的 bloodImpact（红色血雾粒子）并存、互不干扰：那个保留，这里补足"喷到地面/墙面"。

import * as THREE from 'three';
import { heightAt, terrainNormal, raycastWorld } from '../shared/active.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
const MAX_DECALS = 48;        // 贴花池上限（契约要求）
const DROP_CAP = 192;         // 小血滴粒子容量
const SPRAY_CAP = 128;        // 大血雾颗粒容量
const MIN_PARTICLES = 8;      // 单次喷溅最少粒子数
const MAX_PARTICLES = 24;     // 单次喷溅最多粒子数
const GRAVITY = -9.8;
const DECAL_MIN_OPACITY = 0.55;
const DECAL_MAX_OPACITY = 0.8;
const WALL_SEARCH_DIST = 2.6; // 沿子弹方向搜索墙面的距离（m）

// 低饱和暗红调色板（#6e1a15 ~ #8c2b20 区间，含少量更深/更亮的自然变化）
const BLOOD_COLORS = [0x6e1a15, 0x7a2018, 0x8c2b20, 0x621713, 0x84271d];
// 贴花纹理底色（与粒子同族，略深一点，像"渗进"表面）
const DECAL_TINTS = [0x6e1a15, 0x7a2018, 0x8c2b20, 0x5f1611];
// 墙面贴花更暗：浅色墙面上如果直接用地面色，混出来会偏粉，不像血
const WALL_TINTS = [0x55120e, 0x5f1611, 0x6e1a15, 0x4a0f0b];

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3(0, 0, -1);
const _planeNormal = new THREE.Vector3(0, 0, 1); // PlaneGeometry 默认朝向 +Z
// 专供 spawnBloodImpact 使用，避免被 _groundDecal/_spawnDecal 的临时量覆盖
const _bPos = new THREE.Vector3();
const _bDir = new THREE.Vector3();
const _bRand = new THREE.Vector3();
const _bCol = new THREE.Color();

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function isVec3(v) {
  return !!v && typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number';
}

function readVec3(v, out, fallback) {
  if (isVec3(v)) out.set(v.x, v.y, v.z);
  else out.copy(fallback);
  return out;
}

function hasCanvas() {
  return typeof document !== 'undefined' && !!document.createElement;
}

// ---------------------------------------------------------------------------
// 程序化纹理
// ---------------------------------------------------------------------------

// 单个血滴/血雾颗粒：中心实、边缘柔（白色 + alpha，颜色由顶点色乘上去）
function makeDropTexture() {
  if (!hasCanvas()) return null;
  try {
    const size = 64;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    if (!g) return null;
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.92)');
    grad.addColorStop(0.78, 'rgba(255,255,255,0.35)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    g.fill();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  } catch {
    return null;
  }
}

// 不规则血泊轮廓：极坐标抖动 + 二次曲线平滑
function traceBlob(ctx, cx, cy, radius, points, jitter, squashX, squashY) {
  const pts = [];
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2;
    // 两层噪声：低频让轮廓有大起伏，高频让边缘毛糙
    const low = Math.sin(a * 3 + cx * 0.13) * 0.16 + Math.cos(a * 2.3 - cy * 0.11) * 0.12;
    const rr = radius * (1 + low + (Math.random() - 0.5) * jitter);
    pts.push([cx + Math.cos(a) * rr * squashX, cy + Math.sin(a) * rr * squashY]);
  }
  ctx.beginPath();
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p0 = pts[i];
    const p1 = pts[(i + 1) % n];
    const mx = (p0[0] + p1[0]) / 2;
    const my = (p0[1] + p1[1]) / 2;
    if (i === 0) ctx.moveTo(mx, my);
    else ctx.quadraticCurveTo(p0[0], p0[1], mx, my);
  }
  ctx.quadraticCurveTo(pts[0][0], pts[0][1], (pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2);
  ctx.closePath();
}

/**
 * 地面血迹：不规则血泊 + 飞溅小点 + 少量拖痕。
 * 纹理为白底 alpha 图？——不：贴花直接用暗红色，材质用 map + color 白色，
 * 这样不同贴花可以共享纹理并通过材质 color 微调深浅。
 */
function makeGroundDecalTexture() {
  if (!hasCanvas()) return null;
  try {
    const S = 256;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    if (!g) return null;
    const cx = S * 0.5;
    const cy = S * 0.5;

    // 主血泊（两层：外圈稀薄、内圈浓稠）
    g.fillStyle = 'rgba(255,255,255,0.55)';
    traceBlob(g, cx, cy, S * 0.30, 16, 0.34, 1.12, 0.94);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.95)';
    traceBlob(g, cx + 6, cy - 4, S * 0.21, 14, 0.30, 1.06, 0.92);
    g.fill();

    // 2~4 个相连的小血泊（不规则外形）
    const lobes = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < lobes; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = S * (0.16 + Math.random() * 0.16);
      g.fillStyle = `rgba(255,255,255,${0.55 + Math.random() * 0.35})`;
      traceBlob(g, cx + Math.cos(a) * d, cy + Math.sin(a) * d, S * (0.07 + Math.random() * 0.1), 12, 0.42, 1, 1);
      g.fill();
    }

    // 飞溅小点：越远越小越稀
    const dots = 26 + Math.floor(Math.random() * 26);
    for (let i = 0; i < dots; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = S * (0.18 + Math.pow(Math.random(), 0.65) * 0.30);
      const r = 1.2 + Math.random() * (d > S * 0.34 ? 2.2 : 4.6);
      g.fillStyle = `rgba(255,255,255,${0.45 + Math.random() * 0.5})`;
      g.beginPath();
      g.ellipse(
        cx + Math.cos(a) * d,
        cy + Math.sin(a) * d,
        r, r * (0.6 + Math.random() * 0.8),
        Math.random() * Math.PI, 0, Math.PI * 2
      );
      g.fill();
    }

    // 几条飞溅拖痕（沿径向的细长条）
    const streaks = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < streaks; i++) {
      const a = Math.random() * Math.PI * 2;
      const r0 = S * (0.14 + Math.random() * 0.1);
      const len = S * (0.06 + Math.random() * 0.16);
      const w = 1.5 + Math.random() * 3;
      g.save();
      g.translate(cx, cy);
      g.rotate(a);
      g.fillStyle = `rgba(255,255,255,${0.35 + Math.random() * 0.35})`;
      g.beginPath();
      g.ellipse(r0 + len * 0.5, 0, len * 0.5, w, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  } catch {
    return null;
  }
}

/** 墙面血迹：横向喷溅 + 向下流淌的血痕（贴花局部 +Y 为世界上方） */
function makeWallDecalTexture() {
  if (!hasCanvas()) return null;
  try {
    const S = 256;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    if (!g) return null;
    const cx = S * 0.5;
    const cy = S * 0.42;

    // 主喷溅团：横向拉长
    g.fillStyle = 'rgba(255,255,255,0.62)';
    traceBlob(g, cx, cy, S * 0.24, 16, 0.40, 1.28, 0.9);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.95)';
    traceBlob(g, cx - 4, cy + 2, S * 0.15, 12, 0.34, 1.2, 0.95);
    g.fill();

    // 放射状飞溅（喷溅方向感）
    const spikes = 7 + Math.floor(Math.random() * 6);
    for (let i = 0; i < spikes; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = S * (0.16 + Math.random() * 0.22);
      const r = 1.5 + Math.random() * 5;
      g.fillStyle = `rgba(255,255,255,${0.4 + Math.random() * 0.55})`;
      g.beginPath();
      g.ellipse(cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.8, r, r * 0.75, a, 0, Math.PI * 2);
      g.fill();
    }

    // 向下流淌的血痕（重力方向）
    const drips = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < drips; i++) {
      const x = cx + (Math.random() - 0.5) * S * 0.34;
      const y0 = cy + S * 0.05;
      const len = S * (0.10 + Math.random() * 0.24);
      const w = 1.6 + Math.random() * 3.2;
      const grad = g.createLinearGradient(0, y0, 0, y0 + len);
      grad.addColorStop(0, 'rgba(255,255,255,0.9)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(x - w * 0.5, y0);
      g.quadraticCurveTo(x + w * 0.3, y0 + len * 0.6, x - w * 0.15, y0 + len);
      g.lineTo(x + w * 0.15, y0 + len);
      g.quadraticCurveTo(x + w * 0.9, y0 + len * 0.6, x + w * 0.5, y0);
      g.closePath();
      g.fill();
      // 末端血珠
      g.fillStyle = 'rgba(255,255,255,0.75)';
      g.beginPath();
      g.ellipse(x + w * 0.1, y0 + len, w * 0.75, w * 0.95, 0, 0, Math.PI * 2);
      g.fill();
    }

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 粒子组（一个 Points = 一次 draw call；用 itemSize=4 的顶点色实现逐粒子 alpha）
// ---------------------------------------------------------------------------
class ParticleSet {
  constructor(scene, size, capacity, map) {
    this.capacity = capacity;
    this.count = 0;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.col = new Float32Array(capacity * 4);
    this.size = size;

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.col, 4);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e5); // 不做每帧包围球计算

    this.material = new THREE.PointsMaterial({
      size,
      map: map || null,
      vertexColors: true,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      sizeAttenuation: true,
      blending: THREE.NormalBlending, // 血液必须是普通混合（加法混合会变成荧光红）
      alphaTest: 0.01,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.points.visible = false;
    this.geo = geo;
    if (scene) scene.add(this.points);
  }

  /** 加入一个粒子；满了就覆盖最旧的（count 满时直接复用下标 0） */
  add(x, y, z, vx, vy, vz, r, g, b, a, life) {
    let i;
    if (this.count < this.capacity) {
      i = this.count++;
    } else {
      // 覆盖剩余寿命最短的那个，保证新喷溅一定可见
      let worst = 0;
      for (let k = 1; k < this.capacity; k++) {
        if (this.life[k] < this.life[worst]) worst = k;
      }
      i = worst;
    }
    const i3 = i * 3;
    const i4 = i * 4;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.col[i4] = r; this.col[i4 + 1] = g; this.col[i4 + 2] = b; this.col[i4 + 3] = a;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.alpha[i] = a;
    this.geo.setDrawRange(0, this.count);
    this.points.visible = true;
  }

  /** 交换删除（保持数组紧凑） */
  kill(i) {
    const last = this.count - 1;
    if (i !== last) {
      const i3 = i * 3;
      const l3 = last * 3;
      const i4 = i * 4;
      const l4 = last * 4;
      this.pos[i3] = this.pos[l3]; this.pos[i3 + 1] = this.pos[l3 + 1]; this.pos[i3 + 2] = this.pos[l3 + 2];
      this.vel[i3] = this.vel[l3]; this.vel[i3 + 1] = this.vel[l3 + 1]; this.vel[i3 + 2] = this.vel[l3 + 2];
      this.col[i4] = this.col[l4]; this.col[i4 + 1] = this.col[l4 + 1];
      this.col[i4 + 2] = this.col[l4 + 2]; this.col[i4 + 3] = this.col[l4 + 3];
      this.life[i] = this.life[last];
      this.maxLife[i] = this.maxLife[last];
      this.alpha[i] = this.alpha[last];
    }
    this.count = last;
  }

  clear() {
    this.count = 0;
    this.geo.setDrawRange(0, 0);
    this.points.visible = false;
  }

  dispose() {
    this.geo.dispose();
    this.material.dispose();
    if (this.points.parent) this.points.parent.remove(this.points);
  }
}

// ---------------------------------------------------------------------------
// 贴花池
// ---------------------------------------------------------------------------
class Decal {
  constructor(scene, geometry, map, tint) {
    this.material = new THREE.MeshBasicMaterial({
      map: map || null,
      color: tint,
      transparent: true,
      opacity: DECAL_MIN_OPACITY,
      depthWrite: false,
      // 关键：避免与地面/墙面共面导致的 z-fighting
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.visible = false;
    this.mesh.renderOrder = 2;
    this.mesh.matrixAutoUpdate = true;
    this.bornAt = -1;
    this.age = 0;
    this.targetOpacity = DECAL_MIN_OPACITY;
    this.fadeIn = 0.12;
    if (scene) scene.add(this.mesh);
  }

  dispose() {
    this.material.dispose();
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
  }
}

// ---------------------------------------------------------------------------
// 主类
// ---------------------------------------------------------------------------
export class BloodFX {
  constructor(scene, renderer) {
    this.scene = scene || null;
    this.renderer = renderer || null;
    this.disposed = false;
    this.time = 0;

    // 软件渲染（SwiftShader/llvmpipe）减半粒子，避免拖慢主线程
    this.qMul = 1;
    try {
      if (renderer && typeof renderer.getContext === 'function') {
        const gl = renderer.getContext();
        const ext = gl && typeof gl.getExtension === 'function'
          ? gl.getExtension('WEBGL_debug_renderer_info')
          : null;
        const name = ext && gl && typeof gl.getParameter === 'function'
          ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '')
          : '';
        if (/swiftshader|software|llvmpipe|basic render/i.test(name)) this.qMul = 0.5;
      }
    } catch { /* 忽略 */ }

    // 纹理（Node 环境返回 null，退化为纯色）
    this.dropTex = makeDropTexture();
    this.groundTex = makeGroundDecalTexture();
    this.wallTex = makeWallDecalTexture();
    if (this.dropTex && renderer && renderer.capabilities && renderer.capabilities.getMaxAnisotropy) {
      try {
        const aniso = Math.min(4, renderer.capabilities.getMaxAnisotropy());
        this.groundTex && (this.groundTex.anisotropy = aniso);
        this.wallTex && (this.wallTex.anisotropy = aniso);
      } catch { /* 忽略 */ }
    }

    // 粒子：两档尺寸（小血滴 / 大血雾），各 1 次 draw call
    this.drops = new ParticleSet(scene, 0.055, DROP_CAP, this.dropTex);
    this.spray = new ParticleSet(scene, 0.115, SPRAY_CAP, this.dropTex);

    // 贴花池
    this.decalGeo = new THREE.PlaneGeometry(1, 1);
    this.decals = [];
    this.decalCount = 0;

    // 每次喷溅的贴花预算（避免一枪糊满墙）
    this._budget = 0;
  }

  // ------------------------------------------------------------------
  // 贴花池管理
  // ------------------------------------------------------------------
  _acquireDecal(isWall) {
    const tints = isWall ? WALL_TINTS : DECAL_TINTS;
    // 池未满：新建
    if (this.decals.length < MAX_DECALS) {
      const d = new Decal(
        this.scene,
        this.decalGeo,
        isWall ? this.wallTex : this.groundTex,
        tints[Math.floor(Math.random() * tints.length)]
      );
      this.decals.push(d);
      this.decalCount = this.decals.length;
      return d;
    }
    // 池满：复用最旧的一张（bornAt 最小）
    let oldest = this.decals[0];
    for (let i = 1; i < this.decals.length; i++) {
      if (this.decals[i].bornAt < oldest.bornAt) oldest = this.decals[i];
    }
    oldest.material.map = isWall ? this.wallTex : this.groundTex;
    oldest.material.color.setHex(tints[Math.floor(Math.random() * tints.length)]);
    oldest.material.needsUpdate = true;
    return oldest;
  }

  /**
   * 生成一张贴花。
   * @param {THREE.Vector3} point 世界坐标
   * @param {THREE.Vector3} normal 表面法线（已归一化）
   * @param {boolean} isWall 墙面（true）还是地面（false）
   * @param {number} size 直径（米）
   * @param {number} opacity 0.55~0.8
   */
  _spawnDecal(point, normal, isWall, size, opacity) {
    if (this.disposed) return null;
    const d = this._acquireDecal(isWall);
    // 沿法线抬升 1~2cm，配合 polygonOffset 彻底避免 z-fighting
    const lift = isWall ? 0.015 : 0.012;
    d.mesh.position.set(
      point.x + normal.x * lift,
      point.y + normal.y * lift,
      point.z + normal.z * lift
    );
    // 让 PlaneGeometry 的 +Z 对齐表面法线，再绕法线自转
    _v1.copy(normal).normalize();
    if (_v1.lengthSq() < 1e-8) _v1.set(0, 1, 0);
    _q1.setFromUnitVectors(_planeNormal, _v1);
    // 墙面贴花的「流淌方向」必须朝下：setFromUnitVectors 在法线接近 ±Z 时
    // 可能把贴花局部 +Y 翻到下方，这里检查并绕法线转 180° 纠正。
    if (Math.abs(_v1.y) < 0.72) {
      _v2.set(0, 1, 0).applyQuaternion(_q1);
      if (_v2.y < 0) {
        _q2.setFromAxisAngle(_v1, Math.PI);
        _q1.premultiply(_q2);
      }
    }
    // 旋转策略：
    //   * 地面贴花：绕法线任意自转（血泊没有方向性）
    //   * 墙面贴花：只允许小幅旋转（±0.22rad），否则血痕会歪到一边甚至朝上
    const spin = Math.abs(_v1.y) < 0.72
      ? (Math.random() - 0.5) * 0.44
      : Math.random() * Math.PI * 2;
    if (spin !== 0) {
      _q2.setFromAxisAngle(_v1, spin);
      _q1.premultiply(_q2);
    }
    d.mesh.quaternion.copy(_q1);
    d.mesh.scale.set(size, size * (0.85 + Math.random() * 0.3), 1);
    d.material.opacity = 0.001;
    d.targetOpacity = clamp(opacity, DECAL_MIN_OPACITY, DECAL_MAX_OPACITY);
    d.bornAt = this.time;
    d.age = 0;
    d.mesh.visible = true;
    return d;
  }

  /** 地面贴花：按地形法线贴合，尺寸随 severity 变大 */
  _groundDecal(x, z, severity, scaleMul) {
    const gy = heightAt(x, z);
    const n = terrainNormal(x, z);
    _v1.set(n.x, n.y, n.z);
    _v2.set(x, gy, z);
    const size = (0.34 + Math.random() * 0.30) * (0.75 + severity * 0.55) * (scaleMul || 1);
    return this._spawnDecal(_v2, _v1, false, size, DECAL_MIN_OPACITY + Math.random() * 0.22);
  }

  // ------------------------------------------------------------------
  // 对外：受伤喷血
  // ------------------------------------------------------------------
  /**
   * 受伤喷血。
   * @param {THREE.Vector3|{x,y,z}} position 命中点（世界坐标）
   * @param {THREE.Vector3|{x,y,z}} direction 子弹前进方向
   * @param {number} severity 0~1（伤害越重喷得越多越远）
   */
  spawnBloodImpact(position, direction, severity) {
    if (this.disposed) return;
    const s = clamp(Number(severity) || 0, 0, 1);
    readVec3(position, _bPos, _fwd);
    readVec3(direction, _bDir, _fwd);
    if (_bDir.lengthSq() < 1e-8) _bDir.copy(_fwd);
    _bDir.normalize();

    const px = _bPos.x;
    const py = _bPos.y;
    const pz = _bPos.z;

    // ---- 1) 锥形喷溅粒子（8~24 个）----
    const count = Math.max(
      MIN_PARTICLES,
      Math.min(MAX_PARTICLES, Math.round((MIN_PARTICLES + s * 16) * this.qMul))
    );
    // 速度：伤害越大喷得越远；基础 1.7~4.3 m/s
    const baseSpeed = 1.7 + s * 2.6;
    const spread = 0.55 + s * 0.5;
    for (let i = 0; i < count; i++) {
      // 锥形：主方向 + 球面随机扰动
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.max(0, 1 - u * u));
      _bRand.set(r * Math.cos(a), u, r * Math.sin(a));
      const along = 0.55 + Math.random() * 0.85;
      const vx = _bDir.x * baseSpeed * along + _bRand.x * spread * (0.6 + Math.random());
      const vy = _bDir.y * baseSpeed * along + _bRand.y * spread * (0.6 + Math.random()) + 0.5;
      const vz = _bDir.z * baseSpeed * along + _bRand.z * spread * (0.6 + Math.random());
      _bCol.setHex(BLOOD_COLORS[Math.floor(Math.random() * BLOOD_COLORS.length)]);
      const life = 0.7 + Math.random() * 0.8;
      // 30% 用大颗粒（血雾），其余为小血滴
      if (Math.random() < 0.3) {
        this.spray.add(px, py, pz, vx * 0.8, vy * 0.8, vz * 0.8, _bCol.r, _bCol.g, _bCol.b, 0.75, life);
      } else {
        this.drops.add(px, py, pz, vx, vy, vz, _bCol.r, _bCol.g, _bCol.b, 0.95, life);
      }
    }

    // ---- 2) 命中点附近的地面血迹（若人站在地面附近）----
    // 预算是累加的（同一帧多次命中各自生效），但设上限，避免一次霰弹枪把贴花池刷爆
    this._budget = Math.min(14, this._budget + 2 + Math.round(s * 3));
    const gyHere = heightAt(px, pz);
    if (py - gyHere < 1.8 && this._budget > 0) {
      this._budget--;
      this._groundDecal(px + (Math.random() - 0.5) * 0.25, pz + (Math.random() - 0.5) * 0.25, s, 1.0);
    }

    // ---- 3) 墙面贴花：沿子弹方向搜索墙面 ----
    let hit = null;
    try {
      hit = raycastWorld(px, py, pz, _bDir.x, _bDir.y, _bDir.z, WALL_SEARCH_DIST);
    } catch {
      hit = null;
    }
    if (hit && hit.point && hit.normal) {
      const ny = hit.normal.y;
      if (Math.abs(ny) < 0.72) {
        // 竖直面 → 墙面贴花（朝向墙面法线，贴花局部 +Y 为世界上方）
        _v1.set(hit.normal.x, hit.normal.y, hit.normal.z).normalize();
        _v2.set(hit.point.x, hit.point.y, hit.point.z);
        const size = (0.36 + Math.random() * 0.34) * (0.8 + s * 0.6);
        this._spawnDecal(_v2, _v1, true, size, 0.70 + Math.random() * 0.10);
      } else if (ny > 0.72) {
        // 朝上的面 → 地面贴花
        this._groundDecal(hit.point.x, hit.point.z, s, 0.9);
      }
    }
  }

  // ------------------------------------------------------------------
  // 每帧更新
  // ------------------------------------------------------------------
  update(dt) {
    if (this.disposed) return;
    const step = Math.min(Math.max(Number(dt) || 0, 0), 0.1);
    this.time += step;

    this._updateParticles(this.drops, step, true);
    this._updateParticles(this.spray, step, false);

    // 贴花淡入
    for (let i = 0; i < this.decals.length; i++) {
      const d = this.decals[i];
      if (!d.mesh.visible) continue;
      d.age += step;
      if (d.age < d.fadeIn) {
        d.material.opacity = d.targetOpacity * (d.age / d.fadeIn);
      } else if (d.material.opacity !== d.targetOpacity) {
        d.material.opacity = d.targetOpacity;
      }
    }
  }

  /**
   * 粒子积分：重力 + 地面碰撞（落地消失）+ 寿命淡出。
   * @param {ParticleSet} set
   * @param {number} step
   * @param {boolean} makeDecals 落地时是否生成地面血迹
   */
  _updateParticles(set, step, makeDecals) {
    if (set.count === 0) return;
    const pos = set.pos;
    const vel = set.vel;
    const col = set.col;
    const life = set.life;
    const maxLife = set.maxLife;
    const alpha = set.alpha;
    for (let i = set.count - 1; i >= 0; i--) {
      life[i] -= step;
      const i3 = i * 3;
      if (life[i] <= 0) {
        set.kill(i);
        continue;
      }
      // 重力 + 轻微空气阻力
      vel[i3 + 1] += GRAVITY * step;
      const drag = 1 - 0.55 * step;
      vel[i3] *= drag;
      vel[i3 + 2] *= drag;
      pos[i3] += vel[i3] * step;
      pos[i3 + 1] += vel[i3 + 1] * step;
      pos[i3 + 2] += vel[i3 + 2] * step;

      // 落地：生成地面血迹后消失
      const gy = heightAt(pos[i3], pos[i3 + 2]);
      if (pos[i3 + 1] <= gy + 0.02) {
        if (makeDecals && this._budget > 0 && Math.random() < 0.55) {
          this._budget--;
          this._groundDecal(
            pos[i3] + (Math.random() - 0.5) * 0.12,
            pos[i3 + 2] + (Math.random() - 0.5) * 0.12,
            0.35,
            0.45 + Math.random() * 0.35
          );
        }
        set.kill(i);
        continue;
      }

      // 寿命末尾淡出（顶点色 alpha）：最后 35% 寿命线性淡出
      const t = life[i] / maxLife[i];
      col[i * 4 + 3] = alpha[i] * (t < 0.35 ? t / 0.35 : 1);
    }
    set.posAttr.needsUpdate = true;
    set.colAttr.needsUpdate = true;
    set.geo.setDrawRange(0, set.count);
    if (set.count === 0) set.points.visible = false;
  }

  /** 当前贴花数量（测试/调试用） */
  get decalTotal() {
    return this.decals.length;
  }

  /** 活跃粒子总数（测试/调试用） */
  particleCount() {
    return this.drops.count + this.spray.count;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.drops.dispose();
    this.spray.dispose();
    for (let i = 0; i < this.decals.length; i++) this.decals[i].dispose();
    this.decals.length = 0;
    this.decalGeo.dispose();
    if (this.dropTex) this.dropTex.dispose();
    if (this.groundTex) this.groundTex.dispose();
    if (this.wallTex) this.wallTex.dispose();
    this.dropTex = this.groundTex = this.wallTex = null;
  }
}

// 模块级临时颜色已在文件顶部与其它临时量一起声明（_bCol）

/**
 * 创建血液特效管理器。
 * @param {THREE.Scene} scene
 * @param {THREE.WebGLRenderer} [renderer]
 */
export function createBloodFX(scene, renderer) {
  return new BloodFX(scene, renderer);
}

export default createBloodFX;
