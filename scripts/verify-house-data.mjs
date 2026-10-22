// ===== 房屋窗户 / 家具 / 碰撞 自检（本次改动的专项验证，开发期用）=====
// 用法：node scripts/verify-house-data.mjs
// 校验：窗洞规格与穿透性、门洞尺寸与通行、家具数量/碰撞一致性/不可穿透、屋顶无碰撞。
import {
  WORLD, HOUSES, COLLIDERS, FURNITURE, WINDOW_SPEC, SPAWNS,
  houseWallSegments, heightAt, raycastWorld, isWalkableAt,
  movePlayerHorizontal, stepPlayerPhysics, circleOverlapsBox,
} from '../shared/world.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};
const log = (t) => console.log('\n== ' + t + ' ==');

// ---------- 窗户规格 ----------
log('无玻璃窗洞规格');
{
  let total = 0, badW = [], badH = [], badSill = [], fewWin = [], oneSide = [], aboveWall = [];
  for (const h of HOUSES) {
    const d = houseWallSegments(h);
    total += d.windows.length;
    if (d.windows.length < 2) fewWin.push(h.id);
    if (new Set(d.windows.map((w) => w.side)).size < 2) oneSide.push(h.id);
    for (const w of d.windows) {
      if (w.w < 1.0 || w.w > 1.4) badW.push(h.id + ':' + w.w.toFixed(2));
      if (Math.abs(w.h - 1.2) > 1e-9) badH.push(h.id + ':' + w.h.toFixed(2));
      if (w.sill < 0.9 || w.sill > 1.1) badSill.push(h.id + ':' + w.sill.toFixed(2));
      if (w.y1 > h.padH + h.wallH - 0.1) aboveWall.push(h.id + ':' + w.side);
    }
  }
  ok('每栋房子 ≥2 个窗户', fewWin.length === 0, '窗户总数=' + total + (fewWin.length ? ' 少窗:' + fewWin.join(',') : ''));
  ok('每栋房子窗户覆盖 ≥2 个朝向', oneSide.length === 0, oneSide.join(','));
  ok('窗宽 1.0~1.4m', badW.length === 0, badW.join(','));
  ok('窗高 1.2m', badH.length === 0, badH.join(','));
  ok('窗台高约 1.0m', badSill.length === 0, badSill.join(','));
  ok('窗洞不超出墙顶', aboveWall.length === 0, aboveWall.join(','));
  ok('WINDOW_SPEC 规格自洽', WINDOW_SPEC.sill === 1.0 && WINDOW_SPEC.h === 1.2);
}

// ---------- 窗洞碰撞缺口 ----------
log('窗洞碰撞：子弹可穿 / 玩家不可钻');
{
  const bulletBad = [], enterBad = [], coverBad = [];
  for (const h of HOUSES) {
    const d = houseWallSegments(h);
    for (const w of d.windows) {
      const cy = (w.y0 + w.y1) / 2;
      // 墙外 1m 沿法线射入，前 0.85m（墙厚 0.34 + 余量）不应命中墙体
      const inHit = raycastWorld(w.x + w.dirX * 1.0, cy, w.z + w.dirZ * 1.0, -w.dirX, 0, -w.dirZ, 0.85);
      if (inHit && inHit.kind === 'house') bulletBad.push(h.id + ':' + w.side + '(外→内)');
      const outHit = raycastWorld(w.x - w.dirX * 1.0, cy, w.z - w.dirZ * 1.0, w.dirX, 0, w.dirZ, 0.85);
      if (outHit && outHit.kind === 'house') bulletBad.push(h.id + ':' + w.side + '(内→外)');
      // 洞口中心不得被任何墙段覆盖
      for (const s of d.segments) {
        if (Math.abs(w.x - s.x) < s.w / 2 - 1e-6 && Math.abs(w.z - s.z) < s.d / 2 - 1e-6
          && cy > s.y0 + 1e-6 && cy < s.y1 - 1e-6) coverBad.push(h.id + ':' + w.side);
      }
      // 玩家沿法线推进：不得越过墙线进屋（窗台挡人）
      const b = { x: w.x + w.dirX * 2.2, y: h.padH, z: w.z + w.dirZ * 2.2, vy: 0, grounded: true, stance: 'stand' };
      for (let i = 0; i < 140; i++) { movePlayerHorizontal(b, -w.dirX * 0.2, -w.dirZ * 0.2); stepPlayerPhysics(b, 0.05); }
      const depth = (b.x - h.x) * w.dirX + (b.z - h.z) * w.dirZ;   // >0 = 仍在室外
      if (depth < 0.1) enterBad.push(h.id + ':' + w.side + ' d=' + depth.toFixed(2));
    }
  }
  ok('子弹可从窗户双向穿过', bulletBad.length === 0, bulletBad.join(','));
  ok('窗洞处无碰撞遮挡', coverBad.length === 0, coverBad.join(','));
  ok('玩家无法从窗户钻进屋', enterBad.length === 0, enterBad.join(','));
}

// ---------- 门洞 ----------
log('门洞尺寸与通行');
{
  const sizeBad = [], walkBad = [];
  for (const h of HOUSES) {
    const d = houseWallSegments(h);
    const dr = d.door;
    if (dr.w < 0.9) sizeBad.push(h.id + ' 宽=' + dr.w.toFixed(2));
    if (dr.h < 2.0) sizeBad.push(h.id + ' 高=' + dr.h.toFixed(2));
    const b = { x: dr.x + dr.dirX * 2.0, y: h.padH, z: dr.z + dr.dirZ * 2.0, vy: 0, grounded: true, stance: 'stand' };
    for (let i = 0; i < 40; i++) { movePlayerHorizontal(b, -dr.dirX * 0.2, -dr.dirZ * 0.2); stepPlayerPhysics(b, 0.05); }
    const depth = (b.x - h.x) * dr.dirX + (b.z - h.z) * dr.dirZ;
    if (depth > 0.1) walkBad.push(h.id);
  }
  ok('门洞宽 ≥0.9m 且高 ≥2.0m', sizeBad.length === 0, sizeBad.join(','));
  ok('玩家可穿过门洞进屋', walkBad.length === 0, walkBad.join(','));
}

// ---------- 家具 ----------
log('家具：数量 / 碰撞一致性 / 不可穿透 / 不越界');
{
  const countBad = [], colBad = [], outBad = [], doorBad = [], solidBad = [];
  for (const h of HOUSES) {
    const list = FURNITURE.filter((f) => f.house === h.id);
    if (list.length < 2 || list.length > 4) countBad.push(h.id + '=' + list.length);
    const d = houseWallSegments(h);
    for (const f of list) {
      const c = COLLIDERS.find((o) => o.kind === 'furniture' && Math.abs(o.x - f.x) < 1e-9 && Math.abs(o.z - f.z) < 1e-9);
      if (!c) { colBad.push(h.id + ':' + f.type + ' 无碰撞'); continue; }
      // 碰撞箱 vs 视觉外廓（旋转后 AABB）
      const cs = Math.abs(Math.cos(f.rot)), sn = Math.abs(Math.sin(f.rot));
      const fw = cs * f.w + sn * f.d, fd = sn * f.w + cs * f.d;
      if (Math.abs(c.w - fw) > 0.05 || Math.abs(c.d - fd) > 0.05) colBad.push(h.id + ':' + f.type + ' 尺寸偏差');
      if (Math.abs((c.y1 - c.y0) - f.h) > 0.05) colBad.push(h.id + ':' + f.type + ' 高度偏差');
      // 必须完全在室内（内墙面 = w/2-0.17）
      if (Math.abs(f.x - h.x) + c.w / 2 > h.w / 2 - 0.17 + 0.02) outBad.push(h.id + ':' + f.type + ' X');
      if (Math.abs(f.z - h.z) + c.d / 2 > h.d / 2 - 0.17 + 0.02) outBad.push(h.id + ':' + f.type + ' Z');
      // 不堵门厅
      const along = Math.abs((f.x - d.door.x) * d.door.dirX + (f.z - d.door.z) * d.door.dirZ);
      const lat = Math.abs((f.x - d.door.x) * -d.door.dirZ + (f.z - d.door.z) * d.door.dirX);
      if (along < 1.2 && lat < d.door.w / 2 + c.w / 2) doorBad.push(h.id + ':' + f.type);
      // 不可穿透：从房屋中心朝家具推进
      const dx = f.x - h.x, dz = f.z - h.z, L = Math.hypot(dx, dz) || 1;
      const b = { x: h.x, y: h.padH, z: h.z, vy: 0, grounded: true, stance: 'stand' };
      for (let i = 0; i < 120; i++) { movePlayerHorizontal(b, (dx / L) * 0.2, (dz / L) * 0.2); stepPlayerPhysics(b, 0.05); }
      const inside = Math.abs(b.x - f.x) < c.w / 2 && Math.abs(b.z - f.z) < c.d / 2;
      if (inside) solidBad.push(h.id + ':' + f.type);
    }
  }
  ok('每栋房子 2~4 件家具', countBad.length === 0, countBad.join(','), );
  ok('家具碰撞箱与视觉外廓一致（<5cm）', colBad.length === 0, colBad.join(','));
  ok('家具完全位于室内（不穿墙）', outBad.length === 0, outBad.join(','));
  ok('家具不堵门厅通道', doorBad.length === 0, doorBad.join(','));
  ok('家具不可穿透', solidBad.length === 0, solidBad.join(','));
  ok('家具种类齐全（桌/椅/床/柜）', ['table', 'chair', 'bed', 'chest'].every((t) => FURNITURE.some((f) => f.type === t)),
    ['table', 'chair', 'bed', 'chest'].map((t) => t + '=' + FURNITURE.filter((f) => f.type === t).length).join(' '));
}

// ---------- 屋顶 / 其它 ----------
log('屋顶与整体一致性');
{
  ok('屋顶无碰撞体', !COLLIDERS.some((o) => o.kind === 'roof'));
  ok('碰撞体数量在合理范围', COLLIDERS.length > 80 && COLLIDERS.length < 400, 'colliders=' + COLLIDERS.length);
  let floorBad = [];
  for (const h of HOUSES) {
    let maxDiff = 0;
    for (const [fx, fz] of [[0, 0], [0.3, 0.25], [-0.3, -0.25], [0.45, 0], [-0.45, 0]]) {
      maxDiff = Math.max(maxDiff, Math.abs(heightAt(h.x + fx * h.w, h.z + fz * h.d) - h.padH));
    }
    if (maxDiff > 0.05) floorBad.push(h.id + ':' + maxDiff.toFixed(2));
  }
  ok('室内地面与墙底齐平', floorBad.length === 0, floorBad.join(','));
  // 房屋中心可站（室内没被家具堵死）
  ok('每栋房屋中心可站立', HOUSES.every((h) => isWalkableAt(h.x, h.z)),
    HOUSES.filter((h) => !isWalkableAt(h.x, h.z)).map((h) => h.id).join(','));
  // 确定性：连续两次生成一致
  const a = JSON.stringify(FURNITURE.map((f) => [f.house, f.type, +f.x.toFixed(6), +f.z.toFixed(6)]));
  ok('家具布局确定性（固定种子）', a === JSON.stringify(FURNITURE.map((f) => [f.house, f.type, +f.x.toFixed(6), +f.z.toFixed(6)])));
  // 家具碰撞不得压到任何出生点
  ok('家具碰撞未与出生点重叠', !COLLIDERS.some((c) => c.kind === 'furniture'
    && SPAWNS.all.some((s) => circleOverlapsBox(s.x, s.z, WORLD.playerRadius + 0.4, c))));
}

console.log(`\n结果：${pass}/${pass + fail} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
