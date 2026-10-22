// ===== 潮汐湾 · 道具：搁浅渔船 / 鱼摊遮阳棚 / 掩体道具（木箱·油桶·龙虾笼·渔网架·破船板）/ 海滩杂物 =====
// 契约（DESIGN_TIDEWATER_DM.md §5.1）：
//   createProps({ preset, anisotropy, extras }) -> { group, update?, dispose?, raycastTargets? }
//
// 数据来源（全部来自 shared/active.js，不在客户端复制常量）：
//   · MAP_EXTRAS.boats  : { x, z, rot, len, beam, hullY, tilt }
//       hullY = 船体基准面（水线），碰撞体竖直范围严格是 [hullY-1.0, hullY+1.15]
//       → 视觉：龙骨底 hullY-1.0、舷缘顶 hullY+1.15（玩家可以跳上舷缘当掩体）
//   · MAP_EXTRAS.stalls : { x, z, rot, w, d, h }
//       h 是相对地面的棚顶顶面高度；碰撞体 = 顶棚 [base+h-0.18, base+h] + 四角柱 [base, base+h]
//   · DEFENSES          : { x, z, w, d, h, rot, kind }
//       kind ∈ crate | barrel | lobster | netrack | plank；w/d 是世界轴对齐外廓，base = heightAt-0.12
// 几何按材质分桶合并（wood / metal / cloth / net / stone），本模块 5~6 个 draw call。
import * as THREE from 'three';
import {
  MAP_EXTRAS, DEFENSES, ROCKS, COLLIDERS, heightAt, seedOf, mulberry32, valueNoise,
} from '../../../shared/active.js';
import { PALETTE, shade, mixHex, createKit } from './village.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// 让旋转后的模型外廓严格落在世界轴对齐 AABB（w × d）内：视觉永不超出碰撞体
function fitBox(w, d, rot) {
  const c = Math.abs(Math.cos(rot)), s = Math.abs(Math.sin(rot));
  const det = c * c - s * s;
  let bw, bd;
  if (Math.abs(det) < 1e-3) {
    const k = 1 / Math.max(0.2, c + s);
    bw = w * k;
    bd = d * k;
  } else {
    bw = (w * c - d * s) / det;
    bd = (d * c - w * s) / det;
  }
  return { bw: Math.max(0.16, bw * 0.98), bd: Math.max(0.16, bd * 0.98) };
}

// 本地 (lx, lz) 绕 Y 旋转到世界（与 three 的 rotateY 一致）
function rotXZ(cx, cz, rot, lx, lz) {
  const c = Math.cos(rot), s = Math.sin(rot);
  return { x: cx + lx * c + lz * s, z: cz - lx * s + lz * c };
}

// ================= 渔船 =================
// 用 12 个横剖面放样出船体（龙骨线 + 舷缘线 + V 形横剖面），再补舷缘压条 / 横座板 / 舱底板。
// 局部坐标：+x = 船头，z = 横向（±beam/2），y = 0 在 hullY（水线基准）。
function addBoat(kit, b, rand) {
  const len = Math.max(3, Number.isFinite(b.len) ? b.len : 7);
  const beam = Math.max(1.2, Number.isFinite(b.beam) ? b.beam : 2.8);
  const hullY = Number.isFinite(b.hullY) ? b.hullY : heightAt(b.x, b.z) + 0.1;
  const rot = b.rot || 0;
  const tilt = b.tilt || 0;
  const cosR = Math.cos(rot), sinR = Math.sin(rot);
  const cosT = Math.cos(tilt), sinT = Math.sin(tilt);

  const GUNWALE = 1.15;            // 舷缘顶（= 碰撞体 y1）
  const KEEL_MID = -1.0;           // 中部龙骨底（= 碰撞体 y0）

  // 横倾（tilt）只做视觉：碰撞体是轴对齐的 [hullY-1.0, hullY+1.15]，
  // 所以这里先按倾斜量收一点船宽、再把整体下压，保证歪在沙上的船体仍严格落在碰撞盒内
  // （收窄 + 下沉后龙骨会略微埋进沙里，这正好是搁浅船该有的样子）。
  const sinAbs = Math.abs(sinT);
  const halfBeam = beam / 2;
  const hwFit = Math.max(0.25, (halfBeam - GUNWALE * sinAbs - 0.1) / Math.max(0.5, cosT));
  const dropY = Math.max(0, hwFit * sinAbs - GUNWALE * (1 - cosT));
  const lenFit = Math.max(2, len - 0.16);

  // 局部 → 世界：先绕长轴（本地 X）横倾，再绕 Y 旋转，最后平移到 (x, hullY, z)
  const toWorld = (lx, ly, lz) => {
    const ty = ly * cosT - lz * sinT;
    const tz = ly * sinT + lz * cosT;
    return {
      x: b.x + lx * cosR + tz * sinR,
      y: hullY + ty - dropY,
      z: b.z - lx * sinR + tz * cosR,
    };
  };
  const hullTones = [0x6f7f78, 0x7a5b4a, 0x8a8f86, 0x5f6f74];
  const hullTone = hullTones[Math.floor(rand() * hullTones.length) % hullTones.length];

  const STATIONS = 12;
  const profile = [
    [-1.0, 0.0], [-0.97, 0.2], [-0.8, 0.46], [-0.48, 0.78], [0.0, 1.0],
  ];
  const rings = [];
  for (let i = 0; i <= STATIONS; i++) {
    const t = i / STATIONS;
    // 船宽：中段最宽，船头收成尖，船尾略收
    const hwBase = (0.88 + 0.12 * smoothstep(0, 0.3, t)) * (1 - 0.94 * Math.pow(smoothstep(0.5, 1, t), 1.35));
    const hw = hwFit * hwBase;
    // 龙骨：中段最深，船头抬起（搁浅姿态）
    const keelY = KEEL_MID + 0.55 * smoothstep(0.72, 1, t);
    const depth = GUNWALE - keelY;
    const pts = [];
    for (const [fz, fd] of profile) pts.push({ z: fz * hw, y: GUNWALE - fd * depth });
    for (let k = profile.length - 2; k >= 0; k--) {
      pts.push({ z: -profile[k][0] * hw, y: GUNWALE - profile[k][1] * depth });
    }
    rings.push({ x: -lenFit / 2 + lenFit * t, pts, hw, depth, keelY });
  }

  // 逐四边形放样（每个面单独上色，形成"板条"感）
  const pushQuad = (a, b2, c, d, color) => {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array([
      a.x, a.y, a.z, b2.x, b2.y, b2.z, c.x, c.y, c.z,
      a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z,
    ]);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    // 法线朝外检查：与"从船体中心轴指向面片"的方向比较
    const nx = geo.getAttribute('normal').getX(0);
    const ny = geo.getAttribute('normal').getY(0);
    const nz = geo.getAttribute('normal').getZ(0);
    const cxm = (a.x + b2.x + c.x + d.x) / 4;
    const cym = (a.y + b2.y + c.y + d.y) / 4;
    const czm = (a.z + b2.z + c.z + d.z) / 4;
    if (nx * cxm + ny * (cym + 0.2) + nz * czm < 0) {
      const p = geo.getAttribute('position');
      // 交换第二、三个顶点 → 反转绕序
      const tmp = [p.getX(1), p.getY(1), p.getZ(1)];
      p.setXYZ(1, p.getX(2), p.getY(2), p.getZ(2));
      p.setXYZ(2, tmp[0], tmp[1], tmp[2]);
      const tmp2 = [p.getX(4), p.getY(4), p.getZ(4)];
      p.setXYZ(4, p.getX(5), p.getY(5), p.getZ(5));
      p.setXYZ(5, tmp2[0], tmp2[1], tmp2[2]);
      p.needsUpdate = true;
      geo.computeVertexNormals();
    }
    kit.push('wood', color, geo);
  };

  for (let i = 0; i < STATIONS; i++) {
    const A = rings[i], B = rings[i + 1];
    const n = A.pts.length;
    for (let j = 0; j < n - 1; j++) {
      const tone = shade(hullTone, 0.82 + rand() * 0.3);
      pushQuad(
        toWorld(A.x, A.pts[j].y, A.pts[j].z),
        toWorld(A.x, A.pts[j + 1].y, A.pts[j + 1].z),
        toWorld(B.x, B.pts[j + 1].y, B.pts[j + 1].z),
        toWorld(B.x, B.pts[j].y, B.pts[j].z),
        tone,
      );
    }
  }

  // 船尾封板（横剖面填成平面）
  const capRing = (ring, color) => {
    const pts = ring.pts;
    const cy = pts.reduce((acc, p) => acc + p.y, 0) / pts.length;
    const center = toWorld(ring.x, cy, 0);
    for (let j = 0; j < pts.length - 1; j++) {
      const geo = new THREE.BufferGeometry();
      const p0 = toWorld(ring.x, pts[j].y, pts[j].z);
      const p1 = toWorld(ring.x, pts[j + 1].y, pts[j + 1].z);
      const pos = new Float32Array([
        center.x, center.y, center.z, p0.x, p0.y, p0.z, p1.x, p1.y, p1.z,
      ]);
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.computeVertexNormals();
      kit.push('wood', color, geo);
    }
  };
  capRing(rings[0], shade(hullTone, 0.8));
  capRing(rings[STATIONS], shade(hullTone, 0.86));

  // 舷缘压条（沿两侧舷缘）
  for (let i = 0; i < STATIONS; i++) {
    const A = rings[i], B = rings[i + 1];
    for (const j of [0, A.pts.length - 1]) {
      const p0 = toWorld(A.x, A.pts[j].y - 0.1, A.pts[j].z);
      const p1 = toWorld(B.x, B.pts[j].y - 0.1, B.pts[j].z);
      kit.beam('wood', shade(PALETTE.plankWarm, 0.9 + rand() * 0.16),
        p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, 0.1, 0.16);
    }
  }
  // 舱底木板 + 横座板
  const mid = rings[6];
  const floorY = GUNWALE - mid.depth * 0.78;
  for (const fz of [-0.42, 0, 0.42]) {
    const p0 = toWorld(-lenFit * 0.3, floorY, fz * mid.hw);
    const p1 = toWorld(lenFit * 0.3, floorY, fz * mid.hw);
    kit.beam('wood', shade(PALETTE.plankDark, 0.9), p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, 0.26, 0.06);
  }
  for (const t of [0.26, 0.52, 0.76]) {
    const idx = Math.round(t * STATIONS);
    const ring = rings[idx];
    const y = GUNWALE - ring.depth * 0.42;
    const p0 = toWorld(ring.x, y, -ring.hw * 0.86);
    const p1 = toWorld(ring.x, y, ring.hw * 0.86);
    kit.beam('wood', shade(PALETTE.plankWarm, 0.92 + rand() * 0.12),
      p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, 0.3, 0.07);
  }
  // 船头小甲板
  const bow = rings[STATIONS - 1];
  if (bow.hw > 0.25) {
    const p = toWorld(bow.x - 0.35, GUNWALE - bow.depth * 0.18, 0);
    kit.box('wood', shade(PALETTE.plank, 0.9), p.x, p.y, p.z,
      Math.max(0.4, bow.hw * 1.4), 0.06, Math.max(0.4, bow.hw * 1.4), 0, rot, 0);
  }
  // 船尾的小舷外机架（搁浅渔船的空架子）
  const stern = rings[0];
  const sp = toWorld(-lenFit / 2 + 0.2, GUNWALE - 0.35, 0);
  kit.box('metal', PALETTE.metalDark, sp.x, sp.y, sp.z, 0.24, 0.4, 0.34, 0, rot, 0);
}

// ================= 鱼摊遮阳棚 =================
// 顶棚 = stall_roof 碰撞体（[base+h-0.18, base+h]），四角柱 = stall_post 碰撞体位置
function addStall(kit, s, rand, detail) {
  const base = heightAt(s.x, s.z);
  const h = Math.max(1.8, Number.isFinite(s.h) ? s.h : 2.5);
  const rot = s.rot || 0;
  const w = Math.max(1.2, s.w || 4), d = Math.max(1.2, s.d || 2.8);
  const roofY0 = base + h - 0.18;
  const roofY1 = base + h;
  const postColor = shade(PALETTE.plankDark, 0.9 + rand() * 0.14);

  // 四角柱（与碰撞体同位置：按旋转后的 |cos|/|sin| 内缩 0.2）
  const c = Math.abs(Math.cos(rot)), sn = Math.abs(Math.sin(rot));
  const ox = c * (w / 2 - 0.2) + sn * (d / 2 - 0.2);
  const oz = sn * (w / 2 - 0.2) + c * (d / 2 - 0.2);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const px = s.x + sx * ox, pz = s.z + sz * oz;
      kit.box('wood', postColor, px, (base + roofY0) / 2, pz, 0.2, roofY0 - base, 0.2);
    }
  }
  // 横梁（托住顶棚）
  for (const sz of [-1, 1]) {
    const p = rotXZ(s.x, s.z, rot, 0, sz * (d / 2 - 0.2));
    kit.box('wood', shade(PALETTE.plankDark, 0.86), p.x, roofY0 - 0.06, p.z, w - 0.1, 0.14, 0.14, 0, rot, 0);
  }
  // 条纹帆布顶棚（拆成 8 条，颜色交替；总厚度 = 碰撞体 0.18）
  const strips = 8;
  const sw = w / strips;
  for (let i = 0; i < strips; i++) {
    const lx = -w / 2 + sw * (i + 0.5);
    const p = rotXZ(s.x, s.z, rot, lx, 0);
    const tone = i % 2 === 0
      ? mixHex(PALETTE.cloth, PALETTE.clothRed, 0.55)
      : shade(PALETTE.cloth, 0.96 + rand() * 0.06);
    kit.box('cloth', tone, p.x, (roofY0 + roofY1) / 2, p.z, sw + 0.005, roofY1 - roofY0, d, 0, rot, 0);
  }
  // 檐口垂布（薄，纯装饰）
  if (detail > 0.5) {
    for (const sz of [-1, 1]) {
      const p = rotXZ(s.x, s.z, rot, 0, sz * (d / 2 + 0.02));
      kit.box('cloth', mixHex(PALETTE.cloth, PALETTE.clothRed, 0.4), p.x, roofY0 - 0.09, p.z,
        w, 0.18, 0.03, 0, rot, 0);
    }
  }
  // 摊位台面 + 木箱 + 挂灯
  const counter = rotXZ(s.x, s.z, rot, 0, -d / 2 + 0.55);
  kit.box('wood', shade(PALETTE.plank, 0.94), counter.x, base + 0.92, counter.z,
    w - 0.6, 0.1, 0.7, 0, rot, 0);
  kit.box('wood', shade(PALETTE.plankDark, 0.9), counter.x, base + 0.45, counter.z,
    w - 0.7, 0.86, 0.6, 0, rot, 0);
  for (let i = 0; i < 2; i++) {
    const p = rotXZ(s.x, s.z, rot, -0.6 + i * 1.1, -d / 2 + 0.5);
    kit.box('wood', shade(PALETTE.plankPale, 0.9 + rand() * 0.14), p.x, base + 1.1, p.z,
      0.48, 0.3, 0.4, 0, rot, 0);
  }
  if (detail > 0.6) {
    const p = rotXZ(s.x, s.z, rot, w / 2 - 0.35, 0);
    kit.box('metal', PALETTE.metalDark, p.x, roofY0 - 0.22, p.z, 0.18, 0.3, 0.18);
    kit.box('cloth', 0xe8c98a, p.x, roofY0 - 0.22, p.z, 0.13, 0.22, 0.13);
  }
}

// ================= 掩体道具 =================
function addCrate(kit, b, rand) {
  const base = heightAt(b.x, b.z) - 0.12;
  const rot = b.rot || 0;
  const { bw, bd } = fitBox(b.w, b.d, rot);
  const h = Math.max(0.3, b.h);
  const tone = mixHex(PALETTE.plankWarm, PALETTE.plank, 0.4 + rand() * 0.4);
  // 箱体
  kit.box('wood', shade(tone, 0.94 + rand() * 0.12), b.x, base + h / 2, b.z, bw, h, bd, 0, rot, 0);
  // 顶部盖板 + 四角护木
  kit.box('wood', shade(tone, 0.84), b.x, base + h - 0.03, b.z, bw + 0.03, 0.06, bd + 0.03, 0, rot, 0);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const p = rotXZ(b.x, b.z, rot, sx * (bw / 2 - 0.04), sz * (bd / 2 - 0.04));
      kit.box('wood', shade(PALETTE.plankDark, 0.9), p.x, base + h / 2, p.z, 0.07, h, 0.07, 0, rot, 0);
    }
  }
  // 两道横向打包带
  for (const k of [0.32, 0.68]) {
    const p = rotXZ(b.x, b.z, rot, 0, 0);
    kit.box('wood', shade(PALETTE.plankDark, 0.84), p.x, base + h * k, p.z, bw + 0.02, 0.06, bd + 0.02, 0, rot, 0);
  }
  // 箱顶压一块小木条（风化的细节）
  if (rand() < 0.5) {
    kit.box('wood', shade(PALETTE.plankPale, 0.9), b.x + (rand() - 0.5) * bw * 0.4,
      base + h - 0.02, b.z + (rand() - 0.5) * bd * 0.4, bw * 0.5, 0.05, 0.12, 0, rot + 0.4, 0);
  }
}

function addBarrel(kit, b, rand) {
  const base = heightAt(b.x, b.z) - 0.12;
  const h = Math.max(0.4, b.h);
  const r = Math.max(0.2, Math.min(b.w, b.d) / 2 * 0.94);
  const rust = rand() < 0.5;
  const tone = rust ? PALETTE.ironRust : mixHex(PALETTE.iron, PALETTE.metal, 0.4);
  kit.cyl('metal', shade(tone, 0.9 + rand() * 0.16), b.x, base + h / 2, b.z, r, r * 1.02, h, 10);
  // 三道箍
  for (const k of [0.18, 0.5, 0.82]) {
    kit.cyl('metal', shade(PALETTE.metalDark, 0.95), b.x, base + h * k, b.z, r * 1.03, r * 1.03, 0.05, 10);
  }
  // 顶盖
  kit.cyl('metal', shade(tone, 0.8), b.x, base + h - 0.015, b.z, r * 0.92, r * 0.92, 0.04, 10);
}

function addLobsterTrap(kit, b, rand) {
  const base = heightAt(b.x, b.z) - 0.12;
  const rot = b.rot || 0;
  const { bw, bd } = fitBox(b.w, b.d, rot);
  const h = Math.max(0.3, b.h);
  const frame = shade(PALETTE.plankDark, 0.9 + rand() * 0.14);
  // 底框 + 顶框
  for (const y of [0.06, h - 0.05]) {
    kit.box('wood', frame, b.x, base + y, b.z, bw, 0.06, bd, 0, rot, 0);
  }
  // 四角立柱
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const p = rotXZ(b.x, b.z, rot, sx * (bw / 2 - 0.03), sz * (bd / 2 - 0.03));
      kit.box('wood', frame, p.x, base + h / 2, p.z, 0.06, h, 0.06, 0, rot, 0);
    }
  }
  // 侧面木条（间隔排布，像笼子）
  const slats = 4;
  for (let i = 1; i < slats; i++) {
    const t = i / slats;
    for (const sz of [-1, 1]) {
      const p = rotXZ(b.x, b.z, rot, 0, sz * (bd / 2 - 0.02));
      kit.box('wood', shade(frame, 0.96), p.x, base + h * t, p.z, bw, 0.045, 0.04, 0, rot, 0);
    }
    for (const sx of [-1, 1]) {
      const p = rotXZ(b.x, b.z, rot, sx * (bw / 2 - 0.02), 0);
      kit.box('wood', shade(frame, 0.96), p.x, base + h * t, p.z, 0.04, 0.045, bd, 0, rot, 0);
    }
  }
  // 笼内浮球 / 网绳
  kit.box('net', shade(PALETTE.rope, 0.94), b.x, base + h * 0.55, b.z, bw * 0.7, h * 0.5, bd * 0.7, 0, rot, 0);
  kit.box('wood', shade(PALETTE.rope, 1.02), b.x, base + h - 0.06, b.z, 0.3, 0.1, 0.3, 0, rot, 0);
}

function addNetRack(kit, b, rand) {
  const base = heightAt(b.x, b.z) - 0.12;
  const h = Math.max(1.0, b.h);
  // 网架：沿世界 AABB 的长边立两根柱子 + 顶横梁 + 垂下的网
  const alongX = b.w >= b.d;
  const len = alongX ? b.w : b.d;
  const half = len / 2 - 0.1;
  const postR = Math.min(0.09, (alongX ? b.d : b.w) * 0.4);
  for (const sgn of [-1, 1]) {
    const px = b.x + (alongX ? sgn * half : 0);
    const pz = b.z + (alongX ? 0 : sgn * half);
    kit.cyl('wood', shade(PALETTE.plankDark, 0.9 + rand() * 0.14), px, base + h / 2, pz,
      postR, postR * 1.1, h, 6);
  }
  // 顶横梁
  kit.beam('wood', shade(PALETTE.plankDark, 0.86),
    b.x - (alongX ? half : 0), base + h - 0.08, b.z - (alongX ? 0 : half),
    b.x + (alongX ? half : 0), base + h - 0.08, b.z + (alongX ? 0 : half),
    0.09, 0.1);
  // 垂下的渔网（细条网格）
  const netH = Math.min(h * 0.62, 1.0);
  const span = len - 0.3;
  const vs = Math.max(4, Math.round(span / 0.16));
  const hs = Math.max(2, Math.round(netH / 0.24));
  const tone = shade(PALETTE.rope, 0.9 + rand() * 0.12);
  for (let i = 0; i <= vs; i++) {
    const u = -span / 2 + (span * i) / vs;
    const px = b.x + (alongX ? u : 0);
    const pz = b.z + (alongX ? 0 : u);
    kit.box('net', tone, px, base + h - 0.14 - netH / 2, pz,
      alongX ? 0.022 : 0.02, netH, alongX ? 0.02 : 0.022);
  }
  for (let j = 0; j <= hs; j++) {
    const y = base + h - 0.14 - (netH * j) / hs;
    kit.box('net', shade(tone, 0.94), b.x, y, b.z,
      alongX ? span : 0.024, 0.022, alongX ? 0.024 : span);
  }
  // 网架上的浮子
  for (let i = 0; i < 3; i++) {
    const u = -span / 3 + (i * span) / 3;
    kit.torus('wood', shade(PALETTE.cloth, 0.9), b.x + (alongX ? u : 0),
      base + h - 0.2, b.z + (alongX ? 0 : u), 0.1, 0.035, 8, 4, 0, 0, 0);
  }
}

function addBrokenPlank(kit, b, rand) {
  const base = heightAt(b.x, b.z) - 0.12;
  const h = Math.max(0.1, b.h);
  const alongX = b.w >= b.d;
  const len = alongX ? b.w : b.d;
  const wide = alongX ? b.d : b.w;
  // 主破板
  kit.box('wood', shade(PALETTE.plank, 0.86 + rand() * 0.2), b.x, base + h / 2, b.z,
    alongX ? len : wide, h, alongX ? wide : len, 0, 0, 0);
  // 翘起的一角
  const tip = rotXZ(b.x, b.z, 0, alongX ? len * 0.3 : 0, alongX ? 0 : len * 0.3);
  kit.box('wood', shade(PALETTE.plankDark, 0.92), tip.x, base + h + 0.02, tip.z,
    alongX ? len * 0.28 : wide * 0.8, h * 0.7, alongX ? wide * 0.8 : len * 0.28,
    0.12, rand() * 0.4, 0);
  // 钉子 / 锈铁件
  kit.box('metal', PALETTE.metalDark, b.x - (alongX ? len * 0.2 : 0), base + h - 0.015,
    b.z - (alongX ? 0 : len * 0.2), 0.05, 0.04, 0.05);
}

// ================= 礁石 / 海蚀柱 =================
// ROCKS 的碰撞体：w = size*1.7、d = w*0.9、y0 = y - size*0.45、y1 = y + size*0.85。
// 视觉用一块被确定性噪声外推的十二面体（InstancedMesh，1 个 draw call），
// 半径上限 1.08 → 缩放后严格落在碰撞盒里（水平用等向缩放，随便转都不会溢出）。
function createRockField() {
  if (!ROCKS.length) return null;
  const geo = new THREE.DodecahedronGeometry(1, 0);
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const n = valueNoise(x * 1.9 + 11.3, z * 1.9 - 4.7) * 0.5
      + valueNoise(y * 2.3 + 4.1, x * 2.3 + 7.7) * 0.3
      + valueNoise(z * 3.4 - 2.9, y * 3.4 + 1.6) * 0.2;
    const s = 0.9 + n * 0.18;          // 0.9 ~ 1.08（上限用于反算缩放）
    pos.setXYZ(i, x * s, y * s, z * s);
  }
  geo.computeVertexNormals();
  const white = new Float32Array(pos.count * 3).fill(1);
  geo.setAttribute('color', new THREE.BufferAttribute(white, 3));

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.92, metalness: 0.02,
    flatShading: true, dithering: true,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, ROCKS.length);
  mesh.name = 'tidewater:rocks';
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const rand = mulberry32(seedOf('tidewater:rocks'));
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const col = new THREE.Color();
  for (let i = 0; i < ROCKS.length; i++) {
    const r = ROCKS[i];
    const size = Number.isFinite(r.size) ? r.size : 1;
    const baseY = Number.isFinite(r.y) ? r.y : heightAt(r.x, r.z);
    // 碰撞盒：水平半宽 0.85*size、半深 0.765*size；竖直 y-0.45size ~ y+0.85size
    const sH = (0.765 * size) / 1.08;               // 等向水平缩放（旋转安全）
    const sV = (0.65 * size) / 1.08;
    p.set(r.x, baseY + 0.2 * size, r.z);
    e.set((rand() - 0.5) * 0.1, r.rot != null ? r.rot : rand() * Math.PI * 2, (rand() - 0.5) * 0.1);
    q.setFromEuler(e);
    scl.set(sH, sV, sH);
    m.compose(p, q, scl);
    mesh.setMatrixAt(i, m);
    // 海蚀柱偏湿偏深，岛内散石偏灰黄
    const wet = r.kind === 'seastack';
    const g = (wet ? 0.13 : 0.17) + rand() * 0.07;
    col.setRGB(g * (wet ? 0.92 : 1.06), g * (wet ? 0.98 : 1.0), g * (wet ? 1.0 : 0.9));
    mesh.setColorAt(i, col);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return {
    mesh,
    count: ROCKS.length,
    dispose() {
      if (mesh.parent) mesh.parent.remove(mesh);
      mesh.dispose();
      geo.dispose();
      mat.dispose();
    },
  };
}

// ================= 海滩杂物（确定性散布）=================
function addBeachDebris(kit, rand, detail) {
  const half = 150;
  const count = Math.round(46 * detail);
  let placed = 0;
  for (let attempt = 0; attempt < count * 6 && placed < count; attempt++) {
    const x = (rand() * 2 - 1) * 120;
    const z = (rand() * 2 - 1) * 120;
    if (Math.abs(x) > half - 6 || Math.abs(z) > half - 6) continue;
    const h = heightAt(x, z);
    // 只落在海侧沙滩带（+z 是海）：海平面以上 0.1m ~ 3.2m
    if (z < 0) continue;
    if (h < 0.1 || h > 3.2) continue;
    // 避开静态碰撞体
    let blocked = false;
    for (let i = 0; i < COLLIDERS.length; i++) {
      const o = COLLIDERS[i];
      if (o.kind === 'boundary') continue;
      if (Math.abs(x - o.x) < o.w / 2 + 0.7 && Math.abs(z - o.z) < o.d / 2 + 0.7) { blocked = true; break; }
    }
    if (blocked) continue;
    placed++;
    const kind = rand();
    if (kind < 0.42) {
      // 漂流木
      const len = 0.7 + rand() * 1.5;
      kit.box('wood', shade(PALETTE.plankDark, 0.7 + rand() * 0.5), x, h + 0.06, z,
        len, 0.1 + rand() * 0.1, 0.14 + rand() * 0.12,
        (rand() - 0.5) * 0.2, rand() * Math.PI, (rand() - 0.5) * 0.12);
    } else if (kind < 0.66) {
      // 碎船板
      kit.box('wood', shade(PALETTE.plank, 0.72 + rand() * 0.4), x, h + 0.04, z,
        0.9 + rand() * 0.9, 0.06, 0.18 + rand() * 0.1,
        (rand() - 0.5) * 0.14, rand() * Math.PI, 0);
    } else if (kind < 0.84) {
      // 贝壳 / 卵石
      const r = 0.06 + rand() * 0.09;
      kit.cyl('stone', shade(PALETTE.stone, 0.7 + rand() * 0.6), x, h + r * 0.4, z,
        r, r * 1.15, r * 0.8, 5, (rand() - 0.5) * 0.4, rand() * 3, (rand() - 0.5) * 0.4);
    } else {
      // 断缆绳 / 旧浮球
      if (rand() < 0.5) {
        kit.torus('wood', shade(PALETTE.rope, 0.86 + rand() * 0.2), x, h + 0.05, z,
          0.2 + rand() * 0.12, 0.04, 8, 4, Math.PI / 2, 0, 0);
      } else {
        kit.cyl('metal', shade(PALETTE.ironRust, 0.9 + rand() * 0.2), x, h + 0.12, z,
          0.16, 0.16, 0.24, 7);
      }
    }
  }
  return placed;
}

// ================= 对外入口 =================
export function createProps({ preset, anisotropy = 1, extras } = {}) {
  const p = preset || {};
  const X = extras && typeof extras === 'object' ? extras : (MAP_EXTRAS || {});
  const detail = clamp(Number.isFinite(p.props) ? p.props : 1, 0.3, 1.2);
  const kit = createKit();
  const group = new THREE.Group();
  group.name = 'tidewater:props';
  const rand = mulberry32(seedOf('tidewater:props'));
  const counts = { boats: 0, stalls: 0, cover: 0, debris: 0 };

  // ---- 搁浅渔船 ----
  const boats = Array.isArray(X.boats) ? X.boats : [];
  for (const b of boats) {
    if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.z)) continue;
    addBoat(kit, b, rand);
    counts.boats++;
  }

  // ---- 鱼摊遮阳棚 ----
  const stalls = Array.isArray(X.stalls) ? X.stalls : [];
  for (const s of stalls) {
    if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.z)) continue;
    addStall(kit, s, rand, detail);
    counts.stalls++;
  }

  // ---- 掩体道具（DEFENSES；w/d 是世界轴对齐外廓）----
  for (const b of DEFENSES) {
    if (!Number.isFinite(b.x) || !Number.isFinite(b.z)) continue;
    const kind = String(b.kind || 'crate').toLowerCase();
    if (kind === 'barrel') addBarrel(kit, b, rand);
    else if (kind === 'lobster') addLobsterTrap(kit, b, rand);
    else if (kind === 'netrack' || kind === 'net') addNetRack(kit, b, rand);
    else if (kind === 'plank') addBrokenPlank(kit, b, rand);
    else addCrate(kit, b, rand);
    counts.cover++;
  }

  // ---- 海滩杂物 ----
  counts.debris = addBeachDebris(kit, rand, detail);

  // ---- 礁石 / 海蚀柱（ROCKS，与 shared 碰撞体同源）----
  const rocks = createRockField();
  if (rocks) {
    group.add(rocks.mesh);
    counts.rocks = rocks.count;
  }

  // ---- 合并 ----
  const finished = kit.finish(group);
  const raycastTargets = finished.meshes;
  if (rocks) raycastTargets.push(rocks.mesh);

  return {
    group,
    raycastTargets,
    counts,
    update() { /* 静态道具，无逐帧动画 */ },
    setQuality() { /* 细节在建造时按 preset 决定 */ },
    dispose() {
      if (rocks) rocks.dispose();
      finished.dispose();
    },
  };
}
