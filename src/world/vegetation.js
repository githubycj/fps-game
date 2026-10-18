// ===== 植被：草地 / 杂草 / 野花 / 松树 / 阔叶树 / 灌木 / 远处树墙 =====
// 全部 InstancedMesh，顶点着色器风摆（uniform time + 玩家位置压草）。
// 分布规则：道路/广场/房屋内/车辆与基座垫内不长草；数量按画质档缩放。
import * as THREE from 'three';
import {
  WORLD, TREES, HOUSES, CARS, DEFENSES, PYLONS,
  heightAt, surfaceAt, terrainNormal, valueNoise, farHeightAt, rng, clamp,
} from './shared.js';

// ---------- 共享风摆 uniform（各材质引用同一对象，update 时一次更新）----------
function makeWindUniforms() {
  const dir = new THREE.Vector2(0.82, 0.57).normalize();
  return {
    uTime: { value: 0 },
    uGust: { value: 1 },
    uPlayer: { value: new THREE.Vector3(0, 0, 0) },
    uWindDir: { value: dir },
    uFadeStart: { value: 34 },
    uFadeEnd: { value: 56 },
  };
}

const GLSL_BLADE_PROJECT = /* glsl */`
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  vec3 instPos = instanceMatrix[3].xyz;
  float instDist = length(cameraPosition.xz - instPos.xz);
  float lod = 1.0 - smoothstep(uFadeStart, uFadeEnd, instDist);
  // 远处草叶收缩到根部（视距外不渲染）
  mvPosition.xz *= lod;
  float hgt = clamp(position.y * uHeightInv, 0.0, 1.0);
  float phase = instPos.x * 0.41 + instPos.z * 0.33;
  float breeze = sin(uTime * 1.45 + phase) * 0.075 + sin(uTime * 2.63 + phase * 1.73) * 0.04;
  vec2 windOff = uWindDir * (breeze * hgt * hgt * uAmp * uGust);
  // 玩家/单位经过时把草压开
  vec2 toP = instPos.xz - uPlayer.xz;
  float pd = max(length(toP), 0.0001);
  float push = 1.0 - clamp(pd / 2.6, 0.0, 1.0);
  push = push * push * 0.55;
  windOff += (toP / pd) * (push * hgt * hgt);
  mvPosition = instanceMatrix * mvPosition;
  mvPosition.xyz += vec3(windOff.x, 0.0, windOff.y);
#endif
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;
`;

const GLSL_CANOPY_PROJECT = /* glsl */`
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  vec3 instPos = instanceMatrix[3].xyz;
  float hgt = clamp(position.y * uHeightInv, 0.0, 1.0);
  float phase = instPos.x * 0.083 + instPos.z * 0.067;
  float breeze = sin(uTime * 0.85 + phase) * 0.6 + sin(uTime * 1.62 + phase * 0.8) * 0.25;
  mvPosition = instanceMatrix * mvPosition;
  mvPosition.xyz += vec3(uWindDir.x, 0.0, uWindDir.y) * (breeze * hgt * hgt * uAmp * uGust * 0.35);
#endif
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;
`;

// 给材质注入风摆顶点位移（不改 three 自带光照/雾/阴影代码）
function injectWind(material, wind, { mode = 'blade', amp = 1, heightInv = 1 } = {}) {
  const key = `wind_${mode}`;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = wind.uTime;
    shader.uniforms.uGust = wind.uGust;
    shader.uniforms.uPlayer = wind.uPlayer;
    shader.uniforms.uWindDir = wind.uWindDir;
    shader.uniforms.uFadeStart = wind.uFadeStart;
    shader.uniforms.uFadeEnd = wind.uFadeEnd;
    shader.uniforms.uAmp = { value: amp };
    shader.uniforms.uHeightInv = { value: heightInv };
    shader.vertexShader =
      'uniform float uTime;\nuniform float uGust;\nuniform vec3 uPlayer;\nuniform vec2 uWindDir;\n' +
      'uniform float uFadeStart;\nuniform float uFadeEnd;\nuniform float uAmp;\nuniform float uHeightInv;\n' +
      shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      mode === 'blade' ? GLSL_BLADE_PROJECT : GLSL_CANOPY_PROJECT
    );
  };
  material.customProgramCacheKey = () => key;
}

// ---------- 几何生成 ----------
// 草叶：向 +Z 弯曲的锥形条带，法线统一朝上（草坪的柔和受光）
function makeBladeGeometry(height = 0.44, width = 0.05, rows = 3, bend = 0.14) {
  const pos = [], nor = [], col = [], idx = [];
  const rowY = [];
  for (let r = 0; r <= rows; r++) rowY.push(r / rows);
  for (let r = 0; r <= rows; r++) {
    const t = rowY[r];
    const y = t * height;
    const w = width * (1 - t * 0.86);
    const z = bend * t * t;
    // 底暗顶亮的渐变（乘到实例颜色上）：基底不要过暗，否则逆光下会变成黑刺
    const shade = 0.8 + t * 0.36;
    pos.push(-w, y, z, w, y, z);
    nor.push(0, 1, 0, 0, 1, 0);
    col.push(shade, shade * 1.02, shade * 0.86, shade, shade * 1.02, shade * 0.86);
  }
  for (let r = 0; r < rows; r++) {
    const a = r * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, b, c, b, d, c);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

// 野花：两片交叉小面片 + 顶端略亮
function makeFlowerGeometry(height = 0.38) {
  const pos = [], nor = [], col = [], idx = [];
  const push = (x, y, z, shade) => {
    pos.push(x, y, z); nor.push(0, 1, 0); col.push(shade * 0.35, shade * 0.55, shade * 0.25);
  };
  // 两片交叉的竖直面片
  for (let k = 0; k < 2; k++) {
    const ang = k * Math.PI / 2;
    const cx = Math.cos(ang) * 0.09, cz = Math.sin(ang) * 0.09;
    const base = pos.length / 3;
    const shadeBot = 0.3, shadeTop = 1;
    push(-cx * 0.4, 0, -cz * 0.4, shadeBot);
    push(cx * 0.4, 0, cz * 0.4, shadeBot);
    push(cx + cx * 0.6, height, cz + cz * 0.6, shadeTop);
    push(-cx + cx * 0.6, height, -cz + cz * 0.6, shadeTop);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

// 松树树冠：三层锥体叠加（几何单位：米）
function makePineCanopyGeometry() {
  const parts = [];
  const specs = [
    { y: 2.3, r: 2.55, h: 3.6 },
    { y: 4.35, r: 1.95, h: 3.3 },
    { y: 6.35, r: 1.25, h: 2.9 },
  ];
  for (const s of specs) {
    const g = new THREE.ConeGeometry(s.r, s.h, 7, 1, true);
    g.translate(0, s.y + s.h * 0.5, 0);
    parts.push(g);
  }
  return mergeSimple(parts);
}

// 阔叶树树冠：三个错开的球体
function makeOakCanopyGeometry() {
  const parts = [];
  const specs = [
    { x: 0, y: 4.3, z: 0, r: 2.3, sx: 1.15, sy: 0.9, sz: 1.05 },
    { x: 1.35, y: 3.85, z: 0.5, r: 1.6, sx: 1, sy: 0.85, sz: 1 },
    { x: -1.2, y: 4.9, z: -0.6, r: 1.5, sx: 1, sy: 0.9, sz: 1 },
  ];
  for (const s of specs) {
    const g = new THREE.IcosahedronGeometry(s.r, 1);
    g.scale(s.sx, s.sy, s.sz);
    g.translate(s.x, s.y, s.z);
    parts.push(g);
  }
  return mergeSimple(parts);
}

// 灌木：两团压扁的球
function makeBushGeometry() {
  const parts = [];
  const g1 = new THREE.IcosahedronGeometry(0.75, 1);
  g1.scale(1.1, 0.75, 1.0);
  g1.translate(0, 0.5, 0);
  parts.push(g1);
  const g2 = new THREE.IcosahedronGeometry(0.55, 0);
  g2.scale(1.0, 0.8, 1.0);
  g2.translate(0.6, 0.42, 0.2);
  parts.push(g2);
  return mergeSimple(parts);
}

// 简易几何合并（保留 position/normal/color；instanceColor 需要 vertexColors 才生效）
function mergeSimple(geos) {
  const posArr = [], norArr = [], colArr = [];
  let minY = Infinity, maxY = -Infinity;
  for (const g of geos) {
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const span = Math.max(0.001, maxY - minY);
  for (const g of geos) {
    const p = g.getAttribute('position');
    const nAttr = g.getAttribute('normal');
    const index = g.getIndex();
    const emit = (vi) => {
      const y = p.getY(vi);
      // 纵向明暗：树冠底部略暗、顶部略亮（烘焙进顶点色，与实例色相乘）
      const t = (y - minY) / span;
      const shade = 0.66 + t * 0.46;
      posArr.push(p.getX(vi), y, p.getZ(vi));
      norArr.push(nAttr.getX(vi), nAttr.getY(vi), nAttr.getZ(vi));
      colArr.push(shade, shade, shade);
    };
    if (index) {
      for (let i = 0; i < index.count; i++) emit(index.getX(i));
    } else {
      for (let i = 0; i < p.count; i++) emit(i);
    }
    g.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(norArr, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colArr, 3));
  geo.computeBoundingSphere();
  return geo;
}

// 树干：底部在 y=0 的单位圆柱
function makeTrunkGeometry() {
  const g = new THREE.CylinderGeometry(0.13, 0.2, 1, 7, 1, false);
  g.translate(0, 0.5, 0);
  return g;
}

// ---------- 分布辅助 ----------
// 2m 占用网格：房屋内 / 车辆 / 工事 / 塔基不长草
function makeBlocker() {
  const res = 2;
  const N = Math.ceil(WORLD.size / res) + 2;
  const grid = new Uint8Array(N * N);
  const blockRect = (x, z, w, d) => {
    const i0 = Math.floor((x - w / 2 + WORLD.half) / res);
    const i1 = Math.floor((x + w / 2 + WORLD.half) / res);
    const j0 = Math.floor((z - d / 2 + WORLD.half) / res);
    const j1 = Math.floor((z + d / 2 + WORLD.half) / res);
    for (let j = Math.max(0, j0); j <= Math.min(N - 1, j1); j++) {
      for (let i = Math.max(0, i0); i <= Math.min(N - 1, i1); i++) grid[j * N + i] = 1;
    }
  };
  for (const h of HOUSES) blockRect(h.x, h.z, h.w + 2.2, h.d + 2.2);
  for (const c of CARS) blockRect(c.x, c.z, 5.2, 5.2);
  for (const b of DEFENSES) blockRect(b.x, b.z, b.w + 0.9, b.d + 0.9);
  for (const p of PYLONS) blockRect(p.x, p.z, 8.5, 8.5);
  return (x, z) => {
    const i = Math.floor((x + WORLD.half) / res);
    const j = Math.floor((z + WORLD.half) / res);
    if (i < 0 || j < 0 || i >= N || j >= N) return true;
    return grid[j * N + i] === 1;
  };
}

function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

// 判断某点适合长草（地面是草、不在垫子里、坡度不过陡）
function fitsGrass(x, z, blocked, slopeLimit = 0.55) {
  if (blocked(x, z)) return false;
  if (surfaceAt(x, z) !== 'grass') return false;
  const n = terrainNormal(x, z);
  if (1 - n.y > slopeLimit) return false;
  return true;
}

// ---------- 主体 ----------
export function createVegetation({ preset } = {}) {
  const p = preset || {};
  const group = new THREE.Group();
  group.name = 'vegetation';
  const disposables = [];
  const wind = makeWindUniforms();
  const blocked = makeBlocker();
  const rand = rng(20261018);

  const grassDensity = p.grassDensity != null ? p.grassDensity : 1;
  const weedDensity = p.weedDensity != null ? p.weedDensity : 1;
  const flowerDensity = p.flowerDensity != null ? p.flowerDensity : 1;
  wind.uFadeStart.value = (p.grassFade && p.grassFade[0]) || 34;
  wind.uFadeEnd.value = (p.grassFade && p.grassFade[1]) || 56;

  // ================= 草叶 =================
  const bladeH = 0.30;
  // 2 段草叶（4 个三角形），在视觉效果接近的前提下显著减少顶点/填充开销
  const bladeGeo = makeBladeGeometry(bladeH, 0.085, 2, 0.10);
  disposables.push(bladeGeo);
  const bladeMat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    dithering: true,
  });
  injectWind(bladeMat, wind, { mode: 'blade', amp: 1.0, heightInv: 1 / bladeH });
  disposables.push(bladeMat);

  const grassPlacements = [];
  const GRASS_STEP = 0.46;
  const GRASS_CAP = 36000;
  // 草色（sRGB 十六进制 → 线性工作空间）：深橄榄 ↔ 初秋枯黄（整体提亮，避免逆光发黑）
  const GRASS_A = new THREE.Color(0x8b9a55);
  const GRASS_B = new THREE.Color(0xd8c98a);
  const _grassCol = new THREE.Color();
  for (let z = -WORLD.half + 1.5; z < WORLD.half - 1.5; z += GRASS_STEP) {
    for (let x = -WORLD.half + 1.5; x < WORLD.half - 1.5; x += GRASS_STEP) {
      const jx = x + (rand() - 0.5) * GRASS_STEP;
      const jz = z + (rand() - 0.5) * GRASS_STEP;
      // 斑块化：湿润区域更密
      const patch = 0.5 + valueNoise(jx * 0.09 + 3.3, jz * 0.09 - 9.1) * 0.34;
      if (rand() > patch) continue;
      if (!fitsGrass(jx, jz, blocked, 0.58)) continue;
      const h = heightAt(jx, jz);
      const scale = 0.72 + rand() * 0.65;
      const yaw = rand() * Math.PI * 2;
      const tilt = (rand() - 0.5) * 0.22;
      grassPlacements.push({ x: jx, y: h, z: jz, scale, yaw, tilt, tone: rand() });
    }
  }
  shuffle(grassPlacements, rand);
  if (grassPlacements.length > GRASS_CAP) grassPlacements.length = GRASS_CAP;

  const grassMesh = new THREE.InstancedMesh(bladeGeo, bladeMat, grassPlacements.length);
  grassMesh.name = 'grassField';
  grassMesh.frustumCulled = false;
  {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    for (let i = 0; i < grassPlacements.length; i++) {
      const g = grassPlacements[i];
      pos.set(g.x, g.y - 0.02, g.z);
      e.set(g.tilt * 0.6, g.yaw, g.tilt);
      q.setFromEuler(e);
      scl.set(0.85 + g.tone * 0.5, g.scale, 1);
      m.compose(pos, q, scl);
      grassMesh.setMatrixAt(i, m);
      // 绿黄之间：越干越黄（用 sRGB 十六进制插值，保证和地形态色调一致）
      const dry = clamp(0.18 + g.tone * 0.5 + valueNoise(g.x * 0.07, g.z * 0.07) * 0.35, 0, 1);
      _grassCol.copy(GRASS_A).lerp(GRASS_B, dry);
      grassMesh.setColorAt(i, _grassCol);
    }
    grassMesh.instanceMatrix.needsUpdate = true;
    if (grassMesh.instanceColor) grassMesh.instanceColor.needsUpdate = true;
  }
  group.add(grassMesh);
  disposables.push(grassMesh);

  // ================= 高杂草 =================
  const WEED_H = 0.85;
  const weedH = WEED_H;
  const weedGeo = makeBladeGeometry(weedH, 0.095, 3, 0.3);
  disposables.push(weedGeo);
  const weedMat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    dithering: true,
  });
  injectWind(weedMat, wind, { mode: 'blade', amp: 1.35, heightInv: 1 / weedH });
  disposables.push(weedMat);

  const weedPlacements = [];
  const WEED_CAP = 3200;
  const WEED_A = new THREE.Color(0x85935a);
  const WEED_B = new THREE.Color(0xc4b478);
  const _weedCol = new THREE.Color();
  for (let z = -WORLD.half + 2; z < WORLD.half - 2; z += 1.35) {
    for (let x = -WORLD.half + 2; x < WORLD.half - 2; x += 1.35) {
      if (weedPlacements.length >= WEED_CAP) break;
      const jx = x + (rand() - 0.5) * 1.2;
      const jz = z + (rand() - 0.5) * 1.2;
      if (rand() > 0.55) continue;
      if (!fitsGrass(jx, jz, blocked, 0.5)) continue;
      weedPlacements.push({
        x: jx, y: heightAt(jx, jz), z: jz,
        scale: 0.7 + rand() * 0.9, yaw: rand() * Math.PI * 2, tone: rand(),
      });
    }
  }
  shuffle(weedPlacements, rand);
  const weedMesh = new THREE.InstancedMesh(weedGeo, weedMat, weedPlacements.length);
  weedMesh.name = 'weedField';
  weedMesh.frustumCulled = false;
  {
    const m = new THREE.Matrix4(); const q = new THREE.Quaternion();
    const e = new THREE.Euler(); const pos = new THREE.Vector3(); const scl = new THREE.Vector3();
    for (let i = 0; i < weedPlacements.length; i++) {
      const g = weedPlacements[i];
      pos.set(g.x, g.y - 0.03, g.z);
      e.set((rand() - 0.5) * 0.3, g.yaw, (rand() - 0.5) * 0.3);
      q.setFromEuler(e);
      scl.set(1, g.scale, 1);
      m.compose(pos, q, scl);
      weedMesh.setMatrixAt(i, m);
      const dry = clamp(0.3 + g.tone * 0.6, 0, 1);
      _weedCol.copy(WEED_A).lerp(WEED_B, dry);
      weedMesh.setColorAt(i, _weedCol);
    }
    weedMesh.instanceMatrix.needsUpdate = true;
    if (weedMesh.instanceColor) weedMesh.instanceColor.needsUpdate = true;
  }
  group.add(weedMesh);
  disposables.push(weedMesh);

  // ================= 野花 =================
  const flowerGeo = makeFlowerGeometry(0.4);
  disposables.push(flowerGeo);
  const flowerMat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    dithering: true,
  });
  injectWind(flowerMat, wind, { mode: 'blade', amp: 1.1, heightInv: 1 / 0.4 });
  disposables.push(flowerMat);

  const flowerPlacements = [];
  const FLOWER_CAP = 2600;
  const FLOWER_COLORS = [0xece8d2, 0xe6cf52, 0xb892d6, 0xdb8a9c, 0xf0f2e0];
  for (let z = -WORLD.half + 2; z < WORLD.half - 2; z += 1.9) {
    for (let x = -WORLD.half + 2; x < WORLD.half - 2; x += 1.9) {
      if (flowerPlacements.length >= FLOWER_CAP) break;
      const jx = x + (rand() - 0.5) * 1.8;
      const jz = z + (rand() - 0.5) * 1.8;
      if (rand() > 0.36) continue;
      if (!fitsGrass(jx, jz, blocked, 0.45)) continue;
      flowerPlacements.push({
        x: jx, y: heightAt(jx, jz) + 0.04, z: jz,
        scale: 0.7 + rand() * 0.7, yaw: rand() * Math.PI * 2,
        color: FLOWER_COLORS[Math.floor(rand() * FLOWER_COLORS.length)],
      });
    }
  }
  shuffle(flowerPlacements, rand);
  const flowerMesh = new THREE.InstancedMesh(flowerGeo, flowerMat, flowerPlacements.length);
  flowerMesh.name = 'flowerField';
  flowerMesh.frustumCulled = false;
  {
    const m = new THREE.Matrix4(); const q = new THREE.Quaternion();
    const e = new THREE.Euler(); const pos = new THREE.Vector3(); const scl = new THREE.Vector3();
    const col = new THREE.Color();
    for (let i = 0; i < flowerPlacements.length; i++) {
      const g = flowerPlacements[i];
      pos.set(g.x, g.y, g.z);
      e.set(0, g.yaw, 0); q.setFromEuler(e);
      scl.set(1, g.scale, 1);
      m.compose(pos, q, scl);
      flowerMesh.setMatrixAt(i, m);
      col.set(g.color);
      flowerMesh.setColorAt(i, col);
    }
    flowerMesh.instanceMatrix.needsUpdate = true;
    if (flowerMesh.instanceColor) flowerMesh.instanceColor.needsUpdate = true;
  }
  group.add(flowerMesh);
  disposables.push(flowerMesh);

  // ================= 树 =================
  const pineList = TREES.filter((t) => t.type === 'pine');
  const oakList = TREES.filter((t) => t.type === 'oak');
  const bushList = TREES.filter((t) => t.type === 'bush');

  const trunkGeo = makeTrunkGeometry();
  disposables.push(trunkGeo);
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6a5541, dithering: true });
  disposables.push(trunkMat);

  const pineGeoTemplate = makePineCanopyGeometry();
  const oakGeoTemplate = makeOakCanopyGeometry();
  const bushGeoTemplate = makeBushGeometry();
  disposables.push(pineGeoTemplate, oakGeoTemplate, bushGeoTemplate);

  const foliageMat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, dithering: true });
  injectWind(foliageMat, wind, { mode: 'canopy', amp: 0.35, heightInv: 1 / 9 });
  disposables.push(foliageMat);
  const bushMat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, dithering: true });
  injectWind(bushMat, wind, { mode: 'canopy', amp: 0.1, heightInv: 1 / 1.4 });
  disposables.push(bushMat);

  const treeMeshes = [];
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3();
  const _c = new THREE.Color();
  const _c2 = new THREE.Color();

  function buildTreeSet(list, canopyGeo, canopyMat, { trunkRadius = 1, trunkHeight = 4.4, colors = [0x2f4527, 0x5e7038] } = {}) {
    if (!list.length) return;
    // 树干
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, list.length);
    trunks.name = 'treeTrunks';
    trunks.castShadow = !!p.treeShadows;
    trunks.receiveShadow = true;
    // 树冠
    const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, list.length);
    canopies.name = 'treeCanopies';
    canopies.castShadow = !!p.treeShadows;
    canopies.receiveShadow = true;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      const sc = t.scale || 1;
      _p.set(t.x, t.y - 0.15, t.z);
      _e.set(0, t.rot || 0, 0);
      _q.setFromEuler(_e);
      _s.set(sc * trunkRadius, sc * trunkHeight, sc * trunkRadius);
      _m.compose(_p, _q, _s);
      trunks.setMatrixAt(i, _m);
      // 树冠在树干顶部（几何已是米制，整体按 scale 缩放）
      _p.set(t.x, t.y - 0.15, t.z);
      _s.set(sc, sc, sc);
      _m.compose(_p, _q, _s);
      canopies.setMatrixAt(i, _m);
      // 每棵树的绿色差异（sRGB 十六进制 → 线性，乘到顶点色渐变上）
      const v = (t.scale % 0.37) / 0.37;
      _c.set(colors[0]).lerp(_c2.set(colors[1]), v);
      canopies.setColorAt(i, _c);
    }
    trunks.instanceMatrix.needsUpdate = true;
    canopies.instanceMatrix.needsUpdate = true;
    if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;
    group.add(trunks, canopies);
    treeMeshes.push(trunks, canopies);
    disposables.push(trunks, canopies);
  }

  buildTreeSet(pineList, pineGeoTemplate, foliageMat, {
    trunkRadius: 1.0, trunkHeight: 5.2, colors: [0x5a7440, 0x81985a],
  });
  buildTreeSet(oakList, oakGeoTemplate, foliageMat, {
    trunkRadius: 1.35, trunkHeight: 3.4, colors: [0x6d8648, 0x9aab68],
  });
  // 灌木（无树干）
  if (bushList.length) {
    const bushes = new THREE.InstancedMesh(bushGeoTemplate, bushMat, bushList.length);
    bushes.name = 'bushes';
    bushes.castShadow = !!p.treeShadows;
    bushes.receiveShadow = true;
    for (let i = 0; i < bushList.length; i++) {
      const t = bushList[i];
      const sc = t.scale || 1;
      _p.set(t.x, t.y - 0.05, t.z);
      _e.set(0, t.rot || 0, 0); _q.setFromEuler(_e);
      _s.set(sc * 1.1, sc * 0.95, sc * 1.1);
      _m.compose(_p, _q, _s);
      bushes.setMatrixAt(i, _m);
      _c.set(0x33452a).lerp(_c2.set(0x5c7438), (t.scale % 0.5) / 0.5);
      bushes.setColorAt(i, _c);
    }
    bushes.instanceMatrix.needsUpdate = true;
    if (bushes.instanceColor) bushes.instanceColor.needsUpdate = true;
    group.add(bushes);
    treeMeshes.push(bushes);
    disposables.push(bushes);
  }

  // ================= 远处树墙（地图外密林，挡住边界视线）=================
  const wallGeo = new THREE.ConeGeometry(1, 1, 5, 1, true);
  wallGeo.translate(0, 0.5, 0);
  {
    // 顶点色（instanceColor 需要 vertexColors 才参与最终颜色）：下部暗、顶部略亮
    const cnt = wallGeo.getAttribute('position').count;
    const ca = new Float32Array(cnt * 3);
    for (let i = 0; i < cnt; i++) {
      const t = wallGeo.getAttribute('position').getY(i);
      const v = 0.7 + t * 0.4;
      ca[i * 3] = v; ca[i * 3 + 1] = v; ca[i * 3 + 2] = v;
    }
    wallGeo.setAttribute('color', new THREE.BufferAttribute(ca, 3));
  }
  disposables.push(wallGeo);
  const wallMat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, dithering: true, fog: true });
  disposables.push(wallMat);
  const wallPlacements = [];
  const wallRand = rng(778899);
  const WALL_COUNT = 520;
  for (let i = 0; i < WALL_COUNT; i++) {
    // 在边界外的矩形环上取样
    const side = Math.floor(wallRand() * 4);
    const along = (wallRand() * 2 - 1) * 118;
    const out = WORLD.half + 5 + Math.pow(wallRand(), 0.7) * 62;
    let x, z;
    if (side === 0) { x = along; z = -out; }
    else if (side === 1) { x = along; z = out; }
    else if (side === 2) { x = -out; z = along; }
    else { x = out; z = along; }
    if (Math.abs(x) < 6 && Math.abs(z) < 6) continue;
    wallPlacements.push({ x, z, h: 8 + wallRand() * 8, w: 1.6 + wallRand() * 0.9, rot: wallRand() * Math.PI });
  }
  const wallMesh = new THREE.InstancedMesh(wallGeo, wallMat, wallPlacements.length);
  wallMesh.name = 'treeWall';
  wallMesh.castShadow = false;
  wallMesh.receiveShadow = false;
  wallMesh.frustumCulled = false;
  {
    const col = new THREE.Color();
    for (let i = 0; i < wallPlacements.length; i++) {
      const t = wallPlacements[i];
      // 树墙在地图外：高度用共享的远景轮廓，保证站在地图边缘也能看到树梢
      const y = farHeightForWall(t.x, t.z);
      _p.set(t.x, y - 0.3, t.z);
      _e.set(0, t.rot, 0); _q.setFromEuler(_e);
      _s.set(t.w, t.h, t.w);
      _m.compose(_p, _q, _s);
      wallMesh.setMatrixAt(i, _m);
      const v = 0.55 + wallRand() * 0.5;
      col.setRGB(0.05 * v, 0.11 * v, 0.06 * v);
      wallMesh.setColorAt(i, col);
    }
    wallMesh.instanceMatrix.needsUpdate = true;
    if (wallMesh.instanceColor) wallMesh.instanceColor.needsUpdate = true;
  }
  group.add(wallMesh);
  disposables.push(wallMesh);

  // 树墙位置的地面高度：直接复用共享的远景地形轮廓，保证和 terrain 外圈网格贴合
  function farHeightForWall(x, z) {
    if (Math.abs(x) <= WORLD.half && Math.abs(z) <= WORLD.half) return heightAt(x, z);
    return farHeightAt(x, z);
  }

  // 植被数量统计（自测/调试用）
  const counts = {
    grass: grassPlacements.length,
    weeds: weedPlacements.length,
    flowers: flowerPlacements.length,
    trees: pineList.length + oakList.length,
    bushes: bushList.length,
    treeWall: wallPlacements.length,
  };

  function update(dt, playerPos) {
    wind.uTime.value += dt;
    // 阵风：低频起伏（不参与地形确定性，仅视觉）
    const t = wind.uTime.value;
    wind.uGust.value = 0.72 + 0.24 * Math.sin(t * 0.23) + 0.12 * Math.sin(t * 0.61 + 1.3);
    if (playerPos) wind.uPlayer.value.set(playerPos.x, playerPos.y || 0, playerPos.z);
  }

  const bushMeshRef = treeMeshes.find((m) => m.name === 'bushes') || null;

  function setQuality(next) {
    const np = next || {};
    wind.uFadeStart.value = (np.grassFade && np.grassFade[0]) || 34;
    wind.uFadeEnd.value = (np.grassFade && np.grassFade[1]) || 56;
    grassMesh.count = Math.max(0, Math.floor(grassPlacements.length * (np.grassDensity != null ? np.grassDensity : 1)));
    weedMesh.count = Math.max(0, Math.floor(weedPlacements.length * (np.weedDensity != null ? np.weedDensity : 1)));
    flowerMesh.count = Math.max(0, Math.floor(flowerPlacements.length * (np.flowerDensity != null ? np.flowerDensity : 1)));
    for (const tm of treeMeshes) tm.castShadow = !!np.treeShadows;
    if (bushMeshRef && bushList.length) {
      bushMeshRef.count = Math.max(1, Math.floor(bushList.length * (np.bushes != null ? np.bushes : 1)));
    }
  }

  function dispose() {
    for (const d of disposables) if (d && d.dispose) d.dispose();
    if (group.parent) group.parent.remove(group);
  }

  // 首帧按当前档位设置数量
  setQuality(p);

  return { group, wind, counts, update, setQuality, dispose, grassMesh, weedMesh, flowerMesh, treeMeshes };
}

