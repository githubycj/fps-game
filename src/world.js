// ===== 构建 3D 场景：明亮低多边形竞技场（静态几何合并以减少绘制调用）=====
// 视觉取向：分层配色（底座 / 主体 / 顶面 / 描边）+ 渐变天空 + 柔和阴影，保证明亮可读又有层次。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WORLD, TERRAIN, BOUNDARY, SPAWNS } from '../shared/map.js';

// 按 kind 分区配色：body=侧面主体，top=顶面，edge=描边，base=底部裙边
const PALETTE = {
  platform: { body: 0xcfe0ee, top: 0x8fd0e8, edge: 0x4d90b4, base: 0x9fb8cc },
  arena:    { body: 0xf0dfc8, top: 0xf2b96e, edge: 0xb07d3c, base: 0xcbb193 },
  wall:     { body: 0xd8d6ee, top: 0xa6a8e8, edge: 0x6f74b8, base: 0xa9a7c6 },
};

const SHADOW_SIZE = 1024;

// 地面棋盘 + 细网格（Canvas 生成，避免大量几何）
function makeGroundTexture() {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#e9f0f8';
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = '#dee8f3';
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillRect(128, 128, 128, 128);
  ctx.strokeStyle = 'rgba(110,145,180,0.28)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 256; i += 32) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 256); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(256, i); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(WORLD.size / 10, WORLD.size / 10);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 软件渲染（SwiftShader / llvmpipe 等）下关闭阴影：填充与深度开销极高，收益却很低
function isSoftwareRenderer(renderer) {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '') : '';
    return /swiftshader|software|llvmpipe|basic render/i.test(name);
  } catch { return false; }
}

// 垂直渐变天空：上方浅蓝 → 地平线近白
function makeSkyTexture() {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 4; c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0.0, '#9fc9e8');
  g.addColorStop(0.45, '#cfe4f5');
  g.addColorStop(1.0, '#f2f7fb');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function buildWorld(scene, renderer, opts = {}) {
  const raycastTargets = [];

  // ---------- 天空 / 雾 ----------
  const sky = makeSkyTexture();
  if (sky) scene.background = sky;
  else scene.background = new THREE.Color(0xcfe4f5);
  scene.fog = new THREE.Fog(0xdceaf6, 60, 190);

  // ---------- 灯光：半球补光 + 主光（投影） + 环境 ----------
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb9d2e8, 0.85));
  const sun = new THREE.DirectionalLight(0xfff6e8, 1.5);
  sun.position.set(38, 62, 26);
  const softRenderer = opts.soft != null ? !!opts.soft : (renderer ? isSoftwareRenderer(renderer) : false);
  if (renderer && !softRenderer) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    sun.castShadow = true;
    const s = WORLD.half + 6;
    sun.shadow.camera.left = -s;
    sun.shadow.camera.right = s;
    sun.shadow.camera.top = s;
    sun.shadow.camera.bottom = -s;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 180;
    sun.shadow.mapSize.set(SHADOW_SIZE, SHADOW_SIZE);
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.02;
  }
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0xffffff, 0.42));
  // 反向补光（冷色），减少阴影死黑
  const fill = new THREE.DirectionalLight(0xbcd8f5, 0.35);
  fill.position.set(-30, 26, -34);
  scene.add(fill);

  // ---------- 地面 ----------
  const groundTex = makeGroundTexture();
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD.size, WORLD.size),
    new THREE.MeshStandardMaterial({ color: 0xffffff, map: groundTex || null, roughness: 0.95, metalness: 0.02 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  raycastTargets.push(floor);

  // 中心区域柔光标记（浅色圆盘，帮助定位中央擂台）
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(11, 48),
    new THREE.MeshBasicMaterial({ color: 0xf3c98f, transparent: true, opacity: 0.22 })
  );
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.015;
  scene.add(disc);

  // ---------- 地形：底座 + 主体 + 顶面 + 描边 ----------
  const mtx = new THREE.Matrix4();
  const groups = { body: {}, top: {}, edge: {}, base: {} };
  for (const kind of ['platform', 'arena', 'wall']) {
    groups.body[kind] = [];
    groups.top[kind] = [];
    groups.edge[kind] = [];
    groups.base[kind] = [];
  }

  for (const o of TERRAIN) {
    const kind = PALETTE[o.kind] ? o.kind : 'platform';

    // 主体
    const body = new THREE.BoxGeometry(o.w, o.h, o.d);
    mtx.makeTranslation(o.x, o.h / 2, o.z);
    body.applyMatrix4(mtx);
    groups.body[kind].push(body);

    // 顶部亮面（略内缩，形成"倒角"层次）
    const top = new THREE.BoxGeometry(o.w - 0.16, 0.07, o.d - 0.16);
    mtx.makeTranslation(o.x, o.h + 0.035, o.z);
    top.applyMatrix4(mtx);
    groups.top[kind].push(top);

    // 底部裙边（略外扩，压住地面接缝）
    const base = new THREE.BoxGeometry(o.w + 0.24, 0.1, o.d + 0.24);
    mtx.makeTranslation(o.x, 0.05, o.z);
    base.applyMatrix4(mtx);
    groups.base[kind].push(base);

    // 描边
    const edge = new THREE.EdgesGeometry(new THREE.BoxGeometry(o.w, o.h, o.d));
    edge.applyMatrix4(mtx);
    groups.edge[kind].push(edge);
  }

  const bodyMat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.72, metalness: 0.12 });
  const topMat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.55, metalness: 0.18 });
  const edgeMat = (c) => new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.85 });

  const addMerged = (geos, mat, { raycast = false, line = false, shadow = false } = {}) => {
    if (!geos.length) return null;
    const merged = mergeGeometries(geos, false);
    const obj = line ? new THREE.LineSegments(merged, mat) : new THREE.Mesh(merged, mat);
    if (!line) {
      obj.castShadow = shadow;
      obj.receiveShadow = shadow;
    }
    scene.add(obj);
    if (raycast) raycastTargets.push(obj);
    return obj;
  };

  for (const kind of ['platform', 'arena', 'wall']) {
    const pal = PALETTE[kind];
    addMerged(groups.base[kind], bodyMat(pal.base), { shadow: false });
    addMerged(groups.body[kind], bodyMat(pal.body), { raycast: true, shadow: true });
    addMerged(groups.top[kind], topMat(pal.top), { raycast: true, shadow: true });
    addMerged(groups.edge[kind], edgeMat(pal.edge), { line: true });
  }

  // ---------- 装饰：掩体墙霓虹条 / 擂台四角光柱 ----------
  const accentGeos = [];
  for (const o of TERRAIN) {
    if (o.kind === 'wall') {
      for (const sx of [-1, 1]) {
        const bar = new THREE.BoxGeometry(0.09, o.h - 0.5, 0.09);
        mtx.makeTranslation(o.x + sx * (o.w / 2 - 0.26), 0.25 + (o.h - 0.5) / 2, o.z);
        bar.applyMatrix4(mtx);
        accentGeos.push(bar);
      }
    }
  }
  addMerged(accentGeos, new THREE.MeshBasicMaterial({ color: 0x7f8fd8 }));

  const arena = TERRAIN.find((o) => o.kind === 'arena');
  if (arena) {
    const postGeos = [];
    const hw = arena.w / 2 - 0.35, hd = arena.d / 2 - 0.35;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const g = new THREE.CylinderGeometry(0.09, 0.09, 0.7, 8);
        mtx.makeTranslation(arena.x + sx * hw, arena.h + 0.35, arena.z + sz * hd);
        g.applyMatrix4(mtx);
        postGeos.push(g);
      }
    }
    addMerged(postGeos, new THREE.MeshBasicMaterial({ color: 0xf0a860 }));
  }

  // ---------- 边界墙：半透明体 + 顶部亮条 ----------
  const wallGeos = [], wallTopGeos = [];
  for (const o of BOUNDARY) {
    const g = new THREE.BoxGeometry(o.w, o.h, o.d);
    mtx.makeTranslation(o.x, o.h / 2, o.z);
    g.applyMatrix4(mtx);
    wallGeos.push(g);
    const tg = new THREE.BoxGeometry(o.w, 0.12, o.d);
    mtx.makeTranslation(o.x, o.h, o.z);
    tg.applyMatrix4(mtx);
    wallTopGeos.push(tg);
  }
  addMerged(wallGeos, new THREE.MeshBasicMaterial({ color: 0x9dc4ea, transparent: true, opacity: 0.28 }));
  addMerged(wallTopGeos, new THREE.MeshBasicMaterial({ color: 0x5f92c8 }));

  // ---------- 边界内侧霓虹柱（远景视觉锚点） ----------
  const pillarGeos = [], capGeos = [];
  const PI = WORLD.half - 3.5;
  for (const [px, pz] of [[-PI, -PI], [PI, -PI], [-PI, PI], [PI, PI]]) {
    const g = new THREE.BoxGeometry(0.5, 6.5, 0.5);
    mtx.makeTranslation(px, 3.25, pz);
    g.applyMatrix4(mtx);
    pillarGeos.push(g);
    const c = new THREE.BoxGeometry(0.8, 0.35, 0.8);
    mtx.makeTranslation(px, 6.65, pz);
    c.applyMatrix4(mtx);
    capGeos.push(c);
  }
  addMerged(pillarGeos, bodyMat(0xc6d4e4));
  addMerged(capGeos, new THREE.MeshBasicMaterial({ color: 0x6fb4e8 }));

  // ---------- 出生点光柱 ----------
  const pillGeos = [];
  for (const s of SPAWNS) {
    const g = new THREE.CylinderGeometry(0.14, 0.14, 0.9, 8);
    mtx.makeTranslation(s.x, 0.45, s.z);
    g.applyMatrix4(mtx);
    pillGeos.push(g);
  }
  addMerged(pillGeos, new THREE.MeshBasicMaterial({ color: 0x8fc0ea, transparent: true, opacity: 0.55 }));

  return { raycastTargets, sun, softRenderer };
}
