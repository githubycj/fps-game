// ===== 潮汐湾（Tidewater）地图数据层 =====
// 浏览器与 Node 服务器共用。所有地形与布局生成必须是确定性纯函数：
// 固定整数哈希噪声 + 固定种子 RNG，禁止 Math.random() 参与，保证客户端预测与服务器权威一致。
//
// 坐标系：x 向东，z 向南，y 向上；1 unit = 1 m；玩家朝向 yaw=0 时看向 -Z。
// 玩家位置 (x, y, z) 中 y 为脚底高度。
// 海平面 y = 0：南侧（+z）是大海，北侧（-z）是岛体、渔村与主脊。
//
// 地形骨架（契约 §3.2）：
//   · 海岸线 shoreZ(x) 在 z ≈ 20~34 之间缓慢起伏（正弦 + valueNoise），东西两端收口
//   · 沙滩带：从水下缓坡到干沙滩（约 5.7°），再逐级抬升成岛体
//   · 村落地台：(28, -62) 半径 46 的完全平整台地，高 8.5m
//   · 西岬角 (-118, -30) 30m / 东岬角 (120, -16) 26m / 北侧主脊 z≈-150 55m（背景）
//   · 海床：z = shoreZ + 20 约 -3m，z = shoreZ + 80 约 -16m
//   · 礁石浅滩：(-78, 58) 半径 58 的浅水区，海床抬到约 -1.2m

import { createWorldPhysics } from './phys.js';

// ============================================================
// 零、确定性工具（与 shared/world.js 同名同义，逐位一致）
// ============================================================

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

// 32 位整数哈希 → [0,1)
export function hash2i(ix, iz) {
  let h = (Math.imul(ix | 0, 374761393) + Math.imul(iz | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// 双线性平滑 value noise
export function valueNoise(x, z) {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const fx = x - x0, fz = z - z0;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2i(x0, z0), b = hash2i(x0 + 1, z0);
  const c = hash2i(x0, z0 + 1), d = hash2i(x0 + 1, z0 + 1);
  const ab = a + (b - a) * ux;
  const cd = c + (d - c) * ux;
  return ab + (cd - ab) * uz;
}

// 固定种子 RNG（mulberry32）：布局生成唯一随机源
export function mulberry32(seed) {
  let a = seed | 0;
  return function rand() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 确定性字符串种子（FNV-1a）：窗户 / 家具布局禁止 Math.random
export function seedOf(str) {
  let s = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { s ^= str.charCodeAt(i); s = Math.imul(s, 0x01000193); }
  return s >>> 0;
}

// ============================================================
// 一、世界常量
// ============================================================

// 玩家/命中盒/移动参数严格沿用郊区那套数值（契约 §3.1），只改地图尺寸。
export const WORLD = {
  size: 320,
  half: 160,
  maxPlayers: 16,

  // 玩家碰撞
  playerRadius: 0.42,
  playerHeight: 1.8,
  crouchHeight: 1.22,
  slideHeight: 0.95,

  // 视点高度
  eyeHeight: 1.64,
  crouchEyeHeight: 1.05,
  slideEyeHeight: 0.82,

  // 移动
  walkSpeed: 5.4,
  sprintSpeed: 8.4,
  crouchSpeed: 2.5,
  gravity: 22,
  jumpSpeed: 6.8,
  maxStep: 0.6,          // 可直接迈上的台阶高度
  maxSlope: 0.9,         // 约 42°：更陡的坡走不上去
  adAdsSpeedMult: 0.55,

  // 体力（冲刺）
  staminaMax: 100,
  sprintDrain: 22,
  staminaRegen: 18,
  staminaRegenDelay: 0.8,
  jumpStaminaCost: 12,
  slideDuration: 0.7,
  slideSpeed: 9.6,
  slideCooldown: 1.2,

  // 战斗
  maxHp: 100,
  respawnTime: 3,
  stateHz: 20,
  shootRange: 200,
  adsSpeedMult: 0.55,

  // 命中盒（站立，y 相对脚底）
  headY: 1.68,
  headR: 0.23,
  bodyBottom: 0.42,
  bodyTop: 1.57,
  bodyR: 0.33,
  legsBottom: 0.1,
  legsTop: 0.92,
  legsR: 0.27,
};

// 光照/大气：午后热带海岸光（契约 §3.6 推荐值）
export const SUN = {
  dir: [-0.30, 0.86, 0.41],      // 指向太阳的方向（高日照角，近正午偏午后）
  color: 0xfff2dd,               // 偏暖白
  intensity: 3.0,
  hemiSky: 0xbfe0e6,             // 天空偏青蓝
  hemiGround: 0xc9b489,          // 地面反弹：湿沙 + 木板
  hemiIntensity: 1.05,
  fogColor: 0xbcd6dd,            // 海雾淡
  fogNear: 140,
  fogFar: 700,
  exposure: 1.02,
};

// 死亡竞赛不再用据点（契约 §3.6：保留字段避免下游报错）
export const ZONES = [];

// 地图尺寸相关的关键常量（MAP_EXTRAS / WORLD_INFO 也会透出）
export const SEA_LEVEL = 0;
export const VILLAGE = { x: 28, z: -62, r: 46, h: 8.5 };       // 村落地台（完全平整）
export const REEF = { x: -78, z: 58, r: 58, floor: -1.2 };     // 礁石浅滩
// 高度是"叠加量"，实际峰顶 = 岛体基础高度 + 本值 × 内陆掩码，
// 下面三个数已标定到峰顶 ≈ 30m / 26m / 55m（见 scripts/validate-tidewater.mjs）。
export const CAPE_W = { x: -118, z: -30, r: 46, h: 26.5, id: 'west' };  // 西岬角（峰顶 ≈ 30m）
export const CAPE_E = { x: 120, z: -16, r: 42, h: 29.3, id: 'east' };   // 东岬角（峰顶 ≈ 26m）
export const RIDGE = { z: -152, h: 45.7 };                      // 北侧主脊（峰顶 ≈ 55m，背景）

// 长栈桥（地图灵魂 / 狙击位）—— 契约 §3.3
export const PIER = {
  x: 52,
  zStart: 18,
  zEnd: 96,
  deckHeight: 2.8,
  width: 3.4,
  headWidth: 16,
  headDepth: 9,
  railH: 1.05,
};
PIER.halfW = PIER.width / 2;
PIER.headZ0 = PIER.zEnd - PIER.headDepth;    // 87
PIER.headHalfW = PIER.headWidth / 2;

// ============================================================
// 二、海岸线与基础地形
// ============================================================

// 海岸线：z 越大越靠海。范围约 20~34，东西两端收口。
export function shoreZ(x) {
  let z = 27;
  z += 3.6 * Math.sin(x * 0.019 + 0.6);
  z += 2.6 * (valueNoise(x * 0.028 + 3.1, 7.7) * 2 - 1);
  // 东西两端收口：海岸线向北收，岛体在边界附近断开（配合边界沉水）
  z -= 6.0 * smoothstep(118, 158, Math.abs(x));
  return z;
}

// 到海岸线的有符号距离：d > 0 在内陆，d < 0 在海里
function shoreDist(x, z) {
  return shoreZ(x) - z;
}

// 海岸剖面：干沙滩缓坡 → 岛体抬升 / 浅滩 → 海床下沉
function shoreProfile(d) {
  if (d >= 0) {
    const dry = 3.0 * smoothstep(0, 30, d);        // 干沙滩：0 → 3m（约 5.7°）
    const back = 5.5 * smoothstep(30, 112, d);     // 岛体：3 → 8.5m
    const upper = 3.0 * smoothstep(112, 168, d);   // 北侧抬升
    return dry + back + upper;
  }
  const t = -d;
  const shallow = -3.0 * smoothstep(0, 20, t);     // z = shoreZ + 20 → -3m
  const deep = -13.0 * smoothstep(20, 80, t);      // z = shoreZ + 80 → -16m
  const abyss = -3.0 * smoothstep(80, 150, t);     // 外海再降一点，收住地平线
  return shallow + deep + abyss;
}

// 高斯隆起（sigma = r * 0.6，与 shared/world.js 的 HILLS 同构）
function gauss(x, z, cx, cz, r) {
  const dx = x - cx, dz = z - cz;
  const s2 = r * r * 0.36;
  return Math.exp(-(dx * dx + dz * dz) / (2 * s2));
}

// 原始地形（未加平整垫）
function rawHeight(x, z) {
  const d = shoreDist(x, z);
  let h = shoreProfile(d);

  // 岬角只作用在离开海岸线之后的岛体上，避免把沙滩整条抬起来。
  // 掩码过渡带取 46m：既保住沙滩的缓坡，又不会在岸后拉出近垂直的崖壁。
  const inlandMask = smoothstep(12, 58, d);
  h += CAPE_W.h * inlandMask * gauss(x, z, CAPE_W.x, CAPE_W.z, CAPE_W.r);
  h += CAPE_E.h * inlandMask * gauss(x, z, CAPE_E.x, CAPE_E.z, CAPE_E.r);

  // 北侧主脊：背景山体，越靠北越高（玩家被边界挡在前面）
  h += RIDGE.h * smoothstep(-116, -156, z) * (0.82 + 0.18 * valueNoise(x * 0.02 + 5.5, 3.3));

  // 岛体起伏：离开沙滩之后才生效，避免把沙滩搞皱
  const rough = smoothstep(26, 62, d);
  h += rough * (
    1.5 * (valueNoise(x * 0.03 + 11.2, z * 0.03 - 4.4) * 2 - 1) +
    0.6 * (valueNoise(x * 0.09 - 2.6, z * 0.09 + 8.1) * 2 - 1)
  );

  // 礁石浅滩：把海床抬到约 -1.2m，露出若干海蚀柱
  const rd = Math.hypot(x - REEF.x, z - REEF.z);
  if (rd < REEF.r) {
    const w = 1 - smoothstep(REEF.r * 0.55, REEF.r, rd);
    h = lerp(h, REEF.floor, w);
  }

  // 东西边界收口：陆地沉入海里，岛体在地图边缘断开
  h -= 16 * smoothstep(140, 159, Math.abs(x));

  return clamp(h, -110, 110);
}

// ============================================================
// 三、渔村建筑 / 车辆 / 掩体道具
// ============================================================

// 6~8 栋可进入的渔村建筑（契约 §3.3）。
// 全部坐落在村落地台（完全平整 8.5m）上，padH 由地台高度统一给出。
// style 供 scene 侧切换材质/造型：'stilt' | 'boathouse' | 'chandlery' | 'fishstand' | 'shed'
export const HOUSES = [
  {
    id: 'STILT_A', x: -2, z: -44, w: 9, d: 8, wallH: 3.0, roofH: 2.2,
    doorSide: 'south', doorW: 1.6, doorH: 2.15,
    style: 'stilt', color: 0xb9a98c, roof: 'corrugated',
  },
  {
    id: 'STILT_B', x: -10, z: -68, w: 9, d: 8, wallH: 3.0, roofH: 2.2,
    doorSide: 'east', doorW: 1.6, doorH: 2.15,
    style: 'stilt', color: 0xc0ae8e, roof: 'corrugated',
  },
  {
    id: 'STILT_C', x: 6, z: -84, w: 8, d: 7, wallH: 3.0, roofH: 2.1,
    doorSide: 'south', doorW: 1.5, doorH: 2.1,
    style: 'stilt', color: 0xb2a488, roof: 'corrugated',
  },
  {
    id: 'BOATHOUSE', x: 46, z: -46, w: 14, d: 11, wallH: 4.0, roofH: 2.8,
    doorSide: 'south', doorW: 3.6, doorH: 3.4,
    style: 'boathouse', color: 0x8d7f6b, roof: 'corrugated',
  },
  {
    id: 'CHANDLERY', x: 16, z: -60, w: 11, d: 9, wallH: 3.2, roofH: 2.4,
    doorSide: 'west', doorW: 1.7, doorH: 2.2,
    style: 'chandlery', color: 0xc7b493, roof: 'thatch',
  },
  {
    id: 'FISHSTAND', x: 40, z: -76, w: 8, d: 6, wallH: 2.6, roofH: 1.6,
    doorSide: 'none', doorW: 0, doorH: 0,
    style: 'fishstand', color: 0xa89678, roof: 'thatch',
  },
  {
    id: 'SHED', x: 10, z: -98, w: 6, d: 5, wallH: 2.4, roofH: 1.6,
    doorSide: 'south', doorW: 1.3, doorH: 2.05,
    style: 'shed', color: 0x9e9382, roof: 'corrugated',
  },
];

// 渔村不需要输电塔（契约 §3.6：返回 []）
export const PYLONS = [];

// 2 辆废弃皮卡（可选，作为村口掩体）。padH 在地台高度之上补齐。
export const CARS = [
  { id: 'PICKUP1', x: -4, z: -36, rot: 0.18, color: 0x6f7b78 },
  { id: 'PICKUP2', x: 36, z: -28, rot: Math.PI / 2 + 0.12, color: 0x8a6a52 },
];

// 掩体道具（木箱 / 油桶 / 龙虾笼 / 渔网架 / 破船板）。
// 结构沿用 DEFENSES 的 {x,z,w,d,h,rot,kind}；w/d 是**世界轴对齐外廓**，
// scene 侧可直接按 rot 旋转模型。PROPS 是同一份数据的别名（更好读）。
export const DEFENSES = [
  // ---- 村广场 / 渔村巷道 ----
  { x: 24, z: -46, w: 1.1, d: 1.1, h: 1.0, rot: 0.28, kind: 'crate' },
  { x: 22.2, z: -44.4, w: 1.1, d: 1.1, h: 1.0, rot: -0.16, kind: 'crate' },
  { x: 33, z: -64, w: 0.78, d: 0.78, h: 1.05, rot: 0, kind: 'barrel' },
  { x: 34.6, z: -65.4, w: 0.78, d: 0.78, h: 1.05, rot: 0, kind: 'barrel' },
  { x: 30, z: -68, w: 1.3, d: 0.9, h: 0.6, rot: 0.5, kind: 'lobster' },
  { x: 20, z: -52, w: 2.6, d: 0.5, h: 1.5, rot: 0, kind: 'netrack' },
  { x: 12, z: -52, w: 0.5, d: 2.6, h: 1.5, rot: 0, kind: 'netrack' },
  { x: 8, z: -58, w: 1.1, d: 1.1, h: 1.0, rot: 0.62, kind: 'crate' },
  { x: -2, z: -60, w: 0.78, d: 0.78, h: 1.05, rot: 0, kind: 'barrel' },
  { x: 0, z: -76, w: 1.3, d: 0.9, h: 0.6, rot: -0.35, kind: 'lobster' },
  { x: 14, z: -80, w: 3.0, d: 0.35, h: 0.25, rot: 0.22, kind: 'plank' },
  { x: 42, z: -60, w: 1.1, d: 1.1, h: 1.0, rot: 0.9, kind: 'crate' },
  { x: 44, z: -64, w: 0.78, d: 0.78, h: 1.05, rot: 0, kind: 'barrel' },
  { x: 36, z: -44, w: 1.3, d: 0.9, h: 0.6, rot: 0.15, kind: 'lobster' },
  { x: 18, z: -68, w: 1.1, d: 1.1, h: 1.0, rot: -0.4, kind: 'crate' },
  { x: 26, z: -72, w: 0.78, d: 0.78, h: 1.05, rot: 0, kind: 'barrel' },
  { x: 32, z: -82, w: 2.6, d: 0.5, h: 1.5, rot: Math.PI / 2, kind: 'netrack' },
  { x: 4, z: -90, w: 3.0, d: 0.35, h: 0.25, rot: -0.5, kind: 'plank' },
  { x: 2, z: -44, w: 1.1, d: 1.1, h: 1.0, rot: 0.05, kind: 'crate' },
  { x: 12, z: -36, w: 3.0, d: 0.35, h: 0.25, rot: 0.75, kind: 'plank' },
  // ---- 沙滩 / 栈桥桥头 ----
  { x: 72, z: 6, w: 1.1, d: 1.1, h: 1.0, rot: 0.35, kind: 'crate' },
  { x: 40, z: 6, w: 0.78, d: 0.78, h: 1.05, rot: 0, kind: 'barrel' },
  { x: 76, z: -6, w: 1.3, d: 0.9, h: 0.6, rot: -0.2, kind: 'lobster' },
  { x: 68, z: 16, w: 2.6, d: 0.5, h: 1.5, rot: 0.1, kind: 'netrack' },
  { x: 44, z: 16, w: 3.0, d: 0.35, h: 0.25, rot: 1.1, kind: 'plank' },
  { x: 80, z: 4, w: 1.1, d: 1.1, h: 1.0, rot: -0.6, kind: 'crate' },
  { x: 36, z: 14, w: 0.78, d: 0.78, h: 1.05, rot: 0, kind: 'barrel' },
  { x: 70, z: -14, w: 1.1, d: 1.1, h: 1.0, rot: 0.8, kind: 'crate' },
  { x: 42, z: -2, w: 1.3, d: 0.9, h: 0.6, rot: 0.3, kind: 'lobster' },
  { x: 84, z: -12, w: 3.0, d: 0.35, h: 0.25, rot: -0.9, kind: 'plank' },
];

export const PROPS = DEFENSES;

// 木栅栏：渔村不需要（避免不可见碰撞体），保留空数组。
export const FENCES = [];

// 道路/广场尺度（小地图与地形着色用）
export const ROADS = {
  mainWidth: 6,
  crossWidth: 6,
  plazaRadius: 17,
  centerX: VILLAGE.x,
  centerZ: VILLAGE.z,
};

// 鱼摊遮阳棚（MAP_EXTRAS.stalls）
export const STALLS = [
  { x: 24, z: -50, rot: 0, w: 5.0, d: 3.2, h: 2.6 },
  { x: 34, z: -56, rot: Math.PI / 2, w: 4.2, d: 2.8, h: 2.5 },
  { x: 40, z: -68, rot: 0.2, w: 4.6, d: 3.0, h: 2.5 },
];

// 小码头（东侧）+ 2 艘搁浅渔船（契约 §3.3）
export const DOCKS = [
  { x: 96, z: 30, rot: 0, w: 7, d: 5, y: 0.9 },
];

export const BOATS = [
  { x: 99.5, z: 35.5, rot: 0.42, len: 9.0, beam: 3.2, hullY: 0.15, tilt: 0.12 },
  { x: 90.5, z: 40.5, rot: -0.55, len: 7.5, beam: 2.8, hullY: -0.05, tilt: -0.18 },
];

// ============================================================
// 四、出生点（4 队，契约 §3.4）
// ============================================================

// 四个小队的落点（互相 ≥ 70m），每队 6 个出生点环绕在半径 ≤ 11m 的平坦出生垫上。
export const SQUAD_BASES = {
  alpha: { x: -96, z: 8 },        // 西南沙滩
  bravo: { x: 84, z: -6 },        // 东南栈桥侧
  charlie: { x: -104, z: -84 },   // 西北岬角下
  delta: { x: 116, z: -100 },     // 东北高地
};

const SPAWN_RING = [
  [0, 0], [8.5, -6], [-8, -6.5], [6.5, 7.5], [-8.5, 5.5], [0.5, 10],
];

export const SPAWNS = {};
for (const id of Object.keys(SQUAD_BASES)) {
  const b = SQUAD_BASES[id];
  SPAWNS[id] = SPAWN_RING.map(([dx, dz]) => ({ x: b.x + dx, z: b.z + dz }));
}
SPAWNS.all = [];
for (const id of Object.keys(SQUAD_BASES)) SPAWNS.all.push(...SPAWNS[id]);

function nearSpawn(x, z, extra = 3) {
  for (const s of SPAWNS.all) {
    if ((s.x - x) ** 2 + (s.z - z) ** 2 < extra * extra) return true;
  }
  return false;
}

// ============================================================
// 五、平整垫 + 高度场（1.25m 网格 + 双线性插值）
// ============================================================

const PADS = [];
function addPad(x, z, r, blend, h) {
  PADS.push({ x, z, r, blend, h });
}

// 出生垫：让 4 个出生区完全平整（契约要求出生点全部可走）。
// 过渡带取 20m：出生区附近即使地形起伏较大，也不会被切出一道陡坎。
for (const id of Object.keys(SQUAD_BASES)) {
  const b = SQUAD_BASES[id];
  addPad(b.x, b.z, 12, 20, rawHeight(b.x, b.z));
}
// 桥头地形垫：把沙滩在栈桥根部抬到桥面高度（deckHeight）。
// 这是**必须**的：共享物理的 resolveColliders 不支持水平跨台阶
// （feet < y1 - 0.02 就会被当墙推开），所以桥面不能靠台阶接上沙滩，
// 只能让地形本身与桥面齐平，玩家才能直接走上去。
addPad(PIER.x, PIER.zStart - 2, 8, 12, PIER.deckHeight);
// 码头同理：东侧小码头的桥面高 0.9m，让沙滩在码头根部抬到 0.9m 才能直接走上去。
addPad(DOCKS[0].x, DOCKS[0].z - DOCKS[0].d / 2 - 1, 6, 10, DOCKS[0].y);
// 房屋垫：室内地面必须严格等于 houseWallSegments 的 y0
for (const h of HOUSES) h.padH = VILLAGE.h;
for (const h of HOUSES) addPad(h.x, h.z, Math.hypot(h.w, h.d) * 0.5 + 2.0, 5.0, h.padH);
// 车辆
for (const c of CARS) { c.padH = VILLAGE.h; addPad(c.x, c.z, 4.2, 3.0, c.padH); }
// 村落地台（最后应用，最高优先级 → 绝对平整）
addPad(VILLAGE.x, VILLAGE.z, VILLAGE.r, 26, VILLAGE.h);

function baseHeight(x, z) {
  let h = rawHeight(x, z);
  for (let i = 0; i < PADS.length; i++) {
    const p = PADS[i];
    const dx = x - p.x, dz = z - p.z;
    const d = Math.hypot(dx, dz);
    if (d >= p.r + p.blend) continue;
    const w = d <= p.r ? 1 : 1 - smoothstep(p.r, p.r + p.blend, d);
    h += (p.h - h) * w;
  }
  return clamp(h, -110, 110);
}

// 1.25m 高度采样网格（257×257），heightAt 双线性插值
const HF_RES = 256;
const HF_N = HF_RES + 1;
const HF_CELL = WORLD.size / HF_RES;    // 1.25m
const HF = new Float32Array(HF_N * HF_N);
for (let j = 0; j < HF_N; j++) {
  const z = -WORLD.half + j * HF_CELL;
  for (let i = 0; i < HF_N; i++) {
    const x = -WORLD.half + i * HF_CELL;
    HF[j * HF_N + i] = baseHeight(x, z);
  }
}

export function heightAt(x, z) {
  const fx = (x + WORLD.half) / HF_CELL;
  const fz = (z + WORLD.half) / HF_CELL;
  let i = Math.floor(fx), j = Math.floor(fz);
  let tx = fx - i, tz = fz - j;
  if (i < 0) { i = 0; tx = 0; } else if (i > HF_RES - 1) { i = HF_RES - 1; tx = 1; }
  if (j < 0) { j = 0; tz = 0; } else if (j > HF_RES - 1) { j = HF_RES - 1; tz = 1; }
  const k = j * HF_N + i;
  const h00 = HF[k], h10 = HF[k + 1], h01 = HF[k + HF_N], h11 = HF[k + HF_N + 1];
  const a = h00 + (h10 - h00) * tx;
  const b = h01 + (h11 - h01) * tx;
  return a + (b - a) * tz;
}

export function terrainNormal(x, z) {
  const e = 0.6;
  const dx = heightAt(x + e, z) - heightAt(x - e, z);
  const dz = heightAt(x, z + e) - heightAt(x, z - e);
  const len = Math.hypot(dx, 2 * e, dz);
  return { x: -dx / len, y: (2 * e) / len, z: -dz / len };
}

// 栈桥 / 木栈道的水平覆盖范围（表面材质与脚步声用）
function onPierDeck(x, z) {
  if (Math.abs(x - PIER.x) <= PIER.halfW + 0.2 && z >= PIER.zStart - 0.2 && z <= PIER.zEnd + 0.2) return true;
  if (Math.abs(x - PIER.x) <= PIER.headHalfW + 0.2 && z >= PIER.headZ0 - 0.2 && z <= PIER.zEnd + 0.2) return true;
  return false;
}

// 表面类型：湿沙 / 干沙 / 草地 / 岩石 / 木栈桥 / 水下海床
export function surfaceAt(x, z) {
  if (onPierDeck(x, z)) return 'wood';
  const d = shoreDist(x, z);
  const h = heightAt(x, z);
  if (h < -0.15) return 'water';                        // 水下海床（沙泥）
  if (d > -8 && d < 34 && h < 3.6) return 'sand';       // 沙滩带（含湿沙）
  if (Math.hypot(x - VILLAGE.x, z - VILLAGE.z) < ROADS.plazaRadius) return 'dirt';  // 村广场夯土
  if (h > 22) return 'rock';                            // 岬角 / 主脊裸岩
  return 'grass';
}

// ============================================================
// 六、栈桥 / 木栈道 / 码头 / 海蚀柱
// ============================================================

// 桥头坡道：从沙滩逐级抬到桥面（每级 ≤ 0.42m，保证 WORLD.maxStep 可上）
const RAMP_STEPS = 4;
const RAMP_Z0 = 12;
const RAMP_Z1 = PIER.zStart;             // 18
const rampBaseY = Math.min(heightAt(PIER.x, RAMP_Z0), heightAt(PIER.x, RAMP_Z1));
const rampRise = Math.max(0, PIER.deckHeight - rampBaseY);
const rampStepH = Math.min(0.42, rampRise / RAMP_STEPS);
// 桥头地形垫（见上）生效后，沙滩已经与桥面齐平，通常不需要台阶：
// steps === 0 表示"平地接桥"，scene 侧直接从 z0 起接着铺桥面板即可。
const PIER_RAMP = {
  x: PIER.x,
  z0: RAMP_Z0,
  z1: RAMP_Z1,
  width: PIER.width,
  steps: rampStepH > 0.02 ? RAMP_STEPS : 0,
  y0: rampStepH > 0.02 ? rampBaseY : PIER.deckHeight,
  y1: PIER.deckHeight,
  stepH: rampStepH > 0.02 ? rampStepH : 0,
};

// 从沙滩上到村广场的木栈道（贴着地形走，不额外加碰撞体，靠地形坡度可走）
// 起点接在栈桥桥头（桥面高度 2.8），一路爬上村广场
const BOARDWALK_PATH = [
  { x: 52, z: 16 },
  { x: 57, z: 15 },
  { x: 62, z: 14 },
  { x: 57, z: 2 },
  { x: 50, z: -12 },
  { x: 43, z: -26 },
  { x: 36, z: -38 },
  { x: 32, z: -48 },
  { x: 31, z: -54 },
];

// 沿折线按弧长重采样成 ~4m 的小段：段间接缝只有 ~0.3m 高差，
// 视觉上是一条贴着地形爬升的木栈道，而不是一段一段的大台阶。
const BOARDWALK_SEG = 2.0;
export const BOARDWALK = [];
for (let i = 0; i < BOARDWALK_PATH.length - 1; i++) {
  const a = BOARDWALK_PATH[i], b = BOARDWALK_PATH[i + 1];
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const n = Math.max(1, Math.round(len / BOARDWALK_SEG));
  for (let k = 0; k < n; k++) {
    const t0 = k / n, t1 = (k + 1) / n;
    const x1 = a.x + (b.x - a.x) * t0, z1 = a.z + (b.z - a.z) * t0;
    const x2 = a.x + (b.x - a.x) * t1, z2 = a.z + (b.z - a.z) * t1;
    BOARDWALK.push({
      x1, z1, x2, z2,
      w: 3.0,
      y: heightAt((x1 + x2) / 2, (z1 + z2) / 2) + 0.06,
    });
  }
}

// 海蚀柱（礁石浅滩上的礁石，部分可跳上）
// 第 1 块是礁石武器箱的宿主：刻意放在浅滩靠岸的一侧，
// 顶面约 1.9m、紧贴可站立的沙滩（1.05m），玩家跳一下就能上去拿枪。
// （共享物理的 resolveColliders 不支持水平跨台阶，所以"能上去"必须靠跳跃，
//   跳高 1.05m，因此宿主礁石顶面不能超过相邻地面 +1.05m。）
export const SEA_STACKS = [
  { x: -70, z: 12, size: 1.45, seed: 0.11 },  // 礁石武器箱宿主（顶面 ≈ 1.9m，可跳上）
  { x: -78, z: 52, size: 2.4, seed: 0.27 },
  { x: -64, z: 66, size: 1.8, seed: 0.42 },
  { x: -92, z: 68, size: 2.0, seed: 0.58 },
  { x: -86, z: 44, size: 1.5, seed: 0.63 },
  { x: -58, z: 44, size: 1.3, seed: 0.71 },
  { x: -102, z: 54, size: 1.9, seed: 0.84 },
  { x: -70, z: 80, size: 2.2, seed: 0.95 },
];

// ============================================================
// 七、植被 / 礁石（固定种子，客户端与服务器一致）
// ============================================================

function distToHouse(x, z, extra = 0) {
  for (const h of HOUSES) {
    const hw = h.w / 2 + extra, hd = h.d / 2 + extra;
    if (Math.abs(x - h.x) < hw && Math.abs(z - h.z) < hd) return 0;
    const dx = Math.max(Math.abs(x - h.x) - hw, 0);
    const dz = Math.max(Math.abs(z - h.z) - hd, 0);
    const d = Math.hypot(dx, dz);
    if (d < 2.5) return d;
  }
  return 999;
}

function distToPier(x, z, extra = 0) {
  const hw = (z > PIER.headZ0 ? PIER.headHalfW : PIER.halfW) + extra;
  if (z < PIER.zStart - extra || z > PIER.zEnd + extra) return 999;
  return Math.max(0, Math.abs(x - PIER.x) - hw);
}

function distToBoardwalk(x, z) {
  let m = 999;
  for (let i = 0; i < BOARDWALK_PATH.length - 1; i++) {
    const a = BOARDWALK_PATH[i], b = BOARDWALK_PATH[i + 1];
    const vx = b.x - a.x, vz = b.z - a.z;
    const wx = x - a.x, wz = z - a.z;
    const L2 = vx * vx + vz * vz;
    const t = L2 > 1e-6 ? clamp((wx * vx + wz * vz) / L2, 0, 1) : 0;
    m = Math.min(m, Math.hypot(x - (a.x + vx * t), z - (a.z + vz * t)));
  }
  return m;
}

function distToProps(x, z) {
  let m = 999;
  for (const p of DEFENSES) {
    m = Math.min(m, Math.max(0, Math.hypot(x - p.x, z - p.z) - Math.max(p.w, p.d) * 0.5));
  }
  for (const s of STALLS) m = Math.min(m, Math.max(0, Math.hypot(x - s.x, z - s.z) - Math.max(s.w, s.d) * 0.5));
  for (const d of DOCKS) m = Math.min(m, Math.max(0, Math.hypot(x - d.x, z - d.z) - Math.max(d.w, d.d) * 0.5));
  for (const b of BOATS) m = Math.min(m, Math.max(0, Math.hypot(x - b.x, z - b.z) - b.len * 0.5));
  return m;
}

// TREES：棕榈 40 / 阔叶 20 / 灌木 40 / 沙丘草（视觉，无碰撞）
export const TREES = [];
{
  const rand = mulberry32(20261022);
  let guard = 0;

  // ---- 棕榈：沙滩与渔村边缘 ----
  while (TREES.filter((t) => t.type === 'palm').length < 40 && guard++ < 20000) {
    const x = (rand() * 2 - 1) * 150;
    const z = (rand() * 2 - 1) * 60;
    const d = shoreDist(x, z);
    const h = heightAt(x, z);
    if (h < 0.55 || h > 9.5) continue;
    if (d < -12 || d > 96) continue;
    if (distToHouse(x, z, 3.5) !== 999) continue;
    if (distToPier(x, z, 4) < 1) continue;
    if (distToBoardwalk(x, z) < 4.5) continue;
    if (distToProps(x, z) < 2.5) continue;
    if (nearSpawn(x, z, 6)) continue;
    let bad = false;
    for (const t of TREES) if ((t.x - x) ** 2 + (t.z - z) ** 2 < 30) { bad = true; break; }
    if (bad) continue;
    TREES.push({
      x, z, type: 'palm',
      scale: 0.85 + rand() * 0.6,
      rot: rand() * Math.PI * 2,
      lean: (rand() * 2 - 1) * 0.22,
      y: heightAt(x, z),
    });
  }

  // ---- 阔叶树：内陆高地 ----
  guard = 0;
  while (TREES.filter((t) => t.type === 'broadleaf').length < 20 && guard++ < 20000) {
    const x = (rand() * 2 - 1) * 150;
    const z = (rand() * 2 - 1) * 150;
    const h = heightAt(x, z);
    if (h < 5.5 || h > 34) continue;
    if (Math.hypot(x - VILLAGE.x, z - VILLAGE.z) < VILLAGE.r + 6) continue;
    if (distToHouse(x, z, 3.5) !== 999) continue;
    if (distToPier(x, z, 5) < 1) continue;
    if (distToBoardwalk(x, z) < 5) continue;
    if (nearSpawn(x, z, 7)) continue;
    let bad = false;
    for (const t of TREES) if ((t.x - x) ** 2 + (t.z - z) ** 2 < 42) { bad = true; break; }
    if (bad) continue;
    TREES.push({
      x, z, type: 'broadleaf',
      scale: 0.85 + rand() * 0.65,
      rot: rand() * Math.PI * 2,
      y: h,
    });
  }

  // ---- 灌木 ----
  guard = 0;
  while (TREES.filter((t) => t.type === 'bush').length < 40 && guard++ < 20000) {
    const x = (rand() * 2 - 1) * 150;
    const z = (rand() * 2 - 1) * 150;
    const h = heightAt(x, z);
    if (h < 0.7 || h > 40) continue;
    if (distToHouse(x, z, 2.5) !== 999) continue;
    if (distToPier(x, z, 3) < 1) continue;
    if (distToBoardwalk(x, z) < 3.5) continue;
    if (nearSpawn(x, z, 5)) continue;
    let bad = false;
    for (const t of TREES) if ((t.x - x) ** 2 + (t.z - z) ** 2 < 16) { bad = true; break; }
    if (bad) continue;
    TREES.push({
      x, z, type: 'bush',
      scale: 0.7 + rand() * 0.8,
      rot: rand() * Math.PI * 2,
      y: h,
    });
  }

  // ---- 沙丘草（纯视觉，无碰撞）：贴在沙滩上缘 ----
  guard = 0;
  let grass = 0;
  while (grass < 70 && guard++ < 20000) {
    const x = (rand() * 2 - 1) * 152;
    const z = shoreZ(x) - 2 - rand() * 34;
    const h = heightAt(x, z);
    if (h < 0.5 || h > 4.2) continue;
    if (distToPier(x, z, 2) < 1) continue;
    if (distToBoardwalk(x, z) < 2.2) continue;
    if (nearSpawn(x, z, 4)) continue;
    TREES.push({
      x, z, type: 'dunegrass',
      scale: 0.6 + rand() * 0.7,
      rot: rand() * Math.PI * 2,
      y: h,
    });
    grass++;
  }
}

// ROCKS：海蚀柱（礁石浅滩）+ 岛体散石
export const ROCKS = [];
for (const s of SEA_STACKS) {
  ROCKS.push({
    x: s.x, z: s.z, size: s.size, seed: s.seed,
    rot: s.seed * Math.PI * 2,
    y: heightAt(s.x, s.z),
    kind: 'seastack',
  });
}
{
  const rand = mulberry32(77113);
  let guard = 0;
  while (ROCKS.length < 26 && guard++ < 4000) {
    const x = (rand() * 2 - 1) * 148;
    const z = (rand() * 2 - 1) * 148;
    const h = heightAt(x, z);
    if (h < 1.2) continue;
    if (Math.hypot(x - VILLAGE.x, z - VILLAGE.z) < VILLAGE.r + 4) continue;
    if (distToHouse(x, z, 2) !== 999) continue;
    if (distToPier(x, z, 3) < 1) continue;
    if (distToBoardwalk(x, z) < 3) continue;
    if (nearSpawn(x, z, 5)) continue;
    let bad = false;
    for (const r of ROCKS) if ((r.x - x) ** 2 + (r.z - z) ** 2 < 18) { bad = true; break; }
    if (bad) continue;
    ROCKS.push({
      x, z, size: 0.6 + rand() * 1.3,
      rot: rand() * Math.PI * 2, seed: rand(),
      y: h, kind: 'rock',
    });
  }
}

// ============================================================
// 八、房屋开口（门洞 / 无玻璃窗洞）与家具
// ============================================================

// 窗户规格（无玻璃）：洞口本身就是碰撞缺口，子弹/视线可以真的从窗口穿过去，
// 而窗台高约 1.0m，玩家走不进去。渔村窗洞比郊区略小一点。
export const WINDOW_SPEC = {
  sill: 1.0,
  h: 1.15,
  wMin: 1.10,
  wMax: 1.32,
  edge: 0.6,
  longWall: 11,
};

export function houseSides(h) {
  const t = 0.34;
  return [
    { name: 'north', axis: 'x', len: h.w + t, cx: h.x, cz: h.z - h.d / 2, dirX: 0, dirZ: -1 },
    { name: 'south', axis: 'x', len: h.w + t, cx: h.x, cz: h.z + h.d / 2, dirX: 0, dirZ: 1 },
    { name: 'west', axis: 'z', len: h.d + t, cx: h.x - h.w / 2, cz: h.z, dirX: -1, dirZ: 0 },
    { name: 'east', axis: 'z', len: h.d + t, cx: h.x + h.w / 2, cz: h.z, dirX: 1, dirZ: 0 },
  ];
}

// 室内地面顶面（视觉地板：中心 padH+0.02、厚 0.05 → 顶面 padH+0.045）
export function houseFloorTop(h) { return h.padH + 0.045; }

// 单面墙上的窗洞（u = 沿墙方向、相对墙中心的坐标）
function wallWindows(h, s) {
  const spec = WINDOW_SPEC;
  const rand = mulberry32(seedOf(h.id + ':win:' + s.name));
  const half = s.len / 2;
  const usable = s.len - spec.edge * 2;
  if (usable < spec.wMin + 0.2) return [];
  const n = (h.w * h.d >= 110 && s.len >= spec.longWall) ? 2 : 1;
  const out = [];
  if (n === 1) {
    const w = Math.min(spec.wMax, spec.wMin + rand() * (spec.wMax - spec.wMin), usable - 0.7);
    const maxU = half - spec.edge - w / 2;
    const minU = 0.35 + w / 2;
    const sign = rand() < 0.5 ? -1 : 1;
    const u = sign * (maxU > minU ? minU + rand() * (maxU - minU) : Math.max(0, maxU));
    out.push({ u0: u - w / 2, u1: u + w / 2, w });
    return out;
  }
  const gap = 0.5 + rand() * 0.3;
  const maxW = (usable / 2 - gap) * 0.92;
  const w = Math.max(spec.wMin * 0.95, Math.min(spec.wMax, maxW));
  for (const sign of [-1, 1]) {
    const u = sign * (gap + w / 2);
    out.push({ u0: u - w / 2, u1: u + w / 2, w });
  }
  return out;
}

// 生成房屋墙体碰撞（含门洞 / 无玻璃窗洞），视觉建模必须使用同一份数据。
// fishstand（鱼摊棚）是半开放结构：只有四根角柱 + 顶棚，没有墙。
export function houseWallSegments(h) {
  const t = 0.34;
  const y0 = h.padH, y1 = h.padH + h.wallH;
  const floorTop = houseFloorTop(h);
  const segments = [];
  const windows = [];
  const doorW = h.doorW || 1.5, doorH = h.doorH || 2.1;
  const spec = WINDOW_SPEC;
  const push = (cx, cz, sw, sd, sy0, sy1, kind = 'house') => segments.push({
    x: cx, z: cz, w: sw, d: sd, y0: sy0, y1: sy1, kind, material: 'wood', house: h.id,
  });

  // 半开放鱼摊棚：四根角柱，无墙无门
  if (h.style === 'fishstand') {
    const post = 0.32;
    const ox = h.w / 2 - post / 2, oz = h.d / 2 - post / 2;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        push(h.x + sx * ox, h.z + sz * oz, post, post, y0, y1, 'house_post');
      }
    }
    return { segments, windows, door: null, y0, y1, open: true };
  }

  const winY0 = Math.min(floorTop + spec.sill, y1 - spec.h - 0.2);
  const winY1 = winY0 + spec.h;

  let door = null;
  for (const s of houseSides(h)) {
    const half = s.len / 2;
    const hasDoor = h.doorSide === s.name;
    const holes = [];

    if (hasDoor) {
      const dw = Math.min(doorW, s.len - 1.2) / 2;
      const lintelH = Math.min(doorH, h.wallH - 0.3);
      holes.push({ u0: -dw, u1: dw, yb: y0, yt: y0 + lintelH });
      door = {
        side: s.name,
        x: s.cx, z: s.cz,
        w: dw * 2, h: lintelH,
        dirX: s.dirX, dirZ: s.dirZ,
        padH: y0,
      };
    } else {
      for (const w of wallWindows(h, s)) {
        holes.push({ u0: w.u0, u1: w.u1, yb: winY0, yt: winY1 });
        windows.push({
          house: h.id, side: s.name, axis: s.axis,
          x: s.axis === 'x' ? s.cx + (w.u0 + w.u1) / 2 : s.cx,
          z: s.axis === 'x' ? s.cz : s.cz + (w.u0 + w.u1) / 2,
          w: w.w, h: spec.h, y0: winY0, y1: winY1,
          sill: winY0 - floorTop,
          dirX: s.dirX, dirZ: s.dirZ,
          wallCx: s.cx, wallCz: s.cz, wallT: t,
        });
      }
    }

    holes.sort((a, b) => a.u0 - b.u0);
    let cursor = -half;
    const span = (a, b, sy0, sy1) => {
      const len = b - a;
      if (len <= 0.02 || sy1 - sy0 <= 0.02) return;
      const u = (a + b) / 2;
      if (s.axis === 'x') push(s.cx + u, s.cz, len, t, sy0, sy1);
      else push(s.cx, s.cz + u, t, len, sy0, sy1);
    };
    for (const hole of holes) {
      span(cursor, hole.u0, y0, y1);
      span(hole.u0, hole.u1, y0, hole.yb);
      span(hole.u0, hole.u1, hole.yt, y1);
      cursor = hole.u1;
    }
    span(cursor, half, y0, y1);
  }
  return { segments, windows, door, y0, y1 };
}

// ---------- 家具定义：视觉外廓 = 碰撞箱（误差 0） ----------
export const FURNITURE_DEF = {
  table: { w: 1.5, d: 0.95, top: 0.75, h: 0.75 },
  chair: { w: 0.52, d: 0.52, top: 0.45, h: 0.86 },
  crate: { w: 1.1, d: 1.1, top: 1.0, h: 1.0 },
  chest: { w: 1.0, d: 0.55, top: 0.9, h: 0.9 },
};
const FURN_TYPES = ['table', 'chair', 'crate', 'chest'];

export const FURNITURE = [];
for (const h of HOUSES) {
  const { door } = houseWallSegments(h);
  if (h.style === 'fishstand') continue;
  const rand = mulberry32(seedOf(h.id + ':furn'));
  const floorTop = houseFloorTop(h);
  const t = 0.34;
  const innerX = h.w / 2 - t / 2;
  const innerZ = h.d / 2 - t / 2;
  const blocked = [];

  // 门厅净空：门内侧 2m ×（门宽 + 0.9m）不放家具，保证玩家能走进来
  if (door) {
    const cw = door.w + 0.9, cd = 2.0;
    blocked.push({
      x: door.x - door.dirX * (cd / 2 - 0.1),
      z: door.z - door.dirZ * (cd / 2 - 0.1),
      w: door.dirX !== 0 ? cd : cw,
      d: door.dirZ !== 0 ? cd : cw,
    });
  }

  const collides = (x, z, w, d, pad) => blocked.some((o) =>
    Math.abs(x - o.x) < (w + o.w) / 2 + pad && Math.abs(z - o.z) < (d + o.d) / 2 + pad);

  const slots = [];
  for (const s of houseSides(h)) {
    for (const frac of [0.5, 0.3, 0.7]) slots.push({ s, frac });
  }
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = slots[i]; slots[i] = slots[j]; slots[j] = tmp;
  }
  const types = FURN_TYPES.slice();
  for (let i = types.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = types[i]; types[i] = types[j]; types[j] = tmp;
  }

  const want = Math.min(types.length, h.w * h.d < 45 ? 2 : 2 + Math.floor(rand() * 2));

  for (let k = 0; k < want; k++) {
    const type = types[k];
    const def = FURNITURE_DEF[type];
    let spot = null;
    for (const slot of slots) {
      const s = slot.s;
      const rot = Math.atan2(-s.dirX, -s.dirZ);            // 家具正面朝室内
      const c = Math.abs(Math.cos(rot)), sn = Math.abs(Math.sin(rot));
      const fw = c * def.w + sn * def.d;
      const fd = sn * def.w + c * def.d;
      const along = s.axis === 'x' ? fw : fd;
      const depth = s.axis === 'x' ? fd : fw;
      const span = s.len - 0.9 - along;
      if (span < 0.1) continue;
      const u = (slot.frac - 0.5) * span;
      const off = 0.17 + depth / 2 + 0.05;
      const x = s.axis === 'x' ? s.cx + u : s.cx - s.dirX * off;
      const z = s.axis === 'x' ? s.cz - s.dirZ * off : s.cz + u;
      if (Math.abs(x - h.x) + fw / 2 > innerX - 0.02) continue;
      if (Math.abs(z - h.z) + fd / 2 > innerZ - 0.02) continue;
      if (collides(x, z, fw, fd, 0.16)) continue;
      spot = { x, z, rot, fw, fd };
      break;
    }
    if (!spot) continue;
    blocked.push({ x: spot.x, z: spot.z, w: spot.fw, d: spot.fd });
    FURNITURE.push({
      house: h.id, type,
      x: spot.x, z: spot.z, y: floorTop,
      rot: spot.rot,
      w: def.w, d: def.d, top: def.top, h: def.h,
      fw: spot.fw, fd: spot.fd,
    });
  }
}

// ============================================================
// 九、碰撞体（全部实心 AABB，含 y0/y1 竖直范围）
// ============================================================

export const BOUNDARY = [
  { x: 0, z: -(WORLD.half - 2), w: WORLD.size, d: 1.2, y0: -60, y1: 90, kind: 'boundary', material: 'metal' },
  { x: 0, z: (WORLD.half - 2), w: WORLD.size, d: 1.2, y0: -60, y1: 90, kind: 'boundary', material: 'metal' },
  { x: -(WORLD.half - 2), z: 0, w: 1.2, d: WORLD.size, y0: -60, y1: 90, kind: 'boundary', material: 'metal' },
  { x: (WORLD.half - 2), z: 0, w: 1.2, d: WORLD.size, y0: -60, y1: 90, kind: 'boundary', material: 'metal' },
];

export const COLLIDERS = [];

// ---------- 房屋墙（含窗下墙 / 过梁 / 窗间墙垛）----------
for (const h of HOUSES) {
  const { segments } = houseWallSegments(h);
  for (const s of segments) COLLIDERS.push(s);
}

// ---------- 家具 ----------
for (const f of FURNITURE) {
  COLLIDERS.push({
    x: f.x, z: f.z, w: f.fw, d: f.fd,
    y0: f.y, y1: f.y + f.h,
    kind: 'furniture', material: 'wood', house: f.house, furniture: f.type,
  });
}

// ---------- 长栈桥 ----------
{
  const deckT = 0.35;
  const deckY0 = PIER.deckHeight - deckT;
  // 主桥面（z: 18 → 87）
  const runZ0 = PIER.zStart, runZ1 = PIER.headZ0;
  COLLIDERS.push({
    x: PIER.x, z: (runZ0 + runZ1) / 2,
    w: PIER.width, d: runZ1 - runZ0,
    y0: deckY0, y1: PIER.deckHeight,
    kind: 'pier_deck', material: 'wood',
  });
  // 尽头 T 形平台（z: 87 → 96）
  COLLIDERS.push({
    x: PIER.x, z: (PIER.headZ0 + PIER.zEnd) / 2,
    w: PIER.headWidth, d: PIER.headDepth,
    y0: deckY0, y1: PIER.deckHeight,
    kind: 'pier_deck', material: 'wood',
  });

  // 栏杆：1.05m 高，可越 / 可蹲掩（不做成墙体，站立可翻越）
  const railY0 = PIER.deckHeight;
  const railY1 = PIER.deckHeight + PIER.railH;
  const railT = 0.12;
  const pushRail = (cx, cz, w, d) => COLLIDERS.push({
    x: cx, z: cz, w, d, y0: railY0, y1: railY1, kind: 'pier_rail', material: 'wood',
  });
  // 主桥两侧
  const railLen = runZ1 - runZ0;
  pushRail(PIER.x - PIER.halfW, (runZ0 + runZ1) / 2, railT, railLen);
  pushRail(PIER.x + PIER.halfW, (runZ0 + runZ1) / 2, railT, railLen);
  // T 形平台外沿（朝海三面 + 桥头两侧留出主桥接口）
  pushRail(PIER.x, PIER.zEnd, PIER.headWidth, railT);
  pushRail(PIER.x - PIER.headHalfW, (PIER.headZ0 + PIER.zEnd) / 2, railT, PIER.headDepth);
  pushRail(PIER.x + PIER.headHalfW, (PIER.headZ0 + PIER.zEnd) / 2, railT, PIER.headDepth);
  const gap = PIER.halfW + 0.1;
  const sideW = PIER.headHalfW - gap;
  pushRail(PIER.x - gap - sideW / 2, PIER.headZ0, sideW, railT);
  pushRail(PIER.x + gap + sideW / 2, PIER.headZ0, sideW, railT);
}

// ---------- 桥头坡道（逐级台阶）----------
if (rampStepH > 0.02) {
  const dz = (RAMP_Z1 - RAMP_Z0) / RAMP_STEPS;
  for (let i = 0; i < RAMP_STEPS; i++) {
    const z0 = RAMP_Z0 + dz * i;
    COLLIDERS.push({
      x: PIER.x, z: z0 + dz / 2,
      w: PIER.width, d: dz,
      y0: rampBaseY - 0.5, y1: rampBaseY + rampStepH * (i + 1),
      kind: 'pier_ramp', material: 'wood',
    });
  }
} else {
  COLLIDERS.push({
    x: PIER.x, z: (RAMP_Z0 + RAMP_Z1) / 2,
    w: PIER.width, d: RAMP_Z1 - RAMP_Z0,
    y0: PIER.deckHeight - 0.35, y1: PIER.deckHeight,
    kind: 'pier_ramp', material: 'wood',
  });
}

// ---------- 木栈道（贴地木板：只做很薄的视觉层，不挡路）----------
// 地形本身坡度可走，这里不再生成碰撞体（避免把通路堵死）。

// ---------- 码头 + 搁浅渔船 ----------
for (const d of DOCKS) {
  const base = Math.min(heightAt(d.x - d.w / 2, d.z), heightAt(d.x + d.w / 2, d.z));
  COLLIDERS.push({
    x: d.x, z: d.z, w: d.w, d: d.d,
    y0: d.y - 0.35, y1: d.y,
    kind: 'dock_deck', material: 'wood',
  });
  // 引桥台阶（从沙滩走上码头）
  const stepTop = d.y;
  const rampZ0 = d.z - d.d / 2 - 3.0;
  const rampZ1 = d.z - d.d / 2;
  COLLIDERS.push({
    x: d.x, z: (rampZ0 + rampZ1) / 2, w: d.w * 0.8, d: rampZ1 - rampZ0,
    y0: base - 0.6, y1: stepTop,
    kind: 'dock_ramp', material: 'wood',
  });
}

for (const b of BOATS) {
  const c = Math.abs(Math.cos(b.rot)), s = Math.abs(Math.sin(b.rot));
  const aw = c * b.len + s * b.beam;
  const ad = s * b.len + c * b.beam;
  COLLIDERS.push({
    x: b.x, z: b.z, w: aw, d: ad,
    y0: b.hullY - 1.0, y1: b.hullY + 1.15,
    kind: 'boat', material: 'wood',
  });
}

// ---------- 鱼摊遮阳棚（顶棚 + 四角柱）----------
for (const st of STALLS) {
  const base = heightAt(st.x, st.z);
  const c = Math.abs(Math.cos(st.rot)), s = Math.abs(Math.sin(st.rot));
  const aw = c * st.w + s * st.d;
  const ad = s * st.w + c * st.d;
  COLLIDERS.push({
    x: st.x, z: st.z, w: aw, d: ad,
    y0: base + st.h - 0.18, y1: base + st.h,
    kind: 'stall_roof', material: 'wood',
  });
  const ox = (c * (st.w / 2 - 0.2)) + (s * (st.d / 2 - 0.2));
  const oz = (s * (st.w / 2 - 0.2)) + (c * (st.d / 2 - 0.2));
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      COLLIDERS.push({
        x: st.x + sx * ox, z: st.z + sz * oz, w: 0.2, d: 0.2,
        y0: base, y1: base + st.h, kind: 'stall_post', material: 'wood',
      });
    }
  }
}

// ---------- 掩体道具 ----------
for (const b of DEFENSES) {
  const base = heightAt(b.x, b.z) - 0.12;
  COLLIDERS.push({
    x: b.x, z: b.z, w: b.w, d: b.d,
    y0: base, y1: base + b.h,
    kind: b.kind,
    material: b.kind === 'barrel' ? 'metal' : 'wood',
  });
}

// ---------- 礁石 / 海蚀柱 ----------
for (const r of ROCKS) {
  const w = r.size * 1.7;
  COLLIDERS.push({
    x: r.x, z: r.z, w, d: w * 0.9,
    y0: r.y - r.size * 0.45, y1: r.y + r.size * 0.85,
    kind: 'rock', material: 'stone',
  });
}

// ---------- 树干（灌木 / 沙丘草无碰撞）----------
for (const t of TREES) {
  if (t.type === 'bush' || t.type === 'dunegrass') continue;
  const trunk = t.type === 'palm' ? 0.34 : 0.5;
  const w = trunk * t.scale;
  COLLIDERS.push({
    x: t.x, z: t.z, w, d: w,
    y0: t.y - 0.3, y1: t.y + (t.type === 'palm' ? 4.2 : 3.2) * t.scale,
    kind: 'tree', material: 'wood',
  });
}

// ---------- 车辆 ----------
for (const c of CARS) {
  const alongX = Math.abs(Math.sin(c.rot)) < 0.5;
  const w = alongX ? 4.8 : 2.0;
  const d = alongX ? 2.0 : 4.8;
  COLLIDERS.push({
    x: c.x, z: c.z, w, d,
    y0: c.padH - 0.15, y1: c.padH + 1.45,
    kind: 'car', material: 'metal',
  });
}

// ---------- 边界墙 ----------
for (const b of BOUNDARY) COLLIDERS.push(b);

// ============================================================
// 十、物理 / 射线（统一由 shared/phys.js 生成后 re-export）
// ============================================================

const PHYS = createWorldPhysics({
  WORLD,
  heightAt,
  terrainNormal,
  surfaceAt,
  colliders: () => COLLIDERS,
  zones: () => ZONES,
  spawns: () => SPAWNS,
});

export const {
  circleOverlapsBox,
  movePlayerHorizontal,
  groundHeightAt,
  stepPlayerPhysics,
  applyJump,
  hitboxesFor,
  raycastWorld,
  losBlocked,
  zoneOf,
  pickSpawn,
  isWalkableAt,
} = PHYS;

// ============================================================
// 十一、出生朝向 / 武器箱 / 消耗品点
// ============================================================

// 让玩家朝地图中心（契约 §3.4）
export function spawnYaw(spawn) {
  return Math.atan2(spawn.x, spawn.z);
}

// 点位可用性：地面以上、坡度可走、不与碰撞体（含竖直范围）重叠
function spotClear(x, z, radius, minGround = 0.55) {
  if (Math.abs(x) > WORLD.half - 8 || Math.abs(z) > WORLD.half - 8) return false;
  const g = groundHeightAt(x, z, heightAt(x, z));
  if (g < minGround) return false;
  if (!isWalkableAt(x, z)) return false;
  for (let i = 0; i < COLLIDERS.length; i++) {
    const o = COLLIDERS[i];
    if (o.kind === 'boundary') continue;
    if (o.y1 <= g + 0.25) continue;                    // 可以踩上去的低矮物
    if (o.y0 > g + WORLD.playerHeight) continue;       // 头顶以上构件不挡路
    if (circleOverlapsBox(x, z, radius, o)) return false;
  }
  // 再按"纯水平"口径扫一遍：连低矮的、可以踩上去的碰撞体也要让开，
  // 保证道具不会紧贴桥面 / 码头 / 台阶的边沿生成（视觉上也更干净）。
  for (let i = 0; i < COLLIDERS.length; i++) {
    const o = COLLIDERS[i];
    if (o.kind === 'boundary') continue;
    if (circleOverlapsBox(x, z, radius, o)) return false;
  }
  return true;
}

// 5 个武器箱：栈桥尽头 / 船屋 / 礁石 / 村广场 / 西岬角
const SEA_STACK_CRATE = SEA_STACKS[0];
const SEA_STACK_CRATE_TOP = heightAt(SEA_STACK_CRATE.x, SEA_STACK_CRATE.z) + SEA_STACK_CRATE.size * 0.85;

export const CRATE_SPOTS = [
  { x: PIER.x, z: PIER.headZ0 + 3.2, y: PIER.deckHeight, type: 'sniper' },   // 栈桥 T 形平台（狙击位）
  { x: 46, z: -33, y: VILLAGE.h, type: 'shotgun' },                          // 船屋大门外
  { x: SEA_STACK_CRATE.x, z: SEA_STACK_CRATE.z, y: SEA_STACK_CRATE_TOP, type: 'ak47' },  // 礁石浅滩（需跳上海蚀柱）
  { x: VILLAGE.x, z: VILLAGE.z + 2, y: VILLAGE.h, type: 'm416' },            // 村广场
  { x: -114, z: -34, y: null, type: 'deagle' },                              // 西岬角（高度在下方补齐）
];

// 消耗品点：14~18 个，固定种子分层采样（6×6 网格），彼此间距 ≥ 8m
export const ITEM_SPOTS = [];
{
  const rand = mulberry32(20261023);
  // 分层网格：把地图切成 6×6 格，按固定顺序打乱后逐格取点，保证分布均匀
  const cells = [];
  for (let gx = 0; gx < 6; gx++) for (let gz = 0; gz < 6; gz++) cells.push([gx, gz]);
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = cells[i]; cells[i] = cells[j]; cells[j] = tmp;
  }
  const CELL = WORLD.size / 6;
  for (const [gx, gz] of cells) {
    if (ITEM_SPOTS.length >= 16) break;
    for (let attempt = 0; attempt < 60; attempt++) {
      const x = -WORLD.half + (gx + rand()) * CELL;
      const z = -WORLD.half + (gz + rand()) * CELL;
      if (!spotClear(x, z, 0.95)) continue;
      let tooClose = false;
      for (const s of ITEM_SPOTS) {
        if (Math.hypot(s.x - x, s.z - z) < 8) { tooClose = true; break; }
      }
      if (tooClose) continue;
      // 别把道具塞在出生点正上方
      if (nearSpawn(x, z, 5)) continue;
      ITEM_SPOTS.push({ x, z, y: heightAt(x, z) });
      break;
    }
  }
}

// 补齐西岬角武器箱高度
for (const c of CRATE_SPOTS) {
  if (c.y == null) c.y = heightAt(c.x, c.z);
}

// ============================================================
// 十二、MAP_EXTRAS / WORLD_INFO（供 scene 使用，契约 §3.6）
// ============================================================

// 海岸线采样点：每 4m 一个，scene 用来做湿沙带 / 冲浪线。
// 注意取的是**真实水线**（heightAt = 0 的位置）而不是 shoreZ(x)：
// 出生垫 / 桥头垫会把局部沙滩抬起来，真实水线会比 shoreZ 向海推几米，
// 这里对高度场做二分求根，保证湿沙带 / 浪花线和地形严格吻合。
// 东西两端（|x| > 140）陆地已经沉到水下，不再采样。
const SHORELINE_SAMPLES = [];
{
  const BISECT = 26;
  for (let x = -140; x <= 140; x += 4) {
    let inland = shoreZ(x) - 20;          // 内陆侧：一定在水面以上
    let seaward = shoreZ(x) + 40;         // 海侧：一定在水面以下
    if (heightAt(x, inland) <= 0) {       // 极端位置兜底：往内陆再找
      let found = false;
      for (let z = inland; z > -WORLD.half + 2; z -= 4) {
        if (heightAt(x, z) > 0) { inland = z; found = true; break; }
      }
      if (!found) continue;
    }
    for (let i = 0; i < BISECT; i++) {
      const mid = (inland + seaward) * 0.5;
      if (heightAt(x, mid) > 0) inland = mid;
      else seaward = mid;
    }
    SHORELINE_SAMPLES.push({ x, z: (inland + seaward) * 0.5, y: SEA_LEVEL });
  }
}

export const MAP_EXTRAS = {
  seaLevel: SEA_LEVEL,
  pier: {
    x: PIER.x,
    zStart: PIER.zStart,
    zEnd: PIER.zEnd,
    deckHeight: PIER.deckHeight,
    width: PIER.width,
    headWidth: PIER.headWidth,
    headDepth: PIER.headDepth,
    railH: PIER.railH,
    // 便利字段（scene 侧可直接用）
    headZ0: PIER.headZ0,
    halfW: PIER.halfW,
    headHalfW: PIER.headHalfW,
    ramp: { ...PIER_RAMP },
  },
  boardwalk: BOARDWALK.map((s) => ({ ...s })),
  docks: DOCKS.map((d) => ({ ...d })),
  boats: BOATS.map((b) => ({ ...b })),
  stalls: STALLS.map((s) => ({ ...s })),
  reef: { x: REEF.x, z: REEF.z, r: REEF.r },
  shoreline: { samples: SHORELINE_SAMPLES },
  // ---- 额外便利数据（不在契约必填里，scene 可选使用）----
  village: { x: VILLAGE.x, z: VILLAGE.z, r: VILLAGE.r, h: VILLAGE.h },
  capes: [CAPE_W, CAPE_E],
  ridge: RIDGE,
  seaStacks: SEA_STACKS.map((s) => ({ ...s })),
  props: DEFENSES.map((p) => ({ ...p })),
};

export const WORLD_INFO = {
  seaLevel: SEA_LEVEL,
  village: VILLAGE,
  reef: REEF,
  capes: [CAPE_W, CAPE_E],
  ridge: RIDGE,
  pier: PIER,
  roads: ROADS,
  houses: HOUSES,
  zones: ZONES,
  hills: [CAPE_W, CAPE_E],   // 旧字段名兼容（world.js 用 hills 描述地形隆起）
  shoreline: { samples: SHORELINE_SAMPLES },
  bounds: { size: WORLD.size, half: WORLD.half },
};
