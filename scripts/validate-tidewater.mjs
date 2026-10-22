// ===== 潮汐湾（Tidewater）地图数据自检脚本（开发期用，非发布构建）=====
// 用法：node scripts/validate-tidewater.mjs
//
// 覆盖 DESIGN_TIDEWATER_DM.md §3.7 的全部断言，并额外验证：
// 地形标定（岬角/主脊/海床/沙滩坡度）、栈桥可走性（含真实物理行走）、
// 房屋门洞可通行、沙滩→村落路径、API 导出面、MAP_EXTRAS 结构。
import * as M from '../shared/tidewater.js';

const {
  WORLD, SUN, ZONES, HOUSES, PYLONS, CARS, DEFENSES, FENCES, ROADS, TREES, ROCKS,
  BOUNDARY, COLLIDERS, SPAWNS, CRATE_SPOTS, ITEM_SPOTS, FURNITURE, FURNITURE_DEF,
  WINDOW_SPEC, WORLD_INFO, MAP_EXTRAS,
  heightAt, terrainNormal, surfaceAt, houseSides, houseFloorTop, houseWallSegments,
  seedOf, circleOverlapsBox, movePlayerHorizontal, groundHeightAt, stepPlayerPhysics,
  applyJump, hitboxesFor, raycastWorld, losBlocked, zoneOf, pickSpawn, spawnYaw,
  isWalkableAt, hash2i, valueNoise, mulberry32,
} = M;

const fmt = (v, n = 2) => Number(v).toFixed(n);
const deg = (slope) => (Math.atan(slope) * 180) / Math.PI;

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  \u2713 ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; failures.push(name); console.log('  \u2717 ' + name + (extra ? '  ' + extra : '')); }
};
const head = (t) => console.log('\n== ' + t + ' ==');

const SQUAD_IDS = ['alpha', 'bravo', 'charlie', 'delta'];
const SEA = MAP_EXTRAS.seaLevel;
const PIER = MAP_EXTRAS.pier;

// 竖直感知的点位/碰撞体判定：
// 顶面低于"脚底 + 0.25"的碰撞体是可以踩上去的（桥面 / 礁石 / 台阶），不算压人。
function overlapsSolid(x, z, r, feetY) {
  const hits = [];
  for (const o of COLLIDERS) {
    if (o.kind === 'boundary') continue;
    if (o.y1 <= feetY + 0.25) continue;
    if (o.y0 > feetY + WORLD.playerHeight) continue;
    if (circleOverlapsBox(x, z, r, o)) hits.push(o);
  }
  return hits;
}
// 纯水平口径（Lead 探针口径）：只用于对照，不考虑竖直关系
function overlapsFlat(x, z, r) {
  const hits = [];
  for (const o of COLLIDERS) {
    if (o.kind === 'boundary') continue;
    if (circleOverlapsBox(x, z, r, o)) hits.push(o);
  }
  return hits;
}

// 简易行走器：每帧 0.12m + 固定 dt
function walker(x, z, y = null) {
  return {
    x, z, y: y == null ? heightAt(x, z) : y,
    vy: 0, grounded: true, stance: 'stand',
  };
}
function tick(b, dx, dz, dt = 0.05) {
  movePlayerHorizontal(b, dx, dz);
  stepPlayerPhysics(b, dt);
  return b;
}

// ============================================================
head('地形：有限性 / 值域 / 确定性');
// ============================================================
{
  let bad = 0, hmin = Infinity, hmax = -Infinity;
  for (let i = 0; i <= 320; i++) {
    const x = -WORLD.half + i;
    for (let j = 0; j <= 320; j++) {
      const z = -WORLD.half + j;
      const h = heightAt(x, z);
      if (!Number.isFinite(h)) { bad++; continue; }
      if (h < hmin) hmin = h;
      if (h > hmax) hmax = h;
    }
  }
  ok('heightAt 在 321×321 网格上全部有限、无 NaN', bad === 0, 'bad=' + bad);
  ok('所有高度 |h| <= 120', hmin >= -120 && hmax <= 120, 'min=' + fmt(hmin) + ' max=' + fmt(hmax));
  ok('地形有足够高差（海床 → 主脊）', hmax - hmin > 60, '高差=' + fmt(hmax - hmin, 1));
  ok('地形确定性（同一坐标重复采样一致）', heightAt(11.37, -42.11) === heightAt(11.37, -42.11));
  // 用不同遍历顺序再采一遍，验证没有隐藏状态
  const a = [], b = [];
  for (let i = 0; i < 400; i++) a.push(heightAt(-140 + i * 0.7, 90 - i * 0.41));
  for (let i = 399; i >= 0; i--) b.push(heightAt(-140 + i * 0.7, 90 - i * 0.41));
  b.reverse();
  ok('地形纯函数（遍历顺序无关）', a.every((v, i) => v === b[i]));
  // 噪声 / RNG 的确定性
  ok('hash2i / valueNoise 确定性', hash2i(31, -7) === hash2i(31, -7) && valueNoise(3.3, 8.8) === valueNoise(3.3, 8.8));
  const r1 = mulberry32(12345), r2 = mulberry32(12345);
  let same = true;
  for (let i = 0; i < 50; i++) if (r1() !== r2()) same = false;
  ok('mulberry32 固定种子可复现', same);
  ok('seedOf 稳定', seedOf('STILT_A:win:north') === seedOf('STILT_A:win:north'));
  ok('地形法线归一化', (() => {
    const n = terrainNormal(20, -40);
    return Math.abs(Math.hypot(n.x, n.y, n.z) - 1) < 1e-6 && n.y > 0;
  })());
}

// ============================================================
head('海岸线 / 沙滩 / 海床 / 浅滩');
// ============================================================
{
  let lo = Infinity, hi = -Infinity;
  for (let x = -118; x <= 118; x += 1) {
    const z = M.shoreZ(x);
    lo = Math.min(lo, z);
    hi = Math.max(hi, z);
  }
  ok('海岸线 shoreZ 在 z ≈ 20~34 之间起伏', lo >= 20 && hi <= 34, 'range=' + fmt(lo) + '..' + fmt(hi));

  // 海平面 y = 0 必须正好落在 shoreline 采样点上（采样点由高度场二分求根得到）
  const samples = MAP_EXTRAS.shoreline.samples;
  let worstWater = 0;
  for (const p of samples) worstWater = Math.max(worstWater, Math.abs(heightAt(p.x, p.z) - SEA));
  ok('海平面 y = 0 正好落在海岸线上', worstWater < 0.02,
    'maxDev=' + fmt(worstWater, 4) + ' n=' + samples.length);
  ok('海岸线采样点向海一侧确实是水、内陆一侧确实是陆地',
    samples.every((p) => heightAt(p.x, p.z + 6) < 0 && heightAt(p.x, p.z - 6) > 0));
  ok('海平面常量 = 0', SEA === 0);

  // 沙滩坡度：沿垂直海岸方向测 0..30m 的剖面，应在 3°~7°。
  // 只统计"未被平整垫 / 岬角扰动"的干净剖面（与理想沙滩剖面的偏差 < 0.35m）——
  // 出生垫、桥头垫、村落地台过渡带、岬角都会在局部把沙滩抬高，那些位置不算沙滩。
  const smooth = (a, b, x) => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const slopes = [];
  let disturbed = 0;
  for (let x = -130; x <= 130; x += 2) {
    const z0 = M.shoreZ(x);
    let cleanCol = true;
    for (let d = 0; d <= 30; d += 1) {
      if (Math.abs(heightAt(x, z0 - d) - 3.0 * smooth(0, 30, d)) > 0.35) { cleanCol = false; break; }
    }
    if (!cleanCol) { disturbed++; continue; }
    slopes.push((heightAt(x, z0 - 29) - heightAt(x, z0 - 1)) / 28);
  }
  const avgSlope = slopes.reduce((a, b) => a + b, 0) / slopes.length;
  const minSlope = Math.min(...slopes);
  const maxSlope = Math.max(...slopes);
  ok('沙滩带坡度 3°~7°（干净剖面）', slopes.length >= 15 &&
    deg(minSlope) >= 3 && deg(maxSlope) <= 7,
    'n=' + slopes.length + ' avg=' + fmt(deg(avgSlope), 1) + '° ' +
    fmt(deg(minSlope), 1) + '°..' + fmt(deg(maxSlope), 1) + '°（扰动剖面 ' + disturbed + ' 列）');

  // 海床下沉（避开礁石浅滩：浅滩会把海床抬到 -1.2m）
  let s20 = 0, s80 = 0, n = 0;
  for (let x = 0; x <= 120; x += 20) {
    const z0 = M.shoreZ(x);
    s20 += heightAt(x, z0 + 20);
    s80 += heightAt(x, z0 + 80);
    n++;
  }
  ok('海床 z=shoreZ+20 约 -3m', Math.abs(s20 / n + 3) < 0.6, 'h=' + fmt(s20 / n));
  ok('海床 z=shoreZ+80 约 -16m', Math.abs(s80 / n + 16) < 1.6, 'h=' + fmt(s80 / n));

  // 礁石浅滩
  const reefH = heightAt(MAP_EXTRAS.reef.x, MAP_EXTRAS.reef.z);
  ok('礁石浅滩海床抬到约 -1.2m', Math.abs(reefH + 1.2) < 0.4, 'h=' + fmt(reefH));
  ok('礁石浅滩半径 = 58', MAP_EXTRAS.reef.r === 58);
  const stacks = ROCKS.filter((r) => r.kind === 'seastack');
  ok('礁石海蚀柱 6~8 块', stacks.length >= 6 && stacks.length <= 8, 'n=' + stacks.length);
  ok('部分海蚀柱露出水面', stacks.filter((r) => r.y + r.size * 0.85 > 0).length >= 4);
}

// ============================================================
head('地形标定：村落地台 / 岬角 / 主脊');
// ============================================================
{
  const V = MAP_EXTRAS.village;
  ok('村落地台平整（中心 = 8.5m）', Math.abs(heightAt(V.x, V.z) - 8.5) < 0.02, 'h=' + fmt(heightAt(V.x, V.z)));
  ok('村落地台半径 46', V.r === 46);

  // 每栋房屋 footprint 内必须完全平整（墙底/室内地面不悬空）
  let worst = 0, badHouses = [];
  for (const h of HOUSES) {
    let d = 0;
    for (const [fx, fz] of [[0, 0], [0.48, 0], [-0.48, 0], [0, 0.48], [0, -0.48], [0.48, 0.48], [-0.48, -0.48], [0.48, -0.48], [-0.48, 0.48]]) {
      d = Math.max(d, Math.abs(heightAt(h.x + fx * h.w, h.z + fz * h.d) - h.padH));
    }
    if (d > 0.05) badHouses.push(h.id + ':' + fmt(d));
    worst = Math.max(worst, d);
  }
  ok('所有房屋室内地面与墙底齐平', badHouses.length === 0, 'maxDiff=' + fmt(worst) + (badHouses.length ? ' ' + badHouses.join(',') : ''));

  const cw = heightAt(MAP_EXTRAS.capes[0].x, MAP_EXTRAS.capes[0].z);
  const ce = heightAt(MAP_EXTRAS.capes[1].x, MAP_EXTRAS.capes[1].z);
  const rg = heightAt(0, MAP_EXTRAS.ridge.z);
  ok('西岬角 (-118,-30) 约 30m', Math.abs(cw - 30) < 2.5, 'h=' + fmt(cw));
  ok('东岬角 (120,-16) 约 26m', Math.abs(ce - 26) < 2.5, 'h=' + fmt(ce));
  ok('北侧主脊 (z≈-152) 约 55m', Math.abs(rg - 55) < 4, 'h=' + fmt(rg));

  // 可玩区域（岛体，z ∈ [-140, 40]）里大部分地面必须可走
  let tot = 0, walk = 0;
  for (let x = -150; x <= 150; x += 4) for (let z = -140; z <= 40; z += 4) { tot++; if (isWalkableAt(x, z)) walk++; }
  ok('可玩区域可走比例 >= 0.60', walk / tot >= 0.6, 'ratio=' + fmt(walk / tot));
}

// ============================================================
head('出生点（4 队）');
// ============================================================
{
  ok('SPAWNS 含 4 支队 + all', SQUAD_IDS.every((id) => Array.isArray(SPAWNS[id])) && Array.isArray(SPAWNS.all));
  let countBad = [];
  for (const id of SQUAD_IDS) if (SPAWNS[id].length < 5 || SPAWNS[id].length > 8) countBad.push(id + ':' + SPAWNS[id].length);
  ok('每队 5~8 个出生点', countBad.length === 0, countBad.join(',') || SQUAD_IDS.map((id) => SPAWNS[id].length).join('/'));

  let notWalkable = [], solid = [];
  for (const id of SQUAD_IDS) {
    for (const s of SPAWNS[id]) {
      if (!isWalkableAt(s.x, s.z)) notWalkable.push(id + '(' + fmt(s.x) + ',' + fmt(s.z) + ')');
      const hits = overlapsSolid(s.x, s.z, WORLD.playerRadius + 0.45, heightAt(s.x, s.z));
      if (hits.length) solid.push(id + ':' + hits[0].kind);
    }
  }
  ok('出生点 isWalkableAt 全部 true', notWalkable.length === 0, notWalkable.join(',') || 'n=' + SPAWNS.all.length);
  ok('出生点不与碰撞体重叠', solid.length === 0, solid.join(','));

  let minInter = Infinity, minIntra = Infinity;
  for (let i = 0; i < SQUAD_IDS.length; i++) {
    for (let j = i + 1; j < SQUAD_IDS.length; j++) {
      for (const a of SPAWNS[SQUAD_IDS[i]]) for (const b of SPAWNS[SQUAD_IDS[j]]) {
        minInter = Math.min(minInter, Math.hypot(a.x - b.x, a.z - b.z));
      }
    }
  }
  for (const id of SQUAD_IDS) {
    const a = SPAWNS[id];
    for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) {
      minIntra = Math.min(minIntra, Math.hypot(a[i].x - a[j].x, a[i].z - a[j].z));
    }
  }
  ok('跨队出生点两两距离 >= 60m', minInter >= 60, 'min=' + fmt(minInter));
  ok('跨队出生点两两距离 >= 70m（契约 §3.4 设计值）', minInter >= 70, 'min=' + fmt(minInter));
  ok('同队出生点互不重合（>= 4m）', minIntra >= 4, 'min=' + fmt(minIntra));

  // spawnYaw 朝地图中心
  let yawBad = 0;
  for (const s of SPAWNS.all) {
    const yaw = spawnYaw(s);
    // yaw=0 看向 -Z，前向量 = (-sin, -cos)
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const tx = -s.x, tz = -s.z;
    const len = Math.hypot(tx, tz) || 1;
    const dot = (fx * tx + fz * tz) / len;
    if (dot < 0.999) yawBad++;
  }
  ok('spawnYaw 让玩家朝地图中心', yawBad === 0, 'bad=' + yawBad);
  ok('pickSpawn 可用', (() => {
    const s = pickSpawn('alpha', mulberry32(7));
    return Number.isFinite(s.x) && Number.isFinite(s.z);
  })());
}

// ============================================================
head('武器箱 / 消耗品点');
// ============================================================
{
  ok('CRATE_SPOTS 恰好 5 个', CRATE_SPOTS.length === 5, 'n=' + CRATE_SPOTS.length);
  const wantTypes = ['ak47', 'sniper', 'shotgun', 'm416', 'deagle'];
  ok('武器箱类型齐全', wantTypes.every((t) => CRATE_SPOTS.some((c) => c.type === t)),
    CRATE_SPOTS.map((c) => c.type).join('/'));
  ok('ITEM_SPOTS 14~18 个', ITEM_SPOTS.length >= 14 && ITEM_SPOTS.length <= 18, 'n=' + ITEM_SPOTS.length);

  let crateBad = [], itemBad = [];
  for (const c of CRATE_SPOTS) {
    const hits = overlapsSolid(c.x, c.z, 1.1, c.y);
    if (hits.length) crateBad.push(c.type + ':' + hits[0].kind);
  }
  for (const s of ITEM_SPOTS) {
    const hits = overlapsSolid(s.x, s.z, 0.9, s.y);
    if (hits.length) itemBad.push(fmt(s.x) + ',' + fmt(s.z) + ':' + hits[0].kind);
  }
  ok('CRATE_SPOTS 不与碰撞体重叠（竖直感知）', crateBad.length === 0, crateBad.join(','));
  ok('ITEM_SPOTS 不与碰撞体重叠（竖直感知）', itemBad.length === 0, itemBad.join(','));

  // 纯水平口径（Lead 探针口径）：栈桥/礁石上的箱子"站在碰撞体顶面"，属于预期例外
  const flatCrate = CRATE_SPOTS.filter((c) => overlapsFlat(c.x, c.z, 0.6).length > 0)
    .map((c) => c.type + '@(' + fmt(c.x) + ',' + fmt(c.z) + ')');
  const flatItem = ITEM_SPOTS.filter((s) => overlapsFlat(s.x, s.z, 0.6).length > 0);
  const SUPPORT_OK = ['sniper', 'ak47'];   // 栈桥 T 形平台 / 海蚀柱顶
  ok('纯水平口径下只有"站在支撑面上"的 2 个箱子被点名（预期）',
    flatCrate.length === 2 && flatCrate.every((s) => SUPPORT_OK.includes(s.split('@')[0])),
    flatCrate.join(' '));
  ok('纯水平口径下消耗品点无重叠', flatItem.length === 0, 'n=' + flatItem.length);

  let tooClose = 0;
  for (let i = 0; i < ITEM_SPOTS.length; i++) {
    for (let j = i + 1; j < ITEM_SPOTS.length; j++) {
      if (Math.hypot(ITEM_SPOTS[i].x - ITEM_SPOTS[j].x, ITEM_SPOTS[i].z - ITEM_SPOTS[j].z) < 8) tooClose++;
    }
  }
  ok('消耗品点彼此间距 >= 8m', tooClose === 0, 'pairs=' + tooClose);
  ok('消耗品点都在水面以上', ITEM_SPOTS.every((s) => s.y > 0.5), 'minY=' + fmt(Math.min(...ITEM_SPOTS.map((s) => s.y))));
  ok('武器箱点都在水面以上', CRATE_SPOTS.every((c) => c.y > 0.5), 'minY=' + fmt(Math.min(...CRATE_SPOTS.map((c) => c.y))));

  // 每个武器箱都必须真的拿得到（跳跃高度只有 1.05m，共享物理不支持跨台阶）
  {
    // 礁石：从沙滩侧走近、起跳，落到海蚀柱顶
    const stack = ROCKS.find((r) => r.kind === 'seastack' && Math.abs(r.x - CRATE_SPOTS.find((c) => c.type === 'ak47').x) < 0.01);
    const top = stack ? stack.y + stack.size * 0.85 : NaN;
    let landed = false;
    for (const [sx, sz] of [[stack.x, stack.z - 7], [stack.x, stack.z - 6], [stack.x + 1, stack.z - 4]]) {
      const b = walker(sx, sz);
      for (let i = 0; i < 90; i++) tick(b, 0, 0.08);
      applyJump(b);
      for (let i = 0; i < 90; i++) {
        tick(b, 0, 0.06);
        if (b.grounded && Math.abs(b.y - top) < 0.1) { landed = true; break; }
      }
      if (landed) break;
    }
    ok('礁石武器箱可跳上海蚀柱拿到', landed, 'top=' + fmt(top));

    // 西岬角：从村口一路走过去，沿途都必须可走
    const dg = CRATE_SPOTS.find((c) => c.type === 'deagle');
    let walkBad = 0, n = 0;
    for (let t = 0; t <= 1.0001; t += 0.04) {
      const x = -96 + (dg.x + 96) * t;
      const z = -62 + (dg.z + 62) * t;
      n++;
      if (!isWalkableAt(x, z)) walkBad++;
    }
    ok('西岬角武器箱有可走路线（从村落方向）', walkBad === 0 && isWalkableAt(dg.x, dg.z), 'bad=' + walkBad + '/' + n);
  }
}

// ============================================================
head('长栈桥（地图灵魂）');
// ============================================================
{
  ok('栈桥参数符合契约（x=52, z 18→96, 桥面 2.8, 宽 3.4）',
    PIER.x === 52 && PIER.zStart === 18 && PIER.zEnd === 96 && PIER.deckHeight === 2.8 && PIER.width === 3.4,
    'x=' + PIER.x + ' z=' + PIER.zStart + '..' + PIER.zEnd + ' deck=' + PIER.deckHeight);
  ok('T 形平台 16×9', PIER.headWidth === 16 && PIER.headDepth === 9);
  ok('栏杆高 1.05m', PIER.railH === 1.05);

  // 桥面沿线 groundHeightAt ≈ deckHeight
  let bad = [];
  for (let z = PIER.zStart + 1; z <= PIER.zEnd - 1; z += 1) {
    const g = groundHeightAt(PIER.x, z, PIER.deckHeight);
    if (Math.abs(g - PIER.deckHeight) > 0.05) bad.push(z + ':' + fmt(g));
  }
  ok('栈桥桥面沿线 groundHeightAt ≈ deckHeight', bad.length === 0, bad.slice(0, 6).join(',') || 'z 19..95 全部 = 2.80');

  // 从沙滩走上桥（契约 §3.7 / Lead 指定断言）
  const b = walker(PIER.x, PIER.zStart - 8, heightAt(PIER.x, PIER.zStart - 8));
  let reached = false, frames = -1;
  for (let i = 0; i < 300; i++) {
    tick(b, 0, 0.12);
    if (!reached && Math.abs(b.y - PIER.deckHeight) < 0.6 && b.z > PIER.zStart + 2) { reached = true; frames = i; }
  }
  ok('可从沙滩走上栈桥（300 帧内）', reached,
    'frames=' + frames + ' y=' + fmt(b.y) + ' z=' + fmt(b.z));

  // 一路走到 T 形平台尽头
  const b2 = walker(PIER.x, PIER.zStart - 8, heightAt(PIER.x, PIER.zStart - 8));
  let onDeckAll = true, maxZ = b2.z;
  for (let i = 0; i < 1400; i++) {
    tick(b2, 0, 0.12);
    maxZ = Math.max(maxZ, b2.z);
    if (b2.z > PIER.zStart + 4 && Math.abs(b2.y - PIER.deckHeight) > 0.06) onDeckAll = false;
  }
  ok('可一路走到 T 形平台尽头且全程不下沉', onDeckAll && maxZ > PIER.zEnd - 3,
    'maxZ=' + fmt(maxZ) + ' y=' + fmt(b2.y));

  // 上桥通道不被平台两侧栏杆卡死：桥头两侧应留出 >= 桥宽的缺口
  const headRails = COLLIDERS.filter((o) => o.kind === 'pier_rail' && Math.abs(o.z - PIER.headZ0) < 0.5);
  const gapW = PIER.headWidth - headRails.reduce((s, o) => s + o.w, 0);
  ok('T 形平台上桥口留有 >= 桥宽的缺口', gapW >= PIER.width - 0.05, 'gap=' + fmt(gapW));

  // 栏杆确实存在（可蹲掩）
  const rails = COLLIDERS.filter((o) => o.kind === 'pier_rail');
  ok('栈桥栏杆碰撞体存在且高 1.05m',
    rails.length >= 6 && rails.every((o) => Math.abs((o.y1 - o.y0) - PIER.railH) < 1e-6),
    'rails=' + rails.length);

  // 桥头坡道数据自洽
  const ramp = PIER.ramp;
  ok('桥头坡道数据自洽（steps=0 表示平地接桥）',
    ramp.steps === 0 ? Math.abs(ramp.y0 - PIER.deckHeight) < 1e-6 : (ramp.stepH <= 0.42 && ramp.y1 === PIER.deckHeight),
    'steps=' + ramp.steps + ' stepH=' + fmt(ramp.stepH));
}

// ============================================================
head('渔村建筑');
// ============================================================
{
  ok('可进入建筑 6~8 栋', HOUSES.length >= 6 && HOUSES.length <= 8, 'n=' + HOUSES.length);
  const styles = HOUSES.map((h) => h.style);
  ok('风格字段合法', styles.every((s) => ['stilt', 'boathouse', 'chandlery', 'fishstand', 'shed'].includes(s)), styles.join('/'));
  ok('吊脚渔屋 ×3', styles.filter((s) => s === 'stilt').length === 3);
  ok('含船屋 / 杂货铺 / 鱼摊棚 / 工具棚',
    ['boathouse', 'chandlery', 'fishstand', 'shed'].every((s) => styles.includes(s)));

  let doorBad = [], segBad = [];
  for (const h of HOUSES) {
    const seg = houseWallSegments(h);
    if (h.style === 'fishstand') {
      // 半开放：只有角柱、没有墙、没有门
      const onlyPosts = seg.segments.length === 4 && seg.segments.every((s) => s.kind === 'house_post');
      ok('鱼摊棚只有 4 根角柱、无墙无门', onlyPosts && seg.door === null && seg.open === true,
        'segments=' + seg.segments.length);
      continue;
    }
    if (seg.segments.length < 5) segBad.push(h.id);
    const d = seg.door;
    if (!d) { doorBad.push(h.id + ':no-door'); continue; }
    // 门口外 1.6m / 门内 1.6m 都必须可走
    const ox = d.x + d.dirX * 1.6, oz = d.z + d.dirZ * 1.6;
    const ix = d.x - d.dirX * 1.6, iz = d.z - d.dirZ * 1.6;
    if (!isWalkableAt(ox, oz)) doorBad.push(h.id + ':outside');
    if (!isWalkableAt(ix, iz)) doorBad.push(h.id + ':inside');

    // 真实物理穿门：从门外朝屋内目标点（门轴内侧 2.5m）直线行走
    const b = walker(ox, oz, h.padH);
    let inside = false;
    for (let i = 0; i < 80; i++) {
      const dx = ix - b.x, dz = iz - b.z;
      const dd = Math.hypot(dx, dz);
      if (dd < 0.25) break;
      tick(b, (dx / dd) * 0.12, (dz / dd) * 0.12);
      const along = (b.x - d.x) * -d.dirX + (b.z - d.z) * -d.dirZ;
      if (along > 1.0) { inside = true; break; }
    }
    if (!inside) doorBad.push(h.id + ':physics');
  }
  ok('每栋房屋墙体分段正常（含门洞）', segBad.length === 0, segBad.join(','));
  ok('房屋门洞可通行（isWalkableAt + 真实物理穿门）', doorBad.length === 0, doorBad.join(','));

  ok('houseSides 返回 4 面墙', houseSides(HOUSES[0]).length === 4);
  ok('houseFloorTop = padH + 0.045', Math.abs(houseFloorTop(HOUSES[0]) - (HOUSES[0].padH + 0.045)) < 1e-9);
  ok('WINDOW_SPEC 完整', ['sill', 'h', 'wMin', 'wMax', 'edge', 'longWall'].every((k) => typeof WINDOW_SPEC[k] === 'number'));
  ok('FURNITURE_DEF 完整', ['table', 'chair', 'crate', 'chest'].every((k) => !!FURNITURE_DEF[k]));
  ok('家具已生成（含碰撞体）', FURNITURE.length >= 8, 'n=' + FURNITURE.length);
  ok('家具碰撞体已登记', COLLIDERS.filter((o) => o.kind === 'furniture').length === FURNITURE.length);
}

// ============================================================
head('沙滩 → 村落地台：可走路径');
// ============================================================
{
  // 木栈道中心线（沿 MAP_EXTRAS.boardwalk 采样）
  const bw = MAP_EXTRAS.boardwalk;
  let bwBad = 0;
  for (const s of bw) {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const x = s.x1 + (s.x2 - s.x1) * t;
      const z = s.z1 + (s.z2 - s.z1) * t;
      if (!isWalkableAt(x, z)) bwBad++;
    }
  }
  ok('木栈道中心线全程可走', bwBad === 0, 'bad=' + bwBad + ' segs=' + bw.length);
  // 木栈道贴着地形爬升（村落地台比沙滩高 5.5m，最陡处约 16°），
  // 2m 一段的段间高差应 <= 0.65m。
  ok('木栈道段间高差 <= 0.65m（无大台阶跳变）', (() => {
    let m = 0;
    for (let i = 1; i < bw.length; i++) m = Math.max(m, Math.abs(bw[i].y - bw[i - 1].y));
    return m <= 0.65;
  })(), 'maxJump=' + fmt((() => { let m = 0; for (let i = 1; i < bw.length; i++) m = Math.max(m, Math.abs(bw[i].y - bw[i - 1].y)); return m; })()));

  // 真实物理行走：从沙滩沿木栈道走进村广场
  const route = [[62, 14], [57, 2], [50, -12], [43, -26], [36, -38], [32, -48], [31, -54], [28, -62]];
  const b = walker(route[0][0], route[0][1]);
  let wp = 1, stuck = 0, prevX = b.x, prevZ = b.z;
  for (let i = 0; i < 4000 && wp < route.length; i++) {
    const tx = route[wp][0], tz = route[wp][1];
    const dx = tx - b.x, dz = tz - b.z;
    const d = Math.hypot(dx, dz);
    if (d < 1.8) { wp++; continue; }
    tick(b, (dx / d) * 0.12, (dz / d) * 0.12);
    if (Math.hypot(b.x - prevX, b.z - prevZ) < 0.01) { if (++stuck > 60) break; } else stuck = 0;
    prevX = b.x; prevZ = b.z;
  }
  ok('可从沙滩一路走进村广场（真实物理）', wp >= route.length,
    'wp=' + wp + '/' + route.length + ' pos=(' + fmt(b.x) + ',' + fmt(b.z) + ') y=' + fmt(b.y));
  ok('走完路径后站在村落地台上（8.5m）', Math.abs(b.y - 8.5) < 0.6, 'y=' + fmt(b.y));
}

// ============================================================
head('物理 / 射线');
// ============================================================
{
  // 站在地面不下沉
  const g0 = heightAt(28, -62);
  const b = walker(28, -62);
  tick(b, 0, 0);
  ok('站在地面不下沉', Math.abs(b.y - g0) < 0.02 && b.grounded);

  // 平地行走
  const b2 = walker(28, -62);
  const x0 = b2.x;
  for (let i = 0; i < 40; i++) tick(b2, WORLD.walkSpeed * 0.05, 0);
  ok('平地可正常行走', b2.x - x0 > 6, 'dx=' + fmt(b2.x - x0));

  // 撞墙不穿墙（用船屋南墙：门在 z=+d/2，取一段实墙位置）
  const bh = HOUSES.find((h) => h.id === 'BOATHOUSE');
  const wallZ = bh.z + bh.d / 2;
  const b3 = walker(bh.x + 5.5, wallZ + 3.5);
  for (let i = 0; i < 120; i++) tick(b3, 0, -WORLD.walkSpeed * 0.05);
  ok('墙体阻挡（不穿墙）', b3.z > wallZ + 0.1, 'z=' + fmt(b3.z) + ' wallZ=' + fmt(wallZ));

  // 射线：向下打地面
  const hit = raycastWorld(28, 30, -62, 0, -1, 0, 60);
  ok('raycastWorld 命中地形', !!hit && hit.kind === 'terrain' && Math.abs(hit.point.y - heightAt(28, -62)) < 0.4,
    hit ? 'y=' + fmt(hit.point.y) + ' surface=' + hit.surface : 'null');
  // 射线：打栈桥桥面
  const pierHit = raycastWorld(PIER.x, PIER.deckHeight + 6, 60, 0, -1, 0, 20);
  ok('raycastWorld 命中栈桥桥面（材质 wood）', !!pierHit && pierHit.kind === 'pier_deck' && pierHit.surface === 'wood',
    pierHit ? pierHit.kind + '/' + pierHit.surface : 'null');
  // 视线遮挡：墙两侧互相看不见
  const wallA = { x: bh.x + 5.5, z: wallZ + 3, y: bh.padH + 1.6 };
  const wallB = { x: bh.x + 5.5, z: wallZ - 3, y: bh.padH + 1.6 };
  ok('losBlocked 在墙两侧为 true', losBlocked(wallA.x, wallA.y, wallA.z, wallB.x, wallB.y, wallB.z));
  ok('losBlocked 在开阔地为 false', !losBlocked(28, 9.5, -62, 40, 9.5, -62));

  // 命中盒
  const hb = hitboxesFor({ x: 0, y: 8.5, z: 0, stance: 'stand' });
  ok('hitboxesFor 结构完整', hb.head && hb.body && hb.legs && hb.head.r === WORLD.headR);
  ok('applyJump 只在地面生效', (() => {
    const b4 = walker(28, -62);
    const j1 = applyJump(b4);
    const j2 = applyJump(b4);
    return j1 === true && j2 === false && b4.vy === WORLD.jumpSpeed;
  })());

  // 边界：跑不出地图
  const b5 = walker(0, 20);
  for (let i = 0; i < 900; i++) tick(b5, 0, 0.15);
  ok('边界钳制生效（不出地图）', Math.abs(b5.z) < WORLD.half, 'z=' + fmt(b5.z));

  // 掉进海里也要落到海床上，不能掉到 -100
  const b6 = walker(PIER.x, PIER.zEnd - 4, PIER.deckHeight);
  b6.x += PIER.headHalfW + 2;          // 从平台边掉下去
  for (let i = 0; i < 300; i++) stepPlayerPhysics(b6, 0.05);
  ok('从栈桥掉进海里会落到海床（不会无限下坠）', b6.y > -40 && Number.isFinite(b6.y), 'y=' + fmt(b6.y));
}

// ============================================================
head('玩法 / 世界常量 / API 面');
// ============================================================
{
  ok('WORLD.size = 320 / half = 160', WORLD.size === 320 && WORLD.half === 160);
  ok('玩家/移动参数沿用郊区那套数值',
    WORLD.playerRadius === 0.42 && WORLD.playerHeight === 1.8 && WORLD.walkSpeed === 5.4 &&
    WORLD.sprintSpeed === 8.4 && WORLD.gravity === 22 && WORLD.jumpSpeed === 6.8 &&
    WORLD.maxStep === 0.6 && WORLD.maxSlope === 0.9 && WORLD.maxHp === 100);
  ok('ZONES = []（死亡竞赛不用据点）', Array.isArray(ZONES) && ZONES.length === 0);
  ok('PYLONS = []', Array.isArray(PYLONS) && PYLONS.length === 0);
  ok('CARS 为数组（废弃皮卡）', Array.isArray(CARS) && CARS.length === 2, 'n=' + CARS.length);
  ok('zoneOf 返回 null（无据点）', zoneOf(0, 0) === null);

  ok('SUN 为午后热带海岸光',
    Array.isArray(SUN.dir) && SUN.dir.length === 3 && SUN.color === 0xfff2dd &&
    SUN.intensity === 3.0 && SUN.fogColor === 0xbcd6dd && SUN.fogNear === 140 &&
    SUN.fogFar === 700 && SUN.exposure === 1.02);
  ok('SUN.dir 已归一化', Math.abs(Math.hypot(...SUN.dir) - 1) < 0.01, 'len=' + fmt(Math.hypot(...SUN.dir), 3));

  ok('surfaceAt 返回合法材质',
    ['sand', 'grass', 'dirt', 'rock', 'water', 'wood'].includes(surfaceAt(0, 0)) &&
    surfaceAt(52, 60) === 'wood' &&               // 栈桥
    surfaceAt(28, -62) === 'dirt' &&              // 村广场
    surfaceAt(52, 100) === 'water' &&             // 深水
    surfaceAt(-20, M.shoreZ(-20) - 6) === 'sand'); // 干沙滩（避开栈桥覆盖范围）

  ok('ROADS 存在', ROADS && typeof ROADS.plazaRadius === 'number');
  ok('BOUNDARY 4 面', BOUNDARY.length === 4 && BOUNDARY.every((b) => b.kind === 'boundary'));
  ok('FENCES 为空（避免不可见碰撞体）', Array.isArray(FENCES) && FENCES.length === 0);
  ok('DEFENSES 掩体道具齐全', DEFENSES.length >= 20, 'n=' + DEFENSES.length);
  const kinds = new Set(DEFENSES.map((d) => d.kind));
  ok('掩体道具 kind 合法', [...kinds].every((k) => ['crate', 'barrel', 'lobster', 'netrack', 'plank'].includes(k)), [...kinds].join('/'));
  ok('碰撞体数量合理', COLLIDERS.length > 150 && COLLIDERS.length < 700, 'n=' + COLLIDERS.length);
  ok('碰撞体都有 y0 < y1', COLLIDERS.every((o) => o.y1 > o.y0));

  // 植被
  const palms = TREES.filter((t) => t.type === 'palm').length;
  const broad = TREES.filter((t) => t.type === 'broadleaf').length;
  const bush = TREES.filter((t) => t.type === 'bush').length;
  const dune = TREES.filter((t) => t.type === 'dunegrass').length;
  ok('棕榈 ×40', palms === 40, 'n=' + palms);
  ok('阔叶树 ×20', broad === 20, 'n=' + broad);
  ok('灌木 ×40', bush === 40, 'n=' + bush);
  ok('沙丘草存在且无碰撞（视觉）', dune > 0 && !COLLIDERS.some((o) => o.kind === 'tree' &&
    TREES.some((t) => t.type === 'dunegrass' && Math.abs(t.x - o.x) < 0.01 && Math.abs(t.z - o.z) < 0.01)), 'n=' + dune);
  ok('棕榈都在水面以上', TREES.filter((t) => t.type === 'palm').every((t) => t.y > 0.4));

  // MAP_EXTRAS 结构（契约 §3.6）
  const E = MAP_EXTRAS;
  ok('MAP_EXTRAS.seaLevel = 0', E.seaLevel === 0);
  ok('MAP_EXTRAS.pier 字段齐全',
    ['x', 'zStart', 'zEnd', 'deckHeight', 'width', 'headWidth', 'headDepth', 'railH'].every((k) => typeof E.pier[k] === 'number'));
  ok('MAP_EXTRAS.boardwalk 段字段齐全',
    Array.isArray(E.boardwalk) && E.boardwalk.length > 0 &&
    E.boardwalk.every((s) => ['x1', 'z1', 'x2', 'z2', 'w', 'y'].every((k) => typeof s[k] === 'number')));
  ok('MAP_EXTRAS.docks 字段齐全',
    Array.isArray(E.docks) && E.docks.length > 0 &&
    E.docks.every((d) => ['x', 'z', 'rot', 'w', 'd', 'y'].every((k) => typeof d[k] === 'number')));
  ok('MAP_EXTRAS.boats 字段齐全（2 艘搁浅渔船）',
    Array.isArray(E.boats) && E.boats.length === 2 &&
    E.boats.every((b) => ['x', 'z', 'rot', 'len', 'beam', 'hullY', 'tilt'].every((k) => typeof b[k] === 'number')));
  ok('MAP_EXTRAS.stalls 字段齐全',
    Array.isArray(E.stalls) && E.stalls.length > 0 &&
    E.stalls.every((s) => ['x', 'z', 'rot', 'w', 'd', 'h'].every((k) => typeof s[k] === 'number')));
  ok('MAP_EXTRAS.reef 字段齐全', ['x', 'z', 'r'].every((k) => typeof E.reef[k] === 'number'));
  ok('MAP_EXTRAS.shoreline.samples 每 4m 一个采样点', (() => {
    const s = E.shoreline.samples;
    if (!Array.isArray(s) || s.length < 60) return false;
    for (let i = 1; i < s.length; i++) if (Math.abs((s[i].x - s[i - 1].x) - 4) > 1e-6) return false;
    return s.every((p) => typeof p.x === 'number' && typeof p.z === 'number');
  })(), 'n=' + E.shoreline.samples.length);
  // 采样点是"真实水线"（对高度场二分求根），与解析 shoreZ 允许有几米偏差
  // —— 出生垫 / 桥头垫会把局部水线往海侧推。
  ok('MAP_EXTRAS.shoreline 采样点落在真实水线上',
    E.shoreline.samples.every((p) => Math.abs(heightAt(p.x, p.z)) < 0.02) &&
    E.shoreline.samples.every((p) => Math.abs(p.z - M.shoreZ(p.x)) < 25),
    'maxShift=' + fmt(Math.max(...E.shoreline.samples.map((p) => Math.abs(p.z - M.shoreZ(p.x))))));

  ok('船只 / 码头碰撞体已登记',
    COLLIDERS.some((o) => o.kind === 'boat') && COLLIDERS.some((o) => o.kind === 'dock_deck'));
  ok('WORLD_INFO 完整', WORLD_INFO && WORLD_INFO.seaLevel === 0 && !!WORLD_INFO.village && !!WORLD_INFO.pier);

  // 契约 §3.6 的完整导出面
  const api = {
    WORLD, SUN, ZONES, HOUSES, PYLONS, CARS, DEFENSES, FENCES, ROADS, TREES, ROCKS,
    BOUNDARY, COLLIDERS, SPAWNS, CRATE_SPOTS, ITEM_SPOTS, FURNITURE, FURNITURE_DEF,
    WINDOW_SPEC, WORLD_INFO, MAP_EXTRAS,
    heightAt, terrainNormal, surfaceAt, houseSides, houseFloorTop, houseWallSegments,
    seedOf, circleOverlapsBox, movePlayerHorizontal, groundHeightAt, stepPlayerPhysics,
    applyJump, hitboxesFor, raycastWorld, losBlocked, zoneOf, pickSpawn, spawnYaw,
    isWalkableAt, hash2i, valueNoise, mulberry32,
  };
  const missing = Object.entries(api).filter(([, v]) => v === undefined || v === null).map(([k]) => k);
  ok('契约 §3.6 的全部导出都存在', missing.length === 0, missing.join(','));
}

// ============================================================
console.log('\n' + '='.repeat(56));
if (fail === 0) {
  console.log('潮汐湾地图自检全部通过：' + pass + ' 项');
} else {
  console.log('潮汐湾地图自检失败：' + fail + ' 项 / 共 ' + (pass + fail) + ' 项');
  for (const f of failures) console.log('  · ' + f);
}
console.log('='.repeat(56));
process.exit(fail === 0 ? 0 : 1);
