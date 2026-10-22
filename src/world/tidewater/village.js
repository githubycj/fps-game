// ===== 潮汐湾 · 渔村：吊脚渔屋 / 船屋 / 杂货铺 / 鱼摊棚 / 工具棚 + 木栈道 + 村广场 =====
// 契约（DESIGN_TIDEWATER_DM.md §5.1）：
//   createVillage({ preset, anisotropy, extras }) -> { group, update?, dispose?, raycastTargets? }
//
// 关键约定：
//   1) 墙体几何完全由 shared 的 houseWallSegments(h) 生成（世界空间 AABB），
//      所以视觉墙 / 门洞 / 窗洞 / 窗下墙 / 过梁与物理碰撞体逐位一致，绝不穿帮。
//   2) 建筑风格由 h.style 决定：stilt（吊脚渔屋）| boathouse（船屋）| chandlery（杂货铺）
//      | fishstand（鱼摊棚，无墙只有顶棚 + 柱子）| shed（工具棚）。未知风格退化为通用木板房。
//   3) 材质语言：风化木板（顶点色抖动 + 竖向压条 + 转角护板）+ 波纹铁皮（立缝脊）+ 茅草（分层草顶）。
//   4) 静态几何按材质分桶合并：wood / iron / thatch / metal / cloth / net / stone，
//      每桶 1 个 draw call（本模块 ≤ 7 个，满足三模块合计 ≤ 80 的预算）。
//   5) 禁止 Math.random：所有抖动都来自 mulberry32 + 固定种子，两次加载逐位一致。
//
// 本文件同时导出几何/材质工具（PALETTE / shade / createKit），供 pier.js、props.js 复用
// —— 写作用域只允许这三个文件，共用工具放在这里，不再新增第 4 个文件。
import * as THREE from 'three';
import {
  HOUSES, FURNITURE, MAP_EXTRAS, heightAt,
  houseWallSegments, seedOf, mulberry32,
} from '../../../shared/active.js';
import { addBoxGeo, addCylGeo, addTorusGeo, pushPainted, mergePainted } from '../geom.js';

const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _col = new THREE.Color();
const _col2 = new THREE.Color();

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ================= 调色板（sRGB 十六进制；顶点色由 three 转到线性空间）=================
export const PALETTE = {
  // 风化木板
  plank: 0x9c8b74,
  plankWarm: 0xa8946f,
  plankCool: 0x8e8a80,
  plankDark: 0x6b5c4a,
  plankPale: 0xb7ac97,
  trim: 0xc3b9a4,
  trimDark: 0x8b8271,
  // 波纹铁皮
  iron: 0x7e888a,
  ironRust: 0x8a6a4e,
  ironDark: 0x5d6668,
  // 茅草
  thatch: 0xb1965f,
  thatchDark: 0x8f7847,
  thatchPale: 0xc4ab77,
  // 五金 / 绳缆 / 帆布
  metal: 0x9aa0a2,
  metalDark: 0x6d7274,
  rope: 0xc2ad83,
  cloth: 0xd9cfae,
  clothRed: 0x8f4a3d,
  // 地面
  stone: 0x9a9182,
  sand: 0xc9b58d,
};

// 颜色乘法（线性空间运算后再转回 sRGB，避免发灰）
export function shade(hex, k) {
  _col.setHex(hex & 0xffffff).multiplyScalar(k);
  return _col.getHex();
}

// 两种颜色按比例混合
export function mixHex(a, b, t) {
  _col.setHex(a & 0xffffff);
  _col2.setHex(b & 0xffffff);
  return _col.lerp(_col2, clamp(t, 0, 1)).getHex();
}

// ================= 材质分桶 =================
// 每个桶最终合并成 1 个 Mesh（1 draw call）。顶点色负责所有颜色差异。
const BUCKET_DEFS = {
  wood: { roughness: 0.93, metalness: 0.02 },
  iron: { roughness: 0.58, metalness: 0.52 },
  thatch: { roughness: 0.99, metalness: 0.0 },
  metal: { roughness: 0.48, metalness: 0.7 },
  cloth: { roughness: 0.95, metalness: 0.0, side: THREE.DoubleSide },
  net: { roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide },
  stone: { roughness: 0.96, metalness: 0.02 },
};
const SOFT_BUCKETS = new Set(['cloth', 'net']);

// 几何拼装工具：box / cyl / torus / beam / push + finish（合并出网格）
export function createKit() {
  const buckets = new Map();
  const listOf = (key) => {
    let list = buckets.get(key);
    if (!list) { list = []; buckets.set(key, list); }
    return list;
  };

  return {
    // 轴对齐/欧拉旋转盒体
    box(key, color, cx, cy, cz, w, h, d, rx = 0, ry = 0, rz = 0) {
      addBoxGeo(listOf(key), color, cx, cy, cz, w, h, d, rx, ry, rz);
    },
    // 圆柱 / 圆台（seg 越大越圆，木柱 6~8 段足够）
    cyl(key, color, cx, cy, cz, rTop, rBottom, h, seg = 7, rx = 0, ry = 0, rz = 0) {
      addCylGeo(listOf(key), color, cx, cy, cz, rTop, rBottom, h, seg, rx, ry, rz);
    },
    torus(key, color, cx, cy, cz, radius, tube, seg = 10, tubeSeg = 6, rx = 0, ry = 0, rz = 0) {
      addTorusGeo(listOf(key), color, cx, cy, cz, radius, tube, seg, tubeSeg, rx, ry, rz);
    },
    // 任意已带世界变换的几何
    push(key, color, geo) {
      pushPainted(listOf(key), geo, color);
    },
    // 两点之间的梁：截面 w × d，长度自动
    beam(key, color, ax, ay, az, bx, by, bz, w, d) {
      const dx = bx - ax, dy = by - ay, dz = bz - az;
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-4) return;
      const geo = new THREE.BoxGeometry(w, len, d);
      _q.setFromUnitVectors(UP, _v.set(dx / len, dy / len, dz / len));
      geo.applyQuaternion(_q);
      geo.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
      pushPainted(listOf(key), geo, color);
    },
    // 合并出网格，返回 raycast 目标与释放函数
    finish(group, { cast = true, receive = true } = {}) {
      const meshes = [];
      const owned = [];
      const created = [];
      for (const [key, list] of buckets) {
        if (!list.length) continue;
        const merged = mergePainted(list);      // 会释放源几何
        if (!merged) continue;
        const def = BUCKET_DEFS[key] || BUCKET_DEFS.wood;
        const mat = new THREE.MeshStandardMaterial({
          color: 0xffffff, vertexColors: true, dithering: true, ...def,
        });
        const mesh = new THREE.Mesh(merged, mat);
        mesh.name = 'tidewater:' + key;
        const soft = SOFT_BUCKETS.has(key);
        mesh.castShadow = cast && !soft;
        mesh.receiveShadow = receive;
        group.add(mesh);
        created.push(mesh);
        owned.push(merged, mat);
        if (!soft) meshes.push(mesh);
      }
      return {
        meshes,
        dispose() {
          for (const mesh of created) {
            if (mesh.parent) mesh.parent.remove(mesh);
          }
          created.length = 0;
          meshes.length = 0;
          for (const d of owned) if (d && d.dispose) d.dispose();
          owned.length = 0;
          if (group.parent) group.parent.remove(group);
        },
      };
    },
  };
}

// ================= 通用小工具 =================
// HOUSES 缺 padH 时按地形补（houseWallSegments 依赖 padH）
function houseWithPad(h) {
  if (Number.isFinite(h.padH)) return h;
  return { ...h, padH: heightAt(h.x, h.z) };
}

function styleOf(h) {
  const s = String(h.style || '').toLowerCase();
  if (s === 'stilt' || s === 'boathouse' || s === 'chandlery' || s === 'fishstand' || s === 'shed') return s;
  return 'plank';   // 旧数据 / 占位数据（white/blue/red/grey/barn）→ 通用木板房
}

function wallTone(style, h) {
  let base = PALETTE.plank;
  if (style === 'boathouse') base = PALETTE.plankCool;
  else if (style === 'chandlery') base = PALETTE.plankWarm;
  else if (style === 'shed') base = PALETTE.plankDark;
  else if (style === 'stilt') base = PALETTE.plank;
  // 数据里给了 color 就轻微带一点，保留地图作者意图但仍是风化木色
  if (Number.isFinite(h.color)) return mixHex(base, h.color, 0.18);
  return base;
}

// 局部（家具/船体）坐标 → 世界坐标，旋转约定与 three 的 rotateY 一致
function rotXZ(cx, cz, rot, lx, lz) {
  const c = Math.cos(rot), s = Math.sin(rot);
  return { x: cx + lx * c + lz * s, z: cz - lx * s + lz * c };
}

// ================= 屋顶 =================
// 双坡屋顶。spec: { x, z, w, d, baseY, rise, overhangX, overhangZ }
// kind: 'iron'（波纹铁皮 + 立缝脊）| 'thatch'（分层茅草 + 草捆屋脊）
function addGableRoof(kit, spec, kind, rand, detail) {
  const x = spec.x, z = spec.z, w = spec.w, d = spec.d;
  const baseY = spec.baseY, rise = Math.max(0.5, spec.rise || 1.8);
  const overhangZ = spec.overhangZ != null ? spec.overhangZ : 0.55;
  const overhangX = spec.overhangX != null ? spec.overhangX : 0.45;
  const halfD = Math.max(0.6, d / 2);
  const run = halfD + overhangZ;
  const eaveDrop = (rise * overhangZ) / halfD;
  const slopeLen = Math.hypot(run, rise + eaveDrop);
  const angle = Math.atan2(rise + eaveDrop, run);
  const thick = kind === 'thatch' ? 0.26 : 0.085;
  const spanX = w + overhangX * 2;

  for (const side of [1, -1]) {
    const midZ = (side * run) / 2;
    const midY = baseY + rise - (rise + eaveDrop) / 2;
    const rx = side * angle;
    const cy = midY + thick * 0.5;      // 板顶面落在坡面上
    // 坡面法线（绕 X 转 rx 后的 +Y）
    const upY = Math.cos(rx), upZ = Math.sin(rx);
    // 沿坡方向的单位向量
    const dnY = -Math.sin(rx), dnZ = Math.cos(rx);

    if (kind === 'thatch') {
      // 三层草片：越靠檐口越厚、越往下压
      const layers = detail < 0.6 ? 2 : 3;
      for (let k = 0; k < layers; k++) {
        const t = layers === 1 ? 0.5 : k / (layers - 1);      // 0=靠屋脊 1=靠檐口
        const off = (t - 0.5) * (slopeLen * 0.42);
        const lx = 0, ly = thick * 0.5 - k * 0.055;
        kit.box('thatch', shade(PALETTE.thatch, 0.9 + rand() * 0.14),
          x + lx * 0, cy + dnY * off + upY * ly, z + midZ + dnZ * off + upZ * ly,
          spanX, thick, slopeLen * 0.66, rx, 0, 0);
      }
      // 檐口垂草：沿檐口排一排长短不一的草束
      const eaveZ = z + side * run;
      const eaveY = baseY - eaveDrop;
      const fringeStep = 0.24 / Math.max(0.6, detail);
      const nf = Math.max(2, Math.floor(spanX / fringeStep));
      for (let i = 0; i < nf; i++) {
        const lx = -spanX / 2 + (i + 0.5) * (spanX / nf);
        const len = 0.22 + rand() * 0.26;
        kit.box('thatch', shade(PALETTE.thatchDark, 0.86 + rand() * 0.2),
          x + lx, eaveY - len * 0.45, eaveZ + side * 0.02, 0.19, len, 0.09,
          side * (0.15 + rand() * 0.1), 0, 0);
      }
    } else {
      // 铁皮板
      kit.box('iron', shade(PALETTE.iron, 0.92 + rand() * 0.12),
        x, cy, z + midZ, spanX, thick, slopeLen, rx, 0, 0);
      // 立缝脊（standing seam）：沿坡向的细脊
      const seamStep = 0.34 / Math.max(0.55, detail);
      const ns = Math.max(2, Math.floor(spanX / seamStep));
      for (let i = 0; i <= ns; i++) {
        const lx = -spanX / 2 + (i * spanX) / ns;
        const tone = rand() < 0.18 ? PALETTE.ironRust : PALETTE.iron;
        const off = thick / 2 + 0.02;
        kit.box('iron', shade(tone, 0.82 + rand() * 0.24),
          x + lx, cy + upY * off, z + midZ + upZ * off,
          0.05, 0.05, slopeLen * 0.99, rx, 0, 0);
      }
      // 檐口收边
      const eaveZ = z + side * run;
      const eaveY = baseY - eaveDrop;
      kit.box('iron', shade(PALETTE.ironDark, 0.95 + rand() * 0.1),
        x, eaveY - 0.03, eaveZ, spanX + 0.06, 0.09, 0.1, 0, 0, 0);
    }
  }

  // ---- 屋脊 ----
  if (kind === 'thatch') {
    // 草捆屋脊：横放圆柱 + 绳箍
    kit.cyl('thatch', shade(PALETTE.thatchPale, 0.96), x, baseY + rise + thick * 0.6, z,
      0.24, 0.26, spanX + 0.12, 7, 0, 0, Math.PI / 2);
    const wraps = Math.max(2, Math.floor(spanX / 1.5));
    for (let i = 0; i <= wraps; i++) {
      const lx = -spanX / 2 + (i * spanX) / wraps;
      kit.box('wood', PALETTE.rope, x + lx, baseY + rise + thick * 0.6, z, 0.07, 0.5, 0.5);
    }
  } else {
    kit.box('iron', shade(PALETTE.ironDark, 0.9), x, baseY + rise + thick + 0.02, z,
      spanX + 0.08, 0.13, 0.36);
    kit.box('iron', shade(PALETTE.iron, 0.86), x, baseY + rise + thick + 0.11, z,
      spanX + 0.02, 0.06, 0.2);
  }
}

// 单坡（披屋）屋顶：工具棚 / 雨棚用。
// spec: { x, z, w, d, baseY, rise, axis: 'x'|'z', down: 1|-1 }
//   axis = 倾斜方向（'x' 表示沿 X 方向排水），down = 往哪一侧压低（+1 / -1）
// 倾斜方向上的斜面长度按 hypot(水平投影, rise) 算，屋脊方向按另一轴铺开，两端各挑 0.45m。
function addLeanToRoof(kit, spec, kind, rand, detail) {
  const { x, z, w, d, baseY } = spec;
  const rise = Math.max(0.3, spec.rise || 0.9);
  const axis = spec.axis === 'x' ? 'x' : 'z';
  const down = spec.down === -1 ? -1 : 1;
  const thick = kind === 'thatch' ? 0.2 : 0.075;
  const overhang = 0.45;
  const key = kind === 'thatch' ? 'thatch' : 'iron';
  const color = kind === 'thatch' ? PALETTE.thatch : PALETTE.iron;
  const runBase = axis === 'x' ? w : d;      // 倾斜方向的水平投影
  const spanBase = axis === 'x' ? d : w;     // 屋脊方向的宽度
  const runLen = Math.hypot(runBase, rise) + overhang * 2;
  const spanLen = spanBase + overhang * 2;
  const angle = Math.atan2(rise, runBase);
  const cy = baseY + rise / 2 + thick * 0.5;
  const rx = axis === 'z' ? down * angle : 0;
  const rz = axis === 'x' ? -down * angle : 0;
  // 板面法线（绕 X / 绕 Z 旋转后的 +Y）
  const upY = Math.cos(angle);
  const upX = axis === 'x' ? -Math.sin(rz) : 0;
  const upZ = axis === 'z' ? Math.sin(rx) : 0;

  if (axis === 'x') {
    kit.box(key, shade(color, 0.92 + rand() * 0.12), x, cy, z, runLen, thick, spanLen, 0, 0, rz);
  } else {
    kit.box(key, shade(color, 0.92 + rand() * 0.12), x, cy, z, spanLen, thick, runLen, rx, 0, 0);
  }
  // 铁皮立缝（沿倾斜方向），茅草就不加
  if (kind !== 'thatch') {
    const step = 0.34 / Math.max(0.55, detail);
    const n = Math.max(2, Math.floor(spanLen / step));
    const off = thick / 2 + 0.018;
    for (let i = 0; i <= n; i++) {
      const t = -spanLen / 2 + (i * spanLen) / n;
      const color2 = shade(rand() < 0.18 ? PALETTE.ironRust : PALETTE.iron, 0.82 + rand() * 0.24);
      if (axis === 'x') {
        kit.box(key, color2, x + upX * off, cy + upY * off, z + t, runLen * 0.99, 0.05, 0.05, 0, 0, rz);
      } else {
        kit.box(key, color2, x + t, cy + upY * off, z + upZ * off, 0.05, 0.05, runLen * 0.99, rx, 0, 0);
      }
    }
  }
}

// ================= 墙体 =================
// 墙体 AABB 直接来自 houseWallSegments（与碰撞体同源），压条只贴墙外侧 5cm
function addWallSegment(kit, h, s, tone, rand, detail) {
  const hgt = Math.max(0.04, s.y1 - s.y0);
  kit.box('wood', shade(tone, 0.93 + rand() * 0.14), s.x, (s.y0 + s.y1) / 2, s.z, s.w, hgt, s.d);
  if (hgt < 0.5 || detail < 0.35) return;
  const alongZ = s.w <= s.d;
  const span = alongZ ? s.d : s.w;
  const dir = (alongZ ? Math.sign(s.x - h.x) : Math.sign(s.z - h.z)) || 1;
  const faceOff = 0.17 + 0.028;
  const step = 0.62 / Math.max(0.55, detail);
  const n = Math.max(1, Math.round(span / step));
  for (let i = 0; i <= n; i++) {
    const t = -span / 2 + (span * i) / n;
    const px = alongZ ? s.x + dir * faceOff : s.x + t;
    const pz = alongZ ? s.z + t : s.z + dir * faceOff;
    kit.box('wood', shade(tone, 0.8 + rand() * 0.16), px, (s.y0 + s.y1) / 2, pz, 0.055, hgt, 0.055);
  }
}

// 山墙填充（三角棱柱，视觉填充；与郊区实现一致地"子弹可穿"）
function addGableFill(kit, h, padH, wallH, roofH, side, color) {
  const t = 0.34;
  const shape = new THREE.Shape();
  shape.moveTo(-h.d / 2, 0);
  shape.lineTo(h.d / 2, 0);
  shape.lineTo(0, roofH);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 1 });
  geo.translate(0, 0, -t / 2);
  geo.rotateY(side > 0 ? Math.PI / 2 : -Math.PI / 2);
  geo.translate(h.x + side * (h.w / 2 - t / 2), padH + wallH, h.z);
  kit.push('wood', color, geo);
}

// 窗：无玻璃洞口 + 窗框 + 窗台 + 两侧敞开的木板窗扇（不侵占净洞口）
function addWindows(kit, h, windows, rand, detail) {
  for (const win of windows) {
    const alongX = win.axis === 'x';
    const nAxis = alongX ? win.dirZ : win.dirX;      // 指向室外
    const wallHalf = win.wallT / 2;
    const face = 0.035;                              // 框子离墙外皮的距离
    const fw = 0.085;                                // 框条宽
    const midY = (win.y0 + win.y1) / 2;
    const frameColor = shade(PALETTE.trim, 0.88 + rand() * 0.18);
    const cx = win.x, cz = win.z;
    if (alongX) {
      const fz = cz + nAxis * (wallHalf + face);
      kit.box('wood', frameColor, cx - (win.w / 2 + fw / 2), midY, fz, fw, win.h + fw * 2, 0.07);
      kit.box('wood', frameColor, cx + (win.w / 2 + fw / 2), midY, fz, fw, win.h + fw * 2, 0.07);
      kit.box('wood', frameColor, cx, win.y1 + fw / 2, fz, win.w + fw * 2, fw, 0.07);
      kit.box('wood', frameColor, cx, win.y0 - fw / 2, fz, win.w + fw * 2, fw, 0.07);
      // 窗台板（挑出 12cm，不伸进净洞口）
      kit.box('wood', shade(PALETTE.trim, 0.78), cx, win.y0 - fw - 0.03, fz + nAxis * 0.08,
        win.w + 0.3, 0.06, 0.26);
      if (detail > 0.45) {
        // 敞开的木板窗扇（贴在洞口两侧，不挡洞口）
        for (const sx of [-1, 1]) {
          kit.box('wood', shade(PALETTE.plankWarm, 0.9 + rand() * 0.16),
            cx + sx * (win.w / 2 + 0.24), midY, fz + nAxis * 0.02, 0.24, win.h, 0.05);
        }
      }
    } else {
      const fx = cx + nAxis * (wallHalf + face);
      kit.box('wood', frameColor, fx, midY, cz - (win.w / 2 + fw / 2), 0.07, win.h + fw * 2, fw);
      kit.box('wood', frameColor, fx, midY, cz + (win.w / 2 + fw / 2), 0.07, win.h + fw * 2, fw);
      kit.box('wood', frameColor, fx, win.y1 + fw / 2, cz, 0.07, fw, win.w + fw * 2);
      kit.box('wood', frameColor, fx, win.y0 - fw / 2, cz, 0.07, fw, win.w + fw * 2);
      kit.box('wood', shade(PALETTE.trim, 0.78), fx + nAxis * 0.08, win.y0 - fw - 0.03, cz,
        0.26, 0.06, win.w + 0.3);
      if (detail > 0.45) {
        for (const sz of [-1, 1]) {
          kit.box('wood', shade(PALETTE.plankWarm, 0.9 + rand() * 0.16),
            fx + nAxis * 0.02, midY, cz + sz * (win.w / 2 + 0.24), 0.05, win.h, 0.24);
        }
      }
    }
  }
}

// 门：门框 + 向外开的门扇（与 door 元数据同源，净洞口不被侵占）
function addDoor(kit, h, door, style, rand) {
  const padH = door.padH;
  const dirX = door.dirX, dirZ = door.dirZ;
  const tanX = -dirZ, tanZ = dirX;
  const faceOff = 0.2;
  const fx = door.x + dirX * faceOff;
  const fz = door.z + dirZ * faceOff;
  const frameColor = shade(PALETTE.trim, 0.84 + rand() * 0.16);
  const leafColor = style === 'boathouse' ? shade(PALETTE.plankCool, 0.92) : shade(PALETTE.plankWarm, 0.94);

  // 门框（左右门柱 + 门楣）
  if (dirZ !== 0) {
    kit.box('wood', frameColor, fx + tanX * (door.w / 2 + 0.1), padH + door.h / 2, fz, 0.2, door.h, 0.28);
    kit.box('wood', frameColor, fx - tanX * (door.w / 2 + 0.1), padH + door.h / 2, fz, 0.2, door.h, 0.28);
    kit.box('wood', frameColor, fx, padH + door.h + 0.1, fz, door.w + 0.4, 0.2, 0.28);
  } else {
    kit.box('wood', frameColor, fx, padH + door.h / 2, fz + tanZ * (door.w / 2 + 0.1), 0.28, door.h, 0.2);
    kit.box('wood', frameColor, fx, padH + door.h / 2, fz - tanZ * (door.w / 2 + 0.1), 0.28, door.h, 0.2);
    kit.box('wood', frameColor, fx, padH + door.h + 0.1, fz, 0.28, 0.2, door.w + 0.4);
  }

  // 门槛 + 门外一步台阶
  if (dirZ !== 0) {
    kit.box('wood', shade(PALETTE.plankDark, 0.9), door.x, padH + 0.04, door.z, door.w + 0.1, 0.08, 0.34);
    kit.box('wood', shade(PALETTE.plankDark, 0.8), door.x, padH - 0.05, door.z + dirZ * 0.42,
      door.w + 0.3, 0.1, 0.4);
  } else {
    kit.box('wood', shade(PALETTE.plankDark, 0.9), door.x, padH + 0.04, door.z, 0.34, 0.08, door.w + 0.1);
    kit.box('wood', shade(PALETTE.plankDark, 0.8), door.x + dirX * 0.42, padH - 0.05, door.z,
      0.4, 0.1, door.w + 0.3);
  }

  // 门扇：以门洞一侧为轴，向外开 ~100°
  const open = style === 'boathouse' ? 2.2 : 1.75;
  const leaves = style === 'boathouse' && door.w > 2.2 ? [1, -1] : [1];
  for (const sgn of leaves) {
    const hingeX = fx + tanX * sgn * (door.w / 2 - 0.04);
    const hingeZ = fz + tanZ * sgn * (door.w / 2 - 0.04);
    const ang = open * sgn;
    const dx = dirX * Math.cos(ang) - dirZ * Math.sin(ang);
    const dz = dirX * Math.sin(ang) + dirZ * Math.cos(ang);
    const leafW = (leaves.length > 1 ? door.w / 2 : door.w) - 0.08;
    const lcx = hingeX + dx * leafW / 2;
    const lcz = hingeZ + dz * leafW / 2;
    const ry = Math.atan2(-dz, dx);
    kit.box('wood', leafColor, lcx, padH + door.h / 2 + 0.02, lcz, leafW, door.h - 0.05, 0.08, 0, ry, 0);
    // 门扇上的横撑 + 把手
    kit.box('wood', shade(PALETTE.plankDark, 0.92), lcx, padH + door.h * 0.22, lcz,
      leafW * 0.86, 0.1, 0.11, 0, ry, 0);
    kit.box('metal', PALETTE.metalDark, lcx + dx * (leafW / 2 - 0.16), padH + 1.02, lcz + dz * (leafW / 2 - 0.16),
      0.06, 0.06, 0.14, 0, ry, 0);
  }
}

// 外廊 / 吊脚平台：楼板 + 托梁 + 裙板 + 廊柱 + 落地支柱
// 关于「吊脚」：渔村房屋全部坐落在完全平整的村落地台上（padH === heightAt），
// 数据里没有竖直空间给架空层，所以支柱用两种方式表达，任何地形都不会穿帮：
//   1) 廊柱：从楼板顶一路顶到屋檐下，是真正承重的柱子（永远可见）；
//   2) 落地支柱：楼板外沿每 ~1.7m 落一根到地形，只有地形低于楼板时才生成。
// 楼板顶面严格 = 室内地面高度（houseFloorTop 附近），玩家不会被"浮空楼板"绊住。
function addVeranda(kit, h, style, roofSpec, door, rand, detail) {
  const padH = h.padH;
  const wallH = h.wallH || 3.0;
  const wallTop = padH + wallH;
  const roofH = h.roofH || 2.2;
  const isStilt = style === 'stilt';
  const isBoat = style === 'boathouse';
  const out = isStilt ? 0.95 : isBoat ? 0.6 : 0.4;
  const deckY = padH + 0.02;
  const w = h.w + out * 2, d = h.d + out * 2;
  const plankTone = shade(PALETTE.plank, 0.9 + rand() * 0.12);

  // ---- 楼板（四条外沿板）----
  for (const sz of [-1, 1]) {
    kit.box('wood', shade(plankTone, 0.94 + rand() * 0.1),
      h.x, deckY - 0.035, h.z + sz * (h.d / 2 + out / 2), w, 0.07, out);
  }
  for (const sx of [-1, 1]) {
    kit.box('wood', shade(plankTone, 0.9 + rand() * 0.1),
      h.x + sx * (h.w / 2 + out / 2), deckY - 0.035, h.z, out, 0.07, h.d);
  }
  // ---- 托梁（外沿一圈，露出梁头）----
  const joistColor = shade(PALETTE.plankDark, 0.94 + rand() * 0.1);
  for (const sz of [-1, 1]) {
    kit.box('wood', joistColor, h.x, deckY - 0.13, h.z + sz * (h.d / 2 + out - 0.06), w, 0.16, 0.13);
  }
  for (const sx of [-1, 1]) {
    kit.box('wood', joistColor, h.x + sx * (h.w / 2 + out - 0.06), deckY - 0.13, h.z, 0.13, 0.16, d);
  }

  // ---- 裙板：只有地形低于楼板时才画，避免埋进地里 ----
  const corners = [
    [h.x - w / 2, h.z - d / 2], [h.x + w / 2, h.z - d / 2],
    [h.x - w / 2, h.z + d / 2], [h.x + w / 2, h.z + d / 2],
  ];
  let maxDrop = 0;
  for (const [px, pz] of corners) maxDrop = Math.max(maxDrop, deckY - heightAt(px, pz));
  if (maxDrop > 0.15) {
    const skirtH = Math.min(0.62, maxDrop + 0.08);
    const skirtColor = shade(PALETTE.plankDark, 0.92 + rand() * 0.12);
    for (const sz of [-1, 1]) {
      kit.box('wood', skirtColor, h.x, deckY - 0.06 - skirtH / 2, h.z + sz * (h.d / 2 + out), w, skirtH, 0.07);
    }
    for (const sx of [-1, 1]) {
      kit.box('wood', skirtColor, h.x + sx * (h.w / 2 + out), deckY - 0.06 - skirtH / 2, h.z, 0.07, skirtH, d);
    }
  }

  // ---- 廊柱 / 落地支柱（吊脚渔屋、船屋才有）----
  if (!isStilt && !isBoat) return;
  if (detail < 0.3) return;
  const halfD0 = Math.max(0.6, h.d / 2);
  const overhangZ = roofSpec && roofSpec.overhangZ != null ? roofSpec.overhangZ : 0.55;
  const run = halfD0 + overhangZ;
  const eaveDrop = (roofH * overhangZ) / halfD0;
  // 屋面下沿高度（u = 距屋脊的水平距离）
  const roofUnder = (u) => wallTop + roofH - (roofH + eaveDrop) * (clamp(u, 0, run) / run) - 0.05;
  const postColor = shade(PALETTE.plankDark, 0.9 + rand() * 0.14);
  const edgeX = h.w / 2 + out - 0.1;
  const edgeZ = h.d / 2 + out - 0.1;
  // 廊柱顶面统一贴到屋面下沿（山墙端角柱同高，不会穿出屋面）
  const postTopY = roofUnder(edgeZ) + 0.02;

  // 沿 ±z 两条长边的廊柱
  const step = 2.2;
  const nx = Math.max(1, Math.round((edgeX * 2) / step));
  for (const sz of [-1, 1]) {
    for (let i = 0; i <= nx; i++) {
      const px = h.x - edgeX + (i * 2 * edgeX) / nx;
      // 门口不立柱
      if (door && Math.sign(door.dirZ || 0) === sz && Math.abs(px - door.x) < door.w / 2 + 0.55) continue;
      const pz = h.z + sz * edgeZ;
      kit.box('wood', postColor, px, (deckY + postTopY) / 2, pz,
        0.14, Math.max(0.2, postTopY - deckY), 0.14);
    }
  }
  // ±x 两端（山墙面）只立角柱
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const px = h.x + sx * edgeX, pz = h.z + sz * edgeZ;
      kit.box('wood', postColor, px, (deckY + postTopY) / 2, pz,
        0.15, Math.max(0.2, postTopY - deckY), 0.15);
    }
  }

  // 落地支柱：地形低于楼板时才生成（换地图 / 垫子变小也不会悬空）
  const groundPosts = [];
  const nz = Math.max(1, Math.round((edgeZ * 2) / 1.9));
  for (let i = 0; i <= nz; i++) {
    const pz = h.z - edgeZ + (i * 2 * edgeZ) / nz;
    groundPosts.push([h.x - edgeX, pz], [h.x + edgeX, pz]);
  }
  for (let i = 1; i < nx; i++) {
    const px = h.x - edgeX + (i * 2 * edgeX) / nx;
    groundPosts.push([px, h.z - edgeZ], [px, h.z + edgeZ]);
  }
  for (const [px, pz] of groundPosts) {
    const g = heightAt(px, pz);
    const top = deckY - 0.14;
    const drop = top - g;
    if (drop < 0.2) continue;
    kit.box('wood', shade(PALETTE.plankDark, 0.86 + rand() * 0.16),
      px, (g - 0.35 + top) / 2, pz, 0.17, drop + 0.35, 0.17);
    // 外侧斜撑（隔一根）
    if (rand() < 0.4 && drop > 0.5) {
      const ox = Math.sign(px - h.x) || 1;
      const oz = Math.sign(pz - h.z) || 1;
      kit.beam('wood', shade(PALETTE.plankDark, 0.8),
        px, g + 0.1, pz, px - ox * 0.8, top - 0.14, pz - oz * 0.8, 0.09, 0.09);
    }
  }

  // 门口台阶：楼板明显高于地形时才做
  const dropDoor = deckY - heightAt(h.x, h.z);
  if (dropDoor > 0.35 && door) {
    const steps = Math.max(1, Math.min(4, Math.round(dropDoor / 0.26)));
    const rise = dropDoor / steps;
    for (let i = 1; i <= steps; i++) {
      const sy = deckY - rise * i;
      kit.box('wood', shade(PALETTE.plankDark, 0.9), h.x, sy - 0.03,
        h.z + Math.sign(door.dirZ || 1) * (h.d / 2 + out + 0.2 + (i - 1) * 0.3),
        Math.min(2.2, Math.max(1.2, door.w + 0.4)), 0.08, 0.32);
    }
  }
}

// ================= 风格附加构件 =================
function addBoathouseExtras(kit, h, door, rand) {
  const padH = h.padH;
  const dirX = door ? door.dirX : 0;
  const dirZ = door ? door.dirZ : 1;
  const dx = door ? door.x : h.x;
  const dz = door ? door.z : h.z + h.d / 2;
  // 吊装横梁 + 滑轮（船屋标志物）
  const beamY = padH + h.wallH + 0.15;
  kit.box('wood', shade(PALETTE.plankDark, 0.9), dx + dirX * 0.9, beamY, dz + dirZ * 0.9,
    dirZ !== 0 ? 0.22 : 2.6, 0.24, dirZ !== 0 ? 2.6 : 0.22);
  kit.cyl('metal', PALETTE.metalDark, dx + dirX * 1.8, beamY - 0.35, dz + dirZ * 1.8, 0.11, 0.11, 0.16, 8, 0, 0, Math.PI / 2);
  kit.box('metal', PALETTE.metalDark, dx + dirX * 1.8, beamY - 0.7, dz + dirZ * 1.8, 0.05, 0.6, 0.05);
  // 滑道：门口向海铺 6m 木板，逐块贴合地形
  for (let i = 0; i < 16; i++) {
    const d0 = 0.6 + i * 0.42;
    const px = dx + dirX * d0, pz = dz + dirZ * d0;
    const g = heightAt(px, pz);
    const slope = heightAt(px + dirX * 0.4, pz + dirZ * 0.4) - g;
    kit.box('wood', shade(PALETTE.plank, 0.86 + rand() * 0.18),
      px, g + 0.04, pz,
      dirZ !== 0 ? Math.min(3.2, h.w * 0.5) : 0.4, 0.07, dirZ !== 0 ? 0.4 : Math.min(3.2, h.w * 0.5),
      dirZ !== 0 ? Math.atan2(slope, 0.4) : 0, 0, dirZ !== 0 ? 0 : -Math.atan2(slope, 0.4));
  }
}

function addChandleryExtras(kit, h, door, rand) {
  if (!door) return;
  const padH = h.padH;
  const dirX = door.dirX, dirZ = door.dirZ;
  const tanX = -dirZ, tanZ = dirX;
  const dx = door.x, dz = door.z;
  const outD = 1.6;
  const ax = dx + dirX * outD, az = dz + dirZ * outD;
  // 雨棚两根柱子 + 斜披铁皮
  for (const sgn of [-1, 1]) {
    const px = ax + tanX * sgn * (door.w / 2 + 0.5);
    const pz = az + tanZ * sgn * (door.w / 2 + 0.5);
    const g = heightAt(px, pz);
    kit.box('wood', shade(PALETTE.plankDark, 0.92), px, (g + padH + 2.3) / 2, pz,
      0.14, padH + 2.3 - g, 0.14);
  }
  addLeanToRoof(kit, {
    x: dx + dirX * (outD / 2 + 0.1), z: dz + dirZ * (outD / 2 + 0.1),
    w: dirX !== 0 ? outD + 0.6 : door.w + 1.6,
    d: dirX !== 0 ? door.w + 1.6 : outD + 0.6,
    baseY: padH + 2.35, rise: 0.5,
    axis: dirX !== 0 ? 'x' : 'z',
    down: dirX !== 0 ? Math.sign(dirX) : Math.sign(dirZ),
  }, 'iron', rand, 1);
  // 招牌（两根吊链 + 木板）
  const sx = dx + dirX * 0.55 + tanX * (door.w / 2 + 0.9);
  const sz = dz + dirZ * 0.55 + tanZ * (door.w / 2 + 0.9);
  const signY = padH + h.wallH - 0.5;
  kit.box('wood', shade(PALETTE.plankWarm, 0.94), sx, signY, sz,
    dirZ !== 0 ? 1.25 : 0.07, 0.5, dirZ !== 0 ? 0.07 : 1.25);
  for (const sgn of [-1, 1]) {
    kit.box('metal', PALETTE.metalDark,
      sx + (dirZ !== 0 ? sgn * 0.45 : 0), signY + 0.36, sz + (dirZ !== 0 ? 0 : sgn * 0.45),
      0.03, 0.24, 0.03);
  }
}

function addShedExtras(kit, h, door, rand) {
  // 修补痕迹：几块颜色不一致的补丁板（必须避开门口，否则会挡住门洞）
  const padH = h.padH;
  for (let i = 0; i < 3; i++) {
    const sideZ = rand() < 0.5 ? -1 : 1;
    let sx = h.x + (rand() - 0.5) * h.w * 0.7;
    // 门口那一面：把补丁推到门洞两侧
    if (door && Math.sign(door.dirZ || 0) === sideZ) {
      const off = door.w / 2 + 0.95;
      sx = door.x + (rand() < 0.5 ? -off : off);
      if (Math.abs(sx - h.x) > h.w / 2 - 0.6) continue;
    }
    const sz = h.z + sideZ * (h.d / 2 + 0.03);
    kit.box('wood', shade(rand() < 0.5 ? PALETTE.plankPale : PALETTE.plankDark, 0.9 + rand() * 0.15),
      sx, padH + 0.5 + rand() * (h.wallH - 1.2), sz, 0.7 + rand() * 0.5, 0.5 + rand() * 0.3, 0.035);
  }
  // 斜撑
  if (door) {
    const px = door.x + door.dirX * 0.35, pz = door.z + door.dirZ * 0.35;
    kit.beam('wood', shade(PALETTE.plankDark, 0.85), px, padH + 0.1, pz, px, padH + 2.0, pz, 0.1, 0.1);
  }
}

// 鱼摊棚（半开放：只有柱子 + 顶棚 + 柜台，无墙）
// 柱子直接用 houseWallSegments 返回的 4 根角柱 AABB（kind === 'house_post'），
// 所以视觉柱 = 碰撞柱，玩家撞上去的位置完全一致。
function buildFishStand(kit, h, wall, rand, detail) {
  const padH = h.padH;
  const postH = h.wallH || 2.6;
  const hw = h.w / 2, hd = h.d / 2;
  const tone = PALETTE.plankWarm;
  const posts = (wall && wall.segments ? wall.segments : []).filter((s) => s.kind === 'house_post');
  if (posts.length) {
    for (const s of posts) {
      kit.box('wood', shade(tone, 0.86 + rand() * 0.16), s.x, (s.y0 + s.y1) / 2, s.z,
        s.w, s.y1 - s.y0, s.d);
      // 柱脚垫石
      kit.box('stone', mixHex(PALETTE.stone, PALETTE.sand, 0.4), s.x, s.y0 + 0.06, s.z,
        s.w + 0.16, 0.12, s.d + 0.16);
    }
  } else {
    // 兜底：数据没给角柱时按四角自建（不与碰撞冲突）
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        kit.box('wood', shade(tone, 0.86 + rand() * 0.16), h.x + sx * (hw - 0.16),
          padH + postH / 2, h.z + sz * (hd - 0.16), 0.32, postH, 0.32);
      }
    }
  }
  // 柱顶横梁（托住顶棚）
  for (const sz of [-1, 1]) {
    kit.box('wood', shade(tone, 0.8), h.x, padH + postH - 0.12, h.z + sz * (hd - 0.16),
      h.w - 0.2, 0.16, 0.14);
  }
  for (const sx of [-1, 1]) {
    kit.box('wood', shade(tone, 0.8), h.x + sx * (hw - 0.16), padH + postH - 0.12, h.z,
      0.14, 0.16, h.d - 0.2);
  }
  // 茅草顶（外扩，压住柱子）
  addGableRoof(kit, {
    x: h.x, z: h.z, w: h.w + 1.1, d: h.d + 1.1,
    baseY: padH + postH, rise: Math.max(0.7, h.roofH || 1.0),
    overhangX: 0.35, overhangZ: 0.35,
  }, 'thatch', rand, detail);
  // 柜台（朝 -z 一侧）+ 台面上的木箱
  kit.box('wood', shade(PALETTE.plank, 0.92), h.x, padH + 0.92, h.z - hd + 0.55,
    h.w - 0.7, 0.1, 0.72);
  kit.box('wood', shade(PALETTE.plankDark, 0.9), h.x, padH + 0.45, h.z - hd + 0.55,
    h.w - 0.8, 0.86, 0.62);
  for (let i = 0; i < 2; i++) {
    const bx = h.x - 0.7 + i * 1.2;
    kit.box('wood', shade(PALETTE.plankPale, 0.9 + rand() * 0.14),
      bx, padH + 1.12, h.z - hd + 0.5, 0.5, 0.3, 0.42);
  }
  // 挂着的渔网（细条网格，无贴图）
  if (detail > 0.5) {
    addNetPanel(kit, {
      x: h.x + hw - 0.24, y: padH + postH - 0.35, z: h.z,
      w: h.d - 0.6, h: 1.15, axis: 'z',
    }, rand);
  }
}

// 一片挂网：竖向 + 横向细条（不用贴图，保持零外部资源）
function addNetPanel(kit, spec, rand) {
  const { x, y, z, w, h, axis } = spec;
  const vs = Math.max(3, Math.round(w / 0.16));
  const hs = Math.max(2, Math.round(h / 0.22));
  const tone = PALETTE.rope;
  for (let i = 0; i <= vs; i++) {
    const u = -w / 2 + (i * w) / vs;
    const px = axis === 'z' ? x : x + u;
    const pz = axis === 'z' ? z + u : z;
    kit.box('net', shade(tone, 0.85 + rand() * 0.2), px, y - h / 2, pz,
      axis === 'z' ? 0.02 : 0.022, h, axis === 'z' ? 0.022 : 0.02);
  }
  for (let j = 0; j <= hs; j++) {
    const v = -h + (j * h) / hs;
    kit.box('net', shade(tone, 0.8 + rand() * 0.2), x, y + v, z,
      axis === 'z' ? 0.026 : w, 0.022, axis === 'z' ? w : 0.026);
  }
}

// ================= 建筑主体 =================
function buildHouse(kit, h, rand, detail) {
  const style = styleOf(h);
  const padH = h.padH;
  const wallH = h.wallH || 3.0;
  const roofH = h.roofH || 2.2;
  const wallTop = padH + wallH;
  const tone = wallTone(style, h);

  // ---- 墙体 / 开口数据（与碰撞体逐位同源；鱼摊棚只返回 4 根角柱）----
  const wall = houseWallSegments(h);
  const { segments, windows, door } = wall;

  // ---- 鱼摊棚：无墙，只有柱子 + 顶棚 ----
  if (style === 'fishstand') {
    buildFishStand(kit, h, wall, rand, detail);
    return;
  }

  for (const s of segments) addWallSegment(kit, h, s, tone, rand, detail);

  // ---- 转角护板 ----
  const cornerColor = shade(PALETTE.plankDark, 0.94 + rand() * 0.12);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      kit.box('wood', cornerColor, h.x + sx * (h.w / 2 - 0.05), (padH - 0.25 + wallTop + 0.08) / 2,
        h.z + sz * (h.d / 2 - 0.05), 0.2, wallH + 0.33, 0.2);
    }
  }
  // ---- 腰线 + 檐口封板 ----
  const beltY = padH + Math.min(0.62, wallH * 0.24);
  const beltColor = shade(PALETTE.plankDark, 0.98);
  kit.box('wood', beltColor, h.x, beltY, h.z - h.d / 2 - 0.045, h.w + 0.3, 0.12, 0.09);
  kit.box('wood', beltColor, h.x, beltY, h.z + h.d / 2 + 0.045, h.w + 0.3, 0.12, 0.09);
  kit.box('wood', beltColor, h.x - h.w / 2 - 0.045, beltY, h.z, 0.09, 0.12, h.d + 0.3);
  kit.box('wood', beltColor, h.x + h.w / 2 + 0.045, beltY, h.z, 0.09, 0.12, h.d + 0.3);
  const eaveColor = shade(PALETTE.trim, 0.92);
  kit.box('wood', eaveColor, h.x, wallTop - 0.1, h.z - h.d / 2 - 0.06, h.w + 0.4, 0.16, 0.12);
  kit.box('wood', eaveColor, h.x, wallTop - 0.1, h.z + h.d / 2 + 0.06, h.w + 0.4, 0.16, 0.12);
  kit.box('wood', eaveColor, h.x - h.w / 2 - 0.06, wallTop - 0.1, h.z, 0.12, 0.16, h.d + 0.4);
  kit.box('wood', eaveColor, h.x + h.w / 2 + 0.06, wallTop - 0.1, h.z, 0.12, 0.16, h.d + 0.4);

  // ---- 室内地板 ----
  kit.box('wood', shade(PALETTE.plankDark, 0.96), h.x, padH + 0.02, h.z,
    Math.max(0.4, h.w - 0.5), 0.06, Math.max(0.4, h.d - 0.5));

  // ---- 山墙填充 ----
  const gableColor = shade(tone, 0.84);
  addGableFill(kit, h, padH, wallH, roofH, 1, gableColor);
  addGableFill(kit, h, padH, wallH, roofH, -1, gableColor);

  // ---- 屋顶 ----
  // 吊脚渔屋 / 船屋有外廊，挑檐要盖住廊柱，所以挑得更大
  const wideEave = style === 'stilt' || style === 'boathouse';
  const roofKind = style === 'chandlery' || style === 'fishstand' ? 'thatch' : 'iron';
  const roofSpec = {
    x: h.x, z: h.z, w: h.w, d: h.d, baseY: wallTop, rise: roofH,
    overhangX: wideEave ? 1.15 : 0.45,
    overhangZ: wideEave ? 1.1 : 0.55,
  };
  if (style === 'shed') {
    // 披屋：朝门口一侧排水
    const leanAxis = door && door.dirX ? 'x' : 'z';
    const leanDown = door ? ((door.dirX || door.dirZ) >= 0 ? 1 : -1) : 1;
    addLeanToRoof(kit, {
      x: h.x, z: h.z, w: h.w, d: h.d, baseY: wallTop, rise: roofH,
      axis: leanAxis, down: leanDown,
    }, 'iron', rand, detail);
  } else {
    addGableRoof(kit, roofSpec, roofKind, rand, detail);
  }

  // ---- 门窗 ----
  addWindows(kit, h, windows, rand, detail);
  if (door) addDoor(kit, h, door, style, rand);

  // ---- 外廊 / 吊脚平台 + 廊柱 / 落地支柱 ----
  addVeranda(kit, h, style, roofSpec, door, rand, detail);

  // ---- 风格附加 ----
  if (style === 'boathouse') addBoathouseExtras(kit, h, door, rand);
  else if (style === 'chandlery') addChandleryExtras(kit, h, door, rand);
  else if (style === 'shed') addShedExtras(kit, h, door, rand);
}

// ================= 家具（FURNITURE：视觉外廓 = 碰撞箱）=================
function addFurniture(kit, f, rand) {
  const w = f.w, d = f.d, top = f.top, hh = f.h;
  const rot = f.rot || 0;
  const y0 = f.y;
  const put = (color, lx, ly, lz, sw, sh, sd) => {
    const p = rotXZ(f.x, f.z, rot, lx, lz);
    kit.box('wood', color, p.x, y0 + ly, p.z, sw, sh, sd, 0, rot, 0);
  };
  const woodMid = shade(PALETTE.plankWarm, 0.95 + rand() * 0.1);
  const woodDark = shade(PALETTE.plankDark, 0.95 + rand() * 0.1);

  if (f.type === 'table') {
    put(woodMid, 0, top - 0.03, 0, w, 0.07, d);
    put(woodDark, 0, top - 0.09, 0, w - 0.1, 0.05, d - 0.1);
    const lx = w / 2 - 0.1, lz = d / 2 - 0.1;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      put(woodDark, sx * lx, (top - 0.07) / 2, sz * lz, 0.08, top - 0.07, 0.08);
    }
  } else if (f.type === 'chair') {
    put(woodMid, 0, top - 0.03, 0, w, 0.06, d);
    const lx = w / 2 - 0.06, lz = d / 2 - 0.06;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      put(woodDark, sx * lx, (top - 0.06) / 2, sz * lz, 0.055, top - 0.06, 0.055);
    }
    for (const sx of [-1, 1]) put(woodDark, sx * lx, (top + hh) / 2, d / 2 - 0.06, 0.055, hh - top, 0.055);
    put(woodMid, 0, hh - 0.06, d / 2 - 0.06, w - 0.04, 0.11, 0.05);
    put(woodMid, 0, top + 0.24, d / 2 - 0.06, w - 0.06, 0.08, 0.045);
  } else if (f.type === 'bed') {
    put(woodDark, 0, 0.14, 0, w - 0.04, 0.28, d - 0.04);
    put(shade(PALETTE.cloth, 0.98), 0, 0.28 + (top - 0.28) / 2, 0, w - 0.18, top - 0.28, d - 0.18);
    put(shade(PALETTE.cloth, 1.06), -(w / 2 - 0.36), top + 0.04, 0, 0.48, 0.08, d - 0.3);
    put(woodMid, -(w / 2 - 0.04), hh / 2, 0, 0.07, hh, d);
    put(woodMid, w / 2 - 0.04, hh * 0.35, 0, 0.07, hh * 0.7, d);
  } else {
    // 柜子 / 箱子
    put(woodMid, 0, (hh - 0.08) / 2, 0, w, hh - 0.08, d);
    put(woodDark, 0, hh - 0.04, 0, w + 0.03, 0.08, d + 0.03);
    put(woodDark, 0, 0.05, 0, w - 0.06, 0.1, d - 0.06);
    put(shade(PALETTE.plankDark, 0.7), 0, (hh - 0.08) / 2, -(d / 2 + 0.005), 0.02, hh - 0.24, 0.012);
    for (const sx of [-1, 1]) put(PALETTE.metalDark, sx * 0.09, hh * 0.56, -(d / 2 + 0.03), 0.03, 0.1, 0.05);
  }
}

// ================= 木栈道 =================
// walk: [{ x1, z1, x2, z2, w, y }]，y = 木板顶面世界高度（已含离地 6cm）
// 段间高差最大约 0.57m（沙滩 → 村广场爬升 5.5m）：如果每段都画成水平板，接缝处会出现
// 半个台阶的穿帮。这里把每段的 y 当成"段中心高度"，在相邻段中心之间做线性插值，
// 于是整条栈道变成连续的缓坡板（俯仰角跟随坡度），板面始终贴着地形 +6cm。
// 先绕本地 X 俯仰、再绕 Y 转到路径方向（用几何自身的 rotateX/rotateY，顺序确定）。
function addSlopedPlank(kit, color, cx, cy, cz, w, thick, depth, pitch, yaw) {
  const g = new THREE.BoxGeometry(w, thick, depth);
  g.rotateX(pitch);
  g.rotateY(yaw);
  g.translate(cx, cy, cz);
  kit.push('wood', color, g);
}

function addBoardwalk(kit, walk, rand, detail) {
  const segs = (Array.isArray(walk) ? walk : []).filter((s) => s
    && Number.isFinite(s.x1) && Number.isFinite(s.z1)
    && Number.isFinite(s.x2) && Number.isFinite(s.z2));
  if (!segs.length) return 0;
  let drawn = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const dx = s.x2 - s.x1, dz = s.z2 - s.z1;
    const len = Math.hypot(dx, dz);
    if (!(len > 0.2)) continue;
    const dirX = dx / len, dirZ = dz / len;
    const nx = dirZ, nz = -dirX;                  // 宽度方向
    const yaw = Math.atan2(dirX, dirZ);           // 局部 +Z 对齐 (dirX, dirZ)
    const w = Math.max(1.2, s.w || 3);
    const yc = Number.isFinite(s.y) ? s.y : heightAt((s.x1 + s.x2) / 2, (s.z1 + s.z2) / 2) + 0.3;
    const prev = segs[i - 1], next = segs[i + 1];
    const prevY = prev && Number.isFinite(prev.y) ? prev.y : yc;
    const nextY = next && Number.isFinite(next.y) ? next.y : yc;
    const yA = (prevY + yc) / 2;                  // 段起点顶面高度
    const yB = (yc + nextY) / 2;                  // 段终点顶面高度
    const pitch = -Math.atan2(yB - yA, len);

    // 桥面板
    const step = 0.19;
    const cnt = Math.max(1, Math.round(len / step));
    const du = len / cnt;
    for (let k = 0; k < cnt; k++) {
      const u = (k + 0.5) * du;
      const t = u / len;
      const px = s.x1 + dirX * u;
      const pz = s.z1 + dirZ * u;
      const py = yA + (yB - yA) * t;
      // 万一插值让板面低于地形，抬到地面之上 2cm（不陷进沙里）
      const top = Math.max(py, heightAt(px, pz) + 0.02);
      addSlopedPlank(kit, shade(PALETTE.plank, 0.84 + rand() * 0.26),
        px, top - 0.028, pz, w - 0.02, 0.055, du * 0.92, pitch, yaw);
    }
    // 纵梁（跟随坡度）
    for (const sgn of [-1, 1]) {
      const off = sgn * (w / 2 - 0.22);
      kit.beam('wood', shade(PALETTE.plankDark, 0.94),
        s.x1 + nx * off, yA - 0.11, s.z1 + nz * off,
        s.x2 + nx * off, yB - 0.11, s.z2 + nz * off, 0.1, 0.17);
    }
    // 边挡板
    for (const sgn of [-1, 1]) {
      const off = sgn * (w / 2 + 0.015);
      kit.beam('wood', shade(PALETTE.plankDark, 0.9),
        s.x1 + nx * off, yA - 0.07, s.z1 + nz * off,
        s.x2 + nx * off, yB - 0.07, s.z2 + nz * off, 0.03, 0.14);
    }
    // 支撑柱（每两段一对，落到地形）
    if (detail > 0.25 && i % 2 === 0) {
      for (const sgn of [-1, 1]) {
        const off = sgn * (w / 2 - 0.22);
        const px = s.x1 + nx * off, pz = s.z1 + nz * off;
        const g = heightAt(px, pz);
        const top = yA - 0.18;
        if (top - g < 0.12) continue;
        kit.box('wood', shade(PALETTE.plankDark, 0.88 + rand() * 0.14),
          px, (g - 0.3 + top) / 2, pz, 0.12, top - g + 0.3, 0.12);
      }
    }
    drawn++;
  }
  return drawn;
}

// ================= 村广场 =================
function plazaSpec(X) {
  const p = X && X.plaza;
  if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) {
    return { x: p.x, z: p.z, r: Number.isFinite(p.r) ? p.r : 10 };
  }
  if (X && X.village && Number.isFinite(X.village.x) && Number.isFinite(X.village.z)) {
    // 渔村地台中心（MAP_EXTRAS.village），广场取地台中心的一小块
    return { x: X.village.x, z: X.village.z, r: 10 };
  }
  if (!HOUSES.length) return null;
  let sx = 0, sz = 0;
  for (const h of HOUSES) { sx += h.x; sz += h.z; }
  return { x: sx / HOUSES.length, z: sz / HOUSES.length, r: 9 };
}

// 广场：贴着地形铺的夯土/石板（顶面只比地面高 3cm，不挡路、不穿帮）
function addPlaza(kit, X, rand, detail) {
  const spec = plazaSpec(X);
  if (!spec) return 0;
  const step = 2.0;
  const tiles = Math.floor(spec.r / step);
  let count = 0;
  for (let ix = -tiles; ix <= tiles; ix++) {
    for (let iz = -tiles; iz <= tiles; iz++) {
      const x = spec.x + ix * step;
      const z = spec.z + iz * step;
      const dist = Math.hypot(x - spec.x, z - spec.z);
      if (dist > spec.r) continue;
      const y = heightAt(x, z);
      const warm = rand();
      const color = warm < 0.22
        ? shade(PALETTE.plank, 0.9 + rand() * 0.16)
        : mixHex(PALETTE.sand, PALETTE.stone, 0.3 + rand() * 0.5);
      kit.box('stone', color, x, y - 0.03, z, step * 0.95, 0.12, step * 0.95, 0, (rand() - 0.5) * 0.04, 0);
      count++;
    }
  }
  // 广场中央的一圈木铺面（集市感）
  if (detail > 0.4) {
    const ringR = Math.min(3.4, spec.r * 0.42);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const x = spec.x + Math.cos(a) * ringR;
      const z = spec.z + Math.sin(a) * ringR;
      kit.box('wood', shade(PALETTE.plank, 0.88 + rand() * 0.2), x, heightAt(x, z) + 0.01, z,
        1.5, 0.06, 0.7, 0, -a, 0);
    }
  }
  return count;
}

// ================= 对外入口 =================
export function createVillage({ preset, anisotropy = 1, extras } = {}) {
  const p = preset || {};
  const X = extras && typeof extras === 'object' ? extras : (MAP_EXTRAS || {});
  const detail = clamp(Number.isFinite(p.props) ? p.props : 1, 0.3, 1.2);
  const kit = createKit();
  const group = new THREE.Group();
  group.name = 'tidewater:village';
  const rand = mulberry32(seedOf('tidewater:village'));
  const counts = { houses: 0, boardwalk: 0, plazaTiles: 0 };

  // ---- 建筑 ----
  for (const raw of HOUSES) {
    const h = houseWithPad(raw);
    if (!(Number.isFinite(h.x) && Number.isFinite(h.z))) continue;
    buildHouse(kit, h, rand, detail);
    counts.houses++;
  }

  // ---- 家具（与 FURNITURE 碰撞箱同源）----
  for (const f of FURNITURE) {
    if (!Number.isFinite(f.x) || !Number.isFinite(f.y) || !Number.isFinite(f.z)) continue;
    addFurniture(kit, f, rand);
  }

  // ---- 木栈道（栈桥桥头 → 沙滩 → 村广场）----
  counts.boardwalk = addBoardwalk(kit, X.boardwalk, rand, detail);

  // ---- 村广场 ----
  counts.plazaTiles = addPlaza(kit, X, rand, detail);

  // ---- 合并 ----
  const finished = kit.finish(group);
  const raycastTargets = finished.meshes;

  return {
    group,
    raycastTargets,
    counts,
    update() { /* 静态建筑，无逐帧动画 */ },
    setQuality() { /* 几何在建造时按 preset 决定细节，运行期不重建 */ },
    dispose: finished.dispose,
  };
}
