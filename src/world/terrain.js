// ===== 地形 =====
// 高度场网格（满档 200×200 段，按画质档调整），顶点色：草地绿黄 / 泥土路 / 广场碎石 / 山坡岩石 / 路缘毛边。
// 顶点高度全部由 shared/world.js 的 heightAt 采样，保证与碰撞/物理逐位一致。
// 外圈远景地形（地图外到 ~290m）单独一张低密度网格，与内圈在 ±70 处共享顶点坐标，无接缝。
import * as THREE from 'three';
import { WORLD, heightAt, terrainNormal, surfaceAt, valueNoise, farHeightAt, clamp, smoothstep, ROADS } from './shared.js';
import { makeGroundNormalTexture, makeGroundDetailTexture } from './textures.js';

// 顶点色调色板（THREE.Color 会把 sRGB 十六进制转成线性工作空间）
function lin(hex) { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; }
const PAL = {
  grassA: lin(0x5a6a33),
  grassB: lin(0x7d8442),
  grassDry: lin(0x9a9155),
  grassDark: lin(0x44502a),
  road: lin(0x7b6d57),
  roadDark: lin(0x5f5442),
  dirt: lin(0x8f8674),
  dirtDark: lin(0x736b5c),
  rock: lin(0x8a8778),
  rockDark: lin(0x6a675c),
  rockLight: lin(0x9c998c),
};

function mix3(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// 每个顶点的颜色：9 点超采样 surfaceAt 得到草/路/泥权重（路缘自然毛边）+ 坡度混入岩石色
function computeColor(x, z, out) {
  const n1 = valueNoise(x * 0.045 + 7.7, z * 0.045 - 3.1);       // 大尺度草色斑块
  const n2 = valueNoise(x * 0.135 - 2.2, z * 0.135 + 5.5);       // 中尺度枯黄
  const n3 = valueNoise(x * 0.55 + 11.3, z * 0.55 - 8.6);        // 细节噪点
  const n4 = valueNoise(x * 1.7 - 4.4, z * 1.7 + 2.8);           // 高频碎石

  // ---- 草地 ----
  let grass = mix3(PAL.grassA, PAL.grassB, n1);
  grass = mix3(grass, PAL.grassDry, n2 * 0.55 + n3 * 0.2);
  grass = mix3(grass, PAL.grassDark, Math.max(0, n3 - 0.62) * 0.9);

  // ---- 泥土路：（车轮压出的两条浅辙）----
  let road = mix3(PAL.road, PAL.roadDark, n3 * 0.6 + n4 * 0.25);
  const rutMain = smoothstep(0.85, 0.12, Math.abs(Math.abs(x) - 1.75)) * 0.16;
  const rutCross = smoothstep(0.8, 0.12, Math.abs(Math.abs(z) - 1.45)) * 0.16;
  const inMain = Math.abs(x) < ROADS.mainWidth / 2 + 0.8;
  const inCross = Math.abs(z) < ROADS.crossWidth / 2 + 0.8;
  const rut = Math.max(inMain ? rutMain : 0, inCross ? rutCross : 0);
  road = [road[0] * (1 - rut), road[1] * (1 - rut), road[2] * (1 - rut)];

  // ---- 广场碎石 ----
  let dirt = mix3(PAL.dirt, PAL.dirtDark, n3 * 0.5 + n4 * 0.4);
  dirt = mix3(dirt, PAL.roadDark, n4 * 0.25);

  // ---- 权重：抖动采样点让路缘呈自然毛边 ----
  const jx = (valueNoise(x * 0.9 + 31.1, z * 0.9 - 19.3) - 0.5) * 1.1;
  const jz = (valueNoise(x * 0.9 - 13.7, z * 0.9 + 27.9) - 0.5) * 1.1;
  let wGrass = 0, wRoad = 0, wDirt = 0;
  const offs = [
    [0, 0],
    [0.55, 0.2], [-0.5, 0.35], [0.15, -0.6], [-0.35, -0.45],
    [0.8, 0.75], [-0.75, 0.7], [0.7, -0.85], [-0.8, -0.7],
  ];
  for (let i = 0; i < offs.length; i++) {
    const sx = x + offs[i][0] + jx;
    const sz = z + offs[i][1] + jz;
    const s = surfaceAt(sx, sz);
    if (s === 'road') wRoad++;
    else if (s === 'dirt') wDirt++;
    else wGrass++;
  }
  const inv = 1 / offs.length;
  wGrass *= inv; wRoad *= inv; wDirt *= inv;
  // 过渡带两两混合，避免硬边
  let col = [0, 0, 0];
  col = mix3(col, grass, wGrass);
  col = mix3(col, road, wRoad);
  col = mix3(col, dirt, wDirt);
  const ws = wGrass + wRoad + wDirt || 1;
  col = [col[0] / ws, col[1] / ws, col[2] / ws];

  // ---- 坡度岩石：陡坡 / 山脊露出灰岩 ----
  const nrm = terrainNormal(x, z);
  const slope = clamp(1 - nrm.y, 0, 1);
  let rockMix = smoothstep(0.2, 0.5, slope) * 0.6;
  rockMix = Math.min(1, rockMix + smoothstep(0.3, 0.55, Math.abs(n4 - 0.5)) * 0.08 * smoothstep(0.1, 0.22, slope));
  if (rockMix > 0.001) {
    let rock = mix3(PAL.rock, PAL.rockDark, n3 * 0.65);
    rock = mix3(rock, PAL.rockLight, n4 * 0.35);
    col = mix3(col, rock, rockMix);
  }

  // ---- 细节明暗 + 轻微去饱和，让大面积草地不单调 ----
  const shade = 0.9 + n3 * 0.16;
  out[0] = col[0] * shade;
  out[1] = col[1] * shade;
  out[2] = col[2] * shade;
}

// 外圈远景坐标（超出地图边界的距离，m）
const OUTER_DISTANCES = [6, 15, 27, 43, 64, 92, 128, 172, 226, 290];

export function createTerrain({ preset, anisotropy = 1 } = {}) {
  const p = preset || {};
  const segments = Math.max(64, Math.min(220, p.terrainSegments || 176));
  const half = WORLD.half;
  const step = WORLD.size / segments;

  const disposables = [];

  // ---------- 共享材质 ----------
  const normalTex = makeGroundNormalTexture(anisotropy);
  const detailTex = makeGroundDetailTexture(anisotropy);
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    map: detailTex || null,
    roughness: 0.965,
    metalness: 0.0,
    normalMap: normalTex || null,
    normalScale: new THREE.Vector2(0.55, 0.55),
    dithering: true,
    envMapIntensity: 0.55,
  });
  if (normalTex) disposables.push(normalTex);
  if (detailTex) disposables.push(detailTex);
  disposables.push(material);

  // ================= 内圈：可玩区域高度场 =================
  const n = segments + 1;
  const positions = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 3);
  const uvs = new Float32Array(n * n * 2);
  const rgb = [0, 0, 0];
  for (let j = 0; j < n; j++) {
    const z = -half + j * step;
    for (let i = 0; i < n; i++) {
      const x = -half + i * step;
      const idx = (j * n + i) * 3;
      positions[idx] = x;
      positions[idx + 1] = heightAt(x, z);
      positions[idx + 2] = z;
      computeColor(x, z, rgb);
      colors[idx] = rgb[0]; colors[idx + 1] = rgb[1]; colors[idx + 2] = rgb[2];
      const uv = (j * n + i) * 2;
      uvs[uv] = x / 3.1;
      uvs[uv + 1] = z / 3.1;
    }
  }
  const index = new Uint32Array(segments * segments * 6);
  let k = 0;
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      index[k++] = a; index[k++] = c; index[k++] = b;
      index[k++] = b; index[k++] = c; index[k++] = d;
    }
  }
  const innerGeo = new THREE.BufferGeometry();
  innerGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  innerGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  innerGeo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  innerGeo.setIndex(new THREE.BufferAttribute(index, 1));
  innerGeo.computeVertexNormals();
  innerGeo.computeBoundingSphere();
  innerGeo.computeBoundingBox();
  disposables.push(innerGeo);

  const innerMesh = new THREE.Mesh(innerGeo, material);
  innerMesh.name = 'terrainInner';
  innerMesh.receiveShadow = true;
  innerMesh.castShadow = false;
  innerMesh.matrixAutoUpdate = false;
  innerMesh.updateMatrix();

  // ================= 外圈：远景地形（不含可玩区）=================
  const layers = Math.max(3, Math.min(OUTER_DISTANCES.length, p.outerMilestones || 7));
  const outerD = OUTER_DISTANCES.slice(0, layers);
  const negAxis = outerD.map((d) => -half - d).reverse();
  const posAxis = outerD.map((d) => half + d);
  const innerAxis = [];
  for (let i = 0; i <= segments; i++) innerAxis.push(-half + i * step);
  const axis = negAxis.concat(innerAxis, posAxis);
  const m = axis.length;
  const nseg = m - 1;
  const off = negAxis.length;
  const oPos = new Float32Array(m * m * 3);
  const oCol = new Float32Array(m * m * 3);
  const oUv = new Float32Array(m * m * 2);
  for (let j = 0; j < m; j++) {
    const z = axis[j];
    for (let i = 0; i < m; i++) {
      const x = axis[i];
      const idx = (j * m + i) * 3;
      oPos[idx] = x;
      oPos[idx + 1] = farHeightAt(x, z);
      oPos[idx + 2] = z;
      computeColor(x, z, rgb);
      // 远景稍微压暗、降低饱和度，和主区域区分（雾会进一步融合）
      oCol[idx] = rgb[0] * 0.94; oCol[idx + 1] = rgb[1] * 0.95; oCol[idx + 2] = rgb[2] * 0.97;
      const uv = (j * m + i) * 2;
      oUv[uv] = x / 3.1;
      oUv[uv + 1] = z / 3.1;
    }
  }
  const oIndex = [];
  for (let j = 0; j < nseg; j++) {
    for (let i = 0; i < nseg; i++) {
      const innerCell = i >= off && i < off + segments && j >= off && j < off + segments;
      if (innerCell) continue;
      const a = j * m + i, b = a + 1, c = a + m, d = c + 1;
      oIndex.push(a, c, b, b, c, d);
    }
  }
  const outerGeo = new THREE.BufferGeometry();
  outerGeo.setAttribute('position', new THREE.BufferAttribute(oPos, 3));
  outerGeo.setAttribute('color', new THREE.BufferAttribute(oCol, 3));
  outerGeo.setAttribute('uv', new THREE.BufferAttribute(oUv, 2));
  outerGeo.setIndex(oIndex);
  outerGeo.computeVertexNormals();
  outerGeo.computeBoundingSphere();
  disposables.push(outerGeo);

  const outerMesh = new THREE.Mesh(outerGeo, material);
  outerMesh.name = 'terrainOuter';
  outerMesh.receiveShadow = false;
  outerMesh.castShadow = false;
  outerMesh.matrixAutoUpdate = false;
  outerMesh.updateMatrix();

  const group = new THREE.Group();
  group.name = 'terrain';
  group.add(innerMesh, outerMesh);

  function dispose() {
    group.remove(innerMesh, outerMesh);
    if (group.parent) group.parent.remove(group);
    for (const d of disposables) if (d && d.dispose) d.dispose();
  }

  return {
    group,
    innerMesh,
    outerMesh,
    raycastTargets: [innerMesh],
    material,
    triangleCount: () => (index.length + oIndex.length) / 3,
    dispose,
  };
}
