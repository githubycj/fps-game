// ===== 构建 3D 场景：明亮低多边形竞技场（静态几何合并以减少绘制调用）=====
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WORLD, TERRAIN, BOUNDARY, SPAWNS } from '../shared/map.js';

// 按 kind 分区配色（低饱和浅色调，跨度小、区分明显）
const PALETTE = {
  platform: { body: 0xdff3f0, top: 0xb8e8e0, edge: 0x5fb8a8 },
  arena:    { body: 0xf7e8d8, top: 0xf2d8b8, edge: 0xc9a06a },
  wall:     { body: 0xe6e4f7, top: 0xcfd4f5, edge: 0x8f96d8 },
};

export function buildWorld(scene) {
  const raycastTargets = [];

  // 地面（浅灰蓝）
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD.size, WORLD.size),
    new THREE.MeshStandardMaterial({ color: 0xe2e9f1, roughness: 0.95, metalness: 0.05 })
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  raycastTargets.push(floor);

  // 浅色网格
  const grid = new THREE.GridHelper(WORLD.size, 24, 0x9fbcd8, 0xc3d5e8);
  grid.position.y = 0.02;
  grid.material.transparent = true;
  grid.material.opacity = 0.55;
  scene.add(grid);

  const mtx = new THREE.Matrix4();
  const groups = { body: {}, top: {}, edge: {}, accent: [], rim: [] };
  for (const kind of ['platform', 'arena', 'wall']) {
    groups.body[kind] = [];
    groups.top[kind] = [];
    groups.edge[kind] = [];
  }

  for (const o of TERRAIN) {
    const kind = PALETTE[o.kind] ? o.kind : 'platform';
    const body = new THREE.BoxGeometry(o.w, o.h, o.d);
    mtx.makeTranslation(o.x, o.h / 2, o.z);
    body.applyMatrix4(mtx);
    groups.body[kind].push(body);

    const top = new THREE.BoxGeometry(o.w - 0.12, 0.06, o.d - 0.12);
    mtx.makeTranslation(o.x, o.h + 0.03, o.z);
    top.applyMatrix4(mtx);
    groups.top[kind].push(top);

    const edge = new THREE.EdgesGeometry(new THREE.BoxGeometry(o.w, o.h, o.d));
    edge.applyMatrix4(mtx);
    groups.edge[kind].push(edge);

    if (o.kind === 'wall') {
      for (const sx of [-1, 1]) {
        const bar = new THREE.BoxGeometry(0.1, o.h - 0.4, 0.1);
        mtx.makeTranslation(o.x + sx * (o.w / 2 - 0.3), 0.2 + (o.h - 0.4) / 2, o.z);
        bar.applyMatrix4(mtx);
        groups.accent.push(bar);
      }
    } else if (o.kind === 'arena') {
      const rim = new THREE.BoxGeometry(o.w + 0.2, 0.08, o.d + 0.2);
      mtx.makeTranslation(o.x, 0.04, o.z);
      rim.applyMatrix4(mtx);
      groups.rim.push(rim);
    }
  }

  const bodyMat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.75, metalness: 0.1 });
  const topMat = (c) => new THREE.MeshBasicMaterial({ color: c });
  const edgeMat = (c) => new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.9 });

  const addMerged = (geos, mat, raycast = false, line = false) => {
    if (!geos.length) return null;
    const merged = mergeGeometries(geos, false);
    const obj = line ? new THREE.LineSegments(merged, mat) : new THREE.Mesh(merged, mat);
    scene.add(obj);
    if (raycast) raycastTargets.push(obj);
    return obj;
  };

  for (const kind of ['platform', 'arena', 'wall']) {
    const pal = PALETTE[kind];
    addMerged(groups.body[kind], bodyMat(pal.body), true);
    addMerged(groups.top[kind], topMat(pal.top), true);
    addMerged(groups.edge[kind], edgeMat(pal.edge), false, true);
  }
  addMerged(groups.accent, topMat(0x8f96d8), true);
  addMerged(groups.rim, topMat(0xe8c49a), true);

  // 边界墙（浅蓝）
  const wallGeos = [], wallTopGeos = [];
  for (const o of BOUNDARY) {
    const g = new THREE.BoxGeometry(o.w, o.h, o.d);
    mtx.makeTranslation(o.x, o.h / 2, o.z);
    g.applyMatrix4(mtx);
    wallGeos.push(g);
    const tg = new THREE.BoxGeometry(o.w, 0.1, o.d);
    mtx.makeTranslation(o.x, o.h, o.z);
    tg.applyMatrix4(mtx);
    wallTopGeos.push(tg);
  }
  addMerged(wallGeos, new THREE.MeshBasicMaterial({ color: 0xa8c8ec, transparent: true, opacity: 0.35 }), true);
  addMerged(wallTopGeos, topMat(0x7fa8d8), true);

  // 出生点光柱
  const pillGeos = [];
  for (const s of SPAWNS) {
    const g = new THREE.CylinderGeometry(0.12, 0.12, 0.9, 8);
    mtx.makeTranslation(s.x, 0.45, s.z);
    g.applyMatrix4(mtx);
    pillGeos.push(g);
  }
  addMerged(pillGeos, new THREE.MeshBasicMaterial({ color: 0xa8c8ec, transparent: true, opacity: 0.5 }), true);

  return { raycastTargets };
}