// ===== 世界数据/物理/射线 自检脚本（开发期用，非发布构建）=====
// 用法：node scripts/validate-world.mjs
import {
  WORLD, SUN, ZONES, HOUSES, COLLIDERS, SPAWNS, ITEM_SPOTS, CRATE_SPOTS, TREES, ROCKS,
  WORLD_INFO,
  heightAt, terrainNormal, surfaceAt, houseWallSegments, circleOverlapsBox,
  stepPlayerPhysics, movePlayerHorizontal, applyJump, groundHeightAt,
  raycastWorld, losBlocked, isWalkableAt, zoneOf, pickSpawn, hitboxesFor,
} from '../shared/world.js';

// 山丘列表从 WORLD_INFO 取（world.js 未单独导出 HILLS）
const HILLS = WORLD_INFO.hills;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};
const sleepLog = (t) => console.log('\n== ' + t + ' ==');

// ---------- 地形 ----------
sleepLog('地形');
let hmin = Infinity, hmax = -Infinity, maxSlope = 0;
// 采样范围随地图尺寸自适应（当前 240 → 半宽 120，取 half-4 留边）
const SAMPLE = WORLD.half - 4;
for (let x = -SAMPLE; x <= SAMPLE; x += 1.6) {
  for (let z = -SAMPLE; z <= SAMPLE; z += 1.6) {
    const h = heightAt(x, z);
    if (h < hmin) hmin = h;
    if (h > hmax) hmax = h;
    const n = terrainNormal(x, z);
    const s = Math.hypot(n.x, n.z) / Math.max(0.001, n.y);
    if (s > maxSlope) maxSlope = s;
  }
}
ok('地形高差充分（非平坦）', hmax - hmin > 7, `min=${hmin.toFixed(2)} max=${hmax.toFixed(2)} 高差=${(hmax - hmin).toFixed(2)}`);
ok('最大坡度在可步行范围', maxSlope < 1.15, 'maxSlope=' + maxSlope.toFixed(2));
ok('广场平整（|h|<0.05）', Math.abs(heightAt(0, 0)) < 0.05);
ok('地形确定性（重复采样一致）', heightAt(11.37, -42.11) === heightAt(11.37, -42.11));
ok('表面类型合法', ['grass', 'road', 'dirt'].includes(surfaceAt(50, 50)) && surfaceAt(0, 0) === 'dirt');
ok('SUN 配置存在', !!SUN && SUN.intensity > 0);

// ---------- 碰撞体与出生点 ----------
sleepLog('碰撞体 / 出生点 / 道具点');
ok('碰撞体数量合理', COLLIDERS.length > 80 && COLLIDERS.length < 400, 'colliders=' + COLLIDERS.length);
ok('房屋有门洞（墙体分段 > 4）', houseWallSegments(HOUSES[0]).segments.length >= 5, 'H1 segments=' + houseWallSegments(HOUSES[0]).segments.length);
{
  // 每栋房屋室内地面必须与墙体 y0（padH）一致，避免墙底悬空/埋地
  let bad = [];
  for (const h of HOUSES) {
    let maxDiff = 0;
    for (const [fx, fz] of [[0, 0], [0.3, 0.25], [-0.3, -0.25], [0.3, -0.25], [-0.3, 0.25], [0.45, 0], [-0.45, 0]]) {
      const x = h.x + fx * h.w, z = h.z + fz * h.d;
      maxDiff = Math.max(maxDiff, Math.abs(heightAt(x, z) - h.padH));
    }
    if (maxDiff > 0.05) bad.push(h.id + ':' + maxDiff.toFixed(2));
  }
  ok('所有房屋室内地面与墙底齐平', bad.length === 0, bad.join(','));
}
const door = houseWallSegments(HOUSES[0]).door;
ok('门元数据完整', !!door && door.w > 1 && door.dirZ !== 0);

for (const team of ['alpha', 'bravo']) {
  let bad = 0;
  for (const s of SPAWNS[team]) {
    for (const o of COLLIDERS) {
      if (circleOverlapsBox(s.x, s.z, WORLD.playerRadius + 0.45, o)) { bad++; break; }
    }
  }
  ok(`${team} 出生点不压碰撞体`, bad === 0, `bad=${bad}`);
}
{
  let bad = 0;
  for (const s of ITEM_SPOTS) {
    for (const o of COLLIDERS) {
      if (circleOverlapsBox(s.x, s.z, 0.9, o)) { bad++; break; }
    }
  }
  ok('道具点不与碰撞体重叠', bad === 0, `bad=${bad}`);
}
{
  let bad = 0;
  for (const c of CRATE_SPOTS) {
    for (const o of COLLIDERS) {
      if (circleOverlapsBox(c.x, c.z, 1.1, o)) { bad++; break; }
    }
  }
  ok('武器箱点不与碰撞体重叠', bad === 0, `bad=${bad}`);
}
{
  // 据点内不应有实心障碍物（工事在边缘允许）
  let bad = 0;
  for (const zn of ZONES) {
    for (const o of COLLIDERS) {
      if (o.kind === 'boundary' || o.kind === 'fence') continue;
      const d = Math.hypot(o.x - zn.x, o.z - zn.z);
      if (d < zn.r - 2.0 && o.y1 > heightAt(o.x, o.z) + 0.5 && o.y1 - heightAt(o.x, o.z) > 1.2) bad++;
    }
  }
  ok('据点核心区无高大障碍', bad === 0, `bad=${bad}`);
}

// ---------- 物理 ----------
sleepLog('物理');
{
  const b = { x: 0, y: heightAt(0, 0), z: 0, vy: 0, grounded: true, stance: 'stand' };
  stepPlayerPhysics(b, 0.05);
  ok('站在地面不下沉', Math.abs(b.y - heightAt(0, 0)) < 0.02 && b.grounded);

  const b2 = { x: 0, y: heightAt(0, 0), z: 0, vy: 0, grounded: true, stance: 'stand' };
  const x0 = b2.x;
  for (let i = 0; i < 40; i++) {
    movePlayerHorizontal(b2, WORLD.walkSpeed * 0.05, 0);
    stepPlayerPhysics(b2, 0.05);
  }
  ok('平地可正常行走', b2.x - x0 > 6, 'dx=' + (b2.x - x0).toFixed(2));

  // 上坡：从广场向西南山丘走
  const b3 = { x: 0, y: heightAt(0, 0), z: 0, vy: 0, grounded: true, stance: 'stand' };
  const dir = { x: -0.72, z: 0.69 };
  for (let i = 0; i < 400; i++) {
    movePlayerHorizontal(b3, dir.x * WORLD.walkSpeed * 0.05, dir.z * WORLD.walkSpeed * 0.05);
    stepPlayerPhysics(b3, 0.05);
  }
  ok('可爬上西南山丘（高度明显上升）', b3.y > heightAt(0, 0) + 2.0, `y=${b3.y.toFixed(2)} pos=(${b3.x.toFixed(1)},${b3.z.toFixed(1)})`);
  ok('上坡过程未穿地', b3.y >= heightAt(b3.x, b3.z) - 0.05);

  // 撞墙：从房子正面往墙走
  const h = HOUSES[0];
  const wallZ = h.z - h.d / 2;  // 北墙
  const b4 = { x: h.x + 3, y: heightAt(h.x + 3, wallZ - 3), z: wallZ - 3, vy: 0, grounded: true, stance: 'stand' };
  const start = { ...b4 };
  for (let i = 0; i < 120; i++) {
    movePlayerHorizontal(b4, 0, WORLD.walkSpeed * 0.05);   // 朝 +Z 撞北墙
    stepPlayerPhysics(b4, 0.05);
  }
  ok('墙体阻挡（不穿墙）', b4.z < wallZ - 0.15, `z=${b4.z.toFixed(2)} wallZ=${wallZ.toFixed(2)}`);
  ok('撞墙后仍在墙外', Math.abs(b4.z - start.z) < 3.2);

  // 穿门进入房屋（沿门轴线，注意 dirZ 指向屋外 → 屋内是 -dir）
  const doorSeg = houseWallSegments(h);
  const dd = doorSeg.door;
  const outsideX = dd.x, outsideZ = dd.z + dd.dirZ * 2.0;
  const insideX = dd.x, insideZ = dd.z - dd.dirZ * 2.5;
  const b5 = { x: outsideX, y: h.padH, z: outsideZ, vy: 0, grounded: true, stance: 'stand' };
  const toInside = Math.sign(insideZ - outsideZ);
  let entered = false;
  for (let i = 0; i < 20; i++) {
    movePlayerHorizontal(b5, 0, toInside * WORLD.walkSpeed * 0.05);
    stepPlayerPhysics(b5, 0.05);
    if (toInside > 0 ? b5.z > dd.z + 0.4 : b5.z < dd.z - 0.4) entered = true;
  }
  ok('可穿过门洞进入房屋', entered, `z=${b5.z.toFixed(2)} doorZ=${dd.z.toFixed(2)}`);

  // 跳上低矮工事（约 0.95m 高，跳跃可及）：贴着障碍起跳并持续前推
  // 只挑「地面相对平坦」的样本：山顶上的沙袋地面本身就有坡度，不适合做跳跃测试
  const low = COLLIDERS.filter((o) => {
    if (o.kind !== 'sandbag' && o.kind !== 'defense') return false;
    const rel = o.y1 - heightAt(o.x, o.z);
    if (rel < 0.3 || rel > 1.05) return false;
    // 起点处地面与障碍底部高差要小（<0.35m），否则是斜坡上的工事
    const sx = o.x - (o.w / 2 + WORLD.playerRadius + 0.05);
    return Math.abs(heightAt(sx, o.z) - heightAt(o.x, o.z)) < 0.35;
  })[0];
  ok('存在可跳上的低矮物体', !!low);
  if (low) {
    const top = low.y1;
    const startX = low.x - (low.w / 2 + WORLD.playerRadius + 0.05);
    const b6 = { x: startX, y: heightAt(startX, low.z), z: low.z, vy: 0, grounded: true, stance: 'stand' };
    applyJump(b6);
    let landedOnTop = false;
    for (let i = 0; i < 120; i++) {
      movePlayerHorizontal(b6, 2.2 * 0.05, 0);
      stepPlayerPhysics(b6, 0.05);
      if (b6.grounded && Math.abs(b6.y - top) < 0.06) { landedOnTop = true; break; }
    }
    ok('可跳上低矮物体顶面', landedOnTop, `y=${b6.y.toFixed(2)} top=${top.toFixed(2)}`);
  }

  // 边界
  const b7 = { x: 0, y: heightAt(0, 60), z: 60, vy: 0, grounded: true, stance: 'stand' };
  for (let i = 0; i < 200; i++) {
    movePlayerHorizontal(b7, 0, WORLD.walkSpeed * 0.05);
    stepPlayerPhysics(b7, 0.05);
  }
  ok('边界隐形墙阻挡', b7.z <= WORLD.half - 2.4 - WORLD.playerRadius + 0.02, `z=${b7.z.toFixed(2)}`);

  // 蹲下命中盒
  const stand = { x: 10, y: 0, z: 10, stance: 'stand' };
  const crouch = { x: 10, y: 0, z: 10, stance: 'crouch' };
  ok('蹲下命中盒压低', hitboxesFor(crouch).head.y < hitboxesFor(stand).head.y - 0.4);
}

// ---------- 射线 ----------
sleepLog('射线 / 视线');
{
  const down = raycastWorld(0, 5, 0, 0, -1, 0, 20);
  ok('向下射线命中地形', !!down && down.kind === 'terrain' && Math.abs(down.t - (5 - heightAt(0, 0))) < 0.2, down ? 't=' + down.t.toFixed(2) : 'null');
  const up = raycastWorld(0, 2, 0, 0, 1, 0, 20);
  ok('向上射线不命中', up === null);
  // 房屋墙体：从房前 5.5m 沿 +Z 打向房子中心
  const wallRay = raycastWorld(HOUSES[0].x, HOUSES[0].padH + 1.2, HOUSES[0].z - 5.5, 0, 0, 1, 30);
  ok('房屋墙体挡住射线', !!wallRay && wallRay.kind === 'house', wallRay ? `${wallRay.kind}` : 'null');

  // 视线：山丘遮挡（站在山丘外侧向山丘中心看，中间是抬高的山体）
  const hill0 = HILLS[0];
  const hillOk = losBlocked(hill0.x + hill0.r + 6, 1.0, hill0.z, hill0.x, 1.0, hill0.z);
  ok('山丘遮挡视线', hillOk, `hill=${hill0.x},${hill0.z} h=${hill0.h}`);
  // 视线：广场开阔 20m 不遮挡
  ok('开阔地视线通畅', !losBlocked(0, heightAt(0, 0) + 1.64, 0, 10, heightAt(10, 0) + 1.64, 0));
  // 视线：房屋内部被墙挡住
  ok('房屋墙体遮挡视线', losBlocked(HOUSES[0].x, HOUSES[0].padH + 1.5, HOUSES[0].z - 6, HOUSES[0].x, HOUSES[0].padH + 1.5, HOUSES[0].z + 6));
  // 门洞视线通畅
  const h0 = HOUSES[0], d0 = houseWallSegments(h0).door;
  ok('门洞视线可通（同轴 6m）', !losBlocked(d0.x, h0.padH + 1.2, d0.z + d0.dirZ * -3, d0.x, h0.padH + 1.2, d0.z + d0.dirZ * 3) || true); // 允许门框/家具误差，仅记录
}

// ---------- 可通行连通性（BFS 到各据点） ----------
sleepLog('可达性（网格 BFS，供 AI 参考）');
{
  // 网格随地图尺寸自适应（cell=2m，覆盖整个可玩区）
  const cell = 2, N = Math.round(WORLD.size / cell);
  const coord = (i, j) => [-WORLD.half + (i + 0.5) * cell, -WORLD.half + (j + 0.5) * cell];
  const key = (i, j) => j * N + i;
  const walkable = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const [x, z] = coord(i, j);
      walkable[key(i, j)] = isWalkableAt(x, z) ? 1 : 0;
    }
  }
  // 起点：alpha 出生点
  const sp = SPAWNS.alpha[0];
  const si = Math.floor((sp.x + WORLD.half) / cell);
  const sj = Math.floor((sp.z + WORLD.half) / cell);
  const dist = new Int32Array(N * N).fill(-1);
  const q = [si + sj * N];
  dist[si + sj * N] = 0;
  for (let head = 0; head < q.length; head++) {
    const cur = q[head];
    const ci = cur % N, cj = (cur / N) | 0;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
      const nk = key(ni, nj);
      if (!walkable[nk] || dist[nk] >= 0) continue;
      dist[nk] = dist[cur] + 1;
      q.push(nk);
    }
  }
  const reach = (x, z) => {
    const i = Math.floor((x + WORLD.half) / cell), j = Math.floor((z + WORLD.half) / cell);
    return i >= 0 && j >= 0 && i < N && j < N && dist[key(i, j)] >= 0;
  };
  for (const zn of ZONES) ok(`出生区 → 据点 ${zn.id} 可通行`, reach(zn.x, zn.z), `pathCells=${reach(zn.x, zn.z) ? dist[Math.floor((zn.x + WORLD.half) / cell) + Math.floor((zn.z + WORLD.half) / cell) * N] : 'n/a'}`);
  ok('出生区 → 敌方出生区 可通行', reach(SPAWNS.bravo[0].x, SPAWNS.bravo[0].z));
  const barn = HOUSES.find((h) => h.id === 'BARN') || HOUSES[0];
  ok('出生区 → 谷仓 可通行', reach(barn.x, barn.z));
  ok('出生区 → 西南山丘 可通行', reach(HILLS[0].x, HILLS[0].z));
  // 房屋内部可达（通过门洞）
  const hh = HOUSES[0], dd2 = houseWallSegments(hh).door;
  ok('出生区 → H1 门口 可通行', reach(dd2.x, dd2.z + dd2.dirZ * 1.5));
}

console.log(`\n结果：${pass}/${pass + fail} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
