// ===== 霓虹战场 · 客户端主入口 =====
import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { WORLD, PLAYER_COLORS, WEAPONS } from '../shared/map.js';
import { Net, wsUrl } from './net.js';
import { buildWorld } from './world.js';
import { LocalPlayer } from './player.js';
import { Effects } from './effects.js';
import { initAudio, sfx } from './audio.js';

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
function setWeaponHud(w) { if (weaponEl) weaponEl.textContent = w === 'ak47' ? 'AK47' : '手枪'; }
const toastsEl = $('toasts');

// ---------- 渲染器 / 场景 ----------
const renderer = new THREE.WebGLRenderer({
  canvas: $('game'),
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xcfe4f5);
scene.fog = new THREE.FogExp2(0xcfe4f5, 0.0035);

scene.add(new THREE.HemisphereLight(0xffffff, 0xbfd9f0, 1.0));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(30, 50, 20);
scene.add(sun);
scene.add(new THREE.AmbientLight(0xffffff, 0.5));

const world = buildWorld(scene);
const effects = new Effects(scene);

const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 400);
camera.rotation.order = 'YXZ';
scene.add(camera);

// ---------- 枪械模型（挂在相机上） ----------
const gunBase = new THREE.Vector3(0.32, -0.28, -0.5);
const adsBase = new THREE.Vector3(0, -0.16, -0.42);
let aiming = false;
let aimAmount = 0;
function buildGunModel(kind) {
  const g = new THREE.Group();
  const metalMat = new THREE.MeshStandardMaterial({ color: 0x39404f, metalness: 0.75, roughness: 0.35 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x22262f, metalness: 0.5, roughness: 0.55 });
  const polyMat = new THREE.MeshStandardMaterial({ color: 0x4a5160, metalness: 0.2, roughness: 0.7 });
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x8a6a3a, roughness: 0.75, metalness: 0.05 });
  const glowMat = new THREE.MeshBasicMaterial({ color: kind === 'ak47' ? 0xffb066 : 0x7fd4ff });

  const box = (w, h, d, x, y, z, mat = metalMat, rx = 0, rz = 0) => {
    const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    o.position.set(x, y, z);
    if (rx) o.rotation.x = rx;
    if (rz) o.rotation.z = rz;
    g.add(o);
    return o;
  };
  const cyl = (r, len, x, y, z, mat = metalMat, seg = 10) => {
    const o = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg), mat);
    o.rotation.x = Math.PI / 2;
    o.position.set(x, y, z);
    g.add(o);
    return o;
  };

  if (kind === 'ak47') {
    // 机匣 / 防尘盖 / 导轨
    box(0.075, 0.09, 0.5, 0, 0.02, -0.32);
    box(0.062, 0.03, 0.34, 0, 0.085, -0.3, darkMat);
    for (let i = 0; i < 5; i++) box(0.07, 0.012, 0.02, 0, 0.105, -0.44 + i * 0.07, darkMat);
    // 枪管 / 气导管 / 气块
    cyl(0.024, 0.5, 0, 0.02, -0.85);
    cyl(0.016, 0.34, 0, 0.072, -0.62);
    box(0.04, 0.06, 0.05, 0, 0.065, -0.78, darkMat);
    // 枪口制退器
    cyl(0.03, 0.09, 0, 0.02, -1.08, darkMat);
    box(0.07, 0.012, 0.06, 0, 0.02, -1.08, darkMat);
    // 准星
    box(0.022, 0.05, 0.02, 0, 0.1, -0.9, darkMat);
    box(0.012, 0.03, 0.02, 0.024, 0.09, -0.9, darkMat);
    // 护木（木质）
    box(0.07, 0.08, 0.26, 0, -0.01, -0.6, woodMat);
    box(0.062, 0.03, 0.2, 0, -0.055, -0.6, darkMat);
    // 弹匣（弧形两段）
    box(0.06, 0.16, 0.09, 0, -0.12, -0.3, darkMat, 0.18);
    box(0.055, 0.12, 0.08, 0, -0.235, -0.255, darkMat, 0.42);
    // 握把（木质）+ 扳机护圈
    box(0.05, 0.16, 0.07, 0, -0.13, -0.12, woodMat, 0.3);
    box(0.05, 0.012, 0.09, 0, -0.085, -0.2, darkMat);
    box(0.012, 0.03, 0.012, 0, -0.055, -0.2, darkMat);
    // 枪托（木）+ 托底
    box(0.05, 0.09, 0.3, 0, -0.015, 0.2, woodMat);
    box(0.05, 0.12, 0.02, 0, -0.02, 0.36, darkMat);
    // 拉机柄 + 侧发光条
    box(0.03, 0.02, 0.07, 0.055, 0.05, -0.2, metalMat);
    box(0.078, 0.012, 0.2, 0, 0.045, -0.3, glowMat);
  } else {
    // 套筒 / 套筒齿纹
    box(0.075, 0.085, 0.42, 0, 0.045, -0.32);
    for (let i = 0; i < 4; i++) box(0.078, 0.05, 0.012, 0, 0.045, -0.14 - i * 0.028, darkMat);
    // 枪身 / 枪管 / 枪口
    box(0.07, 0.07, 0.34, 0, -0.045, -0.28, polyMat);
    cyl(0.022, 0.18, 0, 0.04, -0.56);
    cyl(0.026, 0.05, 0, 0.04, -0.65, darkMat);
    // 准星 / 照门
    box(0.012, 0.03, 0.02, 0, 0.098, -0.5, darkMat);
    box(0.014, 0.026, 0.014, -0.024, 0.096, -0.14, darkMat);
    box(0.014, 0.026, 0.014, 0.024, 0.096, -0.14, darkMat);
    // 扳机护圈 / 扳机
    box(0.052, 0.012, 0.1, 0, -0.082, -0.27, darkMat);
    box(0.012, 0.032, 0.012, 0, -0.055, -0.26, darkMat);
    // 握把 + 握把贴片
    box(0.055, 0.16, 0.08, 0, -0.14, -0.2, polyMat, 0.28);
    box(0.058, 0.1, 0.05, 0, -0.15, -0.19, darkMat, 0.28);
    // 弹匣底板 / 滑套释放
    box(0.05, 0.03, 0.07, 0, -0.225, -0.185, darkMat);
    box(0.012, 0.014, 0.06, 0.04, -0.02, -0.18, darkMat);
    // 下导轨 + 光纤准心
    box(0.05, 0.02, 0.1, 0, -0.075, -0.45, darkMat);
    box(0.014, 0.014, 0.014, 0, 0.05, -0.56, glowMat);
  }

  g.position.copy(gunBase);
  camera.add(g);
  return g;
}

const gunPistol = buildGunModel('pistol');
const gunAk = buildGunModel('ak47');
gunAk.visible = false;
let gun = gunPistol;
function setWeaponGun(w) {
  const next = w === 'ak47' ? gunAk : gunPistol;
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
function createRemote(p) {
  const group = new THREE.Group();
  const color = p.color;

  const armorMat = new THREE.MeshStandardMaterial({ color: 0xf2f6fb, roughness: 0.45, metalness: 0.35 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x2a3242, roughness: 0.6, metalness: 0.4 });
  const accentMat = new THREE.MeshStandardMaterial({
    color, roughness: 0.4, metalness: 0.3, emissive: color, emissiveIntensity: 0.6,
  });
  const glowMat = new THREE.MeshBasicMaterial({ color });

  const box = (w, h, d, x, y, z, mat = armorMat, rotX = 0, rotZ = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    if (rotX) m.rotation.x = rotX;
    if (rotZ) m.rotation.z = rotZ;
    group.add(m);
    return m;
  };

  // 双腿（细腿 + 膝关节）
  box(0.16, 0.52, 0.2, -0.18, 0.38, 0);
  box(0.16, 0.52, 0.2, 0.18, 0.38, 0);
  box(0.2, 0.1, 0.24, -0.18, 0.58, 0, darkMat);
  box(0.2, 0.1, 0.24, 0.18, 0.58, 0, darkMat);
  // 髋部
  box(0.46, 0.18, 0.28, 0, 0.82, 0, darkMat);
  // 躯干（梯形感：前倾装甲块）
  box(0.44, 0.52, 0.32, 0, 1.12, 0);
  box(0.34, 0.4, 0.2, 0, 1.16, 0.1, accentMat);
  // 胸前核心灯
  box(0.14, 0.14, 0.06, 0, 1.18, 0.26, glowMat);
  // 倾斜肩甲（保罗肩）
  box(0.3, 0.14, 0.36, -0.5, 1.4, 0, accentMat, 0, 0.35);
  box(0.3, 0.14, 0.36, 0.5, 1.4, 0, accentMat, 0, -0.35);
  // 上臂
  box(0.12, 0.38, 0.12, -0.56, 1.18, 0, darkMat);
  box(0.12, 0.38, 0.12, 0.56, 1.18, 0, darkMat);
  // 背包 + 推进器
  box(0.3, 0.42, 0.18, 0, 1.0, -0.38, darkMat);
  box(0.1, 0.12, 0.08, -0.11, 0.86, -0.46, accentMat);
  box(0.1, 0.12, 0.08, 0.11, 0.86, -0.46, accentMat);
  // 头部（机甲面罩）
  box(0.42, 0.34, 0.42, 0, 1.74, 0, armorMat);
  // 发光双眼
  box(0.12, 0.06, 0.05, -0.09, 1.78, -0.22, glowMat);
  box(0.12, 0.06, 0.05, 0.09, 1.78, -0.22, glowMat);
  // 手持枪（侧挂）
  box(0.09, 0.14, 0.34, 0.34, 0.96, 0.12, darkMat);
  box(0.06, 0.06, 0.06, 0.34, 0.98, 0.28, glowMat);

  group.position.set(p.x, p.y, p.z);

  const label = document.createElement('div');
  label.className = 'name-tag';
  label.innerHTML = `<span class="dot" style="color:${hex(color)};background:${hex(color)}"></span>` +
    `<span class="nm">${esc(p.name)}</span>` + (p.bot ? '<span class="ai-tag">AI</span>' : '') +
    (p.bot ? `<span class="team-tag ${p.team === 'ally' ? 'ally' : 'enemy'}"></span>` : '');
  const labelObj = new CSS2DObject(label);
  labelObj.position.set(0, 2.45, 0);
  group.add(labelObj);

  scene.add(group);
  const state = {
    group, labelObj,
    name: p.name,
    target: { x: p.x, y: p.y, z: p.z, yaw: p.yaw, hp: p.hp, alive: p.alive },
  };
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
  } else {
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.14, 0.5), new THREE.MeshStandardMaterial({ color: 0x2a3242, roughness: 0.5 }));
    body.position.y = 0.46;
    group.add(body);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.3, 8), new THREE.MeshStandardMaterial({ color: 0x4a4a55 }));
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.46, -0.4);
    group.add(barrel);
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.18, 0.12), new THREE.MeshStandardMaterial({ color: 0x8a6a3a }));
    mag.position.set(0, 0.28, 0);
    group.add(mag);
  }
  const ring = new THREE.Mesh(
    new THREE.CylinderGeometry(0.7, 0.7, 0.05, 24, 1, true),
    new THREE.MeshBasicMaterial({ color: it.type === 'medkit' ? 0x7fe0c0 : (it.type === 'shield' ? 0x7fb0ff : (it.type === 'speed' ? 0x9be08a : 0xffb066)), transparent: true, opacity: 0.7 })
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
    r.group.position.x += (t.x - r.group.position.x) * k;
    r.group.position.y += (t.y - r.group.position.y) * k;
    r.group.position.z += (t.z - r.group.position.z) * k;
    const da = Math.atan2(Math.sin(t.yaw - r.group.rotation.y), Math.cos(t.yaw - r.group.rotation.y));
    r.group.rotation.y += da * k;
    r.group.visible = t.alive;
    // 名牌仅近距离显示（玩家 id）
    if (r.labelObj) {
      const dx = r.group.position.x - local.pos.x;
      const dz = r.group.position.z - local.pos.z;
      r.labelObj.visible = dx * dx + dz * dz < 15 * 15;
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

function fireVisual() {
  if (window.__game) window.__game.shotsFired = (window.__game.shotsFired || 0) + 1;
  sfx.shoot();
  recoil = 0.14;

  const muzzle = gun.localToWorld(new THREE.Vector3(0, 0, -0.9));
  effects.muzzleFlash(muzzle);

  camera.getWorldDirection(_dir);
  camera.getWorldPosition(_origin);
  _origin.y -= 0.12; // 枪口位置略低于视线中心
  raycaster.set(_origin, _dir);
  const hits = raycaster.intersectObjects(world.raycastTargets, false);
  let end;
  if (hits.length) {
    end = hits[0].point.clone();
    effects.impact(end, 0x00e5ff);
  } else {
    end = _origin.clone().addScaledVector(_dir, WORLD.shootRange);
  }
  effects.tracer(muzzle, end, 0x00e5ff);
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
  if (e.button === 0) shooting = false;
  if (e.button === 2) { aiming = false; if (local) local.aiming = false; }
});

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    if (local && local.locked && local.alive && local.grounded) sfx.jump();
    if (local) local.jumpHeld = true;
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
    local.weapon = me.weapon || 'pistol';
    setHp(me.hp);
    setWeaponHud(local.weapon);
    setWeaponGun(local.weapon);
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
net.on('pickup', (m) => {
  if (!m) return;
  if (m.type === 'ak47') {
    setWeaponGun('ak47');
    addToast('拾取 AK47 · 射速更快但弹道会偏');
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
  raycaster.set(origin, dir);
  raycaster.far = WORLD.shootRange;
  const hits = raycaster.intersectObjects(world.raycastTargets, false);
  const end = hits.length ? hits[0].point.clone() : origin.clone().addScaledVector(dir, WORLD.shootRange);
  effects.tracer(origin, end, 0xffb066); // 敌方/他人曳光：暖色
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
let qualityDowngraded = false;
function loop() {
  requestAnimationFrame(loop);
  const rawDt = clock.getDelta();
  const dt = Math.min(rawDt, 0.05);
  if (rawDt > 0) {
    fpsEma = fpsEma * 0.92 + (1 / rawDt) * 0.08;
    if (window.__game) window.__game.fps = Math.round(fpsEma);
    qualityTimer += rawDt;
    if (!qualityDowngraded && qualityTimer > 2 && fpsEma < 40) {
      qualityDowngraded = true;
      renderer.setPixelRatio(1); // 低帧自动降分辨率，保流畅
    }
  }
  elapsed += dt;

  if (!started) {
    // 菜单背景：环绕摄像机
    const t = elapsed * 0.12;
    const r = 26;
    camera.position.set(Math.cos(t) * r, 14, Math.sin(t) * r);
    camera.lookAt(0, 0, 0);
  } else {
    if (shooting && local.locked && local.alive) {
      if (local.tryFire(performance.now())) fireVisual();
    }
    local.stepFrame(dt);
    local.renderCamera();
    updateRemotes(dt);

    // 枪械动画：后坐力 + 微晃 + 瞄准收枪
    recoil *= Math.exp(-12 * dt);
    aimAmount += ((aiming ? 1 : 0) - aimAmount) * Math.min(1, 10 * dt);
    const sway = 1 - aimAmount;
    gun.position.set(
      gunBase.x + (adsBase.x - gunBase.x) * aimAmount + Math.sin(elapsed * 6.5) * 0.004 * sway,
      gunBase.y + (adsBase.y - gunBase.y) * aimAmount + Math.sin(elapsed * 1.7) * 0.004 * sway,
      gunBase.z + (adsBase.z - gunBase.z) * aimAmount + recoil
    );
    gun.rotation.x = recoil * 1.4;
    if (crosshairEl) crosshairEl.classList.toggle('aiming', aiming);
    // 瞄准拉近视野
    const targetFov = aiming ? WORLD.adsFov : 75;
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
