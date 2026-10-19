// ===== 真实 FPS AI（server/ai.js，ai-nav 实现）=====
// 目标：行为接近“普通 FPS 玩家”的机器人——会看、会听、会记、会绕障、会找掩体、会占点，
// 但反应/枪法有误差，不是神枪手。每 200ms 决策一次，其余时间只做转向/移动/开火节奏的连续更新。
//
// ===== 与 server.js 的约定（ctx 由 game-server 提供，全部容错）=====
// ctx = {
//   players: Map<id, player> | player[],
//   nav: nav（buildNav() 结果；缺失时 ai.js 自己 buildNav() 一次）,
//   zones: [{ id, name, x, z, r, owner, progress, contested, counts }],
//   items: Map<id, {id,type,x,z}> | [],
//   world: { WORLD, heightAt, losBlocked, raycastWorld, movePlayerHorizontal, hitboxesFor },
//   rand: () => [0,1),                       // 可选；缺省用 Math.random
//   requestFire(bot, yaw, pitch),            // 可选；由服务器做权威校验并 handleShoot
//   requestReload(bot), requestSwitch(bot, weaponId),  // 可选
//   eventBus: { on/off/emit },               // 可选；ai.js 订阅 'shot' / 'damaged'
//   events / sounds: []                      // 可选；每 tick 的事件数组（与 eventBus 二选一）
// }
// eventBus 事件：'shot' {shooterId,team,x,y,z,weapon,at}，'damaged' {targetId,byId,x,y,z,at}
//
// ===== aiUpdate 只写这些 bot 字段 =====
//   bot.input{mx,mz,jump,sprint,crouch,aim}、bot.yaw、bot.pitch、bot.aiming、bot.stance、
//   bot.sprint、bot.wantFire / bot.fireAt / bot.fireYaw / bot.firePitch / bot.nextFireAt、
//   bot.wantReload / bot.wantSwitch、bot.brain、bot.path、bot.targetId
// 绝不写 bot.x/z/y/hp/ammo/weapon/vy/grounded 等（移动/伤害/弹药由服务器权威推进）。
//
// 开火三种约定都兼容：优先 ctx.requestFire(bot,yaw,pitch)；没有则设 wantFire + fireAt(now)
// + fireYaw/firePitch，服务器读到后 handleShoot 即可（开完清标记）。
import {
  WORLD as SHARED_WORLD, ZONES as STATIC_ZONES, AI_CONFIG as SHARED_AI_CONFIG,
} from '../shared/world.js';
import {
  buildNav, findPath, nearestWalkable, randomWalkable, hasLineOfWalk, sampleCover,
} from './nav.js';

const PI = Math.PI;
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const INF = Infinity;

// 难度/行为参数：可整体覆盖（bot.aiConfig 可放一个完整配置对象做单 bot 难度），
// 也可直接改 AI_CONFIG 的值热调。默认值对齐 shared/world.js 的 AI_CONFIG（普通玩家强度）。
const AI_DEFAULTS = {
  // 感知
  detectNear: 0.25,          // 最近距离发现耗时（秒）
  detectFar: 1.2,            // 最远距离发现耗时（秒）
  fovDeg: 110,
  visionRadius: 55,
  hearingShot: 45,
  hearingStep: 12,
  loseMemoryMs: 6000,        // 目标记忆时长
  // 决策/移动
  tickMs: 200,
  arriveRadius: 0.8,         // 路径点到达半径
  repathMs: 2000,            // 路径最多 2s 重算
  stuckMs: 800,              // 位移 <0.1m 持续 0.8s 判卡住
  stuckMinMove: 0.1,
  turnRate: 3.0,             // rad/s，人不能瞬间转身
  sprintDist: 14,            // 超过该距离且无敌人时冲刺
  // 战斗
  reactionMin: 340, reactionMax: 720,   // 发现→可开火的反应时间（更接近普通玩家）
  aimErrorStart: 0.30,       // 初始瞄准误差（rad，约 17°）
  aimErrorMin: 0.045,        // 持续追踪收敛后的误差下限（≈2.6°，中远距离不再百发百中）
  aimSettle: 1.8,            // 收敛时间（秒）
  aimHeadChance: 0.10,       // 瞄头概率（不高，避免 AI 枪枪爆头）
  turnAimRate: 2.6,
  shootRange: 55,
  burstMin: 3, burstMax: 6,
  burstPauseMin: 260, burstPauseMax: 620,
  fireRateMultiplier: 0.7,   // <1 = 射速比武器上限慢
  retreatHpFrac: 0.32,       // 低血撤退
  coverHpFrac: 0.55,         // 半血以下优先掩体
  coverCheckMs: 4500,
  flankDistance: 11,
  maxBurstWaitMs: 260,
  ...SHARED_AI_CONFIG,
};
export const AI_CONFIG = AI_DEFAULTS;

const TEAM_INTEL_TTL = 6000;
const ZONE_CLAIM_TTL = 8000;

// 武器基础参数兜底（优先读 shared/weapons.js）
const WEAPON_FALLBACK = {
  pistol: { fireInterval: 0.15, magSize: 12, reloadTime: 1.15, range: 70 },
  smg: { fireInterval: 0.075, magSize: 30, reloadTime: 1.7, range: 55 },
  ak47: { fireInterval: 0.095, magSize: 30, reloadTime: 2.0, range: 85 },
  shotgun: { fireInterval: 0.78, magSize: 6, reloadTime: 2.3, range: 30 },
  sniper: { fireInterval: 1.55, magSize: 5, reloadTime: 2.7, range: 140 },
};
const PREF_RANGE = {
  pistol: [7, 18], smg: [6, 16], ak47: [10, 28], shotgun: [3, 9], sniper: [22, 48],
};
const weaponCache = new Map();

let _weaponLib = null;
async function loadWeaponLib() {
  // 静态 import 会在 weapons.js 缺导出时 link 失败；用动态 import 容错，且只尝试一次
  if (_weaponLib) return _weaponLib;
  _weaponLib = {};
  try {
    const m = await import('../shared/weapons.js');
    _weaponLib = m;
  } catch {
    _weaponLib = {};
  }
  return _weaponLib;
}
void loadWeaponLib();

function weaponInfo(kind) {
  const key = typeof kind === 'string' && kind ? kind : 'pistol';
  let info = weaponCache.get(key);
  if (info) return info;
  let w = null;
  const lib = _weaponLib;
  if (lib && typeof lib.weaponOf === 'function') {
    try { w = lib.weaponOf(key); } catch { w = null; }
  }
  const fb = WEAPON_FALLBACK[key] || WEAPON_FALLBACK.pistol;
  info = {
    kind: key,
    fireInterval: num(w && w.fireInterval, fb.fireInterval),
    magSize: num(w && w.magSize, fb.magSize),
    reloadTime: num(w && w.reloadTime, fb.reloadTime),
    range: num(w && w.range, fb.range),
    pellets: num(w && w.pellets, 1),
  };
  weaponCache.set(key, info);
  return info;
}

// ---------- 小工具 ----------
function num(v, d) { return Number.isFinite(v) ? v : d; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function wrapAngle(a) {
  a = (a + PI) % TAU;
  if (a < 0) a += TAU;
  return a - PI;
}
function angleTo(dx, dz) { return Math.atan2(-dx, -dz); }
function distXZ(ax, az, bx, bz) { return Math.hypot(bx - ax, bz - az); }

function rand01(ctx) {
  const r = ctx && ctx.rand;
  if (typeof r === 'function') {
    const v = r();
    return Number.isFinite(v) ? clamp(v, 0, 0.9999999) : 0.5;
  }
  if (r && typeof r.next === 'function') {
    const v = r.next();
    return Number.isFinite(v) ? clamp(v, 0, 0.9999999) : 0.5;
  }
  if (r && typeof r.random === 'function') {
    const v = r.random();
    return Number.isFinite(v) ? clamp(v, 0, 0.9999999) : 0.5;
  }
  return Math.random();
}
function randRange(ctx, a, b) { return a + rand01(ctx) * (b - a); }
function randInt(ctx, a, b) { return a + Math.floor(rand01(ctx) * (b - a + 1)); }

function eachPlayer(players, fn) {
  if (!players) return;
  if (typeof players.values === 'function') {
    for (const p of players.values()) fn(p);
  } else if (Array.isArray(players)) {
    for (const p of players) fn(p);
  } else if (typeof players === 'object') {
    for (const k in players) fn(players[k]);
  }
}

function findPlayer(players, id) {
  if (!players || id == null) return null;
  if (typeof players.get === 'function') return players.get(id) || null;
  if (Array.isArray(players)) {
    for (const p of players) if (p && p.id === id) return p;
    return null;
  }
  return players[id] || null;
}

function eachItem(items, fn) {
  if (!items) return;
  if (typeof items.values === 'function') {
    for (const it of items.values()) fn(it);
  } else if (Array.isArray(items)) {
    for (const it of items) fn(it);
  } else if (typeof items === 'object') {
    for (const k in items) fn(items[k]);
  }
}

function worldCfg(ctx) {
  const w = ctx && ctx.world;
  return (w && w.WORLD) || SHARED_WORLD;
}
function navFor(ctx) {
  const n = ctx && ctx.nav;
  if (n && n.walkable) return n;
  try { return buildNav(); } catch { return null; }
}
function losOk(ctx, nav, ox, oy, oz, ex, ey, ez) {
  const w = ctx && ctx.world;
  if (w && typeof w.losBlocked === 'function') {
    try { return !w.losBlocked(ox, oy, oz, ex, ey, ez); } catch { /* fallthrough */ }
  }
  if (nav && typeof nav.losBlocked === 'function') {
    try { return !nav.losBlocked(ox, oy, oz, ex, ey, ez); } catch { /* fallthrough */ }
  }
  return true;
}
function groundY(bot, ctx) {
  if (Number.isFinite(bot.y)) return bot.y;
  const w = ctx && ctx.world;
  if (w && typeof w.heightAt === 'function') {
    try { return w.heightAt(num(bot.x, 0), num(bot.z, 0)); } catch { return 0; }
  }
  return 0;
}
function eyeInfo(bot, W, ctx) {
  const crouch = bot.stance === 'crouch' || bot.stance === 'slide';
  return {
    y: groundY(bot, ctx) + (crouch ? num(W.crouchEyeHeight, 1.05) : num(W.eyeHeight, 1.64)),
    crouch,
  };
}

// ---------- 模块级共享状态（同进程内队友共享情报 / 事件队列 / 据点占位）----------
const teamIntel = new Map();       // team -> Map(enemyId -> {x,y,z,vx,vz,at})
const zoneClaims = new Map();      // team -> Map(zoneId -> {botId, at})
const lastDamagedInfo = new Map(); // botId -> { byId, x, z, at }
const eventQueue = [];
let eventBusBound = false;
let eventSeq = 0;

function bindEventBus(bus) {
  if (!bus || eventBusBound || typeof bus.on !== 'function') return;
  eventBusBound = true;
  try {
    bus.on('shot', (e) => queueEvent('shot', e));
    bus.on('damaged', (e) => queueEvent('damaged', e));
    bus.on('death', (e) => queueEvent('death', e));
  } catch { eventBusBound = false; }
}

function queueEvent(kind, raw) {
  if (!raw || typeof raw !== 'object') return;
  const now = Date.now();
  const e = {
    seq: ++eventSeq,
    kind,
    at: num(raw.at, now),
    x: num(raw.x, NaN),
    y: num(raw.y, NaN),
    z: num(raw.z, NaN),
  };
  if (kind === 'shot') {
    e.shooterId = raw.shooterId;
    e.team = raw.team;
    e.weapon = raw.weapon;
  } else if (kind === 'damaged') {
    e.targetId = raw.targetId;
    e.byId = raw.byId;
    if (e.targetId != null) {
      lastDamagedInfo.set(e.targetId, { byId: e.byId, x: e.x, z: e.z, at: e.at });
      if (lastDamagedInfo.size > 32) {
        for (const [k, v] of lastDamagedInfo) {
          if (now - v.at > 8000) lastDamagedInfo.delete(k);
        }
      }
    }
  } else if (kind === 'death') {
    e.id = raw.id;
    e.killerId = raw.killerId;
    e.team = raw.team;
  }
  eventQueue.push(e);
  if (eventQueue.length > 160) eventQueue.splice(0, eventQueue.length - 160);
}

function intelFor(team) {
  let m = teamIntel.get(team);
  if (!m) { m = new Map(); teamIntel.set(team, m); }
  return m;
}

function publishIntel(bot, id, x, y, z, vx, vz, at) {
  if (!bot.team || id == null || !Number.isFinite(x) || !Number.isFinite(z)) return;
  intelFor(bot.team).set(id, { x, y, z, vx, vz, at });
}

// ============================================================
// brain：每个 bot 一份。所有可变状态都在这里，aiUpdate 不建大对象。
// ============================================================
export function createBrain(botId) {
  return {
    id: botId,
    lastUpdate: 0,
    dt: 0.2,
    nextThink: 0,
    wasDead: false,
    firstThink: true,
    // 状态机
    state: 'objective',          // objective | hunt | combat | retreat
    moveMode: 'hold',            // path | direct | strafe | advance | retreat | hold
    moveX: 0, moveZ: 0,
    desiredYaw: 0,
    desiredPitch: 0,
    // 感知
    visId: null, visX: 0, visY: 0, visZ: 0, visDist: 0, visScore: -INF,
    spotting: new Map(),         // enemyId -> {p, at}（发现进度条）
    memory: new Map(),           // enemyId -> {x,y,z,vx,vz,seenAt,stance,intel}
    targetId: null,
    tgtVisible: false,
    tgtX: 0, tgtY: 0, tgtZ: 0, tgtDist: 0,
    trackSince: 0,
    reactAt: 0,
    lastSeenAt: 0,
    lastThreatX: NaN, lastThreatZ: NaN,
    heardAt: 0, heardX: 0, heardZ: 0, heardType: null,
    alertUntil: 0,
    forceYaw: 0, forceYawUntil: 0,
    // 战斗
    aimErr: 0.16,
    aimYawOff: 0, aimPitchOff: 0,
    aimOffAt: 0,
    aimHead: false,
    burstLeft: 0,
    nextShotAt: 0,
    nextBurstAt: 0,
    lastShotRequestAt: 0,
    wantFire: false,
    wantReload: false,
    reloadAskAt: 0,
    wantSwitch: null,
    fireYaw: 0, firePitch: 0,
    // 移动
    path: null, pathIndex: 0, pathGoal: null, pathAt: 0, pathNextAt: 0, pathFailAt: 0,
    arriveX: 0, arriveZ: 0,
    wantsMove: false,
    wantSprint: false,
    wantCrouch: false,
    wantAim: false,
    strafeDir: 1, strafeUntil: 0,
    flankSide: 1, flankFlipAt: 0,
    lastX: 0, lastZ: 0, stuckSince: 0, stuckCount: 0,
    detourUntil: 0, detourX: 0, detourZ: 0,
    jumpAt: 0,
    // 掩体 / 占点
    coverPoint: null, coverThreatX: 0, coverThreatZ: 0, coverAt: 0, coverNextAt: 0,
    coverUntil: 0, inCover: false, peekAt: 0, peekUntil: 0,
    objZoneId: null, objX: 0, objZ: 0, objAt: 0, objType: null,
    patrolAt: 0,
    // 调试/错误
    lastDecision: 'idle',
    _err: null,
  };
}

function ensureBot(bot) {
  if (!bot.input || typeof bot.input !== 'object') bot.input = { mx: 0, mz: 0, jump: false };
  const inp = bot.input;
  if (!Number.isFinite(inp.mx)) inp.mx = 0;
  if (!Number.isFinite(inp.mz)) inp.mz = 0;
  if (!Number.isFinite(inp.jump)) inp.jump = false;
  if (!Number.isFinite(bot.yaw)) bot.yaw = 0;
  if (!Number.isFinite(bot.pitch)) bot.pitch = 0;
  if (typeof bot.stance !== 'string') bot.stance = 'stand';
  if (!Number.isFinite(bot.hp)) { /* 只读兜底，不写回 */ }
  if (!bot.brain) bot.brain = createBrain(bot.id);
  return bot.brain;
}

function safeReset(bot) {
  const b = ensureBot(bot);
  b.path = null;
  b.pathIndex = 0;
  b.targetId = null;
  b.visId = null;
  b.tgtVisible = false;
  b.wantFire = false;
  b.wantReload = false;
  b.moveMode = 'hold';
  if (bot.input) { bot.input.mx = 0; bot.input.mz = 0; bot.input.jump = false; }
  bot.wantFire = false;
}

function cfgFor(bot) {
  const c = bot && bot.aiConfig;
  if (c && typeof c === 'object') return c;
  // 小队角色战术：把角色参数叠加到基础配置上（点射长度/节奏/射速/交战距离/瞄头概率）
  const base = AI_CONFIG;
  const t = bot && bot.tactic;
  if (!t || typeof t !== 'object') return base;
  const merged = {
    ...base,
    burstMin: num(t.burstMin, num(base.burstMin, 3)),
    burstMax: num(t.burstMax, num(base.burstMax, 6)),
    fireRateMultiplier: num(t.fireRate, num(base.fireRateMultiplier, 0.7)),
    aimErrorMin: num(base.aimErrorMin, 0.045) * num(t.aimError, 1),
    aimErrorStart: num(base.aimErrorStart, 0.30) * num(t.aimError, 1),
    coverHpFrac: num(base.coverHpFrac, 0.55) * num(t.coverBias, 1),
    flankDistance: num(base.flankDistance, 11) * (0.7 + num(t.flankBias, 0.5) * 0.6),
  };
  if (Array.isArray(t.burstPause)) {
    merged.burstPauseMin = num(t.burstPause[0], 220);
    merged.burstPauseMax = num(t.burstPause[1], 520);
  }
  return merged;
}

// 角色偏好的交战距离（用于选目标与站位；取中点）
function rolePreferredRange(bot) {
  const t = bot && bot.tactic;
  if (!t || !Array.isArray(t.preferRange)) return null;
  return { min: num(t.preferRange[0], 6), max: num(t.preferRange[1], 30) };
}

function ammoFor(bot) {
  const am = bot && bot.ammo;
  if (!am || typeof am !== 'object') return null;
  const a = am[bot.weapon];
  if (!a || typeof a !== 'object') return null;
  return a;
}

// ============================================================
// 感知：视锥 + 双点 LOS + 发现延时 + 听觉 + 队友情报 + 记忆
// ============================================================
function sense(bot, brain, now, ctx, cfg) {
  const W = worldCfg(ctx);
  const nav = navFor(ctx);
  const team = bot.team;
  const eye = eyeInfo(bot, W);
  const halfFov = (num(cfg.fovDeg, 110) * 0.5) * DEG;
  const vision = num(cfg.visionRadius, 55);
  const dt = brain.dt;

  // 目标可见性每帧重算（选威胁最高者）
  brain.visId = null;
  brain.visScore = -INF;

  const seen = (q) => {
    const dx = num(q.x, 0) - bot.x;
    const dz = num(q.z, 0) - bot.z;
    const d = Math.hypot(dx, dz);
    if (d > vision) return null;
    if (Math.abs(wrapAngle(angleTo(dx, dz) - bot.yaw)) > halfFov) return null;
    const qy = groundY(q, ctx);
    const qCrouch = q.stance === 'crouch' || q.stance === 'slide';
    const headY = qy + num(W.headY, 1.68) * (qCrouch ? 0.68 : 1);
    const chestY = qy + (qCrouch ? 0.78 : 1.05);
    const headClear = losOk(ctx, nav, bot.x, eye.y, bot.z, q.x, headY, q.z);
    const chestClear = headClear ? true : losOk(ctx, nav, bot.x, eye.y, bot.z, q.x, chestY, q.z);
    if (!headClear && !chestClear) return null;
    return { d, qy, headY, chestY };
  };

  eachPlayer(ctx && ctx.players, (q) => {
    if (!q || q === bot || q.id === bot.id) return;
    if (q.alive === false) return;
    if (!Number.isFinite(q.x) || !Number.isFinite(q.z)) return;
    const sameTeam = q.team != null && team != null && q.team === team;
    if (sameTeam) return;
    const vis = seen(q);
    if (!vis) return;
    const d = vis.d;

    // 已在记忆里 = 已发现，直接可见；否则累计发现进度（距离越远越慢）
    const mem = brain.memory.get(q.id);
    const detected = !!mem;
    if (!detected) {
      let sp = brain.spotting.get(q.id);
      if (!sp) { sp = { p: 0, at: now }; brain.spotting.set(q.id, sp); }
      const need = num(cfg.detectNear, 0.25) +
        (num(cfg.detectFar, 1.2) - num(cfg.detectNear, 0.25)) * clamp(d / vision, 0, 1);
      sp.p += dt / Math.max(0.1, need);
      sp.at = now;
      if (sp.p < 1) return;      // 还没“看清”，不参与战斗
      brain.spotting.delete(q.id);
    }

    // 更新记忆 + 速度外推
    let vx = 0, vz = 0;
    if (mem) {
      const dtm = Math.max(0.05, (now - mem.seenAt) / 1000);
      vx = clamp((q.x - mem.x) / dtm, -12, 12);
      vz = clamp((q.z - mem.z) / dtm, -12, 12);
    }
    brain.memory.set(q.id, {
      x: q.x, y: vis.qy, z: q.z, vx, vz,
      seenAt: now, stance: q.stance === 'crouch' || q.stance === 'slide',
      intel: false,
    });
    publishIntel(bot, q.id, q.x, vis.qy, q.z, vx, vz, now);
    brain.lastSeenAt = now;

    // 威胁评分：距离越近越优先；正在瞄我/刚打我的加分；残血目标略优先
    let score = 120 - d * 1.1;
    if (q.aiming) score += 12;
    if (lastDamagedInfo.get(bot.id) && lastDamagedInfo.get(bot.id).byId === q.id) score += 35;
    if (Number.isFinite(q.hp) && q.hp < 40) score += 8;
    if (score > brain.visScore) {
      brain.visScore = score;
      brain.visId = q.id;
      brain.visX = q.x;
      brain.visY = vis.qy;
      brain.visZ = q.z;
      brain.visDist = d;
    }
  });

  // 发现进度条衰减
  if (brain.spotting.size) {
    for (const [id, sp] of brain.spotting) {
      if (sp.at === now) continue;
      sp.p -= dt * 1.8;
      if (sp.p <= 0) brain.spotting.delete(id);
    }
  }

  // 队友情报共享（同队 bot 互相补充最后已知位置）
  if (team) {
    const intel = teamIntel.get(team);
    if (intel) {
      for (const [id, e] of intel) {
        if (now - e.at > num(cfg.loseMemoryMs, 6000)) { intel.delete(id); continue; }
        if (id === brain.visId) continue;
        const mem = brain.memory.get(id);
        if (!mem || e.at > mem.seenAt) {
          brain.memory.set(id, {
            x: e.x, y: num(e.y, 0), z: e.z, vx: num(e.vx, 0), vz: num(e.vz, 0),
            seenAt: e.at, stance: false, intel: true,
          });
        }
      }
    }
  }

  // 记忆过期清理
  if (brain.memory.size) {
    const ttl = num(cfg.loseMemoryMs, 6000);
    for (const [id, m] of brain.memory) {
      if (now - m.seenAt > ttl) brain.memory.delete(id);
    }
  }

  // 听觉：枪声 45m / 脚步 12m（事件 + 近距脚步直接感知）
  if (brain.visId == null) {
    // 附近敌人即使隔着墙也能听到脚步（12m 内）
    eachPlayer(ctx && ctx.players, (q) => {
      if (!q || q === bot || q.alive === false) return;
      if (q.team != null && team != null && q.team === team) return;
      if (!Number.isFinite(q.x) || !Number.isFinite(q.z)) return;
      const d = distXZ(bot.x, bot.z, q.x, q.z);
      if (d <= num(cfg.hearingStep, 12) && brain.visId == null) {
        const err = 0.4 + d * 0.05;
        brain.heardAt = now;
        brain.heardX = q.x + (rand01(ctx) * 2 - 1) * err;
        brain.heardZ = q.z + (rand01(ctx) * 2 - 1) * err;
        brain.heardType = 'step';
      }
    });
  }
}

// 事件（枪声/被击）→ 听觉与警觉
function processEvents(bot, brain, now, ctx, cfg) {
  bindEventBus(ctx && ctx.eventBus);
  const team = bot.team;
  const shotR = num(cfg.hearingShot, 45);
  const stepR = num(cfg.hearingStep, 12);
  const since = brain._evtAt || 0;
  let maxSeq = since;

  const handle = (e) => {
    if (!e || e.seq <= since) return;
    if (e.kind === 'shot') {
      if (e.shooterId === bot.id) return;
      if (e.team != null && team != null && e.team === team) return;  // 队友枪声不预警
      if (!Number.isFinite(e.x) || !Number.isFinite(e.z)) return;
      const d = distXZ(bot.x, bot.z, e.x, e.z);
      if (d > shotR || d < 0.6) return;
      const err = 1.0 + d * 0.10;     // 距离越远，听声辨位越模糊
      brain.heardAt = now;
      brain.heardX = e.x + (rand01(ctx) * 2 - 1) * err;
      brain.heardZ = e.z + (rand01(ctx) * 2 - 1) * err;
      brain.heardType = 'shot';
      brain.alertUntil = now + 3000;
      if (e.shooterId != null) {
        publishIntel(bot, e.shooterId, brain.heardX, 0, brain.heardZ, 0, 0, now);
      }
    } else if (e.kind === 'damaged') {
      if (e.targetId !== bot.id) return;
      const by = e.byId;
      // 服务器 payload 里的 x/z 可能是“被击者”位置：优先用 byId 查攻击者位置
      const attacker = by != null ? findPlayer(ctx && ctx.players, by) : null;
      let hx = NaN, hz = NaN;
      if (attacker && Number.isFinite(attacker.x) && Number.isFinite(attacker.z)) {
        hx = attacker.x;
        hz = attacker.z;
      } else if (Number.isFinite(e.x) && Number.isFinite(e.z) &&
        Math.hypot(e.x - bot.x, e.z - bot.z) > 2) {
        hx = e.x;
        hz = e.z;
      }
      if (Number.isFinite(hx) && Number.isFinite(hz)) {
        brain.heardAt = now;
        brain.heardX = hx;
        brain.heardZ = hz;
        brain.heardType = 'hurt';
        brain.alertUntil = now + 4000;
        brain.forceYaw = angleTo(hx - bot.x, hz - bot.z);
        brain.forceYawUntil = now + 450;      // 被击立即朝来源转身
        if (by != null) {
          publishIntel(bot, by, hx, 0, hz, 0, 0, now);
          const mem = brain.memory.get(by);
          if (!mem) {
            brain.memory.set(by, { x: hx, y: 0, z: hz, vx: 0, vz: 0, seenAt: now, stance: false, intel: true });
          }
        }
      }
    }
    if (e.seq > maxSeq) maxSeq = e.seq;
  };

  // 1) 事件总线队列
  const cutoff = now - 4000;
  for (let i = 0; i < eventQueue.length; i++) {
    const e = eventQueue[i];
    if (e.at < cutoff) continue;
    handle(e);
  }
  // 2) 服务器直接给的每 tick 事件数组（更精确的时序）
  const evs = (ctx && (ctx.events || ctx.sounds || ctx.noises));
  if (Array.isArray(evs)) {
    for (const raw of evs) {
      if (!raw) continue;
      const kind = raw.kind || raw.type || raw.t;
      if (kind === 'shot' || kind === 'damaged' || kind === 'death') {
        queueEvent(kind, raw);
      } else if (kind === 'footstep' || kind === 'step') {
        if (raw.team != null && team != null && raw.team === team) continue;
        if (!Number.isFinite(raw.x) || !Number.isFinite(raw.z)) continue;
        if (distXZ(bot.x, bot.z, raw.x, raw.z) > stepR) continue;
        brain.heardAt = now;
        brain.heardX = num(raw.x, bot.x);
        brain.heardZ = num(raw.z, bot.z);
        brain.heardType = 'step';
      }
    }
  }
  // 3) 服务器直接塞在 bot 上的噪声信息（兼容）
  if (bot.lastNoise && typeof bot.lastNoise === 'object') {
    const e = bot.lastNoise;
    const kind = e.kind || e.type || e.t;
    if ((kind === 'shot' || kind === 'hurt' || kind === 'step') &&
      (!e.at || now - e.at < 3000) && Number.isFinite(e.x) && Number.isFinite(e.z)) {
      const r = kind === 'shot' ? shotR : stepR;
      if (distXZ(bot.x, bot.z, e.x, e.z) <= r) {
        brain.heardAt = now;
        brain.heardX = e.x;
        brain.heardZ = e.z;
        brain.heardType = kind;
      }
    }
    bot.lastNoise = null;
  }
  brain._evtAt = maxSeq;
}

// HP 掉血兜底警觉（服务器没发 damaged 事件时也能反应）
function checkHurt(bot, brain, now, ctx) {
  const hp = Number.isFinite(bot.hp) ? bot.hp : null;
  // 重生检测（服务器回满血 + 位置重置）：清空上一局的记忆/路径，重新决策
  if (hp != null && brain.lastHp != null && hp > brain.lastHp + 20 &&
    (brain.lastHp <= 5 || distXZ(bot.x, bot.z, brain.lastX, brain.lastZ) > 5)) {
    brain.memory.clear();
    brain.spotting.clear();
    brain.path = null;
    brain.pathIndex = 0;
    brain.targetId = null;
    brain.visId = null;
    brain.tgtVisible = false;
    brain.coverPoint = null;
    brain.inCover = false;
    brain.nextThink = 0;
    brain.trackSince = 0;
    brain.burstLeft = 0;
    brain.stuckSince = now;
    brain.lastX = num(bot.x, 0);
    brain.lastZ = num(bot.z, 0);
  }
  if (hp != null && brain.lastHp != null && hp < brain.lastHp - 0.5) {
    brain.alertUntil = now + 4000;
    const dmg = lastDamagedInfo.get(bot.id);
    const fresh = dmg && now - dmg.at < 5000;
    const byId = fresh ? dmg.byId : (bot.lastHitBy != null ? bot.lastHitBy : null);
    const attacker = byId != null ? findPlayer(ctx && ctx.players, byId) : null;
    let hx = NaN, hz = NaN;
    if (attacker && Number.isFinite(attacker.x) && Number.isFinite(attacker.z)) {
      hx = attacker.x;
      hz = attacker.z;
    } else if (fresh && Number.isFinite(dmg.x) && Number.isFinite(dmg.z) &&
      Math.hypot(dmg.x - bot.x, dmg.z - bot.z) > 2) {
      hx = dmg.x;
      hz = dmg.z;
    }
    if (Number.isFinite(hx) && Number.isFinite(hz)) {
      brain.heardAt = now;
      brain.heardX = hx;
      brain.heardZ = hz;
      brain.heardType = 'hurt';
      brain.forceYaw = angleTo(hx - bot.x, hz - bot.z);
      brain.forceYawUntil = now + 450;
    } else if (brain.targetId != null && brain.memory.has(brain.targetId)) {
      const mem = brain.memory.get(brain.targetId);
      brain.forceYaw = angleTo(mem.x - bot.x, mem.z - bot.z);
      brain.forceYawUntil = now + 450;
    }
  }
  if (hp != null) brain.lastHp = hp;
  // 服务器若把攻击来源塞在 bot 上（兼容字段）
  if (bot.hurtFrom && typeof bot.hurtFrom === 'object' &&
    Number.isFinite(bot.hurtFrom.x) && Number.isFinite(bot.hurtFrom.z) &&
    Number.isFinite(bot.hurtFrom.at) && now - bot.hurtFrom.at < 2000) {
    brain.forceYaw = angleTo(bot.hurtFrom.x - bot.x, bot.hurtFrom.z - bot.z);
    brain.forceYawUntil = now + 450;
    brain.alertUntil = now + 3000;
    bot.hurtFrom = null;
  }
}

// ============================================================
// 决策（每 200ms）
// ============================================================
function chooseTarget(bot, brain, now, cfg, ctx) {
  // 可见目标优先
  if (brain.visId != null) {
    if (brain.targetId !== brain.visId) {
      brain.targetId = brain.visId;
      brain.trackSince = now;
      brain.reactAt = now + randRange(ctx, num(cfg.reactionMin, 180), num(cfg.reactionMax, 420));
      brain.aimErr = num(cfg.aimErrorStart, 0.16);
      brain.aimYawOff = 0;
      brain.aimPitchOff = 0;
      brain.burstLeft = 0;
      brain.nextShotAt = now;
      brain.nextBurstAt = now;
      brain.aimHead = rand01(ctx) < num(cfg.aimHeadChance, 0.14);
    }
    brain.tgtVisible = true;
    brain.tgtX = brain.visX;
    brain.tgtY = brain.visY;
    brain.tgtZ = brain.visZ;
    brain.tgtDist = brain.visDist;
    return;
  }
  brain.tgtVisible = false;
  // 否则选记忆/情报里最值得追的目标
  let bestId = null, bestScore = -INF;
  const memTtl = num(cfg.loseMemoryMs, 6000);
  for (const [id, m] of brain.memory) {
    const age = now - m.seenAt;
    if (age > memTtl) continue;
    const d = distXZ(bot.x, bot.z, m.x, m.z);
    let score = 500 - age * 0.08 - d * 1.0;
    if (m.intel) score -= 18;
    if (brain.heardType === 'hurt' && age < 2500) score += 12;
    if (lastDamagedInfo.get(bot.id) && now - lastDamagedInfo.get(bot.id).at < 5000 &&
      lastDamagedInfo.get(bot.id).byId === id) score += 40;
    if (score > bestScore) { bestScore = score; bestId = id; }
  }
  if (bestId != null) {
    brain.targetId = bestId;
    const m = brain.memory.get(bestId);
    const ageS = clamp((now - m.seenAt) / 1000, 0, 1.4);
    brain.tgtX = m.x + num(m.vx, 0) * ageS;
    brain.tgtZ = m.z + num(m.vz, 0) * ageS;
    brain.tgtY = m.y;
    brain.tgtDist = distXZ(bot.x, bot.z, brain.tgtX, brain.tgtZ);
    return;
  }
  brain.targetId = null;
  // 近期听到的动静 → 去查看
  if (now - brain.heardAt < 5000 && Number.isFinite(brain.heardX)) {
    brain.tgtX = brain.heardX;
    brain.tgtZ = brain.heardZ;
    brain.tgtY = 0;
    brain.tgtDist = distXZ(bot.x, bot.z, brain.tgtX, brain.tgtZ);
  } else {
    brain.tgtDist = INF;
  }
}

function chooseObjective(bot, brain, now, ctx, cfg) {
  const W = worldCfg(ctx);
  const nav = navFor(ctx);
  const hp = num(bot.hp, num(W.maxHp, 100));
  const maxHp = num(W.maxHp, 100);
  const hpFrac = hp / Math.max(1, maxHp);
  const team = bot.team || 'bravo';

  // 低血且附近有医疗包 → 先去捡
  if (hpFrac < 0.6) {
    let bestItem = null, bestD = 30;
    eachItem(ctx && ctx.items, (it) => {
      if (!it || !Number.isFinite(it.x) || !Number.isFinite(it.z)) return;
      const type = it.type || it.kind;
      if (type !== 'medkit' && type !== 'health' && type !== 'heal') return;
      const d = distXZ(bot.x, bot.z, it.x, it.z);
      if (d < bestD) { bestD = d; bestItem = it; }
    });
    if (bestItem) {
      brain.objType = 'item';
      return { x: bestItem.x, z: bestItem.z };
    }
  }

  const zones = Array.isArray(ctx && ctx.zones) && ctx.zones.length ? ctx.zones : STATIC_ZONES;
  let claims = zoneClaims.get(team);
  if (!claims) { claims = new Map(); zoneClaims.set(team, claims); }
  let best = null, bestScore = -INF;
  for (const z of zones) {
    if (!z || !Number.isFinite(z.x) || !Number.isFinite(z.z)) continue;
    const d = distXZ(bot.x, bot.z, z.x, z.z);
    const owner = z.owner || z.team || null;
    const capturePush = Math.abs(num(z.capture, num(z.progress, 0)));
    let score = -d * 0.12;
    if (owner !== team) score += 55;                    // 优先占点
    if (z.contested) score += 6;
    if (capturePush > 0.5) score += 10;                 // 争夺已推进大半：优先去抢/回防
    if (owner === team && capturePush < 0.75) score += 16; // 己方据点正在被推：回防
    const claim = claims.get(z.id);
    if (claim && claim.botId !== bot.id && now - claim.at < ZONE_CLAIM_TTL) score -= 38; // 队友已去，别扎堆
    // 更强的分散权重：避免所有 AI 都挤到中央据点叠在一起开火（会造成客户端剧烈掉帧）
    score -= d * 0.10;
    if (score > bestScore) { bestScore = score; best = z; }
  }
  if (best) {
    claims.set(best.id, { botId: bot.id, at: now });
    brain.objZoneId = best.id;
    brain.objType = 'zone';
    return { x: best.x, z: best.z };
  }
  // 兜底：随机巡逻点
  brain.objType = 'patrol';
  const p = nav ? randomWalkable(nav, () => rand01(ctx)) : null;
  return p ? { x: p.x, z: p.z } : { x: bot.x, z: bot.z };
}

// 规划路径到 (gx,gz)。返回 true 表示有路（或直线可走）。
// 节流：路径最多每 2s 重算一次；目标移动 >3.5m 或卡住时允许提前重算（最短间隔 550ms）。
function planTo(bot, brain, now, ctx, gx, gz, force) {
  const nav = navFor(ctx);
  const cfg = cfgFor(bot);
  if (!nav) {
    brain.path = null;
    brain.moveMode = 'direct';
    brain.arriveX = gx;
    brain.arriveZ = gz;
    return false;
  }
  const goalMoved = brain.pathGoal ? distXZ(brain.pathGoal.x, brain.pathGoal.z, gx, gz) : INF;
  if (!force) {
    if (brain.path && brain.path.length) {
      // 最近的路径仍然有效：目标没怎么动 / 还没到重算时间 → 复用
      if (now < brain.pathAt + 550) return true;
      if (now < brain.pathNextAt && goalMoved <= 3.5) return true;
    } else if (now < brain.pathFailAt + 700) {
      // 刚失败过：不要每 tick 重试 A*
      return brain.moveMode === 'direct';
    }
  }

  let path = null;
  try { path = findPath(nav, bot.x, bot.z, gx, gz); } catch { path = null; }
  brain.pathAt = now;
  brain.pathNextAt = now + num(cfg.repathMs, 2000);
  brain.pathGoal = { x: gx, z: gz };
  if (path && path.length) {
    brain.path = path;
    brain.pathIndex = 0;
    brain.pathFailAt = 0;
    brain.moveMode = 'path';
    return true;
  }
  // 无路：能直线走就直走；否则原地防守/等下一次重规划（由调用方兜底）
  brain.path = null;
  brain.pathFailAt = now;
  if (hasLineOfWalk(nav, bot.x, bot.z, gx, gz)) {
    brain.moveMode = 'direct';
    brain.arriveX = gx;
    brain.arriveZ = gz;
    return true;
  }
  brain.moveMode = 'hold';
  return false;
}

function think(bot, brain, now, ctx, cfg) {
  const W = worldCfg(ctx);
  const nav = navFor(ctx);
  const maxHp = num(W.maxHp, 100);
  const hp = num(bot.hp, maxHp);
  const hpFrac = hp / Math.max(1, maxHp);

  chooseTarget(bot, brain, now, cfg, ctx);

  // ---- 掩体状态：到达掩体点 → 进入；威胁走远/超时 → 脱离 ----
  if (!brain.inCover && brain.coverPoint) {
    if (now > brain.coverUntil) brain.coverPoint = null;
    else if (distXZ(bot.x, bot.z, brain.coverPoint.x, brain.coverPoint.z) < 1.6) {
      brain.inCover = true;
      brain.peekAt = now;
    }
  }
  if (brain.inCover) {
    const mem = brain.memory.get(brain.targetId);
    const tx = brain.tgtVisible ? brain.tgtX : (mem ? mem.x : NaN);
    const tz = brain.tgtVisible ? brain.tgtZ : (mem ? mem.z : NaN);
    const threatAway = !Number.isFinite(tx) ||
      distXZ(tx, tz, brain.coverThreatX, brain.coverThreatZ) > 12;
    if (now > brain.coverUntil || threatAway) {
      brain.inCover = false;
      brain.coverPoint = null;
    }
  }

  const hasTarget = brain.targetId != null;
  const visible = brain.tgtVisible;
  const tgtDist = brain.tgtDist;
  brain.wantFire = false;
  brain.wantReload = false;
  brain.wantSwitch = null;
  brain.wantAim = false;
  brain.wantSprint = false;
  brain.wantCrouch = false;
  brain.wantsMove = false;

  // ---- 瞄准误差：持续追踪收敛 ----
  if (visible) {
    const trackS = Math.max(0, (now - brain.trackSince) / 1000);
    const settle = clamp(trackS / num(cfg.aimSettle, 1.2), 0, 1);
    const base = num(cfg.aimErrorMin, 0.012) +
      (num(cfg.aimErrorStart, 0.16) - num(cfg.aimErrorMin, 0.012)) * (1 - settle);
    const distFactor = 0.55 + clamp(tgtDist / num(cfg.visionRadius, 55), 0, 1) * 0.9;
    const moveFactor = brain.wantsMove ? 1.2 : 1;
    const err = clamp(base * distFactor * moveFactor,
      num(cfg.aimErrorMin, 0.012), num(cfg.aimErrorStart, 0.16) * 1.8);
    brain.aimErr = err;
    if (now - brain.aimOffAt > 420) {
      brain.aimOffAt = now;
      brain.aimYawOff = (rand01(ctx) * 2 - 1) * err;
      brain.aimPitchOff = (rand01(ctx) * 2 - 1) * err * 0.65;
      if (rand01(ctx) < 0.1) brain.aimHead = !brain.aimHead;
    }
  }

  // ---- 被击：立即警觉（think 里重置反应时间，低血撤退）----
  const isHurt = now < brain.alertUntil;
  if (isHurt && brain.heardType === 'hurt' && now - brain.heardAt < 250) {
    brain.reactAt = Math.min(brain.reactAt, now + 80);
  }

  // ---- 状态机 ----
  if (visible) {
    const hpLow = hpFrac <= num(cfg.retreatHpFrac, 0.32);
    const wantCover = hpLow ||
      (hpFrac <= num(cfg.coverHpFrac, 0.55) && !brain.inCover) ||
      (tgtDist > 12 && tgtDist < 46 && now >= brain.coverNextAt &&
        rand01(ctx) < (isHurt ? 0.55 : 0.22));
    // 已有掩体点且未到：先去掩体
    if (wantCover && now >= brain.coverNextAt) {
      brain.coverNextAt = now + num(cfg.coverCheckMs, 4500) + randRange(ctx, 0, 1500);
      const navOK = nav != null;
      const c = navOK ? sampleCover(nav, bot.x, bot.z, brain.tgtX, brain.tgtZ) : null;
      if (c) {
        brain.coverPoint = c;
        brain.coverThreatX = brain.tgtX;
        brain.coverThreatZ = brain.tgtZ;
        brain.coverAt = now;
        brain.coverUntil = now + 5000;
        brain.inCover = false;
        planTo(bot, brain, now, ctx, c.x, c.z, true);
        brain.state = hpLow ? 'retreat' : 'combat';
        brain.wantsMove = true;
        brain.wantSprint = hpLow;
        brain.wantCrouch = false;
        brain.wantAim = false;
        brain.wantFire = false;
        brain.lastDecision = 'cover';
        return;
      }
    }
    brain.state = hpLow ? 'retreat' : 'combat';
    // 正在前往掩体：优先走完（不直线暴露）
    if (brain.coverPoint && !brain.inCover && now < brain.coverUntil) {
      const dc = distXZ(bot.x, bot.z, brain.coverPoint.x, brain.coverPoint.z);
      if (dc > 1.4) {
        planTo(bot, brain, now, ctx, brain.coverPoint.x, brain.coverPoint.z, false);
        if (brain.path) {
          brain.moveMode = 'path';
          brain.wantsMove = true;
          brain.wantSprint = hpFrac < 0.5;
          brain.wantAim = false;
          brain.desiredYaw = angleTo(brain.tgtX - bot.x, brain.tgtZ - bot.z);
          brain.lastDecision = 'cover-approach';
          return;
        }
        brain.coverPoint = null;   // 去不了，放弃该掩体
      }
    }
    const wi = weaponInfo(bot.weapon);
    // 交战距离：优先用「小队角色」的偏好区间，没有角色配置时退回武器默认
    const roleRange = rolePreferredRange(bot);
    const pref = roleRange ? [roleRange.min, roleRange.max] : (PREF_RANGE[wi.kind] || [8, 22]);
    brain.wantAim = tgtDist > 6;
    if (brain.inCover) {
      // 掩体后：蹲/探头节奏；蹲下时不开枪
      if (now > brain.peekAt) {
        brain.peekUntil = now + randRange(ctx, 550, 1100);
        brain.peekAt = brain.peekUntil + randRange(ctx, 900, 1900);
      }
      const peek = now < brain.peekUntil;
      brain.wantCrouch = !peek;
      brain.moveMode = 'hold';
      brain.wantsMove = false;
      brain.desiredYaw = angleTo(brain.tgtX - bot.x, brain.tgtZ - bot.z);
    } else if (tgtDist > pref[1] + 3) {
      // 距离太远：推进（走 A*，不直线冲）
      planTo(bot, brain, now, ctx, brain.tgtX, brain.tgtZ, false);
      brain.moveMode = brain.path ? 'path' : 'advance';
      brain.wantsMove = true;
      brain.wantSprint = tgtDist > 26 && !visible;
      brain.desiredYaw = angleTo(brain.tgtX - bot.x, brain.tgtZ - bot.z);
    } else if (tgtDist < pref[0]) {
      // 太近：后撤 + 侧移
      brain.moveMode = 'retreat';
      brain.wantsMove = true;
      brain.desiredYaw = angleTo(brain.tgtX - bot.x, brain.tgtZ - bot.z);
    } else {
      // 合适距离：左右移动（strafe），偶尔停下射击
      if (now > brain.strafeUntil) {
        brain.strafeUntil = now + randRange(ctx, 550, 1300);
        brain.strafeDir = rand01(ctx) < 0.5 ? -1 : 1;
        if (rand01(ctx) < 0.25) brain.strafeDir = 0;   // 0 = 站定开火
      }
      brain.moveMode = brain.strafeDir === 0 ? 'hold' : 'strafe';
      brain.wantsMove = brain.strafeDir !== 0;
      brain.desiredYaw = angleTo(brain.tgtX - bot.x, brain.tgtZ - bot.z);
    }
    brain.lastDecision = 'combat';
  } else if ((hasTarget || now - brain.heardAt < 5000) && tgtDist < INF) {
    // 追击：记忆/情报位置，绕侧包抄（不直线冲）
    brain.state = 'hunt';
    if (now > brain.flankFlipAt) {
      brain.flankFlipAt = now + randRange(ctx, 6000, 11000);
      brain.flankSide = rand01(ctx) < 0.5 ? -1 : 1;
    }
    let gx = brain.tgtX, gz = brain.tgtZ;
    const d = Math.max(0.001, distXZ(bot.x, bot.z, gx, gz));
    const age = brain.memory.has(brain.targetId)
      ? now - brain.memory.get(brain.targetId).seenAt : 9999;
    if (d > 12 && age < 4000) {
      const perpX = -(gz - bot.z) / d, perpZ = (gx - bot.x) / d;
      const off = num(cfg.flankDistance, 11) * brain.flankSide *
        clamp(d / 30, 0.5, 1.2);
      gx += perpX * off;
      gz += perpZ * off;
      if (nav) {
        const nw = nearestWalkable(nav, gx, gz);
        if (nw) { gx = nw.x; gz = nw.z; }
      }
    }
    planTo(bot, brain, now, ctx, gx, gz, false);
    brain.wantsMove = true;
    brain.wantSprint = d > num(cfg.sprintDist, 14) && !isHurt;
    brain.wantAim = hasTarget && d < 30;
    brain.desiredYaw = angleTo(brain.tgtX - bot.x, brain.tgtZ - bot.z);
    brain.wantCrouch = false;
    brain.lastDecision = 'hunt';
  } else {
    // 无敌情：占点 / 防守 / 巡逻 / 捡道具
    brain.state = 'objective';
    const goal = chooseObjective(bot, brain, now, ctx, cfg);
    const dGoal = distXZ(bot.x, bot.z, goal.x, goal.z);
    // 已经在据点里且无需重新走位 → 原地防守
    const z = brain.objZoneId ? zonesGet(ctx, brain.objZoneId) : null;
    const inZone = z && distXZ(bot.x, bot.z, z.x, z.z) <= z.r * 0.85;
    if (inZone && brain.objType === 'zone' && dGoal < z.r && now - brain.patrolAt < 4000) {
      brain.moveMode = 'hold';
      brain.wantsMove = false;
      brain.wantCrouch = rand01(ctx) < 0.35;
      // 面向可能来敌的方向：最近威胁方向 / 地图中心
      if (Number.isFinite(brain.lastThreatX)) {
        brain.desiredYaw = angleTo(brain.lastThreatX - bot.x, brain.lastThreatZ - bot.z);
      } else {
        brain.desiredYaw = angleTo(-bot.x, -bot.z);
      }
    } else {
      planTo(bot, brain, now, ctx, goal.x, goal.z, false);
      brain.wantsMove = brain.path ? true : dGoal > 1.2;
      brain.wantSprint = dGoal > num(cfg.sprintDist, 14);
      brain.wantAim = false;
      brain.wantCrouch = false;
      brain.desiredYaw = brain.path && brain.path.length
        ? 0   // 交给 act 用移动方向
        : angleTo(goal.x - bot.x, goal.z - bot.z);
      if (brain.patrolAt < now) {
        brain.patrolAt = now + randRange(ctx, 2500, 4500);
        if (inZone) brain.objAt = now;
      }
    }
    brain.lastDecision = 'objective';
  }

  // ---- 卡住/矮障碍：起跳 ----
  if (brain.wantsMove && nav && bot.grounded !== false) {
    const los = nav.lowObstacles;
    const mx = bot.x, mz = bot.z;
    for (let i = 0; i < los.length; i++) {
      const o = los[i];
      const d = distXZ(mx, mz, o.x, o.z);
      if (d > 2.4) continue;
      const top = o.h - groundY(bot, ctx);
      if (top < 0.25 || top > 1.05) continue;
      const ang = angleTo(o.x - mx, o.z - mz);
      if (Math.abs(wrapAngle(ang - bot.yaw)) < 50 * DEG) {
        brain.jumpAt = now + 160;
        break;
      }
    }
  }

  // ---- 换弹（弹匣见底或在掩体后补弹）----
  const wi = weaponInfo(bot.weapon);
  const am = ammoFor(bot);
  if (am && Number.isFinite(am.mag)) {
    const mag = am.mag;
    const reserve = am.reserve;
    const haveReserve = reserve === Infinity || !Number.isFinite(reserve) || reserve > 0;
    if (mag <= 0 && haveReserve) {
      requestReload(bot, brain, now, ctx);
    } else if (mag < wi.magSize * 0.35 && haveReserve && !visible && now - brain.lastSeenAt > 1500) {
      requestReload(bot, brain, now, ctx);
    } else if (mag <= 0 && !haveReserve) {
      // 主武器打空且无备弹：切手枪
      if (bot.owned && bot.owned.pistol && bot.weapon !== 'pistol') brain.wantSwitch = 'pistol';
    }
  }
  brain.aimHead = brain.aimHead || false;
}

function zonesGet(ctx, id) {
  const zs = Array.isArray(ctx && ctx.zones) && ctx.zones.length ? ctx.zones : STATIC_ZONES;
  for (const z of zs) if (z && z.id === id) return z;
  return null;
}

function requestReload(bot, brain, now, ctx) {
  if (brain.wantReload) return;
  brain.wantReload = true;
  bot.wantReload = true;
  if (now - brain.reloadAskAt < 800) return;
  brain.reloadAskAt = now;
  if (ctx && typeof ctx.requestReload === 'function') {
    try { ctx.requestReload(bot); } catch { /* ignore */ }
  }
}

// ============================================================
// 执行（每次 aiUpdate 都跑）：转向限速 / 移动输入 / 卡住检测 / 开火节奏
// fireOnly=true 时只做「瞄准 + 开火」（用于子帧之间的轻量帧，保证连发不断档），
// 跳过寻路推进与卡住检测，避免每 tick 都跑 A*。
// ============================================================
function act(bot, brain, now, ctx, cfg, opts) {
  const fireOnly = !!(opts && opts.fireOnly);
  const W = worldCfg(ctx);
  const nav = navFor(ctx);
  const dt = clamp(brain.dt, 0.001, 0.5);
  bot.wantFire = false;
  bot.wantReload = brain.wantReload;

  if (fireOnly) {
    // 轻量帧：沿用上一帧的移动输入，只刷新朝向与开火
    let desiredYaw = Number.isFinite(brain.desiredYaw) ? brain.desiredYaw : bot.yaw;
    let desiredPitch = 0;
    if (brain.tgtVisible) {
      const aim = aimPoint(bot, brain, W);
      desiredYaw = angleTo(aim.x - bot.x, aim.z - bot.z);
      const dx = aim.x - bot.x, dz = aim.z - bot.z;
      const dy = aim.y - eyeInfo(bot, W, ctx).y;
      desiredPitch = clamp(Math.atan2(dy, Math.max(0.3, Math.hypot(dx, dz))), -1.2, 1.2);
    }
    const turnRate = num(cfg.turnRate, 3.4);
    const yawStep = turnRate * dt;
    bot.yaw = wrapAngle(bot.yaw + clamp(wrapAngle(desiredYaw - bot.yaw), -yawStep, yawStep));
    const pitchStep = num(cfg.turnAimRate, 2.6) * dt;
    bot.pitch = clamp(bot.pitch + clamp(desiredPitch - bot.pitch, -pitchStep, pitchStep), -1.2, 1.2);
    if (!bot.input) bot.input = {};
    tryFire(bot, brain, now, ctx, cfg);
    return;
  }

  // ---- 移动方向（先算方向，再决定面朝敌人还是面朝行进方向）----
  let wx = 0, wz = 0, hasDir = false;
  let jump = false;
  const sprintOK = num(bot.stamina, num(W.staminaMax, 100)) > 15;

  if (brain.moveMode === 'path' || brain.moveMode === 'direct') {
    const dir = stepAndFollowPath(bot, brain, now, ctx);
    if (dir) { wx = dir.x; wz = dir.z; hasDir = true; }
  } else if (brain.moveMode === 'strafe') {
    // 相对目标方向的垂直方向移动
    const dx = brain.tgtX - bot.x, dz = brain.tgtZ - bot.z;
    const d = Math.max(0.001, Math.hypot(dx, dz));
    wx = (-dz / d) * brain.strafeDir;
    wz = (dx / d) * brain.strafeDir;
    hasDir = true;
    // 太近/太远时叠加前后分量
    if (d < 7) { wx -= (dx / d) * 0.35; wz -= (dz / d) * 0.35; }
    else if (d > 22) { wx += (dx / d) * 0.35; wz += (dz / d) * 0.35; }
  } else if (brain.moveMode === 'retreat') {
    const dx = brain.tgtX - bot.x, dz = brain.tgtZ - bot.z;
    const d = Math.max(0.001, Math.hypot(dx, dz));
    wx = -dx / d;
    wz = -dz / d;
    // 侧向滑步，避免直线后退
    wx += (-dz / d) * 0.4 * brain.strafeDir;
    wz += (dx / d) * 0.4 * brain.strafeDir;
    hasDir = true;
  } else if (brain.moveMode === 'advance') {
    const dx = brain.tgtX - bot.x, dz = brain.tgtZ - bot.z;
    const d = Math.max(0.001, Math.hypot(dx, dz));
    wx = dx / d;
    wz = dz / d;
    hasDir = true;
  }
  // 卡住后的绕行（横向脱离）
  if (now < brain.detourUntil) {
    wx += brain.detourX;
    wz += brain.detourZ;
    hasDir = true;
  }

  // ---- 期望朝向 + 转向限速（人不能瞬间转身，约 3.4 rad/s）----
  let desiredYaw = Number.isFinite(brain.desiredYaw) ? brain.desiredYaw : bot.yaw;
  let desiredPitch = 0;
  if (brain.tgtVisible) {
    const aim = aimPoint(bot, brain, W);
    desiredYaw = angleTo(aim.x - bot.x, aim.z - bot.z);
    const dx = aim.x - bot.x, dz = aim.z - bot.z;
    const dy = aim.y - eyeInfo(bot, W, ctx).y;
    desiredPitch = clamp(Math.atan2(dy, Math.max(0.3, Math.hypot(dx, dz))), -1.2, 1.2);
  } else if (hasDir) {
    // 无敌情时朝行进方向（视野朝前，行为更自然）
    desiredYaw = angleTo(wx, wz);
  }
  let turnRate = num(cfg.turnRate, 3.4);
  if (now < brain.forceYawUntil) {
    desiredYaw = brain.forceYaw;
    desiredPitch = 0;
    turnRate *= 2.2;
  }
  const yawStep = turnRate * dt;
  bot.yaw = wrapAngle(bot.yaw + clamp(wrapAngle(desiredYaw - bot.yaw), -yawStep, yawStep));
  const pitchStep = num(cfg.turnAimRate, 2.6) * dt;
  bot.pitch = clamp(bot.pitch + clamp(desiredPitch - bot.pitch, -pitchStep, pitchStep), -1.2, 1.2);

  // ---- 卡住检测：位移 < 0.1m 持续 0.8s ----
  const moved = distXZ(brain.lastX, brain.lastZ, bot.x, bot.z);
  const wantMove = brain.moveMode !== 'hold' && (hasDir || brain.wantsMove);
  if (moved >= num(cfg.stuckMinMove, 0.1)) {
    brain.lastX = bot.x;
    brain.lastZ = bot.z;
    brain.stuckSince = now;
    brain.stuckCount = 0;
  } else if (wantMove && brain.moveMode !== 'hold' && now - brain.stuckSince >= num(cfg.stuckMs, 800)) {
    brain.stuckSince = now;
    brain.stuckCount++;
    brain.jumpAt = now + 150;                       // 先试着跳
    brain.pathNextAt = 0;                           // 强制重规划
    if (brain.stuckCount >= 2) {
      brain.stuckCount = 0;
      brain.detourUntil = now + 700;
      const ang = randRange(ctx, 0, TAU);
      brain.detourX = Math.cos(ang) * 0.8;
      brain.detourZ = Math.sin(ang) * 0.8;
      brain.path = null;
      brain.moveMode = 'hold';
      // 随机游走兜底（无路/卡住时不僵死）
      if (nav) {
        const p = randomWalkable(nav, () => rand01(ctx));
        if (p) planTo(bot, brain, now, ctx, p.x, p.z, true);
      }
    } else {
      if (brain.pathGoal) planTo(bot, brain, now, ctx, brain.pathGoal.x, brain.pathGoal.z, true);
    }
  }

  // ---- 写入移动输入 ----
  let mx = 0, mz = 0;
  if (hasDir && wantMove) {
    const len = Math.hypot(wx, wz);
    if (len > 1e-4) {
      wx /= len;
      wz /= len;
      const sin = Math.sin(bot.yaw), cos = Math.cos(bot.yaw);
      const fx = -sin, fz = -cos;      // 前
      const rx = cos, rz = -sin;       // 右
      mz = wx * fx + wz * fz;
      mx = wx * rx + wz * rz;
      const l2 = Math.hypot(mx, mz);
      if (l2 > 1) { mx /= l2; mz /= l2; }
    }
  }
  if (now < brain.jumpAt) jump = true;
  if (!bot.input) bot.input = {};
  bot.input.mx = clamp(mx, -1, 1);
  bot.input.mz = clamp(mz, -1, 1);
  bot.input.jump = jump;
  const sprint = !!(brain.wantSprint && sprintOK && !brain.wantAim && !brain.wantCrouch && brain.tgtVisible === false);
  bot.input.sprint = sprint;
  bot.input.crouch = !!brain.wantCrouch;
  bot.input.aim = !!brain.wantAim;
  bot.sprint = sprint;
  bot.stance = brain.wantCrouch ? 'crouch' : 'stand';
  bot.aiming = !!brain.wantAim && bot.stance !== 'crouch';
  if (!hasDir || !wantMove) {
    bot.input.mx = 0;
    bot.input.mz = 0;
  }

  // ---- 开火 ----
  if (now < brain.jumpAt) jump = true;
  tryFire(bot, brain, now, ctx, cfg);
}

function aimPoint(bot, brain, W) {
  const crouch = brain.memory.has(brain.targetId) ? brain.memory.get(brain.targetId).stance : false;
  const baseY = brain.tgtVisible ? brain.visY : brain.tgtY;
  const headOff = num(W.headY, 1.68) * (crouch ? 0.68 : 1);
  const chestOff = crouch ? 0.78 : 1.05;
  const off = brain.aimHead ? headOff : chestOff;
  return { x: brain.tgtX, y: num(baseY, 0) + off, z: brain.tgtZ };
}

// 路径跟随：返回单位世界方向（x,z）或 null；到达终点返回 null
function stepAndFollowPath(bot, brain, now, ctx) {
  if (brain.moveMode === 'direct') {
    const d = distXZ(bot.x, bot.z, brain.arriveX, brain.arriveZ);
    if (d < num(cfgFor(bot).arriveRadius, 0.8)) { brain.moveMode = 'hold'; return null; }
    return { x: (brain.arriveX - bot.x) / d, z: (brain.arriveZ - bot.z) / d };
  }
  const path = brain.path;
  if (!path || !path.length) { brain.moveMode = 'hold'; return null; }
  const arriveR = num(cfgFor(bot).arriveRadius, 0.8);
  // 到达半径 0.8m；连续推进多个点
  let i = brain.pathIndex;
  while (i < path.length && distXZ(bot.x, bot.z, path[i].x, path[i].z) < arriveR) i++;
  if (i >= path.length) {
    brain.path = null;
    brain.pathIndex = 0;
    brain.moveMode = 'hold';
    return null;
  }
  brain.pathIndex = i;
  const wp = path[i];
  const dx = wp.x - bot.x, dz = wp.z - bot.z;
  const d = Math.hypot(dx, dz);
  if (d < 1e-4) return null;
  return { x: dx / d, z: dz / d };
}

// 友军是否挡在射线上（不误伤）
function friendlyInLine(bot, brain, ctx) {
  if (!ctx || !ctx.players) return false;
  const dx = brain.tgtX - bot.x, dz = brain.tgtZ - bot.z;
  const len = Math.hypot(dx, dz);
  if (len < 0.5) return false;
  const ux = dx / len, uz = dz / len;
  let blocked = false;
  eachPlayer(ctx.players, (q) => {
    if (blocked || !q || q === bot || q.id === bot.id) return;
    if (q.alive === false) return;
    if (q.team == null || bot.team == null || q.team !== bot.team) return;
    const rx = q.x - bot.x, rz = q.z - bot.z;
    const along = rx * ux + rz * uz;
    if (along <= 0.3 || along > len + 1.5) return;
    const perp = Math.abs(rx * uz - rz * ux);
    if (perp < 1.1) blocked = true;
  });
  return blocked;
}

function tryFire(bot, brain, now, ctx, cfg) {
  if (!brain.tgtVisible || brain.targetId == null) return;
  if (now < brain.reactAt) return;                       // 反应时间
  if (bot.reloadUntil && now < bot.reloadUntil) return;  // 换弹中
  if (bot.swapUntil && now < bot.swapUntil) return;      // 切枪硬直
  const W = worldCfg(ctx);
  const wi = weaponInfo(bot.weapon);
  const shootRange = Math.min(num(cfg.shootRange, 55), wi.range);
  if (brain.tgtDist > shootRange) return;

  // 弹药/换弹
  const am = ammoFor(bot);
  if (am && Number.isFinite(am.mag) && am.mag <= 0) {
    requestReload(bot, brain, now, ctx);
    return;
  }
  if (bot.stance === 'crouch' && brain.inCover) return;   // 蹲在掩体后不盲射（探头时再打）
  if (now < brain.nextShotAt) return;

  // 不隔墙开枪：开火前再确认一次双点 LOS
  const eye = eyeInfo(bot, W);
  const aim = aimPoint(bot, brain, W);
  const clear = losOk(ctx, navFor(ctx), bot.x, eye.y, bot.z, aim.x, aim.y, aim.z);
  if (!clear) {
    // 被遮挡：重新找目标/换位，不开枪
    brain.reactAt = Math.min(brain.reactAt, now + 120);
    return;
  }
  if (friendlyInLine(bot, brain, ctx)) return;

  // ---- 开火节奏：全自动武器"长按扳机"，半自动/大威力才点射 ----
  // 长按语义：只要目标持续可见且在射程内，就按武器真实射速连续射击（trigger 保持按下），
  // 只有目标消失/换弹/需要重新瞄准时才松开。这比"固定 N 发一组"更像真人压枪扫射。
  const fullAuto = wi.fireMode !== 'semi' && (wi.fireInterval * 1000) <= 140;
  const holdMs = num(cfg.triggerHoldMs, 900);        // 一次长按最长持续时间
  if (fullAuto) {
    if (!brain.triggerHeld) {
      // 开始一次新的长按
      brain.triggerHeld = true;
      brain.triggerAt = now;
      brain.triggerUntil = now + holdMs + randRange(ctx, 0, 700);
    } else if (now > brain.triggerUntil) {
      // 长按到时间：短暂松开再按（避免无限扫射，也让射击有呼吸感）
      brain.triggerHeld = false;
      brain.nextBurstAt = now + randRange(ctx, num(cfg.burstPauseMin, 260) * 0.5, num(cfg.burstPauseMax, 620) * 0.5);
      return;
    }
  } else {
    // 半自动 / 霰弹 / 狙击：仍用点射分组
    if (brain.burstLeft <= 0) {
      if (now < brain.nextBurstAt) return;
      brain.burstLeft = randInt(ctx, num(cfg.burstMin, 3), num(cfg.burstMax, 6));
    }
  }

  // 瞄准误差（持续追踪收敛后的偏移）
  const fireYaw = wrapAngle(angleTo(aim.x - bot.x, aim.z - bot.z) + brain.aimYawOff);
  const dy = aim.y - eye.y;
  const firePitch = clamp(
    Math.atan2(dy, Math.max(0.3, Math.hypot(aim.x - bot.x, aim.z - bot.z))) + brain.aimPitchOff,
    -1.2, 1.2,
  );

  if (!fullAuto) brain.burstLeft--;
  brain.lastShotRequestAt = now;
  // 长按时用武器真实射速（只受角色 fireRateMultiplier 影响），不打点射间隔
  const fireIntervalMs = Math.max(45, (wi.fireInterval * 1000) /
    Math.max(0.35, num(cfg.fireRateMultiplier, 0.85)));
  brain.nextShotAt = now + fireIntervalMs;
  if (!fullAuto && brain.burstLeft <= 0) {
    brain.nextBurstAt = now + fireIntervalMs +
      randRange(ctx, num(cfg.burstPauseMin, 160), num(cfg.burstPauseMax, 400));
  }

  // 输出开火请求（三种服务器约定都兼容）
  bot.nextFireAt = brain.nextShotAt;
  bot.fireYaw = fireYaw;
  bot.firePitch = firePitch;
  if (ctx && typeof ctx.requestFire === 'function') {
    try { ctx.requestFire(bot, fireYaw, firePitch); } catch { /* ignore */ }
  } else {
    bot.wantFire = true;
    bot.fireAt = now;
    bot.wantFireAt = now;
    bot.yaw = fireYaw;
    bot.pitch = firePitch;
  }
}

// ============================================================
// 入口
// ============================================================
export function aiUpdate(bot, now, ctx, opts) {
  if (!bot || typeof bot !== 'object') return;
  // 死亡：清决策状态，等服务器重生
  if (bot.alive === false) {
    const b = bot.brain;
    if (b) {
      b.wasDead = true;
      b.nextThink = 0;
      b.path = null;
      b.targetId = null;
      b.visId = null;
      b.tgtVisible = false;
      b.wantFire = false;
      b.wantReload = false;
      b.inCover = false;
    }
    return;
  }
  const t = Number.isFinite(now) ? now : Date.now();
  let brain;
  try {
    brain = ensureBot(bot);
    if (brain.wasDead) {
      // 重生：重置记忆与路径，避免带着死亡前的状态
      brain.wasDead = false;
      brain.nextThink = 0;
      brain.path = null;
      brain.targetId = null;
      brain.memory.clear();
      brain.spotting.clear();
      brain.lastHp = Number.isFinite(bot.hp) ? bot.hp : null;
      brain.stuckSince = t;
      brain.lastX = num(bot.x, 0);
      brain.lastZ = num(bot.z, 0);
    }
    const cfg = cfgFor(bot);
    brain.dt = brain.lastUpdate > 0 ? clamp((t - brain.lastUpdate) / 1000, 0.001, 0.5) : 0.2;

    sense(bot, brain, t, ctx, cfg);
    processEvents(bot, brain, t, ctx, cfg);
    checkHurt(bot, brain, t, ctx);

    // 重决策（A* 寻路 / 选点 / 选掩体）可以按子帧分摊；
    // 但轻量级部分（感知 + 开火）必须每个 tick 都跑，否则 AI 打不出连发。
    const wantHeavy = !opts || opts.heavy !== false;
    if (wantHeavy && (t >= brain.nextThink || brain.firstThink)) {
      brain.firstThink = false;
      think(bot, brain, t, ctx, cfg);
      brain.nextThink = t + num(cfg.tickMs, 200) + randRange(ctx, -20, 20);
    }

    act(bot, brain, t, ctx, cfg, { fireOnly: !wantHeavy });
    brain.lastUpdate = t;
    // 供 HUD/调试读取（只写 brain 与约定字段）
    bot.targetId = brain.targetId;
    bot.path = brain.path;
  } catch (err) {
    // 单个 AI 异常不允许拖垮服务器：记录一次并重置到安全状态
    const b = bot.brain;
    if (b && !b._err) {
      b._err = String((err && err.stack) || err);
      if (typeof console !== 'undefined' && console.error) {
        console.error('[ai] aiUpdate 异常（已降级安全状态）', b._err);
      }
    }
    safeReset(bot);
  }
}
