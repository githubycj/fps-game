// ===== 霓虹战场 · 客户端主入口 =====
import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { WORLD, WEAPONS, WEAPON_ORDER, weaponOf } from '../shared/map.js';
import { Net, wsUrl } from './net.js';
import { buildWorld } from './world.js';
import { LocalPlayer } from './player.js';
import { Effects } from './effects.js';
import { initAudio, sfx } from './audio.js';
import { createCharacter } from './models/character.js';
import { createWeaponModel } from './models/weapons.js';

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const menuEl = $('menu'), hudEl = $('hud');
const nickEl = $('nick'), joinBtn = $('joinBtn'), connStatus = $('connStatus');
const statusEl = $('status'), playersEl = $('players');
const hpFill = $('hpFill'), hpNum = $('hpNum');
const hitmarkerEl = $('hitmarker'), flashEl = $('flash');
const pauseEl = $('pause'), pauseText = $('pauseText');
const deathEl = $('death'), deathText = $('deathText'), deathSub = $('deathSub');
const weaponEl = $('weapon');
const scoreEl = $('score');
const shieldWrapEl = $('shieldWrap');
const shieldFillEl = $('shieldFill');
const speedEl = $('speedBadge');
const ammoMagEl = $('ammoMag');
const ammoReserveEl = $('ammoReserve');
const reloadWrapEl = $('reloadWrap');
const reloadFillEl = $('reloadFill');
const slotsEl = $('weaponSlots');
const toastsEl = $('toasts');

// ---------- 武器 HUD ----------
function setWeaponHud(w) {
  if (weaponEl) weaponEl.textContent = weaponOf(w).name;
}
function updateAmmoHud() {
  if (!local) return;
  const a = local.ammoOf();
  const w = local.weaponDef();
  if (ammoMagEl) {
    ammoMagEl.textContent = a.mag;
    ammoMagEl.classList.toggle('low', a.mag <= Math.max(1, Math.floor(w.magSize * 0.25)));
  }
  if (ammoReserveEl) ammoReserveEl.textContent = a.reserve === Infinity ? '∞' : a.reserve;
}
function buildWeaponSlots() {
  if (!slotsEl) return;
  slotsEl.innerHTML = '';
  WEAPON_ORDER.forEach((id, i) => {
    const el = document.createElement('div');
    el.className = 'slot';
    el.dataset.weapon = id;
    el.innerHTML = `<span class="k">${i + 1}</span><span class="n">${weaponOf(id).name}</span>`;
    slotsEl.appendChild(el);
  });
}
function updateWeaponSlots() {
  if (!slotsEl || !local) return;
  for (const el of slotsEl.children) {
    const id = el.dataset.weapon;
    el.classList.toggle('owned', !!local.owned[id]);
    el.classList.toggle('active', id === local.weapon);
  }
}

// ---------- 渲染器 / 场景 ----------
// 软件渲染（SwiftShader 等无 GPU 环境）下关闭抗锯齿：MSAA 的填充开销极高
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
const renderer = new THREE.WebGLRenderer({
  canvas: $('game'),
  antialias: !SOFT_GL,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(SOFT_GL ? 0.6 : Math.min(window.devicePixelRatio, 1.25));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;

const scene = new THREE.Scene();
const world = buildWorld(scene, renderer, { soft: SOFT_GL });
const effects = new Effects(scene);

const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 400);
camera.rotation.order = 'YXZ';
scene.add(camera);

// ---------- 第一人称武器模型（挂在相机上） ----------
// 每把枪的腰射/瞄准基准位不同：长枪更靠后，狙击枪瞄准时居中对齐瞄具
const GUN_BASE = {
  pistol:  [0.30, -0.26, -0.50],
  smg:     [0.28, -0.25, -0.48],
  ak47:    [0.26, -0.24, -0.46],
  shotgun: [0.27, -0.25, -0.44],
  sniper:  [0.22, -0.22, -0.42],
};
const ADS_BASE = {
  pistol:  [0.0, -0.155, -0.40],
  smg:     [0.0, -0.150, -0.38],
  ak47:    [0.0, -0.145, -0.36],
  shotgun: [0.0, -0.150, -0.34],
  sniper:  [0.0, -0.130, -0.30],
};
let aiming = false;
let aimAmount = 0;
const gunModels = {};
for (const id of WEAPON_ORDER) {
  const m = createWeaponModel(id, { firstPerson: true });
  m.visible = false;
  camera.add(m);
  gunModels[id] = m;
}
let gun = gunModels.pistol;
gun.visible = true;

function setWeaponGun(w) {
  const next = gunModels[w] || gunModels.pistol;
  if (next !== gun) {
    gun.visible = false;
    next.visible = true;
    gun = next;
  }
}


// ---------- 名牌渲染 ----------
const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
labelRenderer.domElement.style.position = 'absolute';
labelRenderer.domElement.style.top = '0';
labelRenderer.domElement.style.left = '0';
labelRenderer.domElement.style.pointerEvents = 'none';
document.body.appendChild(labelRenderer.domElement);

// ---------- 网络 ----------
const net = new Net();
let myId = null;
let maxPlayers = WORLD.maxPlayers;
let started = false;
let shooting = false;
const crosshairEl = document.getElementById('crosshair');
let recoil = 0;
let pingSmoothed = 0;
let local = null;
const remotes = new Map();   // id -> { group, labelObj, hpFill, target }
const itemMeshes = new Map(); // id -> 地面道具
const playerRows = new Map(); // id -> DOM row
let deathVisible = false;

const hex = (c) => '#' + c.toString(16).padStart(6, '0');
const esc = (s) => String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

// ---------- HUD 辅助 ----------
function setHp(hp) {
  const pct = Math.max(0, Math.min(100, hp));
  hpFill.style.width = pct + '%';
  hpNum.textContent = Math.round(pct);
}

function showHitmarker(part = 'body', killed = false) {
  hitmarkerEl.classList.remove('head', 'kill');
  if (killed) hitmarkerEl.classList.add('kill');
  else if (part === 'head') hitmarkerEl.classList.add('head');
  hitmarkerEl.classList.remove('hidden');
  hitmarkerEl.style.animation = 'none';
  void hitmarkerEl.offsetWidth; // 重启动画
  hitmarkerEl.style.animation = '';
  setTimeout(() => {
    hitmarkerEl.classList.add('hidden');
    hitmarkerEl.classList.remove('head', 'kill');
  }, killed ? 450 : 200);
}

let flashTimer = null;
function flashDamage(head = false) {
  flashEl.classList.remove('hidden');
  flashEl.style.opacity = head ? 1 : 0.85;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flashEl.style.opacity = 0;
    setTimeout(() => flashEl.classList.add('hidden'), 550);
  }, 80);
}

function addToast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  toastsEl.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

// ---------- 远程玩家 ----------
// ---------- 远程玩家（程序化角色模型 + 骨骼式动画） ----------
function setRemoteWeapon(r, id) {
  if (r.weaponId === id) return;
  r.weaponId = id;
  r.char.attachWeapon(createWeaponModel(id, { simple: true }));
}

function createRemote(p) {
  const char = createCharacter({ color: p.color });
  const group = char.root;
  group.position.set(p.x, p.y, p.z);
  group.rotation.y = p.yaw;

  const label = document.createElement('div');
  label.className = 'name-tag';
  label.innerHTML = `<span class="dot" style="color:${hex(p.color)};background:${hex(p.color)}"></span>` +
    `<span class="nm">${esc(p.name)}</span>` + (p.bot ? '<span class="ai-tag">AI</span>' : '') +
    (p.bot ? `<span class="team-tag ${p.team === 'ally' ? 'ally' : 'enemy'}"></span>` : '');
  const labelObj = new CSS2DObject(label);
  labelObj.position.set(0, 2.05, 0);
  group.add(labelObj);

  scene.add(group);
  const state = {
    char, group, labelObj,
    name: p.name,
    weaponId: null,
    target: {
      x: p.x, y: p.y, z: p.z, yaw: p.yaw, hp: p.hp, alive: p.alive,
      grounded: p.grounded !== false, aiming: !!p.aiming,
    },
    speed: 0,
  };
  setRemoteWeapon(state, p.weapon || 'pistol');
  remotes.set(p.id, state);
  return state;
}

function createItemMesh(it) {
  const group = new THREE.Group();
  if (it.type === 'medkit') {
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.22, 0.5), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }));
    body.position.y = 0.42;
    group.add(body);
    const crossMat = new THREE.MeshBasicMaterial({ color: 0xd84050 });
    const c1 = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.1, 0.06), crossMat);
    c1.position.set(0, 0.42, 0.28);
    group.add(c1);
    const c2 = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.28, 0.06), crossMat);
    c2.position.set(0, 0.42, 0.28);
    group.add(c2);
  } else if (it.type === 'shield') {
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 10), new THREE.MeshStandardMaterial({ color: 0x7fb0ff, roughness: 0.25, metalness: 0.4, emissive: 0x2a4a80, emissiveIntensity: 0.6 }));
    orb.position.y = 0.45;
    group.add(orb);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.03, 8, 20), new THREE.MeshBasicMaterial({ color: 0xaad0ff }));
    rim.position.y = 0.45;
    rim.rotation.x = Math.PI / 2;
    group.add(rim);
  } else if (it.type === 'speed') {
    const core = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.36, 4), new THREE.MeshStandardMaterial({ color: 0x9be08a, roughness: 0.4, metalness: 0.3, emissive: 0x2f6a24, emissiveIntensity: 0.6 }));
    core.position.y = 0.46;
    core.rotation.x = -Math.PI / 2;
    group.add(core);
    for (const dz of [0.16, -0.2]) {
      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, 0.12), new THREE.MeshBasicMaterial({ color: 0xbaffa8 }));
      tail.position.set(0, 0.46, dz);
      group.add(tail);
    }
  } else if (WEAPONS[it.type]) {
    // 武器道具：直接摆一把缩小版的枪，拾取前就能看出是什么
    const wm = createWeaponModel(it.type);
    wm.scale.setScalar(0.5);
    wm.position.set(0, 0.5, 0);
    wm.rotation.set(0.08, 0, 0.35);
    group.add(wm);
  }
  const ringColor = WEAPONS[it.type]
    ? WEAPONS[it.type].tracer
    : (it.type === 'medkit' ? 0x7fe0c0 : (it.type === 'shield' ? 0x7fb0ff : 0x9be08a));
  const ring = new THREE.Mesh(
    new THREE.CylinderGeometry(0.7, 0.7, 0.05, 24, 1, true),
    new THREE.MeshBasicMaterial({ color: ringColor, transparent: true, opacity: 0.7 })
  );
  ring.position.y = 0.03;
  group.add(ring);
  group.position.set(it.x, 0, it.z);
  scene.add(group);

  const state = { group, type: it.type, bob: Math.random() * Math.PI * 2 };
  itemMeshes.set(it.id, state);
  return state;
}
function syncItems(list) {
  const seen = new Set();
  for (const it of list || []) {
    seen.add(it.id);
    if (!itemMeshes.has(it.id)) createItemMesh(it);
  }
  for (const id of itemMeshes.keys()) {
    if (!seen.has(id)) {
      const s = itemMeshes.get(id);
      scene.remove(s.group);
      itemMeshes.delete(id);
    }
  }
}

function removeRemote(id) {
  const r = remotes.get(id);
  if (r) {
    scene.remove(r.group);
    remotes.delete(id);
  }
}

function updateRemotes(dt) {
  for (const r of remotes.values()) {
    const t = r.target;
    const k = 1 - Math.exp(-10 * dt);
    const px = r.group.position.x, pz = r.group.position.z;
    r.group.position.x += (t.x - r.group.position.x) * k;
    r.group.position.y += (t.y - r.group.position.y) * k;
    r.group.position.z += (t.z - r.group.position.z) * k;
    const da = Math.atan2(Math.sin(t.yaw - r.group.rotation.y), Math.cos(t.yaw - r.group.rotation.y));
    r.group.rotation.y += da * k;

    // 用位移估计水平速度，驱动步态动画
    const inst = Math.hypot(r.group.position.x - px, r.group.position.z - pz) / Math.max(dt, 1e-4);
    r.speed = r.speed * 0.72 + inst * 0.28;
    r.char.update({ speed: r.speed, grounded: t.grounded, alive: t.alive, aiming: t.aiming }, dt);

    // 名牌仅近距离显示（且存活）
    if (r.labelObj) {
      const dx = r.group.position.x - local.pos.x;
      const dz = r.group.position.z - local.pos.z;
      r.labelObj.visible = t.alive && (dx * dx + dz * dz < 15 * 15);
    }
  }
}

// ---------- 在线玩家列表 ----------
function makePlayerRow(p) {
  const row = document.createElement('div');
  row.className = 'player-row' + (p.id === myId ? ' me' : '');
  row.innerHTML = `<span class="pdot" style="color:${hex(p.color)};background:${hex(p.color)}"></span>` +
    `<span class="pname">${esc(p.name)}${p.id === myId ? '（我）' : ''}</span>` +
    (p.bot ? '<span class="ai-tag">AI</span>' : '') +
    (p.bot ? `<span class="team-tag ${p.team === 'ally' ? 'ally' : 'enemy'}"></span>` : '') +
    `<span class="pbar"><i></i></span>`;
  playersEl.appendChild(row);
  return row;
}

function syncPlayerList(players) {
  const seen = new Set();
  for (const p of players) {
    seen.add(p.id);
    let row = playerRows.get(p.id);
    if (!row) {
      row = makePlayerRow(p);
      playerRows.set(p.id, row);
    }
    const fill = row.querySelector('.pbar i');
    fill.style.width = Math.max(0, (p.hp / WORLD.maxHp) * 100) + '%';
    fill.classList.toggle('dead', !p.alive);
  }
  for (const [id, row] of playerRows) {
    if (!seen.has(id)) {
      row.remove();
      playerRows.delete(id);
    }
  }
}

// ---------- 开火视觉 ----------
const _dir = new THREE.Vector3();
const _origin = new THREE.Vector3();
const raycaster = new THREE.Raycaster();
raycaster.far = WORLD.shootRange;

const _muzzle = new THREE.Vector3();
const _beamDir = new THREE.Vector3();

function fireVisual() {
  const w = local.weaponDef();
  if (window.__game) window.__game.shotsFired = (window.__game.shotsFired || 0) + 1;
  sfx.shoot();
  recoil = Math.min(0.24, recoil + w.recoil.kick);

  // 枪口位置取武器模型自带坐标（随模型缩放），用于闪光与曳光起点
  const ml = gun.userData.muzzle;
  _muzzle.set(0, 0, -0.9);
  if (ml) _muzzle.copy(ml);
  gun.localToWorld(_muzzle);
  effects.muzzleFlash(_muzzle, w.tracer);

  camera.getWorldDirection(_dir);
  camera.getWorldPosition(_origin);
  _origin.y -= 0.12; // 射线略低于视线中心，与服务器 eyeHeight 对齐
  raycaster.set(_origin, _dir);
  raycaster.far = w.range;
  const hits = raycaster.intersectObjects(world.raycastTargets, false);
  const end = hits.length
    ? hits[0].point.clone()
    : _origin.clone().addScaledVector(_dir, w.range);
  if (hits.length) effects.impact(end, w.tracer);

  // 霰弹枪一次画多条曳光，视觉上体现弹丸扩散
  const beams = w.pellets > 1 ? Math.min(w.pellets, 5) : 1;
  for (let i = 0; i < beams; i++) {
    if (beams === 1) {
      effects.tracer(_muzzle, end, w.tracer);
      break;
    }
    _beamDir.copy(_dir);
    const a = (i / beams) * Math.PI * 2 + Math.random();
    const r = w.pelletSpread * 0.85 * Math.sqrt(Math.random());
    _beamDir.x += Math.cos(a) * r;
    _beamDir.y += Math.sin(a) * r;
    _beamDir.z += (Math.random() - 0.5) * r * 0.5;
    _beamDir.normalize();
    const e = hits.length ? hits[0].point.clone() : _origin.clone().addScaledVector(_beamDir, w.range);
    effects.tracer(_muzzle, e, w.tracer);
  }
}

// ---------- 指针锁定与输入 ----------
function requestLock() {
  renderer.domElement.requestPointerLock();
}

function showPause(text) {
  pauseText.textContent = text;
  pauseEl.classList.remove('hidden');
}
function hidePause() { pauseEl.classList.add('hidden'); }

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === renderer.domElement;
  if (local) local.locked = locked;
  if (locked) {
    hidePause();
  } else if (started && local && local.alive && !deathVisible) {
    showPause('已暂停 · 点击继续');
  }
});

document.addEventListener('mousemove', (e) => {
  if (local && local.locked) local.onMouseMove(e.movementX, e.movementY);
});

document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('mousedown', (e) => {
  if (!started || !local) return;
  initAudio();
  if (e.button === 0 && local.locked && local.alive) shooting = true;
  if (e.button === 2 && local.locked && local.alive) { aiming = true; local.aiming = true; }
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 0) {
    shooting = false;
    if (local) local.onTriggerUp();   // 半自动武器需松开扳机才能再次击发
  }
  if (e.button === 2) { aiming = false; if (local) local.aiming = false; }
});

// 滚轮切枪
window.addEventListener('wheel', (e) => {
  if (!started || !local || !local.locked || !local.alive) return;
  local.cycleWeapon(e.deltaY > 0 ? 1 : -1);
}, { passive: true });

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    if (local && local.locked && local.alive && local.grounded) sfx.jump();
    if (local) local.jumpHeld = true;
  }
  if (local && started && local.alive && !e.repeat) {
    // 数字键 1~5 直接切枪
    const m = /^(?:Digit|Numpad)([1-5])$/.exec(e.code);
    if (m) {
      const id = WEAPON_ORDER[Number(m[1]) - 1];
      if (id && local.requestSwitch(id)) sfx.switchWeapon();
    }
    if (e.code === 'KeyR') {
      if (local.requestReload()) sfx.reload();
    }
    if (e.code === 'KeyQ' && local.cycleWeapon(-1)) sfx.switchWeapon();
  }
  if (local) local.keys.add(e.code);
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && local) local.jumpHeld = false;
  if (local) local.keys.delete(e.code);
});
window.addEventListener('blur', () => {
  if (local) { local.keys.clear(); local.jumpHeld = false; }
  shooting = false;
});

// 暂停 / 死亡点击
pauseEl.addEventListener('click', () => {
  if (!local || !local.alive || deathVisible) return;
  shooting = false;
  requestLock();
});
// ---------- 网络事件 ----------
function cancelAim() { aiming = false; if (local) local.aiming = false; }

function showDeath(killerName) {
  deathText.textContent = `你被 ${killerName || '？？？'} 击倒`;
  deathSub.textContent = '重生中…';
  deathEl.classList.remove('hidden');
  deathVisible = true;
  cancelAim();
  sfx.death();
}

net.on('welcome', (m) => {
  myId = m.id;
  maxPlayers = m.maxPlayers || WORLD.maxPlayers;
  local = new LocalPlayer(camera, net);
  local.reset(m.spawn);
  started = true;
  menuEl.classList.add('hidden');
  hudEl.classList.remove('hidden');
  statusEl.textContent = `已连接 · 玩家 ${m.players.length}/${m.maxPlayers}`;
  syncPlayerList(m.players);
  for (const p of m.players) if (p.id !== myId) createRemote(p);
  // 初始化武器 HUD（服务器决定开局持有）
  const me0 = m.players.find((p) => p.id === myId);
  if (me0) local.syncWeaponFromServer(me0);
  buildWeaponSlots();
  updateWeaponSlots();
  setWeaponHud(local.weapon);
  setWeaponGun(local.weapon);
  updateAmmoHud();
  if (!deathVisible) showPause('点击屏幕进入战斗');
});

net.on('player_joined', (m) => {
  if (!started) return;
  createRemote(m.player);
  addToast(`${m.player.name} 加入战场`);
  sfx.join();
});

net.on('player_left', (m) => {
  if (!started) return;
  removeRemote(m.id);
  const row = playerRows.get(m.id);
  if (row) { row.remove(); playerRows.delete(m.id); }
  addToast(`有玩家离开了战场`);
  sfx.leave();
});

net.on('state', (m) => {
  if (!started || !local) return;
  const me = m.players.find((p) => p.id === myId);
  if (me) {
    const wasAlive = local.alive;
    local.serverPos = new THREE.Vector3(me.x, me.y, me.z);
    local.alive = me.alive;
    local.hp = me.hp;
    local.syncWeaponFromServer(me);      // 弹药/持有/当前武器以服务器为准
    setHp(me.hp);
    setWeaponHud(local.weapon);
    setWeaponGun(local.weapon);
    updateAmmoHud();
    updateWeaponSlots();
    if (scoreEl) scoreEl.textContent = '击杀 ' + (me.kills || 0) + ' · 死亡 ' + (me.deaths || 0);
    if (shieldWrapEl) {
      shieldWrapEl.classList.toggle('hidden', !(me.shield > 0));
      if (shieldFillEl) shieldFillEl.style.width = Math.max(0, Math.min(100, (me.shield / WORLD.shieldMax) * 100)) + '%';
    }
    if (speedEl) speedEl.classList.toggle('hidden', !me.speed);
    if (me.alive && !wasAlive && deathVisible) {
      // 重生后自动回到战场（无需点击，指针锁保持）
      deathEl.classList.add('hidden');
      deathVisible = false;
      sfx.respawn();
    }
  }
  const seen = new Set();
  for (const p of m.players) {
    if (p.id === myId) continue;
    seen.add(p.id);
    let r = remotes.get(p.id);
    if (!r) r = createRemote(p);
    const t = r.target;
    t.x = p.x; t.y = p.y; t.z = p.z;
    t.yaw = p.yaw;
    t.hp = p.hp;
    t.alive = p.alive;
    t.grounded = p.grounded !== false;   // 用于落地/跳跃动画
    t.aiming = !!p.aiming;
    const wid = p.weapon || 'pistol';
    if (r.weaponId !== wid) setRemoteWeapon(r, wid);
  }
  for (const id of remotes.keys()) {
    if (!seen.has(id)) removeRemote(id);
  }
  syncPlayerList(m.players);
  syncItems(m.items);
  statusEl.textContent = `已连接 · ${Math.round(pingSmoothed)}ms · ${m.players.length}/${maxPlayers} 人`;
});

let enemyTracers = 0;
let killCount = 0;
// 武器拾取提示（一句话说明定位）
const WEAPON_TIP = {
  pistol: '稳定兜底 · 备弹无限',
  smg: '高射速 · 适合近身泼水',
  ak47: '中距全能 · 注意压枪',
  shotgun: '贴脸爆发 · 远距离乏力',
  sniper: '开镜一击致命 · 腰射极不准',
};

net.on('reload_start', (m) => {
  sfx.reload();
  if (local && local.reloadUntil <= 0) {
    local.reloadTotal = m.duration || 1000;
    local.reloadUntil = performance.now() + local.reloadTotal;
  }
});

net.on('reload_done', () => { updateAmmoHud(); });

net.on('weapon_switch', (m) => {
  if (!local) return;
  local.weapon = m.weapon;
  local.swapUntil = performance.now() + (m.duration || 300);
  setWeaponGun(m.weapon);
  setWeaponHud(m.weapon);
  updateAmmoHud();
  updateWeaponSlots();
});

net.on('dry_fire', () => { sfx.dryFire(); });

net.on('pickup', (m) => {
  if (!m) return;
  if (WEAPONS[m.type]) {
    addToast(`拾取 ${WEAPONS[m.type].name} · ${WEAPON_TIP[m.type] || ''}`);
    setWeaponGun(m.type);
    setWeaponHud(m.type);
    updateAmmoHud();
    updateWeaponSlots();
    sfx.pickup();
  } else if (m.type === 'medkit') {
    addToast('拾取 急救包 · 生命回满');
    sfx.heal();
  } else if (m.type === 'shield') {
    addToast('拾取 护盾 · 可吸收 50 伤害');
    sfx.pickup();
  } else if (m.type === 'speed') {
    addToast('拾取 加速 · 8 秒内移速提升');
    sfx.pickup();
  }
});

net.on('streak', (m) => {
  if (!m) return;
  const mine = m.playerId === myId;
  addToast((mine ? '你' : m.name) + ' 达成 ' + m.streak + ' 连杀！');
  if (mine) sfx.kill();
});

net.on('shot', (m) => {
  if (!started || !m || m.shooterId === myId) return;
  if (typeof m.x !== 'number' || typeof m.dx !== 'number') return;
  enemyTracers++;
  const origin = new THREE.Vector3(m.x, m.y, m.z);
  const dir = new THREE.Vector3(m.dx, m.dy, m.dz).normalize();
  const w = weaponOf(m.weapon);
  raycaster.set(origin, dir);
  raycaster.far = w.range;
  const hits = raycaster.intersectObjects(world.raycastTargets, false);
  const end = hits.length ? hits[0].point.clone() : origin.clone().addScaledVector(dir, w.range);
  effects.tracer(origin, end, w.tracer); // 他人曳光：按武器配色
});

net.on('hit', (m) => {
  if (m.targetId === myId) {
    flashDamage(m.part === 'head');
    if (m.part === 'head') sfx.headHurt(); else sfx.hurt();
  } else if (m.shooterId === myId) {
    showHitmarker(m.part, m.killed);
    if (m.part === 'head') sfx.headshot(); else sfx.hit();
    if (m.killed) {
      killCount++;
      sfx.kill();
      const nm = (remotes.get(m.targetId) && remotes.get(m.targetId).name) || '对手';
      addToast('击倒 ' + nm + (m.part === 'head' ? '（爆头）' : ''));
    }
    if (typeof m.x === 'number') {
      effects.impact(new THREE.Vector3(m.x, m.y, m.z), m.part === 'head' ? 0xf0b060 : 0x7fd4ff);
    }
  }
});

net.on('death', (m) => {
  if (m.id === myId) {
    showDeath(m.killerName);
  }
});

net.on('error', (m) => {
  connStatus.textContent = m.msg || '连接失败';
  connStatus.className = 'status err';
  joinBtn.disabled = false;
});

net.on('close', () => {
  if (started) {
    statusEl.textContent = '连接已断开';
    showPause('连接已断开，请刷新页面重试');
  } else {
    connStatus.textContent = '连接已断开';
    connStatus.className = 'status err';
    joinBtn.disabled = false;
  }
});

net.on('pong', (m) => {
  const rtt = performance.now() - m.time;
  pingSmoothed = pingSmoothed * 0.8 + rtt * 0.2;
});

// ---------- 加入流程 ----------
joinBtn.addEventListener('click', async () => {
  initAudio();
  const name = nickEl.value.trim() || '玩家';
  connStatus.textContent = '连接中…';
  connStatus.className = 'status';
  joinBtn.disabled = true;
  try {
    await net.connect(wsUrl());
    net.send({ t: 'join', name });
    connStatus.textContent = '已连接，等待服务器确认…';
  } catch (e) {
    connStatus.textContent = '连接失败：' + e.message;
    connStatus.className = 'status err';
    joinBtn.disabled = false;
  }
});
nickEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinBtn.click();
});
nickEl.focus();

setInterval(() => net.send({ t: 'ping', time: performance.now() }), 1000);

// 30Hz 实时输入上报（与渲染帧率解耦）
setInterval(() => { if (started && local) local.sendInput(); }, 33);

// ---------- 主循环 ----------
const clock = new THREE.Clock();
let elapsed = 0;

let fpsEma = 0;
let qualityTimer = 0;
let qualityLevel = 0;   // 0=满配（含阴影） 1=降分辨率 2=关闭阴影
function downgradeQuality() {
  if (qualityLevel === 0) {
    // 先关阴影：低端设备上收益最大（软件渲染环境已在 world 里直接关闭）
    renderer.shadowMap.enabled = false;
    if (world.sun) world.sun.castShadow = false;
    scene.traverse((o) => {
      if (!o.material) return;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) m.needsUpdate = true;
    });
    qualityLevel = 1;
  } else if (qualityLevel === 1) {
    renderer.setPixelRatio(1);           // 仍不达标再降分辨率，保流畅
    qualityLevel = 2;
  }
}
function loop() {
  requestAnimationFrame(loop);
  const rawDt = clock.getDelta();
  const dt = Math.min(rawDt, 0.05);
  if (rawDt > 0) {
    fpsEma = fpsEma * 0.92 + (1 / rawDt) * 0.08;
    if (window.__game) window.__game.fps = Math.round(fpsEma);
    qualityTimer += rawDt;
    // 分两级降级，每级观察 2 秒
    if (qualityTimer > 2) {
      if (qualityLevel === 0 && fpsEma < 40) { downgradeQuality(); qualityTimer = 0; }
      else if (qualityLevel === 1 && fpsEma < 30) { downgradeQuality(); qualityTimer = 0; }
    }
  }
  elapsed += dt;

  if (!started) {
    // 菜单背景：环绕摄像机
    const t = elapsed * 0.12;
    const r = 26;
    camera.position.set(Math.cos(t) * r, 14, Math.sin(t) * r);
    camera.lookAt(0, 0, 0);
    if (gun) gun.visible = false;
  } else {
    if (shooting && local.locked && local.alive) {
      if (local.tryFire()) { fireVisual(); updateAmmoHud(); }
    }
    local.stepFrame(dt);
    local.renderCamera();
    updateRemotes(dt);

    // ---- 枪械动画：后坐力 + 微晃 + 瞄准收枪 + 换弹下沉 + 切枪抬起 ----
    const w = local.weaponDef();
    recoil *= Math.exp(-12 * dt);
    aimAmount += ((aiming ? 1 : 0) - aimAmount) * Math.min(1, 10 * dt);
    const sway = 1 - aimAmount;
    const gb = GUN_BASE[local.weapon] || GUN_BASE.pistol;
    const ab = ADS_BASE[local.weapon] || ADS_BASE.pistol;
    const rp = local.reloadProgress();      // 0~1（换弹中）
    const sp = local.swapProgress();        // 0~1（切枪中）
    const reloadDip = rp > 0 ? Math.sin(rp * Math.PI) : 0;
    const swapDip = sp > 0 && sp < 1 ? (1 - sp) : 0;
    const walk = Math.min(local.speed / 8, 1);
    const bobX = Math.sin(elapsed * 9) * 0.010 * walk * sway;
    const bobY = Math.abs(Math.cos(elapsed * 9)) * 0.012 * walk * sway;

    gun.visible = local.alive;
    gun.position.set(
      gb[0] + (ab[0] - gb[0]) * aimAmount + Math.sin(elapsed * 6.5) * 0.004 * sway + bobX,
      gb[1] + (ab[1] - gb[1]) * aimAmount + Math.sin(elapsed * 1.7) * 0.004 * sway + bobY
        - reloadDip * 0.13 - swapDip * 0.32,
      gb[2] + (ab[2] - gb[2]) * aimAmount + recoil
    );
    gun.rotation.set(
      recoil * 1.5 + reloadDip * 0.40 + swapDip * 0.70,
      reloadDip * 0.30,
      reloadDip * 0.55
    );

    // 准星随当前散布扩散（移动/连发变大，ADS 收紧）
    if (crosshairEl) {
      crosshairEl.classList.toggle('aiming', aiming);
      const size = 14 + Math.min(local.currentSpreadRad() * 900, 46);
      crosshairEl.style.width = size.toFixed(1) + 'px';
      crosshairEl.style.height = size.toFixed(1) + 'px';
    }

    // 换弹进度条
    if (reloadWrapEl) {
      const on = rp > 0 && rp < 1;
      reloadWrapEl.classList.toggle('hidden', !on);
      if (on && reloadFillEl) reloadFillEl.style.width = (rp * 100).toFixed(1) + '%';
    }

    // 瞄准拉近视野（每把枪的 ADS FOV 不同）
    const targetFov = aiming ? w.adsFov : 75;
    if (Math.abs(camera.fov - targetFov) > 0.05) {
      camera.fov += (targetFov - camera.fov) * Math.min(1, 12 * dt);
      camera.updateProjectionMatrix();
    }
  }

  effects.update(dt);
  for (const s of itemMeshes.values()) {
    s.bob += dt * 2.4;
    s.group.position.y = Math.sin(s.bob) * 0.12 + 0.06;
    s.group.rotation.y += dt * 1.2;
  }
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}
loop();

// 调试辅助（供自动化测试/排查使用）
window.__game = {
  camera,
  get local() { return local; },
  get player() {
    return local ? {
      x: +local.pos.x.toFixed(2), y: +local.pos.y.toFixed(2), z: +local.pos.z.toFixed(2),
      yaw: +local.yaw.toFixed(2), pitch: +local.pitch.toFixed(2), hp: local.hp, grounded: local.grounded, weapon: local.weapon,
      sx: local.serverPos ? +local.serverPos.x.toFixed(2) : null,
      sy: local.serverPos ? +local.serverPos.y.toFixed(2) : null,
      sz: local.serverPos ? +local.serverPos.z.toFixed(2) : null,
      alive: local.alive, locked: local.locked,
      weapon: local.weapon,
      mag: local.ammoOf().mag,
      reserve: local.ammoOf().reserve === Infinity ? -1 : local.ammoOf().reserve,
      owned: Object.keys(local.owned),
      reloading: local.reloadUntil > 0,
      recoilPitch: +local.recoilPitch.toFixed(4),
      spread: +local.currentSpreadRad().toFixed(4),
      aiming: local.aiming,
    } : null;
  },
  get enemyTracers() { return enemyTracers; },
  get killCount() { return killCount; },
  get itemCount() { return itemMeshes.size; },
  get tracerCount() { return effects.tracers.length; },
  get remotes() {
    return [...remotes.values()].map((r) => ({
      name: r.name,
      x: +r.group.position.x.toFixed(2),
      y: +r.group.position.y.toFixed(2),
      z: +r.group.position.z.toFixed(2),
      hp: r.target.hp,
      alive: r.target.alive,
    }));
  },
};

// ---------- 自适应 ----------
window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);
});
