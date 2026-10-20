// ===== 共享世界数据层：高度场地形 / 郊区布局 / 碰撞体 / 物理 / 射线 =====
// 浏览器与 Node 服务器共用。所有地形与布局生成必须是确定性纯函数：
// 固定整数哈希噪声 + 固定种子 RNG，禁止 Math.random() 参与，保证客户端预测与服务器权威一致。
//
// 坐标系：x 向东，z 向南，y 向上；1 unit = 1 m；玩家朝向 yaw=0 时看向 -Z。
// 玩家位置 (x, y, z) 中 y 为脚底高度。

export const WORLD = {
  size: 140,
  half: 70,
  maxPlayers: 8,

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

// 光照/大气（客户端渲染 + 共享给环境模块）
export const SUN = {
  dir: [-0.42, 0.74, 0.52],      // 指向太阳的方向（已归一化）
  color: 0xfff0d4,
  intensity: 2.7,
  hemiSky: 0xbcd6f0,
  hemiGround: 0x8a7c5c,
  hemiIntensity: 1.0,
  fogColor: 0xc9d6e2,
  fogNear: 55,
  fogFar: 210,
  exposure: 1.0,
};

// 据点争夺
export const ZONE_CAPTURE_TIME = 6;     // 单人从 0 占满所需秒数
export const ZONE_SCORE_RATE = 1;       // 每个据点每秒得分
export const MATCH_SCORE_TARGET = 420;  // 先到分数获胜
export const MATCH_TIME_LIMIT = 600;    // 秒
export const UAV_KILLSTREAK = 5;        // 5 连杀触发
export const UAV_DURATION = 10;         // 秒

// AI 基础配置（server/ai.js 可覆盖细节）
// 难度取向：接近"普通玩家"——反应慢、瞄准误差大、点射之间有停顿，不做神枪手。
export const AI_CONFIG = {
  max: 5,
  allyCount: 2,
  enemyCount: 3,
  tickMs: 200,
  visionRadius: 55,
  fovDeg: 110,
  hearingShot: 45,
  hearingStep: 12,
  loseMemoryMs: 6000,
  reactionMin: 340,
  reactionMax: 720,
  aimErrorStart: 0.30,
  aimErrorMin: 0.045,
  aimSettle: 1.8,
  turnRate: 3.0,
  shootRange: 55,
  damageMult: 1.0,
  healthMult: 1.0,
  moveSpeedMult: 0.94,
  jumpChance: 0.15,
  stepHeight: 0.62,
};
export const BOTS = AI_CONFIG; // 旧名兼容

export const TEAMS = ['alpha', 'bravo'];
export const PLAYER_COLORS = [0x6f9fc4, 0x7fae8f, 0x8f9fc4, 0xb08f6f, 0x6faeae, 0xc9a06a, 0xa06f7f, 0x8fb26f];
export const BOT_COLORS = { ally: 0x6f9fc4, enemy: 0xc06a4e };

// ============================================================
// 一、确定性噪声与地形基础
// ============================================================

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

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

// 山丘：高斯隆起（sigma = r * 0.6），保证整体坡度可步行
const HILLS = [
  { x: -52, z: 54, r: 30, h: 7.5 },
  { x: 56, z: -50, r: 26, h: 6.5 },
  { x: -58, z: -44, r: 24, h: 4.2 },
  { x: 48, z: 48, r: 20, h: 3.2 },
  { x: -8, z: -58, r: 28, h: 3.0 },
  { x: 8, z: 56, r: 22, h: 2.4 },
];

function rawHeight(x, z) {
  // 多层起伏噪声（长波 + 中波 + 细节），整体以 0 为中心
  let h = 1.15 * (valueNoise(x * 0.022 + 13.7, z * 0.022 - 7.1) * 2 - 1);
  h += 0.5 * (valueNoise(x * 0.075 - 3.3, z * 0.075 + 9.9) * 2 - 1);
  h += 0.18 * (valueNoise(x * 0.21 + 5.1, z * 0.21 - 2.4) * 2 - 1);
  // 山丘
  for (const hill of HILLS) {
    const dx = x - hill.x, dz = z - hill.z;
    const d2 = dx * dx + dz * dz;
    const s2 = hill.r * hill.r * 0.36;
    h += hill.h * Math.exp(-d2 / (2 * s2));
  }
  // 地图边缘缓坡抬升，视觉上收住边界
  const edge = Math.max(Math.abs(x), Math.abs(z));
  h += 3.2 * smoothstep(56, 68, edge);
  return h;
}

// ============================================================
// 二、郊区布局：房屋 / 输电塔 / 车辆 / 栅栏 / 石堆 / 树
// ============================================================

// 房子：可进入的墙板房。doorSide 指向道路/广场一侧。
// padH 在下方由 rawHeight 计算并补齐。
export const HOUSES = [
  { id: 'H1', x: -38, z: -26, w: 12, d: 9, wallH: 3.2, roofH: 2.6, doorSide: 'south', doorW: 1.6, doorH: 2.15, style: 'white', color: 0xd8d2c4 },
  { id: 'H2', x: 38, z: -30, w: 10, d: 8, wallH: 3.0, roofH: 2.3, doorSide: 'south', doorW: 1.5, doorH: 2.1, style: 'blue', color: 0xb9c6cf },
  { id: 'H3', x: -40, z: 30, w: 13, d: 9, wallH: 3.4, roofH: 2.8, doorSide: 'north', doorW: 1.6, doorH: 2.2, style: 'red', color: 0xc4a58f },
  { id: 'H4', x: 36, z: 32, w: 10, d: 8, wallH: 3.0, roofH: 2.4, doorSide: 'north', doorW: 1.5, doorH: 2.1, style: 'grey', color: 0xccc7ba },
  { id: 'BARN', x: 2, z: -52, w: 16, d: 11, wallH: 4.2, roofH: 3.4, doorSide: 'south', doorW: 3.2, doorH: 3.4, style: 'barn', color: 0x9a6b4f },
  { id: 'SHED', x: -14, z: 48, w: 6, d: 5, wallH: 2.4, roofH: 1.8, doorSide: 'south', doorW: 1.3, doorH: 1.95, style: 'shed', color: 0xa8a08c },
];

// 大型输电塔（26m 桁架塔 + 塔间悬链电缆，由 env 建模）
// 位置刻意远离房屋平整垫，避免两套 pad 相互干扰导致墙底/塔基悬空。
export const PYLONS = [
  { x: -24, z: 26, rot: 0.35, h: 26, id: 'P1' },
  { x: 26, z: -14, rot: -0.35, h: 26, id: 'P2' },
];

// 废弃车辆（掩体）
export const CARS = [
  { x: -22, z: 6, rot: 0, color: 0x6f7b78, id: 'CAR1' },
  { x: 24, z: -6, rot: Math.PI / 2, color: 0x7a5b4a, id: 'CAR2' },
];

// 低矮工事/沙袋墙（据点附近掩体，0.95m：站立可越、蹲下可掩护）
export const DEFENSES = [
  { x: -34, z: 13.5, w: 4.4, d: 0.8, h: 0.95, rot: 0, kind: 'sandbag' },
  { x: -40.5, z: 6, w: 0.8, d: 4.4, h: 0.95, rot: 0, kind: 'concrete' },
  { x: 34, z: 13.5, w: 4.4, d: 0.8, h: 0.95, rot: 0, kind: 'sandbag' },
  { x: 40.5, z: 6, w: 0.8, d: 4.4, h: 0.95, rot: 0, kind: 'concrete' },
  { x: 0, z: -8.5, w: 5.0, d: 0.8, h: 0.95, rot: 0, kind: 'concrete' },
  { x: 0, z: 8.5, w: 5.0, d: 0.8, h: 0.95, rot: 0, kind: 'sandbag' },
];

// 木栅栏（仅轴对齐；自动生成 1.05m 高碰撞体）
export const FENCES = [
  // H1 前院（门朝 +Z）
  { x1: -46, z1: -18.5, x2: -39.2, z2: -18.5, h: 1.05 },
  { x1: -36.8, z1: -18.5, x2: -30, z2: -18.5, h: 1.05 },
  // H2 前院
  { x1: 32, z1: -23, x2: 37.2, z2: -23, h: 1.05 },
  { x1: 38.8, z1: -23, x2: 44, z2: -23, h: 1.05 },
  // H3 前院（门朝 -Z）
  { x1: -48, z1: 22.5, x2: -41.2, z2: 22.5, h: 1.05 },
  { x1: -38.8, z1: 22.5, x2: -32, z2: 22.5, h: 1.05 },
  // H4 前院
  { x1: 30, z1: 25, x2: 35.2, z2: 25, h: 1.05 },
  { x1: 36.8, z1: 25, x2: 42, z2: 25, h: 1.05 },
  // 谷仓侧栏
  { x1: -6, z1: -44.5, x2: -6, z2: -35, h: 1.15 },
  { x1: 10, z1: -44.5, x2: 10, z2: -35, h: 1.15 },
  // 路边草场围栏
  { x1: -60, z1: -10, x2: -48, z2: -10, h: 1.05 },
  { x1: 48, z1: 10, x2: 60, z2: 10, h: 1.05 },
];

// 道路（泥土路 + 中央碎石广场）
export const ROADS = {
  mainWidth: 8,     // 南北向，沿 x=0
  crossWidth: 7,    // 东西向，沿 z=0
  plazaRadius: 13,  // 中央广场
};

// 据点
export const ZONES = [
  { id: 'A', name: '西村', x: -34, z: 6, r: 9 },
  { id: 'B', name: '中央广场', x: 0, z: 0, r: 10 },
  { id: 'C', name: '东站', x: 34, z: 6, r: 9 },
];

// ============================================================
// 三、平整垫 + 高度场
// ============================================================

// 先给房屋/塔/车辆定基准高度（以原始地形为准）
for (const h of HOUSES) h.padH = rawHeight(h.x, h.z);
for (const p of PYLONS) p.padH = rawHeight(p.x, p.z);
for (const c of CARS) c.padH = rawHeight(c.x, c.z);

// 平整垫：据点 / 出生区 / 房屋 / 塔 / 车辆 / 广场
// 注意：广场垫必须最后应用，保证中央广场绝对平整（据点 B 在其内部）。
const PADS = [];
function addPad(x, z, r, blend, h) {
  PADS.push({ x, z, r, blend, h });
}
for (const zn of ZONES) addPad(zn.x, zn.z, zn.r + 2.5, 7, zn.id === 'B' ? 0 : rawHeight(zn.x, zn.z));
addPad(0, 55, 17, 10, rawHeight(0, 55));                          // alpha 出生区
addPad(0, -55, 17, 10, rawHeight(0, -55));                        // bravo 出生区
for (const p of PYLONS) addPad(p.x, p.z, 7.5, 4.5, p.padH);
for (const c of CARS) addPad(c.x, c.z, 4.2, 3.0, c.padH);
// 房屋垫放在塔/车之后：房屋室内地面必须严格等于 wallSegments 的 y0
for (const h of HOUSES) addPad(h.x, h.z, Math.hypot(h.w, h.d) * 0.5 + 2.2, 5.5, h.padH);
addPad(0, 0, ROADS.plazaRadius + 1, 9, 0);                        // 中央广场（最后，最高优先）

function baseHeight(x, z) {
  let h = rawHeight(x, z);
  for (const p of PADS) {
    const dx = x - p.x, dz = z - p.z;
    const d = Math.hypot(dx, dz);
    if (d >= p.r + p.blend) continue;
    const w = d <= p.r ? 1 : 1 - smoothstep(p.r, p.r + p.blend, d);
    h += (p.h - h) * w;
  }
  return h;
}

// 1m 高度采样网格（141×141），heightAt 双线性插值
const HF_RES = 140;
const HF_N = HF_RES + 1;
const HF_CELL = WORLD.size / HF_RES;
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

export function surfaceAt(x, z) {
  if (Math.hypot(x, z) <= ROADS.plazaRadius) return 'dirt';
  if (Math.abs(x) <= ROADS.mainWidth / 2 || Math.abs(z) <= ROADS.crossWidth / 2) return 'road';
  return 'grass';
}

// ============================================================
// 四、程序化树木 / 石堆（固定种子，客户端与服务器一致）
// ============================================================

const treeRand = mulberry32(20261018);

function distToHouse(x, z, extra = 0) {
  for (const h of HOUSES) {
    const hw = h.w / 2 + extra, hd = h.d / 2 + extra;
    if (Math.abs(x - h.x) < hw && Math.abs(z - h.z) < hd) return 0;
    const dx = Math.max(Math.abs(x - h.x) - hw, 0);
    const dz = Math.max(Math.abs(z - h.z) - hd, 0);
    if (Math.hypot(dx, dz) < 2.5) return Math.hypot(dx, dz);
  }
  return 999;
}
function distToZones(x, z, extra = 0) {
  let m = 999;
  for (const zn of ZONES) m = Math.min(m, Math.max(0, Math.hypot(x - zn.x, z - zn.z) - zn.r - extra));
  return m;
}
function distToPylons(x, z, extra = 0) {
  let m = 999;
  for (const p of PYLONS) m = Math.min(m, Math.max(0, Math.hypot(x - p.x, z - p.z) - 4 - extra));
  return m;
}
function onRoad(x, z, margin = 6) {
  return Math.abs(x) < ROADS.mainWidth / 2 + margin || Math.abs(z) < ROADS.crossWidth / 2 + margin;
}

// 出生点必须提前定义：生成树木/石堆时要主动避开，避免出生即卡在碰撞体里
export const SPAWNS = {
  alpha: [
    { x: 0, z: 52 }, { x: -7, z: 56 }, { x: 7, z: 56 }, { x: 0, z: 60 },
    { x: -12, z: 58 }, { x: 12, z: 58 }, { x: 18, z: 52 }, { x: -18, z: 52 },
  ],
  bravo: [
    { x: 24, z: -52 }, { x: -24, z: -52 }, { x: 30, z: -58 }, { x: -30, z: -58 },
    { x: 20, z: -60 }, { x: -20, z: -60 }, { x: 34, z: -46 }, { x: -34, z: -46 },
  ],
};
SPAWNS.all = [...SPAWNS.alpha, ...SPAWNS.bravo];

function nearSpawn(x, z, extra = 3) {
  for (const s of SPAWNS.all) {
    if ((s.x - x) ** 2 + (s.z - z) ** 2 < extra * extra) return true;
  }
  return false;
}

export const TREES = [];
{
  const rand = treeRand;
  let guard = 0;
  while (TREES.length < 72 && guard++ < 3000) {
    const x = (rand() * 2 - 1) * 66;
    const z = (rand() * 2 - 1) * 66;
    if (onRoad(x, z, 4)) continue;
    if (distToHouse(x, z, 2) !== 999) continue;
    if (distToZones(x, z, 3) < 1) continue;
    if (distToPylons(x, z, 4) < 1) continue;
    // 出生区留空
    if (Math.abs(x) < 16 && Math.abs(Math.abs(z) - 55) < 16) continue;
    if (nearSpawn(x, z, 3.5)) continue;
    let tooClose = false;
    for (const t of TREES) {
      if ((t.x - x) ** 2 + (t.z - z) ** 2 < 20) { tooClose = true; break; }
    }
    if (tooClose) continue;
    const r = rand();
    const type = r < 0.42 ? 'pine' : r < 0.85 ? 'oak' : 'bush';
    const scale = 0.8 + rand() * 0.7;
    TREES.push({ x, z, type, scale, rot: rand() * Math.PI * 2, y: heightAt(x, z) });
  }
}

export const ROCKS = [];
{
  const rand = mulberry32(77113);
  let guard = 0;
  while (ROCKS.length < 28 && guard++ < 2000) {
    const hill = HILLS[Math.floor(rand() * HILLS.length)];
    const ang = rand() * Math.PI * 2;
    const dist = hill.r * (0.25 + rand() * 0.7);
    const x = hill.x + Math.cos(ang) * dist;
    const z = hill.z + Math.sin(ang) * dist;
    if (Math.abs(x) > 64 || Math.abs(z) > 64) continue;
    if (onRoad(x, z, 3)) continue;
    if (distToHouse(x, z, 2) !== 999) continue;
    if (distToZones(x, z, 2) < 1) continue;
    if (nearSpawn(x, z, 4)) continue;
    let tooClose = false;
    for (const r of ROCKS) {
      if ((r.x - x) ** 2 + (r.z - z) ** 2 < 16) { tooClose = true; break; }
    }
    if (tooClose) continue;
    const size = 0.55 + rand() * 1.25;
    ROCKS.push({
      x, z, size, rot: rand() * Math.PI * 2, seed: rand(),
      y: heightAt(x, z),
    });
  }
}

// ============================================================
// 五、碰撞体（所有实心 AABB，含 y0/y1 竖直范围）
// ============================================================

export const BOUNDARY = [
  { x: 0, z: -(WORLD.half - 2), w: WORLD.size, d: 1.2, y0: -30, y1: 40, kind: 'boundary', material: 'metal' },
  { x: 0, z: (WORLD.half - 2), w: WORLD.size, d: 1.2, y0: -30, y1: 40, kind: 'boundary', material: 'metal' },
  { x: -(WORLD.half - 2), z: 0, w: 1.2, d: WORLD.size, y0: -30, y1: 40, kind: 'boundary', material: 'metal' },
  { x: (WORLD.half - 2), z: 0, w: 1.2, d: WORLD.size, y0: -30, y1: 40, kind: 'boundary', material: 'metal' },
];

// 生成房屋墙体碰撞（含门洞与门楣），视觉建模必须使用同一份数据
export function houseWallSegments(h) {
  const t = 0.34;
  const y0 = h.padH, y1 = h.padH + h.wallH;
  const segments = [];
  const doorW = h.doorW || 1.5, doorH = h.doorH || 2.1;
  const push = (cx, cz, sw, sd, sy0, sy1) => segments.push({
    x: cx, z: cz, w: sw, d: sd, y0: sy0, y1: sy1, kind: 'house', material: 'wood', house: h.id,
  });

  // 南北墙沿 X 方向；东西墙沿 Z 方向
  const sides = {
    north: { axis: 'x', len: h.w + t, cx: h.x, cz: h.z - h.d / 2 },
    south: { axis: 'x', len: h.w + t, cx: h.x, cz: h.z + h.d / 2 },
    west: { axis: 'z', len: h.d + t, cx: h.x - h.w / 2, cz: h.z },
    east: { axis: 'z', len: h.d + t, cx: h.x + h.w / 2, cz: h.z },
  };

  let door = null;
  for (const side of Object.keys(sides)) {
    const s = sides[side];
    const hasDoor = h.doorSide === side;
    if (!hasDoor) {
      if (s.axis === 'x') push(s.cx, s.cz, s.len, t, y0, y1);
      else push(s.cx, s.cz, t, s.len, y0, y1);
      continue;
    }
    // 带门洞：左右两段 + 门楣
    const half = s.len / 2;
    const dw = Math.min(doorW, s.len - 1.2) / 2;
    const segLen = half - dw;
    if (segLen > 0.1) {
      if (s.axis === 'x') {
        push(s.cx - (dw + segLen / 2), s.cz, segLen, t, y0, y1);
        push(s.cx + (dw + segLen / 2), s.cz, segLen, t, y0, y1);
      } else {
        push(s.cx, s.cz - (dw + segLen / 2), t, segLen, y0, y1);
        push(s.cx, s.cz + (dw + segLen / 2), t, segLen, y0, y1);
      }
    }
    const lintelH = Math.min(doorH, h.wallH - 0.3);
    if (h.wallH - lintelH > 0.05) {
      if (s.axis === 'x') push(s.cx, s.cz, dw * 2, t, y0 + lintelH, y1);
      else push(s.cx, s.cz, t, dw * 2, y0 + lintelH, y1);
    }
    door = {
      side,
      x: s.axis === 'x' ? s.cx : s.cx,
      z: s.axis === 'x' ? s.cz : s.cz,
      w: dw * 2, h: lintelH,
      dirX: side === 'west' ? -1 : side === 'east' ? 1 : 0,
      dirZ: side === 'north' ? -1 : side === 'south' ? 1 : 0,
      padH: y0,
    };
  }
  return { segments, door, y0, y1 };
}

export const COLLIDERS = [];

// 房屋墙
for (const h of HOUSES) {
  const { segments } = houseWallSegments(h);
  for (const s of segments) COLLIDERS.push(s);
}
// 栅栏
for (const f of FENCES) {
  const cx = (f.x1 + f.x2) / 2, cz = (f.z1 + f.z2) / 2;
  const w = Math.max(Math.abs(f.x2 - f.x1), 0.16);
  const d = Math.max(Math.abs(f.z2 - f.z1), 0.16);
  const base = Math.min(heightAt(f.x1, f.z1), heightAt(f.x2, f.z2)) - 0.15;
  COLLIDERS.push({ x: cx, z: cz, w, d, y0: base, y1: base + (f.h || 1.05), kind: 'fence', material: 'wood' });
}
// 石堆
for (const r of ROCKS) {
  const w = r.size * 2.0;
  COLLIDERS.push({
    x: r.x, z: r.z, w, d: w * 0.9,
    y0: r.y - r.size * 0.45, y1: r.y + r.size * 0.85,
    kind: 'rock', material: 'stone',
  });
}
// 树干
for (const t of TREES) {
  if (t.type === 'bush') continue;
  const trunk = t.type === 'pine' ? 0.36 : 0.48;
  const w = trunk * t.scale;
  COLLIDERS.push({
    x: t.x, z: t.z, w, d: w,
    y0: t.y - 0.3, y1: t.y + (t.type === 'pine' ? 3.4 : 3.0) * t.scale,
    kind: 'tree', material: 'wood',
  });
}
// 车辆
for (const c of CARS) {
  const alongX = Math.abs(Math.sin(c.rot)) < 0.5;
  const w = alongX ? 4.4 : 1.9;
  const d = alongX ? 1.9 : 4.4;
  COLLIDERS.push({
    x: c.x, z: c.z, w, d,
    y0: c.padH - 0.15, y1: c.padH + 1.45,
    kind: 'car', material: 'metal',
  });
}
// 工事 / 沙袋
for (const b of DEFENSES) {
  const base = heightAt(b.x, b.z) - 0.12;
  COLLIDERS.push({
    x: b.x, z: b.z, w: b.w, d: b.d,
    y0: base, y1: base + b.h, kind: b.kind, material: b.kind === 'sandbag' ? 'dirt' : 'concrete',
  });
}
// 输电塔：混凝土基座（可站）+ 四条塔腿（基座高度取该处真实地形，避免悬空）
for (const p of PYLONS) {
  const c = Math.cos(p.rot), s = Math.sin(p.rot);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const lx = sx * 2.35, lz = sz * 2.35;
      const wx = p.x + lx * c - lz * s;
      const wz = p.z + lx * s + lz * c;
      const base = heightAt(wx, wz);
      COLLIDERS.push({
        x: wx, z: wz, w: 1.8, d: 1.8,
        y0: base - 0.25, y1: base + 0.45, kind: 'pylon_base', material: 'concrete',
      });
      COLLIDERS.push({
        x: wx, z: wz, w: 0.6, d: 0.6,
        y0: base + 0.45, y1: base + 9, kind: 'pylon', material: 'metal',
      });
    }
  }
}
// 边界墙
for (const b of BOUNDARY) COLLIDERS.push(b);

// ============================================================
// 六、出生点 / 据点 / 道具点
// ============================================================

// 出生点（SPAWNS 已在上方定义，生成植被时用于避让）
export function spawnYaw(spawn) {
  return Math.atan2(spawn.x, spawn.z);
}

// 固定武器箱位置（据点中心 + 两处补给点）
export const CRATE_SPOTS = [
  { x: -34, z: 6, type: 'ak47' },
  { x: 0, z: 0, type: 'sniper' },
  { x: 34, z: 6, type: 'shotgun' },
  // 新增枪械：A/C 据点外侧各放一个，鼓励绕后取枪
  { x: -46, z: -14, type: 'm416' },
  { x: 46, z: -14, type: 'deagle' },
];

// 消耗品/武器道具点：固定种子采样，保证不压在碰撞体上
export const ITEM_SPOTS = [];
{
  const rand = mulberry32(982451653);
  let guard = 0;
  while (ITEM_SPOTS.length < 16 && guard++ < 4000) {
    const ang = rand() * Math.PI * 2;
    const rad = 8 + rand() * 52;
    const x = Math.cos(ang) * rad;
    const z = Math.sin(ang) * rad;
    if (Math.abs(x) > 62 || Math.abs(z) > 62) continue;
    if (Math.abs(x) < 4.5 && Math.abs(z) < 4.5) continue;   // 广场中心留给武器箱
    let ok = true;
    for (const o of COLLIDERS) {
      if (o.kind === 'boundary') continue;
      const hw = o.w / 2 + 0.8, hd = o.d / 2 + 0.8;
      if (Math.abs(x - o.x) < hw && Math.abs(z - o.z) < hd) { ok = false; break; }
    }
    if (!ok) continue;
    for (const s of ITEM_SPOTS) {
      if (Math.hypot(s.x - x, s.z - z) < 7) { ok = false; break; }
    }
    if (!ok) continue;
    ITEM_SPOTS.push({ x, z });
  }
}

// ============================================================
// 七、物理：水平移动 / 重力 / 地面 / 碰撞
// ============================================================

function stanceHeight(b) {
  const s = b.stance || 'stand';
  if (s === 'crouch') return WORLD.crouchHeight;
  if (s === 'slide') return WORLD.slideHeight;
  return b.height ?? WORLD.playerHeight;
}

export function circleOverlapsBox(x, z, r, o) {
  const hw = o.w / 2, hd = o.d / 2;
  const cx = Math.max(o.x - hw, Math.min(x, o.x + hw));
  const cz = Math.max(o.z - hd, Math.min(z, o.z + hd));
  const dx = x - cx, dz = z - cz;
  return dx * dx + dz * dz < r * r - 1e-9;
}

function verticalSpan(b) {
  const h = stanceHeight(b);
  return { feet: b.y, head: b.y + h };
}

// 把玩家从所有实心碰撞体里水平推出（考虑竖直范围）
function resolveColliders(b) {
  const r = b.radius ?? WORLD.playerRadius;
  const { feet, head } = verticalSpan(b);
  let pushed = false;
  for (let n = 0; n < 2; n++) {
    for (const o of COLLIDERS) {
      if (head <= o.y0 + 0.02 || feet >= o.y1 - 0.02) continue;
      if (!circleOverlapsBox(b.x, b.z, r, o)) continue;
      const hw = o.w / 2, hd = o.d / 2;
      const minX = o.x - hw, maxX = o.x + hw;
      const minZ = o.z - hd, maxZ = o.z + hd;
      const cx = Math.max(minX, Math.min(b.x, maxX));
      const cz = Math.max(minZ, Math.min(b.z, maxZ));
      const dx = b.x - cx, dz = b.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 < 1e-8) {
        // 圆心在盒内：沿穿透最浅的轴推出
        const pushX = Math.min(b.x - minX, maxX - b.x);
        const pushZ = Math.min(b.z - minZ, maxZ - b.z);
        if (pushX < pushZ) b.x = b.x < o.x ? minX - r : maxX + r;
        else b.z = b.z < o.z ? minZ - r : maxZ + r;
      } else {
        const d = Math.sqrt(d2);
        b.x = cx + (dx / d) * r;
        b.z = cz + (dz / d) * r;
      }
      pushed = true;
    }
  }
  return pushed;
}

// 水平移动（含坡度限制 + 碰撞体推出 + 边界钳制）
export function movePlayerHorizontal(b, dx, dz) {
  const r = b.radius ?? WORLD.playerRadius;
  const startX = b.x, startZ = b.z;
  const grounded = b.grounded !== false;

  // 分轴移动，允许沿陡坡侧滑
  if (dx !== 0) {
    b.x += dx;
    resolveColliders(b);
    if (grounded && heightAt(b.x, b.z) - b.y > WORLD.maxStep) b.x = startX;
  }
  if (dz !== 0) {
    b.z += dz;
    resolveColliders(b);
    if (grounded && heightAt(b.x, b.z) - b.y > WORLD.maxStep) b.z = startZ;
  }
  resolveColliders(b);

  const lim = WORLD.half - 2.4 - r;
  b.x = clamp(b.x, -lim, lim);
  b.z = clamp(b.z, -lim, lim);

  return { blocked: Math.abs(b.x - startX) < 1e-6 && Math.abs(b.z - startZ) < 1e-6 };
}

// 可站立高度：地形 + 脚下可踩的碰撞体顶面（台阶/石头顶）
function standableHeight(x, z, r, prevY, curY, grounded) {
  let g = heightAt(x, z);
  for (const o of COLLIDERS) {
    if (o.kind === 'boundary') continue;
    if (o.y1 <= g) continue;
    if (!circleOverlapsBox(x, z, r, o)) continue;
    const canLand = prevY >= o.y1 - 0.06;
    const canStep = grounded && curY + WORLD.maxStep >= o.y1;
    if ((canLand || canStep) && o.y1 > g) g = o.y1;
  }
  return g;
}

// 对外：当前脚底所在的可站立高度
export function groundHeightAt(x, z, feetY = 0, radius = WORLD.playerRadius) {
  return standableHeight(x, z, radius, feetY, feetY, true);
}

export function stepPlayerPhysics(b, dt) {
  const r = b.radius ?? WORLD.playerRadius;
  const height = stanceHeight(b);
  const prevY = b.y;

  b.vy -= WORLD.gravity * dt;
  b.y += b.vy * dt;

  // 撞头（向上顶到门楣/基座底部）
  if (b.vy > 0) {
    for (const o of COLLIDERS) {
      if (o.kind === 'boundary') continue;
      if (!circleOverlapsBox(b.x, b.z, r, o)) continue;
      if (prevY + height <= o.y0 + 0.02 && b.y + height > o.y0) {
        b.y = o.y0 - height;
        b.vy = 0;
        break;
      }
    }
  }

  const g = standableHeight(b.x, b.z, r, prevY, b.y, b.grounded !== false);
  if (b.y <= g) {
    b.y = g;
    if (b.vy < 0) b.vy = 0;
    b.grounded = true;
  } else {
    b.grounded = false;
  }

  resolveColliders(b);
  const lim = WORLD.half - 2.4 - r;
  b.x = clamp(b.x, -lim, lim);
  b.z = clamp(b.z, -lim, lim);
  return b;
}

// 起跳（保持客户端/服务器一致）
export function applyJump(b) {
  if (!b.grounded) return false;
  b.vy = WORLD.jumpSpeed;
  b.grounded = false;
  return true;
}

// 命中盒：头球 + 躯干胶囊 + 腿胶囊（蹲/滑铲整体压低）
export function hitboxesFor(p) {
  const crouched = p.stance === 'crouch' || p.stance === 'slide';
  const k = crouched ? (p.stance === 'slide' ? 0.52 : 0.68) : 1;
  const x = p.x, y = p.y, z = p.z;
  return {
    head: { x, y: y + WORLD.headY * k, z, r: WORLD.headR },
    body: {
      ax: x, ay: y + WORLD.bodyBottom * k, az: z,
      bx: x, by: y + WORLD.bodyTop * k, bz: z,
      r: WORLD.bodyR * (crouched ? 0.95 : 1),
    },
    legs: {
      ax: x, ay: y + WORLD.legsBottom * k, az: z,
      bx: x, by: y + WORLD.legsTop * k, bz: z,
      r: WORLD.legsR,
    },
  };
}

// ============================================================
// 八、射线：地形 + 碰撞体（子弹命中 / 视线遮挡 / AI 感知共用）
// ============================================================

function rayTerrain(ox, oy, oz, dx, dy, dz, maxDist) {
  const startH = heightAt(ox, oz);
  if (oy < startH) {
    return { t: 0, point: { x: ox, y: oy, z: oz }, normal: terrainNormal(ox, oz), surface: surfaceAt(ox, oz), kind: 'terrain' };
  }
  let t = 0, prevT = 0;
  let guard = 0;
  while (t < maxDist && guard++ < 600) {
    const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
    const h = heightAt(x, z);
    if (y <= h) {
      // 二分细化
      let lo = prevT, hi = t;
      for (let i = 0; i < 12; i++) {
        const m = (lo + hi) * 0.5;
        if (oy + dy * m <= heightAt(ox + dx * m, oz + dz * m)) hi = m;
        else lo = m;
      }
      const px = ox + dx * hi, py = oy + dy * hi, pz = oz + dz * hi;
      return { t: hi, point: { x: px, y: py, z: pz }, normal: terrainNormal(px, pz), surface: surfaceAt(px, pz), kind: 'terrain' };
    }
    prevT = t;
    const gap = y - h;
    t += clamp(gap * 0.55, 0.35, 1.8);
  }
  return null;
}

function rayAABB(ox, oy, oz, dx, dy, dz, o) {
  const minx = o.x - o.w / 2, maxx = o.x + o.w / 2;
  const miny = o.y0, maxy = o.y1;
  const minz = o.z - o.d / 2, maxz = o.z + o.d / 2;
  let tmin = 0, tmax = Infinity;
  let nAxis = 0, nSign = 0;
  let axis = 0;
  for (const [origin, dir, mn, mx] of [[ox, dx, minx, maxx], [oy, dy, miny, maxy], [oz, dz, minz, maxz]]) {
    if (Math.abs(dir) < 1e-9) {
      if (origin < mn || origin > mx) return null;
    } else {
      let t1 = (mn - origin) / dir;
      let t2 = (mx - origin) / dir;
      let sign = -1;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; sign = 1; }
      if (t1 > tmin) { tmin = t1; nAxis = axis; nSign = sign; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
    axis++;
  }
  if (tmin <= 0 || tmin >= 1e9) return null;
  return { t: tmin, nx: nAxis === 0 ? nSign : 0, ny: nAxis === 1 ? nSign : 0, nz: nAxis === 2 ? nSign : 0 };
}

export function raycastWorld(ox, oy, oz, dx, dy, dz, maxDist = 200) {
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-9) return null;
  dx /= len; dy /= len; dz /= len;

  let best = rayTerrain(ox, oy, oz, dx, dy, dz, maxDist);
  let bestMat = best ? best.surface : 'grass';

  for (const o of COLLIDERS) {
    const hit = rayAABB(ox, oy, oz, dx, dy, dz, o);
    if (!hit) continue;
    if (hit.t > maxDist) continue;
    if (!best || hit.t < best.t) {
      best = {
        t: hit.t,
        point: { x: ox + dx * hit.t, y: oy + dy * hit.t, z: oz + dz * hit.t },
        normal: { x: hit.nx, y: hit.ny, z: hit.nz },
        surface: o.material || 'wood',
        kind: o.kind,
      };
      bestMat = o.material || 'wood';
    }
  }
  if (best) best.surface = bestMat;
  return best;
}

// 视线是否被地形/建筑遮挡（eye → eye）
export function losBlocked(ox, oy, oz, ex, ey, ez) {
  const dx = ex - ox, dy = ey - oy, dz = ez - oz;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 0.05) return false;
  const hit = raycastWorld(ox, oy, oz, dx, dy, dz, dist);
  return !!hit && hit.t < dist - 0.15;
}

// ============================================================
// 九、据点 / 出生 / 其它工具
// ============================================================

export function zoneOf(x, z) {
  for (const zn of ZONES) {
    const dx = x - zn.x, dz = z - zn.z;
    if (dx * dx + dz * dz <= zn.r * zn.r) return zn;
  }
  return null;
}

export function pickSpawn(team = 'alpha', rng = Math.random) {
  const list = SPAWNS[team] || SPAWNS.alpha;
  for (let i = 0; i < 10; i++) {
    const s = list[Math.floor(rng() * list.length)];
    let blocked = false;
    for (const o of COLLIDERS) {
      if (circleOverlapsBox(s.x, s.z, WORLD.playerRadius + 0.5, o)) { blocked = true; break; }
    }
    if (!blocked) return { x: s.x, z: s.z };
  }
  return { x: list[0].x, z: list[0].z };
}

export function isWalkableAt(x, z, slopeLimit = WORLD.maxSlope) {
  if (Math.abs(x) > WORLD.half - 3 || Math.abs(z) > WORLD.half - 3) return false;
  const g = heightAt(x, z);
  const R = WORLD.playerRadius + 0.35;
  for (const o of COLLIDERS) {
    if (o.y1 <= g + 0.25) continue;                          // 顶面低于可跨越台阶：视为可走
    if (o.y0 > g + WORLD.playerHeight) continue;             // 门楣等头顶以上构件不挡路
    if (circleOverlapsBox(x, z, R, o)) return false;
  }
  const n = terrainNormal(x, z);
  const slope = Math.hypot(n.x, n.z) / Math.max(0.001, n.y);
  return slope <= slopeLimit;
}

// 供 AI/小地图使用的常量组合
export const WORLD_INFO = {
  hills: HILLS,
  roads: ROADS,
  houses: HOUSES,
  zones: ZONES,
};
