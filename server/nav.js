// ===== 导航网格 + A* 寻路（server/nav.js）=====
// 地图无关：所有地形/碰撞数据都来自 shared/active.js（按 MAP 环境变量切换郊区 / 潮汐湾），
// 不再直接 import shared/world.js，保证服务器与客户端用的是同一张地图。
//
// 网格分辨率 1m：i = floor(x+half), j = floor(z+half)，节点世界坐标 = (i+0.5-half, j+0.5-half)。
// 郊区 140×140（half=70），潮汐湾 320×320（half=160），尺寸全部由 WORLD.size/half 推导。
//
// 可走判定与 shared/<map>.js 的 isWalkableAt 等价（同一净空半径 R = playerRadius + 0.35，
// 同一竖直过滤：顶面低于台阶高度的矮障碍可跨过、门楣等头顶构件不挡路），但这里按碰撞体
// bbox 局部刷格而不是每格遍历全部碰撞体，建图从 ~100ms 降到 ~10ms 级。
//
// 对外 API（契约 §4.4 只要求这些名字稳定，可新增）：
//   buildNav() -> nav            （模块级缓存，整进程只建一次；可传 source 供测试）
//   findPath(nav, sx,sz, tx,tz)  -> [{x,z}] | null
//   nearestWalkable(nav,x,z)     -> {x,z} | null
//   randomWalkable(nav, rng)     -> {x,z} | null
//   hasLineOfWalk(nav, ax,az,bx,bz) -> boolean
//   sampleCover(nav, x,z, threatX,threatZ) -> {x,z,low} | null
import {
  WORLD, COLLIDERS, SPAWNS, heightAt, isWalkableAt, losBlocked,
} from '../shared/active.js';

const SOLID_MARGIN = 0.12;                 // 掩体/视线网格余量（净空半径在 buildNavFrom 内按地图 WORLD.playerRadius 计算）
const LINE_STEP = 0.4;                     // 直线可达性采样步长（米）
// A* 展开上限：潮汐湾 320×320 格，跨图寻路展开量远大于郊区，放宽到 40000 仍然有界
const MAX_EXPAND = 40000;
const SQRT2 = Math.SQRT2;
const INF = 1e9;
const JUMPABLE_MAX = 1.0;                  // 顶面不高于 1m 的矮障碍可尝试起跳翻越
const JUMPABLE_KINDS = new Set(['rock', 'rubble', 'debris', 'crate', 'platform', 'stone']);

let _navCache = null;

function clampNum(v, a, b) { return v < a ? a : v > b ? b : v; }
function finiteOr(v, d) { return Number.isFinite(v) ? v : d; }
function nowMs() {
  return (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
    ? performance.now() : Date.now();
}

// SPAWNS 兼容两种形态：{alpha:[],bravo:[],all:[]} 或纯数组
function normalizeSpawns(src) {
  const s = src.SPAWNS;
  const out = [];
  if (Array.isArray(s)) {
    for (const p of s) if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) out.push({ x: p.x, z: p.z });
    return out;
  }
  if (s && typeof s === 'object') {
    if (Array.isArray(s.all)) {
      for (const p of s.all) if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) out.push({ x: p.x, z: p.z });
    } else {
      for (const k of Object.keys(s)) {
        if (!Array.isArray(s[k])) continue;
        for (const p of s[k]) if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) out.push({ x: p.x, z: p.z });
      }
    }
  }
  return out;
}

// ---------- 网格坐标 ----------
function nodeAt(nav, x, z) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return -1;
  const i = Math.floor(x + nav.half);
  const j = Math.floor(z + nav.half);
  if (i < 0 || j < 0 || i >= nav.n || j >= nav.n) return -1;
  return j * nav.n + i;
}

function nodePoint(nav, node) {
  const i = node % nav.n;
  const j = (node - i) / nav.n;
  return { x: i + 0.5 - nav.half, z: j + 0.5 - nav.half };
}

function inBounds(nav, x, z) {
  return Number.isFinite(x) && Number.isFinite(z) &&
    x > -nav.half && x < nav.half && z > -nav.half && z < nav.half;
}

function walkableAt(nav, x, z) {
  const node = nodeAt(nav, x, z);
  return node >= 0 && nav.walkable[node] === 1;
}

// 格心高度双线性采样（heights 是 140×140 的格心高度）
function heightSample(nav, x, z) {
  const gx = clampNum(x + nav.half - 0.5, 0, nav.n - 1);
  const gz = clampNum(z + nav.half - 0.5, 0, nav.n - 1);
  const i0 = Math.floor(gx), j0 = Math.floor(gz);
  const i1 = Math.min(nav.n - 1, i0 + 1), j1 = Math.min(nav.n - 1, j0 + 1);
  const fx = gx - i0, fz = gz - j0;
  const h = nav.heights, n = nav.n;
  const h00 = h[j0 * n + i0], h10 = h[j0 * n + i1];
  const h01 = h[j1 * n + i0], h11 = h[j1 * n + i1];
  return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
}

// 2D 线段与 AABB 最近进入参数（无交返回 INF）；掩体预筛选用
function segBoxT(ax, az, bx, bz, c, margin) {
  const hw = finiteOr(c.w, 1) / 2 + margin;
  const hd = finiteOr(c.d, 1) / 2 + margin;
  const minX = c.x - hw, maxX = c.x + hw;
  const minZ = c.z - hd, maxZ = c.z + hd;
  const dx = bx - ax, dz = bz - az;
  let t0 = 0, t1 = 1;
  if (Math.abs(dx) < 1e-9) {
    if (ax < minX || ax > maxX) return INF;
  } else {
    let ta = (minX - ax) / dx, tb = (maxX - ax) / dx;
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return INF;
  }
  if (Math.abs(dz) < 1e-9) {
    if (az < minZ || az > maxZ) return INF;
  } else {
    let ta = (minZ - az) / dz, tb = (maxZ - az) / dz;
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return INF;
  }
  return t0;
}

// 地形 + 碰撞体的“粗遮挡”预筛（不追求精确，只用来减少昂贵射线调用）
function quickCoverBlocked(nav, tx, tz, cx, cz) {
  const hFn = nav._heightFn;
  const ty = hFn(tx, tz) + 1.62;
  const cy = hFn(cx, cz) + 1.05;
  const dx = cx - tx, dz = cz - tz;
  const dist = Math.hypot(dx, dz);
  if (dist < 1.2) return false;
  // 地形隆起
  const steps = Math.max(2, Math.ceil(dist / 1.5));
  for (let k = 1; k < steps; k++) {
    const t = k / steps;
    const y = ty + (cy - ty) * t;
    if (hFn(tx + dx * t, tz + dz * t) > y + 0.15) return true;
  }
  // 实体（至少要挡住 1.0m 高度的视线）
  const list = nav.colliders;
  for (let m = 0; m < list.length; m++) {
    const c = list[m];
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.z)) continue;
    if (c.kind === 'boundary') continue;
    const y0 = finiteOr(c.y0, 0);
    const y1 = finiteOr(c.y1, finiteOr(c.h, finiteOr(c.height, 3)));
    if (y1 < 1.0 || y0 > 2.2) continue;
    const t = segBoxT(tx, tz, cx, cz, c, 0.05);
    if (t > 0.02 && t < 0.985) return true;
  }
  return false;
}

// ---------- 网格直线可达（等步长采样；strict=true 要求 1m 级净空）----------
function lineWalkable(nav, ax, az, bx, bz, strict) {
  if (!inBounds(nav, ax, az) || !inBounds(nav, bx, bz)) return false;
  const dx = bx - ax, dz = bz - az;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-4) {
    const node = nodeAt(nav, ax, az);
    if (node < 0) return false;
    return strict ? nav.open[node] === 1 : nav.walkable[node] === 1;
  }
  const steps = Math.max(1, Math.ceil(dist / LINE_STEP));
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const node = nodeAt(nav, ax + dx * t, az + dz * t);
    if (node < 0) return false;
    if (strict) {
      if (nav.open[node] === 1) continue;
      // 端点允许落在“可走但贴近障碍”的格子里，中间不行
      if ((k === 0 || k === steps) && nav.walkable[node] === 1) continue;
      return false;
    }
    if (nav.walkable[node] !== 1) return false;
  }
  return true;
}

// ---------- 网格视线（ctx.world.losBlocked 缺失时的兜底）----------
function navLosBlocked(nav, ax, ay, az, bx, by, bz) {
  if (!Number.isFinite(ax) || !Number.isFinite(bz)) return true;
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.hypot(dx, dy, dz);
  if (len < 0.2) return false;
  const steps = Math.min(220, Math.ceil(len / 0.7));
  const list = nav.colliders;
  for (let k = 1; k < steps; k++) {
    const t = k / steps;
    const x = ax + dx * t, y = ay + dy * t, z = az + dz * t;
    if (y < heightSample(nav, x, z) + 0.03) return true;   // 被地形挡住
    for (let m = 0; m < list.length; m++) {
      const c = list[m];
      if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.z)) continue;
      const hw = finiteOr(c.w, 1) / 2, hd = finiteOr(c.d, 1) / 2;
      if (x < c.x - hw || x > c.x + hw || z < c.z - hd || z > c.z + hd) continue;
      const y0 = finiteOr(c.y0, 0);
      const y1 = finiteOr(c.y1, finiteOr(c.h, finiteOr(c.height, 3)));
      if (y >= y0 && y <= y1) return true;
    }
  }
  return false;
}

// ---------- A* 二叉堆（复用缓冲）----------
function growHeap(nav) {
  const cap = nav._heap.length * 2;
  const h = new Int32Array(cap);
  h.set(nav._heap);
  nav._heap = h;
  const f = new Float32Array(cap);
  f.set(nav._heapF);
  nav._heapF = f;
}

function heapPush(nav, node, f) {
  if (nav._heapSize >= nav._heap.length) growHeap(nav);
  const heap = nav._heap, heapF = nav._heapF;
  let i = nav._heapSize++;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (heapF[p] <= f) break;
    heap[i] = heap[p];
    heapF[i] = heapF[p];
    i = p;
  }
  heap[i] = node;
  heapF[i] = f;
}

function heapPop(nav) {
  const heap = nav._heap, heapF = nav._heapF;
  const top = heap[0];
  const size = --nav._heapSize;
  if (size > 0) {
    const last = heap[size], lastF = heapF[size];
    let i = 0;
    for (;;) {
      let c = i * 2 + 1;
      if (c >= size) break;
      if (c + 1 < size && heapF[c + 1] < heapF[c]) c++;
      if (heapF[c] >= lastF) break;
      heap[i] = heap[c];
      heapF[i] = heapF[c];
      i = c;
    }
    heap[i] = last;
    heapF[i] = lastF;
  }
  return top;
}

function octile(nav, a, b) {
  const ai = a % nav.n, bi = b % nav.n;
  const aj = (a - ai) / nav.n, bj = (b - bi) / nav.n;
  const dx = Math.abs(ai - bi), dz = Math.abs(aj - bj);
  return (dx + dz) + (SQRT2 - 2) * Math.min(dx, dz);
}

// ---------- 平滑：直线可走则拉直 ----------
function smoothPath(nav, pts) {
  const len = pts.length;
  if (len <= 2) return pts;
  const out = [pts[0]];
  let i = 0;
  while (i < len - 1) {
    let j = len - 1;
    for (; j > i + 1; j--) {
      if (lineWalkable(nav, pts[i].x, pts[i].z, pts[j].x, pts[j].z, true)) break;
    }
    out.push(pts[j]);
    i = j;
  }
  return out;
}

// ---------- 建图 ----------
function buildNavFrom(src) {
  const t0 = nowMs();
  const W = src.WORLD || WORLD || {};
  const half = finiteOr(W.half, finiteOr(W.size, 140) / 2);
  const n = Math.round(finiteOr(W.size, half * 2));
  const count = n * n;
  const heightFn = typeof src.heightAt === 'function' ? src.heightAt : heightAt;
  const colliders = Array.isArray(src.COLLIDERS) ? src.COLLIDERS
    : (Array.isArray(COLLIDERS) ? COLLIDERS : []);
  const playerHeight = finiteOr(W.playerHeight, 1.8);
  const maxStep = finiteOr(W.maxStep, 0.6);
  const maxSlope = finiteOr(W.maxSlope, 0.9);
  const R = finiteOr(W.playerRadius, 0.42) + 0.35;
  const R2 = R * R;
  const rangeMargin = half - 3;   // 与 isWalkableAt 的边界判定保持一致（每张地图自己算）

  const walkable = new Uint8Array(count).fill(1);
  const heights = new Float32Array(count);
  const slope = new Float32Array(count);
  const clearance = new Float32Array(count);
  const cost = new Float32Array(count);
  const lowObstacles = [];

  // 1) 格心高度
  for (let j = 0; j < n; j++) {
    const z = j + 0.5 - half;
    for (let i = 0; i < n; i++) {
      heights[j * n + i] = heightFn(i + 0.5 - half, z) || 0;
    }
  }

  // 2) 边界 + 坡度（与 isWalkableAt 的边界/坡度规则一致）
  for (let j = 0; j < n; j++) {
    const z = j + 0.5 - half;
    for (let i = 0; i < n; i++) {
      const idx = j * n + i;
      const x = i + 0.5 - half;
      if (Math.abs(x) > rangeMargin || Math.abs(z) > rangeMargin) { walkable[idx] = 0; continue; }
      const h0 = heights[idx];
      let s = 0;
      for (let dz = -1; dz <= 1; dz++) {
        const nj = j + dz;
        if (nj < 0 || nj >= n) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const ni = i + dx;
          if (ni < 0 || ni >= n) continue;
          const cur = Math.abs(heights[nj * n + ni] - h0) / (dx && dz ? SQRT2 : 1);
          if (cur > s) s = cur;
        }
      }
      slope[idx] = s;
      if (s > maxSlope) walkable[idx] = 0;
    }
  }

  // 3) 碰撞体：按 bbox 局部刷格（等价 isWalkableAt：R 净空 + 矮障碍可跨 + 头顶构件不挡）
  for (let k = 0; k < colliders.length; k++) {
    const c = colliders[k];
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.z)) continue;
    const hw = finiteOr(c.w, 1) / 2;
    const hd = finiteOr(c.d, 1) / 2;
    const y0 = finiteOr(c.y0, 0);
    const y1 = finiteOr(c.y1, finiteOr(c.h, finiteOr(c.height, 3)));
    if (!(y1 > 0.02)) continue;
    const i0 = Math.max(0, Math.ceil(c.x - hw - R + half - 0.5));
    const i1 = Math.min(n - 1, Math.floor(c.x + hw + R + half - 0.5));
    const j0 = Math.max(0, Math.ceil(c.z - hd - R + half - 0.5));
    const j1 = Math.min(n - 1, Math.floor(c.z + hd + R + half - 0.5));
    for (let j = j0; j <= j1; j++) {
      const z = j + 0.5 - half;
      const nz = z < c.z - hd ? c.z - hd : (z > c.z + hd ? c.z + hd : z);
      const ddz = z - nz;
      const row = j * n;
      for (let i = i0; i <= i1; i++) {
        const x = i + 0.5 - half;
        const nx = x < c.x - hw ? c.x - hw : (x > c.x + hw ? c.x + hw : x);
        const ddx = x - nx;
        if (ddx * ddx + ddz * ddz >= R2) continue;
        const g = heights[row + i];
        if (y1 <= g + 0.25) continue;                      // 矮到可跨过
        if (y0 > g + playerHeight) continue;               // 门楣等头顶构件
        walkable[row + i] = 0;
      }
    }
    // 可跳翻的矮障碍：记录给 AI（顶面离地 ≤1m）
    const gC = heightFn(c.x, c.z);
    if (y1 - gC <= JUMPABLE_MAX && y1 - gC > 0.25 && (JUMPABLE_KINDS.has(c.kind) || y1 - gC <= 0.75)) {
      lowObstacles.push({ x: c.x, z: c.z, w: finiteOr(c.w, 1), d: finiteOr(c.d, 1), h: y1, kind: c.kind });
    }
  }

  // 4) 出生点 / 据点中心可用性校验（数据承诺不重叠；若不满足则退到最近可走点）
  const tmpNav = { half, n, walkable };
  const spawns = [];
  for (const s of normalizeSpawns(src)) {
    const node = nodeAt(tmpNav, s.x, s.z);
    if (node >= 0 && walkable[node] === 1) spawns.push({ x: s.x, z: s.z });
    else {
      const p = nearestWalkableInner(tmpNav, s.x, s.z);
      if (p) spawns.push(p);
    }
  }
  // 死亡竞赛不再有据点：zones 保留空数组，避免下游读到 undefined（决策逻辑已不依赖它）
  const zones = [];
  const zoneList = Array.isArray(src.ZONES) ? src.ZONES : [];
  for (const z of zoneList) {
    if (!z || !Number.isFinite(z.x) || !Number.isFinite(z.z)) continue;
    const node = nodeAt(tmpNav, z.x, z.z);
    if (node >= 0 && walkable[node] === 1) zones.push({ ...z });
    else {
      const p = nearestWalkableInner(tmpNav, z.x, z.z);
      zones.push(p ? { ...z, x: p.x, z: p.z } : { ...z });
    }
  }

  // 5) 开阔格：8 邻接全部可走（直线平滑/随机点用，保证 1m 级净空）
  const open = new Uint8Array(count);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const idx = j * n + i;
      if (walkable[idx] !== 1) continue;
      let ok = 1;
      for (let dz = -1; dz <= 1 && ok; dz++) {
        const nj = j + dz;
        if (nj < 0 || nj >= n) { ok = 0; break; }
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const ni = i + dx;
          if (ni < 0 || ni >= n) { ok = 0; break; }
          if (walkable[nj * n + ni] !== 1) { ok = 0; break; }
        }
      }
      open[idx] = ok;
    }
  }

  // 6) 离障碍距离（chamfer 距离变换，单位≈米）→ 代价：贴墙/陡坡更贵，引导路径走开阔地
  for (let i = 0; i < count; i++) clearance[i] = walkable[i] === 1 ? INF : 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const idx = j * n + i;
      let d = clearance[idx];
      if (i > 0) d = Math.min(d, clearance[idx - 1] + 1);
      if (j > 0) {
        d = Math.min(d, clearance[idx - n] + 1);
        if (i > 0) d = Math.min(d, clearance[idx - n - 1] + SQRT2);
        if (i < n - 1) d = Math.min(d, clearance[idx - n + 1] + SQRT2);
      }
      clearance[idx] = d;
    }
  }
  for (let j = n - 1; j >= 0; j--) {
    for (let i = n - 1; i >= 0; i--) {
      const idx = j * n + i;
      let d = clearance[idx];
      if (i < n - 1) d = Math.min(d, clearance[idx + 1] + 1);
      if (j < n - 1) {
        d = Math.min(d, clearance[idx + n] + 1);
        if (i < n - 1) d = Math.min(d, clearance[idx + n + 1] + SQRT2);
        if (i > 0) d = Math.min(d, clearance[idx + n - 1] + SQRT2);
      }
      clearance[idx] = d;
    }
  }
  let walkableCount = 0;
  for (let i = 0; i < count; i++) {
    if (walkable[i] !== 1) { cost[i] = 1e6; continue; }
    walkableCount++;
    cost[i] = 1 + slope[i] * 0.8 + Math.max(0, 2.0 - clearance[i]) * 0.30;
  }

  const nav = {
    version: 1,
    size: n, half, n, count, step: 1,
    walkable, open, heights, slope, clearance, cost,
    colliders, lowObstacles, spawns, zones,
    maxSlope, maxStep, margin: R,
    walkableCount,
    buildMs: Math.round((nowMs() - t0) * 10) / 10,
    // A* 复用缓冲（避免每个 AI 每次寻路分配大对象）
    _g: new Float32Array(count),
    _from: new Int32Array(count),
    _stamp: new Int32Array(count),
    _closed: new Int32Array(count),
    _stampCounter: 0,
    _heap: new Int32Array(8192),
    _heapF: new Float32Array(8192),
    _heapSize: 0,
    _pathBuf: new Int32Array(count),
    _lastPathMs: 0,
    _pathCount: 0,
    _queryCount: 0,
    _heightFn: heightFn,
    _losFn: typeof src.losBlocked === 'function' ? src.losBlocked : losBlocked,
    _walkFn: typeof src.isWalkableAt === 'function' ? src.isWalkableAt : isWalkableAt,
    _solidMargin: SOLID_MARGIN,
  };

  // 实例方法（建图时创建一次）
  nav.nodeAt = (x, z) => nodeAt(nav, x, z);
  nav.point = (node) => nodePoint(nav, node);
  nav.walkableAt = (x, z) => walkableAt(nav, x, z);
  nav.openAt = (x, z) => { const k = nodeAt(nav, x, z); return k >= 0 && nav.open[k] === 1; };
  nav.heightAt = (x, z) => heightSample(nav, x, z);
  nav.losBlocked = (ax, ay, az, bx, by, bz) => nav._losFn(ax, ay, az, bx, by, bz);
  nav.isWalkableAt = (x, z) => nav._walkFn(x, z);
  return nav;
}

// 建图/查询时的 nearestWalkable（nav 尚未成型时也可用）
function nearestWalkableInner(nav, x, z) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const i0 = clampNum(Math.floor(x + nav.half), 0, nav.n - 1);
  const j0 = clampNum(Math.floor(z + nav.half), 0, nav.n - 1);
  if (nav.walkable[j0 * nav.n + i0] === 1) return nodePoint(nav, j0 * nav.n + i0);
  const maxR = Math.min(nav.n, 30);
  for (let r = 1; r <= maxR; r++) {
    let best = -1, bestD = INF;
    const ja = Math.max(0, j0 - r), jb = Math.min(nav.n - 1, j0 + r);
    const ia = Math.max(0, i0 - r), ib = Math.min(nav.n - 1, i0 + r);
    for (let j = ja; j <= jb; j++) {
      const edgeRow = (j === ja || j === jb);
      for (let i = ia; i <= ib; i++) {
        if (!edgeRow && i !== ia && i !== ib) continue;
        const idx = j * nav.n + i;
        if (nav.walkable[idx] !== 1) continue;
        const dx = (i + 0.5 - nav.half) - x, dz = (j + 0.5 - nav.half) - z;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = idx; }
      }
    }
    if (best >= 0) return nodePoint(nav, best);
  }
  return null;
}

// ---------- 对外 API ----------

// 构建（并缓存）导航网格。server 只调一次；测试可传 source 覆盖数据源（不写缓存）。
export function buildNav(source) {
  if (source) return buildNavFrom(source);
  if (!_navCache) _navCache = buildNavFrom({ WORLD, COLLIDERS, ZONES: [], SPAWNS, heightAt, isWalkableAt, losBlocked });
  return _navCache;
}

// A* 寻路：返回世界坐标路径点 [{x,z}]（首点为起点附近格心，末点尽量贴近目标）或 null
export function findPath(nav, sx, sz, tx, tz) {
  nav = nav || buildNav();
  if (!nav) return null;
  if (!Number.isFinite(sx) || !Number.isFinite(sz) || !Number.isFinite(tx) || !Number.isFinite(tz)) return null;
  const t0 = nowMs();
  nav._queryCount++;

  const startP = nearestWalkableInner(nav, sx, sz);
  const goalP = nearestWalkableInner(nav, tx, tz);
  if (!startP || !goalP) return null;
  // 请求点已经在某格可走区域内且离格心很近时，直接用格心；否则从最近可走格出发
  const startNode = nearestNodeTo(nav, startP.x, startP.z);
  const goalNode = nearestNodeTo(nav, goalP.x, goalP.z);
  if (startNode < 0 || goalNode < 0) return null;
  if (startNode === goalNode) {
    nav._lastPathMs = 0;
    return [{ x: goalP.x, z: goalP.z }];
  }

  nav._heapSize = 0;
  const stamp = ++nav._stampCounter;
  const gScore = nav._g, from = nav._from, seen = nav._stamp, closed = nav._closed;
  const walk = nav.walkable, n = nav.n;

  seen[startNode] = stamp;
  gScore[startNode] = 0;
  from[startNode] = -1;
  heapPush(nav, startNode, octile(nav, startNode, goalNode));

  let found = false;
  let expanded = 0;
  while (nav._heapSize > 0) {
    const cur = heapPop(nav);
    if (closed[cur] === stamp) continue;
    closed[cur] = stamp;
    if (cur === goalNode) { found = true; break; }
    if (++expanded > MAX_EXPAND) break;

    const ci = cur % n;
    const cj = (cur - ci) / n;
    for (let dz = -1; dz <= 1; dz++) {
      const nj = cj + dz;
      if (nj < 0 || nj >= n) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const ni = ci + dx;
        if (ni < 0 || ni >= n) continue;
        const nidx = nj * n + ni;
        if (walk[nidx] !== 1) continue;
        if (dx && dz) {
          // 禁止穿角：两个正交邻格都必须可走
          if (walk[cj * n + ni] !== 1 || walk[nj * n + ci] !== 1) continue;
        }
        if (closed[nidx] === stamp) continue;
        const ng = gScore[cur] + (dx && dz ? SQRT2 : 1) * costOf(nav, nidx);
        if (seen[nidx] !== stamp || ng < gScore[nidx]) {
          seen[nidx] = stamp;
          gScore[nidx] = ng;
          from[nidx] = cur;
          heapPush(nav, nidx, ng + octile(nav, nidx, goalNode));
        }
      }
    }
  }
  if (!found) { nav._lastPathMs = 0; return null; }

  // 回溯
  let len = 0;
  const buf = nav._pathBuf;
  let cur = goalNode;
  const guard = nav.count + 2;
  while (cur >= 0 && len < guard) {
    buf[len++] = cur;
    if (cur === startNode) break;
    cur = from[cur];
  }
  if (len >= guard || buf[len - 1] !== startNode) { nav._lastPathMs = 0; return null; }

  const pts = new Array(len);
  for (let i = 0; i < len; i++) pts[i] = nodePoint(nav, buf[len - 1 - i]);

  // 路径末点尽量贴近原始目标（目标点本身可走且直线可达时）
  const endP = pts[pts.length - 1];
  if (walkableAt(nav, tx, tz) && Math.hypot(tx - endP.x, tz - endP.z) > 0.25 &&
    lineWalkable(nav, endP.x, endP.z, tx, tz, true)) {
    pts.push({ x: tx, z: tz });
  }

  const smoothed = smoothPath(nav, pts);
  nav._lastPathMs = Math.round((nowMs() - t0) * 100) / 100;
  nav._pathCount++;
  return smoothed;
}

function costOf(nav, node) {
  const c = nav.cost[node];
  return c > 1e5 ? 1e6 : c;
}

function nearestNodeTo(nav, x, z) {
  const i = clampNum(Math.floor(x + nav.half), 0, nav.n - 1);
  const j = clampNum(Math.floor(z + nav.half), 0, nav.n - 1);
  const idx = j * nav.n + i;
  return nav.walkable[idx] === 1 ? idx : -1;
}

// 最近的可行走格心；找不到返回 null
export function nearestWalkable(nav, x, z) {
  nav = nav || buildNav();
  if (!nav) return null;
  return nearestWalkableInner(nav, x, z);
}

// 随机可行走点（优先开阔格，避免贴墙点；rng 可为函数或 {next()/random()}）
export function randomWalkable(nav, rng) {
  nav = nav || buildNav();
  if (!nav) return null;
  let rand;
  if (typeof rng === 'function') rand = rng;
  else if (rng && typeof rng.next === 'function') rand = () => rng.next();
  else if (rng && typeof rng.random === 'function') rand = () => rng.random();
  else rand = Math.random;

  const count = nav.count;
  for (let i = 0; i < 160; i++) {
    const node = Math.floor(rand() * count);
    if (node >= 0 && node < count && nav.open[node] === 1) return nodePoint(nav, node);
  }
  for (let i = 0; i < 240; i++) {
    const node = Math.floor(rand() * count);
    if (node >= 0 && node < count && nav.walkable[node] === 1) return nodePoint(nav, node);
  }
  for (let node = 0; node < count; node += 97) {
    if (nav.walkable[node] === 1) return nodePoint(nav, node);
  }
  return null;
}

// 直线能否走过去（网格采样，含 1m 级净空要求）
export function hasLineOfWalk(nav, ax, az, bx, bz) {
  nav = nav || buildNav();
  if (!nav) return false;
  return lineWalkable(nav, ax, az, bx, bz, true);
}

// 找掩体：在 (x,z) 附近找一个“威胁看不到、可走、离威胁别太远也别太近”的点。
// 返回 { x, z, low }：low=true 表示只有蹲下才被完全遮挡（矮墙/沙袋）。
export function sampleCover(nav, x, z, threatX, threatZ) {
  nav = nav || buildNav();
  if (!nav) return null;
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(threatX) || !Number.isFinite(threatZ)) return null;

  const hFn = nav._heightFn;
  const losFn = nav._losFn;
  const threatEyeY = hFn(threatX, threatZ) + 1.62;
  const d0 = Math.hypot(threatX - x, threatZ - z);
  const R = 16;
  let best = null;
  let bestScore = -INF;

  // 2m 步长扫附近格点（附近网格），先廉价预筛，再对少量候选做真实射线验证
  for (let dzc = -R; dzc <= R; dzc += 2) {
    const cz = Math.round(z + dzc);
    for (let dxc = -R; dxc <= R; dxc += 2) {
      const cx = Math.round(x + dxc);
      const node = nodeAt(nav, cx, cz);
      if (node < 0 || nav.walkable[node] !== 1) continue;
      const dSelf = Math.hypot(cx - x, cz - z);
      if (dSelf < 2 || dSelf > R) continue;
      const dThreat = Math.hypot(threatX - cx, threatZ - cz);
      if (dThreat < 4 || dThreat > 34) continue;
      if (dThreat < d0 * 0.35) continue;
      if (!quickCoverBlocked(nav, threatX, threatZ, cx, cz)) continue;
      // 真实射线：站立胸口被挡 = 完整掩体；仅蹲姿眼高被挡 = 矮掩体
      const groundY = hFn(cx, cz);
      const standBlocked = losFn(threatX, threatEyeY, threatZ, cx, groundY + 1.15, cz);
      const crouchBlocked = losFn(threatX, threatEyeY, threatZ, cx, groundY + 0.9, cz);
      if (!standBlocked && !crouchBlocked) continue;
      let score = 60 - dSelf * 1.1 - Math.abs(dThreat - 14) * 0.7;
      if (standBlocked) score += 16;
      if (nav.open[node] === 1) score += 6;
      if (score > bestScore) {
        bestScore = score;
        best = { x: cx, z: cz, low: !standBlocked && crouchBlocked };
      }
    }
  }
  return best;
}
