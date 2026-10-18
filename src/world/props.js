// ===== 场景道具：石堆 / 废弃车辆 / 沙袋与混凝土工事 / 散落杂物 =====
// 石堆用 InstancedMesh（1 draw），车辆/工事/杂物按材质合并（各 1 draw）。
// 尺寸与 shared/world.js 的碰撞体一致（石堆 2*size 宽、车辆 4.4×1.9、工事 w×d×h）。
import * as THREE from 'three';
import {
  ROCKS, CARS, DEFENSES, WORLD, heightAt, surfaceAt, valueNoise, rng, insideStaticBox,
} from './shared.js';
import {
  addBoxGeo, addTorusGeo, pushPainted, mergePainted,
} from './geom.js';

export function createProps({ preset, anisotropy = 1 } = {}) {
  const p = preset || {};
  const group = new THREE.Group();
  group.name = 'props';
  const disposables = [];
  const raycastTargets = [];

  // ================= 石堆 =================
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  {
    // 顶点按确定性噪声外推，得到棱角分明的碎石；重复顶点用位置哈希，保证面不撕裂
    const pos = rockGeo.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const n = valueNoise(x * 1.9 + 11.3, z * 1.9 - 4.7) * 0.55
        + valueNoise(y * 2.3 + 4.1, x * 2.3 + 7.7) * 0.3
        + valueNoise(z * 3.4 - 2.9, y * 3.4 + 1.6) * 0.15;
      const s = 0.8 + n * 0.42;
      pos.setXYZ(i, x * s, y * s * 0.78, z * s);
    }
    rockGeo.computeVertexNormals();
    // 顶点色（白色底），instanceColor 负责每块石头的色差
    const count = pos.count;
    const white = new Float32Array(count * 3).fill(1);
    rockGeo.setAttribute('color', new THREE.BufferAttribute(white, 3));
  }
  disposables.push(rockGeo);
  const rockMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.88, metalness: 0.02,
    flatShading: true, dithering: true,
  });
  disposables.push(rockMat);

  const rockMesh = new THREE.InstancedMesh(rockGeo, rockMat, Math.max(1, ROCKS.length));
  rockMesh.name = 'rocks';
  rockMesh.castShadow = true;
  rockMesh.receiveShadow = true;
  {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const col = new THREE.Color();
    const rand = rng(3311);
    for (let i = 0; i < ROCKS.length; i++) {
      const r = ROCKS[i];
      const size = r.size || 1;
      // 碰撞体：宽 2*size、底面 r.y-0.45size、顶面 r.y+0.85size
      pos.set(r.x, r.y + size * 0.2, r.z);
      e.set((rand() - 0.5) * 0.3, r.rot || 0, (rand() - 0.5) * 0.3);
      q.setFromEuler(e);
      scl.set(size * 0.98, size * 0.66, size * 0.96);
      m.compose(pos, q, scl);
      rockMesh.setMatrixAt(i, m);
      // 灰褐色岩石（线性空间色值，与地形岩石色接近）
      const g = 0.15 + rand() * 0.1;
      col.setRGB(g * 1.04, g, g * 0.92);
      rockMesh.setColorAt(i, col);
    }
    rockMesh.instanceMatrix.needsUpdate = true;
    if (rockMesh.instanceColor) rockMesh.instanceColor.needsUpdate = true;
  }
  group.add(rockMesh);
  disposables.push(rockMesh);
  raycastTargets.push(rockMesh);

  // ================= 废弃车辆 =================
  const carGeos = [];
  for (const c of CARS) {
    const rot = c.rot || 0;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const T = (lx, ly, lz) => [c.x + lx * cos - lz * sin, c.padH + ly, c.z + lx * sin + lz * cos];
    const body = c.color || 0x6f7b78;
    const bodyDark = new THREE.Color(body).multiplyScalar(0.78).getHex();
    const rust = 0x6e4b34;
    const add = (color, lx, ly, lz, w, h, d, rx = 0) => {
      const [x, y, z] = T(lx, ly, lz);
      addBoxGeo(carGeos, color, x, y, z, w, h, d, rx, rot, 0);
    };
    // 车身 / 裙边 / 引擎盖 / 后备箱
    add(body, 0, 0.86, 0, 4.2, 0.62, 1.72, 0.01);
    add(bodyDark, 0, 0.48, 0, 3.9, 0.36, 1.62);
    add(body, 1.48, 1.04, 0, 1.18, 0.26, 1.62);
    add(body, -1.56, 1.02, 0, 0.98, 0.3, 1.6);
    // 驾驶舱 + 玻璃带 + 车顶
    add(bodyDark, -0.18, 1.42, 0, 2.15, 0.6, 1.5);
    add(0x2b3236, -0.18, 1.5, 0, 1.92, 0.34, 1.56);
    add(bodyDark, -0.18, 1.74, 0, 1.86, 0.09, 1.44);
    // 前后保险杠
    add(0x6b6a64, 2.1, 0.72, 0, 0.22, 0.3, 1.72);
    add(0x6b6a64, -2.1, 0.72, 0, 0.22, 0.3, 1.72);
    // 锈斑（贴在车身侧面）
    add(rust, 0.6, 0.9, 0.87, 0.9, 0.34, 0.03);
    add(rust, -0.9, 0.8, -0.87, 0.7, 0.28, 0.03);
    // 车轮（缺一个 → 报废感）
    const wheel = (lx, lz, has) => {
      if (!has) return;
      const [x, y, z] = T(lx, 0.36, lz);
      const g = new THREE.CylinderGeometry(0.35, 0.35, 0.24, 10);
      g.rotateX(Math.PI / 2);   // 轴向：车身宽度方向（本地 Z）
      g.rotateY(rot);
      g.translate(x, y, z);
      pushPainted(carGeos, g, 0x232120);
      // 轮毂
      const hub = new THREE.CylinderGeometry(0.14, 0.14, 0.26, 8);
      hub.rotateX(Math.PI / 2);
      hub.rotateY(rot);
      hub.translate(x, y, z);
      pushPainted(carGeos, hub, 0x8a8880);
    };
    wheel(1.42, 0.86, true);
    wheel(1.42, -0.86, true);
    wheel(-1.42, 0.86, true);
    wheel(-1.42, -0.86, true);
  }
  const carGeo = mergePainted(carGeos);
  if (carGeo) {
    const carMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.58, metalness: 0.42, dithering: true,
    });
    disposables.push(carMat);
    const carMesh = new THREE.Mesh(carGeo, carMat);
    carMesh.name = 'wreckedCars';
    carMesh.castShadow = true;
    carMesh.receiveShadow = true;
    group.add(carMesh);
    disposables.push(carGeo);
    raycastTargets.push(carMesh);
  }

  // ================= 工事（沙袋 / 混凝土）=================
  const defGeos = [];
  const randDef = rng(5150);
  for (const b of DEFENSES) {
    const rot = b.rot || 0;
    const base = heightAt(b.x, b.z) - 0.12;
    const h = b.h || 0.95;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const T = (lx, ly, lz) => [b.x + lx * cos - lz * sin, base + ly, b.z + lx * sin + lz * cos];
    if (b.kind === 'sandbag') {
      const bagH = 0.3;
      const layers = Math.max(2, Math.round(h / bagH));
      const cols = Math.max(1, Math.floor(b.w / 0.58));
      for (let layer = 0; layer < layers; layer++) {
        const stagger = (layer % 2) * 0.29;
        for (let i = 0; i < cols; i++) {
          const lx = -b.w / 2 + 0.3 + i * 0.58 + stagger * 0.5;
          if (lx > b.w / 2 - 0.15) continue;
          const [x, y, z] = T(lx, layer * bagH + bagH / 2, 0);
          const shade = 0.86 + randDef() * 0.26;
          const color = new THREE.Color(0x9a8a63).multiplyScalar(shade);
          addBoxGeo(defGeos, color, x, y, z, 0.56, bagH * 0.94, b.d * 0.94,
            0, rot + (randDef() - 0.5) * 0.14, 0);
        }
      }
      // 顶部压袋
      const [tx, ty, tz] = T(0, h + 0.1, 0);
      addBoxGeo(defGeos, new THREE.Color(0x8d7d58), tx, ty, tz, b.w * 0.55, 0.16, b.d * 0.8, 0, rot, 0);
    } else {
      // 混凝土隔离墩：底座宽 → 中部 → 顶部收窄
      const segs = Math.max(1, Math.round(b.w / 2.5));
      const segW = b.w / segs;
      for (let i = 0; i < segs; i++) {
        const lx = -b.w / 2 + segW * (i + 0.5);
        const [x, y, z] = T(lx, h * 0.18, 0);
        const tone = 0.9 + randDef() * 0.2;
        const col = new THREE.Color(0x9b988e).multiplyScalar(tone);
        addBoxGeo(defGeos, col, x, y, z, segW * 0.98, h * 0.36, b.d, 0, rot, 0);
        const [x2, y2, z2] = T(lx, h * 0.6, 0);
        addBoxGeo(defGeos, col, x2, y2, z2, segW * 0.96, h * 0.48, b.d * 0.72, 0, rot, 0);
        const [x3, y3, z3] = T(lx, h * 0.9, 0);
        addBoxGeo(defGeos, col, x3, y3, z3, segW * 0.9, h * 0.2, b.d * 0.44, 0, rot, 0);
      }
    }
  }
  const defGeo = mergePainted(defGeos);
  if (defGeo) {
    const defMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.93, metalness: 0.02, dithering: true,
    });
    disposables.push(defMat);
    const defMesh = new THREE.Mesh(defGeo, defMat);
    defMesh.name = 'defenses';
    defMesh.castShadow = true;
    defMesh.receiveShadow = true;
    group.add(defMesh);
    disposables.push(defGeo);
    raycastTargets.push(defMesh);
  }

  // ================= 散落杂物（木条 / 轮胎 / 油桶）=================
  const debrisGeos = [];
  const rand = rng(90210);
  const pieces = Math.round(30 * (p.props != null ? p.props : 1));
  for (let i = 0; i < pieces; i++) {
    const x = (rand() * 2 - 1) * 62;
    const z = (rand() * 2 - 1) * 62;
    if (Math.abs(x) < 5 && Math.abs(z) < 5) continue;
    if (surfaceAt(x, z) !== 'grass') continue;
    if (insideStaticBox(x, z, 0.5)) continue;
    if (Math.abs(x) > WORLD.half - 5 || Math.abs(z) > WORLD.half - 5) continue;
    const y = heightAt(x, z);
    const kind = rand();
    if (kind < 0.6) {
      // 木条/木板
      const len = 1.2 + rand() * 1.2;
      addBoxGeo(debrisGeos, new THREE.Color(0x7a6349).multiplyScalar(0.8 + rand() * 0.4),
        x, y + 0.05, z, len, 0.07, 0.2 + rand() * 0.12,
        (rand() - 0.5) * 0.16, rand() * Math.PI, (rand() - 0.5) * 0.1);
    } else if (kind < 0.85) {
      // 废轮胎（平躺）
      addTorusGeo(debrisGeos, 0x26251f, x, y + 0.13, z, 0.34, 0.11, 10, 6,
        Math.PI / 2, 0, rand() * Math.PI);
    } else {
      // 锈油桶
      const g = new THREE.CylinderGeometry(0.27, 0.27, 0.84, 10);
      g.translate(x, y + 0.42, z);
      pushPainted(debrisGeos, g, new THREE.Color(0x7c5a40).multiplyScalar(0.8 + rand() * 0.35));
    }
  }
  const debrisGeo = mergePainted(debrisGeos);
  if (debrisGeo) {
    const debrisMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.8, metalness: 0.18, dithering: true,
    });
    disposables.push(debrisMat);
    const debrisMesh = new THREE.Mesh(debrisGeo, debrisMat);
    debrisMesh.name = 'debris';
    debrisMesh.castShadow = true;
    debrisMesh.receiveShadow = true;
    group.add(debrisMesh);
    disposables.push(debrisGeo);
  }

  function setQuality() { /* 道具尺寸小，档位差异在建造时决定 */ }
  function dispose() {
    for (const d of disposables) if (d && d.dispose) d.dispose();
    if (group.parent) group.parent.remove(group);
  }

  return {
    group,
    raycastTargets,
    counts: { rocks: ROCKS.length, cars: CARS.length, defenses: DEFENSES.length },
    setQuality,
    dispose,
  };
}
