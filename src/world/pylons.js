// ===== 输电塔 / 悬链电缆 / 路边电线杆 =====
// 两座 26m 四腿斜桁架输电塔（与 shared 的四腿碰撞体同 footprint）+ 横担 + 绝缘子串 +
// 塔间悬链电缆（CatmullRom + TubeGeometry 下垂），以及纯视觉的路边电线杆 + 电线。
// 静态几何合并：钢构 / 混凝土 / 绝缘子 / 木杆各 1 draw，电缆 1 draw，电线 1 draw（LineSegments）。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PYLONS, WORLD, heightAt, insideStaticBox, ROADS } from './shared.js';
import { makeRustTexture } from './textures.js';

const V3 = THREE.Vector3;

// 局部坐标下的桁架杆件
function strut(list, a, b, thick) {
  const dir = new V3().subVectors(b, a);
  const len = dir.length();
  if (len < 0.02) return;
  dir.normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new V3(0, 1, 0), dir);
  const mid = new V3().addVectors(a, b).multiplyScalar(0.5);
  const g = new THREE.BoxGeometry(thick, len, thick);
  g.applyMatrix4(new THREE.Matrix4().compose(mid, q, new V3(1, 1, 1)));
  list.push(g);
}

// 基础几何 → 世界坐标 + 上色
function bake(list, matrix, colorHex, out) {
  const c = new THREE.Color(colorHex);
  for (const g0 of list) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    if (g !== g0) g0.dispose();
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    }
    if (!g.getAttribute('uv')) {
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    }
    if (matrix) g.applyMatrix4(matrix);
    const n = g.getAttribute('position').count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    out.push(g);
  }
  list.length = 0;
}

export function createPylons({ preset, anisotropy = 1 } = {}) {
  const p = preset || {};
  const group = new THREE.Group();
  group.name = 'pylons';
  const disposables = [];
  const raycastTargets = [];

  const steelGeos = [], concreteGeos = [], insulatorGeos = [], poleGeos = [], cableGeos = [];

  // ---------- 塔身 ----------
  const TOWER_H = 26;
  const levels = [0.45, 5.6, 11.2, 16.8, 21.5, TOWER_H];
  const hwAt = (y) => 2.35 - (2.35 - 0.95) * ((y - 0.45) / (TOWER_H - 0.45));
  const armLowerY = 21.5, armUpperY = 24.2;
  const armLowerLen = 4.5, armUpperLen = 3.3;
  const conductorY = { lower: armLowerY - 1.15, upper: armUpperY - 1.05 };
  const braces = Math.max(1, Math.min(5, p.towerBraces || 3));

  // 世界坐标挂点（供电缆使用）
  const attach = [];

  for (const tower of PYLONS) {
    const rot = tower.rot || 0;
    const h = tower.h || TOWER_H;
    const scale = h / TOWER_H;
    const mat = new THREE.Matrix4().compose(
      new V3(tower.x, tower.padH, tower.z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rot, 0)),
      new V3(1, 1, 1)
    );

    const steel = [], concrete = [], insul = [];

    // 四腿（逐层收分）
    for (let i = 0; i < levels.length - 1; i++) {
      const y0 = levels[i] * scale, y1 = levels[i + 1] * scale;
      const w0 = hwAt(levels[i]) * scale, w1 = hwAt(levels[i + 1]) * scale;
      const thick = 0.19 - i * 0.02;
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          strut(steel, new V3(sx * w0, y0, sz * w0), new V3(sx * w1, y1, sz * w1), thick);
        }
      }
      // 水平横杆
      if (i < levels.length - 1) {
        const y = y1;
        strut(steel, new V3(-w1, y, -w1), new V3(w1, y, -w1), 0.1);
        strut(steel, new V3(-w1, y, w1), new V3(w1, y, w1), 0.1);
        strut(steel, new V3(-w1, y, -w1), new V3(-w1, y, w1), 0.1);
        strut(steel, new V3(w1, y, -w1), new V3(w1, y, w1), 0.1);
      }
      // 四面 X 斜撑
      if (i < braces + 1) {
        const faces = [
          ['z', -w0, -w1], ['z', w0, w1], ['x', -w0, -w1], ['x', w0, w1],
        ];
        for (const [axis, o0, o1] of faces) {
          if (axis === 'z') {
            strut(steel, new V3(-w0, y0, o0), new V3(w1, y1, o1), 0.09);
            strut(steel, new V3(w0, y0, o0), new V3(-w1, y1, o1), 0.09);
          } else {
            strut(steel, new V3(o0, y0, -w0), new V3(o1, y1, w1), 0.09);
            strut(steel, new V3(o0, y0, w0), new V3(o1, y1, -w1), 0.09);
          }
        }
      }
    }

    // 塔顶小屋架 + 地线支架
    strut(steel, new V3(0, TOWER_H * scale, 0), new V3(0, (TOWER_H + 0.9) * scale, 0), 0.14);
    for (const sx of [-1, 1]) {
      strut(steel, new V3(sx * 0.95 * scale, TOWER_H * scale, 0), new V3(sx * 1.25 * scale, (TOWER_H + 0.5) * scale, 0), 0.08);
    }

    // 横担（±X 两个方向，上下两层）
    function buildArm(sign, yArm, armLen) {
      const inner = 0.9 * scale;
      const tipX = sign * armLen * scale;
      const y = yArm * scale;
      const tipY = y;
      // 上弦
      strut(steel, new V3(sign * inner, y, 0), new V3(tipX, tipY, 0), 0.13);
      // 下弦
      strut(steel, new V3(sign * inner, y - 1.9 * scale, 0), new V3(tipX, tipY, 0), 0.11);
      // 端部竖杆
      strut(steel, new V3(tipX, tipY, 0), new V3(tipX, tipY - 1.15 * scale, 0), 0.1);
      // 腹杆（竖向格构）
      const segs = 3;
      for (let i = 1; i <= segs; i++) {
        const t = i / (segs + 1);
        const x = sign * (inner + (armLen * scale - inner) * t);
        const bottomY = y - 1.9 * scale + 1.9 * scale * t;
        strut(steel, new V3(x, bottomY, 0), new V3(x, y, 0), 0.075);
      }
      // 绝缘子串（上下三片瓷瓶 + 挂杆），从横担端部垂下
      const insX = tipX;
      const insTop = y;
      for (let i = 0; i < 3; i++) {
        const discY = insTop - 0.22 * scale - i * 0.3 * scale;
        const g = new THREE.CylinderGeometry(0.2 * scale, 0.2 * scale, 0.09 * scale, 8);
        g.translate(insX, discY, 0);
        insul.push(g);
      }
      const rod = new THREE.CylinderGeometry(0.045 * scale, 0.045 * scale, 1.0 * scale, 6);
      rod.translate(insX, insTop - 0.55 * scale, 0);
      insul.push(rod);
      return new V3(insX, insTop - 1.12 * scale, 0);
    }

    const lowerR = buildArm(1, armLowerY, armLowerLen);
    const lowerL = buildArm(-1, armLowerY, armLowerLen);
    const upperR = buildArm(1, armUpperY, armUpperLen);
    const upperL = buildArm(-1, armUpperY, armUpperLen);

    // 混凝土基座（与 shared 碰撞体完全一致：1.8×1.8，y: padH-0.25 → padH+0.45）
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const g = new THREE.BoxGeometry(1.8, 0.7, 1.8);
        g.translate(sx * 2.35, 0.1, sz * 2.35);
        concrete.push(g);
        // 基座下的踢脚/斜台
        const g2 = new THREE.BoxGeometry(1.5, 0.18, 1.5);
        g2.translate(sx * 2.35, 0.52, sz * 2.35);
        concrete.push(g2);
      }
    }

    // 局部 → 世界
    bake(steel, mat, 0x9a958c, steelGeos);
    bake(concrete, mat, 0xa8a49a, concreteGeos);
    bake(insul, mat, 0xcfc9ba, insulatorGeos);

    // 记录电缆挂点（世界坐标）
    const toWorld = (v) => v.clone().applyMatrix4(mat);
    attach.push({
      id: tower.id || 'P',
      top: toWorld(new V3(0, (TOWER_H + 0.9) * scale, 0)),
      lowerR: toWorld(lowerR), lowerL: toWorld(lowerL),
      upperR: toWorld(upperR), upperL: toWorld(upperL),
    });
  }

  // ---------- 塔间悬链电缆 ----------
  function addCatenary(a, b, sag, radius, segs) {
    const pts = [];
    const steps = 9;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const y = a.y + (b.y - a.y) * t - sag * 4 * t * (1 - t);
      pts.push(new V3(x, y, z));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const tube = new THREE.TubeGeometry(curve, segs, radius, 5, false);
    cableGeos.push(tube);
  }

  if (attach.length >= 2) {
    const a = attach[0], b = attach[attach.length - 1];
    const segs = Math.max(8, Math.min(64, p.cableSegments || 40));
    const sagBase = 3.6;
    addCatenary(a.lowerR, b.lowerR, sagBase, 0.055, segs);
    addCatenary(a.lowerL, b.lowerL, sagBase, 0.055, segs);
    addCatenary(a.upperR, b.upperR, sagBase * 0.8, 0.05, segs);
    addCatenary(a.upperL, b.upperL, sagBase * 0.8, 0.05, segs);
    addCatenary(a.top, b.top, sagBase * 0.55, 0.04, Math.max(6, segs >> 1));
  }

  // ---------- 路边电线杆（纯视觉，不登记碰撞）----------
  const poleRows = [
    { axis: 'z', fixed: -(ROADS.mainWidth / 2 + 1.8) },
    { axis: 'z', fixed: (ROADS.mainWidth / 2 + 1.8) },
    { axis: 'x', fixed: -(ROADS.crossWidth / 2 + 1.8) },
    { axis: 'x', fixed: (ROADS.crossWidth / 2 + 1.8) },
  ];
  const wirePoints = [];
  const POLE_H = 8.4;

  for (const row of poleRows) {
    const list = [];   // 本排电杆的世界坐标与高度
    for (let t = -64; t <= 64; t += 16) {
      const x = row.axis === 'z' ? row.fixed : t;
      const z = row.axis === 'z' ? t : row.fixed;
      // 路口 / 建筑 / 掩体处跳过
      if (row.axis === 'z' && Math.abs(z) < 7) continue;
      if (row.axis === 'x' && Math.abs(x) < 7) continue;
      if (Math.abs(x) > WORLD.half - 4 || Math.abs(z) > WORLD.half - 4) continue;
      if (insideStaticBox(x, z, 0.9)) continue;
      list.push({ x, z, y: heightAt(x, z) });
    }
    // 木杆 + 横担（世界坐标，稍后统一烘焙上色）
    const poleLocal = [], poleInsulLocal = [];
    for (const q of list) {
      const pole = new THREE.CylinderGeometry(0.11, 0.15, POLE_H, 7);
      pole.translate(q.x, q.y + POLE_H / 2 - 0.25, q.z);
      poleLocal.push(pole);
      const armY = q.y + POLE_H - 1.1;
      const isZ = row.axis === 'z';
      const arm = new THREE.BoxGeometry(isZ ? 2.0 : 0.12, 0.13, isZ ? 0.12 : 2.0);
      arm.translate(q.x, armY, q.z);
      poleLocal.push(arm);
      // 横担绝缘子
      for (const off of [-0.75, 0, 0.75]) {
        const ix = isZ ? q.x + off : q.x;
        const iz = isZ ? q.z : q.z + off;
        const ins = new THREE.CylinderGeometry(0.055, 0.07, 0.14, 6);
        ins.translate(ix, armY + 0.14, iz);
        poleInsulLocal.push(ins);
      }
    }
    bake(poleLocal, null, 0x6d5c46, poleGeos);
    bake(poleInsulLocal, null, 0xcfc9ba, insulatorGeos);
    // 同排相邻电杆之间拉两根电线（带下垂）
    const isZ = row.axis === 'z';
    for (let i = 0; i < list.length - 1; i++) {
      const A = list[i], B = list[i + 1];
      for (const off of [-0.7, 0.7]) {
        const ax = isZ ? A.x + off : A.x;
        const az = isZ ? A.z : A.z + off;
        const bx = isZ ? B.x + off : B.x;
        const bz = isZ ? B.z : B.z + off;
        const ay = A.y + POLE_H - 0.95;
        const by = B.y + POLE_H - 0.95;
        const sag = 0.55;
        const steps = 6;
        let px = ax, py = ay, pz = az;
        for (let s = 1; s <= steps; s++) {
          const tt = s / steps;
          const x = ax + (bx - ax) * tt;
          const z = az + (bz - az) * tt;
          const y = ay + (by - ay) * tt - sag * 4 * tt * (1 - tt);
          wirePoints.push(px, py, pz, x, y, z);
          px = x; py = y; pz = z;
        }
      }
    }
  }

  // ---------- 材质与合并 ----------
  function mergeToMesh(list, material, name, opts = {}) {
    if (!list.length) return null;
    const merged = mergeGeometries(list, false);
    for (const g of list) g.dispose();
    if (!merged) return null;
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = name;
    mesh.castShadow = opts.cast !== false;
    mesh.receiveShadow = opts.receive !== false;
    group.add(mesh);
    disposables.push(merged);
    if (opts.raycast) raycastTargets.push(mesh);
    return mesh;
  }

  const rustTex = makeRustTexture(anisotropy);
  if (rustTex) rustTex.repeat.set(2, 2);
  const steelMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, map: rustTex || null,
    roughness: 0.66, metalness: 0.72, dithering: true,
  });
  const concreteMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.92, metalness: 0.02, dithering: true,
  });
  const insulatorMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.3, metalness: 0.05, dithering: true,
  });
  const poleMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.9, metalness: 0.02, dithering: true,
  });
  const cableMat = new THREE.MeshStandardMaterial({
    color: 0x4a4741, roughness: 0.45, metalness: 0.85, dithering: true,
  });
  disposables.push(steelMat, concreteMat, insulatorMat, poleMat, cableMat, rustTex || null);

  mergeToMesh(steelGeos, steelMat, 'pylonSteel', { raycast: true });
  mergeToMesh(concreteGeos, concreteMat, 'pylonConcrete', { raycast: true });
  mergeToMesh(insulatorGeos, insulatorMat, 'pylonInsulators', { raycast: false, cast: false });
  mergeToMesh(poleGeos, poleMat, 'utilityPoles', { raycast: true });
  mergeToMesh(cableGeos, cableMat, 'powerCables', { raycast: false, cast: false });

  // 电线：LineSegments（最省）
  if (wirePoints.length) {
    const wireGeo = new THREE.BufferGeometry();
    wireGeo.setAttribute('position', new THREE.Float32BufferAttribute(wirePoints, 3));
    const wireMat = new THREE.LineBasicMaterial({ color: 0x33322e, transparent: true, opacity: 0.9 });
    const lines = new THREE.LineSegments(wireGeo, wireMat);
    lines.name = 'utilityWires';
    group.add(lines);
    disposables.push(wireGeo, wireMat);
  }

  function setQuality() { /* 输电塔几何静态，档位差异在建造时已决定 */ }
  function dispose() {
    for (const d of disposables) if (d && d.dispose) d.dispose();
    if (group.parent) group.parent.remove(group);
  }

  return { group, raycastTargets, attach, counts: { pylons: PYLONS.length }, setQuality, dispose };
}
