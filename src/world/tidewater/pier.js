// ===== 潮汐湾 · 长栈桥（地图灵魂 / 狙击位）+ T 形平台 + 栏杆 + 系船桩 + 桥头台阶 =====
// 契约（DESIGN_TIDEWATER_DM.md §5.1）：
//   createPier({ preset, anisotropy, extras }) -> { group, update?, dispose?, raycastTargets? }
//
// 视觉与碰撞严格对齐（数据来自 MAP_EXTRAS.pier，碰撞体由 shared/tidewater.js 生成）：
//   · 主桥面   x = pier.x, z = zStart → headZ0，宽 pier.width，顶面 = deckHeight
//   · T 形平台 z = headZ0 → zEnd，宽 headWidth（平台包含在 zStart..zEnd 之内）
//   · 栏杆     1.05m，沿主桥两侧 + 平台朝海三面 + 平台靠岸两侧（中间留主桥接口）
//   · 桥头台阶 4 级，z = ramp.z0 → ramp.z1，每级顶面 = ramp.y0 + stepH*(i+1)
//   · 小码头   MAP_EXTRAS.docks（含岸边引桥平台），也在本文件里画（栈桥域）
// 所有几何按材质分桶合并（wood / metal / iron / cloth），本模块 3~4 个 draw call。
import * as THREE from 'three';
import { MAP_EXTRAS, heightAt, seedOf, mulberry32 } from '../../../shared/active.js';
import { PALETTE, shade, createKit } from './village.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// 契约 §3.3 的兜底数值（extras.pier 缺失时使用，保证占位地图也能生成几何）
const PIER_FALLBACK = {
  x: 52, zStart: 18, zEnd: 96, deckHeight: 2.8,
  width: 3.4, headWidth: 16, headDepth: 9, railH: 1.05,
};

function resolvePier(X) {
  const src = X && X.pier && typeof X.pier === 'object' ? X.pier : null;
  const p = { ...PIER_FALLBACK };
  if (src) {
    for (const k of Object.keys(PIER_FALLBACK)) {
      if (Number.isFinite(src[k])) p[k] = src[k];
    }
  }
  p.halfW = Number.isFinite(src && src.halfW) ? src.halfW : p.width / 2;
  p.headHalfW = Number.isFinite(src && src.headHalfW) ? src.headHalfW : p.headWidth / 2;
  p.headZ0 = Number.isFinite(src && src.headZ0) ? src.headZ0 : p.zEnd - p.headDepth;
  p.ramp = src && src.ramp && typeof src.ramp === 'object' ? { ...src.ramp } : null;
  // 占位地图（没有 pier 数据）时把桥面抬到地形之上，避免整条栈桥埋进地里
  if (!src) {
    let gmax = -Infinity;
    for (let i = 0; i <= 24; i++) {
      const z = p.zStart + ((p.zEnd - p.zStart) * i) / 24;
      gmax = Math.max(gmax, heightAt(p.x, z));
    }
    p.deckHeight = Math.max(p.deckHeight, gmax + 0.8);
  }
  return p;
}

// ---------- 桥面铺板 ----------
// 板条横跨 X（垂直于行走方向），沿 z 从 z0 到 z1；顶面严格 = topY
function deckPlanks(kit, x, z0, z1, halfWidth, topY, rand) {
  const step = 0.18;
  const n = Math.max(1, Math.round((z1 - z0) / step));
  const dz = (z1 - z0) / n;
  for (let i = 0; i < n; i++) {
    const z = z0 + dz * (i + 0.5);
    // 靠岸段地形与桥面齐平（桥头地形垫 2.8m）：板面浮到沙面之上 3cm，
    // 避免桥面被地形网格吃掉、或者与沙面 z-fighting。
    let gmax = -Infinity;
    for (const ox of [-halfWidth + 0.25, 0, halfWidth - 0.25]) {
      gmax = Math.max(gmax, heightAt(x + ox, z));
    }
    const top = gmax > topY - 0.16 ? Math.min(Math.max(topY, gmax + 0.03), topY + 0.1) : topY;
    kit.box('wood', shade(PALETTE.plank, 0.82 + rand() * 0.3),
      x + (rand() - 0.5) * 0.025, top - 0.035 + (rand() - 0.5) * 0.006, z,
      halfWidth * 2 - 0.02, 0.06, dz * 0.9);
  }
  return n;
}

// 桥面下的纵梁 + 横枕
function deckFrame(kit, x, z0, z1, halfWidth, topY, rand) {
  const zc = (z0 + z1) / 2, len = z1 - z0;
  for (const sgn of [-1, 1]) {
    kit.box('wood', shade(PALETTE.plankDark, 0.92 + rand() * 0.1),
      x + sgn * (halfWidth - 0.22), topY - 0.17, zc, 0.12, 0.2, len);
  }
  const n = Math.max(1, Math.round(len / 2.2));
  for (let i = 0; i <= n; i++) {
    const z = z0 + (len * i) / n;
    kit.box('wood', shade(PALETTE.plankDark, 0.86 + rand() * 0.12),
      x, topY - 0.21, z, halfWidth * 2, 0.16, 0.14);
  }
}

// 桥桩：从桥面下落到海床
function pilings(kit, x, z, halfWidth, topY, rand, deep = 0.45) {
  for (const sgn of [-1, 1]) {
    const px = x + sgn * (halfWidth - 0.26);
    // 海床很深处（水面以下看不见）把桩截到 -2.4，省几何也不影响观感
    const bed = Math.max(heightAt(px, z) - deep, -2.4);
    const top = topY - 0.2;
    if (top - bed < 0.3) continue;
    kit.cyl('wood', shade(PALETTE.plankDark, 0.84 + rand() * 0.18),
      px, (bed + top) / 2, z, 0.15, 0.17, top - bed, 7);
    // 水下斜撑
    if (rand() < 0.3) {
      kit.beam('wood', shade(PALETTE.plankDark, 0.78),
        px, bed + 0.2, z, x + sgn * 0.1, top - 0.35, z, 0.09, 0.09);
    }
  }
}

// 栏杆：沿 a→b 的直线（与 pier_rail 碰撞体同线），高 railH，厚 0.12
function addRail(kit, ax, az, bx, bz, deckY, railH, rand) {
  const dx = bx - ax, dz = bz - az;
  const len = Math.hypot(dx, dz);
  if (len < 0.3) return;
  const postColor = shade(PALETTE.plankDark, 0.9 + rand() * 0.14);
  const topColor = shade(PALETTE.trim, 0.9 + rand() * 0.14);
  const n = Math.max(1, Math.round(len / 2.2));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    kit.box('wood', postColor, ax + dx * t, deckY + railH / 2, az + dz * t, 0.13, railH, 0.13);
  }
  // 顶栏 + 中栏
  kit.beam('wood', topColor, ax, deckY + railH - 0.06, az, bx, deckY + railH - 0.06, bz, 0.14, 0.11);
  kit.beam('wood', shade(PALETTE.plankDark, 0.95), ax, deckY + railH * 0.5, az,
    bx, deckY + railH * 0.5, bz, 0.09, 0.08);
}

// 系船桩 + 缆绳圈
function addBollard(kit, x, z, deckY, rand) {
  kit.cyl('wood', shade(PALETTE.plankDark, 0.92 + rand() * 0.12), x, deckY + 0.21, z, 0.17, 0.2, 0.42, 8);
  kit.cyl('metal', shade(PALETTE.metalDark, 0.95), x, deckY + 0.44, z, 0.21, 0.21, 0.06, 8);
  // 缆绳圈（平躺在桥面上）
  kit.torus('wood', shade(PALETTE.rope, 0.92 + rand() * 0.12), x + 0.5, deckY + 0.045, z,
    0.24, 0.05, 9, 5, Math.PI / 2, 0, 0);
}

// 灯柱（纯装饰，不发光；避免每盏灯一个 PointLight 吃性能）
function addLampPost(kit, x, z, deckY, rand) {
  kit.cyl('wood', shade(PALETTE.plankDark, 0.9), x, deckY + 1.3, z, 0.08, 0.1, 2.6, 6);
  kit.box('wood', shade(PALETTE.plankDark, 0.9), x + 0.28, deckY + 2.52, z, 0.62, 0.08, 0.08);
  kit.box('metal', PALETTE.metalDark, x + 0.56, deckY + 2.2, z, 0.22, 0.34, 0.22);
  kit.box('cloth', shade(0xe8c98a, 0.95 + rand() * 0.1), x + 0.56, deckY + 2.2, z, 0.16, 0.26, 0.16);
  kit.box('metal', PALETTE.metalDark, x + 0.56, deckY + 2.4, z, 0.26, 0.06, 0.26);
}

// 平台外沿的爬梯（下到水面）
function addLadder(kit, x, z, deckY, rand) {
  for (const sgn of [-1, 1]) {
    kit.box('wood', shade(PALETTE.plankDark, 0.9), x + sgn * 0.22, deckY - 1.05, z, 0.08, 2.2, 0.08);
  }
  for (let i = 0; i < 6; i++) {
    kit.box('wood', shade(PALETTE.plank, 0.9 + rand() * 0.14), x, deckY - 0.25 - i * 0.34, z, 0.44, 0.06, 0.07);
  }
}

// ---------- 小码头（东侧，含岸边引桥平台）----------
function addDock(kit, d, rand) {
  const y = Number.isFinite(d.y) ? d.y : heightAt(d.x, d.z) + 0.9;
  const rot = d.rot || 0;
  const hw = Math.max(0.8, d.w / 2), hd = Math.max(0.8, d.d / 2);
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const at = (u, v) => ({ x: d.x + u * cos + v * sin, z: d.z - u * sin + v * cos });

  // 铺板（横跨 u，沿 v 排）
  const step = 0.18;
  const n = Math.max(1, Math.round((hd * 2) / step));
  const dv = (hd * 2) / n;
  for (let i = 0; i < n; i++) {
    const v = -hd + dv * (i + 0.5);
    const p = at(0, v);
    kit.box('wood', shade(PALETTE.plank, 0.84 + rand() * 0.26), p.x, y - 0.035, p.z,
      hw * 2 - 0.02, 0.06, dv * 0.9, 0, rot, 0);
  }
  // 纵梁
  for (const sgn of [-1, 1]) {
    const p = at(sgn * (hw - 0.2), 0);
    kit.box('wood', shade(PALETTE.plankDark, 0.92), p.x, y - 0.16, p.z, 0.11, 0.18, hd * 2, 0, rot, 0);
  }
  // 四角桩（落到海床）
  for (const su of [-1, 1]) {
    for (const sv of [-1, 1]) {
      const p = at(su * (hw - 0.2), sv * (hd - 0.2));
      const bed = heightAt(p.x, p.z) - 0.5;
      const top = y - 0.18;
      if (top - bed < 0.2) continue;
      kit.cyl('wood', shade(PALETTE.plankDark, 0.86 + rand() * 0.16), p.x, (bed + top) / 2, p.z,
        0.14, 0.16, top - bed, 7);
    }
  }
  // 系缆桩
  for (const su of [-1, 1]) {
    const p = at(su * (hw - 0.45), hd - 0.3);
    kit.cyl('wood', shade(PALETTE.plankDark, 0.92), p.x, y + 0.16, p.z, 0.13, 0.15, 0.32, 7);
  }
  // 岸边引桥平台（与 dock_ramp 碰撞体同高：顶面 = y，宽 = w*0.8）
  const rampW = d.w * 0.8;
  const rz0 = d.z - hd - 3.0, rz1 = d.z - hd;
  const rn = Math.max(1, Math.round((rz1 - rz0) / 0.18));
  for (let i = 0; i < rn; i++) {
    const z = rz0 + ((rz1 - rz0) * (i + 0.5)) / rn;
    kit.box('wood', shade(PALETTE.plank, 0.82 + rand() * 0.26), d.x, y - 0.035, z,
      rampW - 0.02, 0.06, ((rz1 - rz0) / rn) * 0.9);
  }
  for (const sgn of [-1, 1]) {
    const px = d.x + sgn * (rampW / 2 - 0.2);
    const bed = heightAt(px, rz1) - 0.4;
    if (y - 0.2 - bed > 0.25) {
      kit.box('wood', shade(PALETTE.plankDark, 0.88), px, (bed + y - 0.2) / 2, rz0 + 1.4,
        0.12, y - 0.2 - bed, 0.12);
    }
  }
  // 岸边两级踏脚（纯视觉，帮助理解高度差）
  for (let i = 0; i < 2; i++) {
    const g = heightAt(d.x, rz0 - 0.3 - i * 0.4);
    kit.box('wood', shade(PALETTE.plankDark, 0.9), d.x, g + 0.02 + i * 0.06, rz0 - 0.3 - i * 0.4,
      rampW * 0.7, 0.1, 0.42);
  }
}

// ================= 对外入口 =================
export function createPier({ preset, anisotropy = 1, extras } = {}) {
  const p = preset || {};
  const X = extras && typeof extras === 'object' ? extras : (MAP_EXTRAS || {});
  const detail = clamp(Number.isFinite(p.props) ? p.props : 1, 0.3, 1.2);
  const kit = createKit();
  const group = new THREE.Group();
  group.name = 'tidewater:pier';
  const rand = mulberry32(seedOf('tidewater:pier'));
  const P = resolvePier(X);

  const x = P.x, deckY = P.deckHeight, halfW = P.halfW, headHalfW = P.headHalfW;
  const zStart = P.zStart, headZ0 = P.headZ0, zEnd = P.zEnd;
  const railH = P.railH;
  const counts = { planks: 0, posts: 0, rails: 0 };

  // ---- 主桥面 ----
  counts.planks += deckPlanks(kit, x, zStart, headZ0, halfW, deckY, rand);
  deckFrame(kit, x, zStart, headZ0, halfW, deckY, rand);
  // ---- T 形平台 ----
  counts.planks += deckPlanks(kit, x, headZ0, zEnd, headHalfW, deckY, rand);
  deckFrame(kit, x, headZ0, zEnd, headHalfW, deckY, rand);
  // 平台与主桥的接缝横梁
  kit.box('wood', shade(PALETTE.plankDark, 0.9), x, deckY - 0.2, headZ0, headHalfW * 2, 0.18, 0.16);

  // ---- 桥桩 ----
  const pn = Math.max(2, Math.round((headZ0 - zStart) / 2.6));
  for (let i = 0; i <= pn; i++) {
    const z = zStart + ((headZ0 - zStart) * i) / pn;
    pilings(kit, x, z, halfW, deckY, rand);
  }
  // 平台桩（沿外沿一圈 + 中间两根）
  const headPosts = [];
  for (const su of [-1, 1]) {
    for (const sv of [-1, 1]) headPosts.push([x + su * (headHalfW - 0.3), (headZ0 + zEnd) / 2 + sv * (P.headDepth / 2 - 0.3)]);
  }
  headPosts.push([x, headZ0 + P.headDepth * 0.28], [x, zEnd - 0.4]);
  for (const [px, pz] of headPosts) {
    const bed = Math.max(heightAt(px, pz) - 0.5, -2.4);
    const top = deckY - 0.2;
    if (top - bed < 0.3) continue;
    kit.cyl('wood', shade(PALETTE.plankDark, 0.84 + rand() * 0.18),
      px, (bed + top) / 2, pz, 0.16, 0.18, top - bed, 7);
    counts.posts++;
  }

  // ---- 栏杆（严格沿 pier_rail 碰撞体）----
  // 主桥两侧
  addRail(kit, x - halfW, zStart, x - halfW, headZ0, deckY, railH, rand);
  addRail(kit, x + halfW, zStart, x + halfW, headZ0, deckY, railH, rand);
  // 平台朝海一面
  addRail(kit, x - headHalfW, zEnd, x + headHalfW, zEnd, deckY, railH, rand);
  // 平台东西两侧
  addRail(kit, x - headHalfW, headZ0, x - headHalfW, zEnd, deckY, railH, rand);
  addRail(kit, x + headHalfW, headZ0, x + headHalfW, zEnd, deckY, railH, rand);
  // 平台靠岸两侧（中间给主桥留口）
  const gap = halfW + 0.1;
  addRail(kit, x - headHalfW, headZ0, x - gap, headZ0, deckY, railH, rand);
  addRail(kit, x + gap, headZ0, x + headHalfW, headZ0, deckY, railH, rand);
  counts.rails = 7;

  // ---- 系船桩 / 灯柱 / 爬梯 ----
  for (const sgn of [-1, 1]) {
    addBollard(kit, x + sgn * (halfW - 0.4), zStart + 3.2, deckY, rand);
    addBollard(kit, x + sgn * (halfW - 0.4), headZ0 - 4.0, deckY, rand);
  }
  addBollard(kit, x - headHalfW + 0.9, zEnd - 0.9, deckY, rand);
  addBollard(kit, x + headHalfW - 0.9, zEnd - 0.9, deckY, rand);
  if (detail > 0.45) {
    for (const t of [0.18, 0.5, 0.82]) {
      const z = zStart + (headZ0 - zStart) * t;
      addLampPost(kit, x - halfW + 0.28, z, deckY, rand);
    }
  }
  addLadder(kit, x + headHalfW - 1.6, zEnd + 0.1, deckY, rand);

  // ---- 桥头坡道 / 引桥平台（与 pier_ramp 碰撞体对齐）----
  const ramp = P.ramp;
  if (ramp && Number.isFinite(ramp.z0) && Number.isFinite(ramp.z1) && !(ramp.steps > 0)) {
    // 数据里是"平的一段"（顶面 = ramp.y1 ≈ deckHeight）：直接铺一段桥面 + 纵梁
    const ry = Number.isFinite(ramp.y1) ? ramp.y1 : deckY;
    const rw = Number.isFinite(ramp.width) ? ramp.width : P.width;
    const rx = Number.isFinite(ramp.x) ? ramp.x : x;
    deckPlanks(kit, rx, ramp.z0, ramp.z1, rw / 2, ry, rand);
    deckFrame(kit, rx, ramp.z0, ramp.z1, rw / 2, ry, rand);
    // 与沙滩的接缝压边
    kit.box('wood', shade(PALETTE.plankDark, 0.9), rx, ry - 0.12, ramp.z0 + 0.05, rw, 0.16, 0.14);
    counts.planks += 1;
  }
  if (ramp && Number.isFinite(ramp.z0) && Number.isFinite(ramp.z1) && ramp.steps > 0) {
    const steps = Math.max(1, Math.min(12, ramp.steps | 0));
    const dz = (ramp.z1 - ramp.z0) / steps;
    const w = Number.isFinite(ramp.width) ? ramp.width : P.width;
    for (let i = 0; i < steps; i++) {
      const top = ramp.y0 + ramp.stepH * (i + 1);
      const z = ramp.z0 + dz * (i + 0.5);
      // 踏面
      kit.box('wood', shade(PALETTE.plank, 0.84 + rand() * 0.24), ramp.x, top - 0.05, z,
        w, 0.1, dz + 0.02);
      // 踢面（一直落到地形，避免悬空）
      const g = heightAt(ramp.x, z) - 0.2;
      const h = Math.max(0.08, top - 0.1 - g);
      kit.box('wood', shade(PALETTE.plankDark, 0.92 + rand() * 0.1), ramp.x, g + h / 2, z,
        w - 0.1, h, 0.1);
      // 两侧挡板
      for (const sgn of [-1, 1]) {
        kit.box('wood', shade(PALETTE.plankDark, 0.88), ramp.x + sgn * (w / 2 - 0.06),
          g + (top - g) / 2, z, 0.1, Math.max(0.1, top - g), dz);
      }
    }
    // 台阶两侧扶手
    if (detail > 0.4) {
      for (const sgn of [-1, 1]) {
        const rx = ramp.x + sgn * (w / 2 - 0.08);
        kit.beam('wood', shade(PALETTE.trim, 0.92), rx, ramp.y0 + 0.95, ramp.z0,
          rx, deckY + railH - 0.1, ramp.z1, 0.1, 0.1);
      }
    }
  }

  // ---- 小码头 ----
  const docks = Array.isArray(X.docks) ? X.docks : [];
  for (const d of docks) {
    if (!d || !Number.isFinite(d.x) || !Number.isFinite(d.z)) continue;
    addDock(kit, d, rand);
    counts.posts += 1;
  }

  // ---- 合并 ----
  const finished = kit.finish(group);

  return {
    group,
    raycastTargets: finished.meshes,
    counts,
    update() { /* 静态结构，无逐帧动画 */ },
    setQuality() { /* 细节在建造时按 preset 决定 */ },
    dispose: finished.dispose,
  };
}
