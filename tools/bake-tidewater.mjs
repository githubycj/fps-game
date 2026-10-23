// ===== Tidewater 地图烘焙脚本 =====
// 直接运行上游开源代码（vendor/tidewater/src，commit 4811ba4，MIT），把这张地图的
// 地形高度/遮罩、碰撞体、村落+码头+道具+瓦砾几何、岩石、植被布置提取成本游戏使用的数据。
//
// 用法：
//   node tools/bake-tidewater.mjs              # 全量烘焙
//   node tools/bake-tidewater.mjs --only=terrain
//   node tools/bake-tidewater.mjs --skip=debris
//
// 产物（都要提交）：
//   data/tidewater/world.json                    中间产物（可读，便于排查）
//   data/tidewater/terrain.bin                   中间产物
//   shared/tidewater-baked.js                    同构运行时数据（地形高度/碰撞/元数据）
//   public/data/tidewater/geo.bin.gz             浏览器几何/遮罩/植被实例（gzip 容器）
//
// 数据契约见 docs/tidewater-data.md。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor/tidewater/src');
const DATA_DIR = path.join(ROOT, 'data/tidewater');
const PUBLIC_DATA = path.join(ROOT, 'public/data/tidewater');

const args = new Set(process.argv.slice(2));
const onlyArg = [...args].find((a) => a.startsWith('--only='));
const skipArg = [...args].find((a) => a.startsWith('--skip='));
const ONLY = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',')) : null;
const SKIP = skipArg ? new Set(skipArg.slice('--skip='.length).split(',')) : new Set();
const want = (step) => (!ONLY || ONLY.has(step)) && !SKIP.has(step);

// 上游绘制细节纹理时会立刻上传 GPU；无 GPU 环境下由 VENDOR.md 里的补丁跳过（见 DSH-PATCH 3）。
globalThis.__TIDEWATER_HEADLESS__ = true;

const t0 = Date.now();
const log = (...a) => console.log(`[bake ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// ---------- 烘焙窗口（本游戏可玩区域）----------
// 与上游坐标完全一致：米制，y 向上，海平面 y=0，海在 +z，岛在 -z。
const REGION = { x0: -182, z0: -232, size: 384, texel: 1 };
REGION.res = Math.round(REGION.size / REGION.texel) + 1; // 385 个采样点（含两端）

const HEIGHT_SCALE = 0.01; // int16 精度 1 cm，范围 ±327.67 m

const mod = async (rel) => import(pathToFileUrl(path.join(VENDOR, rel)));
function pathToFileUrl(p) {
  return 'file:///' + p.replace(/\\/g, '/').replace(/^\/+/, '');
}

// ---------- 工具 ----------
function quantizeI16(arr, scale) {
  const out = new Int16Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const v = Math.round(arr[i] / scale);
    out[i] = v < -32768 ? -32768 : v > 32767 ? 32767 : v;
  }
  return out;
}
function quantizeI8(arr, scale) {
  const out = new Int8Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const v = Math.round(arr[i] / scale);
    out[i] = v < -128 ? -128 : v > 127 ? 127 : v;
  }
  return out;
}
function quantizeU8(arr, scale, offset = 0) {
  const out = new Uint8Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const v = Math.round((arr[i] + offset) / scale);
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}
function quantizeU16(arr, scale) {
  const out = new Uint16Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const v = Math.round(arr[i] / scale);
    out[i] = v < 0 ? 0 : v > 65535 ? 65535 : v;
  }
  return out;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 二进制容器（与 src/world/tidewater/format.js 对应）----------
class TdwWriter {
  constructor() {
    this.buffers = [];
    this.byName = new Map();
  }
  add(name, type, array) {
    if (this.byName.has(name)) throw new Error('duplicate buffer ' + name);
    const b = { name, type, array, byteLength: array.byteLength };
    this.buffers.push(b);
    this.byName.set(name, b);
    return name;
  }
  build(header) {
    let offset = 0;
    const buffers = this.buffers.map((b) => {
      offset = Math.ceil(offset / 4) * 4;
      const entry = { name: b.name, type: b.type, count: b.array.length, byteOffset: offset, byteLength: b.byteLength };
      offset += b.byteLength;
      return entry;
    });
    const total = offset;
    const payload = Buffer.alloc(total);
    for (let i = 0; i < this.buffers.length; i++) {
      const b = this.buffers[i], e = buffers[i];
      Buffer.from(b.array.buffer, b.array.byteOffset, b.byteLength).copy(payload, e.byteOffset);
    }
    const h = { version: 1, region: REGION, buffers, ...header };
    const json = Buffer.from(JSON.stringify(h), 'utf8');
    const magic = Buffer.from('TDW1', 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(json.length, 0);
    return Buffer.concat([magic, len, json, payload]);
  }
}

function meshFromGeometry(w, name, geo, kind, groups) {
  const a = geo.attributes;
  const mesh = { name, kind, attrs: {}, vertexCount: a.position.count, groups: groups || [] };
  // 位置：i16，精度 1/64 m
  const pos = a.position.array;
  w.add(name + '_pos', 'i16', quantizeI16(pos, 1 / 64));
  mesh.attrs.position = { buffer: name + '_pos', size: 3, scale: 1 / 64 };
  if (a.normal) {
    w.add(name + '_nrm', 'i8', quantizeI8(a.normal.array, 1 / 127));
    mesh.attrs.normal = { buffer: name + '_nrm', size: 3, scale: 1 / 127 };
  }
  if (a.uv) {
    w.add(name + '_uv', 'u16', quantizeU16(a.uv.array, 1 / 32));
    mesh.attrs.uv = { buffer: name + '_uv', size: 2, scale: 1 / 32 };
  }
  if (a.tint) {
    w.add(name + '_tint', 'u8', quantizeU8(a.tint.array, 2 / 255));
    mesh.attrs.tint = { buffer: name + '_tint', size: 3, scale: 2 / 255 };
  }
  if (a.vdata) {
    w.add(name + '_vdata', 'i16', quantizeI16(a.vdata.array, 1 / 1024));
    mesh.attrs.vdata = { buffer: name + '_vdata', size: 4, scale: 1 / 1024 };
  }
  if (a.ao) {
    w.add(name + '_ao', 'u8', quantizeU8(a.ao.array, 1 / 255));
    mesh.attrs.ao = { buffer: name + '_ao', size: 1, scale: 1 / 255 };
  }
  if (geo.index) {
    const idx = geo.index.array;
    // 顶点数 > 65535 时必须 u32
    w.add(name + '_idx', 'u32', new Uint32Array(idx));
    mesh.indices = { buffer: name + '_idx', type: 'u32' };
  }
  const bb = geo.boundingBox || (geo.computeBoundingBox(), geo.boundingBox);
  if (bb) mesh.bounds = { min: bb.min.toArray(), max: bb.max.toArray() };
  return mesh;
}

// ---------- 主流程 ----------
async function main() {
  const THREE = await mod('engine/index.js');
  const { TerrainData } = await mod('world/TerrainData.js');
  const { Colliders } = await mod('world/Colliders.js');
  const { Village } = await mod('world/Village.js');
  const { Rocks } = await mod('world/Rocks.js');
  const { VegSite, scatterVegetation } = await mod('world/vegetation/Scatter.js');

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(PUBLIC_DATA, { recursive: true });

  // ---- 1. 地形 ----
  log('生成地形 TerrainData(seed=7)…');
  const terrain = new TerrainData(7);
  log('地形完成');

  // ---- 2. 村落（会在地形上刻建筑台地，必须先跑）----
  log('构建村落 Village……');
  const scene = new THREE.Group();
  const colliders = new Colliders();
  const village = new Village({ scene, terrain, colliders });
  log(`村落完成：建筑 ${village.buildings.length}，足迹 ${village.footprints.length}，碰撞盒 ${colliders.boxes.length}，圆柱 ${colliders.cylinders.length}`);

  // ---- 3. 岩石 ----
  let rocks = null;
  if (want('rocks')) {
    log('散布岩石 Rocks……');
    rocks = new Rocks({ scene, terrain, village, colliders, castShadow: false, sunShadow: false });
    log(`岩石完成：${rocks.instances.length} 个实例，碰撞盒 ${colliders.boxes.length}`);
  }

  // ---- 4. 植被布置 ----
  let vegRecords = null;
  if (want('veg')) {
    log('散布植被 Scatter……');
    const site = new VegSite(terrain, { footprints: village.footprints });
    const veg = scatterVegetation(site);
    vegRecords = veg;
    const counts = Object.entries(veg).map(([k, v]) => `${k}:${Array.isArray(v) ? v.length : v}`).join(' ');
    log('植被完成：' + counts);
  }

  // ---- 5. 采样地形窗口 + 遮罩 ----
  log('采样 384m 地形窗口……');
  const { x0, z0, size, res, texel } = REGION;
  const heights = new Float32Array(res * res);
  for (let j = 0; j < res; j++) {
    const z = z0 + j * texel;
    for (let i = 0; i < res; i++) {
      heights[j * res + i] = terrain.heightAt(x0 + i * texel, z);
    }
  }
  const MASK_KEYS = ['rock', 'sand', 'path', 'gully', 'seagrass', 'rubble', 'scarp'];
  const masks = {};
  for (const key of MASK_KEYS) masks[key] = new Uint8Array(res * res);
  for (let j = 0; j < res; j++) {
    const z = z0 + j * texel;
    const tj = Math.max(0, Math.min(terrain.res - 1, Math.floor(z - terrain.origin)));
    for (let i = 0; i < res; i++) {
      const x = x0 + i * texel;
      const ti = Math.max(0, Math.min(terrain.res - 1, Math.floor(x - terrain.origin)));
      const src = tj * terrain.res + ti;
      const k = j * res + i;
      masks.rock[k] = Math.round(Math.max(0, Math.min(1, terrain.rock[src])) * 255);
      masks.sand[k] = terrain.sand[src];
      masks.path[k] = terrain.path[src];
      masks.gully[k] = terrain.gully[src];
      masks.seagrass[k] = terrain.seagrass[src];
      masks.rubble[k] = terrain.rubble[src];
      masks.scarp[k] = terrain.scarp[src];
    }
  }
  let hmin = Infinity, hmax = -Infinity;
  for (const h of heights) { if (h < hmin) hmin = h; if (h > hmax) hmax = h; }
  log(`地形窗口完成：高度 ${hmin.toFixed(1)} … ${hmax.toFixed(1)} m`);

  // ---- 6. 碰撞体 / 元数据 ----
  const colliderBoxes = colliders.boxes.map((b) => ({
    x: +b.center.x.toFixed(3), y: +b.center.y.toFixed(3), z: +b.center.z.toFixed(3),
    hx: +b.half.x.toFixed(3), hy: +b.half.y.toFixed(3), hz: +b.half.z.toFixed(3),
    rotY: +b.rotY.toFixed(4), walkable: !!b.walkable, tag: b.tag || '',
  }));
  const colliderCyls = colliders.cylinders.map((c) => ({
    x: +c.x.toFixed(3), z: +c.z.toFixed(3), r: +(c.r ?? c.radius).toFixed(3),
    yMin: +c.yMin.toFixed(3), yMax: +c.yMax.toFixed(3), tag: c.tag || '',
  }));

  // ---- 7. 安全出生点 ----
  const spawns = buildSpawns(terrain, colliders, village);

  // ---- 8. 写出 world.json ----
  const worldMeta = {
    region: REGION,
    source: { repo: 'dgreenheck/tidewater', commit: '4811ba48d795197de5621985f404e765c0b7c0ef', license: 'MIT' },
    pier: village.pierInfo || null,
    village: { center: { x: 40, z: -118 }, radius: 95 },
    buildings: village.buildings,
    footprints: village.footprints,
    lights: village.lights,
    path: village.path ? { length: village.path.length, width: village.path.width, samples: village.path.samples } : null,
    sidePaths: village.sidePaths,
    rockSites: terrain.rockSites,
    spawn: { x: 53.6, z: -77, yaw: Math.PI },
    colliders: { boxes: colliderBoxes, cylinders: colliderCyls },
    spawns,
    counts: {
      buildings: village.buildings.length, footprints: village.footprints.length,
      boxes: colliderBoxes.length, cylinders: colliderCyls.length,
      rocks: rocks ? rocks.instances.length : 0,
    },
  };
  fs.writeFileSync(path.join(DATA_DIR, 'world.json'), JSON.stringify(worldMeta));

  // ---- 9. shared/tidewater-baked.js（同构，提交）----
  log('生成 shared/tidewater-baked.js…');
  const heightsI16 = quantizeI16(heights, HEIGHT_SCALE);
  const heightsB64 = Buffer.from(heightsI16.buffer, heightsI16.byteOffset, heightsI16.byteLength).toString('base64');
  const baked = renderBakedModule({
    region: REGION, heightsB64, heightScale: HEIGHT_SCALE,
    colliders: { boxes: colliderBoxes, cylinders: colliderCyls },
    meta: {
      pier: worldMeta.pier, village: worldMeta.village, buildings: village.buildings,
      footprints: village.footprints, path: worldMeta.path, sidePaths: worldMeta.sidePaths,
      spawn: worldMeta.spawn, rockSites: terrain.rockSites,
    },
    spawns,
  });
  fs.writeFileSync(path.join(ROOT, 'shared/tidewater-baked.js'), baked);
  log('shared/tidewater-baked.js 已写出', (baked.length / 1024).toFixed(0) + ' KB');

  // ---- 10. geo.bin.gz（浏览器几何）----
  log('打包几何 geo.bin.gz…');
  const w = new TdwWriter();
  const header = { meshes: [], masks: [] };

  // 村庄：5 个不透明批次共享同一份 geometry（用 drawRange 区分材质槽），fabric / nets 各自独立
  const SLOT_ORDER = ['wood', 'hard', 'roofMetal', 'thatch', 'stone'];
  const byName = new Map(village.meshes.map((m) => [m.name, m]));
  const opaque = SLOT_ORDER.map((s) => byName.get('village_' + s)).filter(Boolean);
  if (opaque.length) {
    const base = opaque[0].geometry;
    const groups = opaque.map((m) => ({
      slot: m.name.replace('village_', ''),
      start: m.geometry.drawRange.start,
      count: m.geometry.drawRange.count === Infinity ? base.index.count : m.geometry.drawRange.count,
    }));
    header.meshes.push(meshFromGeometry(w, 'village', base, 'village', groups));
    for (const m of village.meshes) {
      if (opaque.includes(m)) continue;
      const slot = m.name.replace('village_', '');
      header.meshes.push(meshFromGeometry(w, m.name, m.geometry, 'village', [{ slot, start: 0, count: m.geometry.index.count }]));
    }
  }

  // 岩石：4 种原型近景几何 + 实例矩阵（实例里的 style 是 ROCK_STYLES 的下标）
  if (rocks) {
    const protoName = new Map(); // style 下标 → mesh name
    rocks.buckets.forEach((b, s) => {
      const styleName = b.near.name.match(/rocks-(.+)-near/)[1];
      const meshName = 'rock_' + styleName + '_near';
      protoName.set(s, meshName);
      header.meshes.push(meshFromGeometry(w, meshName, b.near.geometry, 'rockProto', []));
    });
    const rm = new Map(); // style → [matrix16...]
    for (const r of rocks.instances) {
      const key = r.style ?? 0;
      if (!rm.has(key)) rm.set(key, []);
      rm.get(key).push(...r.matrix.elements);
    }
    // instance buffer: stride 16 (matrix)，每个 style 一段
    const instBuf = [];
    const instStyles = [];
    let cursor = 0;
    for (const [style, list] of [...rm.entries()].sort((a, b) => a[0] - b[0])) {
      instBuf.push(...list);
      instStyles.push({ style, mesh: protoName.get(style), start: cursor, count: list.length / 16 });
      cursor += list.length / 16;
    }
    w.add('rock_mtx', 'f32', new Float32Array(instBuf));
    header.rockInstances = { buffer: 'rock_mtx', type: 'f32', stride: 16, count: cursor, styles: instStyles };
  }

  // 植被：窗口内记录（typeIdx, x, y, z, s, sy, yaw, seed, H, 0）
  if (vegRecords) {
    const types = Object.keys(vegRecords).filter((k) => Array.isArray(vegRecords[k]));
    const inRegion = (x, z) => x >= x0 && x <= x0 + size && z >= z0 && z <= z0 + size;
    const rows = [];
    for (let ti = 0; ti < types.length; ti++) {
      for (const r of vegRecords[types[ti]]) {
        if (!inRegion(r.x, r.z)) continue;
        rows.push(ti, r.x, r.y, r.z, r.s, r.sy ?? r.s, r.yaw, r.seed, r.H ?? 1, 0);
      }
    }
    w.add('veg_rec', 'f32', new Float32Array(rows));
    header.vegetation = { types, buffer: 'veg_rec', type: 'f32', stride: 10, count: rows.length / 10 };
    const counts = types.map((t, i) => { let n = 0; for (let k = 0; k < rows.length; k += 10) if (rows[k] === i) n++; return `${t}:${n}`; });
    log(`植被窗口内 ${rows.length / 10} 条记录（${counts.join(' ')}）`);
  }

  // 遮罩
  for (const key of MASK_KEYS) {
    w.add('mask_' + key, 'u8', masks[key]);
    header.masks.push({ name: key, buffer: 'mask_' + key, type: 'u8', res });
  }

  // 高度（浏览器端做顶点位移 / 快速采样）
  w.add('height_i16', 'i16', heightsI16);
  header.heights = { buffer: 'height_i16', type: 'i16', scale: HEIGHT_SCALE, res };

  const raw = w.build(header);
  const gz = zlib.gzipSync(raw, { level: 9 });
  fs.writeFileSync(path.join(PUBLIC_DATA, 'geo.bin.gz'), gz);
  log(`geo.bin.gz 已写出：raw ${(raw.length / 1048576).toFixed(2)} MB → gzip ${(gz.length / 1048576).toFixed(2)} MB`);

  // 中间产物：地形原始数据
  const terrainBin = Buffer.alloc(res * res * 2 + MASK_KEYS.length * res * res);
  Buffer.from(heightsI16.buffer, heightsI16.byteOffset, heightsI16.byteLength).copy(terrainBin, 0);
  let mo = res * res * 2;
  for (const key of MASK_KEYS) { Buffer.from(masks[key]).copy(terrainBin, mo); mo += res * res; }
  fs.writeFileSync(path.join(DATA_DIR, 'terrain.bin'), terrainBin);

  log('完成 ✔');
}

// ---------- 出生点 ----------
function buildSpawns(terrain, colliders, village) {
  const candidates = [];
  const push = (x, z, tag) => {
    const y = terrain.heightAt(x, z);
    if (!Number.isFinite(y) || y < -60) return;
    const ground = colliders.groundHeightAt(x, z, y + 6, 0);
    const top = ground > -Infinity ? Math.max(y, ground) : y;
    if (top < 0.4) return; // 水下
    // 不能在实体碰撞盒里
    for (const b of colliders.boxes) {
      if (b.top < top + 0.2) continue;
      if (b.bottom > top + 1.8) continue;
      const dx = x - b.center.x, dz = z - b.center.z;
      if (Math.abs(dx) > b.radius + 1 || Math.abs(dz) > b.radius + 1) continue;
      const lx = dx * b.cos - dz * b.sin, lz = dx * b.sin + dz * b.cos;
      if (Math.abs(lx) < b.half.x + 0.6 && Math.abs(lz) < b.half.z + 0.6) return;
    }
    candidates.push({ x: +x.toFixed(2), z: +z.toFixed(2), y: +top.toFixed(2), tag });
  };
  push(53.6, -77, 'start');
  push(18, -60, 'spawn');
  // 村落 / 广场 / 码头 / 海滩 四个区域均匀撒点
  const areas = [
    { x0: -10, x1: 100, z0: -160, z1: -85, tag: 'village' },
    { x0: 30, x1: 80, z0: -90, z1: 30, tag: 'pier' },
    { x0: -120, x1: 150, z0: -45, z1: 5, tag: 'beach' },
    { x0: -60, x1: 110, z0: -190, z1: -150, tag: 'ridge' },
  ];
  const rand = mulberry32(20261024);
  for (const a of areas) {
    for (let i = 0; i < 120 && candidates.filter((c) => c.tag === a.tag).length < 8; i++) {
      push(a.x0 + rand() * (a.x1 - a.x0), a.z0 + rand() * (a.z1 - a.z0), a.tag);
    }
  }
  // 去重（同区域点间距 > 8m）
  const kept = [];
  for (const c of candidates) {
    if (c.tag !== 'start' && kept.some((k) => Math.hypot(k.x - c.x, k.z - c.z) < 8)) continue;
    kept.push({ ...c, yaw: 0 });
  }
  // yaw 朝向地图中心，避免出生就看墙
  for (const s of kept) s.yaw = Math.atan2(0 - s.x, -10 - s.z);
  for (const s of kept) if (s.tag === 'start' || s.tag === 'spawn') s.yaw = Math.PI;
  return kept;
}

// ---------- 生成 shared/tidewater-baked.js ----------
function renderBakedModule({ region, heightsB64, heightScale, colliders, meta, spawns }) {
  const lin = (arr) => '[' + arr.map((n) => (Number.isInteger(n) ? n : +n.toFixed(4))).join(',') + ']';
  const boxes = colliders.boxes.map((b) =>
    `{x:${b.x},y:${b.y},z:${b.z},hx:${b.hx},hy:${b.hy},hz:${b.hz},rotY:${b.rotY},walkable:${b.walkable ? 1 : 0},tag:${JSON.stringify(b.tag)}}`).join(',\n  ');
  const cyls = colliders.cylinders.map((c) =>
    `{x:${c.x},z:${c.z},r:${c.r},yMin:${c.yMin},yMax:${c.yMax},tag:${JSON.stringify(c.tag)}}`).join(',\n  ');
  const buildingList = (meta.buildings || []).map((b) =>
    `{name:${JSON.stringify(b.name)},x:${+b.x.toFixed(3)},z:${+b.z.toFixed(3)},floorY:${+b.floorY.toFixed(3)},roofTop:${+b.roofTop.toFixed(3)},stilts:${!!b.stilts},r:${+b.footprint.r.toFixed(3)}}`).join(',\n  ');
  const spawnList = spawns.map((s) =>
    `{x:${s.x},z:${s.z},y:${s.y},yaw:${+s.yaw.toFixed(4)},tag:${JSON.stringify(s.tag)}}`).join(',\n  ');
  return `// ===== 自动生成：Tidewater 地图的运行时数据 =====
// 由 tools/bake-tidewater.mjs 直接运行上游 dgreenheck/tidewater（MIT, commit 4811ba48）生成。
// 不要手改本文件；改烘焙脚本后重新执行 node tools/bake-tidewater.mjs。
// 数据契约见 docs/tidewater-data.md。

export const BAKED_SOURCE = { repo: 'dgreenheck/tidewater', commit: '4811ba48d795197de5621985f404e765c0b7c0ef', license: 'MIT' };

// 烘焙窗口：x ∈ [${region.x0}, ${region.x0 + region.size}]，z ∈ [${region.z0}, ${region.z0 + region.size}]，1 m 采样
export const BAKED_REGION = ${JSON.stringify({ x0: region.x0, z0: region.z0, size: region.size, res: region.res, texel: region.texel })};

// 高度图：int16，scale = ${heightScale} m（行优先：index = j * res + i，i 沿 +x，j 沿 +z）
export const HEIGHT_SCALE = ${heightScale};
export const HEIGHT_B64 = '${heightsB64}';

// 碰撞体（与上游 Colliders 同参：addBox(center, half, rotY, {walkable, tag})）
export const BAKED_COLLIDERS = {
  boxes: [
  ${boxes}
  ],
  cylinders: [
  ${cyls}
  ],
};

// 地图元数据
export const BAKED_META = {
  source: BAKED_SOURCE,
  region: BAKED_REGION,
  village: ${JSON.stringify(meta.village)},
  pier: ${JSON.stringify(meta.pier)},
  buildings: [
  ${buildingList}
  ],
  footprints: ${JSON.stringify((meta.footprints || []).map((f) => ({ x: +f.x.toFixed(2), z: +f.z.toFixed(2), r: +f.r.toFixed(2), kind: f.kind || '' })))},
  path: ${JSON.stringify(meta.path)},
  sidePaths: ${JSON.stringify(meta.sidePaths)},
  spawn: ${JSON.stringify(meta.spawn)},
  rockSites: ${JSON.stringify((meta.rockSites || []).map((r) => ({ x: +r.x.toFixed(2), z: +r.z.toFixed(2), r: +r.r.toFixed(2), h: +r.h.toFixed(2) })))},
};

// 出生点（已按地形与碰撞校正）
export const BAKED_SPAWNS = [
  ${spawnList}
];

// ---------- 高度采样（双线性，窗口外 clamp 到边缘）----------
let _heights = null;
export function bakedHeights() {
  if (_heights) return _heights;
  const bin = typeof atob === 'function' ? atob(HEIGHT_B64) : Buffer.from(HEIGHT_B64, 'base64').toString('binary');
  const n = bin.length;
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
  _heights = new Int16Array(bytes.buffer, bytes.byteOffset, n >> 1);
  return _heights;
}

export function heightAt(x, z) {
  const { x0, z0, size, res } = BAKED_REGION;
  const h = bakedHeights();
  const step = size / (res - 1);
  let fx = (x - x0) / step, fz = (z - z0) / step;
  if (fx < 0) fx = 0; else if (fx > res - 1) fx = res - 1;
  if (fz < 0) fz = 0; else if (fz > res - 1) fz = res - 1;
  const i = Math.min(res - 2, Math.floor(fx)), j = Math.min(res - 2, Math.floor(fz));
  const tx = fx - i, tz = fz - j;
  const k = j * res + i;
  const a = h[k], b = h[k + 1], c = h[k + res], d = h[k + res + 1];
  return ((a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz) * HEIGHT_SCALE;
}

export function normalAt(x, z, out = { x: 0, y: 1, z: 0 }) {
  const e = 1;
  const hx = heightAt(x + e, z) - heightAt(x - e, z);
  const hz = heightAt(x, z + e) - heightAt(x, z - e);
  const nx = -hx, ny = 2 * e, nz = -hz;
  const len = Math.hypot(nx, ny, nz) || 1;
  out.x = nx / len; out.y = ny / len; out.z = nz / len;
  return out;
}
`;
}

main().catch((e) => {
  console.error('[bake] 失败：', e && e.stack ? e.stack : e);
  process.exit(1);
});
