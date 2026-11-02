// Tidewater terrain, driven directly by the baked upstream GEO data (geo.bin.gz).
//
// Two meshes:
//   near  - 384x384 m window, 1 m grid (GEO.heights(), 385^2 samples), decimated to
//           2 m / 3 m for medium / low quality.
//   far   - the whole island at the baked 8 m texel (GEO.island()), laid around the
//           near window.  Cells fully inside the near window are dropped, the overlap
//           strip is snapped to the near surface and sunk slightly, so there is never
//           a visible crack or a floating cliff.
//
// Vertex colours are mixed from the seven baked masks (rock, sand, path, gully,
// seagrass, rubble, scarp) plus slope and a little procedural detail noise.
// Material is a plain MeshStandardMaterial + vertexColors (no custom PBR).

import * as THREE from 'three';
import { GEO } from './load-geo.js';

const REGION = GEO.header.region; // { x0, z0, size, res } at 1 m
const ISLAND = GEO.header.island; // { x0, z0, size, texel, res }
const MASK_ORDER = ['rock', 'sand', 'path', 'gully', 'seagrass', 'rubble', 'scarp'];

// How far the far mesh is pushed down under the near mesh (metres).
const SEAM_DROP = 0.42;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
function smoothstep(a, b, x) {
  if (a === b) return x < a ? 0 : 1;
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

function hash2(ix, iz) {
  let h = Math.imul(ix | 0, 374761393) + Math.imul(iz | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise(x, z) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function fbm(x, z, octaves) {
  let amp = 0.5;
  let sum = 0;
  let norm = 0;
  let fx = x;
  let fz = z;
  for (let i = 0; i < octaves; i++) {
    sum += vnoise(fx, fz) * amp;
    norm += amp;
    amp *= 0.5;
    fx = fx * 2.07 + 17.1;
    fz = fz * 2.03 - 9.4;
  }
  return sum / norm;
}

// ---------------------------------------------------------------------------
// palette (sRGB hex; THREE.Color converts to the working colour space)
// ---------------------------------------------------------------------------

const C = {
  sandDry: new THREE.Color(0xe4d5ac),
  sandDry2: new THREE.Color(0xd6c295),
  sandWet: new THREE.Color(0xb5a075),
  bedShallow: new THREE.Color(0xc8b78a),
  bedDeep: new THREE.Color(0x46564e),
  seaGrass: new THREE.Color(0x5c7a58),
  grassA: new THREE.Color(0x7a8a4c),
  grassB: new THREE.Color(0x63763a),
  grassLush: new THREE.Color(0x557a3e),
  grassDry: new THREE.Color(0xa6a364),
  rock: new THREE.Color(0x8d8779),
  rockDark: new THREE.Color(0x6a6459),
  rockLight: new THREE.Color(0xb2a795),
  dirt: new THREE.Color(0xb2966b),
  dirtWet: new THREE.Color(0x7c6a4b),
  rubble: new THREE.Color(0x9b9283),
  scarp: new THREE.Color(0xb3a68f),

  // far / background island
  farSand: new THREE.Color(0xdccca2),
  farGrass: new THREE.Color(0x66794a),
  farGrass2: new THREE.Color(0x50633a),
  farRock: new THREE.Color(0x8b8478),
  farRockDark: new THREE.Color(0x655f55),
  farRockLight: new THREE.Color(0xa79c8c),
  farSeabed: new THREE.Color(0x8c8b6d),
  farDeep: new THREE.Color(0x3d4c48),
  farSeagrass: new THREE.Color(0x556655),
};

const _c1 = new THREE.Color();
const _c2 = new THREE.Color();
const _c3 = new THREE.Color();

// ---------------------------------------------------------------------------
// data caches (GEO decodes on each call, so keep one copy around)
// ---------------------------------------------------------------------------

let _heights = null;
let _masks = null;

function heights() {
  if (!_heights) _heights = GEO.heights();
  return _heights;
}

function masks() {
  if (!_masks) {
    _masks = {};
    for (const name of MASK_ORDER) _masks[name] = GEO.mask(name);
  }
  return _masks;
}

/** Bilinear sampler over the near (1 m) height grid, clamped to the window. */
export function createHeightSampler() {
  const R = REGION;
  const H = heights();
  const res = R.res;
  const step = R.size / (res - 1);
  return function heightAt(x, z) {
    let gx = (x - R.x0) / step;
    let gz = (z - R.z0) / step;
    gx = clamp(gx, 0, res - 1.0001);
    gz = clamp(gz, 0, res - 1.0001);
    const i = gx | 0;
    const j = gz | 0;
    const tx = gx - i;
    const tz = gz - j;
    const k = j * res + i;
    const k1 = k + 1;
    const k2 = k + res;
    const k3 = k2 + 1;
    const a = H[k] * (1 - tx) + H[k1] * tx;
    const b = H[k2] * (1 - tx) + H[k3] * tx;
    return a * (1 - tz) + b * tz;
  };
}

/** Island (8 m) bilinear sampler, used to keep the far mesh consistent. */
function islandSampler() {
  const I = GEO.island();
  const R = I.region;
  const H = I.heights;
  return function islandAt(x, z) {
    let gx = (x - R.x0) / R.texel;
    let gz = (z - R.z0) / R.texel;
    gx = clamp(gx, 0, R.res - 1.0001);
    gz = clamp(gz, 0, R.res - 1.0001);
    const i = gx | 0;
    const j = gz | 0;
    const tx = gx - i;
    const tz = gz - j;
    const k = j * R.res + i;
    const a = H[k] * (1 - tx) + H[k + 1] * tx;
    const b = H[k + R.res] * (1 - tx) + H[k + R.res + 1] * tx;
    return a * (1 - tz) + b * tz;
  };
}

// ---------------------------------------------------------------------------
// near colours
// ---------------------------------------------------------------------------

function nearColor(x, z, h, slope, out) {
  const M = masks();
  const R = REGION;
  const i = clamp(Math.round(x - R.x0), 0, R.res - 1);
  const j = clamp(Math.round(z - R.z0), 0, R.res - 1);
  const k = j * R.res + i;

  const sand = M.sand[k] * (1 / 255);
  const rock = M.rock[k] * (1 / 255);
  const path = M.path[k] * (1 / 255);
  const gully = M.gully[k] * (1 / 255);
  const sea = M.seagrass[k] * (1 / 255);
  const rubble = M.rubble[k] * (1 / 255);
  const scarp = M.scarp[k] * (1 / 255);

  const macro = fbm(x * 0.052 + 3.1, z * 0.052 - 7.4, 3);
  const micro = fbm(x * 0.41 - 12.7, z * 0.41 + 5.9, 2);
  const fine = vnoise(x * 1.7 + 8.4, z * 1.7 - 2.3);

  const steep = clamp01((slope - 0.38) / 0.95);
  const depth = -h;

  // --- dry land base: grass / scrub
  _c1.copy(C.grassA).lerp(C.grassB, macro);
  _c1.lerp(C.grassLush, clamp01((h - 6) / 48) * 0.55);
  _c1.lerp(C.grassDry, micro * 0.2);

  // --- sand: the baked sand mask is a wide "sandy soil" field, so it is used as a
  //     blend weight and boosted close to sea level.
  const wetBand = smoothstep(1.9, 0.1, h); // 1 at/below the waterline
  let sandW = Math.max(sand * 1.25, smoothstep(3.4, 0.5, h) * 0.6);
  sandW = clamp01(sandW) * (1 - steep * 0.6);
  _c2.copy(C.sandDry).lerp(C.sandDry2, micro * 0.5);
  _c1.lerp(_c2, sandW);

  // --- rock: baked masks plus steep faces
  const rockW = clamp01(rock * 1.05 + rubble * 0.9 + scarp * 1.1 + steep * 0.95);
  _c2.copy(C.rock).lerp(C.rockDark, clamp01(micro * 0.55 + gully * 0.5));
  _c2.lerp(C.rockLight, macro * 0.3);
  _c1.lerp(_c2, rockW);
  _c1.lerp(C.rubble, rubble * 0.35 * (1 - rockW * 0.5));

  // --- dirt: paths / eroded gullies
  const dirtW = clamp01(path * 1.4 + gully * 0.45) * (1 - rockW * 0.8);
  _c2.copy(C.dirt).lerp(C.dirtWet, clamp01(gully * 0.8 + wetBand * 0.35));
  _c1.lerp(_c2, dirtW);

  // --- wet sand right at the waterline
  const underW = smoothstep(1.15, -0.75, h);
  if (underW > 0.004) {
    _c2.copy(C.bedShallow).lerp(C.bedDeep, smoothstep(1.0, 15, depth));
    _c2.lerp(C.seaGrass, sea * smoothstep(0.5, 3.0, depth) * 0.9);
    _c2.lerp(C.sandWet, wetBand * 0.22);
    _c1.lerp(_c2, underW);
  } else {
    _c1.lerp(C.sandWet, wetBand * sandW * 0.5);
  }

  // --- detail shading
  const shade = 0.9 + 0.2 * micro + 0.09 * fine + 0.06 * (macro - 0.5);
  out.copy(_c1).multiplyScalar(shade * (1 - steep * 0.07));
  return out;
}

// ---------------------------------------------------------------------------
// far colours
// ---------------------------------------------------------------------------

function farColor(x, z, h, slope, out) {
  const macro = fbm(x * 0.021 + 5.3, z * 0.021 - 2.1, 3);
  const micro = vnoise(x * 0.11 - 3.7, z * 0.11 + 6.2);
  const steep = clamp01((slope - 0.45) / 1.25);

  // seabed -> sand
  _c1.copy(C.farDeep).lerp(C.farSeabed, smoothstep(34, 3.5, -h));
  _c1.lerp(C.farSeagrass, smoothstep(0.2, 4, -h) * macro * 0.35);

  // dry sand band
  const sandW = smoothstep(-0.5, 1.6, h) * (1 - smoothstep(2.4, 6.5, h) * 0.85);
  _c1.lerp(C.farSand, sandW);

  // grass / scrub
  const grassW = smoothstep(3.0, 8.0, h) * (1 - smoothstep(52, 68, h) * 0.7);
  _c2.copy(C.farGrass).lerp(C.farGrass2, macro);
  _c1.lerp(_c2, grassW);

  // rock: steep faces, high ground
  const rockW = clamp01(steep * 0.95 + smoothstep(50, 66, h) * 0.7);
  _c2.copy(C.farRock).lerp(C.farRockDark, clamp01(steep * 0.6 + micro * 0.4));
  _c2.lerp(C.farRockLight, clamp01((h - 60) / 160) * 0.7 + macro * 0.2);
  _c1.lerp(_c2, rockW);

  const shade = 0.92 + 0.16 * micro + 0.05 * (macro - 0.5);
  out.copy(_c1).multiplyScalar(shade);
  return out;
}

// ---------------------------------------------------------------------------
// near mesh
// ---------------------------------------------------------------------------

function nearStepOf(preset) {
  const seg = (preset && preset.terrainSegments) || 144;
  if (seg >= 140) return 1;
  if (seg >= 120) return 2;
  return 3;
}

function buildNearGeometry(step) {
  const R = REGION;
  const H = heights();
  const res = R.res;
  const cols = Math.round(R.size / step) + 1; // 385 / 193 / 129
  const vcount = cols * cols;
  const pos = new Float32Array(vcount * 3);
  const col = new Float32Array(vcount * 3);
  const uv = new Float32Array(vcount * 2);
  const c = new THREE.Color();
  const inv = 1 / step;

  for (let j = 0; j < cols; j++) {
    const sj = Math.min(res - 1, Math.round(j * step));
    const z = R.z0 + j * step;
    for (let i = 0; i < cols; i++) {
      const si = Math.min(res - 1, Math.round(i * step));
      const x = R.x0 + i * step;
      const k = sj * res + si;
      const h = H[k];

      const iL = si > 0 ? si - 1 : si;
      const iR = si < res - 1 ? si + 1 : si;
      const jD = sj > 0 ? sj - 1 : sj;
      const jU = sj < res - 1 ? sj + 1 : sj;
      const gx = (H[sj * res + iR] - H[sj * res + iL]) / Math.max(1, iR - iL);
      const gz = (H[jU * res + si] - H[jD * res + si]) / Math.max(1, jU - jD);
      const slope = Math.hypot(gx, gz);

      nearColor(x, z, h, slope, c);
      const v = j * cols + i;
      pos[v * 3] = x;
      pos[v * 3 + 1] = h;
      pos[v * 3 + 2] = z;
      col[v * 3] = c.r;
      col[v * 3 + 1] = c.g;
      col[v * 3 + 2] = c.b;
      uv[v * 2] = (x - R.x0) * inv * 0.08;
      uv[v * 2 + 1] = (z - R.z0) * inv * 0.08;
    }
  }

  const quads = (cols - 1) * (cols - 1);
  const index = vcount > 65535 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
  let o = 0;
  for (let j = 0; j < cols - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      // counter-clockwise when seen from +y
      index[o++] = a;
      index[o++] = d;
      index[o++] = b;
      index[o++] = b;
      index[o++] = d;
      index[o++] = e;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

// ---------------------------------------------------------------------------
// far mesh (whole island at 8 m, near window punched out)
// ---------------------------------------------------------------------------

function buildFarGeometry() {
  const I = GEO.island();
  const R = I.region;
  const H = I.heights;
  const res = R.res;
  const texel = R.texel;
  const heightAt = createHeightSampler();

  // near window in world space
  const nx0 = REGION.x0;
  const nx1 = REGION.x0 + REGION.size;
  const nz0 = REGION.z0;
  const nz1 = REGION.z0 + REGION.size;
  const insideX = (x) => x > nx0 + 1e-4 && x < nx1 - 1e-4;
  const insideZ = (z) => z > nz0 + 1e-4 && z < nz1 - 1e-4;

  const pos = new Float32Array(res * res * 3);
  const col = new Float32Array(res * res * 3);
  const c = new THREE.Color();
  const inv = 1 / texel;

  for (let j = 0; j < res; j++) {
    const z = R.z0 + j * texel;
    for (let i = 0; i < res; i++) {
      const x = R.x0 + i * texel;
      const k = j * res + i;
      const raw = H[k];
      // inside the near window: follow the detailed surface so the seam is continuous
      let y = insideX(x) && insideZ(z) ? heightAt(x, z) : raw;
      y -= SEAM_DROP;

      const iL = i > 0 ? i - 1 : i;
      const iR = i < res - 1 ? i + 1 : i;
      const jD = j > 0 ? j - 1 : j;
      const jU = j < res - 1 ? j + 1 : j;
      const gx = (H[j * res + iR] - H[j * res + iL]) / Math.max(1, iR - iL) * inv;
      const gz = (H[jU * res + i] - H[jD * res + i]) / Math.max(1, jU - jD) * inv;
      const slope = Math.hypot(gx, gz);

      farColor(x, z, raw, slope, c);
      const v = k * 3;
      pos[v] = x;
      pos[v + 1] = y;
      pos[v + 2] = z;
      col[v] = c.r;
      col[v + 1] = c.g;
      col[v + 2] = c.b;
    }
  }

  // Cell fully inside the near window?
  const skipCell = (i, j) => {
    const x0 = R.x0 + i * texel;
    const x1 = x0 + texel;
    const z0 = R.z0 + j * texel;
    const z1 = z0 + texel;
    return x0 >= nx0 - 1e-4 && x1 <= nx1 + 1e-4 && z0 >= nz0 - 1e-4 && z1 <= nz1 + 1e-4;
  };

  const idx = [];
  for (let j = 0; j < res - 1; j++) {
    for (let i = 0; i < res - 1; i++) {
      if (skipCell(i, j)) continue;
      const a = j * res + i;
      const b = a + 1;
      const d = a + res;
      const e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

export function createTerrain({ preset, anisotropy = 1, extras = {} } = {}) {
  const p = preset || {};
  const seaLevel = (extras && extras.seaLevel) || 0;
  const group = new THREE.Group();
  group.name = 'terrainBaked';

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.97,
    metalness: 0,
    dithering: true,
  });
  material.name = 'terrainBakedMaterial';

  let step = nearStepOf(p);
  let nearGeo = buildNearGeometry(step);
  const farGeo = buildFarGeometry();

  const nearMesh = new THREE.Mesh(nearGeo, material);
  nearMesh.name = 'terrainNear';
  nearMesh.receiveShadow = true;
  nearMesh.castShadow = false;
  nearMesh.matrixAutoUpdate = false;
  nearMesh.updateMatrix();

  const farMesh = new THREE.Mesh(farGeo, material);
  farMesh.name = 'terrainFar';
  farMesh.receiveShadow = false;
  farMesh.castShadow = false;
  farMesh.matrixAutoUpdate = false;
  farMesh.updateMatrix();

  group.add(farMesh);
  group.add(nearMesh);

  const raycastTargets = [nearMesh, farMesh];
  const heightAt = createHeightSampler();

  function triOf(geo) {
    const n = geo.index ? geo.index.count : geo.getAttribute('position').count;
    return n / 3;
  }

  function rebuildNear(nextStep) {
    step = nextStep;
    const next = buildNearGeometry(step);
    group.remove(nearMesh);
    nearMesh.geometry.dispose();
    nearGeo = next;
    nearMesh.geometry = next;
    nearMesh.updateMatrix();
    const b = next.boundingSphere;
    if (b) {
      nearMesh.matrixAutoUpdate = false;
    }
  }

  return {
    group,
    raycastTargets,
    nearMesh,
    farMesh,
    material,
    get step() {
      return step;
    },
    /** bilinear near height sampler (also handed to the ocean) */
    heightAt,
    seaLevel,
    update() {
      /* static geometry: nothing per frame */
    },
    setQuality(next) {
      const s = nearStepOf(next);
      if (s !== step) rebuildNear(s);
    },
    dispose() {
      group.remove(farMesh, nearMesh);
      nearGeo.dispose();
      farGeo.dispose();
      material.dispose();
    },
    get triangleCount() {
      return triOf(nearGeo) + triOf(farGeo);
    },
    stats() {
      return {
        nearTriangles: triOf(nearGeo),
        farTriangles: triOf(farGeo),
        nearStep: step,
        nearVertices: nearGeo.getAttribute('position').count,
        farVertices: farGeo.getAttribute('position').count,
      };
    },
  };
}

export default createTerrain;
