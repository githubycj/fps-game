// ===== 地图注册表（运行时选择当前地图）=====
// 服务器：环境变量 MAP=suburban|tidewater（默认 tidewater）
// 浏览器：globalThis.__MAP_ID__ → URL ?map= → 默认 tidewater
// 服务器在 welcome 消息里回传自己的地图 id，客户端发现不一致会自动带 ?map= 刷新，
// 保证"地形高度 / 碰撞体 / 射线"两侧逐位一致。
//
// 所有客户端/服务器模块都应从本文件（或 src/world/shared.js）取地图数据，
// 不要再直接 import './world.js'（那是郊区地图的固定实现）。

import * as SUBURBAN from './world.js';
import * as TIDEWATER from './tidewater.js';
import * as MODECFG from './mode.js';

export const MAPS = [
  {
    id: 'suburban',
    name: '郊区战场',
    en: 'SUBURBAN FRONT',
    subtitle: '初秋 16:00 · 西村 — 中央广场 — 东站',
    desc: '起伏草地与白色墙板房的北美郊区，输电塔与泥泞十字路口。',
  },
  {
    id: 'tidewater',
    name: '潮汐湾',
    en: 'TIDEWATER',
    subtitle: '午后 · 沙滩 — 渔村 — 长栈桥',
    desc: '热带海岛的渔村海岸：白沙滩、珊瑚礁浅滩、木质长栈桥与吊脚渔屋。',
  },
];

function resolveMapId() {
  // 1) 显式注入（index.html 引导脚本 / 测试脚本）
  try {
    const g = typeof globalThis !== 'undefined' ? globalThis.__MAP_ID__ : null;
    if (g) return normalize(g);
  } catch (e) { /* ignore */ }
  // 2) URL 查询参数（浏览器）
  try {
    if (typeof location !== 'undefined' && location.search) {
      const q = new URLSearchParams(location.search).get('map');
      if (q) return normalize(q);
    }
  } catch (e) { /* ignore */ }
  // 3) 环境变量（Node 服务器）
  try {
    if (typeof process !== 'undefined' && process.env && process.env.MAP) return normalize(process.env.MAP);
  } catch (e) { /* ignore */ }
  return 'tidewater';
}

function normalize(v) {
  const s = String(v || '').toLowerCase();
  if (s === 'suburban' || s === 'suburb' || s === 'old') return 'suburban';
  if (s === 'tidewater' || s === 'tide' || s === 'island') return 'tidewater';
  return 'tidewater';
}

export const MAP_ID = resolveMapId();
export const MAP_META = MAPS.find((m) => m.id === MAP_ID) || MAPS[0];

const M = MAP_ID === 'suburban' ? SUBURBAN : TIDEWATER;

// ---------- 地图数据 ----------
export const WORLD = M.WORLD;
export const SUN = M.SUN;
export const ZONES = M.ZONES || [];
export const HOUSES = M.HOUSES || [];
export const PYLONS = M.PYLONS || [];
export const CARS = M.CARS || [];
export const DEFENSES = M.DEFENSES || [];
// 潮汐湾把掩体道具放在 PROPS（与 DEFENSES 同一引用）；郊区没有 PROPS，回退到 DEFENSES
export const PROPS = M.PROPS || M.DEFENSES || [];
export const FENCES = M.FENCES || [];
export const ROADS = M.ROADS || { mainWidth: 8, crossWidth: 7, plazaRadius: 13 };
export const TREES = M.TREES || [];
export const ROCKS = M.ROCKS || [];
export const BOUNDARY = M.BOUNDARY || [];
export const COLLIDERS = M.COLLIDERS || [];
export const SPAWNS = M.SPAWNS || { alpha: [], bravo: [], all: [] };
export const CRATE_SPOTS = M.CRATE_SPOTS || [];
export const ITEM_SPOTS = M.ITEM_SPOTS || [];
export const FURNITURE = M.FURNITURE || [];
export const FURNITURE_DEF = M.FURNITURE_DEF || {};
export const WINDOW_SPEC = M.WINDOW_SPEC || { sill: 1.0, h: 1.2, wMin: 1.16, wMax: 1.36 };
export const WORLD_INFO = M.WORLD_INFO || {};
export const MAP_EXTRAS = M.MAP_EXTRAS || {};

// ---------- 地图函数 ----------
export const heightAt = M.heightAt;
export const terrainNormal = M.terrainNormal;
export const surfaceAt = M.surfaceAt;
export const houseSides = M.houseSides;
export const houseFloorTop = M.houseFloorTop;
export const houseWallSegments = M.houseWallSegments;
export const seedOf = M.seedOf;
export const circleOverlapsBox = M.circleOverlapsBox;
export const movePlayerHorizontal = M.movePlayerHorizontal;
export const groundHeightAt = M.groundHeightAt;
export const stepPlayerPhysics = M.stepPlayerPhysics;
export const applyJump = M.applyJump;
export const hitboxesFor = M.hitboxesFor;
export const raycastWorld = M.raycastWorld;
export const losBlocked = M.losBlocked;
export const zoneOf = M.zoneOf;
export const pickSpawn = M.pickSpawn;
export const spawnYaw = M.spawnYaw;
export const isWalkableAt = M.isWalkableAt;
export const hash2i = M.hash2i;
export const valueNoise = M.valueNoise;
export const mulberry32 = M.mulberry32;

// ---------- 玩法（与地图无关）----------
export const MODE = MODECFG.MODE;
export const DM = MODECFG.DM;
export const SQUADS = MODECFG.SQUADS;
export const SQUAD_IDS = MODECFG.SQUAD_IDS;
export const squadOf = MODECFG.squadOf;
export const squadColor = MODECFG.squadColor;
export const squadUi = MODECFG.squadUi;
export const isFriendly = MODECFG.isFriendly;
export const activeSquads = MODECFG.activeSquads;
export const AI_CONFIG = MODECFG.AI_CONFIG;
export const BOTS = MODECFG.AI_CONFIG;

// 旧名兼容（部分旧代码/脚本仍在引用）
export const TEAMS = MODE.SQUAD_IDS;
export const PLAYER_COLORS = [0x6f9fc4, 0x7fae8f, 0x8f9fc4, 0xb08f6f, 0x6faeae, 0xc9a06a, 0xa06f7f, 0x8fb26f];
export const BOT_COLORS = { ally: 0x6f9fc4, enemy: 0xc06a4e };
export const UAV_KILLSTREAK = MODECFG.DM.uavKillstreak;
export const UAV_DURATION = MODECFG.DM.uavDuration;
