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
import { Effects } from './effects.js';
import { initAudio, sfx, setAudioListener, startAmbience, stopAmbience } from './audio.js';
import { createCharacter } from './models/character.js';
import { createWeaponModel } from './models/weapons.js';
import { initHud, hud } from './hud.js';

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
  'setCrosshair', 'setAiming', 'setScope',
  'showHitmarker', 'flashDamage', 'showDamageFrom',
  'setScores', 'setZones', 'setTimer', 'setUav', 'setKills', 'setDeaths', 'setPing', 'setPlayers',
  'addKillFeed', 'addToast', 'setStreak',
  'showDeath', 'hideDeath', 'showPause', 'hidePause',
  'showWarmup', 'hideWarmup', 'setCountdown', 'setMatchPhase',
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
const scope = new ScopeController(camera);
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
let lastHud = { aiming: null, scope: null, stance: null, weapon: null, mag: -1, reserve: -1 };

const hex = (c) => '#' + Number(c || 0x888888).toString(16).padStart(6, '0');
const esc = (s) => String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const v3 = (p) => new THREE.Vector3(p.x, p.y, p.z);

// 名称标签用的简易血量条
function labelHTML(name, color, bot, team) {
  return `<span class="dot" style="background:${hex(color)}"></span><span class="nm">${esc(name)}</span>` +
    (bot ? '<span class="ai-tag">AI</span>' : '') +
    `<span class="hpbar"><i style="width:100%"></i></span>`;
}

// ---------- 远程玩家 ----------
function setRemoteWeapon(r, id) {
  if (r.weaponId === id) return;
  r.weaponId = id;
  let model = remoteWeaponCache.get(id);
  if (!model) {
    model = createWeaponModel(id, { simple: true });
    remoteWeaponCache.set(id, model);
  }
  r.char.attachWeapon(model);
}

function createRemote(p) {
  const char = createCharacter({ color: p.color, team: p.team || 'bravo' });
  const group = char.root;
  group.position.set(p.x, p.y ?? heightAt(p.x, p.z), p.z);
  group.rotation.y = p.yaw || 0;

  const label = document.createElement('div');
  label.className = 'name-tag';
  label.innerHTML = labelHTML(p.name, p.color, p.bot, p.team);
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

    // 名牌：近距离显示；血量条同步
    if (r.labelObj) {
      const dx = r.group.position.x - camera.position.x;
      const dz = r.group.position.z - camera.position.z;
      const d2 = dx * dx + dz * dz;
      r.labelObj.visible = t.alive && d2 < 30 * 30;
      if (t.hp !== r.lastLabelHp) {
        const bar = r.label.querySelector('.hpbar i');
        if (bar) bar.style.width = Math.max(0, Math.min(100, t.hp)) + '%';
        r.lastLabelHp = t.hp;
      }
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
  const spread = result ? result.spread : local.currentSpreadRad();
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
  if (local.cycleWeapon(e.deltaY > 0 ? 1 : -1)) onWeaponChanged();
}, { passive: true });

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    // 开局等待阶段：空格 = 开始 10 秒倒计时
    if (started && matchPhase === 'waiting') {
      net.send({ t: 'ready' });
      H.setMatchPhase('countdown', 10);
      return;
    }
    // 未开赛不跳跃
    if (matchPhase !== 'playing') { if (local) local.jumpHeld = false; return; }
    if (local && local.locked && local.alive && local.grounded) S.jump();
    if (local) local.jumpHeld = true;
  }
  if (local && started && !e.repeat) {
    if (local.locked && local.alive) {
      const m = /^(?:Digit|Numpad)([1-5])$/.exec(e.code);
      if (m) {
        const id = WEAPON_ORDER[Number(m[1]) - 1];
        if (id && local.requestSwitch(id)) { S.switchWeapon(); onWeaponChanged(); }
      }
      if (e.code === 'KeyR') {
        if (local.requestReload()) { S.reload(local.weapon); H.setReload(0.001); }
      }
      if (e.code === 'KeyQ') {
        if (local.cycleWeapon(-1)) { S.switchWeapon(); onWeaponChanged(); }
      }
    }
  }
  if (local) local.keys.add(e.code);
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && local) local.jumpHeld = false;
  if (local) local.keys.delete(e.code);
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
  if (lastHud.scope !== scopeNow) {
    H.setScope(scopeNow, w.sightType, w.scopeMagnification > 1 ? w.scopeMagnification + '×' : '');
    lastHud.scope = scopeNow;
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

// ---------- 预编译材质/着色器：把"进入游戏第一帧"的卡顿提前到主菜单阶段 ----------
function prewarmAssets() {
  if (!scene || !camera || !renderer) return;
  let warm = null;
  const extraGroups = [];
  try {
    warm = new THREE.Group();
    warm.name = 'prewarm';
    warm.position.set(0, -300, 0);
    scene.add(warm);
    // 角色材质（远程玩家首次出现时不再编译）
    const ch = createCharacter({ color: 0x8a93a6, team: 'alpha', variant: 1 });
    ch.root.position.set(0, -300, 0);
    warm.add(ch.root);
    // 全部第一/第三人称武器模板材质
    for (const id of WEAPON_ORDER) {
      const g = createWeaponModel(id, { firstPerson: false });
      g.position.set(2, -300, 0);
      warm.add(g);
      extraGroups.push(g);
    }
    // 拾取物模型材质
    for (const type of ['ak47', 'sniper', 'shotgun', 'medkit', 'shield', 'speed']) {
      try {
        const g = world.createItemMesh ? world.createItemMesh(type) : null;
        if (g) { g.position.set(-3, -300, 0); warm.add(g); extraGroups.push(g); }
      } catch { /* ignore */ }
    }
    // 战斗特效材质（粒子/枪口焰/血雾）
    try {
      effects.muzzleFlash(new THREE.Vector3(0, -300, 0), new THREE.Vector3(0, 0, -1), 'sniper');
      effects.impact(new THREE.Vector3(0, -300, 0), new THREE.Vector3(0, 1, 0), 'dirt', 'ak47');
      effects.bloodImpact(new THREE.Vector3(0, -300, 0), new THREE.Vector3(0, 0, 1), true);
    } catch { /* ignore */ }

    const cleanup = () => {
      try {
        if (warm) {
          scene.remove(warm);
          for (const g of extraGroups) {
            try { world.forgetItem && world.forgetItem(g); } catch { /* ignore */ }
            warm.remove(g);
          }
          try { ch.dispose && ch.dispose(); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
      warm = null;
    };
    const doCompile = () => {
      try {
        if (renderer.compile) renderer.compile(scene, camera);
      } catch { /* ignore */ }
      cleanup();
    };
    if (typeof renderer.compileAsync === 'function') {
      renderer.compileAsync(scene, camera).then(cleanup, cleanup);
    } else {
      setTimeout(doCompile, 30);
    }
  } catch (e) {
    errors.push('prewarm: ' + (e && e.message));
    if (warm) scene.remove(warm);
  }
}

// ---------- 初始化 HUD / 启动 ----------
try { initHud(); } catch (e) { errors.push('initHud: ' + e.message); }
syncSettingsFromHud();
H.setVisible(false);
H.setMenuVisible && H.setMenuVisible(true);
H.showMenu && H.showMenu();
setConnStatus('未连接');
loop();
// 主菜单显示后预编译所有材质/特效着色器，避免"进入游戏第一帧"卡顿
setTimeout(prewarmAssets, 600);
setTimeout(() => { try { if (renderer.compile) renderer.compile(scene, camera); } catch { /* ignore */ } }, 1600);

// ---------- 调试/自动化接口 ----------
window.__game = {
  camera, scene, renderer, world, effects, scope, net, hud,
  createCharacter, createWeaponModel, THREE,
  send: (msg) => net.send(msg),
  get started() { return started; },
  get local() { return local; },
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
