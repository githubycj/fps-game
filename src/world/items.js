// ===== 地面拾取物模型（createItemMesh）=====
// 武器箱 / 医疗箱 / 护盾球 / 加速装置 / 弹药箱。
// 每个 Group 结构：root → bobRoot（浮动+旋转，由 world.update 驱动）→ 静态几何 + 悬浮标记。
// 同类型共享模板（clone 复用几何/材质），每件 2 个 draw call。
import * as THREE from 'three';
import { addBoxGeo, addTorusGeo, pushPainted, mergePainted, normalizeGeo, paintGeo } from './geom.js';

const WEAPON_IDS = new Set(['pistol', 'smg', 'ak47', 'shotgun', 'sniper']);
const MARKER_COLORS = {
  ak47: 0xffb366,
  shotgun: 0xa8d16a,
  sniper: 0x7fb6ff,
  smg: 0xc79fff,
  pistol: 0xd8d8d8,
  medkit: 0xff7f8a,
  shield: 0x7fd4ff,
  speed: 0x9be08a,
  ammo: 0xffd76a,
  crate: 0xd9b06a,
};

export function createItemFactory({ preset } = {}) {
  const p = preset || {};
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.62, metalness: 0.18, dithering: true,
  });
  const shellMat = new THREE.MeshStandardMaterial({
    color: 0x7fd4ff, emissive: 0x2a6f9a, emissiveIntensity: 0.9,
    roughness: 0.15, metalness: 0.3, transparent: true, opacity: 0.42,
    depthWrite: false, dithering: true,
  });
  const markerMat = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  const materials = [bodyMat, shellMat, markerMat];

  const templateCache = new Map();
  const tracked = [];
  let disposed = false;

  // ---------- 悬浮标记（小八面体，加色发光）----------
  function makeMarker(colorHex) {
    const geo = new THREE.OctahedronGeometry(0.115, 0);
    geo.translate(0, 1.18, 0);
    const g = normalizeGeo(geo);
    paintGeo(g, colorHex);
    const mesh = new THREE.Mesh(g, markerMat);
    mesh.name = 'itemMarker';
    return mesh;
  }

  // ---------- 武器箱：木箱 + 铁箍 + 顶部枪械剪影 ----------
  function buildWeaponCrate(type) {
    const geos = [];
    addBoxGeo(geos, 0x8f6f4c, 0, 0.3, 0, 0.92, 0.5, 0.62);
    // 木箱板缝
    for (const z of [-0.19, 0, 0.19]) {
      addBoxGeo(geos, 0x7a5c3d, 0, 0.3, z * 0.98, 0.94, 0.42, 0.02);
    }
    // 铁箍
    const bandColor = MARKER_COLORS[type] || 0xb08a55;
    addBoxGeo(geos, 0x4a4741, -0.28, 0.3, 0, 0.09, 0.54, 0.66);
    addBoxGeo(geos, 0x4a4741, 0.28, 0.3, 0, 0.09, 0.54, 0.66);
    addBoxGeo(geos, bandColor, 0, 0.56, 0, 0.5, 0.05, 0.42);
    // 顶盖
    addBoxGeo(geos, 0x9a7b52, 0, 0.57, 0, 0.9, 0.06, 0.6);
    // 枪械剪影（简化：机匣 + 枪管 + 弹匣 + 枪托，朝向 +X）
    const metal = 0x3a3936;
    addBoxGeo(geos, metal, 0, 0.65, 0, 0.5, 0.1, 0.09);
    addBoxGeo(geos, 0x2f2e2b, 0.34, 0.66, 0, 0.28, 0.05, 0.05);
    addBoxGeo(geos, 0x6b4f34, -0.32, 0.64, 0, 0.2, 0.11, 0.07);
    addBoxGeo(geos, metal, 0.04, 0.58, 0, 0.08, 0.14, 0.06);
    // 类型识别色块
    addBoxGeo(geos, bandColor, -0.36, 0.45, 0.315, 0.18, 0.1, 0.02);
    return mergePainted(geos);
  }

  // ---------- 医疗箱 ----------
  function buildMedkit() {
    const geos = [];
    addBoxGeo(geos, 0xf0ede2, 0, 0.22, 0, 0.5, 0.3, 0.4);
    addBoxGeo(geos, 0xd8d3c4, 0, 0.37, 0, 0.46, 0.04, 0.36);
    // 红十字（顶面 + 两个侧面）
    addBoxGeo(geos, 0xd84050, 0, 0.2, 0.202, 0.28, 0.09, 0.01);
    addBoxGeo(geos, 0xd84050, 0, 0.2, 0.202, 0.09, 0.28, 0.01);
    addBoxGeo(geos, 0xd84050, 0.251, 0.2, 0, 0.01, 0.09, 0.24);
    addBoxGeo(geos, 0xd84050, 0.251, 0.2, 0, 0.01, 0.24, 0.09);
    // 提手
    addBoxGeo(geos, 0x8a8578, 0, 0.44, 0, 0.24, 0.04, 0.05);
    return mergePainted(geos);
  }

  // ---------- 护盾球 ----------
  function buildShield() {
    const geos = [];
    const sphere = new THREE.IcosahedronGeometry(0.29, 1);
    sphere.translate(0, 0.52, 0);
    pushPainted(geos, sphere, 0x9fdcff);
    const ring = new THREE.TorusGeometry(0.36, 0.022, 6, 20);
    ring.rotateX(Math.PI / 2);
    ring.translate(0, 0.52, 0);
    pushPainted(geos, ring, 0xe4f6ff);
    const base = new THREE.CylinderGeometry(0.3, 0.36, 0.08, 12);
    base.translate(0, 0.05, 0);
    pushPainted(geos, base, 0x6f9fb5);
    return mergePainted(geos);
  }

  // ---------- 加速装置 ----------
  function buildSpeed() {
    const geos = [];
    const base = new THREE.CylinderGeometry(0.24, 0.3, 0.08, 10);
    base.translate(0, 0.05, 0);
    pushPainted(geos, base, 0x5c6b4e);
    const cone = new THREE.ConeGeometry(0.16, 0.34, 6);
    cone.rotateZ(-Math.PI / 2);
    cone.translate(0.02, 0.36, 0);
    pushPainted(geos, cone, 0x9be08a);
    for (const dz of [0.17, -0.17]) {
      addBoxGeo(geos, 0x6fae5f, -0.22, 0.36, dz, 0.18, 0.05, 0.06);
    }
    const ring = new THREE.TorusGeometry(0.26, 0.02, 5, 14);
    ring.rotateX(Math.PI / 2);
    ring.translate(0, 0.36, 0);
    pushPainted(geos, ring, 0xc8ffb4);
    return mergePainted(geos);
  }

  // ---------- 弹药箱 ----------
  function buildAmmo() {
    const geos = [];
    addBoxGeo(geos, 0x5f6440, 0, 0.18, 0, 0.56, 0.28, 0.36);
    addBoxGeo(geos, 0x4e5336, 0, 0.33, 0, 0.52, 0.04, 0.33);
    addBoxGeo(geos, 0xb08f4a, 0, 0.2, 0.182, 0.2, 0.1, 0.01);
    // 子弹（顶部）
    for (let i = 0; i < 3; i++) {
      const x = -0.14 + i * 0.14;
      const c = new THREE.CylinderGeometry(0.035, 0.035, 0.16, 6);
      c.translate(x, 0.42, 0);
      pushPainted(geos, c, 0xc9a24e);
      const tip = new THREE.ConeGeometry(0.035, 0.07, 6);
      tip.translate(x, 0.535, 0);
      pushPainted(geos, tip, 0xa8843c);
    }
    return mergePainted(geos);
  }

  function buildTemplate(type) {
    const root = new THREE.Group();
    root.name = `item_${type}`;
    const bobRoot = new THREE.Group();
    bobRoot.name = 'bobRoot';
    root.add(bobRoot);

    let body = null;
    let shell = null;
    if (WEAPON_IDS.has(type)) body = buildWeaponCrate(type);
    else if (type === 'medkit') body = buildMedkit();
    else if (type === 'speed') body = buildSpeed();
    else if (type === 'ammo') body = buildAmmo();
    else if (type === 'shield') shell = buildShield();
    else body = buildWeaponCrate('crate');

    if (body) {
      const mesh = new THREE.Mesh(body, bodyMat);
      mesh.name = 'itemBody';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      bobRoot.add(mesh);
    }
    if (shell) {
      const mesh = new THREE.Mesh(shell, shellMat);
      mesh.name = 'itemShell';
      bobRoot.add(mesh);
    }
    const marker = makeMarker(MARKER_COLORS[type] || MARKER_COLORS.crate);
    bobRoot.add(marker);

    root.userData = { itemType: type, bobRoot, marker, anim: 0, phase: Math.random() * Math.PI * 2 };
    return root;
  }

  function createItemMesh(type) {
    const key = WEAPON_IDS.has(type) ? type : type || 'crate';
    let tpl = templateCache.get(key);
    if (!tpl) {
      tpl = buildTemplate(key);
      templateCache.set(key, tpl);
    }
    const mesh = tpl.clone(true);
    mesh.userData = {
      itemType: key,
      bobRoot: mesh.getObjectByName('bobRoot'),
      marker: mesh.getObjectByName('itemMarker'),
      anim: 0,
      phase: Math.random() * Math.PI * 2,
    };
    tracked.push(mesh);
    return mesh;
  }

  // 每帧：浮动 + 旋转 + 标记脉动（低档也保留，成本极低）
  function update(dt) {
    if (disposed) return;
    const glow = p.label !== '低';
    for (let i = 0; i < tracked.length; i++) {
      const it = tracked[i];
      const ud = it.userData;
      if (!ud || !ud.bobRoot) continue;
      ud.anim += dt;
      const t = ud.anim;
      ud.bobRoot.position.y = 0.05 + Math.sin(t * 2.2 + ud.phase) * 0.055;
      ud.bobRoot.rotation.y += dt * 0.85;
      if (ud.marker) {
        const s = glow ? 1 + Math.sin(t * 3.2 + ud.phase) * 0.14 : 1;
        ud.marker.scale.setScalar(s);
        ud.marker.rotation.y -= dt * 1.7;
      }
    }
  }

  // 拾取/销毁时可由外部调用，避免 tracked 无限增长
  function forget(group) {
    const i = tracked.indexOf(group);
    if (i >= 0) tracked.splice(i, 1);
  }

  function dispose() {
    disposed = true;
    // 把已创建并挂到场景上的拾取物一并移除，避免 world.dispose 后残留
    for (const g of tracked) {
      if (g.parent) g.parent.remove(g);
    }
    tracked.length = 0;
    for (const tpl of templateCache.values()) {
      tpl.traverse((o) => {
        if (o.isMesh && o.geometry) o.geometry.dispose();
      });
    }
    templateCache.clear();
    for (const m of materials) m.dispose();
  }

  return { createItemMesh, update, forget, tracked, dispose };
}
