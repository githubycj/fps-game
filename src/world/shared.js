// ===== 共享世界数据适配层 =====
// 唯一数据源是 shared/world.js（Lead 维护）：地形高度场、布局、碰撞体、物理都由它提供。
// 本文件不做任何地形/布局的复制，只做：
//   1) 统一 re-export，场景模块只依赖这里，避免各处散落 import 路径；
//   2) 少量纯工具函数（clamp / 插值 / 远景色地形轮廓），供程序化装饰使用；
//   3) 对可选导出做兜底（例如缺省某些布局数组时退化为空数组），保证场景在数据版本演进时不崩。
import * as S from '../../shared/world.js';

// ---------- 基础常量 ----------
export const WORLD = S.WORLD;
export const SUN = S.SUN;
export const ROADS = S.ROADS || { mainWidth: 8, crossWidth: 7, plazaRadius: 13 };
export const ZONES = S.ZONES || [];
export const TEAMS = S.TEAMS || ['alpha', 'bravo'];

// ---------- 布局数据 ----------
export const HOUSES = S.HOUSES || [];
export const PYLONS = S.PYLONS || [];
export const TREES = S.TREES || [];
export const FENCES = S.FENCES || [];
export const ROCKS = S.ROCKS || [];
export const CARS = S.CARS || [];
export const DEFENSES = S.DEFENSES || [];
export const BOUNDARY = S.BOUNDARY || [];
export const COLLIDERS = S.COLLIDERS || [];
export const SPAWNS = S.SPAWNS || { alpha: [], bravo: [], all: [] };
export const CRATE_SPOTS = S.CRATE_SPOTS || [];
export const ITEM_SPOTS = S.ITEM_SPOTS || [];
export const WORLD_INFO = S.WORLD_INFO || {};
export const HILLS = (S.WORLD_INFO && S.WORLD_INFO.hills) || [];

// ---------- 共享函数 ----------
export const heightAt = S.heightAt;
export const terrainNormal = S.terrainNormal;
export const surfaceAt = S.surfaceAt;
export const houseWallSegments = S.houseWallSegments;
export const isWalkableAt = S.isWalkableAt;
export const zoneOf = S.zoneOf;
export const valueNoise = S.valueNoise;
export const hash2i = S.hash2i;
export const mulberry32 = S.mulberry32;

// ---------- 通用数学工具 ----------
export function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
export function damp(cur, target, lambda, dt) {
  return lerp(cur, target, 1 - Math.exp(-lambda * dt));
}
// 固定种子的确定性随机（地形装饰用，禁止 Math.random 参与静态布局）
export function rng(seed) { return mulberry32(seed | 0); }

// ---------- 地形辅助 ----------
// 安全采样：shared 未就绪或越界时给出可用的有限值
export function safeHeightAt(x, z) {
  try {
    const h = heightAt(x, z);
    return Number.isFinite(h) ? h : 0;
  } catch (e) {
    return 0;
  }
}

// 坡度：0=平地，1=垂直（用共享 terrainNormal 计算，和物理的 maxSlope 语义一致）
export function slopeAt(x, z) {
  const n = terrainNormal(x, z);
  return clamp(1 - n.y, 0, 1);
}

// 地图外远景地形轮廓。地图内（|x|,|z| <= half）严格等于 heightAt(x,z)，
// 保证与外圈网格在 ±half 处逐位接缝；地图外做缓慢抬升 + 噪声丘陵 + 远山，收住地平线。
export function farHeightAt(x, z) {
  const half = WORLD.half;
  if (Math.abs(x) <= half && Math.abs(z) <= half) return safeHeightAt(x, z);
  // 钳制到 ±half 的精确边界：与外圈网格/内圈网格共享顶点时高度逐位一致，接缝无裂缝
  const cx = clamp(x, -half, half);
  const cz = clamp(z, -half, half);
  const base = safeHeightAt(cx, cz);
  const d = Math.max(0, Math.abs(x) - half, Math.abs(z) - half);
  const t = clamp(d / 150, 0, 1);
  // 远处缓坡抬升 → 地平线上的山丘轮廓
  let h = base + 26 * Math.pow(t, 1.45);
  h += (valueNoise(x * 0.0115 + 5.1, z * 0.0115 - 3.7) * 2 - 1) * 10.5 * smoothstep(0, 55, d);
  h += (valueNoise(x * 0.028 - 7.3, z * 0.028 + 1.9) * 2 - 1) * 2.6 * smoothstep(0, 22, d);
  h += (valueNoise(x * 0.09 + 2.7, z * 0.09 - 5.3) * 2 - 1) * 0.55 * smoothstep(0, 8, d);
  return h;
}

// 是否落在任何“不该长草”的静态碰撞体里（草/杂物散布用，粗判即可）
export function insideStaticBox(x, z, pad = 0) {
  for (let i = 0; i < COLLIDERS.length; i++) {
    const o = COLLIDERS[i];
    if (o.kind === 'boundary') continue;
    const hw = o.w * 0.5 + pad, hd = o.d * 0.5 + pad;
    if (Math.abs(x - o.x) < hw && Math.abs(z - o.z) < hd) return true;
  }
  return false;
}
