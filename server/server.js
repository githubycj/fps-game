// ===== 郊区战场 SUBURBAN FRONT · 权威游戏服务器 =====
// 职责：
//   1. HTTP 静态托管 dist/ + WebSocket 实时对战（同端口、单局、无房间）
//   2. 权威移动：一律复用 shared/world.js 的地形/碰撞/物理（movePlayerHorizontal + stepPlayerPhysics）
//   3. 权威命中：shared hitboxesFor 命中盒 + shared raycastWorld 世界遮挡（禁止穿墙）
//   4. 玩法：据点争夺 Domination（3 据点 / 人数加速 / 争夺暂停 / 无人回退 / 每秒得分 / 胜负 / 8s 重置）
//   5. 战术机动：冲刺（体力）、蹲下、滑铲（冲刺中按蹲）、跳跃；姿态进入快照并影响散布/命中盒
//   6. 连杀奖励：5 连杀（不死）→ 全队 UAV 10s（state 广播 uav 截止时间 + uav_start 事件）
//   7. 道具：3 个固定武器箱（30s 刷新）+ ITEM_SPOTS 医疗/护盾/加速（8~15s 补货）
//   8. AI：server/ai.js 的 aiUpdate(bot, now, ctx) 每 200ms 决策；server/nav.js 的 buildNav() 启动时建一次；
//      AI 移动由本服务器用共享物理推进，AI 开火由本服务器校验并调用 handleShoot
//   9. 反作弊：消息频率限制 + 速度上限校验 + 服务器权威弹药/换弹/切枪/射速
//
// 说明：地形/物理/命中盒/射线绝不在本文件重复实现，全部来自 shared/world.js。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

// ---- 共享数据模块（命名空间导入 + 兜底，防止 shared 短暂未就绪时服务器直接崩溃）----
import * as worldMod from '../shared/world.js';
import * as weaponsMod from '../shared/weapons.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 3001);
const DEBUG = /^(1|true|yes|on)$/i.test(String(process.env.DEBUG || ''));
const isMain = !!(process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url);

// ============================================================
// 一、共享世界/武器数据（spec §3 §5；全部复用，不复制地形逻辑）
// ============================================================

// 世界常量兜底（正常情况完全由 shared/world.js 提供）
const W = worldMod.WORLD || {
  size: 140, half: 70, maxPlayers: 8,
  playerRadius: 0.42, playerHeight: 1.8, crouchHeight: 1.22, slideHeight: 0.95,
  eyeHeight: 1.64, crouchEyeHeight: 1.05, slideEyeHeight: 0.82,
  walkSpeed: 5.4, sprintSpeed: 8.4, crouchSpeed: 2.5,
  gravity: 22, jumpSpeed: 6.8, maxStep: 0.6, maxSlope: 0.9,
  staminaMax: 100, sprintDrain: 22, staminaRegen: 18, staminaRegenDelay: 0.8,
  jumpStaminaCost: 12, slideDuration: 0.7, slideSpeed: 9.6, slideCooldown: 1.2,
  maxHp: 100, respawnTime: 3, stateHz: 20, shootRange: 200, adsSpeedMult: 0.55,
  headY: 1.68, headR: 0.23, bodyBottom: 0.42, bodyTop: 1.57, bodyR: 0.33,
  legsBottom: 0.1, legsTop: 0.92, legsR: 0.27,
};
const ZONE_DEFS = worldMod.ZONES || [
  { id: 'A', name: '西村', x: -34, z: 6, r: 9 },
  { id: 'B', name: '中央广场', x: 0, z: 0, r: 10 },
  { id: 'C', name: '东站', x: 34, z: 6, r: 9 },
];
const SPAWNS = worldMod.SPAWNS || { alpha: [{ x: 0, z: 52 }], bravo: [{ x: 0, z: -52 }], all: [] };
const CRATE_SPOTS = worldMod.CRATE_SPOTS || [
  { x: -34, z: 6, type: 'ak47' },
  { x: 0, z: 0, type: 'sniper' },
  { x: 34, z: 6, type: 'shotgun' },
];
const ITEM_SPOTS = worldMod.ITEM_SPOTS || [];
const AI_CONFIG = worldMod.AI_CONFIG || {
  max: 5, allyCount: 2, enemyCount: 3, tickMs: 200, visionRadius: 55, fovDeg: 110,
  shootRange: 55, damageMult: 1, healthMult: 1, moveSpeedMult: 0.94,
};
const ZONE_CAPTURE_TIME = worldMod.ZONE_CAPTURE_TIME ?? 6;
const ZONE_SCORE_RATE = worldMod.ZONE_SCORE_RATE ?? 1;
const MATCH_SCORE_TARGET = worldMod.MATCH_SCORE_TARGET ?? 240;
const MATCH_TIME_LIMIT = worldMod.MATCH_TIME_LIMIT ?? 600;
const UAV_KILLSTREAK = worldMod.UAV_KILLSTREAK ?? 5;
const UAV_DURATION = worldMod.UAV_DURATION ?? 10;

const PLAYER_COLORS = worldMod.PLAYER_COLORS || [0x6f9fc4, 0x7fae8f, 0x8f9fc4, 0xb08f6f, 0x6faeae, 0xc9a06a, 0xa06f7f, 0x8fb26f];
const BOT_COLORS = worldMod.BOT_COLORS || { ally: 0x6f9fc4, enemy: 0xc06a4e };

// 共享函数（全部来自 shared/world.js）
const heightAt = worldMod.heightAt || (() => 0);
const zoneOf = worldMod.zoneOf || ((x, z) => {
  for (const zn of ZONE_DEFS) {
    const dx = x - zn.x, dz = z - zn.z;
    if (dx * dx + dz * dz <= zn.r * zn.r) return zn;
  }
  return null;
});
const pickSpawnShared = worldMod.pickSpawn || null;
const spawnYawShared = worldMod.spawnYaw || null;
const movePlayerHorizontal = worldMod.movePlayerHorizontal || ((b, dx, dz) => {
  b.x += dx; b.z += dz;
  const lim = W.half - 3;
  b.x = Math.max(-lim, Math.min(lim, b.x));
  b.z = Math.max(-lim, Math.min(lim, b.z));
  return { blocked: false };
});
const stepPlayerPhysics = worldMod.stepPlayerPhysics || ((b, dt) => {
  b.vy -= W.gravity * dt;
  b.y += b.vy * dt;
  const g = heightAt(b.x, b.z);
  if (b.y <= g) { b.y = g; b.vy = 0; b.grounded = true; } else { b.grounded = false; }
  return b;
});
const hitboxesFor = worldMod.hitboxesFor || ((p) => {
  const k = p.stance === 'crouch' ? 0.68 : p.stance === 'slide' ? 0.52 : 1;
  const x = p.x, y = p.y, z = p.z;
  return {
    head: { x, y: y + W.headY * k, z, r: W.headR },
    body: { ax: x, ay: y + W.bodyBottom * k, az: z, bx: x, by: y + W.bodyTop * k, bz: z, r: W.bodyR },
    legs: { ax: x, ay: y + W.legsBottom * k, az: z, bx: x, by: y + W.legsTop * k, bz: z, r: W.legsR },
  };
});
const raycastWorldShared = worldMod.raycastWorld || null;
const losBlockedShared = worldMod.losBlocked || null;

// 武器数据（spec §5：伤害/爆头/腿/距离衰减/散布/弹药/换弹/ADS/射速/切枪）
const WEAPONS = weaponsMod.WEAPONS || {};
const STARTING_WEAPONS = weaponsMod.STARTING_WEAPONS || ['pistol', 'smg'];
const PICKUP_WEAPONS = weaponsMod.PICKUP_WEAPONS || ['ak47', 'shotgun', 'sniper'];
const AI_WEAPON_POOL = (weaponsMod.AI_WEAPONS && weaponsMod.AI_WEAPONS.length)
  ? weaponsMod.AI_WEAPONS
  : ['smg', 'ak47', 'shotgun', 'pistol'];
const WEAPON_ORDER = weaponsMod.WEAPON_ORDER || ['pistol', 'smg', 'ak47', 'shotgun', 'sniper'];
const weaponOf = weaponsMod.weaponOf || ((id) => WEAPONS[id] || WEAPONS.pistol || {});
const isWeaponId = weaponsMod.isWeaponId || ((id) => Object.prototype.hasOwnProperty.call(WEAPONS, id));
const currentSpread = weaponsMod.currentSpread || ((w, o = {}) => {
  let s = (w.spread || 0.01) + (o.moving ? (w.spreadMoving || 0) : 0) + (o.sprinting ? (w.spreadSprint || 0.09) : 0)
    + Math.min(o.shots || 0, 30) * (w.spreadPerShot || 0);
  if (o.crouched) s *= (w.spreadCrouchMult ?? 1);
  if (o.ads) s *= (w.adsSpreadMult || 0.4);
  return Math.min(s, w.spreadMax || 0.12);
});
const shotDamage = weaponsMod.shotDamage || ((w, { part = 'body', dist = 0 } = {}) => {
  let base = w.damage || 20;
  if (part === 'head') base *= (w.headshotMult || 2.2);
  else if (part === 'legs') base *= (w.legMult || 0.8);
  return Math.max(1, Math.round(base));
});

// 服务器私有规则（shared 未定义的部分，集中在这里，便于 Lead/HUD 对齐）
const RULES = {
  shieldMax: 100,             // 钢制插板（护甲）上限：出生自带，只保护躯干
  armorReduce: 0.8,           // 躯干伤害 80% 由插板吸收，20% 进入生命
  matchCountdown: 10,         // 真人按空格后 10 秒倒计时
  speedBoostMs: 8000,         // 加速道具持续
  speedBoostMult: 1.5,        // 加速移速倍率
  pickupRadius: 1.7,          // 拾取半径
  crateRespawnMs: 30000,      // 武器箱 30s 刷新
  itemRespawnMin: 8000,       // 消耗品补货 8~15s
  itemRespawnMax: 15000,
  matchResetDelay: 8,         // 赛后 8s 重置
  killfeedMax: 8,
  inputTimeoutMs: 350,        // 真人客户端输入超时（停止移动）
  maxMessagesPerSec: 200,     // 反作弊：消息频率上限
  maxPlayers: W.maxPlayers || 8,
};
const CONSUMABLE_TYPES = ['medkit', 'shield', 'speed'];
const TICK_MS = 1000 / (W.stateHz || 20);
const AI_DECISION_MS = Math.max(100, AI_CONFIG.tickMs || 200);

// ============================================================
// 二、通用工具
// ============================================================

const DEG = Math.PI / 180;
const clampNum = (v, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;
};
const round3 = (v) => Math.round(v * 1000) / 1000;
const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const randRange = (min, max) => min + Math.random() * (max - min);
function normalizeYaw(a) {
  let y = Number.isFinite(a) ? a : 0;
  while (y > Math.PI) y -= Math.PI * 2;
  while (y < -Math.PI) y += Math.PI * 2;
  return y;
}
function wrapAngle(a) {
  let y = a;
  while (y > Math.PI) y -= Math.PI * 2;
  while (y < -Math.PI) y += Math.PI * 2;
  return y;
}
// yaw=0 看向 -Z；pitch 向上为正
function dirFromYawPitch(yaw, pitch) {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}
function eyeHeightFor(p) {
  if (p.stance === 'slide') return W.slideEyeHeight ?? W.eyeHeight * 0.6;
  if (p.stance === 'crouch') return W.crouchEyeHeight ?? W.eyeHeight * 0.65;
  return W.eyeHeight;
}
function bodyCenterY(p) {
  const hb = hitboxesFor(p);
  return (hb.body.ay + hb.body.by) * 0.5;
}
const emptyInput = () => ({ mx: 0, mz: 0, jump: false, sprint: false, crouch: false, aim: false, seq: 0 });

// 射线-球（返回最近正 t，未命中 Infinity）
function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const lx = cx - ox, ly = cy - oy, lz = cz - oz;
  const b = lx * dx + ly * dy + lz * dz;
  const c = lx * lx + ly * ly + lz * lz - r * r;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const sq = Math.sqrt(disc);
  const t1 = b - sq;
  if (t1 > 1e-6) return t1;
  const t2 = b + sq;
  return t2 > 1e-6 ? t2 : Infinity;
}
// 射线-胶囊（a/b 为轴两端点，r 半径；返回最近正 t，未命中 Infinity）
function rayCapsule(ox, oy, oz, dx, dy, dz, cap) {
  const abx = cap.bx - cap.ax, aby = cap.by - cap.ay, abz = cap.bz - cap.az;
  const abab = abx * abx + aby * aby + abz * abz;
  const r = cap.r;
  if (abab < 1e-8) return raySphere(ox, oy, oz, dx, dy, dz, cap.ax, cap.ay, cap.az, r);
  const mx = ox - cap.ax, my = oy - cap.ay, mz = oz - cap.az;
  const md = dx * abx + dy * aby + dz * abz;
  const ma = mx * abx + my * aby + mz * abz;
  const A = 1 - (md * md) / abab;
  const B = 2 * (mx * dx + my * dy + mz * dz - (ma * md) / abab);
  const C = mx * mx + my * my + mz * mz - (ma * ma) / abab - r * r;
  let best = Infinity;
  if (Math.abs(A) > 1e-9) {
    const disc = B * B - 4 * A * C;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      for (const t of [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) {
        if (t <= 1e-6) continue;
        const h = (ma + t * md) / abab;
        if (h >= 0 && h <= 1 && t < best) best = t;
      }
    }
  }
  // 两端球帽
  const c1 = raySphere(ox, oy, oz, dx, dy, dz, cap.ax, cap.ay, cap.az, r);
  const c2 = raySphere(ox, oy, oz, dx, dy, dz, cap.bx, cap.by, cap.bz, r);
  return Math.min(best, c1, c2);
}
// 世界遮挡：优先用共享 raycastWorld；退化时用共享 losBlocked
function rayHitWorld(ox, oy, oz, dx, dy, dz, maxDist) {
  if (raycastWorldShared) return raycastWorldShared(ox, oy, oz, dx, dy, dz, maxDist);
  return null;
}
function losBlocked(ox, oy, oz, ex, ey, ez) {
  if (losBlockedShared) return losBlockedShared(ox, oy, oz, ex, ey, ez);
  const dx = ex - ox, dy = ey - oy, dz = ez - oz;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 0.05) return false;
  const hit = rayHitWorld(ox, oy, oz, dx, dy, dz, dist);
  return !!hit && hit.t < dist - 0.15;
}

// ============================================================
// 三、全局对局状态（唯一权威）
// ============================================================

const players = new Map();      // id -> player（含真人 + AI）
const items = new Map();        // id -> 地面道具（武器箱/消耗品）
let nextId = 1;
let itemSeq = 1;
let botSeq = 1;

// 据点运行时状态
const zoneRuntime = ZONE_DEFS.map((z) => ({
  id: z.id, name: z.name, x: z.x, z: z.z, r: z.r,
  owner: null,          // 'alpha' | 'bravo' | null
  capture: 0,           // -1..1：负=bravo 推进，正=alpha 推进
  contested: false,     // 双方同时在场 → 争夺暂停
  counts: { alpha: 0, bravo: 0 },
}));
const scores = { alpha: 0, bravo: 0 };
const match = {
  mode: 'domination',
  // 'waiting'（等待真人按空格）→ 'countdown'（10s）→ 'playing' → 'ended'
  phase: 'waiting',
  countdown: 0,
  timeLeft: MATCH_TIME_LIMIT,
  target: MATCH_SCORE_TARGET,
  winner: null,
  round: 1,
  endedAt: 0,
};
const uav = { alpha: 0, bravo: 0 };   // 队伍 UAV 截止时间（epoch ms，0=无）
const killfeed = [];                  // 最近击杀信息（state.killfeed）

// 固定武器箱刷新状态
const crateState = CRATE_SPOTS.map((spot, index) => ({ spot, index, itemId: null, respawnAt: 0 }));
// 消耗品固定点补货状态
const pickupSpots = ITEM_SPOTS.map((spot, index) => ({ spot, index, itemId: null, respawnAt: 0 }));

// ============================================================
// 四、AI / 导航模块接入（server/ai.js + server/nav.js，允许缺失时兜底）
// ============================================================

let aiModule = null;
let navModule = null;
let aiImpl = null;         // ai.js: aiUpdate(bot, now, ctx)
let createBrainImpl = null;
let NAV = null;            // nav.js: buildNav() 结果
let navTried = false;

async function ensureAiModules() {
  if (!aiModule) {
    try { aiModule = await import('./ai.js'); } catch (err) {
      aiModule = null;
      if (isMain) console.warn('[server] server/ai.js 尚未就绪，使用内置兜底 AI：' + (err && err.message));
    }
  }
  if (!navModule) {
    try { navModule = await import('./nav.js'); } catch (err) {
      navModule = null;
      if (isMain) console.warn('[server] server/nav.js 尚未就绪（AI 将使用简化导航）：' + (err && err.message));
    }
  }
  aiImpl = (aiModule && typeof aiModule.aiUpdate === 'function') ? aiModule.aiUpdate : null;
  createBrainImpl = (aiModule && typeof aiModule.createBrain === 'function') ? aiModule.createBrain : null;
  return aiImpl;
}
function ensureNav() {
  if (NAV) return NAV;
  if (navTried) return NAV;
  navTried = true;
  if (navModule && typeof navModule.buildNav === 'function') {
    try {
      NAV = navModule.buildNav();
      if (isMain) console.log('[server] 导航网格构建完成');
    } catch (err) {
      NAV = null;
      if (isMain) console.warn('[server] nav 构建失败，AI 使用简化导航：' + (err && err.message));
    }
  }
  return NAV;
}

// 简易事件总线：供 AI 听觉/情报共享使用（on/off/emit，无 once）
const eventBus = {
  _handlers: new Map(),
  on(type, fn) {
    if (typeof fn !== 'function') return () => {};
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(fn);
    return () => this.off(type, fn);
  },
  off(type, fn) {
    const set = this._handlers.get(type);
    if (set) set.delete(fn);
  },
  emit(type, data) {
    const set = this._handlers.get(type);
    if (!set) return;
    for (const fn of set) {
      try { fn(data); } catch (err) {
        if (isMain) console.warn('[server] eventBus handler 异常(' + type + ')：' + (err && err.message));
      }
    }
  },
};
// 兼容部分 AI 实现可能使用的 subscribe 命名
eventBus.subscribe = (type, fn) => eventBus.on(type, fn);

// AI 听觉噪声事件批（脚步声）：每次 AI 决策前把“上一批”交给 ctx.events（ai.js 按 12m/敌我过滤），
// 这样 ai.js 的 ctx.events 路径不会重复处理历史事件；同时 eventBus 也 emit 一份供未来订阅。
let aiNoiseEvents = [];
let aiNoiseSeq = 0;
function emitNoise(ev) {
  aiNoiseSeq += 1;
  aiNoiseEvents.push({ seq: aiNoiseSeq, at: Date.now(), ...ev });
  if (aiNoiseEvents.length > 240) aiNoiseEvents.splice(0, aiNoiseEvents.length - 240);
}

// AI 上下文（spec §6.7 ctx 字段 + 额外便利字段）
function buildAiCtx(now = Date.now(), noiseBatch = null) {
  return {
    players,
    nav: ensureNav(),
    zones: zoneRuntime,
    items,
    eventBus,
    events: noiseBatch || [],
    world: {
      WORLD: W,
      heightAt,
      losBlocked,
      raycastWorld: rayHitWorld,
      movePlayerHorizontal,
      stepPlayerPhysics,
      hitboxesFor,
      zoneOf,
    },
    rand: (min = 0, max = 1) => (typeof min === 'number' && typeof max === 'number' ? randRange(min, max) : Math.random()),
    rng: Math.random,
    teams: ['alpha', 'bravo'],
    requestFire: (bot, yaw, pitch) => requestBotFire(bot, yaw, pitch),
    requestReload: (bot) => (bot ? startReload(bot) : false),
    requestSwitch: (bot, id) => (bot ? switchWeapon(bot, id) : false),
    canSee,
    scores,
    match,
    uav,
    killfeed,
    now,
    dt: AI_DECISION_MS / 1000,
  };
}

// ============================================================
// 五、玩家 / 出生 / 重生
// ============================================================

function sanitizeName(name) {
  const raw = String(name ?? '').trim().slice(0, 12);
  return raw || '玩家';
}
function freeSpawn(team) {
  // 优先用 shared pickSpawn（避开碰撞体），并尽量避开其他存活玩家
  for (let attempt = 0; attempt < 10; attempt++) {
    let s = null;
    if (pickSpawnShared) s = pickSpawnShared(team, Math.random);
    if (!s) {
      const list = SPAWNS[team] || SPAWNS.all || [];
      s = list.length ? list[Math.floor(Math.random() * list.length)] : { x: 0, z: team === 'bravo' ? -52 : 52 };
    }
    let ok = true;
    for (const p of players.values()) {
      if (!p.alive || p === undefined) continue;
      const dx = p.x - s.x, dz = p.z - s.z;
      if (dx * dx + dz * dz < 2.5 * 2.5) { ok = false; break; }
    }
    if (ok) return s;
  }
  const list = SPAWNS[team] || SPAWNS.all || [{ x: 0, z: 50 }];
  return list[0];
}
function yawForSpawn(spawn) {
  if (spawnYawShared) return normalizeYaw(spawnYawShared(spawn));
  return normalizeYaw(Math.atan2(spawn.x, spawn.z));
}
function fullAmmo(id) {
  const w = weaponOf(id);
  return { mag: w.magSize ?? 12, reserve: w.reserveStart ?? Infinity };
}
function makeLoadout() {
  const owned = {};
  const ammo = {};
  for (const id of STARTING_WEAPONS) {
    if (!isWeaponId(id)) continue;
    owned[id] = true;
    ammo[id] = fullAmmo(id);
  }
  const first = Object.keys(owned)[0] || 'pistol';
  if (!owned[first]) { owned[first] = true; ammo[first] = fullAmmo(first); }
  return { owned, ammo, active: STARTING_WEAPONS[0] || first };
}
function ammoOf(p) {
  if (!p.ammo) p.ammo = {};
  if (!p.ammo[p.weapon]) p.ammo[p.weapon] = fullAmmo(p.weapon);
  return p.ammo[p.weapon];
}

// 创建真人玩家（加入 alpha 队）
function createPlayer(ws, name) {
  const team = 'alpha';
  const spawn = freeSpawn(team);
  const loadout = makeLoadout();
  const color = PLAYER_COLORS[nextId % PLAYER_COLORS.length];
  const player = {
    id: 'p' + nextId++,
    ws,
    bot: false,
    name: sanitizeName(name),
    team,
    color,
    // 位置/物理（y 为脚底高度）
    x: spawn.x, y: heightAt(spawn.x, spawn.z), z: spawn.z,
    vy: 0, grounded: true,
    yaw: yawForSpawn(spawn), pitch: 0,
    // 生命/状态
    hp: W.maxHp, maxHp: W.maxHp, alive: true, respawnAt: 0,
    shield: RULES.shieldMax, stamina: W.staminaMax, speedUntil: 0,
    // 机动
    stance: 'stand', sprinting: false, sliding: false, aiming: false,
    prevCrouch: false, slideUntil: 0, slideCdUntil: 0, slideDirX: 0, slideDirZ: 0,
    speedNow: 0,
    // 武器（服务器权威）
    weapon: loadout.active,
    owned: loadout.owned,
    ammo: loadout.ammo,
    reloadUntil: 0, swapUntil: 0, lastFire: 0, lastShotAt: 0, burst: 0,
    // 战绩
    kills: 0, deaths: 0, streak: 0,
    // 网络
    input: emptyInput(),
    lastInputAt: Date.now(),
    speedMult: 1,
    stepDist: 0,
    cheatCount: 0,
  };
  players.set(player.id, player);
  return player;
}

// 切换/拾取后：保证当前武器在持有列表里
function ensureWeaponValid(p) {
  if (!p.owned) p.owned = {};
  if (!p.owned[p.weapon]) {
    p.weapon = 'pistol';
    p.owned.pistol = true;
    p.ammo = p.ammo || {};
    p.ammo.pistol = fullAmmo('pistol');
  }
}

// 重生：回本队出生区，补满血量/体力/弹药（不没收已拾取武器）
function respawn(p) {
  const team = p.team || 'alpha';
  const spawn = freeSpawn(team);
  p.x = spawn.x;
  p.z = spawn.z;
  p.y = heightAt(spawn.x, spawn.z);
  p.vy = 0;
  p.grounded = true;
  p.yaw = yawForSpawn(spawn);
  p.pitch = 0;
  p.hp = p.maxHp ?? W.maxHp;
  p.alive = true;
  p.respawnAt = 0;
  p.shield = RULES.shieldMax;
  p.speedUntil = 0;
  p.stamina = W.staminaMax;
  p.stance = 'stand';
  p.sprinting = false;
  p.sliding = false;
  p.aiming = false;
  p.prevCrouch = false;
  p.slideUntil = 0;
  p.slideCdUntil = 0;
  p.reloadUntil = 0;
  p.swapUntil = 0;
  p.lastFire = 0;
  p.lastShotAt = 0;
  p.burst = 0;
  p.streak = 0;
  p.input = emptyInput();
  p.lastInputAt = Date.now();
  p.speedNow = 0;
  p.stepDist = 0;
  ensureWeaponValid(p);
  for (const id of Object.keys(p.owned)) p.ammo[id] = fullAmmo(id);
  send(p.ws, {
    t: 'respawn', id: p.id, x: round3(p.x), y: round3(p.y), z: round3(p.z), yaw: p.yaw,
  });
  return p;
}

// ============================================================
// 六、快照 / 消息
// ============================================================

function uavDeadline(team, now = Date.now()) {
  return (uav[team] || 0) > now ? uav[team] : 0;
}
function zoneSnapshot() {
  return zoneRuntime.map((z) => {
    const abs = Math.min(1, Math.abs(z.capture));
    let capturing = null;
    if (abs < 0.999) capturing = z.capture > 0 ? 'alpha' : z.capture < 0 ? 'bravo' : null;
    return {
      id: z.id, name: z.name, x: z.x, z: z.z, r: z.r,
      owner: z.owner,
      progress: abs,
      capture: z.capture,
      capturing,
      contested: z.contested,
      counts: { alpha: z.counts.alpha, bravo: z.counts.bravo },
    };
  });
}
function itemSnapshot(it) {
  return {
    id: it.id, kind: it.kind, type: it.type,
    x: round3(it.x), y: round3(it.y ?? heightAt(it.x, it.z)), z: round3(it.z),
  };
}
function snapshot(p) {
  const now = Date.now();
  const a = p.ammo && p.ammo[p.weapon] ? p.ammo[p.weapon] : { mag: 0, reserve: 0 };
  return {
    id: p.id,
    name: p.name,
    color: p.color,
    team: p.team,
    x: round3(p.x), y: round3(p.y), z: round3(p.z),
    yaw: p.yaw, pitch: p.pitch,
    hp: p.hp, maxHp: p.maxHp ?? W.maxHp,
    alive: !!p.alive,
    shield: p.shield || 0,
    stamina: Math.round(p.stamina ?? W.staminaMax),
    weapon: p.weapon,
    ammo: { mag: a.mag, reserve: a.reserve === Infinity ? -1 : a.reserve },
    owned: p.owned ? Object.keys(p.owned) : ['pistol'],
    reloadUntil: p.reloadUntil || 0,
    reloading: (p.reloadUntil || 0) > now,
    swapUntil: p.swapUntil || 0,
    stance: p.stance || 'stand',
    sprint: !!p.sprinting,
    sliding: !!p.sliding,
    grounded: !!p.grounded,
    aiming: !!p.aiming,
    kills: p.kills || 0,
    deaths: p.deaths || 0,
    streak: p.streak || 0,
    speed: now < (p.speedUntil || 0),
    uav: now < (uav[p.team] || 0),
    respawnIn: p.alive ? 0 : Math.max(0, Math.ceil(((p.respawnAt || 0) - now) / 1000)),
    bot: p.bot ? true : undefined,
  };
}
function stateMessage(now = Date.now()) {
  const list = [];
  for (const p of players.values()) list.push(snapshot(p));
  return {
    t: 'state',
    ts: now,
    players: list,
    items: [...items.values()].map(itemSnapshot),
    zones: zoneSnapshot(),
    scores: { alpha: Math.round(scores.alpha * 10) / 10, bravo: Math.round(scores.bravo * 10) / 10 },
    match: {
      mode: match.mode,
      phase: match.phase,
      countdown: Math.max(0, Math.ceil(match.countdown)),
      timeLeft: Math.max(0, Math.ceil(match.timeLeft)),
      target: match.target,
      winner: match.winner,
      round: match.round,
    },
    uav: { alpha: uavDeadline('alpha', now), bravo: uavDeadline('bravo', now) },
    killfeed: killfeed.slice(-RULES.killfeedMax),
  };
}
function welcomeMessage(p) {
  return {
    t: 'welcome',
    id: p.id,
    color: p.color,
    team: p.team,
    spawn: { x: round3(p.x), y: round3(p.y), z: round3(p.z), yaw: p.yaw, team: p.team },
    maxPlayers: RULES.maxPlayers,
    players: [...players.values()].map(snapshot),
    zones: zoneSnapshot(),
    items: [...items.values()].map(itemSnapshot),
    mode: match.mode,
    match: {
      mode: match.mode, phase: match.phase, countdown: Math.max(0, Math.ceil(match.countdown)),
      timeLeft: Math.max(0, Math.ceil(match.timeLeft)),
      target: match.target, winner: match.winner,
    },
    scores: { alpha: Math.round(scores.alpha * 10) / 10, bravo: Math.round(scores.bravo * 10) / 10 },
    uav: { alpha: uavDeadline('alpha'), bravo: uavDeadline('bravo') },
  };
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(msg)); } catch { /* 忽略已断开的连接 */ }
  }
}
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const p of players.values()) {
    if (p.ws && p.ws.readyState === 1) {
      try { p.ws.send(data); } catch { /* 忽略 */ }
    }
  }
}
function broadcastExcept(ws, msg) {
  const data = JSON.stringify(msg);
  for (const p of players.values()) {
    if (p.ws && p.ws !== ws && p.ws.readyState === 1) {
      try { p.ws.send(data); } catch { /* 忽略 */ }
    }
  }
}

// ============================================================
// 七、武器：换弹 / 切枪 / 拾取
// ============================================================

function startReload(p) {
  const now = Date.now();
  if (!p.alive) return false;
  if ((p.reloadUntil || 0) > 0) return false;
  const w = weaponOf(p.weapon);
  const a = ammoOf(p);
  if (a.mag >= (w.magSize ?? 12)) return false;
  if (!(a.reserve > 0) && a.reserve !== Infinity) return false;
  const empty = a.mag <= 0;
  const durationSec = (empty ? (w.reloadEmptyTime ?? w.reloadTime) : w.reloadTime) ?? 1.8;
  p.reloadUntil = now + Math.round(durationSec * 1000);
  p.reloadWeapon = p.weapon;
  send(p.ws, { t: 'reload_start', weapon: p.weapon, duration: Math.round(durationSec * 1000) });
  return true;
}
function finishReload(p) {
  const id = p.reloadWeapon || p.weapon;
  const w = weaponOf(id);
  if (!p.ammo) p.ammo = {};
  if (!p.ammo[id]) p.ammo[id] = fullAmmo(id);
  const a = p.ammo[id];
  const need = (w.magSize ?? 12) - a.mag;
  const take = a.reserve === Infinity ? need : Math.min(need, a.reserve);
  a.mag += take;
  if (a.reserve !== Infinity) a.reserve = Math.max(0, a.reserve - take);
  p.reloadUntil = 0;
  p.reloadWeapon = 0;
  send(p.ws, {
    t: 'reload_done', weapon: id, mag: a.mag,
    reserve: a.reserve === Infinity ? -1 : a.reserve,
  });
  return true;
}
function switchWeapon(p, id) {
  const now = Date.now();
  if (!p || !id || !isWeaponId(id)) return false;
  if (!p.owned || !p.owned[id] || id === p.weapon) return false;
  if (now < (p.swapUntil || 0)) return false;
  const w = weaponOf(id);
  p.weapon = id;
  p.reloadUntil = 0;          // 切枪打断换弹
  p.reloadWeapon = 0;
  p.swapUntil = now + Math.round((w.swapTime ?? 0.4) * 1000);
  p.burst = 0;
  p.lastShotAt = 0;
  send(p.ws, { t: 'weapon_switch', weapon: id, duration: Math.round((w.swapTime ?? 0.4) * 1000) });
  return true;
}
// 拾取武器：加入持有并补满；instant=true 时立即切换（拾取武器箱不拖泥带水）
function grantWeapon(p, id, opts = {}) {
  if (!p || !isWeaponId(id)) return false;
  const w = weaponOf(id);
  p.owned = p.owned || {};
  p.ammo = p.ammo || {};
  p.owned[id] = true;
  p.ammo[id] = { mag: w.magSize ?? 12, reserve: w.reserveStart ?? Infinity };
  if (p.bot) p.ammo[id].reserve = Infinity;   // AI 备弹无限，避免长时间对局里“弹尽人亡”
  if (p.weapon === id) {
    p.reloadUntil = 0;
    return true;
  }
  const was = p.weapon;
  p.weapon = id;
  p.reloadUntil = 0;
  p.reloadWeapon = 0;
  p.burst = 0;
  p.lastShotAt = 0;
  p.swapUntil = opts.instant ? 0 : Date.now() + Math.round((w.swapTime ?? 0.4) * 1000);
  if (p.swapUntil > Date.now()) {
    send(p.ws, { t: 'weapon_switch', weapon: id, duration: p.swapUntil - Date.now(), picked: true, prev: was });
  } else if (opts.instant) {
    send(p.ws, { t: 'weapon_switch', weapon: id, duration: 0, picked: true, prev: was });
  }
  return true;
}

// ============================================================
// 八、道具：武器箱 + 消耗品
// ============================================================

function createItem(kind, type, x, z, extra = {}) {
  const item = {
    id: 'it' + itemSeq++,
    kind, type,
    x, z, y: heightAt(x, z),
    ...extra,
  };
  items.set(item.id, item);
  return item;
}
function spawnCrate(index) {
  const st = crateState[index];
  if (!st || st.itemId) return null;
  const it = createItem('crate', st.spot.type, st.spot.x, st.spot.z, { spotIndex: index });
  st.itemId = it.id;
  st.respawnAt = 0;
  return it;
}
function spawnPickupSpot(index, type) {
  const st = pickupSpots[index];
  if (!st || st.itemId) return null;
  const t = type || CONSUMABLE_TYPES[Math.floor(Math.random() * CONSUMABLE_TYPES.length)];
  const it = createItem('item', t, st.spot.x, st.spot.z, { spotIndex: index });
  st.itemId = it.id;
  st.respawnAt = 0;
  return it;
}
// 初始化地图道具：3 个固定武器箱 + ITEM_SPOTS 消耗品（ITEMS_MAX 控制消耗品数量）
function initItems() {
  // 对账：状态里有 itemId 但 items 已被清空（测试/重置场景）时重新生成
  for (const st of crateState) if (st.itemId && !items.has(st.itemId)) { st.itemId = null; st.respawnAt = 0; }
  for (const st of pickupSpots) if (st.itemId && !items.has(st.itemId)) { st.itemId = null; st.respawnAt = 0; }
  for (let i = 0; i < crateState.length; i++) spawnCrate(i);
  const max = Math.max(0, Number(process.env.ITEMS_MAX ?? pickupSpots.length));
  for (let i = 0; i < Math.min(max, pickupSpots.length); i++) spawnPickupSpot(i);
}
function updateItemRespawns(now) {
  for (const st of crateState) {
    if (!st.itemId && st.respawnAt && now >= st.respawnAt) spawnCrate(st.index);
  }
  for (const st of pickupSpots) {
    if (!st.itemId && st.respawnAt && now >= st.respawnAt) spawnPickupSpot(st.index);
  }
}
// spawnItem(type, x?, z?)：调试/测试入口，返回 item
function spawnItem(type, x, z) {
  let t = type;
  if (!t || (!isWeaponId(t) && CONSUMABLE_TYPES.indexOf(t) < 0 && t !== 'ammo')) {
    t = CONSUMABLE_TYPES[Math.floor(Math.random() * CONSUMABLE_TYPES.length)];
  }
  if (typeof x === 'number' && typeof z === 'number') {
    return createItem(isWeaponId(t) ? 'crate' : 'item', t,
      clampNum(x, -W.half + 3, W.half - 3), clampNum(z, -W.half + 3, W.half - 3));
  }
  const free = pickupSpots.filter((s) => !s.itemId);
  if (free.length) {
    const st = free[Math.floor(Math.random() * free.length)];
    // 调试生成武器 → 作为一个独立武器箱放在空闲道具点上（不占用该点的补货状态）
    if (isWeaponId(t)) return createItem('crate', t, st.spot.x, st.spot.z);
    return spawnPickupSpot(st.index, t);
  }
  return createItem(isWeaponId(t) ? 'crate' : 'item', t,
    randRange(-W.half + 8, W.half - 8), randRange(-W.half + 8, W.half - 8));
}
// 应用道具效果（玩家/AI 通用）
function applyItem(p, it) {
  if (!p || !it) return false;
  const now = Date.now();
  if (it.type === 'medkit') {
    p.hp = p.maxHp ?? W.maxHp;
  } else if (it.type === 'shield') {
    p.shield = RULES.shieldMax;
  } else if (it.type === 'speed') {
    p.speedUntil = now + RULES.speedBoostMs;
  } else if (it.type === 'ammo') {
    for (const id of Object.keys(p.owned || {})) {
      const w = weaponOf(id);
      p.ammo[id] = { mag: w.magSize ?? 12, reserve: w.reserveMax ?? w.reserveStart ?? Infinity };
    }
  } else if (isWeaponId(it.type)) {
    grantWeapon(p, it.type, { instant: true });   // 拾取武器立即切换并补满
  } else {
    return false;
  }
  send(p.ws, {
    t: 'pickup',
    itemId: it.id,
    kind: it.kind,
    type: it.type,
    weapon: p.weapon,
    hp: p.hp,
    shield: p.shield || 0,
    stamina: Math.round(p.stamina ?? W.staminaMax),
  });
  return true;
}
// 拾取检测（20Hz）
function updatePickups(now = Date.now()) {
  const r2 = RULES.pickupRadius * RULES.pickupRadius;
  for (const [id, it] of [...items]) {
    for (const p of players.values()) {
      if (!p.alive) continue;
      const dx = p.x - it.x, dz = p.z - it.z;
      if (dx * dx + dz * dz > r2) continue;
      if (Math.abs(p.y - it.y) > 1.6) continue;
      if (!applyItem(p, it)) continue;
      items.delete(id);
      if (it.spotIndex != null) {
        if (it.kind === 'crate') {
          const st = crateState[it.spotIndex];
          if (st) { st.itemId = null; st.respawnAt = now + RULES.crateRespawnMs; }
        } else {
          const st = pickupSpots[it.spotIndex];
          if (st) { st.itemId = null; st.respawnAt = now + randInt(RULES.itemRespawnMin, RULES.itemRespawnMax); }
        }
      }
      break;
    }
  }
}

// ============================================================
// 九、战斗：命中判定 / 伤害 / 击杀 / UAV
// ============================================================

// 友军伤害规则：AI 绝不误伤友军；两名真人同队时允许误伤（便于调试/测试），队友 AI 不受真人伤害
function canDamage(attacker, target) {
  if (!attacker || !target || attacker === target) return false;
  if (!target.alive) return false;
  if (attacker.team === target.team && (attacker.bot || target.bot)) return false;
  return true;
}

// 沿射线找最近的可命中目标：共享命中盒 + 共享世界射线遮挡
// 部位判定：先取 head / body / legs 三者的最近交点，再按命中点高度归入部位。
// （共享命中盒的 body 胶囊顶端球帽会包住头部、底端球帽会压住大腿，纯“最近几何体”会把爆头算成躯干，
//   因此这里按命中点高度带分类：≥ 头部球底 → 爆头；≤ 腿部胶囊顶 → 腿部；其余 → 躯干。）
function findHit(p, ox, oy, oz, dx, dy, dz, range) {
  let best = null;
  let bestT = Infinity;
  let bestPart = 'body';
  for (const q of players.values()) {
    if (!canDamage(p, q)) continue;
    const hb = hitboxesFor(q);
    let t = raySphere(ox, oy, oz, dx, dy, dz, hb.head.x, hb.head.y, hb.head.z, hb.head.r);
    const tBody = rayCapsule(ox, oy, oz, dx, dy, dz, hb.body);
    if (tBody < t) t = tBody;
    const tLegs = rayCapsule(ox, oy, oz, dx, dy, dz, hb.legs);
    if (tLegs < t) t = tLegs;
    if (t >= bestT || t > range) continue;
    // 命中点高度 → 部位（适配站/蹲/滑铲的缩放命中盒）
    const hitY = oy + dy * t;
    const headBottom = hb.head.y - hb.head.r;
    const legsTop = hb.legs.by;
    let part;
    if (hitY >= headBottom - 0.02) part = 'head';
    else if (hitY <= legsTop + 0.02) part = 'legs';
    else part = 'body';
    best = q;
    bestT = t;
    bestPart = part;
  }
  if (!best) return null;
  const worldHit = rayHitWorld(ox, oy, oz, dx, dy, dz, bestT + 0.01);
  if (worldHit && worldHit.t < bestT - 0.03) return null;   // 被墙/地形挡住
  return { target: best, part: bestPart, t: bestT };
}

function registerKillfeed(entry) {
  killfeed.push(entry);
  while (killfeed.length > RULES.killfeedMax) killfeed.shift();
}

function onKill(killer, victim, part) {
  const now = Date.now();
  victim.alive = false;
  victim.hp = 0;
  victim.deaths = (victim.deaths || 0) + 1;
  victim.streak = 0;
  victim.respawnAt = now + Math.round((W.respawnTime ?? 3) * 1000);
  victim.input = emptyInput();
  victim.reloadUntil = 0;
  victim.swapUntil = 0;
  victim.sprinting = false;
  victim.sliding = false;
  victim.aiming = false;
  if (killer) {
    killer.kills = (killer.kills || 0) + 1;
    killer.streak = (killer.streak || 0) + 1;
  }
  const entry = {
    at: now,
    killerId: killer ? killer.id : null,
    killerName: killer ? killer.name : '环境',
    killerTeam: killer ? killer.team : null,
    victimId: victim.id,
    victimName: victim.name,
    victimTeam: victim.team,
    weapon: killer ? killer.weapon : null,
    headshot: part === 'head',
    part,
    streak: killer ? killer.streak : 0,
  };
  registerKillfeed(entry);
  broadcast({
    t: 'death',
    id: victim.id,
    victimId: victim.id,
    victimName: victim.name,
    victimTeam: victim.team,
    killerId: killer ? killer.id : null,
    killerName: killer ? killer.name : '环境',
    killerTeam: killer ? killer.team : null,
    weapon: entry.weapon,
    part,
    headshot: entry.headshot,
    streak: entry.streak,
    x: round3(victim.x),
    y: round3(victim.y),
    z: round3(victim.z),
    killfeed: entry,
  });
  // 连杀提示（>=2 连杀广播，main.js/HUD 可做 toast）
  if (killer && killer.streak >= 2) {
    broadcast({ t: 'streak', playerId: killer.id, name: killer.name, streak: killer.streak });
  }
  eventBus.emit('death', entry);
  // 5 连杀（不死）→ 全队 UAV 10s
  if (killer && killer.streak > 0 && killer.streak % UAV_KILLSTREAK === 0) triggerUav(killer);
}

function triggerUav(p) {
  const now = Date.now();
  const until = now + UAV_DURATION * 1000;
  uav[p.team] = Math.max(uav[p.team] || 0, until);
  broadcast({
    t: 'uav_start',
    team: p.team,
    duration: UAV_DURATION,
    until,
    byId: p.id,
    byName: p.name,
    streak: p.streak,
  });
  eventBus.emit('uav', { team: p.team, until, byId: p.id });
}

// 服务器权威开火：校验射速/弹药/切枪/换弹 → 散布 → 多弹丸 → 共享命中盒 + 世界遮挡 → 伤害
function handleShoot(p, msg = {}) {
  if (!p || !p.alive) return false;
  // 只有正式开赛后才能开火（等待/倒计时阶段禁止对枪）
  if (match.phase !== 'playing') return false;
  const now = Date.now();
  if (now < (p.swapUntil || 0)) return false;                       // 切枪硬直
  if ((p.reloadUntil || 0) > 0) return false;                       // 换弹中
  const w = weaponOf(p.weapon);
  const interval = (w.fireInterval ?? 0.1) * 1000;
  if (now - (p.lastFire || 0) < interval - 1) return false;         // 射速限制

  const a = ammoOf(p);
  if (a.mag <= 0) {
    p.lastFire = now;
    send(p.ws, { t: 'dry_fire', weapon: p.weapon });
    startReload(p);
    return false;
  }
  p.lastFire = now;
  a.mag -= 1;

  // 朝向以客户端上报为准（已做范围钳制），并同步到服务器状态
  let baseYaw = normalizeYaw(clampNum(msg.yaw ?? p.yaw, -8 * Math.PI, 8 * Math.PI));
  let basePitch = clampNum(msg.pitch ?? p.pitch, -1.5, 1.5);
  p.yaw = baseYaw;
  p.pitch = basePitch;

  // 连发累积（停火 450ms 重置）
  if (now - (p.lastShotAt || 0) > 450) p.burst = 0;
  p.lastShotAt = now;
  p.burst = Math.min((p.burst || 0) + 1, 30);

  const ox = p.x, oz = p.z, oy = p.y + eyeHeightFor(p);
  const eyeDir = dirFromYawPitch(baseYaw, basePitch);
  // 广播开火：远程玩家播放枪声/枪口焰/弹壳（无曳光弹）
  broadcastExcept(p.ws, {
    t: 'shot',
    shooterId: p.id,
    shooterName: p.name,
    team: p.team,
    weapon: p.weapon,
    x: round3(ox), y: round3(oy), z: round3(oz),
    dx: round3(eyeDir.x), dy: round3(eyeDir.y), dz: round3(eyeDir.z),
    at: now,
  });
  eventBus.emit('shot', {
    shooterId: p.id, team: p.team, weapon: p.weapon,
    x: ox, y: oy, z: oz, at: now,
  });

  // 散布：腰射/移动/连发/冲刺/蹲/滑铲/开镜（shared currentSpread 汇总，战术散布在此追加）
  const moving = (p.speedNow || 0) > 1.2;
  const ads = !!p.aiming && !p.sprinting && !p.sliding;
  const crouched = p.stance === 'crouch' || p.stance === 'slide';
  let spread = currentSpread(w, {
    moving, ads,
    shots: Math.max(0, (p.burst || 1) - 1),
    sprinting: !!p.sprinting,
    crouched,
  });
  if (p.sliding) spread *= 1.5;   // 滑铲射击极不稳定
  const pellets = Math.max(1, Math.round(w.pellets || 1));
  const range = w.range ?? W.shootRange ?? 200;

  // 汇总每个受害者的伤害（霰弹枪一次可命中多弹丸）
  const hits = new Map();
  for (let i = 0; i < pellets; i++) {
    let yaw = baseYaw;
    let pitch = basePitch;
    if (spread > 0) {
      yaw += (Math.random() * 2 - 1) * spread;
      pitch += (Math.random() * 2 - 1) * spread * 0.75;
    }
    if (pellets > 1 && (w.pelletSpread || 0) > 0) {
      // 霰弹：固定锥形分布 + 随机抖动
      const ang = (i / pellets) * Math.PI * 2 + Math.random() * 0.9;
      const rad = (w.pelletSpread || 0) * Math.sqrt(Math.random());
      yaw += Math.cos(ang) * rad;
      pitch += Math.sin(ang) * rad * 0.8;
    }
    const dir = dirFromYawPitch(yaw, pitch);
    const hit = findHit(p, ox, oy, oz, dir.x, dir.y, dir.z, range);
    if (!hit) continue;
    let dmg = shotDamage(w, { part: hit.part, dist: hit.t });
    if (p.bot && AI_CONFIG.damageMult) dmg = Math.max(1, Math.round(dmg * AI_CONFIG.damageMult));
    let rec = hits.get(hit.target.id);
    if (!rec) {
      rec = { target: hit.target, dmg: 0, head: 0, body: 0, legs: 0, pellets: 0, t: Infinity, point: null, dir: null };
      hits.set(hit.target.id, rec);
    }
    rec.dmg += dmg;
    rec.pellets += 1;
    if (hit.part === 'head') rec.head += 1;
    else if (hit.part === 'legs') rec.legs += 1;
    else rec.body += 1;
    if (hit.t < rec.t) {
      rec.t = hit.t;
      rec.point = { x: ox + dir.x * hit.t, y: oy + dir.y * hit.t, z: oz + dir.z * hit.t };
      rec.dir = dir;
    }
  }

  if (process.env.DEBUG_SHOOT) {
    console.log('[shoot]', p.name, p.weapon, 'spread', spread.toFixed(4), 'pellets', pellets,
      'hits', [...hits.values()].map((r) => r.target.name + ':' + r.dmg).join(',') || 'none');
  }

  const nowAfter = Date.now();
  for (const rec of hits.values()) {
    const target = rec.target;
    if (!target.alive) continue;
    const part = rec.head > 0 ? 'head' : (rec.legs > 0 && rec.body === 0 ? 'legs' : 'body');
    let dmg = rec.dmg;
    let absorbed = 0;
    // 钢制插板：出生自带，只保护躯干。躯干伤害 80% 由插板吸收、20% 进入生命；
    // 头部/腿部不享受护甲减免（保留爆头价值）。
    if (part === 'body' && (target.shield || 0) > 0) {
      const toPlate = dmg * RULES.armorReduce;
      absorbed = Math.min(target.shield, toPlate);
      target.shield = Math.max(0, target.shield - absorbed);
      const overflow = toPlate - absorbed;   // 插板被打穿后的溢出部分
      dmg = dmg * (1 - RULES.armorReduce) + overflow;
    }
    dmg = Math.max(0, Math.round(dmg));
    if (dmg > 0) target.hp = Math.max(0, target.hp - dmg);
    target.lastDamageAt = nowAfter;
    const killed = target.hp <= 0;
    const point = rec.point || { x: ox, y: oy, z: oz };
    const hitMsg = {
      t: 'hit',
      shooterId: p.id,
      shooterName: p.name,
      targetId: target.id,
      targetName: target.name,
      dmg,
      rawDmg: rec.dmg,
      part,
      headshot: part === 'head',
      killed,
      pellets: rec.pellets,
      x: round3(point.x), y: round3(point.y), z: round3(point.z),
      distance: round3(rec.t),
      weapon: p.weapon,
      targetHp: target.hp,
      hp: target.hp,
      shield: target.shield || 0,
      absorbed: Math.round(absorbed),
      team: p.team,
    };
    send(p.ws, hitMsg);
    send(target.ws, hitMsg);
    eventBus.emit('damaged', {
      targetId: target.id, byId: p.id, team: p.team,
      x: target.x, y: target.y, z: target.z, hp: target.hp, at: nowAfter,
    });
    if (killed) onKill(p, target, part);
  }
  return true;
}

// AI 开火请求：走与真人相同的权威校验
function requestBotFire(bot, yaw, pitch) {
  if (!bot || !bot.alive) return false;
  return handleShoot(bot, {
    yaw: typeof yaw === 'number' ? yaw : bot.yaw,
    pitch: typeof pitch === 'number' ? pitch : bot.pitch,
  });
}

// ============================================================
// 十、移动 / 机动（冲刺 / 蹲 / 滑铲 / 跳跃）——全部使用共享物理
// ============================================================

function moveSpeedFor(p) {
  const w = weaponOf(p.weapon);
  let base;
  if (p.stance === 'slide') base = W.slideSpeed ?? W.sprintSpeed;
  else if (p.stance === 'crouch') base = W.crouchSpeed;
  else if (p.sprinting) base = W.sprintSpeed;
  else base = W.walkSpeed;
  if (p.aiming && !p.sprinting && p.stance !== 'slide') base *= (W.adsSpeedMult ?? W.adAdsSpeedMult ?? 0.55);
  base *= (w.moveSpeedMult ?? 1);
  base *= (p.speedMult ?? 1);
  if (Date.now() < (p.speedUntil || 0)) base *= RULES.speedBoostMult;
  return base;
}
function startSlide(p, now, mx, mz) {
  const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
  let dx = -sin * mz + cos * mx;
  let dz = -cos * mz - sin * mx;
  const len = Math.hypot(dx, dz);
  if (len > 1e-4) { dx /= len; dz /= len; } else { dx = -sin; dz = -cos; }
  p.sliding = true;
  p.slideUntil = now + Math.round((W.slideDuration ?? 0.7) * 1000);
  p.slideCdUntil = now + Math.round((W.slideCooldown ?? 1.2) * 1000);
  p.slideDirX = dx;
  p.slideDirZ = dz;
  p.stance = 'slide';
  p.sprinting = false;
  eventBus.emit('slide', { id: p.id, x: p.x, y: p.y, z: p.z, team: p.team });
}
function endSlide(p, wantCrouch) {
  p.sliding = false;
  p.stance = wantCrouch ? 'crouch' : 'stand';
}

// 单帧推进：读输入 → 机动 → 共享水平移动 → 共享垂直物理
function updatePlayer(p, dt) {
  const now = Date.now();
  if (!p) return;

  // 换弹计时完成
  if ((p.reloadUntil || 0) > 0 && now >= p.reloadUntil) finishReload(p);

  if (!p.alive) {
    if (now >= (p.respawnAt || 0)) respawn(p);
    return;
  }

  // 真人长时间没输入 → 停止移动（防“幽灵移动”）
  if (!p.bot && now - (p.lastInputAt || 0) > RULES.inputTimeoutMs) p.input = emptyInput();

  const inp = p.input || emptyInput();
  const mx = clampNum(inp.mx ?? 0, -1, 1);
  const mz = clampNum(inp.mz ?? 0, -1, 1);
  const wantsMove = Math.abs(mx) > 0.01 || Math.abs(mz) > 0.01;
  if (Object.prototype.hasOwnProperty.call(inp, 'aim')) p.aiming = !!inp.aim;
  const wantSprint = !!inp.sprint;
  let wantCrouch = !!inp.crouch;
  // AI 可能直接设置 stance：保持其蹲姿意图（AI 自行在需要时改回 stand）
  if (p.bot && p.stance === 'crouch' && !wantCrouch && !p.sprinting && !p.sliding) wantCrouch = true;

  // —— 滑铲 ——
  if (p.sliding && (now >= p.slideUntil || !p.grounded)) endSlide(p, wantCrouch);
  if (!p.sliding && wantCrouch && !p.prevCrouch && p.grounded && now >= (p.slideCdUntil || 0)
    && (p.stamina ?? 0) > 5 && (p.sprinting || wantSprint) && wantsMove) {
    startSlide(p, now, mx, mz);
  }
  p.prevCrouch = wantCrouch;

  // —— 冲刺 & 体力 ——
  p.sprinting = !p.sliding && wantSprint && wantsMove && (p.stamina ?? 0) > 0 && p.stance !== 'crouch';
  if (p.stance !== 'slide') p.stance = wantCrouch ? 'crouch' : 'stand';
  if (p.sprinting) {
    p.stamina = Math.max(0, (p.stamina ?? W.staminaMax) - (W.sprintDrain ?? 22) * dt);
    p.lastSprintAt = now;
  } else if (now - (p.lastSprintAt || 0) > (W.staminaRegenDelay ?? 0.8) * 1000) {
    p.stamina = Math.min(W.staminaMax ?? 100, (p.stamina ?? W.staminaMax) + (W.staminaRegen ?? 18) * dt);
  }

  // —— 跳跃 ——
  if (inp.jump && p.grounded && (p.stamina ?? 0) > 0) {
    p.vy = W.jumpSpeed ?? 6.8;
    p.grounded = false;
    p.stamina = Math.max(0, (p.stamina ?? 0) - (W.jumpStaminaCost ?? 12));
    if (p.sliding) { p.sliding = false; p.stance = wantCrouch ? 'crouch' : 'stand'; }
    eventBus.emit('jump', { id: p.id, x: p.x, y: p.y, z: p.z, team: p.team });
  }

  // —— 位移（共享 movePlayerHorizontal：坡度限制 + 碰撞体推出 + 边界） ——
  const beforeX = p.x, beforeZ = p.z;
  if (p.sliding) {
    const speed = W.slideSpeed ?? 9.6;
    movePlayerHorizontal(p, p.slideDirX * speed * dt, p.slideDirZ * speed * dt);
  } else {
    const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
    let fx = -sin * mz + cos * mx;
    let fz = -cos * mz - sin * mx;
    const len = Math.hypot(fx, fz);
    if (len > 1) { fx /= len; fz /= len; }
    const speed = moveSpeedFor(p);
    if (fx !== 0 || fz !== 0) movePlayerHorizontal(p, fx * speed * dt, fz * speed * dt);
  }
  // 共享垂直物理（重力/落地/贴地/撞头/碰撞推出）
  stepPlayerPhysics(p, dt);

  // 实测水平速度（供散布与状态使用）
  const moved = Math.hypot(p.x - beforeX, p.z - beforeZ);
  p.speedNow = dt > 0 ? moved / dt : 0;

  // 反作弊基础：单帧水平位移不得超过理论最大值（服务器自身计算，仅防异常）
  const cap = ((W.slideSpeed ?? 9.6) * 1.6 + 1) * dt + 0.35;
  if (moved > cap) {
    p.x = beforeX;
    p.z = beforeZ;
    p.cheatCount = (p.cheatCount || 0) + 1;
    if (p.cheatCount === 20 && !p.bot) send(p.ws, { t: 'error', msg: '移动异常已被服务器纠正' });
  }

  // —— 脚步噪声（AI 听觉 12m；走/跑/蹲/滑铲步幅不同） ——
  if (p.grounded && p.speedNow > 0.8) {
    const stride = (p.sprinting || p.sliding) ? 1.55 : (p.stance === 'crouch' ? 2.6 : 2.15);
    p.stepDist = (p.stepDist || 0) + p.speedNow * dt;
    if (p.stepDist >= stride) {
      p.stepDist = 0;
      const noise = {
        kind: 'footstep', type: 'step', id: p.id, team: p.team,
        x: round3(p.x), y: round3(p.y), z: round3(p.z),
        sprint: !!p.sprinting, sliding: !!p.sliding, crouch: p.stance === 'crouch',
      };
      emitNoise(noise);
      eventBus.emit('footstep', noise);
    }
  }

  ensureWeaponValid(p);
}

// 玩家间轻推分离（避免模型重叠；在 tick 中统一处理）
function separatePlayers() {
  const list = [];
  for (const p of players.values()) if (p.alive) list.push(p);
  const minD = (W.playerRadius ?? 0.42) * 2;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (Math.abs(a.y - b.y) > 1.5) continue;
      const dx = a.x - b.x, dz = a.z - b.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= minD * minD || d2 < 1e-8) continue;
      const d = Math.sqrt(d2);
      const push = (minD - d) * 0.5;
      a.x += (dx / d) * push;
      a.z += (dz / d) * push;
      b.x -= (dx / d) * push;
      b.z -= (dz / d) * push;
    }
  }
}

// ============================================================
// 十一、据点争夺 / 计分 / 比赛流程
// ============================================================

function zoneCounts() {
  for (const z of zoneRuntime) { z.counts.alpha = 0; z.counts.bravo = 0; }
  for (const p of players.values()) {
    if (!p.alive) continue;
    const zn = zoneOf(p.x, p.z);
    if (!zn) continue;
    const rt = zoneRuntime.find((z) => z.id === zn.id);
    if (!rt) continue;
    if (p.team === 'alpha') rt.counts.alpha += 1;
    else if (p.team === 'bravo') rt.counts.bravo += 1;
  }
}
function onZoneCaptured(z, team, prevOwner) {
  broadcast({
    t: 'zone_capture',
    zone: z.id,
    zoneId: z.id,
    id: z.id,
    name: z.name,
    team,
    owner: team,
    progress: 1,
    prevOwner: prevOwner || null,
  });
  if (prevOwner && prevOwner !== team) {
    broadcast({ t: 'zone_lost', zone: z.id, zoneId: z.id, name: z.name, team: prevOwner, by: team });
  }
  eventBus.emit('zone_capture', { zone: z.id, team, prevOwner: prevOwner || null });
}
function updateZones(dt) {
  zoneCounts();
  // 赛后结算的 8 秒内冻结据点推进（比分/归属保持最终结果，重置时统一清零）
  if (match.phase !== 'playing') return;
  const baseRate = 1 / Math.max(0.5, ZONE_CAPTURE_TIME);
  for (const z of zoneRuntime) {
    const a = z.counts.alpha, b = z.counts.bravo;
    z.contested = a > 0 && b > 0;
    if (z.contested) continue;   // 双方都在点内 → 争夺暂停
    if (a > 0 || b > 0) {
      const team = a > 0 ? 'alpha' : 'bravo';
      const count = Math.max(a, b);
      const speedMult = Math.min(2.5, 1 + 0.5 * (count - 1));   // 人数加速
      const dir = team === 'alpha' ? 1 : -1;
      z.capture = clampNum(z.capture + dir * baseRate * speedMult * dt, -1, 1);
      if (dir > 0 && z.capture >= 1 && z.owner !== 'alpha') {
        const prev = z.owner;
        z.owner = 'alpha';
        z.capture = 1;
        onZoneCaptured(z, 'alpha', prev);
      } else if (dir < 0 && z.capture <= -1 && z.owner !== 'bravo') {
        const prev = z.owner;
        z.owner = 'bravo';
        z.capture = -1;
        onZoneCaptured(z, 'bravo', prev);
      }
    } else if (z.capture > -1 && z.capture < 1) {
      // 无人 → 缓慢回退（已归属且满进度则保持不变）
      const decay = baseRate * 0.35 * dt;
      if (z.capture > 0) z.capture = Math.max(0, z.capture - decay);
      else if (z.capture < 0) z.capture = Math.min(0, z.capture + decay);
    }
  }
}
function updateScores(dt) {
  if (match.phase !== 'playing') return;
  for (const z of zoneRuntime) {
    if (z.owner === 'alpha') scores.alpha += ZONE_SCORE_RATE * dt;
    else if (z.owner === 'bravo') scores.bravo += ZONE_SCORE_RATE * dt;
  }
}
function matchSummary() {
  return {
    mode: match.mode,
    phase: match.phase,
    countdown: Math.max(0, Math.ceil(match.countdown)),
    timeLeft: Math.max(0, Math.ceil(match.timeLeft)),
    target: match.target,
    winner: match.winner,
    round: match.round,
    scores: { alpha: Math.round(scores.alpha * 10) / 10, bravo: Math.round(scores.bravo * 10) / 10 },
  };
}
function endMatch(winner, reason) {
  if (match.phase === 'ended') return;
  match.phase = 'ended';
  match.endedAt = Date.now();
  match.winner = winner;
  match.timeLeft = Math.max(0, match.timeLeft);
  broadcast({
    t: 'match_end',
    winner,
    reason,
    scores: { alpha: Math.round(scores.alpha * 10) / 10, bravo: Math.round(scores.bravo * 10) / 10 },
    target: match.target,
    timeLeft: Math.max(0, Math.ceil(match.timeLeft)),
    match: matchSummary(),
  });
  eventBus.emit('match_end', { winner, reason });
  if (isMain) console.log('[match] 结束：' + (winner || '平局') + '（' + reason + '）');
}
function resetMatch() {
  match.phase = 'waiting';
  match.countdown = 0;
  match.timeLeft = MATCH_TIME_LIMIT;
  match.winner = null;
  match.endedAt = 0;
  match.round += 1;
  scores.alpha = 0;
  scores.bravo = 0;
  uav.alpha = 0;
  uav.bravo = 0;
  killfeed.length = 0;
  for (const z of zoneRuntime) {
    z.owner = null;
    z.capture = 0;
    z.contested = false;
    z.counts.alpha = 0;
    z.counts.bravo = 0;
  }
  if (isMain) console.log('[match] 第 ' + match.round + ' 局准备：等待真人按空格开始');
}

// 真人按空格 → 进入 10 秒倒计时
function requestMatchStart() {
  if (match.phase !== 'waiting') return false;
  if (humanCount() <= 0) return false;
  match.phase = 'countdown';
  match.countdown = RULES.matchCountdown;
  broadcast({ t: 'match_countdown', seconds: RULES.matchCountdown, round: match.round });
  if (isMain) console.log('[match] 玩家开始准备，倒计时 ' + RULES.matchCountdown + 's');
  return true;
}

// 调试/测试用：跳过等待与倒计时直接开赛
function forceMatchStart() {
  match.phase = 'playing';
  match.countdown = 0;
  match.timeLeft = MATCH_TIME_LIMIT;
  match.winner = null;
  match.endedAt = 0;
  return true;
}

function updateMatch(dt, now) {
  if (match.phase === 'waiting') {
    // 等待真人按空格，计时/比分/据点全部冻结
    return;
  }
  if (match.phase === 'countdown') {
    match.countdown = Math.max(0, match.countdown - dt);
    if (match.countdown <= 0) {
      match.phase = 'playing';
      match.countdown = 0;
      match.timeLeft = MATCH_TIME_LIMIT;
      broadcast({ t: 'match_start', round: match.round });
      if (isMain) console.log('[match] 第 ' + match.round + ' 局正式开始');
    }
    return;
  }
  if (match.phase === 'ended') {
    if (now - (match.endedAt || 0) >= RULES.matchResetDelay * 1000) resetMatch();
    return;
  }
  match.timeLeft -= dt;
  // 先到 MATCH_SCORE_TARGET
  if (scores.alpha >= match.target) { endMatch('alpha', 'score'); return; }
  if (scores.bravo >= match.target) { endMatch('bravo', 'score'); return; }
  // 时间到：分高者胜，平局 winner=null
  if (match.timeLeft <= 0) {
    match.timeLeft = 0;
    const winner = scores.alpha === scores.bravo ? null : (scores.alpha > scores.bravo ? 'alpha' : 'bravo');
    endMatch(winner, 'time');
  }
}

// ============================================================
// 十二、AI：创建 / 决策循环 / 兜底
// ============================================================

function normalizeTeam(teamArg) {
  const t = String(teamArg || '').toLowerCase();
  if (t === 'alpha' || t === 'ally' || t === 'blue' || t === 'friend' || t === '友军') return 'alpha';
  if (t === 'bravo' || t === 'enemy' || t === 'red' || t === '敌军') return 'bravo';
  return 'bravo';
}
// 可否看见目标：距离 + 视锥（共享 AI_CONFIG）+ 共享 LOS（头/胸两点）
function canSee(bot, q) {
  if (!bot || !q || !bot.alive || !q.alive) return false;
  if (bot.team === q.team) return false;
  const eyeX = bot.x, eyeY = bot.y + eyeHeightFor(bot), eyeZ = bot.z;
  const dx = q.x - eyeX, dz = q.z - eyeZ;
  const dist2d = Math.hypot(dx, dz);
  if (dist2d > (AI_CONFIG.visionRadius ?? 55)) return false;
  const angTo = Math.atan2(-dx, -dz);
  if (Math.abs(wrapAngle(angTo - bot.yaw)) > ((AI_CONFIG.fovDeg ?? 110) / 2) * DEG) return false;
  const chestY = q.y + bodyCenterY(q);
  if (losBlocked(eyeX, eyeY, eyeZ, q.x, chestY, q.z)) {
    // 胸线被挡时再看头线（探头/矮掩体情况）
    const hb = hitboxesFor(q);
    if (losBlocked(eyeX, eyeY, eyeZ, hb.head.x, hb.head.y, hb.head.z)) return false;
  }
  return true;
}

// 创建 AI（默认敌军；team 支持 alpha/bravo 与旧名 ally/enemy）
function createBot(teamArg) {
  const team = normalizeTeam(teamArg);
  const spawn = freeSpawn(team);
  const primary = AI_WEAPON_POOL[(botSeq - 1) % AI_WEAPON_POOL.length] || 'smg';
  const owned = { pistol: true };
  const ammo = {};
  for (const id of [primary, 'pistol']) {
    if (!isWeaponId(id)) continue;
    owned[id] = true;
    ammo[id] = fullAmmo(id);
    ammo[id].reserve = Infinity;
  }
  const color = team === 'alpha' ? (BOT_COLORS.ally ?? 0x6f9fc4) : (BOT_COLORS.enemy ?? 0xc06a4e);
  const bot = {
    id: 'bot' + botSeq,
    ws: null,
    bot: true,
    name: 'AI-' + (team === 'alpha' ? 'A' : 'B') + String(botSeq).padStart(2, '0'),
    team,
    color,
    x: spawn.x, y: heightAt(spawn.x, spawn.z), z: spawn.z,
    vy: 0, grounded: true,
    yaw: yawForSpawn(spawn), pitch: 0,
    hp: (W.maxHp ?? 100) * (AI_CONFIG.healthMult ?? 1),
    maxHp: (W.maxHp ?? 100) * (AI_CONFIG.healthMult ?? 1),
    alive: true, respawnAt: 0,
    shield: RULES.shieldMax, stamina: W.staminaMax, speedUntil: 0,
    stance: 'stand', sprinting: false, sliding: false, aiming: false,
    prevCrouch: false, slideUntil: 0, slideCdUntil: 0, slideDirX: 0, slideDirZ: 0,
    speedNow: 0,
    weapon: isWeaponId(primary) ? primary : Object.keys(owned)[0],
    owned, ammo,
    reloadUntil: 0, swapUntil: 0, lastFire: 0, lastShotAt: 0, burst: 0,
    kills: 0, deaths: 0, streak: 0,
    input: emptyInput(),
    lastInputAt: Date.now(),
    speedMult: AI_CONFIG.moveSpeedMult ?? 1,
    damageMult: AI_CONFIG.damageMult ?? 1,
    // AI 决策字段（由 server/ai.js 写入）
    brain: null,
    path: [],
    waypoint: null,
    targetId: null,
    lastSeenAt: 0,
    lastSeenX: 0,
    lastSeenZ: 0,
    nextFireAt: 0,
    fireAt: 0,
    fireYaw: 0,
    firePitch: 0,
    wantFire: false,
    wantFireAt: 0,
    wantReload: false,
    wantSwitch: null,
    lastHitBy: null,
    hurtFrom: null,
    lastNoise: null,
    nextReloadAt: 0,
    stuckSince: 0,
    _lastX: spawn.x,
    _lastZ: spawn.z,
    _aiError: 0,
  };
  if (createBrainImpl) {
    try { bot.brain = createBrainImpl(bot.id); } catch (err) {
      bot.brain = null;
      if (isMain) console.warn('[server] createBrain 失败：' + (err && err.message));
    }
  }
  botSeq += 1;
  players.set(bot.id, bot);
  broadcast({ t: 'player_joined', player: snapshot(bot) });
  if (isMain) console.log('[bot] ' + bot.name + '（' + team + '）加入，当前 AI ' + countBots() + ' 个');
  return bot;
}

function countBots() {
  let n = 0;
  for (const p of players.values()) if (p.bot) n += 1;
  return n;
}

// 兜底 AI：server/ai.js 未就绪或抛错时保证对局仍然可玩（占点 + 看见敌人开火）
function fallbackAi(bot, now) {
  if (!bot.alive) return;
  // 找最近的可见敌人
  let target = null;
  let bestD = Infinity;
  for (const q of players.values()) {
    if (q === bot || q.team === bot.team || !q.alive) continue;
    if (!canSee(bot, q)) continue;
    const d = Math.hypot(q.x - bot.x, q.z - bot.z);
    if (d < bestD) { bestD = d; target = q; }
  }
  if (target) {
    bot.aiming = true;
    bot.targetId = target.id;
    const aimYaw = Math.atan2(-(target.x - bot.x), -(target.z - bot.z));
    const chestY = target.y + bodyCenterY(target);
    const eyeY = bot.y + eyeHeightFor(bot);
    const dist = Math.hypot(target.x - bot.x, chestY - eyeY, target.z - bot.z);
    const aimPitch = Math.asin(clampNum((chestY - eyeY) / Math.max(0.01, dist), -0.999, 0.999));
    // 转向速率限制
    const maxTurn = 0.35;
    bot.yaw = wrapAngle(bot.yaw + clampNum(wrapAngle(aimYaw - bot.yaw), -maxTurn, maxTurn));
    bot.pitch = clampNum(aimPitch + 0.03, -1.2, 1.2);
    bot.input = {
      mx: 0,
      mz: bestD > 9 ? 1 : (bestD < 4 ? -1 : 0),
      jump: false,
      sprint: bestD > 20 && (bot.stamina ?? 0) > 20,
      crouch: bestD < 12,
      aim: true,
    };
    // 开火（服务器权威校验射速/弹药）
    const a = ammoOf(bot);
    if (a.mag <= 0 && !(bot.reloadUntil > 0) && now >= (bot.nextReloadAt || 0)) {
      startReload(bot);
      bot.nextReloadAt = now + 800;
    } else if (now >= (bot.nextFireAt || 0) && Math.abs(wrapAngle(aimYaw - bot.yaw)) < 0.12 && a.mag > 0) {
      bot.nextFireAt = now + randInt(140, 320);
      requestBotFire(bot, bot.yaw + randRange(-0.03, 0.03), bot.pitch + randRange(-0.02, 0.02));
    }
    bot.wantFire = false;
    return;
  }
  // 没敌人：去争夺/防守据点
  let objective = null;
  for (const z of zoneRuntime) {
    if (z.owner !== bot.team) { objective = z; break; }
  }
  if (!objective) objective = zoneRuntime.find((z) => Math.hypot(z.x - bot.x, z.z - bot.z) < 8) || zoneRuntime[0];
  bot.aiming = false;
  bot.pitch = clampNum(bot.pitch * 0.9, -0.3, 0.3);
  const dx = objective.x - bot.x, dz = objective.z - bot.z;
  const d = Math.hypot(dx, dz);
  if (d > Math.max(2.5, objective.r * 0.5)) {
    const yaw = Math.atan2(-dx, -dz);
    bot.yaw = wrapAngle(bot.yaw + clampNum(wrapAngle(yaw - bot.yaw), -0.3, 0.3));
    bot.input = { mx: 0, mz: 1, jump: false, sprint: d > 18 && (bot.stamina ?? 0) > 20, crouch: false, aim: false };
  } else {
    bot.input = { mx: 0, mz: 0, jump: false, sprint: false, crouch: true, aim: false };
    bot.yaw = wrapAngle(bot.yaw + 0.02);
  }
  const a = ammoOf(bot);
  if (a.mag < (weaponOf(bot.weapon).magSize ?? 12) * 0.4 && !(bot.reloadUntil > 0) && now >= (bot.nextReloadAt || 0)) {
    startReload(bot);
    bot.nextReloadAt = now + 1200;
  }
  bot.wantFire = false;
}

// 处理 AI 的开火/换弹/切枪意图（兼容 ai.js 的约定：
// ctx.requestFire / bot.fireAt+fireYaw/firePitch / bot.wantFire / bot.wantReload / bot.wantSwitch）
function processBotFire(bot, now) {
  if (!bot || !bot.bot || !bot.alive) return;
  // 空弹匣自动换弹（避免 AI 拿空枪站着）
  const a = ammoOf(bot);
  if (a.mag <= 0 && !(bot.reloadUntil > 0) && now >= (bot.nextReloadAt || 0)) {
    startReload(bot);
    bot.nextReloadAt = now + 800;
  }
  // ai.js 请求换弹/切枪
  if (bot.wantReload) {
    bot.wantReload = false;
    if (!(bot.reloadUntil > 0)) startReload(bot);
  }
  if (bot.wantSwitch) {
    const target = bot.wantSwitch;
    bot.wantSwitch = null;
    if (typeof target === 'string') switchWeapon(bot, target);
  }
  if (bot.fireAt && now >= bot.fireAt) {
    const yaw = typeof bot.fireYaw === 'number' ? bot.fireYaw : bot.yaw;
    const pitch = typeof bot.firePitch === 'number' ? bot.firePitch : bot.pitch;
    bot.fireAt = 0;
    bot.wantFire = false;
    requestBotFire(bot, yaw, pitch);
  }
  if (bot.wantFire) {
    bot.wantFire = false;
    if (now >= (bot.nextFireAt || 0) && !(bot.reloadUntil > 0)) {
      const interval = (weaponOf(bot.weapon).fireInterval ?? 0.1) * 1000;
      bot.nextFireAt = now + Math.max(80, interval * 1.15);
      requestBotFire(bot, bot.yaw, bot.pitch);
    }
  }
}

// 导出的 aiUpdate 包装器：优先交给 server/ai.js，异常/缺失时使用兜底 AI
function aiUpdate(bot, now = Date.now(), ctxArg) {
  if (!bot || !bot.bot) return;
  // 直接调用（测试/外部）时：把当前脚步声批次交给 ai.js 并消费掉，避免历史事件被重复处理
  let ctx = ctxArg;
  if (!ctx) {
    const batch = aiNoiseEvents;
    aiNoiseEvents = [];
    ctx = buildAiCtx(now, batch);
  }
  if (aiImpl && (bot._aiError || 0) < 3) {
    try {
      aiImpl(bot, now, ctx);
    } catch (err) {
      bot._aiError = (bot._aiError || 0) + 1;
      if (isMain) console.warn('[server] ai.js aiUpdate 异常（第 ' + bot._aiError + ' 次）：' + (err && err.message));
      fallbackAi(bot, now);
    }
  } else {
    fallbackAi(bot, now);
  }
  processBotFire(bot, now);
}

// AI 决策循环：每 200ms 一次（spec §6.7）
function runAiTick(now = Date.now()) {
  // 只把“上一批”脚步声交给本 tick 的 AI（ctx.events 会在每个 bot 上被处理一次）
  const batch = aiNoiseEvents;
  aiNoiseEvents = [];
  const ctx = buildAiCtx(now, batch);
  for (const bot of players.values()) {
    if (!bot.bot) continue;
    bot.lastInputAt = now;
    if (!bot.alive) continue;
    aiUpdate(bot, now, ctx);
  }
}

// ============================================================
// 十三、主循环：20Hz 推进 + 状态广播
// ============================================================

function tick(now = Date.now(), dt = TICK_MS / 1000) {
  // 等待/倒计时阶段冻结 AI，避免开局前互相对枪
  if (match.phase !== 'playing') {
    for (const p of players.values()) {
      if (!p.bot) continue;
      p.input = emptyInput();
      p.sprinting = false;
      p.sliding = false;
      p.aiming = false;
      p.stance = 'stand';
    }
  }
  for (const p of players.values()) updatePlayer(p, dt);
  separatePlayers();
  updateZones(dt);
  updateScores(dt);
  updateMatch(dt, now);
  updateItemRespawns(now);
  updatePickups(now);
  broadcast(stateMessage(now));
}
// 供外部测试/集成使用的一步推进（等价于一个 20Hz tick）
function stepOnce(dt = TICK_MS / 1000) {
  tick(Date.now(), dt);
}

// ============================================================
// 十四、HTTP 静态托管 + WebSocket 协议
// ============================================================

function staticHandler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }
  if (!fs.existsSync(DIST)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>郊区战场 · 服务器运行中</h1><p>开发模式请执行 <b>npm run dev</b> 并访问 Vite 地址</p>');
    return;
  }
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(DIST, urlPath));
  if (!file.startsWith(DIST)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA 回退
      fs.readFile(path.join(DIST, 'index.html'), (err2, html) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': mime(file) });
    res.end(data);
  });
}
function mime(file) {
  const ext = path.extname(file).toLowerCase();
  const map = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.map': 'application/json',
  };
  return map[ext] || 'application/octet-stream';
}

// ---- 消息频率限制（反作弊）----
function allowMessage(ws, now) {
  if (!ws._msgWindowAt || now - ws._msgWindowAt > 1000) {
    ws._msgWindowAt = now;
    ws._msgCount = 0;
  }
  ws._msgCount = (ws._msgCount || 0) + 1;
  if (ws._msgCount > RULES.maxMessagesPerSec) {
    if (!ws._rateWarned) {
      ws._rateWarned = true;
      send(ws, { t: 'error', msg: '消息频率过高，已限流' });
    }
    return false;
  }
  return true;
}

const server = http.createServer(staticHandler);
const wss = new WebSocketServer({ server, path: '/ws' });

function humanCount() {
  let n = 0;
  for (const p of players.values()) if (!p.bot && p.ws) n += 1;
  return n;
}
function findPlayerByMsg(msg) {
  if (!msg) return null;
  const key = msg.id ?? msg.name;
  if (key == null) return null;
  const s = String(key);
  if (players.has(s)) return players.get(s);
  for (const p of players.values()) if (p.name === s) return p;
  return null;
}
// 调试：把玩家传送到坐标（仅 DEBUG=1）
// 注意：只改位置/物理状态，不改 hp/alive（回血/击杀请用 debug_hp），避免调试与命中测试互相干扰
function debugSetPos(msg) {
  const p = findPlayerByMsg(msg);
  if (!p) return;
  const lim = (W.half ?? 70) - 3;
  p.x = clampNum(msg.x ?? p.x, -lim, lim);
  p.z = clampNum(msg.z ?? p.z, -lim, lim);
  p.y = typeof msg.y === 'number' ? clampNum(msg.y, -5, 40) : heightAt(p.x, p.z);
  p.vy = 0;
  p.grounded = true;
  p.stamina = W.staminaMax;
  p.sliding = false;
  p.sprinting = false;
  p.stance = 'stand';
  p.speedNow = 0;
  if (typeof msg.yaw === 'number') p.yaw = normalizeYaw(msg.yaw);
  stepPlayerPhysics(p, 0.016);
}
function debugSetHp(msg) {
  const p = findPlayerByMsg(msg);
  if (!p) return;
  p.hp = clampNum(msg.hp, 0, p.maxHp ?? W.maxHp);
  if (p.hp <= 0) {
    p.alive = false;
    p.respawnAt = Date.now() + Math.round((W.respawnTime ?? 3) * 1000);
  }
}
function debugSetZone(msg) {
  const id = String(msg.id || msg.zone || '').toUpperCase();
  const z = zoneRuntime.find((q) => q.id.toUpperCase() === id);
  if (!z) return;
  const teamRaw = String(msg.team || '').toLowerCase();
  if (!teamRaw || teamRaw === 'neutral' || teamRaw === 'none') {
    z.owner = null;
    z.capture = 0;
  } else {
    const team = normalizeTeam(teamRaw);
    z.owner = team;
    z.capture = team === 'alpha' ? 1 : -1;
    onZoneCaptured(z, team, null);
  }
}
function handleDebug(msg) {
  if (!DEBUG) return;
  switch (msg.t) {
    case 'debug_pos': debugSetPos(msg); break;
    case 'debug_spawn_bot': createBot(msg.team || 'bravo'); break;
    case 'debug_spawn_item': {
      const type = msg.type || 'medkit';
      if (typeof msg.x === 'number' && typeof msg.z === 'number') spawnItem(type, msg.x, msg.z);
      else spawnItem(type);
      break;
    }
    case 'debug_zone': debugSetZone(msg); break;
    case 'debug_hp': debugSetHp(msg); break;
    // 额外调试钩子（测试快速推进比赛用）
    case 'debug_score': {
      const team = normalizeTeam(msg.team);
      if (team === 'alpha' || team === 'bravo') scores[team] = Math.max(0, Number(msg.value) || 0);
      break;
    }
    case 'debug_time': {
      match.timeLeft = Math.max(0, Number(msg.timeLeft ?? msg.value) || 0);
      break;
    }
    // 跳过等待/倒计时，直接开赛（仅测试）
    case 'debug_start': {
      forceMatchStart();
      break;
    }
    case 'debug_ready': {
      requestMatchStart();
      break;
    }
    default: break;
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws._msgWindowAt = 0;
  ws._msgCount = 0;
  let player = null;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    const now = Date.now();
    if (!allowMessage(ws, now)) return;
    let msg = null;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;

    // 调试钩子（仅 DEBUG=1 且必须在 join 前也可用）
    if (msg.t.startsWith('debug_')) { handleDebug(msg); return; }

    switch (msg.t) {
      case 'join': {
        if (player) return;
        if (humanCount() >= RULES.maxPlayers) {
          send(ws, { t: 'error', msg: '服务器已满（最多 ' + RULES.maxPlayers + ' 名真人）' });
          ws.close();
          return;
        }
        player = createPlayer(ws, msg.name);
        send(ws, welcomeMessage(player));
        broadcastExcept(ws, { t: 'player_joined', player: snapshot(player) });
        send(ws, stateMessage());
        if (isMain) console.log('[+] ' + player.name + ' (' + player.id + ') 加入 alpha 队，当前真人 ' + humanCount());
        break;
      }
      case 'ready': {
        // 真人玩家按下空格：等待阶段 → 10 秒倒计时
        requestMatchStart();
        break;
      }
      case 'input': {
        if (!player) return;
        const inp = player.input || emptyInput();
        inp.mx = clampNum(msg.mx ?? 0, -1, 1);
        inp.mz = clampNum(msg.mz ?? 0, -1, 1);
        inp.jump = !!msg.jump;
        inp.sprint = !!msg.sprint;
        inp.crouch = !!msg.crouch;
        inp.aim = !!msg.aim;
        inp.seq = Number.isFinite(msg.seq) ? msg.seq : 0;
        player.input = inp;
        player.lastInputAt = now;
        if (typeof msg.yaw === 'number') player.yaw = normalizeYaw(msg.yaw);
        if (typeof msg.pitch === 'number') player.pitch = clampNum(msg.pitch, -1.5, 1.5);
        break;
      }
      case 'shoot': {
        if (player) handleShoot(player, msg);
        break;
      }
      case 'reload': {
        if (player) startReload(player);
        break;
      }
      case 'switch': {
        if (player) switchWeapon(player, msg.weapon);
        break;
      }
      case 'ping': {
        send(ws, { t: 'pong', time: msg.time, serverTime: now });
        break;
      }
      default: break;
    }
  });

  ws.on('close', () => {
    if (player) {
      players.delete(player.id);
      broadcast({ t: 'player_left', id: player.id, name: player.name, team: player.team });
      if (isMain) console.log('[-] ' + player.name + ' (' + player.id + ') 离开，当前真人 ' + humanCount());
      player = null;
    }
  });
  ws.on('error', () => { /* 忽略连接错误，close 会清理 */ });
});

// ============================================================
// 十五、启动（仅直接运行时；被测试 import 时只导出 API）
// ============================================================

function spawnInitialBots() {
  const total = Math.max(0, Math.min(16, Number(process.env.BOTS_MAX ?? AI_CONFIG.max ?? 5)));
  if (total <= 0) return;
  const alphaCount = total >= 2 ? Math.max(1, Math.round(total * 0.4)) : 0;
  const bravoCount = total - alphaCount;
  for (let i = 0; i < alphaCount; i++) createBot('alpha');
  for (let i = 0; i < bravoCount; i++) createBot('bravo');
  if (isMain) console.log('[bot] 启动 AI：alpha ' + alphaCount + ' / bravo ' + bravoCount + '（共 ' + countBots() + '）');
}

async function start() {
  await ensureAiModules();
  ensureNav();
  initItems();
  server.listen(PORT, '0.0.0.0', () => {
    console.log('[server] 郊区战场服务器已启动：' + PORT + '（HTTP + WebSocket /ws）');
    console.log('[server] 模式 Domination：' + ZONE_DEFS.map((z) => z.id).join('/') + '，先到 ' + MATCH_SCORE_TARGET + ' 分或 ' + MATCH_TIME_LIMIT + 's');
  });
  spawnInitialBots();

  // AI 决策循环（200ms）
  setInterval(() => {
    try { runAiTick(); } catch (err) {
      if (isMain) console.warn('[server] AI tick 异常：' + (err && err.message));
    }
  }, AI_DECISION_MS);

  // 主循环（20Hz）
  setInterval(() => {
    try { tick(); } catch (err) {
      if (isMain) console.warn('[server] tick 异常：' + (err && err.message));
    }
  }, TICK_MS);

  // 心跳：清理失联连接
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* 忽略 */ }
    }
  }, 15000);
}

// 模块加载时先尝试接入 ai/nav（失败不阻塞；start 时会再试一次）
await ensureAiModules();

if (isMain) {
  await start();
}

// ============================================================
// 十六、导出（spec §6.8 要求的旧名字全部保留，可新增）
// ============================================================
export {
  // —— spec §6.8 必须保留 ——
  createPlayer,
  createBot,
  handleShoot,
  respawn,
  snapshot,
  updatePlayer,
  aiUpdate,
  canSee,
  countBots,
  spawnItem,
  applyItem,
  initItems,
  items,
  players,
  startReload,
  finishReload,
  switchWeapon,
  grantWeapon,
  ammoOf,
  makeLoadout,
  // —— 新增（测试/集成便利）——
  tick,
  stepOnce,
  stateMessage,
  requestMatchStart,
  forceMatchStart,
  zoneRuntime as zones,
  scores,
  match,
  uav,
  killfeed,
  eventBus,
  handleDebug,
  ensureNav,
  ensureAiModules,
  raySphere,
  rayCapsule,
  rayHitWorld,
  losBlocked,
  hitboxesFor,
  heightAt,
  WEAPONS,
  WEAPON_ORDER,
  PICKUP_WEAPONS,
  RULES,
  server,
  wss,
};
