// ===== 郊区战场 · 客户端主入口 =====
// 职责：渲染循环、输入、第一人称武器/开镜、远程角色插值、特效与音效调度、网络事件、HUD 接线。
// 场景/角色/枪模/音效/特效/HUD 均由独立模块实现，这里只做集成。
import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { WORLD, ZONES, heightAt, raycastWorld, surfaceAt } from '../shared/world.js';
import { WEAPON_ORDER, weaponOf, isScopeWeapon } from '../shared/weapons.js';
import { Net, wsUrl } from './net.js';
import { buildWorld } from './world.js';
import { LocalPlayer, BASE_FOV } from './player.js';
import { ScopeController } from './scope.js';
import { createOptics } from './optics.js';
import { Effects } from './effects.js';
import { initAudio, sfx, setAudioListener, startAmbience, stopAmbience } from './audio.js';
import { createCharacter } from './models/character.js';
import { createWeaponModel } from './models/weapons.js';
import { initHud, hud } from './hud.js';
import { uploadTexturesStep, pendingUploadCount } from './world/textures.js';

// ---------- 设置（localStorage / HUD 设置面板共享） ----------
const SENS_BASE = 0.0022;
const settings = {
  sens: 1,            // 灵敏度倍率（0.2 ~ 3，HUD 滑块）
  quality: 'auto',    // auto | high | medium | low
};
if (typeof window !== 'undefined') window.__settings = settings;

// ---------- HUD 安全包装：缺方法时不至于整帧崩掉 ----------
const HUD_METHODS = [
  'showMenu', 'hideMenu', 'setMenuStatus', 'setMenuVisible',
  'setHp', 'setShield', 'setStamina', 'setStance',
  'setWeapon', 'setReload', 'setWeaponSlots',
  'setCrosshair', 'setAiming', 'setScope', 'setOpticZoom',
  'showHitmarker', 'flashDamage', 'showDamageFrom',
  'setScores', 'setZones', 'setTimer', 'setUav', 'setKills', 'setDeaths', 'setPing', 'setPlayers',
  'addKillFeed', 'addToast', 'setStreak',
  'showDeath', 'hideDeath', 'showPause', 'hidePause',
  'showWarmup', 'hideWarmup', 'setCountdown', 'setMatchPhase', 'setGod',
  'showMatchEnd', 'hideMatchEnd',
  'setMinimapState', 'setVisible', 'setStatus',
];
const H = {};
{
  const src = hud || {};
  for (const m of HUD_METHODS) {
    H[m] = (...args) => {
      try {
        if (typeof src[m] === 'function') return src[m](...args);
      } catch (e) {
        if (!H._warned) { console.warn('[hud] ' + m + ':', e.message); H._warned = true; }
      }
      return undefined;
    };
  }
}

// ---------- 音效安全包装 ----------
const SFX_NAMES = ['shoot', 'dryFire', 'reload', 'reloadStep', 'switchWeapon', 'hit', 'hitConfirm',
  'headshotConfirm', 'kill', 'hurt', 'death', 'jump', 'land', 'footstep', 'slide',
  'pickup', 'heal', 'uiClick', 'capture', 'zoneLost', 'uav', 'win', 'lose', 'whiz', 'respawn'];
const S = {};
for (const n of SFX_NAMES) {
  S[n] = (...args) => { try { if (sfx && typeof sfx[n] === 'function') sfx[n](...args); } catch { /* 音效失败不影响游戏 */ } };
}

// ---------- 软件渲染检测 ----------
function detectSoftwareGL() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return false;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '') : '';
    return /swiftshader|software|llvmpipe|basic render/i.test(name);
  } catch { return false; }
}
const SOFT_GL = detectSoftwareGL();

// ---------- 渲染器 / 场景 ----------
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: !SOFT_GL,
  powerPreference: 'high-performance',
  stencil: false,
});
renderer.setPixelRatio(SOFT_GL ? 0.75 : Math.min(window.devicePixelRatio || 1, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
const world = buildWorld(scene, renderer, { soft: SOFT_GL, quality: settings.quality });
const effects = new Effects(scene, renderer);

const camera = new THREE.PerspectiveCamera(BASE_FOV, innerWidth / innerHeight, 0.06, 520);
camera.rotation.order = 'YXZ';
scene.add(camera);

// 名称标签（CSS2D）层
const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
Object.assign(labelRenderer.domElement.style, {
  position: 'absolute', top: '0', left: '0', pointerEvents: 'none', zIndex: '6',
});
document.body.appendChild(labelRenderer.domElement);

// ---------- 第一人称武器 ----------
const gunModels = {};
// 真实光学瞄具：独立相机把场景渲染到贴图，镜片 shader 显示放大画面 + 畸变 + 分划
const optics = createOptics(renderer, scene);
const scope = new ScopeController(camera);
scope.optics = optics;
for (const id of WEAPON_ORDER) {
  const g = createWeaponModel(id, { firstPerson: true });
  // 第一人称视图模型整体再缩一档，避免枪身占屏过大（模型模块给的是枪械真实比例）
  g.scale.multiplyScalar(0.82);
  g.visible = false;
  camera.add(g);
  gunModels[id] = g;
  scope.register(id, g);
}
scope.setWeapon('pistol');
// 把视图模型调到近裁剪面之外一点（模型模块自己缩放，这里只做避免穿帮的保险）
for (const id of WEAPON_ORDER) gunModels[id].position.z = -0.2;

// ---------- 状态 ----------
const net = new Net();
let myId = null;
let myTeam = 'alpha';
let maxPlayers = WORLD.maxPlayers;
let started = false;
let local = null;
let deathVisible = false;
let shooting = false;
let matchPhase = 'waiting';
let matchCountdown = 0;
let lastCountdownShown = -1;
// GOD 无敌（本地计时，服务器权威判定伤害）
let godUntil = 0;
let godHudTick = 0;
let pingSmoothed = 0;
let elapsed = 0;
let fpsEma = 0;
let qualityLevel = SOFT_GL ? 2 : 0;
let lastQualityCheck = 0;
let statusText = '';
const remotes = new Map();       // id -> remote state
const itemMeshes = new Map();    // id -> { group, type, bob }
const remoteWeaponCache = new Map();
const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
window.addEventListener('unhandledrejection', (e) => errors.push('promise: ' + String(e.reason)));
const originalError = console.error.bind(console);
console.error = (...args) => { errors.push(args.join(' ')); originalError(...args); };

let lastMinimapAt = 0;
let lastStateMsg = null;
let lastHud = { aiming: null, scope: null, stance: null, weapon: null, mag: -1, reserve: -1, zoomLabel: null };

const hex = (c) => '#' + Number(c || 0x888888).toString(16).padStart(6, '0');
const esc = (s) => String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const v3 = (p) => new THREE.Vector3(p.x, p.y, p.z);

// 头顶名牌：
//  · 敌人（含 AI）：只显示名字（+ AI 标记），不显示血量条 —— 血量是战术信息，不该白送
//  · 队友：只显示名字，同样不显示血量条
//  · 自己队伍里的 AI 也不显示血条
function labelHTML(name, color, bot, team, myTeam) {
  const isMate = team && myTeam && team === myTeam;
  return `<span class="dot" style="background:${hex(color)}"></span>` +
    `<span class="nm${isMate ? ' mate' : ''}">${esc(name)}</span>` +
    (bot ? '<span class="ai-tag">AI</span>' : '');
}

// ---------- 远程玩家 ----------
function setRemoteWeapon(r, id) {
  if (r.weaponId === id) return;
  r.weaponId = id;
  // 每个角色独占一份武器模型：共享同一 Group 被多个角色 attach 时会被搬走/克隆，
  // 容易导致枪口位置错乱、武器方向异常
  let model = createWeaponModel(id, { simple: true });
  r.char.attachWeapon(model);
}

function createRemote(p) {
  const char = createCharacter({ color: p.color, team: p.team || 'bravo' });
  const group = char.root;
  group.position.set(p.x, p.y ?? heightAt(p.x, p.z), p.z);
  group.rotation.y = p.yaw || 0;

  const label = document.createElement('div');
  label.className = 'name-tag';
  label.innerHTML = labelHTML(p.name, p.color, p.bot, p.team, myTeam);
  const labelObj = new CSS2DObject(label);
  labelObj.position.set(0, 2.02, 0);
  group.add(labelObj);

  scene.add(group);
  const state = {
    id: p.id,
    char, group, label, labelObj,
    name: p.name,
    team: p.team || 'bravo',
    bot: !!p.bot,
    weaponId: null,
    target: {
      x: p.x, y: p.y ?? heightAt(p.x, p.z), z: p.z,
      yaw: p.yaw || 0, pitch: p.pitch || 0,
      hp: p.hp, alive: p.alive !== false,
      grounded: p.grounded !== false, aiming: !!p.aiming,
      stance: p.stance || 'stand', sprint: !!p.sprint,
      firingUntil: 0, reloadUntil: 0, hitAt: 0,
    },
    speed: 0,
    glint: null,
    lastHp: p.hp,
    lastLabelHp: p.hp,
  };
  setRemoteWeapon(state, p.weapon || 'pistol');
  remotes.set(p.id, state);
  return state;
}

function removeRemote(id) {
  const r = remotes.get(id);
  if (!r) return;
  scene.remove(r.group);
  try { r.char.dispose && r.char.dispose(); } catch { /* ignore */ }
  remotes.delete(id);
}

const _glintTexture = (() => {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,240,200,0.9)');
    g.addColorStop(0.6, 'rgba(255,200,120,0.25)');
    g.addColorStop(1, 'rgba(255,180,80,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  } catch { return null; }
})();

function ensureGlint(r) {
  if (r.glint || !_glintTexture) return;
  const mat = new THREE.SpriteMaterial({ map: _glintTexture, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  r.glint = new THREE.Sprite(mat);
  r.glint.scale.setScalar(0.5);
  r.glint.position.set(0, 1.72, -0.18);
  r.group.add(r.glint);
}

function updateRemotes(dt) {
  for (const r of remotes.values()) {
    const t = r.target;
    const k = 1 - Math.exp(-12 * dt);
    const px = r.group.position.x, pz = r.group.position.z;
    r.group.position.x += (t.x - r.group.position.x) * k;
    r.group.position.y += (t.y - r.group.position.y) * k;
    r.group.position.z += (t.z - r.group.position.z) * k;
    const da = Math.atan2(Math.sin(t.yaw - r.group.rotation.y), Math.cos(t.yaw - r.group.rotation.y));
    r.group.rotation.y += da * k;

    const inst = Math.hypot(r.group.position.x - px, r.group.position.z - pz) / Math.max(dt, 1e-4);
    r.speed = r.speed * 0.75 + inst * 0.25;

    const nowMs = performance.now();
    const firing = nowMs < t.firingUntil;
    const w = weaponOf(r.weaponId);
    r.char.update({
      speed: r.speed,
      grounded: t.grounded,
      alive: t.alive,
      aiming: t.aiming,
      pitch: t.pitch,
      stance: t.stance,
      sprint: t.sprint,
      firing,
      reloading: nowMs < t.reloadUntil,
      hitAt: t.hitAt || 0,
    }, dt);

    // 名牌：近距离显示；血量条已移除（不给敌人/队友暴露血量信息）
    if (r.labelObj) {
      const dx = r.group.position.x - camera.position.x;
      const dz = r.group.position.z - camera.position.z;
      const d2 = dx * dx + dz * dz;
      r.labelObj.visible = t.alive && d2 < 30 * 30;
    }

    // 狙击镜反光：开镜的狙击手会有镜片闪光（真实感 + 反制信息）
    const scoped = t.alive && t.aiming && w.sightType === 'scope';
    if (scoped) { ensureGlint(r); if (r.glint) r.glint.visible = true; }
    else if (r.glint) r.glint.visible = false;
  }
}

// ---------- 地面道具 ----------
function syncItems(list) {
  const seen = new Set();
  for (const it of list || []) {
    seen.add(it.id);
    if (itemMeshes.has(it.id)) continue;
    let group;
    try {
      group = world.createItemMesh ? world.createItemMesh(it.type) : null;
    } catch { group = null; }
    if (!group) continue;
    const gy = heightAt(it.x, it.z);
    group.position.set(it.x, gy, it.z);
    scene.add(group);
    itemMeshes.set(it.id, { group, type: it.type, bob: Math.random() * Math.PI * 2, baseY: gy });
  }
  for (const id of [...itemMeshes.keys()]) {
    if (!seen.has(id)) {
      const s = itemMeshes.get(id);
      scene.remove(s.group);
      itemMeshes.delete(id);
    }
  }
}

// ---------- 开火视觉：枪口焰 / 弹壳 / 弹着（无曳光弹） ----------
const _muzzle = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _remoteMuzzle = new THREE.Vector3();
const _bloodPos = new THREE.Vector3();
const _toCam = new THREE.Vector3();

function fireVisual(result) {
  const gun = scope.active || gunModels[local.weapon];
  if (!gun) return;
  const w = weaponOf(local.weapon);
  if (gun.userData.muzzle) _muzzle.copy(gun.userData.muzzle); else _muzzle.set(0, 0.03, -0.8);
  gun.localToWorld(_muzzle);
  camera.getWorldDirection(_dir);
  _right.set(1, 0, 0).applyQuaternion(camera.quaternion);

  // 音效：第一人称近距离（含空间感由 audio 模块处理）
  S.shoot(local.weapon, { distance: 0, pan: 0 });
  try { effects.muzzleFlash(_muzzle, _dir, local.weapon); } catch { /* ignore */ }
  try { effects.shellEject(_muzzle, _right, local.weapon); } catch { /* ignore */ }

  // 客户端的视觉弹着预测（服务器权威命中另发 hit 消息）
  camera.getWorldPosition(_origin);
  _origin.y -= 0.06;
    // 客户端视觉弹着预测（服务器权威命中另发 hit 消息）；开镜时与实际弹道一致（几乎一个点）
    const spread = local.adsAmount > 0.6 ? Math.min(result ? result.spread : 0, 0.004) : (result ? result.spread : local.currentSpreadRad());
  const pellets = Math.max(1, Math.min(w.pellets || 1, 6));
  for (let i = 0; i < pellets; i++) {
    const d = _dir.clone();
    if (spread > 0) {
      const a = Math.random() * Math.PI * 2;
      const rad = spread * (pellets > 1 ? 0.8 : 1) * Math.sqrt(Math.random());
      d.x += Math.cos(a) * rad;
      d.y += Math.sin(a) * rad;
      d.z += (Math.random() - 0.5) * rad * 0.25;
      d.normalize();
    }
    const hit = raycastWorld(_origin.x, _origin.y, _origin.z, d.x, d.y, d.z, w.range);
    if (hit) {
      try { effects.impact(v3(hit.point), v3(hit.normal), hit.surface, local.weapon); } catch { /* ignore */ }
    }
  }
}

// ---------- 玩家列表 / HUD 同步 ----------
function playerListForHud(players) {
  return (players || []).map((p) => ({
    id: p.id, name: p.name, color: p.color, team: p.team,
    hp: p.hp, alive: p.alive, bot: !!p.bot, kills: p.kills, deaths: p.deaths,
    me: p.id === myId,
  }));
}

function updateLocalHud(me) {
  if (!me || !local) return;
  if (typeof me.hp === 'number') H.setHp(Math.max(0, Math.round(me.hp)), WORLD.maxHp);
  if (typeof me.shield === 'number') H.setShield(me.shield, 100);
  // GOD 状态以服务器快照为准（god = 剩余毫秒）
  if (typeof me.god === 'number') {
    const left = Math.ceil(me.god / 1000);
    if (left > 0) { godUntil = Date.now() + me.god; H.setGod(true, left); }
    else if (godUntil) { godUntil = 0; H.setGod(false, 0); }
  }
  if (typeof me.kills === 'number') H.setKills(me.kills);
  if (typeof me.deaths === 'number') H.setDeaths(me.deaths);
  H.setStance(local.stance);
  H.setStamina(local.stamina, WORLD.staminaMax);
  const w = weaponOf(local.weapon);
  const a = local.ammoOf();
  if (lastHud.weapon !== local.weapon || lastHud.mag !== a.mag || lastHud.reserve !== a.reserve) {
    H.setWeapon(local.weapon, w.name, a.mag, a.reserve === Infinity ? -1 : a.reserve);
    lastHud.weapon = local.weapon;
    lastHud.mag = a.mag;
    lastHud.reserve = a.reserve;
  }
  H.setWeaponSlots(local.owned, local.weapon, WEAPON_ORDER);
}

function zonesForHud(list) {
  return (list || []).map((z) => {
    let progress = z.progress;
    if (progress === undefined || progress === null) progress = Math.max(z.progressAlpha || 0, z.progressBravo || 0);
    // 兼容 0~100 与 0~1 两种进度表示
    if (progress > 1) progress = progress / 100;
    return {
      id: z.id,
      name: z.name || z.id,
      x: z.x, z: z.z, r: z.r,
      owner: z.owner || null,
      progress: Math.max(0, Math.min(1, progress || 0)),
      progressAlpha: z.progressAlpha !== undefined ? (z.progressAlpha > 1 ? z.progressAlpha / 100 : z.progressAlpha) : undefined,
      progressBravo: z.progressBravo !== undefined ? (z.progressBravo > 1 ? z.progressBravo / 100 : z.progressBravo) : undefined,
      contested: !!z.contested,
      capTeam: z.capTeam || null,
    };
  });
}

function minimapFromState(players, zones, uav) {
  if (!local) return;
  const nowMs = Date.now();
  const myUav = uav && uav[myTeam] && uav[myTeam] > nowMs;
  const allies = [];
  const enemies = [];
  for (const p of players || []) {
    if (p.id === myId || !p.alive) continue;
    if (p.team === myTeam) allies.push({ x: p.x, z: p.z, color: p.color, name: p.name });
    else enemies.push({ x: p.x, z: p.z, color: p.color, name: p.name });
  }
  H.setMinimapState({
    x: local.pos.x, z: local.pos.z, yaw: local.yaw,
    allies, enemies, zones,
    uav: !!myUav,
    myTeam,
  });
}

// ---------- 菜单 / 连接 ----------
const menuEl = document.getElementById('menu');
const nickEl = document.getElementById('nick');
const joinBtn = document.getElementById('joinBtn');
const connStatus = document.getElementById('connStatus');

function setConnStatus(text, kind = '') {
  if (connStatus) {
    connStatus.textContent = text;
    connStatus.className = 'status' + (kind ? ' ' + kind : '');
  }
  H.setMenuStatus(text, kind);
}

function showPause(text) { H.showPause(text); }
function hidePause() { H.hidePause(); }
function requestLock() {
  if (document.pointerLockElement !== canvas) canvas.requestPointerLock && canvas.requestPointerLock();
}

// 画质 / 灵敏度由 HUD 设置面板统一管理；这里只同步到渲染与玩家
function syncSettingsFromHud() {
  try {
    if (hud && typeof hud.getSettings === 'function') {
      const hs = hud.getSettings() || {};
      if (typeof hs.sens === 'number' && hs.sens > 0) settings.sens = hs.sens;
      if (hs.quality) settings.quality = hs.quality;
    }
  } catch { /* ignore */ }
  if (typeof window !== 'undefined') window.__settings = settings;
  if (world.setQuality) world.setQuality(settings.quality);
  if (effects.setQuality) {
    effects.setQuality(settings.quality === 'auto' ? (SOFT_GL ? 'low' : 'high') : settings.quality);
  }
  if (local) local.sens = SENS_BASE * settings.sens;
}
window.addEventListener('sf:settings', (e) => {
  const d = (e && e.detail) || {};
  if (typeof d.sens === 'number' && d.sens > 0) {
    settings.sens = d.sens;
    if (local) local.sens = SENS_BASE * d.sens;
  }
  if (d.quality && d.quality !== settings.quality) {
    settings.quality = d.quality;
    if (world.setQuality) world.setQuality(d.quality);
    if (effects.setQuality) effects.setQuality(d.quality === 'auto' ? (SOFT_GL ? 'low' : 'high') : d.quality);
  }
});

joinBtn && joinBtn.addEventListener('click', async () => {
  initAudio();
  const name = (nickEl && nickEl.value.trim()) || '玩家';
  setConnStatus('连接中…');
  if (joinBtn) joinBtn.disabled = true;
  try {
    await net.connect(wsUrl());
    net.send({ t: 'join', name });
    setConnStatus('已连接，等待服务器确认…');
  } catch (e) {
    setConnStatus('连接失败：' + e.message, 'err');
    if (joinBtn) joinBtn.disabled = false;
  }
});
nickEl && nickEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn && joinBtn.click(); });
nickEl && nickEl.focus();

setInterval(() => net.send({ t: 'ping', time: performance.now() }), 1000);
setInterval(() => { if (started && local) local.sendInput(); }, 33);

// ---------- 输入 ----------
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  if (local) local.locked = locked;
  if (locked) hidePause();
  else if (started && local && local.alive && !deathVisible && matchPhase === 'playing') {
    shooting = false;
    if (local) local.aiming = false;
    showPause('已暂停 · 点击画面继续');
  }
});

document.addEventListener('mousemove', (e) => {
  if (local && local.locked) local.onMouseMove(e.movementX || 0, e.movementY || 0);
});

document.addEventListener('contextmenu', (e) => e.preventDefault());
// 屏蔽浏览器（Edge/Chrome）的额外默认行为：中键自动滚动、拖拽、双击选中、Ctrl+滚轮缩放
document.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
document.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
document.addEventListener('dragstart', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('selectstart', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') e.preventDefault();
});
window.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
document.addEventListener('mousedown', (e) => {
  if (!started || !local) return;
  initAudio();
  if (matchPhase !== 'playing') return;
  if (e.button === 0 && local.locked && local.alive) shooting = true;
  if (e.button === 2 && local.locked && local.alive) local.aiming = true;
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 0) { shooting = false; if (local) local.onTriggerUp(); }
  if (e.button === 2 && local) local.aiming = false;
});

window.addEventListener('wheel', (e) => {
  if (!started || !local || !local.locked || !local.alive) return;
  // 两套互不冲突的逻辑：
  //  · 按住右键（开镜）时，滚轮 = 调整当前光学镜的放大倍率（狙击 3~10×）
  //  · 未开镜时，滚轮 = 切换武器（原逻辑）
  // 判定优先级：只要 ADS 处于激活（aiming 或 adsAmount > 0.35）就走变倍，
  // 因此开镜状态下不会误切枪；松开右键后滚轮立刻恢复切枪。
  const aiming = local.aiming || local.adsAmount > 0.35;
  if (aiming) {
    const dir = e.deltaY > 0 ? -1 : 1;      // 上滚 = 放大
    const next = scope.adjustZoom ? scope.adjustZoom(dir) : null;
    if (next != null) {
      e.preventDefault();
      const label = next + '×';
      H.setOpticZoom(label);
      lastHud.zoomLabel = label;
      // 变倍环转动的机械声（复用切枪音效，音高略有区别）
      if (S.switchWeapon) S.switchWeapon();
      H.addToast('放大倍率 ' + label);
    }
    return;
  }
  if (local.cycleWeapon(e.deltaY > 0 ? 1 : -1)) onWeaponChanged();
}, { passive: false });

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    // 开局等待阶段：空格 = 开始 3 秒倒计时
    if (started && matchPhase === 'waiting') {
      net.send({ t: 'ready' });
      H.setMatchPhase('countdown', 3);
      return;
    }
    // 未开赛不跳跃
    if (matchPhase !== 'playing') { if (local) local.jumpHeld = false; return; }
    if (local && local.locked && local.alive && local.grounded) S.jump();
    if (local) local.jumpHeld = true;
  }
  if (local && started && !e.repeat && local.locked && local.alive && e.code === 'KeyR') {
    if (local.requestReload()) { S.reload(local.weapon); H.setReload(0.001); }
  }
  if (local) local.keys.add(e.code);
});

// ---------- 快捷键屏蔽 ----------
// 只保留游戏必需的按键：WASD、Shift(冲刺)、C/Ctrl(蹲)、空格、R(换弹)、Mouse 左右键；
// 其余（数字键切枪、Q、B、Tab、F1、Esc 等浏览器/游戏快捷键）一律拦截，避免误触影响操作。
// 玩家仍可通过鼠标滚轮切换已持有的武器。
const ALLOWED_CODES = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'ShiftLeft', 'ShiftRight',
  'KeyC', 'Space', 'KeyR',
  // 后台命令控制台呼出键
  'Backquote', 'Enter', 'NumpadEnter', 'Escape',
]);
function blockShortcuts(e) {
  // 菜单输入框内不拦截（昵称输入）
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
  const code = e.code || '';
  // 1) Ctrl / Alt / Win(Cmd) 组合键一律屏蔽：Ctrl+S 保存、Ctrl+D 收藏、Ctrl+Shift+B 收藏夹栏、
  //    Ctrl+H 历史、Ctrl+J 下载、Ctrl+P 打印、Ctrl+U 源码、Ctrl+W 关标签、Alt+←/→ 前进后退等 Edge 快捷键。
  //    只 preventDefault，不 stopPropagation —— 否则会打断游戏自己的按键监听（Ctrl 蹲下）。
  if (e.ctrlKey || e.metaKey || e.altKey) {
    e.preventDefault();
    return;
  }
  // 2) 白名单以外的单键一律拦截（F1~F12、Tab、F5、编辑键等）
  if (ALLOWED_CODES.has(code)) return;
  e.preventDefault();
}

// ---------- 后台命令控制台（/add 1 ai 等）----------
const CMD_HISTORY_MAX = 20;
const cmdHistory = [];
let cmdBusy = false;
function cmdAppend(text, cls) {
  const log = document.getElementById('cmdLog');
  if (!log) return;
  const div = document.createElement('div');
  div.className = cls || '';
  div.textContent = text;
  log.appendChild(div);
  while (log.childElementCount > 40) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}
function isCmdOpen() {
  const box = document.getElementById('cmdBox');
  return !!box && !box.classList.contains('hidden');
}
function openCmd(prefill) {
  const box = document.getElementById('cmdBox');
  const input = document.getElementById('cmdInput');
  if (!box || !input) return;
  // 防抖：短时间内重复呼出会反复释放指针锁，表现为"游戏失去控制"
  const now = performance.now();
  if (now - (openCmd._last || 0) < 250) return;
  openCmd._last = now;
  box.classList.remove('hidden');
  if (typeof prefill === 'string') input.value = prefill;
  // 打开控制台时释放指针锁，否则无法输入
  if (document.pointerLockElement) document.exitPointerLock();
  if (local) { local.locked = false; local.keys.clear(); local.aiming = false; local.jumpHeld = false; }
  shooting = false;
  // 必须立即聚焦（若延后到 setTimeout，浏览器会把焦点移到 body）
  try { input.focus(); } catch { /* ignore */ }
  try { input.select(); } catch { /* ignore */ }
}
function closeCmd() {
  const box = document.getElementById('cmdBox');
  const input = document.getElementById('cmdInput');
  if (box) box.classList.add('hidden');
  if (input) { input.value = ''; input.blur(); }
  try { requestLock(); } catch { /* ignore */ }
}
// 解析 "/add 1 ai" / "add clear ai" / "/add -1 ai"
function parseCommand(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const parts = raw.replace(/^\//, '').split(/\s+/).filter(Boolean);
  const cmd = (parts.shift() || '').toLowerCase();
  // 支持 "/add" 单独输入后按提示再补参数，这里只做简单补全
  if (cmd === 'add' || cmd === 'bots' || cmd === 'help' || cmd === '/add') {
    return { cmd: cmd.replace(/^\//, ''), args: parts };
  }
  return { cmd, args: parts };
}
function runCommand(text) {
  const parsed = parseCommand(text);
  if (!parsed) return;
  const { cmd, args } = parsed;
  if (cmd === 'help' || cmd === '?' || cmd === '') {
    cmdAppend('可用命令：', 'ok');
    cmdAppend('/god [秒]        本人全武器 +300 发弹药 + 无敌（默认 120s）');
    cmdAppend('/dark            切换黑夜');
    cmdAppend('/light           切换白天');
    cmdAppend('/add 1 ai        增加 1 个 AI');
    cmdAppend('/add 3 ai        增加 3 个 AI');
    cmdAppend('/add -1 ai       减少 1 个 AI');
    cmdAppend('/add clear ai    清空所有 AI');
    cmdAppend('/add 1 ai alpha  友军 AI（默认 bravo 敌军）');
    cmdAppend('/bots            查看当前 AI 数量');
    cmdAppend('/env             查看当前昼夜');
    return;
  }
  if (cmd === 'add' || cmd === 'bots' || cmd === 'god' || cmd === 'dark' || cmd === 'light' || cmd === 'env') {
    if (cmd === 'add') {
      const count = args[0];
      const kind = args[1] || 'ai';
      if (count == null) { cmdAppend('用法：/add 1 ai  ·  /add -1 ai  ·  /add clear ai', 'err'); return; }
      cmdAppend('> /' + text.replace(/^\//, ''));
      net.send({ t: 'command', text: 'add ' + count + ' ' + kind + (args[2] ? ' ' + args[2] : '') });
    } else if (cmd === 'god') {
      cmdAppend('> /' + text.replace(/^\//, ''));
      net.send({ t: 'command', text: 'god' + (args[0] ? ' ' + args[0] : '') });
    } else {
      net.send({ t: 'command', text: cmd });
    }
    return;
  }
  cmdAppend('未知命令 /' + cmd + '，输入 help 查看用法', 'err');
}
{
  const input = document.getElementById('cmdInput');
  if (input) {
    input.addEventListener('keydown', (e) => {
      // 输入框内不触发游戏按键
      e.stopPropagation();
      if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) { closeCmd(); return; }
        if (cmdHistory[cmdHistory.length - 1] !== text) cmdHistory.push(text);
        while (cmdHistory.length > CMD_HISTORY_MAX) cmdHistory.shift();
        input.value = '';
        runCommand(text);
        return;
      }
      if (e.code === 'Escape' || e.code === 'Backquote') {
        e.preventDefault();
        closeCmd();
        return;
      }
      // ↑/↓ 历史命令
      if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
        e.preventDefault();
        if (!cmdHistory.length) return;
        const idx = Number(input.dataset.histIdx ?? cmdHistory.length);
        const next = e.code === 'ArrowUp'
          ? Math.max(0, idx - 1)
          : Math.min(cmdHistory.length, idx + 1);
        input.dataset.histIdx = String(next);
        input.value = next >= cmdHistory.length ? '' : cmdHistory[next];
        return;
      }
    });
  }
}
// 点击控制台外部关闭
document.addEventListener('mousedown', (e) => {
  if (!isCmdOpen()) return;
  const box = document.getElementById('cmdBox');
  if (box && !box.contains(e.target)) { closeCmd(); }
});

window.addEventListener('keydown', blockShortcuts, { capture: true });
window.addEventListener('keyup', blockShortcuts, { capture: true });
window.addEventListener('keypress', blockShortcuts, { capture: true });
// Backquote（~）呼出后台命令控制台；游戏中按 Enter 也可呼出
window.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;      // 输入框内交给输入框处理
  // 按住 Ctrl/Alt/Win 时绝不打开控制台：
  // 否则玩家蹲下（Ctrl）时误触按键会弹出控制台 → 释放鼠标锁 + 暂停，表现得像"闪退"。
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.repeat) return;
  if (e.code === 'Backquote' || (e.code === 'Enter' && !isCmdOpen())) {
    e.preventDefault();
    e.stopPropagation();
    openCmd('');
  }
}, { capture: true });
// Esc 会退出指针锁：拦截并锁定（游戏内不需要 Esc）
window.addEventListener('keydown', (e) => {
  if (isCmdOpen()) return;
  if (e.code === 'Escape') { e.preventDefault(); try { requestLock(); } catch { /* ignore */ } }
}, { capture: true });
// 修饰键松开时清理按键状态（蹲下已改为只用 C 键，这里主要防止 Shift 等卡住）
function releaseModifiers() {
  if (!local) return;
  for (const code of ['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
    'ShiftLeft', 'ShiftRight']) {
    local.keys.delete(code);
  }
}
window.addEventListener('keyup', (e) => {
  if (e.code === 'ControlLeft' || e.code === 'ControlRight' ||
      e.code === 'AltLeft' || e.code === 'AltRight' || e.code === 'MetaLeft' || e.code === 'MetaRight') {
    releaseModifiers();
  }
}, { capture: true });
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && local) local.jumpHeld = false;
  if (local) local.keys.delete(e.code);
  // 兜底：焦点切换后浏览器可能漏发 keyup，这里按键盘事件补齐修饰键状态
  if (e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta' || e.code === '') releaseModifiers();
});
window.addEventListener('blur', () => {
  if (local) { local.keys.clear(); local.jumpHeld = false; local.aiming = false; }
  shooting = false;
});

// 暂停点击恢复
const pauseEl = document.getElementById('pause');
pauseEl && pauseEl.addEventListener('click', () => {
  if (!local || !local.alive || deathVisible) return;
  shooting = false;
  requestLock();
});
// 死亡遮罩点击（若浏览器已释放指针锁，也允许点一下重新锁定）
const deathEl = document.getElementById('death');
deathEl && deathEl.addEventListener('click', () => {
  if (!local || !local.alive || document.pointerLockElement) return;
  requestLock();
});
// 开局准备遮罩：点击画面锁定鼠标（空格开始由键盘处理）
const warmupEl = document.getElementById('warmup');
warmupEl && warmupEl.addEventListener('click', () => {
  if (!document.pointerLockElement) requestLock();
});

function onWeaponChanged() {
  if (!local) return;
  scope.setWeapon(local.weapon);
  const w = weaponOf(local.weapon);
  H.setWeapon(local.weapon, w.name, local.ammoOf().mag, local.ammoOf().reserve === Infinity ? -1 : local.ammoOf().reserve);
  H.setWeaponSlots(local.owned, local.weapon, WEAPON_ORDER);
  lastHud.weapon = local.weapon;
}

// ---------- 开局准备 / 倒计时状态 ----------
function applyMatchInfo(match) {
  if (!match || !match.phase) return;
  const prev = matchPhase;
  matchPhase = match.phase;
  matchCountdown = Math.max(0, Math.ceil(match.countdown || 0));
  H.setMatchPhase(matchPhase, matchCountdown);
  if (matchPhase === 'waiting') {
    H.hidePause();
    H.hideMatchEnd();
    shooting = false;
  } else if (matchPhase === 'countdown') {
    H.hidePause();
    H.hideMatchEnd();
    if (matchCountdown !== lastCountdownShown) {
      lastCountdownShown = matchCountdown;
      if (matchCountdown > 0) S.uiClick();
    }
  } else if (matchPhase === 'playing') {
    H.hideWarmup();
    if (prev !== 'playing') {
      H.hideMatchEnd();
      H.addToast('战斗开始');
      if (local && local.alive && !deathVisible && !document.pointerLockElement) {
        showPause('点击画面继续战斗');
      }
    }
  } else if (matchPhase === 'ended') {
    H.hideWarmup();
  }
}

// ---------- 网络事件 ----------
net.on('welcome', (m) => {
  myId = m.id;
  myTeam = m.team || 'alpha';
  maxPlayers = m.maxPlayers || WORLD.maxPlayers;
  local = new LocalPlayer(camera, net);
  local.sens = SENS_BASE * settings.sens;
  local.team = myTeam;
  local.onFootstep = (surface, speed, sprint) => S.footstep(surface, sprint ? 'sprint' : speed > 4 ? 'run' : 'walk');
  local.reset(m.spawn || { x: 0, z: 52 }, myTeam);
  started = true;
  menuEl && menuEl.classList.add('hidden');
  H.hideMenu();
  H.setVisible(true);
  deathVisible = false;
  H.hideDeath();

  const players = m.players || [];
  syncPlayerList(players);
  for (const p of players) if (p.id !== myId) createRemote(p);
  const me = players.find((p) => p.id === myId);
  if (me) updateLocalHud(me);
  H.setWeaponSlots(local.owned, local.weapon, WEAPON_ORDER);
  H.setScores({ alpha: 0, bravo: 0 });
  H.setZones(zonesForHud(m.zones || []));
  H.setTimer(m.match && m.match.timeLeft);
  syncItems(m.items || []);
  applyMatchInfo(m.match);
  // 同步全局昼夜（后加入的玩家也能看到当前是白天/黑夜）
  if (m.env && m.env.mode) {
    try { world.setEnv(m.env.mode === 'dark' ? 'dark' : 'day', true); } catch (err) { errors.push('env: ' + err.message); }
  }
  // 等待阶段用"按空格开始"覆盖层；已有指针锁/进行中才显示暂停提示
  if (m.match && m.match.phase !== 'waiting' && m.match.phase !== 'countdown' && !deathVisible) {
    showPause('点击画面进入战斗');
  } else {
    H.hidePause();
  }
  startAmbience && startAmbience();
});

net.on('player_joined', (m) => {
  if (!started || !m.player) return;
  if (m.player.id === myId) return;
  createRemote(m.player);
  H.addToast(`${m.player.name} 加入战场`);
  syncPlayerList([...(remotesListForHud()), m.player]);
});

net.on('player_left', (m) => {
  removeRemote(m.id);
  H.addToast('有玩家离开了战场');
});

// 后台命令结果
net.on('command_result', (m) => {
  const msg = (m && m.msg) || '';
  cmdAppend(msg, m && m.ok ? 'ok' : 'err');
  H.addToast(msg);
});

// GOD 无敌开启（本地事件）
net.on('god', (m) => {
  godUntil = Date.now() + (m.seconds || 120) * 1000;
  H.addToast('GOD 模式：无敌 ' + (m.seconds || 120) + ' 秒 · 全武器 +' + (m.extraAmmo || 300) + ' 发');
  H.setGod(true, m.seconds || 120);
  // 立刻刷新武器槽（服务器已把全部武器发给本人）
  try { if (local) H.setWeaponSlots(local.owned, local.weapon, WEAPON_ORDER); } catch { /* ignore */ }
});
// GOD 挡下伤害时的轻微白闪（区别于正常受击红闪）
function flashDamageLight() {
  const el = document.getElementById('hitFlash') || document.getElementById('flash');
  if (!el) return;
  el.classList.remove('god-flash');
  void el.offsetWidth;
  el.classList.add('god-flash');
  setTimeout(() => el.classList.remove('god-flash'), 420);
}

// GOD 挡下伤害（自己或看到别人挡下）
net.on('god_block', (m) => {
  if (m.self) {
    H.addToast('无敌生效：伤害已免疫');
    flashDamageLight();
  } else {
    H.addToast((m.targetName || '目标') + ' 处于无敌状态');
  }
});

// 昼夜切换（服务器广播，所有客户端同步）
net.on('env', (m) => {
  const mode = m && m.mode === 'dark' ? 'dark' : 'day';
  try { world.setEnv(mode); } catch (err) { errors.push('env: ' + err.message); }
  H.addToast(mode === 'dark' ? '天黑了：枪口焰会照亮周围' : '天亮了');
});

// 昼夜 → 特效层（夜间枪口焰更亮 + 脚下补光），由 world.setEnv 统一回调
try {
  world.onEnvChange((mode) => {
    try { effects.setNightMode(mode === 'dark'); } catch { /* ignore */ }
  });
} catch { /* ignore */ }

function remotesListForHud() {
  return [...remotes.values()].map((r) => ({
    id: r.id, name: r.name, team: r.team, hp: r.target.hp, alive: r.target.alive, bot: r.bot,
  }));
}

function syncPlayerList(players) {
  H.setPlayers(playerListForHud(players), myId);
}

net.on('state', (m) => {
  if (!started || !local) return;
  lastStateMsg = m;
  const me = (m.players || []).find((p) => p.id === myId);
  if (me) {
    const wasAlive = local.alive;
    const prevWeapon = local.weapon;
    local.setServerState(me);
    if (local.weapon !== prevWeapon) onWeaponChanged();
    updateLocalHud(me);
    if (me.alive && !wasAlive) {
      deathVisible = false;
      H.hideDeath();
      S.respawn();
      // 死亡期间指针锁可能被系统释放：重生后提示点击继续，避免"鼠标无法控制"
      if (!document.pointerLockElement) {
        if (local) local.locked = false;
        showPause('点击画面继续战斗');
      }
    }
  }
  // 远程玩家同步
  const seen = new Set();
  for (const p of m.players || []) {
    if (p.id === myId) continue;
    seen.add(p.id);
    let r = remotes.get(p.id);
    if (!r) r = createRemote(p);
    const t = r.target;
    t.x = p.x; t.y = p.y ?? heightAt(p.x, p.z); t.z = p.z;
    t.yaw = p.yaw || 0;
    t.pitch = p.pitch || 0;
    t.hp = p.hp;
    t.alive = p.alive !== false;
    t.grounded = p.grounded !== false;
    t.aiming = !!p.aiming;
    t.stance = p.stance || 'stand';
    t.sprint = !!p.sprint;
    if (p.reloading || (p.reloadUntil && p.reloadUntil > Date.now())) t.reloadUntil = performance.now() + 400;
    const wid = p.weapon || 'pistol';
    if (r.weaponId !== wid) setRemoteWeapon(r, wid);
  }
  for (const id of [...remotes.keys()]) if (!seen.has(id)) removeRemote(id);
  syncPlayerList(m.players || []);
  syncItems(m.items || []);

  // 模式 / 据点 / 比分 / UAV
  H.setScores(m.scores || { alpha: 0, bravo: 0 });
  H.setZones(zonesForHud(m.zones || []));
  if (m.match) {
    H.setTimer(m.match.timeLeft);
    applyMatchInfo(m.match);
  }
  if (m.uav) {
    const myUavUntil = m.uav[myTeam] || 0;
    const left = Math.max(0, (myUavUntil - Date.now()) / 1000);
    H.setUav(left > 0, left);
  }
  if (m.killstreak) H.setStreak(m.killstreak);
  if (performance.now() - lastMinimapAt > 100) {
    lastMinimapAt = performance.now();
    minimapFromState(m.players, zonesForHud(m.zones || []), m.uav);
  }
  const pingTxt = Math.round(pingSmoothed) + 'ms';
  H.setPing(pingTxt);
});

net.on('reload_start', (m) => {
  if (!local) return;
  if (local.reloadUntil <= 0) {
    local.reloadTotal = m.duration || 1500;
    local.reloadUntil = performance.now() + local.reloadTotal;
  }
  S.reload(local.weapon);
});
net.on('reload_done', () => { if (local) { updateLocalHud({ ...snapshotSelf() }); } });
net.on('weapon_switch', (m) => {
  if (!local) return;
  local.weapon = m.weapon;
  local.swapUntil = performance.now() + (m.duration || 350);
  onWeaponChanged();
});
net.on('dry_fire', () => S.dryFire());

function snapshotSelf() {
  return { hp: local ? local.hp : 100, weapon: local ? local.weapon : 'pistol' };
}

net.on('pickup', (m) => {
  if (!m) return;
  if (m.type === 'medkit') { H.addToast('拾取 医疗包 · 生命回满'); S.heal(); }
  else if (m.type === 'shield') { H.addToast('拾取 钢制插板 · 恢复护甲'); S.pickup(m.type); }
  else if (m.type === 'speed') { H.addToast('拾取 加速 · 短时间提速'); S.pickup(m.type); }
  else if (weaponOf(m.type) && m.type !== 'pistol') {
    H.addToast('拾取 ' + weaponOf(m.type).name);
    S.pickup(m.type);
    if (local) {
      local.owned[m.type] = true;
      const w = weaponOf(m.type);
      local.ammo[m.type] = { mag: w.magSize, reserve: w.reserveStart };
      local.weapon = m.type;
      onWeaponChanged();
    }
  }
});

net.on('shot', (m) => {
  if (!started || !m || m.shooterId === myId) return;
  // 调试计数：远程开火按服务器时间戳分桶，用于检查是否"同帧齐射"
  if (window.__game) {
    const at = m.at || Date.now();
    const key = String(at);
    const bucket = (window.__game.__shotBuckets || (window.__game.__shotBuckets = {}));
    bucket[key] = (bucket[key] || 0) + 1;
    const keys = Object.keys(bucket);
    if (keys.length > 400) for (const k of keys.slice(0, 200)) delete bucket[k];
    window.__game.__lastShotAt = at;
  }
  const w = weaponOf(m.weapon);
  const eyePos = v3({ x: m.x, y: m.y, z: m.z });
  const dir = new THREE.Vector3(m.dx || 0, m.dy || 0, m.dz || 0).normalize();
  const r = remotes.get(m.shooterId);
  // 枪口焰放在对方武器模型的枪口 world 坐标（以前用服务器给的"眼睛"位置，会显示在头上）
  let flashPos = eyePos;
  if (r && r.char && typeof r.char.getWeaponMuzzleWorld === 'function') {
    try { flashPos = r.char.getWeaponMuzzleWorld(_remoteMuzzle); } catch { flashPos = eyePos; }
  }
  try { effects.muzzleFlash(flashPos, dir, m.weapon); } catch { /* ignore */ }
  if (window.__game) {
    window.__lastRemoteShot = {
      weapon: m.weapon,
      muzzle: [+flashPos.x.toFixed(2), +flashPos.y.toFixed(2), +flashPos.z.toFixed(2)],
      eye: [+eyePos.x.toFixed(2), +eyePos.y.toFixed(2), +eyePos.z.toFixed(2)],
      shooterId: m.shooterId,
    };
  }
  // 距离/声像（按枪口位置计算，更符合听感）
  const dx = flashPos.x - camera.position.x, dy = flashPos.y - camera.position.y, dz = flashPos.z - camera.position.z;
  const dist = Math.hypot(dx, dy, dz);
  const rightX = Math.cos(local ? local.yaw : 0), rightZ = -Math.sin(local ? local.yaw : 0);
  const pan = dist > 0.5 ? Math.max(-1, Math.min(1, (dx * rightX + dz * rightZ) / dist)) : 0;
  S.shoot(m.weapon, { distance: dist, pan });
  // 子弹擦身（用眼睛→玩家的几何关系）
  if (local && local.alive && dist > 2) {
    const toPlayer = new THREE.Vector3(-(eyePos.x - camera.position.x), -(eyePos.y - camera.position.y), -(eyePos.z - camera.position.z));
    const along = toPlayer.dot(dir);
    if (along > 0 && along < w.range) {
      const closest = Math.hypot(toPlayer.x - dir.x * along, toPlayer.y - dir.y * along, toPlayer.z - dir.z * along);
      if (closest < 2.2) S.whiz();
    }
  }
  if (r) r.target.firingUntil = performance.now() + 90;
});

let lastHitmarkerPart = null;
net.on('hit', (m) => {
  if (!m) return;
  if (m.targetId === myId) {
    if (local) local.hurt(m.part === 'head' ? 0.03 : 0.014);
    H.flashDamage(m.part === 'head');
    if (m.shooterId && m.shooterId !== myId) {
      const r = remotes.get(m.shooterId);
      const sx = r ? r.group.position.x : m.x, sz = r ? r.group.position.z : m.z;
      const dx = sx - camera.position.x, dz = sz - camera.position.z;
      const yaw = local ? local.yaw : 0;
      const lx = dx * Math.cos(yaw) - dz * Math.sin(yaw);
      const lz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
      H.showDamageFrom(Math.atan2(lx, -lz));
    }
    if (m.part === 'head') S.hurt(); else S.hurt();
  } else if (m.shooterId === myId) {
    lastHitmarkerPart = m.part;
    H.showHitmarker(m.part, !!m.killed);
    if (m.part === 'head') S.headshotConfirm(); else S.hitConfirm(m.part);
    if (typeof m.x === 'number') {
      try {
        _bloodPos.set(m.x, m.y, m.z);
        // 命中点往摄像机方向挪一点，避免血雾被角色网格遮住内部
        _toCam.copy(camera.position).sub(_bloodPos).normalize();
        _bloodPos.addScaledVector(_toCam, 0.12);
        effects.bloodImpact(_bloodPos, _toCam, m.part === 'head');
      } catch { /* ignore */ }
    }
    const rv = remotes.get(m.targetId);
    if (rv) rv.target.hitAt = performance.now();
    if (m.killed) {
      S.kill();
      const victim = remotes.get(m.targetId);
      H.addKillFeed({ killer: '你', victim: victim ? victim.name : '敌人', headshot: m.part === 'head', weapon: local ? local.weapon : '' });
    }
  }
});

net.on('death', (m) => {
  if (m.id === myId) {
    deathVisible = true;
    shooting = false;
    if (local) { local.alive = false; local.aiming = false; }
    H.showDeath('你被 ' + (m.killerName || '敌人') + ' 击倒', '重生中…');
    S.death();
    // 注意：不退出 pointer lock —— 退出后重生会失去鼠标控制（体验问题）
  } else {
    const victim = remotes.get(m.id);
    H.addKillFeed({ killer: m.killerName || '敌人', victim: victim ? victim.name : '玩家', headshot: m.part === 'head', weapon: m.weapon || '' });
    if (victim) victim.target.alive = false;
  }
});

net.on('killfeed', (m) => {
  H.addKillFeed(m);
});

net.on('match_countdown', (m) => {
  lastCountdownShown = -1;
  H.setMatchPhase('countdown', (m && m.seconds) || 10);
  S.uiClick();
});
net.on('match_start', () => {
  H.hideWarmup();
  H.addToast('战斗开始 · 占领 A/B/C 据点');
});
net.on('zone_capture', (m) => {
  const mine = m.team === myTeam;
  H.addToast(`${m.zoneId || m.id || ''} 据点${mine ? '已占领' : '被敌方占领'}`);
  S.capture(1);
});
net.on('zone_lost', () => { H.addToast('据点失守'); S.zoneLost(); });
net.on('uav_start', (m) => {
  if (m.team === myTeam) { H.addToast('UAV 侦察上线 · 敌方位置已标记'); S.uav(); }
});
net.on('match_end', (m) => {
  const win = m.winner === myTeam;
  H.showMatchEnd({ winner: m.winner, winnerTeam: m.winner, myTeam, win, scores: m.scores });
  S.win && win ? S.win() : (S.lose && S.lose());
  shooting = false;
  if (document.pointerLockElement) document.exitPointerLock();
});
net.on('streak', (m) => {
  const mine = m.playerId === myId;
  H.addToast((mine ? '你' : m.name) + ' 达成 ' + m.streak + ' 连杀');
  if (mine) S.kill();
});
net.on('error', (m) => {
  setConnStatus(m.msg || '连接失败', 'err');
  if (joinBtn) joinBtn.disabled = false;
});
net.on('close', () => {
  try { stopAmbience && stopAmbience(); } catch { /* ignore */ }
  if (started) {
    showPause('连接已断开，请刷新页面重试');
    H.addToast('连接已断开');
  } else {
    setConnStatus('连接已断开', 'err');
    if (joinBtn) joinBtn.disabled = false;
  }
});
net.on('pong', (m) => {
  const rtt = performance.now() - m.time;
  pingSmoothed = pingSmoothed * 0.8 + rtt * 0.2;
});

// ---------- 主循环 ----------
const clock = new THREE.Clock();
const _camDir = new THREE.Vector3();

function updateHudPerFrame() {
  if (!local) return;
  const w = local.weaponDef();
  const aimingNow = local.adsAmount > 0.5;
  const scopeNow = local.scopeActive;
  if (lastHud.aiming !== aimingNow) { H.setAiming(aimingNow, w.sightType); lastHud.aiming = aimingNow; }
  // 倍率标签：可变倍镜（狙击）显示当前倍率，红点/机瞄不显示
  const zoomLabel = scope.zoomRange && !scope.zoomRange().fixed
    ? (scope.zoomLevel || w.scopeMagnification || 1) + '×'
    : (w.scopeMagnification > 1 ? w.scopeMagnification + '×' : '');
  if (lastHud.scope !== scopeNow || lastHud.zoomLabel !== zoomLabel) {
    H.setScope(false, w.sightType, zoomLabel);   // 所有瞄具都用 PiP 镜片，不再全屏遮罩
    if (H.setOpticZoom) H.setOpticZoom(zoomLabel);
    lastHud.scope = scopeNow;
    lastHud.zoomLabel = zoomLabel;
  }
  if (lastHud.stance !== local.stance) { H.setStance(local.stance); lastHud.stance = local.stance; }
  H.setStamina(local.stamina, WORLD.staminaMax);
  const spreadPx = 14 + Math.min(local.currentSpreadRad() * 900, 60);
  H.setCrosshair(spreadPx, { ads: aimingNow, hidden: scopeNow || !local.alive });
  H.setReload(local.reloadProgress() || null);
  if (!local.alive) H.setReload(null);
}

function loop() {
  requestAnimationFrame(loop);
  const rawDt = clock.getDelta();
  const dt = Math.min(rawDt, 0.05);
  if (rawDt > 0) {
    fpsEma = fpsEma * 0.92 + (1 / rawDt) * 0.08;
    elapsed += dt;
    // 自适应画质：仅在 auto 模式下降档
    if (settings.quality === 'auto') {
      lastQualityCheck += rawDt;
      if (lastQualityCheck > 4) {
        lastQualityCheck = 0;
        if (qualityLevel === 0 && fpsEma < 42 && world.setQuality) { world.setQuality('medium'); qualityLevel = 1; }
        else if (qualityLevel === 1 && fpsEma < 30 && world.setQuality) { world.setQuality('low'); qualityLevel = 2; }
      }
    }
  }

  // GOD 剩余时间：每秒刷新一次 HUD，到点自动解除
  if (godUntil > 0) {
    godHudTick += dt;
    if (godHudTick >= 0.5) {
      godHudTick = 0;
      const left = Math.max(0, Math.ceil((godUntil - Date.now()) / 1000));
      if (left > 0) H.setGod(true, left);
      else { godUntil = 0; H.setGod(false, 0); H.addToast('GOD 效果结束'); }
    }
  }

  if (!started) {
    // 菜单背景：环绕镜头
    const t = elapsed * 0.08;
    camera.position.set(Math.cos(t) * 34, 17, Math.sin(t) * 34);
    camera.lookAt(0, 2, 0);
    camera.fov += (BASE_FOV - camera.fov) * Math.min(1, 6 * dt);
    camera.updateProjectionMatrix();
    if (world.setMenuMode) world.setMenuMode(true);
  } else if (local) {
    if (world.setMenuMode) world.setMenuMode(false);
    // 开火（自动武器按住连发）
    if (shooting && local.locked && local.alive) {
      const res = local.tryFire();
      if (res) fireVisual(res);
    }
    local.stepFrame(dt);
    local.renderCamera(dt);
    const rig = scope.update(dt, { player: local, elapsed });
    if (!local.alive && scope.active) scope.active.visible = false;

    updateRemotes(dt);
    updateHudPerFrame();

    // 世界/特效/道具
    camera.getWorldDirection(_camDir);
    try { setAudioListener(camera.position, _camDir); } catch { /* ignore */ }
    if (world.update) {
      try { world.update(dt, { camera, playerPos: local.pos, time: elapsed, aiming: local.aiming, scope: scopeNow(local) }); } catch (e) { errors.push('world.update: ' + e.message); }
    }
    try { effects.update(dt, camera); } catch (e) { errors.push('effects.update: ' + e.message); }
    for (const s of itemMeshes.values()) {
      s.bob += dt * 2.2;
      s.group.position.y = s.baseY + 0.08 + Math.sin(s.bob) * 0.06;
      s.group.rotation.y += dt * 1.1;
    }
  }

  // 真实光学（PiP）：只有带光学镜片的枪才需要额外渲染。
  // 镜内视场 = 镜片角直径 ÷ 放大倍率 → 镜片圆内是真正的 M 倍放大像，镜片外仍是原视角；
  // 镜片圆心与相机正前方重合，所以放大不会改变命中判定。
  // 注意：狙击镜现在也用同一套 PiP 镜片（不再走全屏遮罩），所以这里不能再排除 scopeActive，
  // 否则狙击开镜时贴图不更新 → 镜片里是上一帧的静止画面，还会随渲染顺序闪烁。
  if (local && local.adsAmount > 0.02) {
    const opticFov = scope.opticCameraFov();
    if (opticFov > 0) {
      try { optics.render(camera, opticFov); }
      catch (e) { if (!loop._opticsErr) { loop._opticsErr = true; errors.push('optics: ' + e.message); } }
    }
  }

  // 渲染（环境模块接管后期时走它的 render）
  try {
    if (world.render) world.render(camera);
    else renderer.render(scene, camera);
  } catch (e) {
    if (!loop._renderErr) { loop._renderErr = true; console.error(e); }
  }
  try { labelRenderer.render(scene, camera); } catch { /* ignore */ }
}

function scopeNow(l) { return !!(l && l.scopeActive); }

// 尺寸自适应
window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);
  if (world.onResize) world.onResize(innerWidth, innerHeight, renderer);
});

// ---------- 分帧预编译材质/着色器：把"进入游戏第一帧"的卡顿拆到多帧 ----------
const prewarmGroups = [];
function makePrewarmGroup(full) {
  const g = new THREE.Group();
  g.name = 'prewarm';
  g.position.set(0, -300, 0);
  scene.add(g);
  const extras = [];
  try {
    const ch = createCharacter({ color: 0x8a93a6, team: 'alpha', variant: 1 });
    ch.root.position.set(0, -300, 0);
    g.add(ch.root);
    prewarmGroups.push({ group: g, ch, extras });
    // 第 1 批只要角色材质（最常用）
    if (full === 0) return { group: g, ch, extras };
    for (const id of WEAPON_ORDER) {
      const w = createWeaponModel(id, { firstPerson: false });
      w.position.set(2, -300, 0);
      g.add(w);
      extras.push(w);
    }
    if (full === 3) {
      for (const type of ['ak47', 'sniper', 'shotgun', 'medkit', 'shield', 'speed']) {
        try {
          const it = world.createItemMesh ? world.createItemMesh(type) : null;
          if (it) { it.position.set(-3, -300, 0); g.add(it); extras.push(it); }
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return { group: g, ch: null, extras };
}

function prewarmBatch(full) {
  if (!scene || !camera || !renderer) return;
  const item = makePrewarmGroup(full);
  try {
    // 战斗特效材质（枪口焰/血雾/弹着粒子）
    if (full === 2 || full === 3) {
      const far = new THREE.Vector3(0, -300, 0);
      try { effects.muzzleFlash(far, new THREE.Vector3(0, 0, -1), 'sniper'); } catch { /* ignore */ }
      try { effects.impact(far, new THREE.Vector3(0, 1, 0), 'dirt', 'ak47'); } catch { /* ignore */ }
      try { effects.bloodImpact(far, new THREE.Vector3(0, 0, 1), true); } catch { /* ignore */ }
    }
    const cleanup = () => {
      try {
        if (item.group) scene.remove(item.group);
        for (const e of item.extras || []) {
          try { if (e.userData && e.userData.kind) { scene.remove(e); } } catch { /* ignore */ }
        }
        try { if (item.ch) item.ch.dispose(); } catch { /* ignore */ }
        if (world.forgetItem) {
          for (const e of item.extras || []) {
            try { if (e.name && e.name.indexOf('item') >= 0) world.forgetItem(e); } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }
    };
    if (typeof renderer.compileAsync === 'function') {
      renderer.compileAsync(scene, camera).then(cleanup, cleanup);
    } else {
      try { if (renderer.compile) renderer.compile(scene, camera); } catch { /* ignore */ }
      cleanup();
    }
  } catch { /* ignore */ }
}

// ---------- 初始化 HUD / 启动 ----------
try { initHud(); } catch (e) { errors.push('initHud: ' + e.message); }
syncSettingsFromHud();
H.setVisible(false);
H.setMenuVisible && H.setMenuVisible(true);
H.showMenu && H.showMenu();
setConnStatus('未连接');
loop();
// 分帧资源上传：主菜单阶段每帧上传 2 张程序化贴图 + 逐步预编译材质，
// 避免"进入游戏"时一次性上传所有贴图/编译所有着色器导致强卡顿。
(function scheduleAssetWarmup() {
  let frames = 0;
  const tick = () => {
    frames += 1;
    try {
      if (frames < 240) {
        const left = uploadTexturesStep(2);
        if (frames === 2 || frames === 90) prewarmBatch(frames === 90 ? 2 : 0);
      } else if (frames < 320) {
        // 剩下的直接一次性标记上传，保证进入游戏前全部就绪
        const left = uploadTexturesStep(64);
        if (left === 0) { prewarmBatch(3); return; }
      } else {
        return;
      }
    } catch { /* ignore */ }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();

// ---------- 调试/自动化接口 ----------
window.__game = {
  camera, scene, renderer, world, effects, scope, net, hud,
  createCharacter, createWeaponModel, THREE,
  send: (msg) => net.send(msg),
  get started() { return started; },
  get local() { return local; },
  // 远程玩家（含 AI）状态表，供调试/自动化读取名牌等信息
  get remotes() { return remotes; },
  get player() {
    if (!local) return null;
    return {
      x: +local.pos.x.toFixed(2), y: +local.pos.y.toFixed(2), z: +local.pos.z.toFixed(2),
      yaw: +local.yaw.toFixed(2), pitch: +local.pitch.toFixed(2),
      hp: local.hp, alive: local.alive, grounded: local.grounded,
      shield: local.shield || 0,
      weapon: local.weapon, stance: local.stance, sprint: local.sprinting, sliding: local.sliding,
      stamina: +local.stamina.toFixed(1),
      mag: local.ammoOf().mag,
      reserve: local.ammoOf().reserve === Infinity ? -1 : local.ammoOf().reserve,
      owned: Object.keys(local.owned),
      reloading: local.reloadUntil > 0,
      aiming: local.aiming, ads: +local.adsAmount.toFixed(2), scope: local.scopeActive,
      recoilPitch: +local.recoilPitch.toFixed(4),
      spread: +local.currentSpreadRad().toFixed(4),
      sx: local.serverPos ? +local.serverPos.x.toFixed(2) : null,
      sy: local.serverPos ? +local.serverPos.y.toFixed(2) : null,
      sz: local.serverPos ? +local.serverPos.z.toFixed(2) : null,
      locked: local.locked,
    };
  },
  get remotes() {
    return [...remotes.values()].map((r) => ({
      id: r.id, name: r.name, team: r.team,
      x: +r.group.position.x.toFixed(2), y: +r.group.position.y.toFixed(2), z: +r.group.position.z.toFixed(2),
      yaw: +r.group.rotation.y.toFixed(2), hp: r.target.hp, alive: r.target.alive, weapon: r.weaponId,
    }));
  },
  get serverPlayers() { return lastStateMsg ? lastStateMsg.players : []; },
  get itemCount() { return itemMeshes.size; },
  get enemyTracers() { return 0; },
  get tracerCount() { return 0; },
  get fps() { return Math.round(fpsEma); },
  get errors() { return errors.slice(-20); },
  get hitmarkerPart() { return lastHitmarkerPart; },
  get matchPhase() { return matchPhase; },
  get matchCountdown() { return matchCountdown; },
  get pendingTextures() { return pendingUploadCount(); },
  get scopeActive() { return local ? local.scopeActive : false; },
  get qualityLevel() { return qualityLevel; },
  get settings() { return settings; },
  setQuality(q) { settings.quality = q; localStorage.setItem('sf_quality', q); if (world.setQuality) world.setQuality(q); },
  setSens(v) { settings.sens = v; if (local) local.sens = v; },
  get zoneState() { return lastStateMsg ? zonesForHud(lastStateMsg.zones || []) : null; },
  get myId() { return myId; },
  get myTeam() { return myTeam; },
};

// 供 HUD 读取地形（小地图）等的桥接
window.__world = { heightAt, ZONES, WORLD, surfaceAt };
