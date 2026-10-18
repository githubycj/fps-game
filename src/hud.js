// ===== 郊区战场 · HUD 模块（写实军事 HUD / 小地图 / 命中反馈 / 开镜遮罩） =====
// 契约：REMAKE_SPEC.md §6.6 / §7。所有方法只操作已存在的 DOM，不依赖 main.js；
// 对缺失元素全部容错（自动化测试可能提前调用）。
import { heightAt, surfaceAt, ZONES, WORLD, ROADS, HOUSES } from '../shared/world.js';

// ---------- 安全的世界数据（shared/world.js 缺失字段时兜底） ----------
const WORLD_SAFE = (WORLD && Number.isFinite(WORLD.size) && Number.isFinite(WORLD.half))
  ? WORLD
  : { size: 140, half: 70, maxPlayers: 8, playerRadius: 0.42, staminaMax: 100, maxHp: 100 };
const ZONES_SAFE = (Array.isArray(ZONES) && ZONES.length)
  ? ZONES
  : [
    { id: 'A', name: '西村', x: -34, z: 6, r: 9 },
    { id: 'B', name: '中央广场', x: 0, z: 0, r: 10 },
    { id: 'C', name: '东站', x: 34, z: 6, r: 9 },
  ];
const ROADS_SAFE = (ROADS && Number.isFinite(ROADS.plazaRadius))
  ? ROADS
  : { mainWidth: 8, crossWidth: 7, plazaRadius: 13 };
const HOUSES_SAFE = Array.isArray(HOUSES) ? HOUSES : [];

// ---------- 小工具 ----------
const $ = (id) => (typeof document === 'undefined' ? null : document.getElementById(id));
const domCache = new Map();
function node(id) {
  if (typeof document === 'undefined') return null;
  const hit = domCache.get(id);
  if (hit && hit.isConnected) return hit;
  const found = document.getElementById(id);
  if (found) domCache.set(id, found);
  return found;
}
function child(id, sel) {
  const p = node(id);
  return p ? p.querySelector(sel) : null;
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
const hexColor = (c) => (typeof c === 'number' ? '#' + c.toString(16).padStart(6, '0') : (c || '#8aa6b8'));
const setText = (n, t) => { if (n && n.textContent !== String(t)) n.textContent = String(t); };
const setStyle = (n, prop, val) => { if (n) n.style[prop] = val; };
const toggleCls = (n, cls, on) => { if (n) n.classList.toggle(cls, !!on); };
const nextFrame = (fn) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn);
  else setTimeout(fn, 16);
};

// 武器显示名（服务器 kind → 中文）
const WEAPON_NAMES = {
  pistol: '手枪', smg: '冲锋枪', ak47: '突击步枪', shotgun: '霰弹枪', sniper: '狙击步枪',
  knife: '匕首', medkit: '急救包', shield: '护盾', speed: '加速',
};
const WEAPON_ORDER_DEFAULT = ['pistol', 'smg', 'ak47', 'shotgun', 'sniper'];
const weaponNameOf = (kind, fallback) => WEAPON_NAMES[kind] || fallback || kind || '';

function isScopeSight(sightType) {
  const s = String(sightType || '').toLowerCase();
  return s === 'scope' || s === 'sniper';
}

function normalizeOwner(owner) {
  const s = String(owner || '').toLowerCase();
  if (s === 'alpha' || s === 'ally' || s === 'a' || s === '玩家' || s === '我方') return 'alpha';
  if (s === 'bravo' || s === 'enemy' || s === 'b' || s === '敌军' || s === '敌方') return 'bravo';
  return null;
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
  shield: 0, shieldMax: 100,
  stamina: 100, staminaMax: 100,
  stance: 'stand',
  weapon: 'pistol', weaponName: '手枪', mag: 0, reserve: 0,
  reloading: false, reloadProgress: null,
  ads: false, sightType: 'iron', scopeActive: false, zoomLabel: '6×',
  crosshairHidden: false, crosshairSize: 22,
  hitmarkerPart: null, hitmarkerKilled: false,
  lastDamageAngle: null,
  scores: { alpha: 0, bravo: 0 }, timer: 0, timeLimit: 0,
  zones: [], uav: { active: false, sec: 0 },
  kills: 0, deaths: 0, ping: 0, streak: 0,
  players: [], selfId: null,
  menuVisible: true, hudVisible: false,
  paused: false, dead: false, matchEnd: false, winner: null,
  warmupVisible: false, matchPhase: 'waiting', countdown: 0,
  god: false, godLeft: 0,
  heading: 0,
  minimap: { x: 0, z: 0, yaw: 0, allies: [], enemies: [], zones: [], uav: false },
};
if (typeof window !== 'undefined') window.__hud = state;

// 定时器（避免重复叠加）
let markTimer = null;
let headMarkTimer = null;
let flashTimer = null;
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
  initCompass();
  initZoneBar();
  initMinimap();
  bindResize();
  syncSettingsUi();

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

  const marks = node('compassMarks');
  if (marks && marks.childElementCount === 0) {
    for (const z of ZONES_SAFE) {
      const m = document.createElement('span');
      m.className = 'compass-zone';
      m.dataset.zone = z.id;
      m.innerHTML = '<b>' + esc(z.id) + '</b>';
      marks.appendChild(m);
    }
  }
}

function updateCompass() {
  const strip = node('compassStrip');
  const compass = node('compass');
  const marks = node('compassMarks');
  const yaw = num(state.minimap.yaw, 0);

  // 世界 -Z 为北；Three.js yaw=0 面朝 -Z，因此罗盘方位角 = -yaw
  let heading = (-yaw * 180 / Math.PI) % 360;
  if (heading < 0) heading += 360;
  state.heading = heading;

  const width = (compass && compass.clientWidth) ? compass.clientWidth : 420;
  if (strip) strip.style.transform = 'translateX(' + (width / 2 - heading * COMPASS_SCALE).toFixed(1) + 'px)';
  setText(node('compassHeading'), pad3(Math.round(heading)));

  if (!marks) return;
  const span = width / 2 - 14;
  const px = num(state.minimap.x, 0);
  const pz = num(state.minimap.z, 0);
  for (const z of runtimeZones()) {
    const m = marks.querySelector('.compass-zone[data-zone="' + z.id + '"]');
    if (!m) continue;
    const bearing = bearingDegTo(px, pz, z.x, z.z);
    let delta = ((bearing - heading + 540) % 360) - 180;
    const x = delta * COMPASS_SCALE;
    const visible = Math.abs(x) <= span;
    m.style.left = (width / 2 + x).toFixed(1) + 'px';
    m.classList.toggle('hidden', !visible);
    m.classList.toggle('fade', visible && Math.abs(x) > span * 0.8);
    m.classList.toggle('own-alpha', z.owner === 'alpha');
    m.classList.toggle('own-bravo', z.owner === 'bravo');
    m.title = z.name + (z.owner === 'alpha' ? ' · 我方控制' : z.owner === 'bravo' ? ' · 敌方控制' : '');
  }
}

function bearingDegTo(px, pz, tx, tz) {
  const dx = tx - px;
  const dz = tz - pz;
  let deg = Math.atan2(dx, -dz) * 180 / Math.PI; // 北 = -Z，东 = +X
  if (deg < 0) deg += 360;
  return deg;
}

// ---------- 据点进度条 ----------
function initZoneBar() {
  const bar = node('zoneBar');
  if (!bar || bar.childElementCount > 0) return;
  for (const z of ZONES_SAFE) {
    const row = document.createElement('div');
    row.className = 'zone-chip';
    row.dataset.zone = z.id;
    row.innerHTML =
      '<span class="z-letter">' + esc(z.id) + '</span>' +
      '<span class="z-name">' + esc(z.name || '') + '</span>' +
      '<div class="z-track"><i></i></div>' +
      '<span class="z-owner">中立</span>';
    bar.appendChild(row);
  }
}

function zoneProgressValue(z) {
  const raw = (z && (z.progress != null ? z.progress : (z.capture != null ? z.capture : z.p)));
  const v = num(raw, 0);
  return clamp01(Math.abs(v) > 1 ? Math.abs(v) / 100 : Math.abs(v));
}

function runtimeZones() {
  const runtime = Array.isArray(state.zones) ? state.zones : [];
  return ZONES_SAFE.map((base, idx) => {
    const rt = runtime.find((z) => z && String(z.id).toUpperCase() === String(base.id).toUpperCase()) || runtime[idx] || {};
    return {
      id: base.id,
      name: rt.name || base.name,
      x: num(rt.x, base.x),
      z: num(rt.z, base.z),
      r: num(rt.r, base.r || 9),
      owner: normalizeOwner(rt.owner != null ? rt.owner : (rt.team != null ? rt.team : rt.controller)),
      progress: zoneProgressValue(rt),
      contested: !!(rt.contested || rt.contest),
    };
  });
}

// ============================================================
// 小地图（一次性烘焙地形底图 + 10Hz 叠加动态标记）
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

// 底图：140×140 采样（与地形网格一致），高度 → 明暗 + 地表类型着色 + 房屋/道路
function bakeMinimap() {
  try {
    const N = 140;
    const c = document.createElement('canvas');
    c.width = N;
    c.height = N;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const half = WORLD_SAFE.half;
    const size = WORLD_SAFE.size;
    const hs = new Float32Array(N * N);
    let hMin = Infinity;
    let hMax = -Infinity;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = -half + ((i + 0.5) / N) * size;
        const z = -half + ((j + 0.5) / N) * size;
        const h = sampleHeight(x, z);
        hs[j * N + i] = h;
        if (h < hMin) hMin = h;
        if (h > hMax) hMax = h;
      }
    }
    const span = Math.max(0.001, hMax - hMin);
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
        const shade = clamp(0.52 + (-dzdx * 0.42 + dzdz * 0.52) * 2.6, 0.34, 1.02);
        const t = clamp01((h - hMin) / span);
        // 低地橄榄 → 高地沙褐
        let r;
        let g;
        let b;
        if (t < 0.55) {
          const k = t / 0.55;
          r = 46 + k * 34;
          g = 54 + k * 32;
          b = 38 + k * 18;
        } else {
          const k = (t - 0.55) / 0.45;
          r = 80 + k * 62;
          g = 86 + k * 46;
          b = 56 + k * 42;
        }
        if (surface === 'road') { r = 118; g = 110; b = 88; }
        else if (surface === 'dirt') { r = 108; g = 98; b = 74; }
        else if (surface === 'rock') { r = 112; g = 108; b = 96; }
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

    // 房屋屋顶（低饱和米灰，方便辨认可进入建筑）
    const toPx = (v) => ((v + half) / size) * N;
    for (const h of HOUSES_SAFE) {
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

    // 广场/道路中央连接处稍稍压亮，强调十字路口
    ctx.strokeStyle = 'rgba(214, 202, 160, 0.16)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.arc(toPx(0), toPx(0), (ROADS_SAFE.plazaRadius / size) * N, 0, Math.PI * 2);
    ctx.stroke();
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

  // 10m 网格
  ctx.strokeStyle = 'rgba(226, 219, 184, 0.07)';
  ctx.lineWidth = 1;
  for (let g = -60; g <= 60; g += 20) {
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

  // 据点圆环 + 占领进度弧
  for (const z of runtimeZones()) {
    const cx = wx(z.x);
    const cy = wz(z.z);
    const r = Math.max(4, (z.r / size) * w);
    const color = z.owner === 'alpha' ? 'rgba(126, 158, 178, 0.95)'
      : z.owner === 'bravo' ? 'rgba(178, 108, 82, 0.95)'
        : 'rgba(206, 196, 158, 0.85)';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = z.owner === 'alpha' ? 'rgba(126, 158, 178, 0.14)'
      : z.owner === 'bravo' ? 'rgba(178, 108, 82, 0.14)'
        : 'rgba(206, 196, 158, 0.06)';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = z.contested ? 2 : 1.2;
    ctx.stroke();
    if (z.progress > 0.001) {
      ctx.beginPath();
      ctx.arc(cx, cy, r + 2.2, -Math.PI / 2, -Math.PI / 2 + z.progress * Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(244, 239, 222, 0.92)';
    ctx.font = '600 ' + Math.max(8, Math.round(w / 24)) + 'px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(z.id, cx, cy + 0.5);
  }

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

  // 队友
  const allies = Array.isArray(state.minimap.allies) ? state.minimap.allies : [];
  for (const a of allies) {
    if (!a) continue;
    const ax = wx(a.x);
    const ay = wz(a.z);
    if (ax < 0 || ax > w || ay < 0 || ay > h) continue;
    ctx.beginPath();
    ctx.arc(ax, ay, 2.6, 0, Math.PI * 2);
    ctx.fillStyle = hexColor(a.color != null ? a.color : 0x8aa6b8);
    ctx.fill();
    ctx.strokeStyle = 'rgba(12, 14, 10, 0.85)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // UAV 敌人（未开 UAV 时完全不显示）
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
      ctx.fillStyle = 'rgba(190, 92, 70, 0.95)';
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
// hud 方法（契约 §6.6）
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
    const res = (reserve === Infinity || reserve === -1 || reserve == null) ? '∞' : String(Math.max(0, Math.round(num(reserve, 0))));
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
        slot.innerHTML = '<span class="k">' + (i + 1) + '</span><span class="n">' + esc(weaponNameOf(id, id)) + '</span>';
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

    const key = isHead ? 'headMarkTimer' : 'markTimer';
    if (key === 'headMarkTimer' && headMarkTimer) clearTimeout(headMarkTimer);
    if (key === 'markTimer' && markTimer) clearTimeout(markTimer);
    const dur = isHead ? (kill ? 560 : 420) : (kill ? 340 : 200);
    const timer = setTimeout(() => { target.classList.remove('show', 'kill'); }, dur);
    if (isHead) headMarkTimer = timer;
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

  // ---------- 比赛信息 ----------
  setScores(scores) {
    const s = scores || {};
    let a = state.scores.alpha;
    let b = state.scores.bravo;
    if (Array.isArray(s)) { a = num(s[0], a); b = num(s[1], b); }
    else { a = num(s.alpha != null ? s.alpha : s[0], a); b = num(s.bravo != null ? s.bravo : s[1], b); }
    state.scores = { alpha: a, bravo: b };
    setText(node('scoreAlpha'), Math.round(a));
    setText(node('scoreBravo'), Math.round(b));
    const alphaSide = node('scoreAlpha');
    if (alphaSide && alphaSide.parentElement) {
      alphaSide.parentElement.classList.toggle('leading', a > b);
      alphaSide.parentElement.classList.toggle('trailing', a < b);
    }
    const bravoSide = node('scoreBravo');
    if (bravoSide && bravoSide.parentElement) {
      bravoSide.parentElement.classList.toggle('leading', b > a);
      bravoSide.parentElement.classList.toggle('trailing', b < a);
    }
    const target = s.target != null ? s.target : (s.scoreTarget != null ? s.scoreTarget : null);
    if (target != null) setText(node('scoreTarget'), '先到 ' + Math.round(num(target, 420)) + ' 分');
  },
  setZones(zonesRuntime) {
    const arr = Array.isArray(zonesRuntime) ? zonesRuntime
      : (zonesRuntime && Array.isArray(zonesRuntime.zones) ? zonesRuntime.zones : null);
    if (!arr) return;
    state.zones = arr;
    refreshZoneBar();
    requestMinimapDraw(true);
    updateCompass();
    updateZoneInside();
  },
  setTimer(sec) {
    const t = Math.max(0, num(sec, state.timer));
    state.timer = t;
    const el = node('timer');
    if (!el) return;
    el.textContent = fmtTime(t);
    el.classList.toggle('urgent', t <= 60);
    el.classList.toggle('critical', t <= 10);
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
    if (selfId != null) state.selfId = selfId;
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
          '<span class="pkd mono"></span>' +
          '<span class="pbar"><i></i></span>';
        row = {
          el,
          dot: el.querySelector('.pdot'),
          team: el.querySelector('.pteam'),
          name: el.querySelector('.pname'),
          ai: el.querySelector('.ai-tag'),
          kd: el.querySelector('.pkd'),
          bar: el.querySelector('.pbar i'),
        };
        rows.set(p.id, row);
        root.appendChild(el);
      }
      const me = (state.selfId != null && p.id === state.selfId) || !!p.me;
      row.el.classList.toggle('me', me);
      const team = normalizeOwner(p.team);
      row.el.classList.toggle('team-alpha', team === 'alpha');
      row.el.classList.toggle('team-bravo', team === 'bravo');
      setText(row.team, team === 'alpha' ? 'A' : team === 'bravo' ? 'B' : '');
      setText(row.name, (p.name == null ? '玩家' : p.name) + (me ? '（我）' : ''));
      setStyle(row.dot, 'background', hexColor(p.color != null ? p.color : 0x8aa6b8));
      setStyle(row.dot, 'color', hexColor(p.color != null ? p.color : 0x8aa6b8));
      row.ai.classList.toggle('hidden', !p.bot);
      const kd = (p.kills != null || p.deaths != null) ? Math.round(num(p.kills, 0)) + '/' + Math.round(num(p.deaths, 0)) : '';
      setText(row.kd, kd);
      const maxHp = num(p.maxHp, WORLD_SAFE.maxHp || 100);
      const hp = clamp(num(p.hp, maxHp), 0, maxHp);
      setStyle(row.bar, 'width', (hp / maxHp * 100).toFixed(1) + '%');
      row.bar.classList.toggle('dead', p.alive === false);
      row.el.classList.toggle('dead', p.alive === false);
      row.el.classList.toggle('enemy', team === 'bravo');
      row.el.classList.toggle('ally', team === 'alpha');
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
  addKillFeed(info) {
    const root = node('killfeed');
    if (!root) return;
    const d = info || {};
    const nameOf = (v) => (v && typeof v === 'object') ? (v.name != null ? v.name : '') : (v == null ? '' : v);
    const killer = nameOf(d.killer);
    const victim = nameOf(d.victim);
    const weaponKind = d.weapon ? String(d.weapon) : '';
    const weapon = WEAPON_NAMES[weaponKind] || weaponKind;
    const entry = document.createElement('div');
    entry.className = 'kill-entry' + (d.headshot ? ' headshot' : '');
    entry.innerHTML =
      '<span class="kf-k">' + esc(killer || '???') + '</span>' +
      '<span class="kf-w">' + esc(weapon || '—') + '</span>' +
      (d.headshot ? '<span class="kf-hs">HS</span>' : '') +
      '<span class="kf-v">' + esc(victim || '???') + '</span>';
    root.prepend(entry);
    while (root.childElementCount > 5) root.removeChild(root.lastElementChild);
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
    setText(node('warmupTitle'), title || '按 空格 开始战斗');
    setText(node('warmupSub'), sub || '点击画面锁定鼠标 · 按空格开始 10 秒倒计时');
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
    setText(node('warmupSub'), '战斗即将开始');
    countEl.classList.remove('hidden');
    setText(countEl, n > 0 ? String(n) : 'GO');
  },
  setMatchPhase(phase, countdown) {
    const p = String(phase || 'waiting');
    if (p === 'waiting') {
      this.showWarmup('按 空格 开始战斗', '点击画面锁定鼠标 · 按空格开始 10 秒倒计时');
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
  showMatchEnd(info) {
    const d = info || {};
    const root = node('matchEnd');
    if (!root) return;
    let scores = d.scores;
    if (!scores || (scores.alpha == null && scores.bravo == null && !Array.isArray(scores))) scores = state.scores;
    let a = state.scores.alpha;
    let b = state.scores.bravo;
    if (Array.isArray(scores)) { a = num(scores[0], a); b = num(scores[1], b); }
    else if (scores) { a = num(scores.alpha, a); b = num(scores.bravo, b); }
    state.scores = { alpha: a, bravo: b };

    const winnerTeam = String(d.winnerTeam || d.winner || '').toLowerCase();
    const myTeam = String(d.myTeam || 'alpha').toLowerCase();
    let result = 'draw';
    if (typeof d.win === 'boolean') {
      if (a === b) result = 'draw';
      else result = d.win ? 'win' : 'lose';
    } else if (winnerTeam === 'alpha' || winnerTeam === 'bravo') {
      result = winnerTeam === myTeam ? 'win' : 'lose';
    } else if (winnerTeam === 'draw' || winnerTeam === 'tie') {
      result = 'draw';
    } else {
      // 兜底：按最终比分与本地队伍判定
      if (a > b) result = myTeam === 'bravo' ? 'lose' : 'win';
      else if (a < b) result = myTeam === 'bravo' ? 'win' : 'lose';
      else result = 'draw';
    }

    const title = node('matchEndTitle');
    if (title) {
      title.textContent = result === 'win' ? '胜 利' : result === 'lose' ? '战 败' : '平 局';
      title.classList.remove('win', 'lose', 'draw');
      title.classList.add(result);
    }
    setText(node('matchEndScores'), 'ALPHA ' + Math.round(a) + '  :  ' + Math.round(b) + ' BRAVO');
    setText(node('matchEndSub'), '据点争夺 · 最终比分');
    root.classList.remove('hidden');
    root.classList.toggle('is-win', result === 'win');
    root.classList.toggle('is-lose', result === 'lose');
    state.matchEnd = true;
    state.winner = result;
  },
  hideMatchEnd() {
    const d = node('matchEnd');
    if (d) d.classList.add('hidden');
    state.matchEnd = false;
  },

  // ---------- 小地图 / 罗盘 ----------
  setMinimapState(mm) {
    const s = mm || {};
    state.minimap.x = num(s.x, state.minimap.x);
    state.minimap.z = num(s.z, state.minimap.z);
    state.minimap.yaw = num(s.yaw, state.minimap.yaw);
    state.minimap.allies = Array.isArray(s.allies) ? s.allies : [];
    state.minimap.enemies = Array.isArray(s.enemies) ? s.enemies : [];
    state.minimap.uav = !!(s.uav != null ? s.uav : state.uav.active);
    if (Array.isArray(s.zones) && s.zones.length) {
      // 小地图/快照里的 zones 是运行时格式（{id,owner,progress,contested}），
      // 位置缺省时由 shared/world.js 的 ZONES 补齐。
      state.zones = s.zones;
      refreshZoneBar();
    }
    updateCompass();
    updateZoneInside();
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

  // ---------- 额外便捷方法（非 §6.6 必需，供 Lead 选用） ----------
  setStreak(n) {
    state.streak = Math.max(0, Math.round(num(n, 0)));
    const b = node('streakBadge');
    if (!b) return;
    b.classList.toggle('hidden', state.streak < 2);
    b.textContent = state.streak + ' 连杀';
    b.classList.toggle('hot', state.streak >= 5);
  },
  setSpeedBoost(active, secLeft) {
    // 兼容旧 #speedBadge（§6.6 未要求，main.js 可选用）
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

// 弹匣容量提示（仅用于低弹量着色，实际数值以服务器为准）
const WEAPON_MAG_HINT = { pistol: 12, smg: 30, ak47: 30, shotgun: 8, sniper: 5 };

function updateScoreLine() {
  setText(node('score'), '击杀 ' + state.kills + ' · 死亡 ' + state.deaths);
}

// 据点进度条 DOM 刷新（不强制重画小地图，可被每帧状态调用）
function refreshZoneBar() {
  const bar = node('zoneBar');
  if (!bar) return;
  for (const z of runtimeZones()) {
    const row = bar.querySelector('.zone-chip[data-zone="' + z.id + '"]');
    if (!row) continue;
    row.classList.remove('owner-alpha', 'owner-bravo', 'contested');
    if (z.owner === 'alpha') row.classList.add('owner-alpha');
    else if (z.owner === 'bravo') row.classList.add('owner-bravo');
    if (z.contested) row.classList.add('contested');
    const fill = row.querySelector('.z-track i');
    setStyle(fill, 'width', (z.progress * 100).toFixed(1) + '%');
    const owner = row.querySelector('.z-owner');
    setText(owner, z.owner === 'alpha' ? '我方' : z.owner === 'bravo' ? '敌方' : '中立');
  }
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

function updateZoneInside() {
  const bar = node('zoneBar');
  if (!bar) return;
  const px = num(state.minimap.x, 0);
  const pz = num(state.minimap.z, 0);
  for (const z of runtimeZones()) {
    const row = bar.querySelector('.zone-chip[data-zone="' + z.id + '"]');
    if (!row) continue;
    const d = Math.hypot(px - z.x, pz - z.z);
    row.classList.toggle('inside', d <= z.r);
  }
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
}
