// ===== 共享地图数据 + 3D 平台碰撞（服务器与客户端共用，保证预测一致）=====
import { WEAPONS, STARTING_WEAPONS, PICKUP_WEAPONS, WEAPON_ORDER } from './weapons.js';

export { WEAPONS, STARTING_WEAPONS, PICKUP_WEAPONS, WEAPON_ORDER };
export { weaponOf, falloffMultiplier, currentSpread, shotDamage, isWeaponId } from './weapons.js';

export const WORLD = {
  size: 120,            // 竞技场边长（大图）
  half: 60,
  maxPlayers: 8,
  playerRadius: 0.55,
  playerHeight: 1.8,
  eyeHeight: 1.55,
  moveSpeed: 10,
  jumpSpeed: 8,         // 跳跃初速 → 最高约 1.6m
  gravity: 20,
  damage: 20,           // 身体伤害（5 枪击倒 100 血）
  headshotMult: 2.25,   // 爆头倍率 → 45
  headY: 1.68,          // 头部球心高度偏移
  headR: 0.32,          // 头部判定半径
  bodyY: 0.75,          // 身体球心高度偏移
  bodyR: 0.75,          // 身体判定半径（顶部 1.5，不罩住头部）
  maxHp: 100,
  respawnTime: 2.5,
  stateHz: 20,
  shootRange: 80,       // 大图拉大射程
  adsFov: 45,           // 瞄准（ADS）时的 FOV
  aimSpeedMult: 0.55,   // 瞄准时移速倍率
  aimSpreadMult: 0.4,   // 瞄准时散布倍率
  shieldMax: 50,        // 护盾上限
  speedBoostMs: 8000,   // 加速持续时间
  speedBoostMult: 1.5,  // 加速移速倍率
};

// 道具类型（地面随机刷新）：功能道具 + 可在地图上争夺的武器
// 武器详细数值见 shared/weapons.js
export const ITEM_TYPES = ['medkit', 'shield', 'speed', ...PICKUP_WEAPONS];

// 地面道具配置
export const ITEMS = {
  max: 4,
  spawnMin: 8000, spawnMax: 15000,   // 每隔 8~15 秒补一个
  pickupRadius: 1.6,
};

// 地形：长方体（x/z 为中心，w/d 为沿 X/Z 的长宽，h 为高，底部贴地）
// kind：arena=中央擂台, platform=可跳平台, wall=高掩体墙
export const TERRAIN = [
  // 中央擂台（1.2m，可直接跳上）
  { x: 0,    z: 0,    w: 12, d: 12, h: 1.2, kind: 'arena' },
  // 可跳平台（0.5~1.2m）
  { x: -20,  z: -15,  w: 5,  d: 5,  h: 0.8, kind: 'platform' },
  { x: 20,   z: -15,  w: 5,  d: 5,  h: 0.8, kind: 'platform' },
  { x: -20,  z: 15,   w: 5,  d: 5,  h: 0.8, kind: 'platform' },
  { x: 20,   z: 15,   w: 5,  d: 5,  h: 0.8, kind: 'platform' },
  { x: 0,    z: -30,  w: 6,  d: 4,  h: 1.0, kind: 'platform' },
  { x: 0,    z: 30,   w: 6,  d: 4,  h: 1.0, kind: 'platform' },
  { x: -35,  z: 0,    w: 4,  d: 6,  h: 1.0, kind: 'platform' },
  { x: 35,   z: 0,    w: 4,  d: 6,  h: 1.0, kind: 'platform' },
  { x: -15,  z: -35,  w: 4,  d: 4,  h: 0.6, kind: 'platform' },
  { x: 15,   z: -35,  w: 4,  d: 4,  h: 0.6, kind: 'platform' },
  { x: -15,  z: 35,   w: 4,  d: 4,  h: 0.6, kind: 'platform' },
  { x: 15,   z: 35,   w: 4,  d: 4,  h: 0.6, kind: 'platform' },
  { x: -45,  z: -20,  w: 4,  d: 4,  h: 1.2, kind: 'platform' },
  { x: 45,   z: -20,  w: 4,  d: 4,  h: 1.2, kind: 'platform' },
  { x: -45,  z: 20,   w: 4,  d: 4,  h: 1.2, kind: 'platform' },
  { x: 45,   z: 20,   w: 4,  d: 4,  h: 1.2, kind: 'platform' },
  { x: 0,    z: -45,  w: 5,  d: 3,  h: 0.5, kind: 'platform' },
  { x: 0,    z: 45,   w: 5,  d: 3,  h: 0.5, kind: 'platform' },
  // 高掩体墙（2.2~2.8m，跳不上去）
  { x: -30,  z: -30,  w: 5,  d: 5,  h: 2.6, kind: 'wall' },
  { x: 30,   z: -30,  w: 5,  d: 5,  h: 2.6, kind: 'wall' },
  { x: -30,  z: 30,   w: 5,  d: 5,  h: 2.6, kind: 'wall' },
  { x: 30,   z: 30,   w: 5,  d: 5,  h: 2.6, kind: 'wall' },
  { x: 0,    z: -20,  w: 8,  d: 2,  h: 2.2, kind: 'wall' },
  { x: 0,    z: 20,   w: 8,  d: 2,  h: 2.2, kind: 'wall' },
  { x: -20,  z: 0,    w: 2,  d: 8,  h: 2.2, kind: 'wall' },
  { x: 20,   z: 0,    w: 2,  d: 8,  h: 2.2, kind: 'wall' },
  { x: -40,  z: -10,  w: 3,  d: 6,  h: 2.8, kind: 'wall' },
  { x: 40,   z: -10,  w: 3,  d: 6,  h: 2.8, kind: 'wall' },
  { x: -40,  z: 10,   w: 3,  d: 6,  h: 2.8, kind: 'wall' },
  { x: 40,   z: 10,   w: 3,  d: 6,  h: 2.8, kind: 'wall' },
  { x: 0,    z: -40,  w: 6,  d: 2,  h: 2.4, kind: 'wall' },
  { x: 0,    z: 40,   w: 6,  d: 2,  h: 2.4, kind: 'wall' },
];

// 边界墙：可见且参与碰撞
export const BOUNDARY = [
  { x: 0,            z: -(WORLD.half - 0.25), w: WORLD.size + 1, d: 0.5, h: 4 },
  { x: 0,            z:  (WORLD.half - 0.25), w: WORLD.size + 1, d: 0.5, h: 4 },
  { x: -(WORLD.half - 0.25), z: 0, w: 0.5, d: WORLD.size + 1, h: 4 },
  { x:  (WORLD.half - 0.25), z: 0, w: 0.5, d: WORLD.size + 1, h: 4 },
];

export const COLLIDERS = [...TERRAIN, ...BOUNDARY];

export const SPAWNS = [
  { x: -50, z: -50 }, { x: 50, z: -50 },
  { x: -50, z: 50 },  { x: 50, z: 50 },
  { x: 0,   z: -55 }, { x: 0,   z: 55 },
  { x: -55, z: 0 },   { x: 55,  z: 0 },
];

export const PLAYER_COLORS = [
  0x7fc4f5, 0x5fd0c8, 0x8f9ff0, 0xb08fe0,
  0x7fe0c0, 0xf0b060, 0xe080a0, 0x90d080,
];
// AI 对手配色：友军浅绿、敌军浅红，便于区分
export const BOT_COLORS = { ally: 0x8fd88f, enemy: 0xe88a8a };

// AI 配置（服务器使用；BOTS_MAX=0 可关闭）
export const BOTS = {
  max: 3,                              // 最多 3 个敌军 AI
  weapon: 'pistol',                    // AI 固定用手枪（不受弹匣/换弹限制，保持陪练节奏）
  firstMin: 10000, firstMax: 10000,    // 10 秒刷一个
  nextMin: 10000, nextMax: 10000,
  tick: 250,
  visionRadius: 20,                    // 视野半径（20m）
  fovDeg: 160,                         // 视野角度（160°）
  loseMemoryMs: 5000,                  // 失去视野 5 秒后放弃追踪、随机游走
  fireMin: 900, fireMax: 1600,         // 射速区间（较慢）
  shootRange: 20,                      // 只在视野内射击
  aimErr: 0.3,
  jitterYaw: 0.08, jitterPitch: 0.06,  // 瞄准误差（打不太准）
  damageMult: 0.5,                     // AI 伤害倍率（身体 10、爆头约 22）
  moveChance: 0.8,
};

// 圆（玩家）与 AABB（箱子）是否在水平面上重叠
export function circleOverlapsBox(x, z, r, o) {
  const hw = o.w / 2, hd = o.d / 2;
  const cx = Math.max(o.x - hw, Math.min(x, o.x + hw));
  const cz = Math.max(o.z - hd, Math.min(z, o.z + hd));
  const dx = x - cx, dz = z - cz;
  // 加极小容差，避免浮点误差导致的贴脸“粘墙/空气墙”判定
  return dx * dx + dz * dz < r * r - 1e-9;
}

// 3D 平台物理：水平推挤 + 重力 + 落地/撞头 + 地面。
export function stepPlayerPhysics(b, dt) {
  const r = b.radius ?? WORLD.playerRadius;
  const h = b.height ?? WORLD.playerHeight;

  for (const o of COLLIDERS) {
    if (b.y >= o.h) continue;
    if (b.y + h <= 0) continue;
    if (!circleOverlapsBox(b.x, b.z, r, o)) continue;
    const hw = o.w / 2, hd = o.d / 2;
    const minX = o.x - hw, maxX = o.x + hw;
    const minZ = o.z - hd, maxZ = o.z + hd;
    const cx = Math.max(minX, Math.min(b.x, maxX));
    const cz = Math.max(minZ, Math.min(b.z, maxZ));
    const dx = b.x - cx, dz = b.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 === 0) {
      const pushX = Math.min(b.x - minX, maxX - b.x);
      const pushZ = Math.min(b.z - minZ, maxZ - b.z);
      if (pushX < pushZ) b.x = b.x < o.x ? minX - r : maxX + r;
      else b.z = b.z < o.z ? minZ - r : maxZ + r;
    } else {
      const d = Math.sqrt(d2);
      b.x = cx + (dx / d) * r;
      b.z = cz + (dz / d) * r;
    }
  }

  const prevY = b.y;
  b.vy -= WORLD.gravity * dt;
  b.y += b.vy * dt;

  b.grounded = false;
  if (b.y <= 0) {
    b.y = 0; b.vy = 0; b.grounded = true;
  } else if (b.vy <= 0) {
    let bestTop = -1;
    for (const o of COLLIDERS) {
      if (prevY >= o.h && b.y <= o.h && circleOverlapsBox(b.x, b.z, r, o)) {
        if (o.h > bestTop) bestTop = o.h;
      }
    }
    if (bestTop >= 0) { b.y = bestTop; b.vy = 0; b.grounded = true; }
  } else if (b.vy > 0) {
    for (const o of COLLIDERS) {
      if (b.y + h >= o.h && prevY + h <= o.h && circleOverlapsBox(b.x, b.z, r, o)) {
        b.y = o.h - h; b.vy = 0; b.grounded = false;
        break;
      }
    }
  }
  return b;
}