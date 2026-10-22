// ===== 潮汐湾 · HUD 模块（死亡竞赛 / 4 队排名 / 小地图 / 命中反馈） =====
// 契约：DESIGN_TIDEWATER_DM.md §5.2。
// 所有方法只操作已存在的 DOM，不依赖 main.js；对缺失元素全部容错（自动化测试可能提前调用）。
// 玩法已改为「限时死亡竞赛」：
//   · 顶部 #scoreBar = 倒计时 + #squadBoard（4 队击杀排名条，自己队伍高亮）
//   · 击杀信息按小队配色；小地图队友按小队色、敌人仅在 UAV 期间显示
//   · 结算面板 #matchEnd 显示 4 队排名表与自己的名次
// 地图/玩法常量一律取自 shared/active.js，不在客户端复制一份。
import {
  WORLD, MAP_ID, MAP_META, MAP_EXTRAS, SQUADS, DM,
  heightAt, surfaceAt, ROADS, HOUSES,
} from '../shared/active.js';

// ---------- 安全的世界数据（shared 字段缺失时兜底） ----------
const WORLD_SAFE = (WORLD && Number.isFinite(WORLD.size) && Number.isFinite(WORLD.half))
  ? WORLD
  : { size: 320, half: 160, maxPlayers: 16, playerRadius: 0.42, staminaMax: 100, maxHp: 100 };
const ROADS_SAFE = (ROADS && Number.isFinite(ROADS.plazaRadius))
  ? ROADS
  : { mainWidth: 8, crossWidth: 7, plazaRadius: 0 };
const HOUSES_SAFE = Array.isArray(HOUSES) ? HOUSES : [];
const EXTRAS_SAFE = (MAP_EXTRAS && typeof MAP_EXTRAS === 'object') ? MAP_EXTRAS : {};
const MAP_SAFE = (MAP_META && typeof MAP_META === 'object')
  ? MAP_META
  : { id: 'tidewater', name: '潮汐湾', en: 'TIDEWATER', subtitle: '', desc: '' };
const DM_SAFE = (DM && typeof DM === 'object')
  ? DM
  : { timeLimit: 480, killTarget: 0, countdown: 3, squadCount: 4, killfeedMax: 8, respawnTime: 3 };
const SQUADS_SAFE = (Array.isArray(SQUADS) && SQUADS.length)
  ? SQUADS
  : [
    { id: 'alpha', name: '蓝队', tag: 'ALPHA', color: 0x4a86c8, ui: '#4a86c8', css: 'squad-alpha' },
    { id: 'bravo', name: '红队', tag: 'BRAVO', color: 0xc8553f, ui: '#c8553f', css: 'squad-bravo' },
    { id: 'charlie', name: '绿队', tag: 'CHARLIE', color: 0x4fa869, ui: '#4fa869', css: 'squad-charlie' },
    { id: 'delta', name: '黄队', tag: 'DELTA', color: 0xc9a63f, ui: '#c9a63f', css: 'squad-delta' },
  ];

// ---------- 小工具 ----------
const domCache = new Map();
function node(id) {
  if (typeof document === 'undefined') return null;
  const hit = domCache.get(id);
  if (hit && hit.isConnected) return hit;
  const found = document.getElementById(id);
  if (found) domCache.set(id, found);
  return found;
}
const clamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));
const clamp01 = (v) => clamp(Number(v) || 0, 0, 1);
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const pad2 = (n) => String(Math.floor(n)).padStart(2, '0');
const pad3 = (n) => String(Math.floor(n) % 1000).padStart(3, '0');
const fmtTime = (sec) => {
  const s = Math.max(0, Math.ceil(num(sec, 0)));
  return Math.floor(s / 60) + ':' + pad2(s % 60);
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (m) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const setText = (n, t) => { if (n && n.textContent !== String(t)) n.textContent = String(t); };
const setStyle = (n, prop, val) => { if (n) n.style[prop] = val; };
const nextFrame = (fn) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn);
  else setTimeout(fn, 16);
};

// 武器显示名（服务器 kind → 中文）
const WEAPON_NAMES = {
  pistol: '手枪', smg: '冲锋枪', ak47: '突击步枪', shotgun: '霰弹枪', sniper: '狙击步枪',
  m416: 'M416', deagle: '沙漠之鹰',
  knife: '匕首', medkit: '急救包', shield: '护盾', speed: '加速',
};
const WEAPON_ORDER_DEFAULT = ['pistol', 'smg', 'ak47', 'shotgun', 'sniper', 'm416', 'deagle'];
const WEAPON_MAG_HINT = { pistol: 12, smg: 30, ak47: 30, shotgun: 8, sniper: 5, m416: 30, deagle: 7 };
const weaponNameOf = (kind, fallback) => WEAPON_NAMES[kind] || fallback || kind || '';

function isScopeSight(sightType) {
  const s = String(sightType || '').toLowerCase();
  return s === 'scope' || s === 'sniper';
}

// ---------- 小队（4 队） ----------
// 兼容旧字段 team / ally / enemy / A~D 等写法，统一归一化到 alpha|bravo|charlie|delta
const SQUAD_ALIASES = {
  alpha: 'alpha', a: 'alpha', ally: 'alpha', blue: 'alpha', '蓝队': 'alpha', '我方': 'alpha',
  bravo: 'bravo', b: 'bravo', enemy: 'bravo', red: 'bravo', '红队': 'bravo', '敌方': 'bravo',
  charlie: 'charlie', c: 'charlie', green: 'charlie', '绿队': 'charlie',
  delta: 'delta', d: 'delta', yellow: 'delta', '黄队': 'delta',
};
function normalizeSquad(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return SQUAD_ALIASES[s] || null;
}
function squadMetaOf(id) {
  const key = normalizeSquad(id);
  const hit = SQUADS_SAFE.find((s) => s.id === key);
  if (hit) return hit;
  const fallback = key || 'alpha';
  return {
    id: fallback, name: fallback, tag: fallback.toUpperCase(),
    color: 0x8aa6b8, ui: '#8aa6b8', css: 'squad-' + fallback,
  };
}
function squadCss(id) {
  return 'squad-' + (normalizeSquad(id) || 'alpha');
}

function normalizeStance(stance) {
  const s = String(stance || '').toLowerCase();
  if (s === 'crouch' || s === 'crouching' || s === '蹲' || s === '蹲下') return 'crouch';
  if (s === 'slide' || s === 'sliding' || s === '滑铲') return 'slide';
  if (s === 'sprint' || s === 'sprinting' || s === '冲刺') return 'sprint';
  return 'stand';
}
const STANCE_TEXT = { stand: '站立', crouch: '蹲下', slide: '滑铲', sprint: '冲刺' };

// ---------- 设置（window.__settings 供 main.js 读取） ----------
const DEFAULT_SETTINGS = { quality: 'auto', sens: 1 };
const QUALITY_VALUES = ['auto', 'high', 'medium', 'low'];
function loadSettings() {
  const out = { ...DEFAULT_SETTINGS };
  try {
    const q = localStorage.getItem('sf_quality');
    if (q && QUALITY_VALUES.includes(q)) out.quality = q;
    const s = parseFloat(localStorage.getItem('sf_sens'));
    if (Number.isFinite(s)) out.sens = clamp(s, 0.2, 3);
  } catch { /* 隐私模式 / 无 localStorage */ }
  return out;
}
const settings = loadSettings();
if (typeof window !== 'undefined') window.__settings = settings;

function persistSettings() {
  if (typeof window !== 'undefined') window.__settings = settings;
  try {
    localStorage.setItem('sf_quality', settings.quality);
    localStorage.setItem('sf_sens', String(settings.sens));
  } catch { /* 忽略 */ }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try { window.dispatchEvent(new CustomEvent('sf:settings', { detail: { ...settings } })); } catch { /* 忽略 */ }
  }
}
function updateSensLabel() {
  setText(node('sensValue'), settings.sens.toFixed(2));
}

// ---------- HUD 状态（同时作为 window.__hud 暴露给自动化测试） ----------
const state = {
  hp: 100, hpMax: 100,
  lowHpVeins: false,
  shield: 0, shieldMax: 100,
  stamina: 100, staminaMax: 100,
  stance: 'stand',
  weapon: 'pistol', weaponName: '手枪', mag: 0, reserve: 0,
  reloading: false, reloadProgress: null,
  ads: false, sightType: 'iron', scopeActive: false, zoomLabel: '6×',
  crosshairHidden: false, crosshairSize: 22,
  hitmarkerPart: null, hitmarkerKilled: false,
  lastDamageAngle: null,
  // 死亡竞赛
  mode: 'dm', matchPhase: 'waiting', timeLimit: num(DM_SAFE.timeLimit, 480),
  timer: num(DM_SAFE.timeLimit, 480), killTarget: num(DM_SAFE.killTarget, 0),
  scores: {}, standings: [], selfSquad: null, selfRank: 0, winnerSquad: null,
  uav: { active: false, sec: 0 },
  kills: 0, deaths: 0, ping: 0, streak: 0,
  players: [], selfId: null,
  menuVisible: true, hudVisible: false,
  paused: false, dead: false, matchEnd: false, winner: null,
  warmupVisible: false, countdown: 0,
  god: false, godLeft: 0,
  // 旧字段兼容：旧模式（占点）已删除，恒为空数组（个别旧脚本仍会读取）
  zones: [],
  heading: 0,
  minimap: { x: 0, z: 0, yaw: 0, allies: [], enemies: [], uav: false },
};
if (typeof window !== 'undefined') window.__hud = state;

// 定时器（避免重复叠加）
let markTimer = null;
let headMarkTimer = null;
let flashTimer = null;
let bloodTimer = null;
let staminaFillEl = null;

// ============================================================
// 初始化
// ============================================================
let initialized = false;
let resizeBound = false;

export function initHud() {
  if (typeof document === 'undefined') return hud;
  const root = node('hud');
  if (initialized && root) return hud;
  if (root) initialized = true;

  initMenuSettings();
  initMapInfo();
  initCompass();
  initSquadBoard();
  initMinimap();
  bindResize();
  syncSettingsUi();

  // 旧模式（占点）已删除：#zoneBar 长期隐藏（DOM 保留，避免旧脚本取不到节点）
  const zoneBar = node('zoneBar');
  if (zoneBar) zoneBar.classList.add('hidden');

  if (root) state.hudVisible = !root.classList.contains('hidden');
  if (typeof window !== 'undefined' && !window.__hud) window.__hud = state;

  // 初始布局：等一帧后测量真实尺寸
  nextFrame(() => {
    resizeMinimap(true);
    updateCompass();
    drawMinimap();
  });
  return hud;
}

function initMenuSettings() {
  const sel = node('qualitySelect');
  if (sel && !sel.dataset.bound) {
    sel.dataset.bound = '1';
    sel.addEventListener('change', () => {
      if (QUALITY_VALUES.includes(sel.value)) {
        settings.quality = sel.value;
        persistSettings();
      }
    });
  }
  const rng = node('sensRange');
  if (rng && !rng.dataset.bound) {
    rng.dataset.bound = '1';
    rng.addEventListener('input', () => {
      const v = parseFloat(rng.value);
      if (Number.isFinite(v)) {
        settings.sens = clamp(v, 0.2, 3);
        updateSensLabel();
        persistSettings();
      }
    });
  }
}
function syncSettingsUi() {
  const sel = node('qualitySelect');
  if (sel && QUALITY_VALUES.includes(settings.quality)) sel.value = settings.quality;
  const rng = node('sensRange');
  if (rng) rng.value = String(settings.sens);
  updateSensLabel();
}

// ---------- 菜单：地图信息（数据驱动，跟着 MAP_META 自动变） ----------
function initMapInfo() {
  // 地图描述在 index.html 里没有独立节点：首次调用时动态补一个 #menuDesc
  if (typeof document !== 'undefined' && !node('menuDesc')) {
    const headEl = document.querySelector('#menu .menu-head');
    if (headEl) {
      const p = document.createElement('p');
      p.id = 'menuDesc';
      p.className = 'menu-desc';
      headEl.appendChild(p);
    }
  }
  hud.setMapInfo(MAP_SAFE, SQUADS_SAFE.length);
}

// ---------- 罗盘条 ----------
const COMPASS_SCALE = 6; // 每度 6px
function initCompass() {
  const strip = node('compassStrip');
  if (strip && strip.childElementCount === 0) {
    const frag = document.createDocumentFragment();
    // -180° ~ 540° 两圈半，保证任意朝向都能铺满可视窗口
    for (let d = -180; d <= 540; d += 5) {
      const norm = ((d % 360) + 360) % 360;
      const s = document.createElement('span');
      s.className = 'compass-tick';
      if (norm === 0) {
        s.classList.add('cardinal');
        s.textContent = 'N';
      } else if (norm === 90) {
        s.classList.add('cardinal');
        s.textContent = 'E';
      } else if (norm === 180) {
        s.classList.add('cardinal');
        s.textContent = 'S';
      } else if (norm === 270) {
        s.classList.add('cardinal');
        s.textContent = 'W';
      } else if (d % 30 === 0) {
        s.classList.add('major', 'num');
        s.textContent = pad3(norm);
      } else if (d % 15 === 0) {
        s.classList.add('major');
      } else {
        s.classList.add('minor');
      }
      s.style.left = (d * COMPASS_SCALE) + 'px';
      frag.appendChild(s);
    }
    strip.appendChild(frag);
  }
  // #compassMarks 曾是占点标记容器；旧模式删除后留空即可
}

function updateCompass() {
  const strip = node('compassStrip');
  const compass = node('compass');
  const yaw = num(state.minimap.yaw, 0);

  // 世界 -Z 为北；Three.js yaw=0 面朝 -Z，因此罗盘方位角 = -yaw
  let heading = (-yaw * 180 / Math.PI) % 360;
  if (heading < 0) heading += 360;
  state.heading = heading;

  const width = (compass && compass.clientWidth) ? compass.clientWidth : 420;
  if (strip) strip.style.transform = 'translateX(' + (width / 2 - heading * COMPASS_SCALE).toFixed(1) + 'px)';
  setText(node('compassHeading'), pad3(Math.round(heading)));
}

// ============================================================
// 小队排名条（#squadBoard）
// ============================================================
function initSquadBoard() {
  const board = node('squadBoard');
  if (!board) return;
  // 先渲染一次占位（4 队 0 击杀），避免进入战场瞬间顶部是空的
  if (!state.standings.length) {
    hud.setScores(SQUADS_SAFE.map((s) => ({ squad: s.id, kills: 0 })));
  }
}

/**
 * 归一化排名数据：既接受 [{squad,kills,rank}]，也接受 {alpha: 3, bravo: 5} 映射。
 * 返回按名次升序排列的数组，附带队名/配色/是否是自己队伍。
 */
function normalizeStandings(input, selfSquad) {
  const self = normalizeSquad(selfSquad != null ? selfSquad : state.selfSquad);
  const order = SQUADS_SAFE.map((s) => s.id);
  let rows = [];
  if (Array.isArray(input)) {
    rows = input.map((it) => {
      if (!it || typeof it !== 'object') return null;
      const squad = normalizeSquad(it.squad != null ? it.squad : (it.team != null ? it.team : it.id));
      if (!squad) return null;
      return {
        squad,
        kills: num(it.kills != null ? it.kills : (it.score != null ? it.score : it.points), 0),
        rank: Math.max(0, Math.round(num(it.rank, 0))),
      };
    }).filter(Boolean);
  } else if (input && typeof input === 'object') {
    rows = order
      .filter((id) => input[id] != null)
      .map((id) => ({ squad: id, kills: num(input[id], 0), rank: 0 }));
    // 服务器只发了旧比分时也补齐 4 行，保证排名条结构稳定
    if (!rows.length) rows = order.map((id) => ({ squad: id, kills: 0, rank: 0 }));
  }
  if (!rows.length) return [];

  // 未带 rank 时按击杀降序（并列按小队定义顺序，保证确定性）
  rows.sort((x, y) => (y.kills - x.kills) || (order.indexOf(x.squad) - order.indexOf(y.squad)));
  rows.forEach((r, i) => {
    if (!r.rank) r.rank = i + 1;
    const meta = squadMetaOf(r.squad);
    r.name = meta.name;
    r.ui = meta.ui;
    r.color = meta.color;
    r.css = squadCss(r.squad);
    r.isSelf = !!self && r.squad === self;
  });
  rows.sort((x, y) => (x.rank - y.rank) || (y.kills - x.kills));
  return rows;
}

function renderSquadBoard() {
  const board = node('squadBoard');
  if (!board) return;
  const rows = state.standings;
  const sig = rows.map((r) => r.squad + ':' + Math.round(r.kills) + ':' + r.rank + ':' + (r.isSelf ? 1 : 0)).join('|');
  if (board.dataset.sig === sig) return; // 每帧都可能调用，签名不变就不重排 DOM
  board.dataset.sig = sig;
  board.innerHTML = '';
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'squad-row ' + r.css + (r.isSelf ? ' is-self' : '');
    row.dataset.squad = r.squad;
    row.dataset.rank = String(r.rank);
    row.innerHTML =
      '<span class="sq-rank mono">' + r.rank + '</span>' +
      '<i class="sq-color"></i>' +
      '<span class="sq-name">' + esc(r.name) + '</span>' +
      '<span class="sq-kills mono">' + Math.round(r.kills) + '</span>';
    const dot = row.querySelector('.sq-color');
    if (dot) dot.style.background = r.ui;
    board.appendChild(row);
  }
}

// 顶部目标文案：优先显示"先到 N 击杀"，否则显示"限时 8:00"
function updateTargetUi() {
  setText(node('modeLabel'), '死亡竞赛');
  const target = node('scoreTarget');
  if (!target) return;
  if (state.killTarget > 0) setText(target, '先到 ' + Math.round(state.killTarget) + ' 击杀');
  else setText(target, '限时 ' + fmtTime(state.timeLimit) + ' · 人头最多获胜');
}

function updateTimerUi() {
  const el = node('timer');
  if (!el) return;
  const t = Math.max(0, num(state.timer, 0));
  el.textContent = fmtTime(t);
  el.classList.toggle('urgent', t <= 60);
  el.classList.toggle('critical', t <= 10);
}

// ============================================================
// 小地图（一次性烘焙地形底图 + 动态标记叠加）
// ============================================================
let minimapBase = null;
let minimapCss = 196;
let minimapDpr = 1;
let lastMinimapDraw = 0;
let minimapPending = false;

function sampleHeight(x, z) {
  try {
    if (typeof heightAt === 'function') {
      const h = heightAt(x, z);
      if (Number.isFinite(h)) return h;
    }
  } catch { /* 忽略 */ }
  return 0;
}
function sampleSurface(x, z) {
  try {
    if (typeof surfaceAt === 'function') return String(surfaceAt(x, z) || 'grass');
  } catch { /* 忽略 */ }
  return 'grass';
}

function initMinimap() {
  if (!minimapBase) minimapBase = bakeMinimap();
  resizeMinimap(true);
  drawMinimap();
}

// 底图：高度 → 明暗 + 地表类型着色（海/沙/草/岩）+ 栈桥/栈道 + 房屋屋顶
function bakeMinimap() {
  try {
    const N = 160;
    const c = document.createElement('canvas');
    c.width = N;
    c.height = N;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const half = WORLD_SAFE.half;
    const size = WORLD_SAFE.size;
    const seaLevel = num(EXTRAS_SAFE.seaLevel, 0);
    const hs = new Float32Array(N * N);
    let hMax = -Infinity;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = -half + ((i + 0.5) / N) * size;
        const z = -half + ((j + 0.5) / N) * size;
        const h = sampleHeight(x, z);
        hs[j * N + i] = h;
        if (h > hMax) hMax = h;
      }
    }
    const landMax = Math.max(seaLevel + 0.001, hMax);
    const img = ctx.createImageData(N, N);
    const data = img.data;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const idx = j * N + i;
        const h = hs[idx];
        const x = -half + ((i + 0.5) / N) * size;
        const z = -half + ((j + 0.5) / N) * size;
        const surface = sampleSurface(x, z);
        // 坡度光照（西北向光，与场景太阳方向一致）
        const hL = hs[idx - (i > 0 ? 1 : 0)];
        const hR = hs[idx + (i < N - 1 ? 1 : 0)];
        const hU = hs[idx - (j > 0 ? N : 0)];
        const hD = hs[idx + (j < N - 1 ? N : 0)];
        const dzdx = hR - hL;
        const dzdz = hD - hU;
        const shade = clamp(0.54 + (-dzdx * 0.42 + dzdz * 0.52) * 2.6, 0.34, 1.04);
        const t = clamp01((h - seaLevel) / (landMax - seaLevel));
        let r;
        let g;
        let b;
        if (surface === 'water' || h < seaLevel - 0.05) {
          // 水深：浅滩翠绿 → 深海青蓝（与海面着色同一色系）
          const d = clamp01((seaLevel - h) / 18);
          r = 58 - d * 40;
          g = 138 - d * 76;
          b = 142 - d * 40;
        } else if (surface === 'sand' || surface === 'wetSand' || surface === 'beach' || h < seaLevel + 3.4) {
          const k = clamp01((h - seaLevel) / 3.4);
          r = 176 + k * 34;
          g = 162 + k * 32;
          b = 120 + k * 30;
        } else if (surface === 'rock' || t > 0.84) {
          r = 118;
          g = 116;
          b = 108;
        } else {
          // 低地橄榄 → 高地枯草
          r = 62 + t * 58;
          g = 76 + t * 44;
          b = 48 + t * 30;
        }
        if (surface === 'road') { r = 118; g = 110; b = 88; }
        else if (surface === 'dirt') { r = 108; g = 98; b = 74; }
        else if (surface === 'wood' || surface === 'deck' || surface === 'plank') { r = 132; g = 104; b = 74; }
        // 轻微确定性噪点，避免死板
        const n = (((i * 37 + j * 91 + 17) % 13) - 6) * 0.8;
        const o = idx * 4;
        data[o] = clamp(r * shade + n, 0, 255);
        data[o + 1] = clamp(g * shade + n, 0, 255);
        data[o + 2] = clamp(b * shade + n * 0.7, 0, 255);
        data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    const toPx = (v) => ((v + half) / size) * N;

    // 长栈桥 / T 形平台（地图灵魂，狙击位）：来自 MAP_EXTRAS.pier
    const pier = EXTRAS_SAFE.pier;
    if (pier && Number.isFinite(pier.x) && Number.isFinite(pier.zStart) && Number.isFinite(pier.zEnd)) {
      const pw = Math.max(1, (num(pier.width, 3.4) / size) * N);
      const z0 = toPx(Math.min(pier.zStart, pier.zEnd));
      const z1 = toPx(Math.max(pier.zStart, pier.zEnd));
      ctx.fillStyle = 'rgba(150, 116, 80, 0.95)';
      ctx.fillRect(toPx(pier.x) - pw / 2, z0, pw, Math.max(1, z1 - z0));
      if (Number.isFinite(pier.headWidth) && Number.isFinite(pier.headDepth)) {
        const hw = (pier.headWidth / size) * N;
        const hd = (pier.headDepth / size) * N;
        const farZ = Math.abs(pier.zEnd) >= Math.abs(pier.zStart) ? pier.zEnd : pier.zStart;
        ctx.fillRect(toPx(pier.x) - hw / 2, toPx(farZ) - hd / 2, hw, hd);
      }
    }
    // 木栈道
    const walk = Array.isArray(EXTRAS_SAFE.boardwalk) ? EXTRAS_SAFE.boardwalk : [];
    ctx.strokeStyle = 'rgba(150, 118, 84, 0.9)';
    for (const b of walk) {
      if (!b || !Number.isFinite(b.x1) || !Number.isFinite(b.x2)) continue;
      ctx.lineWidth = Math.max(1, (num(b.w, 3) / size) * N);
      ctx.beginPath();
      ctx.moveTo(toPx(b.x1), toPx(b.z1));
      ctx.lineTo(toPx(b.x2), toPx(b.z2));
      ctx.stroke();
    }
    // 码头
    const docks = Array.isArray(EXTRAS_SAFE.docks) ? EXTRAS_SAFE.docks : [];
    ctx.fillStyle = 'rgba(150, 116, 80, 0.9)';
    for (const d of docks) {
      if (!d || !Number.isFinite(d.x) || !Number.isFinite(d.z)) continue;
      const dw = Math.max(1, (num(d.w, 4) / size) * N);
      const dd = Math.max(1, (num(d.d, 4) / size) * N);
      ctx.fillRect(toPx(d.x) - dw / 2, toPx(d.z) - dd / 2, dw, dd);
    }

    // 房屋屋顶（低饱和米灰，方便辨认可进入建筑）
    for (const h of HOUSES_SAFE) {
      if (!h || !Number.isFinite(h.x) || !Number.isFinite(h.w)) continue;
      const x0 = toPx(h.x - h.w / 2);
      const y0 = toPx(h.z - h.d / 2);
      const w = (h.w / size) * N;
      const d = (h.d / size) * N;
      ctx.fillStyle = 'rgba(206, 198, 176, 0.62)';
      ctx.fillRect(x0, y0, w, d);
      ctx.strokeStyle = 'rgba(92, 86, 68, 0.8)';
      ctx.lineWidth = 0.6;
      ctx.strokeRect(x0 + 0.3, y0 + 0.3, w - 0.6, d - 0.6);
    }

    // 中央广场（仅郊区地图有真正意义上的广场；潮汐湾是渔村台地，不画）
    if (MAP_SAFE.id === 'suburban' && ROADS_SAFE.plazaRadius > 0) {
      ctx.strokeStyle = 'rgba(214, 202, 160, 0.16)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.arc(toPx(0), toPx(0), (ROADS_SAFE.plazaRadius / size) * N, 0, Math.PI * 2);
      ctx.stroke();
    }
    return c;
  } catch (e) {
    return null;
  }
}

function resizeMinimap(force) {
  const cv = node('minimap');
  if (!cv) return;
  let css = minimapCss || 196;
  const rect = cv.getBoundingClientRect();
  if (rect && rect.width > 8) css = rect.width;
  const dpr = clamp(typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1, 1, 2);
  const px = Math.max(64, Math.round(css * dpr));
  if (force || cv.width !== px || cv.height !== px) {
    cv.width = px;
    cv.height = px;
  }
  minimapCss = css;
  minimapDpr = dpr;
}

function requestMinimapDraw(force) {
  if (force) {
    drawMinimap();
    lastMinimapDraw = nowMs();
    return;
  }
  const now = nowMs();
  if (now - lastMinimapDraw >= 90) {
    drawMinimap();
    lastMinimapDraw = now;
  } else if (!minimapPending) {
    minimapPending = true;
    setTimeout(() => {
      minimapPending = false;
      drawMinimap();
      lastMinimapDraw = nowMs();
    }, 100);
  }
}

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  return Date.now();
}

function drawMinimap() {
  const cv = node('minimap');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const w = minimapCss;
  const h = minimapCss;
  ctx.setTransform(minimapDpr, 0, 0, minimapDpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // 底图
  if (minimapBase) {
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(minimapBase, 0, 0, w, h);
  } else {
    ctx.fillStyle = '#39412f';
    ctx.fillRect(0, 0, w, h);
  }

  const half = WORLD_SAFE.half;
  const size = WORLD_SAFE.size;
  const wx = (x) => ((num(x, 0) + half) / size) * w;
  const wz = (z) => ((num(z, 0) + half) / size) * h;

  // 20m 网格（按地图尺寸自适应）
  ctx.strokeStyle = 'rgba(226, 219, 184, 0.07)';
  ctx.lineWidth = 1;
  for (let g = -half; g <= half; g += 20) {
    ctx.beginPath();
    ctx.moveTo(wx(g), 0);
    ctx.lineTo(wx(g), h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, wz(g));
    ctx.lineTo(w, wz(g));
    ctx.stroke();
  }

  // 边界
  ctx.strokeStyle = 'rgba(232, 224, 190, 0.22)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

  // 玩家视野扇形
  const px = wx(state.minimap.x);
  const py = wz(state.minimap.z);
  const yaw = num(state.minimap.yaw, 0);
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(-yaw);
  const fovHalf = (55 * Math.PI / 180) / 2;
  const viewR = (34 / size) * w;
  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, viewR);
  grad.addColorStop(0, 'rgba(236, 230, 200, 0.14)');
  grad.addColorStop(1, 'rgba(236, 230, 200, 0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, viewR, -Math.PI / 2 - fovHalf, -Math.PI / 2 + fovHalf);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // 队友：按小队配色
  const allies = Array.isArray(state.minimap.allies) ? state.minimap.allies : [];
  for (const a of allies) {
    if (!a) continue;
    const ax = wx(a.x);
    const ay = wz(a.z);
    if (ax < 0 || ax > w || ay < 0 || ay > h) continue;
    ctx.beginPath();
    ctx.arc(ax, ay, 2.6, 0, Math.PI * 2);
    ctx.fillStyle = a.color || squadMetaOf(a.squad).ui;
    ctx.fill();
    ctx.strokeStyle = 'rgba(12, 14, 10, 0.85)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // 敌人：仅 UAV 期间显示（未开 UAV 时完全不显示）
  const uavActive = state.uav.active || state.minimap.uav;
  if (uavActive) {
    const enemies = Array.isArray(state.minimap.enemies) ? state.minimap.enemies : [];
    for (const e of enemies) {
      if (!e) continue;
      const ex = wx(e.x);
      const ey = wz(e.z);
      if (ex < 0 || ex > w || ey < 0 || ey > h) continue;
      ctx.save();
      ctx.translate(ex, ey);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = e.color || squadMetaOf(e.squad).ui;
      ctx.strokeStyle = 'rgba(20, 16, 12, 0.9)';
      ctx.lineWidth = 1;
      ctx.fillRect(-2.4, -2.4, 4.8, 4.8);
      ctx.strokeRect(-2.4, -2.4, 4.8, 4.8);
      ctx.restore();
    }
  }

  // 玩家朝向箭头
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(-yaw);
  ctx.beginPath();
  ctx.moveTo(0, -7);
  ctx.lineTo(4.4, 5.4);
  ctx.lineTo(0, 2.8);
  ctx.lineTo(-4.4, 5.4);
  ctx.closePath();
  ctx.fillStyle = '#eee6cb';
  ctx.fill();
  ctx.strokeStyle = 'rgba(16, 18, 12, 0.9)';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.restore();

  // 北向标记
  ctx.fillStyle = 'rgba(236, 229, 200, 0.75)';
  ctx.font = '600 9px Consolas, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('N', 4, 3);
  ctx.beginPath();
  ctx.moveTo(11, 4);
  ctx.lineTo(13.4, 9);
  ctx.lineTo(8.6, 9);
  ctx.closePath();
  ctx.fill();
}

// ============================================================
// hud 方法（契约 §5.2）
// ============================================================
export const hud = {
  // ---------- 菜单 ----------
  showMenu() {
    const m = node('menu');
    if (m) m.classList.remove('hidden');
    state.menuVisible = true;
  },
  hideMenu() {
    const m = node('menu');
    if (m) m.classList.add('hidden');
    state.menuVisible = false;
  },
  setMenuVisible(v) {
    if (v) hud.showMenu();
    else hud.hideMenu();
  },
  setStatus(text) {
    setText(node('status'), text == null ? '' : String(text));
  },
  setMenuStatus(text, kind) {
    const s = node('connStatus');
    if (!s) return;
    s.textContent = String(text == null ? '' : text);
    const k = String(kind || '').toLowerCase();
    s.classList.remove('ok', 'err', 'warn');
    if (k === 'ok' || k === 'success' || k === 'connected') s.classList.add('ok');
    else if (k === 'err' || k === 'error' || k === 'fail' || k === 'failed') s.classList.add('err');
    else if (k === 'warn' || k === 'connecting' || k === 'wait') s.classList.add('warn');
  },
  /**
   * 地图信息（菜单文案数据驱动）：kicker / 标题 / 副标题 / 描述
   * @param {{name?:string,en?:string,subtitle?:string,desc?:string}} meta MAP_META
   * @param {number} [squadCount] 小队数量（默认取 SQUADS.length）
   */
  setMapInfo(meta, squadCount) {
    const m = meta || MAP_SAFE;
    setText(node('menuKicker'), (m.en || 'TIDEWATER') + ' · DEATHMATCH');
    setText(node('menuTitle'), m.name || '');
    setText(node('menuSub'), m.subtitle || '');
    setText(node('menuDesc'), m.desc || '');
    const count = Math.max(2, Math.round(num(squadCount, SQUADS_SAFE.length)));
    setText(node('menuSquadCount'), count);
    if (typeof document !== 'undefined') {
      document.title = (m.name || '') + ' · ' + (m.en || '');
    }
  },

  // ---------- 生命体征 ----------
  setHp(hp, max) {
    const m = num(max, state.hpMax) || 100;
    const v = clamp(num(hp, m), 0, m);
    state.hp = v;
    state.hpMax = m;
    setStyle(node('hpFill'), 'width', (v / m * 100).toFixed(1) + '%');
    setText(node('hpNum'), Math.round(v));
    const wrap = node('hpWrap');
    if (wrap) {
      wrap.classList.toggle('low', v / m <= 0.3);
      wrap.classList.toggle('critical', v / m <= 0.15);
    }
    // 低血持续暗黑血丝：hp < 15% 常驻，回血（> 15%）或死亡才消失
    const low = v > 0.001 && v / m < 0.15;
    this.setLowHpVeins(low);
  },
  // GOD 无敌标记（顶部金色徽标 + 剩余秒数）
  setGod(active, seconds) {
    const el = node('godBadge');
    if (!el) return;
    state.god = !!active;
    state.godLeft = Math.max(0, Math.round(num(seconds, 0)));
    el.classList.toggle('hidden', !state.god);
    if (state.god) setText(node('godLeft'), state.godLeft > 0 ? state.godLeft + 's' : '');
  },
  setShield(v0, max) {
    const m = num(max, state.shieldMax) || 100;
    const v = clamp(num(v0, 0), 0, m);
    state.shield = v;
    state.shieldMax = m;
    const wrap = node('shieldWrap');
    if (wrap) wrap.classList.toggle('hidden', v <= 0.001);
    setStyle(node('shieldFill'), 'width', (v / m * 100).toFixed(1) + '%');
    setText(node('shieldNum'), Math.round(v));
  },
  setStamina(v0, max) {
    const m = num(max, state.staminaMax) || 100;
    const v = clamp(num(v0, m), 0, m);
    state.stamina = v;
    state.staminaMax = m;
    const bar = node('staminaBar');
    if (!staminaFillEl || !staminaFillEl.isConnected) staminaFillEl = bar ? bar.querySelector('i') : null;
    setStyle(staminaFillEl, 'width', (v / m * 100).toFixed(1) + '%');
    if (bar) {
      bar.classList.toggle('low', v / m <= 0.25);
      bar.classList.toggle('empty', v <= 0.001);
    }
  },
  setStance(stance) {
    const s = normalizeStance(stance);
    state.stance = s;
    const b = node('stanceBadge');
    if (!b) return;
    b.textContent = STANCE_TEXT[s] || '站立';
    b.classList.remove('stand', 'crouch', 'slide', 'sprint');
    b.classList.add(s);
  },

  // ---------- 武器 / 弹药 ----------
  setWeapon(kind, name, mag, reserve) {
    state.weapon = kind || state.weapon;
    state.weaponName = name || weaponNameOf(kind, state.weaponName);
    setText(node('weapon'), state.weaponName);
    const m = Math.max(0, Math.round(num(mag, 0)));
    state.mag = m;
    state.reserve = reserve;
    const magEl = node('ammoMag');
    if (magEl) {
      magEl.textContent = String(m);
      const magSize = num(WEAPON_MAG_HINT[state.weapon], 0);
      magEl.classList.toggle('low', magSize > 0 && m <= Math.max(1, Math.floor(magSize * 0.25)));
    }
    const res = (reserve === Infinity || reserve === -1 || reserve == null)
      ? '∞' : String(Math.max(0, Math.round(num(reserve, 0))));
    setText(node('ammoReserve'), res);
  },
  setReload(progress) {
    const wrap = node('reloadWrap');
    const p = (progress == null) ? null : clamp01(progress);
    const on = p != null && p > 0.001 && p < 0.999;
    state.reloading = on;
    state.reloadProgress = p;
    if (wrap) wrap.classList.toggle('hidden', !on);
    if (on) setStyle(node('reloadFill'), 'width', (p * 100).toFixed(1) + '%');
  },
  setWeaponSlots(ownedMap, activeId, order) {
    const root = node('weaponSlots');
    if (!root) return;
    const list = (Array.isArray(order) && order.length) ? order : WEAPON_ORDER_DEFAULT;
    const owned = (id) => (Array.isArray(ownedMap) ? ownedMap.includes(id) : !!(ownedMap && ownedMap[id]));
    const sig = list.join(',') + '|' + String(activeId) + '|' + list.map((id) => (owned(id) ? 1 : 0)).join('');
    if (root.dataset.sig !== sig) {
      root.dataset.sig = sig;
      root.innerHTML = '';
      list.forEach((id, i) => {
        const slot = document.createElement('div');
        slot.className = 'slot';
        slot.dataset.weapon = id;
        slot.innerHTML = '<span class="k">' + (i + 1) + '</span>' +
          '<span class="n">' + esc(weaponNameOf(id, id)) + '</span>';
        root.appendChild(slot);
      });
    }
    for (const slot of root.children) {
      const id = slot.dataset.weapon;
      slot.classList.toggle('owned', owned(id));
      slot.classList.toggle('active', id === activeId);
    }
    state.weaponSlots = list.slice();
  },
  setCrosshair(spreadPx, opts) {
    const o = opts || {};
    const c = node('crosshair');
    if (!c) return;
    let size = Number(spreadPx);
    if (!Number.isFinite(size)) size = state.crosshairSize || 22;
    size = clamp(size, 8, 200);
    state.crosshairSize = size;
    if ('ads' in o) state.ads = !!o.ads;
    if ('hidden' in o) state.crosshairHidden = !!o.hidden;
    c.style.width = size.toFixed(1) + 'px';
    c.style.height = size.toFixed(1) + 'px';
    c.classList.toggle('aiming', !!state.ads);
    applyCrosshairVisibility();
  },
  setAiming(ads, sightType) {
    const st = sightType || state.sightType || 'iron';
    state.ads = !!ads;
    state.sightType = st;
    const c = node('crosshair');
    if (c) c.classList.toggle('aiming', !!ads);
    // 开镜时隐藏普通准星（机瞄/红点靠肉眼瞄具，狙击靠分划遮罩）
    applyCrosshairVisibility();
    // 狙击开镜：由 setAiming 直接驱动遮罩；红点/机瞄永远不显示遮罩
    if (ads && isScopeSight(st)) setScopeInternal(true, st, state.zoomLabel);
    else setScopeInternal(false, st, state.zoomLabel);
  },
  setScope(active, sightType, zoomLabel) {
    setScopeInternal(active, sightType, zoomLabel);
  },

  // ---------- 命中反馈 ----------
  showHitmarker(part, killed) {
    const p = (String(part || '').toLowerCase() === 'head') ? 'head'
      : (String(part || '').toLowerCase() === 'legs' ? 'legs' : 'body');
    const isHead = p === 'head';
    const kill = !!killed;
    state.hitmarkerPart = p;
    state.hitmarkerKilled = kill;

    const target = node(isHead ? 'hitmarker-head' : 'hitmarker');
    const other = node(isHead ? 'hitmarker' : 'hitmarker-head');
    if (other) other.classList.remove('show', 'kill');
    if (!target) return;

    // 重启动画：移除 class → 强制回流 → 加 class
    target.classList.remove('show', 'kill');
    void target.offsetWidth;
    target.classList.toggle('kill', kill);
    target.classList.add('show');

    const isHeadKey = isHead;
    if (isHeadKey && headMarkTimer) clearTimeout(headMarkTimer);
    if (!isHeadKey && markTimer) clearTimeout(markTimer);
    const dur = isHead ? (kill ? 560 : 420) : (kill ? 340 : 200);
    const timer = setTimeout(() => { target.classList.remove('show', 'kill'); }, dur);
    if (isHeadKey) headMarkTimer = timer;
    else markTimer = timer;
  },
  flashDamage(headshot) {
    const f = node('flash');
    if (!f) return;
    f.classList.remove('hidden', 'show', 'head');
    void f.offsetWidth;
    if (headshot) f.classList.add('head');
    f.classList.add('show');
    state.lastDamageHead = !!headshot;
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      f.classList.remove('show', 'head');
    }, 640);
  },

  /**
   * 受击血丝：屏幕边缘生成血管状纹理，约 0.5 秒消散。
   * @param {number} severity 0~1，伤害占比越高血丝越密越粗
   */
  bloodVeins(severity) {
    const svg = node('bloodVeins');
    const group = node('bvGroup');
    if (!svg || !group || typeof document.createElementNS !== 'function') return;
    const sev = clamp(num(severity, 0.2), 0.05, 1);
    const NS = 'http://www.w3.org/2000/svg';
    const W = Math.max(320, svg.clientWidth || window.innerWidth || 1000);
    const H = Math.max(240, svg.clientHeight || window.innerHeight || 700);
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    while (group.firstChild) group.removeChild(group.firstChild);

    const cx = W / 2;
    const cy = H / 2;
    const baseW = Math.min(W, H) / 500;

    // 一条"血管"：从屏幕边缘某点出发，向中心方向蜿蜒生长（多段贝塞尔 + 分叉）
    const drawVein = (startX, startY, dirX, dirY, len, width, opacity, depth) => {
      let x = startX;
      let y = startY;
      let dx = dirX;
      let dy = dirY;
      let d = 'M' + x.toFixed(1) + ' ' + y.toFixed(1);
      const segs = 4 + Math.floor(Math.random() * 3);
      for (let s = 0; s < segs; s++) {
        // 每段方向轻微随机偏转，形成自然的蜿蜒
        const turn = (Math.random() - 0.5) * 1.0;
        const cs = Math.cos(turn);
        const sn = Math.sin(turn);
        const nx = dx * cs - dy * sn;
        const ny = dx * sn + dy * cs;
        dx = nx;
        dy = ny;
        const stepLen = (len / segs) * (0.6 + Math.random() * 0.8);
        const nx2 = x + dx * stepLen;
        const ny2 = y + dy * stepLen;
        // 二次贝塞尔，控制点偏移做出血管的弧度
        const mx = (x + nx2) / 2 + (-dy) * stepLen * (Math.random() - 0.5) * 0.9;
        const my = (y + ny2) / 2 + (dx) * stepLen * (Math.random() - 0.5) * 0.9;
        d += ' Q' + mx.toFixed(1) + ' ' + my.toFixed(1) + ' ' + nx2.toFixed(1) + ' ' + ny2.toFixed(1);
        x = nx2;
        y = ny2;
        // 沿途分叉出细血管
        if (depth < 2 && Math.random() < 0.55) {
          const bl = stepLen * (0.4 + Math.random() * 0.7);
          const bang = Math.atan2(dy, dx) + (Math.random() < 0.5 ? 1 : -1) * (0.5 + Math.random() * 0.8);
          drawVein(x, y, Math.cos(bang), Math.sin(bang), bl,
            width * 0.55, opacity * 0.7, depth + 1);
        }
      }
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('stroke-width', Math.max(0.8, width * baseW).toFixed(2));
      p.setAttribute('opacity', opacity.toFixed(2));
      group.appendChild(p);
    };

    // 从四条边（以及四角）向内生长：数量与长度随伤势加重
    const clusters = Math.round(3 + sev * 6);
    for (let i = 0; i < clusters; i++) {
      // 随机选一条边
      const side = Math.floor(Math.random() * 4);
      let sx;
      let sy;
      let dirX;
      let dirY;
      if (side === 0) { sx = Math.random() * W; sy = 0; dirX = (Math.random() - 0.5) * 0.6; dirY = 1; }
      else if (side === 1) { sx = Math.random() * W; sy = H; dirX = (Math.random() - 0.5) * 0.6; dirY = -1; }
      else if (side === 2) { sx = 0; sy = Math.random() * H; dirX = 1; dirY = (Math.random() - 0.5) * 0.6; }
      else { sx = W; sy = Math.random() * H; dirX = -1; dirY = (Math.random() - 0.5) * 0.6; }
      // 朝屏幕中心略微修正方向
      const toCx = cx - sx;
      const toCy = cy - sy;
      const tl = Math.hypot(toCx, toCy) || 1;
      dirX = dirX * 0.55 + (toCx / tl) * 0.45;
      dirY = dirY * 0.55 + (toCy / tl) * 0.45;
      const dl = Math.hypot(dirX, dirY) || 1;
      dirX /= dl;
      dirY /= dl;
      // 长度：屏幕短边的 12%~32%，伤势越重越长
      const len = Math.min(W, H) * (0.12 + Math.random() * 0.16) * (0.75 + sev * 0.7);
      drawVein(sx, sy, dirX, dirY, len, 2.0 + Math.random() * 2.4 * (0.7 + sev),
        0.5 + Math.random() * 0.45, 0);
    }

    svg.classList.remove('hidden');
    void svg.offsetWidth;
    svg.classList.add('show');
    if (bloodTimer) clearTimeout(bloodTimer);
    bloodTimer = setTimeout(() => {
      svg.classList.remove('show');
      setTimeout(() => {
        if (!svg.classList.contains('show')) svg.classList.add('hidden');
      }, 520);
    }, 60);
  },

  /**
   * 低血量持续暗黑血丝：hp < 15% 时显示，回血或死亡才消失。
   * @param {boolean} on
   */
  setLowHpVeins(on) {
    const el = node('lowHpVeins');
    if (!el) return;
    const want = !!on;
    if (state.lowHpVeins === want) return;
    state.lowHpVeins = want;
    el.classList.remove('hidden');
    el.classList.toggle('show', want);
    if (!want) {
      setTimeout(() => { if (!state.lowHpVeins) el.classList.add('hidden'); }, 520);
    }
  },

  showDamageFrom(angleRad) {
    const angle = num(angleRad, 0);
    // 优先：SVG 正态分布曲线扇形（指向明确，越靠前越红）
    const layer = node('dmgLayer');
    if (layer && typeof document.createElementNS === 'function') {
      try {
        const NS = 'http://www.w3.org/2000/svg';
        const g = document.createElementNS(NS, 'g');
        g.setAttribute('transform', 'rotate(' + (angle * 180 / Math.PI).toFixed(2) + ')');
        // 正态分布曲线（高斯钟形）扇形：尖端指向伤害来源，横向越靠中间越红
        const sigma = 0.26;
        const R0 = 64;      // 内半径（离准星的距离）
        const LEN = 52;     // 尖端长度
        const HALF = 40;    // 底边半宽
        const N = 30;
        let d = '';
        for (let i = 0; i <= N; i++) {
          const t = i / N;
          const x = (t - 0.5) * 2;                              // -1..1
          const y = Math.exp(-(x * x) / (2 * sigma * sigma));    // 0..1
          d += (i === 0 ? 'M' : 'L') + (x * HALF).toFixed(2) + ' ' + (-(R0 + y * LEN)).toFixed(2);
        }
        d += 'L' + HALF.toFixed(2) + ' ' + (-R0).toFixed(2);
        d += 'L' + (-HALF).toFixed(2) + ' ' + (-R0).toFixed(2) + 'Z';
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', d);
        path.setAttribute('fill', 'url(#dmgCurveGrad)');
        path.setAttribute('stroke', 'rgba(255,120,96,0.85)');
        path.setAttribute('stroke-width', '1.2');
        path.setAttribute('class', 'dmg-curve');
        g.appendChild(path);
        // 尖端发光点：明确指向来源
        const tip = document.createElementNS(NS, 'circle');
        tip.setAttribute('cx', '0');
        tip.setAttribute('cy', String(-(R0 + LEN + 3)));
        tip.setAttribute('r', '8');
        tip.setAttribute('fill', 'url(#dmgGlowGrad)');
        tip.setAttribute('class', 'dmg-tip');
        g.appendChild(tip);
        layer.appendChild(g);
        while (layer.childElementCount > 6) layer.removeChild(layer.firstChild);
        setTimeout(() => {
          g.classList.add('fade');
          setTimeout(() => g.remove(), 340);
        }, 900);
        state.lastDamageAngle = angle;
        return;
      } catch { /* 回退到 DOM 环 */ }
    }
    const root = node('dmgIndicators');
    if (!root) return;
    const div = document.createElement('div');
    div.className = 'dmg-ind';
    div.style.transform = 'translate(-50%, -50%) rotate(' + angle.toFixed(4) + 'rad)';
    root.appendChild(div);
    while (root.childElementCount > 8) root.removeChild(root.firstChild);
    setTimeout(() => {
      div.classList.add('fade');
      setTimeout(() => div.remove(), 320);
    }, 850);
  },

  // ---------- 比赛信息（死亡竞赛） ----------
  /**
   * 4 队击杀排名（顶部排名条）。
   * @param {Array|Object} standings [{squad,kills,rank}] 或 {alpha:3,bravo:5,...}
   */
  setScores(standings) {
    const rows = normalizeStandings(standings, state.selfSquad);
    if (!rows.length) return;
    state.standings = rows;
    const map = {};
    for (const r of rows) map[r.squad] = r.kills;
    state.scores = map;
    const self = rows.find((r) => r.isSelf);
    state.selfRank = self ? self.rank : 0;
    renderSquadBoard();
  },
  /** 自己所在小队（用于高亮与结算名次） */
  setSelfSquad(id) {
    const s = normalizeSquad(id);
    state.selfSquad = s;
    if (state.standings.length) hud.setScores(state.standings);
  },
  /**
   * 对局信息：倒计时 / 目标 / 阶段
   * @param {{mode?:string, phase?:string, timeLeft?:number, killTarget?:number}} info
   */
  setMatchInfo(info) {
    const m = info || {};
    if (m.mode) state.mode = String(m.mode);
    if (m.phase) state.matchPhase = String(m.phase);
    if (m.timeLeft != null) state.timer = Math.max(0, num(m.timeLeft, state.timer));
    if (m.killTarget != null) state.killTarget = Math.max(0, num(m.killTarget, 0));
    updateTimerUi();
    updateTargetUi();
  },
  setTimer(sec) {
    state.timer = Math.max(0, num(sec, state.timer));
    updateTimerUi();
  },
  setUav(active, secLeft) {
    const on = !!active;
    const sec = Math.max(0, num(secLeft, state.uav.sec));
    state.uav = { active: on, sec };
    const badge = node('uavBadge');
    if (badge) {
      badge.classList.toggle('hidden', !on);
      setText(node('uavTime'), Math.ceil(sec) + 's');
    }
    const dot = node('uavDot');
    if (dot) dot.classList.toggle('hidden', !on);
    const hudEl = node('hud');
    if (hudEl) hudEl.classList.toggle('uav', on);
    requestMinimapDraw(true);
  },
  setKills(kills) {
    state.kills = Math.max(0, Math.round(num(kills, state.kills)));
    updateScoreLine();
  },
  setDeaths(deaths) {
    state.deaths = Math.max(0, Math.round(num(deaths, state.deaths)));
    updateScoreLine();
  },
  setPing(ms) {
    // main.js 传的是 '47ms' 这样的字符串，也兼容数字
    const parsed = (typeof ms === 'string') ? parseFloat(ms) : Number(ms);
    const v = Math.max(0, Math.round(Number.isFinite(parsed) ? parsed : 0));
    state.ping = v;
    const el = node('ping');
    if (!el) return;
    el.textContent = v + ' ms';
    el.classList.toggle('good', v > 0 && v < 60);
    el.classList.toggle('fair', v >= 60 && v < 120);
    el.classList.toggle('bad', v >= 120);
  },
  setPlayers(list, selfId) {
    const arr = Array.isArray(list) ? list
      : (list && typeof list === 'object' ? Object.values(list) : []);
    if (selfId != null) { state.selfId = selfId; state.myId = selfId; }
    state.players = arr;
    const root = node('players');
    if (!root) return;
    if (!root._hudRows) root._hudRows = new Map();
    const rows = root._hudRows;
    const seen = new Set();

    for (const p of arr) {
      if (!p || p.id == null) continue;
      seen.add(p.id);
      let row = rows.get(p.id);
      if (!row) {
        const el = document.createElement('div');
        el.className = 'player-row';
        el.innerHTML =
          '<span class="pdot"></span>' +
          '<span class="pteam"></span>' +
          '<span class="pname"></span>' +
          '<span class="ai-tag hidden">AI</span>' +
          '<span class="pkd mono"></span>';
        row = {
          el,
          dot: el.querySelector('.pdot'),
          team: el.querySelector('.pteam'),
          name: el.querySelector('.pname'),
          ai: el.querySelector('.ai-tag'),
          kd: el.querySelector('.pkd'),
        };
        rows.set(p.id, row);
        root.appendChild(el);
      }
      const me = (state.selfId != null && p.id === state.selfId) || !!p.me;
      row.el.classList.toggle('me', me);
      const squadId = normalizeSquad(p.squad != null ? p.squad : p.team);
      const meta = squadMetaOf(squadId);
      row.el.classList.remove('squad-alpha', 'squad-bravo', 'squad-charlie', 'squad-delta',
        'team-alpha', 'team-bravo', 'ally', 'enemy');
      row.el.classList.add(meta.css);
      row.el.classList.toggle('ally', !!squadId && squadId === state.selfSquad);
      row.el.classList.toggle('enemy', !!squadId && !!state.selfSquad && squadId !== state.selfSquad);
      setText(row.team, (meta.tag || '').slice(0, 1));
      setText(row.name, (p.name == null ? '玩家' : p.name) + (me ? '（我）' : ''));
      setStyle(row.dot, 'background', meta.ui);
      setStyle(row.dot, 'color', meta.ui);
      if (row.ai) row.ai.classList.toggle('hidden', !p.bot);
      const kd = (p.kills != null || p.deaths != null)
        ? Math.round(num(p.kills, 0)) + '/' + Math.round(num(p.deaths, 0)) : '';
      setText(row.kd, kd);
      // 血量条已移除：不向玩家暴露他人血量（仅保留存活/阵亡状态用于灰显）
      row.el.classList.toggle('dead', p.alive === false);
    }
    // 清理离场玩家
    for (const [id, row] of rows) {
      if (!seen.has(id)) {
        row.el.remove();
        rows.delete(id);
      }
    }
    // 左上状态附上在场人数（仅在 HUD 已可见时）
    const st = node('status');
    if (st && /^已连接/.test(st.textContent)) setText(st, '已连接 · ' + arr.length + ' 人');
  },

  // ---------- 击杀信息 / Toast ----------
  /**
   * 击杀信息：杀手[队色] ▸ 受害者[队色]
   * @param {{killer?:string|Object, killerName?:string, killerSquad?:string,
   *          victim?:string|Object, victimName?:string, victimSquad?:string,
   *          headshot?:boolean, weapon?:string}} info
   */
  addKillFeed(info) {
    const root = node('killfeed');
    if (!root) return;
    const d = info || {};
    const killer = sideOf(d.killer != null ? d.killer : d.killerName,
      d.killerSquad != null ? d.killerSquad : d.killerTeam);
    const victim = sideOf(d.victim != null ? d.victim : d.victimName,
      d.victimSquad != null ? d.victimSquad : d.victimTeam);
    const weaponKind = d.weapon ? String(d.weapon) : '';
    const weapon = WEAPON_NAMES[weaponKind] || weaponKind;
    const kMeta = squadMetaOf(killer.squad);
    const vMeta = squadMetaOf(victim.squad);
    const entry = document.createElement('div');
    entry.className = 'kill-entry' + (d.headshot ? ' headshot' : '') +
      (killer.squad ? ' ' + kMeta.css : '') + (victim.squad ? ' ' + vMeta.css : '');
    entry.innerHTML =
      '<span class="kf-k' + (killer.squad ? ' ' + kMeta.css : '') + '">' + esc(killer.name || '???') + '</span>' +
      (weapon ? '<span class="kf-w">' + esc(weapon) + '</span>' : '') +
      (d.headshot ? '<span class="kf-hs">HS</span>' : '') +
      '<span class="kf-arrow">▸</span>' +
      '<span class="kf-v' + (victim.squad ? ' ' + vMeta.css : '') + '">' + esc(victim.name || '???') + '</span>';
    const kEl = entry.querySelector('.kf-k');
    const vEl = entry.querySelector('.kf-v');
    if (kEl && killer.squad) kEl.style.color = kMeta.ui;
    if (vEl && victim.squad) vEl.style.color = vMeta.ui;
    root.prepend(entry);
    const max = Math.max(3, Math.round(num(DM_SAFE.killfeedMax, 8)));
    while (root.childElementCount > max) root.removeChild(root.lastElementChild);
    setTimeout(() => {
      entry.classList.add('out');
      setTimeout(() => entry.remove(), 320);
    }, 5200);
  },
  addToast(text) {
    const root = node('toasts');
    if (!root) return;
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = String(text == null ? '' : text);
    root.appendChild(t);
    while (root.childElementCount > 4) root.removeChild(root.firstElementChild);
    setTimeout(() => {
      t.classList.add('out');
      setTimeout(() => t.remove(), 320);
    }, 2400);
  },

  // ---------- 弹窗 ----------
  showDeath(text, sub) {
    const d = node('death');
    if (!d) return;
    setText(node('deathText'), text || '你被击倒');
    setText(node('deathSub'), sub || '重生中…');
    d.classList.remove('hidden');
    state.dead = true;
    setScopeInternal(false, state.sightType, state.zoomLabel);
    // 死亡：清除低血血丝与短时血丝
    this.setLowHpVeins(false);
    const bv = node('bloodVeins');
    if (bv) { bv.classList.remove('show'); bv.classList.add('hidden'); }
  },
  hideDeath() {
    const d = node('death');
    if (d) d.classList.add('hidden');
    state.dead = false;
  },
  showPause(text) {
    const p = node('pause');
    if (!p) return;
    setText(node('pauseText'), text || '已暂停 · 点击继续');
    p.classList.remove('hidden');
    state.paused = true;
  },
  hidePause() {
    const p = node('pause');
    if (p) p.classList.add('hidden');
    state.paused = false;
  },

  // ---------- 开局准备 / 倒计时 ----------
  showWarmup(title, sub) {
    const root = node('warmup');
    if (!root) return;
    const n = Math.max(1, Math.round(num(DM_SAFE.countdown, 3)));
    setText(node('warmupTitle'), title || '按 空格 开始战斗');
    setText(node('warmupSub'), sub || ('点击画面锁定鼠标 · 按空格开始 ' + n + ' 秒倒计时 · 死亡 ' +
      Math.round(num(DM_SAFE.respawnTime, 3)) + ' 秒后复活'));
    const count = node('warmupCount');
    if (count) count.classList.add('hidden');
    root.classList.remove('hidden');
    state.warmupVisible = true;
    state.matchPhase = 'waiting';
  },
  hideWarmup() {
    const root = node('warmup');
    if (root) root.classList.add('hidden');
    state.warmupVisible = false;
  },
  setCountdown(sec) {
    const root = node('warmup');
    const countEl = node('warmupCount');
    if (!root || !countEl) return;
    const n = Math.max(0, Math.ceil(num(sec, 0)));
    state.countdown = n;
    state.matchPhase = 'countdown';
    root.classList.remove('hidden');
    state.warmupVisible = true;
    setText(node('warmupTitle'), '准备开始');
    setText(node('warmupSub'), '死亡竞赛 · 击杀最多的小队获胜');
    countEl.classList.remove('hidden');
    setText(countEl, n > 0 ? String(n) : 'GO');
  },
  setMatchPhase(phase, countdown) {
    const p = String(phase || 'waiting');
    if (p === 'waiting') {
      this.showWarmup();
      return;
    }
    if (p === 'countdown') {
      this.setCountdown(countdown);
      return;
    }
    state.matchPhase = p === 'playing' ? 'playing' : p;
    state.countdown = 0;
    this.hideWarmup();
  },
  /**
   * 死亡竞赛结算面板：4 队排名表 + 自己的名次
   * @param {{winnerSquad?:string, standings?:Array|Object, selfRank?:number,
   *          selfSquad?:string, win?:boolean}} info
   */
  showMatchEnd(info) {
    const d = info || {};
    const root = node('matchEnd');
    if (!root) return;
    const selfSquad = normalizeSquad(d.selfSquad != null ? d.selfSquad : state.selfSquad);
    const rows = normalizeStandings(d.standings != null ? d.standings : state.standings, selfSquad);
    if (rows.length) {
      state.standings = rows;
      const map = {};
      for (const r of rows) map[r.squad] = r.kills;
      state.scores = map;
    }
    const selfRow = rows.find((r) => r.isSelf) || null;
    const selfRank = Math.max(0, Math.round(num(d.selfRank, selfRow ? selfRow.rank : state.selfRank)));
    const winnerSquad = normalizeSquad(d.winnerSquad != null ? d.winnerSquad
      : (d.winner != null ? d.winner : (rows[0] ? rows[0].squad : null)));
    state.winnerSquad = winnerSquad || null;
    const win = (typeof d.win === 'boolean') ? d.win
      : (!!winnerSquad && !!selfSquad && winnerSquad === selfSquad);
    state.selfRank = selfRank;

    const title = node('matchEndTitle');
    if (title) {
      title.textContent = win ? '胜 利' : (selfRank > 0 ? '第 ' + selfRank + ' 名' : '失 败');
      title.classList.remove('win', 'lose', 'draw');
      title.classList.add(win ? 'win' : 'lose');
    }
    setText(node('matchEndSub'), '死亡竞赛 · 最终排名');
    // #matchEndScores 已被 Lead 加上 .hidden 且不再使用，这里保持不动
    renderMatchEndStandings(rows, selfSquad);
    root.classList.remove('hidden');
    root.classList.toggle('is-win', win);
    root.classList.toggle('is-lose', !win);
    state.matchEnd = true;
    state.winner = win ? 'win' : 'lose';
  },
  hideMatchEnd() {
    const d = node('matchEnd');
    if (d) d.classList.add('hidden');
    state.matchEnd = false;
  },

  // ---------- 小地图 / 罗盘 ----------
  /**
   * @param {{x?:number,z?:number,yaw?:number,
   *          allies?:Array<{x:number,z:number,squad?:string}>,
   *          enemies?:Array<{x:number,z:number,squad?:string}>, uav?:boolean}} mm
   */
  setMinimapState(mm) {
    const s = mm || {};
    state.minimap.x = num(s.x, state.minimap.x);
    state.minimap.z = num(s.z, state.minimap.z);
    state.minimap.yaw = num(s.yaw, state.minimap.yaw);
    const allies = Array.isArray(s.allies) ? s.allies : [];
    state.minimap.allies = allies.filter(Boolean).map((a) => {
      const squad = normalizeSquad(a.squad != null ? a.squad : a.team);
      return { x: num(a.x, 0), z: num(a.z, 0), squad, color: squadMetaOf(squad).ui };
    });
    const enemies = Array.isArray(s.enemies) ? s.enemies : [];
    state.minimap.enemies = enemies.filter(Boolean).map((e) => {
      const squad = normalizeSquad(e.squad != null ? e.squad : e.team);
      return { x: num(e.x, 0), z: num(e.z, 0), squad, color: squadMetaOf(squad).ui };
    });
    state.minimap.uav = !!(s.uav != null ? s.uav : state.uav.active);
    updateCompass();
    requestMinimapDraw(false);
  },

  setVisible(v) {
    const root = node('hud');
    if (root) root.classList.toggle('hidden', !v);
    state.hudVisible = !!v;
    if (v) {
      // main.js 进入战场后不再单独更新 #status，这里补一个可读的连接状态
      const st = node('status');
      if (st && (st.textContent === '' || st.textContent === '连接中…')) setText(st, '已连接');
      nextFrame(() => {
        resizeMinimap(true);
        updateCompass();
        drawMinimap();
      });
    } else {
      setScopeInternal(false, state.sightType, state.zoomLabel);
    }
  },

  // ---------- 额外便捷方法 ----------
  setStreak(n) {
    state.streak = Math.max(0, Math.round(num(n, 0)));
    const b = node('streakBadge');
    if (!b) return;
    b.classList.toggle('hidden', state.streak < 2);
    b.textContent = state.streak + ' 连杀';
    b.classList.toggle('hot', state.streak >= 5);
  },
  setSpeedBoost(active, secLeft) {
    // 兼容旧 #speedBadge（main.js 可选用）
    const on = !!active;
    const sec = Math.max(0, num(secLeft, 0));
    state.speedBoost = { active: on, sec };
    const b = node('speedBadge');
    if (!b) return;
    b.classList.toggle('hidden', !on);
    b.textContent = on && sec > 0 ? '加速 ' + Math.ceil(sec) + 's' : '加速';
  },
  setSelfId(id) {
    state.selfId = id == null ? null : id;
  },
  getSettings() {
    return { ...settings };
  },
  getState() {
    return state;
  },
};

// 击杀信息两侧的名字：既支持纯字符串，也支持 {name, squad} 对象
function sideOf(v, squadFallback) {
  if (v && typeof v === 'object') {
    return {
      name: v.name != null ? v.name : '',
      squad: normalizeSquad(v.squad != null ? v.squad : v.team),
    };
  }
  return {
    name: v == null ? '' : String(v),
    squad: normalizeSquad(squadFallback),
  };
}

// 结算面板排名表（自己的队伍加 .me-row 高亮，第一名加 .champion）
function renderMatchEndStandings(rows, selfSquad) {
  const root = node('matchEndStandings');
  if (!root) return;
  root.innerHTML = '';
  const self = normalizeSquad(selfSquad);
  for (const r of rows) {
    const row = document.createElement('div');
    const isSelf = !!self && r.squad === self;
    row.className = 'standings-row ' + r.css + (isSelf ? ' me-row' : '') + (r.rank === 1 ? ' champion' : '');
    row.dataset.squad = r.squad;
    row.innerHTML =
      '<span class="st-rank mono">' + r.rank + '</span>' +
      '<i class="st-color"></i>' +
      '<span class="st-name">' + esc(r.name) + '</span>' +
      '<span class="st-kills mono">' + Math.round(r.kills) + '</span>';
    const dot = row.querySelector('.st-color');
    if (dot) dot.style.background = r.ui;
    root.appendChild(row);
  }
}

function updateScoreLine() {
  setText(node('score'), '击杀 ' + state.kills + ' · 死亡 ' + state.deaths);
}

function applyCrosshairVisibility() {
  const c = node('crosshair');
  if (!c) return;
  // 开镜（任何瞄具：机瞄/红点/狙击镜）都不再显示屏幕中心准星，
  // 瞄准参考交给真实瞄具（照门/准星、红点、狙击分划）。
  const hidden = !!state.crosshairHidden || !!state.ads || (state.scopeActive && isScopeSight(state.sightType));
  c.classList.toggle('hidden', hidden);
}

// 开镜遮罩统一入口：只有狙击类瞄具会显示圆形遮罩
function setScopeInternal(active, sightType, zoomLabel) {
  const st = sightType || state.sightType || 'scope';
  const show = !!active && isScopeSight(st);
  state.scopeActive = show;
  state.scopeSight = st;
  if (zoomLabel) state.zoomLabel = String(zoomLabel);
  const overlay = node('scopeOverlay');
  if (overlay) overlay.classList.toggle('hidden', !show);
  const root = node('hud');
  if (root) root.classList.toggle('scoped', show);
  setText(node('scopeZoom'), state.zoomLabel || '6×');
  applyCrosshairVisibility();
}

function bindResize() {
  if (resizeBound || typeof window === 'undefined') return;
  resizeBound = true;
  window.addEventListener('resize', () => {
    resizeMinimap(true);
    updateCompass();
    drawMinimap();
  });
}

// 供 Lead/自动化测试使用：window.__hud 已暴露 state；这里再挂一个初始化入口以防脚本加载顺序问题
if (typeof window !== 'undefined') {
  window.__initHud = initHud;
  window.__hudMap = { id: MAP_SAFE.id, meta: MAP_SAFE };
}
