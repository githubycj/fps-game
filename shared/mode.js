// ===== 对局模式配置：死亡竞赛 Deathmatch（DM）+ 多 AI 小队 =====
// 本文件由 Lead 维护，是"玩法"的唯一契约。
// 旧玩法（拆弹 Search & Destroy / 据点争夺 Domination）已废弃：
//   · 不再有炸弹、包点、回合、购买、经济、拆包/安包
//   · 不再有据点占领与每秒得分
// 新玩法：
//   · 限时死亡竞赛：时间结束时小队击杀数（人头）最多者获胜
//   · 支持 2~4 支小队，每支小队可包含任意数量 AI（多 AI 小队）
//   · 同小队互不伤害，跨小队互相敌对（小队团队死斗 Team Deathmatch）

export const MODE = 'dm';

export const DM = {
  // ---- 时长与胜负 ----
  timeLimit: 480,          // 一局时长（秒）。到点按击杀数排名定胜负
  killTarget: 0,           // >0 时先到该击杀数立即结束（0 = 只看时间）
  countdown: 3,            // 真人按空格后开场倒计时（秒）
  resetDelay: 8,           // 结算面板停留后自动开下一局（秒）

  // ---- 小队 ----
  squadCount: 4,           // 默认 4 支小队（2/3/4 都支持，由服务器决定）
  maxPlayers: 20,          // 单局真人 + AI 总上限（默认 12 个 AI → 还能进 8 个真人）
  botsPerSquad: 3,         // 每支小队默认 AI 数量（"多 AI 小队"）
  autoBalance: true,       // 真人加入时分配到人数最少的小队

  // ---- 复活 ----
  respawnTime: 3,          // 死亡后复活秒数
  spawnProtect: 1.5,       // 出生保护（秒，期间无敌）
  spawnSpread: 12,         // 出生点随机散布半径（米）

  // ---- 计分（纯人头）----
  killScore: 1,            // 每次击杀给本小队 +1
  suicideScore: 0,         // 自杀不扣分（只增加自己死亡数）
  assistScore: 0,          // 暂无助攻分
  headshotScore: 1,        // 爆头仍然只算 1 个人头

  // ---- 连杀奖励（沿用 UAV）----
  uavKillstreak: 5,
  uavDuration: 10,

  // ---- 赛后 ----
  killfeedMax: 8,
  scoreboardTop: 5,
};

// 小队定义。颜色用于 HUD / 小地图 / 角色臂章。
// spawn 字段对应 shared/<map>.js 里 SPAWNS[squadId] 的键名。
export const SQUADS = [
  { id: 'alpha',   name: '蓝队', tag: 'ALPHA',   color: 0x4a86c8, ui: '#4a86c8', css: 'squad-alpha' },
  { id: 'bravo',   name: '红队', tag: 'BRAVO',   color: 0xc8553f, ui: '#c8553f', css: 'squad-bravo' },
  { id: 'charlie', name: '绿队', tag: 'CHARLIE', color: 0x4fa869, ui: '#4fa869', css: 'squad-charlie' },
  { id: 'delta',   name: '黄队', tag: 'DELTA',   color: 0xc9a63f, ui: '#c9a63f', css: 'squad-delta' },
];

export const SQUAD_IDS = SQUADS.map((s) => s.id);

export function squadOf(id) {
  return SQUADS.find((s) => s.id === id) || null;
}

export function squadColor(id) {
  const s = squadOf(id);
  return s ? s.color : 0x888888;
}

export function squadUi(id) {
  const s = squadOf(id);
  return s ? s.ui : '#888888';
}

export function isFriendly(a, b) {
  return !!a && a === b;
}

// 当前生效的小队列表（服务器可通过 SQUADS 环境变量裁剪数量）
export function activeSquads(count = DM.squadCount) {
  const n = Math.max(2, Math.min(SQUADS.length, count | 0 || DM.squadCount));
  return SQUADS.slice(0, n);
}

// ===== AI 配置（跨地图共用；旧 shared/world.js 里的 AI_CONFIG 仍保留以兼容）=====
export const AI_CONFIG = {
  max: 12,                 // 全场 AI 上限（4 队 × 3）
  perSquad: 3,
  tickMs: 200,
  visionRadius: 60,
  fovDeg: 115,
  hearingShot: 50,
  hearingStep: 12,
  loseMemoryMs: 6000,
  reactionMin: 320,
  reactionMax: 700,
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
  roamRadius: 90,          // 无目标时的游走半径
  huntBias: 0.65,          // 主动找人的概率（其余时间守点/游走）
};
