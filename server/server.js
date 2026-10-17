// ===== 霓虹战场 · 游戏服务器 =====
// WebSocket 实时同步 + 权威移动/命中校验 + 生产模式静态托管 dist/

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { WORLD, COLLIDERS, TERRAIN as TERRAIN_FOR_SPOT, SPAWNS, PLAYER_COLORS, BOT_COLORS, BOTS, WEAPONS, ITEMS, ITEM_TYPES, circleOverlapsBox, stepPlayerPhysics } from '../shared/map.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 3001);
const TICK_MS = 1000 / WORLD.stateHz;

const players = new Map(); // id -> player
let nextId = 1;
const items = new Map(); // id -> 地面道具
let itemSeq = 1;

// ---------- 工具 ----------
function clampNum(v, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(v) ? v : 0));
}

function normalizeYaw(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function dirFromYawPitch(yaw, pitch) {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const lx = cx - ox, ly = cy - oy, lz = cz - oz;
  const b = lx * dx + ly * dy + lz * dz;
  const c = lx * lx + ly * ly + lz * lz - r * r;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const t1 = b - Math.sqrt(disc);
  if (t1 > 0) return t1;
  const t2 = b + Math.sqrt(disc);
  return t2 > 0 ? t2 : Infinity;
}

function rayAABB(ox, oy, oz, dx, dy, dz, minx, miny, minz, maxx, maxy, maxz) {
  let tmin = 0;
  let tmax = Infinity;
  const axes = [[ox, dx, minx, maxx], [oy, dy, miny, maxy], [oz, dz, minz, maxz]];
  for (const [o, d, mn, mx] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < mn || o > mx) return Infinity;
    } else {
      let t1 = (mn - o) / d;
      let t2 = (mx - o) / d;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return Infinity;
    }
  }
  return tmin;
}

// 射线到命中点之间是否有障碍物遮挡（防穿墙射击）
function losBlocked(ox, oy, oz, dx, dy, dz, hitT) {
  for (const o of COLLIDERS) {
    const hw = o.w / 2, hd = o.d / 2;
    const t = rayAABB(ox, oy, oz, dx, dy, dz, o.x - hw, 0, o.z - hd, o.x + hw, o.h, o.z + hd);
    if (t < hitT - 0.05) return true;
  }
  return false;
}

// ---------- 玩家管理 ----------
function pickSpawn() {
  for (let i = 0; i < 12; i++) {
    const s = SPAWNS[Math.floor(Math.random() * SPAWNS.length)];
    let ok = true;
    for (const p of players.values()) {
      if (!p.alive) continue;
      const dx = p.x - s.x, dz = p.z - s.z;
      if (dx * dx + dz * dz < 9) { ok = false; break; }
    }
    if (ok) return { x: s.x, z: s.z };
  }
  return { x: SPAWNS[0].x, z: SPAWNS[0].z };
}

function createPlayer(ws, name) {
  const spawn = pickSpawn();
  const color = PLAYER_COLORS[(nextId) % PLAYER_COLORS.length];
  const player = {
    id: 'p' + nextId++,
    ws,
    name: String(name).trim().slice(0, 12) || '玩家',
    x: spawn.x, y: 0, z: spawn.z,
    vy: 0, grounded: true,
    yaw: Math.atan2(spawn.x, spawn.z),
    pitch: 0,
    hp: WORLD.maxHp,
    alive: true,
    respawnAt: 0,
    lastFire: 0,
    lastInputAt: 0,
    input: { mx: 0, mz: 0, jump: false },
    weapon: 'pistol',
    team: 'blue',
    kills: 0, deaths: 0, streak: 0,
    shield: 0, speedUntil: 0, aiming: false,
    color,
  };
  players.set(player.id, player);
  return player;
}

function respawn(p) {
  const s = pickSpawn();
  p.x = s.x; p.y = 0; p.z = s.z;
  p.vy = 0; p.grounded = true;
  p.hp = WORLD.maxHp; p.alive = true;
  p.weapon = 'pistol';
  p.shield = 0; p.speedUntil = 0; p.aiming = false; p.streak = 0;
  p.yaw = Math.atan2(s.x, s.z); p.pitch = 0;
  p.input = { mx: 0, mz: 0, jump: false };
}

function snapshot(p) {
  return {
    id: p.id, name: p.name, color: p.color,
    x: round(p.x), y: round(p.y), z: round(p.z),
    yaw: p.yaw, pitch: p.pitch,
    hp: p.hp, alive: p.alive,
    weapon: p.weapon,
    team: p.team,
    kills: p.kills, deaths: p.deaths,
    shield: p.shield,
    speed: p.speedUntil > Date.now(),
    aiming: p.aiming,
    bot: p.bot ? true : undefined,
  };
}
function round(v) { return Math.round(v * 1000) / 1000; }

// ---------- 逻辑更新 ----------
function updatePlayer(p, dt) {
  // 客户端失联/空闲时停止移动，防止沿用最后一次输入（bot 由 AI 决策维护，不适用）
  if (!p.bot && Date.now() - p.lastInputAt > 250) {
    p.input = { mx: 0, mz: 0, jump: false };
  }
  if (!p.alive) {
    if (Date.now() >= p.respawnAt) respawn(p);
    return;
  }
  const { mx, mz, jump } = p.input;
  const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
  let fx = -sin * mz + cos * mx;
  let fz = -cos * mz - sin * mx;
  const fl = Math.hypot(fx, fz);
  if (fl > 1) { fx /= fl; fz /= fl; }

  const boosting = p.speedUntil > Date.now();
  const spd = WORLD.moveSpeed
    * (p.aiming ? WORLD.aimSpeedMult : 1)
    * (boosting ? WORLD.speedBoostMult : 1);
  p.x += fx * spd * dt;
  p.z += fz * spd * dt;

  if (p.grounded && jump) { p.vy = WORLD.jumpSpeed; p.grounded = false; }

  // 3D 平台物理（共享）：水平推挤 + 重力 + 落地/撞头 + 地面
  stepPlayerPhysics(p, dt);

  // 玩家间轻微分离（仅相近高度时），避免重叠
  for (const q of players.values()) {
    if (q === p || !q.alive) continue;
    if (Math.abs(p.y - q.y) > 1.5) continue;
    const dx = p.x - q.x, dz = p.z - q.z;
    const d2 = dx * dx + dz * dz;
    const minD = WORLD.playerRadius * 2;
    if (d2 < minD * minD && d2 > 1e-8) {
      const d = Math.sqrt(d2);
      const push = (minD - d) * 0.5;
      p.x += (dx / d) * push;
      p.z += (dz / d) * push;
    }
  }
}

function handleShoot(p, msg) {
  const now = Date.now();
  if (!p.alive) return;
  const wpn = WEAPONS[p.weapon] || WEAPONS.pistol;
  if (now - p.lastFire < wpn.fireInterval * 1000) return;
  p.lastFire = now;

  let yaw = normalizeYaw(clampNum(msg.yaw, -64, 64));
  let pitch = clampNum(msg.pitch, -1.5, 1.5);
  // AK47 散布：射程越远越偏
  const spread = wpn.spread * (p.aiming ? WORLD.aimSpreadMult : 1);
  if (spread > 0) {
    yaw += (Math.random() - 0.5) * 2 * spread;
    pitch += (Math.random() - 0.5) * 2 * spread * 0.7;
  }
  p.yaw = yaw; p.pitch = pitch;

  const ox = p.x, oy = p.y + WORLD.eyeHeight, oz = p.z;
  const dir = dirFromYawPitch(yaw, pitch);

  // 广播开火：让所有玩家都能看到曳光弹
  broadcast({ t: 'shot', shooterId: p.id, x: round(ox), y: round(oy), z: round(oz), dx: dir.x, dy: dir.y, dz: dir.z });

  let best = null;
  let bestT = Infinity;
  let bestPart = 'body';
  for (const q of players.values()) {
    if (q === p || !q.alive) continue;
    // 同队 bot 互不打（当前全部为敌军，互不伤害，只打真人）
    if (p.bot && q.bot && p.team === q.team) continue;
    // 部位判定：头部球 vs 身体球，取最近命中
    const tHead = raySphere(ox, oy, oz, dir.x, dir.y, dir.z, q.x, q.y + WORLD.headY, q.z, WORLD.headR);
    const tBody = raySphere(ox, oy, oz, dir.x, dir.y, dir.z, q.x, q.y + WORLD.bodyY, q.z, WORLD.bodyR);
    let t = tBody;
    let part = 'body';
    if (tHead < tBody) { t = tHead; part = 'head'; }
    if (t < bestT && t <= WORLD.shootRange) {
      bestT = t;
      best = q;
      bestPart = part;
    }
  }

  if (process.env.DEBUG_SHOOT) {
    console.log('[shoot]', p.name, 'from', ox.toFixed(1), oy.toFixed(1), oz.toFixed(1),
      'yaw', yaw.toFixed(2), 'pitch', pitch.toFixed(2), 'best', best ? best.name : 'none',
      'part', bestPart, 't', Number.isFinite(bestT) ? bestT.toFixed(1) : 'inf',
      'blocked', best ? losBlocked(ox, oy, oz, dir.x, dir.y, dir.z, bestT) : '-');
  }
  if (best && !losBlocked(ox, oy, oz, dir.x, dir.y, dir.z, bestT)) {
    const base = bestPart === 'head' ? Math.round(WORLD.damage * WORLD.headshotMult) : WORLD.damage;
    let dmg = p.bot ? Math.max(1, Math.round(base * BOTS.damageMult)) : base;
    // 护盾先吸收伤害
    if (best.shield > 0) {
      const absorbed = Math.min(best.shield, dmg);
      best.shield -= absorbed;
      dmg -= absorbed;
    }
    if (dmg > 0) best.hp -= dmg;
    const killed = best.hp <= 0;
    if (killed) best.hp = 0;
    const hx = ox + dir.x * bestT, hy = oy + dir.y * bestT, hz = oz + dir.z * bestT;
    send(best.ws, { t: 'hit', shooterId: p.id, targetId: best.id, dmg, part: bestPart, killed, x: round(hx), y: round(hy), z: round(hz) });
    send(p.ws, { t: 'hit', shooterId: p.id, targetId: best.id, dmg, part: bestPart, killed, x: round(hx), y: round(hy), z: round(hz) });
    if (killed) {
      best.alive = false;
      best.respawnAt = Date.now() + WORLD.respawnTime * 1000;
      best.deaths++;
      best.streak = 0;
      p.kills++;
      p.streak++;
      broadcast({ t: 'death', id: best.id, killerId: p.id, killerName: p.name });
      if (p.streak >= 2) {
        broadcast({ t: 'streak', playerId: p.id, name: p.name, streak: p.streak });
      }
    }
  }
}

// ---------- 消息收发 ----------
function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const p of players.values()) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(data);
  }
}
function broadcastExcept(ws, msg) {
  const data = JSON.stringify(msg);
  for (const p of players.values()) {
    if (p.ws && p.ws !== ws && p.ws.readyState === 1) p.ws.send(data);
  }
}

// ---------- 地面道具 ----------
function randomItemSpot() {
  for (let i = 0; i < 20; i++) {
    const x = (Math.random() * 2 - 1) * (WORLD.half - 4);
    const z = (Math.random() * 2 - 1) * (WORLD.half - 4);
    let ok = true;
    for (const o of TERRAIN_FOR_SPOT) {
      if (circleOverlapsBox(x, z, 1.2, o)) { ok = false; break; }
    }
    for (const p of players.values()) {
      if (Math.hypot(p.x - x, p.z - z) < 3) { ok = false; break; }
    }
    for (const it of items.values()) {
      if (Math.hypot(it.x - x, it.z - z) < 3) { ok = false; break; }
    }
    if (ok) return { x, z };
  }
  return null;
}
function spawnItem(forceType) {
  const spot = randomItemSpot();
  if (!spot) return null;
  const type = forceType || ITEM_TYPES[Math.floor(Math.random() * ITEM_TYPES.length)];
  const item = { id: 'it' + itemSeq++, type, x: spot.x, z: spot.z };
  items.set(item.id, item);
  return item;
}
function applyItem(p, it) {
  if (it.type === 'medkit') p.hp = WORLD.maxHp;
  else if (it.type === 'ak47') p.weapon = 'ak47';
  else if (it.type === 'shield') p.shield = WORLD.shieldMax;
  else if (it.type === 'speed') p.speedUntil = Date.now() + WORLD.speedBoostMs;
  send(p.ws, { t: 'pickup', type: it.type });
}

// ---------- AI 对手 ----------
let botSeq = 1;
function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }
function wrapAngle(a) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }
function countBots() {
  let n = 0;
  for (const p of players.values()) if (p.bot) n++;
  return n;
}
function randomWaypoint() {
  const h = WORLD.half - 4;
  return { x: (Math.random() * 2 - 1) * h, z: (Math.random() * 2 - 1) * h };
}
function createBot(teamArg) {
  const spawn = pickSpawn();
  const team = teamArg || 'enemy';
  const bot = {
    id: 'bot' + botSeq,
    ws: null,
    bot: true,
    name: 'AI-' + String(botSeq).padStart(2, '0'),
    x: spawn.x, y: 0, z: spawn.z,
    vy: 0, grounded: true,
    yaw: Math.atan2(spawn.x, spawn.z), pitch: 0,
    hp: WORLD.maxHp, alive: true,
    respawnAt: 0, lastFire: 0, lastInputAt: Date.now(),
    input: { mx: 0, mz: 0, jump: false },
    color: BOT_COLORS[team],
    team,
    weapon: 'pistol',
    kills: 0, deaths: 0, streak: 0,
    shield: 0, speedUntil: 0, aiming: false,
    waypoint: null,
    rememberId: null, rememberX: 0, rememberZ: 0, rememberAt: 0,
    nextFireAt: 0,
    _lx: 0, _lz: 0,
  };
  botSeq++;
  players.set(bot.id, bot);
  broadcast({ t: 'player_joined', player: snapshot(bot) });
  console.log('[bot] ' + bot.name + ' 出现，当前 ' + countBots() + ' 个 AI');
  return bot;
}

// AI 决策（休闲陪练：偏差大、射速慢、偶尔游走/跳跃）
// 视野判断：20m 半径 + 160° 视锥（头朝方向）+ 视线遮挡
function canSee(bot, q) {
  if (!bot.alive || !q.alive) return false;
  const dx = q.x - bot.x, dz = q.z - bot.z;
  const d = Math.hypot(dx, dz);
  if (d > BOTS.visionRadius) return false;
  const angTo = Math.atan2(-dx, -dz);
  if (Math.abs(wrapAngle(angTo - bot.yaw)) > (BOTS.fovDeg / 2) * Math.PI / 180) return false;
  const eye = bot.y + WORLD.eyeHeight;
  const dy = (q.y + WORLD.bodyY) - eye;
  const dist3 = Math.hypot(dx, dy, dz);
  const dir = dirFromYawPitch(angTo, Math.asin(dy / dist3));
  if (losBlocked(bot.x, eye, bot.z, dir.x, dir.y, dir.z, dist3)) return false;
  return true;
}

// AI 决策（视野驱动：20m 半径 + 160° 视锥 + 视线；丢失视野 5 秒后随机游走）
function aiUpdate(bot, now) {
  if (!bot.alive) return;
  bot.lastInputAt = now;
  const eye = bot.y + WORLD.eyeHeight;
  // 视野内寻找目标（半径 + 视锥 + 视线）
  let visible = null, bestD = Infinity;
  for (const q of players.values()) {
    if (q === bot || q.bot || !q.alive || !q.ws || q.ws.readyState !== 1) continue;
    if (!canSee(bot, q)) continue;
    const d = Math.hypot(q.x - bot.x, q.z - bot.z);
    if (d < bestD) { bestD = d; visible = q; }
  }

  // 目标记忆：最近 5 秒内见过的目标继续追踪，超时放弃
  if (visible) {
    bot.rememberId = visible.id;
    bot.rememberX = visible.x;
    bot.rememberZ = visible.z;
    bot.rememberAt = now;
  }
  let target = null;
  if (visible) {
    target = visible;
  } else if (bot.rememberId && now - bot.rememberAt < BOTS.loseMemoryMs) {
    const q = players.get(bot.rememberId);
    if (q && q.alive && !q.bot) target = q;
  }
  if (!target) bot.rememberId = null;

  const moved = Math.hypot(bot.x - bot._lx, bot.z - bot._lz);
  bot._lx = bot.x; bot._lz = bot.z;
  const stuck = moved < 0.05;

  if (target) {
    // 朝目标（可见则当前位，不可见则记忆位）移动
    const tx = visible ? target.x : bot.rememberX;
    const tz = visible ? target.z : bot.rememberZ;
    const dx = tx - bot.x, dz = tz - bot.z;
    const d = Math.hypot(dx, dz);
    if (d > 4 && Math.random() < BOTS.moveChance) {
      bot.yaw = Math.atan2(-dx, -dz) + (Math.random() - 0.5) * 0.3;
      bot.input = { mx: 0, mz: 1, jump: stuck && Math.random() < 0.4 };
    } else {
      bot.input = { mx: 0, mz: 0, jump: stuck && Math.random() < 0.3 };
    }
    // 射击：仅当前可见
    if (visible && now >= bot.nextFireAt) {
      const dy = (target.y + WORLD.bodyY) - eye;
      const dist3 = Math.hypot(dx, dy, dz);
      const aimYaw = Math.atan2(-dx, -dz);
      const aimPitch = Math.asin(dy / dist3);
      bot.yaw = aimYaw;
      const jy = aimYaw + (Math.random() - 0.5) * BOTS.jitterYaw * 2;
      const jp = aimPitch + (Math.random() - 0.5) * BOTS.jitterPitch * 2;
      bot.nextFireAt = now + randInt(BOTS.fireMin, BOTS.fireMax);
      handleShoot(bot, { yaw: jy, pitch: jp });
    }
  } else {
    // 随机游走
    if (!bot.waypoint || Math.hypot(bot.waypoint.x - bot.x, bot.waypoint.z - bot.z) < 2.5 || stuck) {
      bot.waypoint = randomWaypoint();
    }
    bot.yaw = Math.atan2(-(bot.waypoint.x - bot.x), -(bot.waypoint.z - bot.z));
    bot.input = { mx: 0, mz: 1, jump: stuck && Math.random() < 0.35 };
  }
}

// ---------- HTTP / WS 服务器 ----------
const server = http.createServer(staticHandler);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  let player = null;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;

    switch (msg.t) {
      case 'join': {
        if (player) return; // 已加入
        const joined = [...players.values()].filter(p => p.ws && p.ws.readyState === 1).length;
        if (joined >= WORLD.maxPlayers) {
          send(ws, { t: 'error', msg: `服务器已满（最多 ${WORLD.maxPlayers} 人）` });
          ws.close();
          return;
        }
        player = createPlayer(ws, msg.name);
        send(ws, {
          t: 'welcome',
          id: player.id,
          color: player.color,
          spawn: { x: player.x, z: player.z },
          maxPlayers: WORLD.maxPlayers,
          players: [...players.values()].map(snapshot),
        });
        broadcastExcept(ws, { t: 'player_joined', player: snapshot(player) });
        console.log(`[+] ${player.name} (${player.id}) 加入，当前 ${players.size} 人`);
        break;
      }
      case 'input': {
        if (!player) return;
        player.input = {
          mx: clampNum(msg.mx, -1, 1),
          mz: clampNum(msg.mz, -1, 1),
          jump: !!msg.jump,
        };
        player.lastInputAt = Date.now();
        player.aiming = !!msg.aim;
        if (typeof msg.yaw === 'number') player.yaw = normalizeYaw(msg.yaw);
        if (typeof msg.pitch === 'number') player.pitch = clampNum(msg.pitch, -1.5, 1.5);
        break;
      }
      case 'shoot': {
        if (player) handleShoot(player, msg);
        break;
      }
      case 'ping': {
        send(ws, { t: 'pong', time: msg.time });
        break;
      }
      case 'debug_spawn_bot': {
        // 仅自动化测试使用（DEBUG=1）
        if (!process.env.DEBUG) break;
        createBot(msg.team);
        break;
      }
      case 'debug_spawn_item': {
        // 仅自动化测试使用（DEBUG=1）
        if (!process.env.DEBUG) break;
        if (typeof msg.x === 'number') {
          const item = { id: 'it' + itemSeq++, type: msg.type || 'medkit', x: clampNum(msg.x, -58, 58), z: clampNum(msg.z ?? 0, -58, 58) };
          items.set(item.id, item);
        } else {
          spawnItem(msg.type);
        }
        break;
      }
      case 'debug_pos': {
        // 仅自动化测试使用（需设置环境变量 DEBUG=1）
        if (!process.env.DEBUG) break;
        for (const p of players.values()) {
          if (p.name === String(msg.name)) {
            p.x = clampNum(msg.x, -29.5, 29.5);
            p.z = clampNum(msg.z, -29.5, 29.5);
            p.y = clampNum(msg.y ?? 0, 0, 10); p.vy = 0; p.grounded = true;
            if (typeof msg.yaw === 'number') p.yaw = msg.yaw;
            p.hp = WORLD.maxHp; p.alive = true;
          }
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (player) {
      players.delete(player.id);
      broadcast({ t: 'player_left', id: player.id });
      console.log(`[-] ${player.name} (${player.id}) 离开，当前 ${players.size} 人`);
    }
  });
});

// 心跳：清理失联连接
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);

// 游戏主循环：20Hz 状态广播
setInterval(() => {
  const dt = TICK_MS / 1000;
  for (const p of players.values()) updatePlayer(p, dt);

  // 地面道具拾取
  for (const [id, it] of items) {
    for (const p of players.values()) {
      if (!p.alive) continue;
      const dx = p.x - it.x, dz = p.z - it.z;
      if (dx * dx + dz * dz < ITEMS.pickupRadius * ITEMS.pickupRadius) {
        applyItem(p, it);
        items.delete(id);
        break;
      }
    }
  }

  broadcast({ t: 'state', ts: Date.now(), players: [...players.values()].map(snapshot), items: [...items.values()] });
}, TICK_MS);

// ---------- 静态文件托管（生产模式） ----------
function staticHandler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); res.end('Method Not Allowed'); return;
  }
  if (!fs.existsSync(DIST)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>霓虹战场 · 服务器运行中</h1><p>开发模式请执行 <b>npm run dev</b> 并访问 http://localhost:4173</p>');
    return;
  }
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(DIST, urlPath));
  if (!file.startsWith(DIST)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA 回退到 index.html
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

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

const maxBots = Math.max(0, Number(process.env.BOTS_MAX ?? BOTS.max));

if (isMain) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] ${PORT}（HTTP + WebSocket /ws）`);
  });
  if (maxBots > 0) {
    const scheduleNext = (delay) => setTimeout(() => {
      if (countBots() < maxBots) createBot();
      scheduleNext(randInt(BOTS.nextMin, BOTS.nextMax));
    }, delay);
    scheduleNext(randInt(BOTS.firstMin, BOTS.firstMax));
  }
  const maxItems = Math.max(0, Number(process.env.ITEMS_MAX ?? ITEMS.max));
  if (maxItems > 0) {
    spawnItem();
    spawnItem();
    const scheduleItem = (delay) => setTimeout(() => {
      if (items.size < maxItems) spawnItem();
      scheduleItem(randInt(ITEMS.spawnMin, ITEMS.spawnMax));
    }, delay);
    scheduleItem(randInt(ITEMS.spawnMin, ITEMS.spawnMax));
  }
  // AI 决策循环始终运行（手动生成/调试生成的 bot 也会动）
  setInterval(() => {
    const now = Date.now();
    for (const p of players.values()) if (p.bot) aiUpdate(p, now);
  }, BOTS.tick);
}

export { createPlayer, createBot, handleShoot, respawn, snapshot, updatePlayer, aiUpdate, canSee, countBots, spawnItem, applyItem, items, raySphere, losBlocked, players };
