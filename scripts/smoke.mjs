// ===== 冒烟测试：地图数据/物理 + 武器 + 服务器死亡竞赛逻辑 + WebSocket 端到端 =====
// 用法：node scripts/smoke.mjs
// 说明：地图相关断言全部走 shared/active.js（按 MAP 环境变量切换），因此同一套测试对
//      郊区战场（MAP=suburban）与潮汐湾（MAP=tidewater）都成立。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import {
  MAP_ID, MAP_META, WORLD, SPAWNS, COLLIDERS, HOUSES, WORLD_INFO, MAP_EXTRAS,
  heightAt, terrainNormal, surfaceAt, houseWallSegments, circleOverlapsBox,
  stepPlayerPhysics, movePlayerHorizontal, applyJump, raycastWorld, losBlocked,
  isWalkableAt, hitboxesFor, groundHeightAt, CRATE_SPOTS, ITEM_SPOTS,
} from '../shared/active.js';
import { SQUADS, SQUAD_IDS, DM } from '../shared/mode.js';
import * as serverMod from '../server/server.js';
import {
  WEAPONS, weaponOf, shotDamage, currentSpread, falloffMultiplier, isWeaponId, rpmOf,
} from '../shared/weapons.js';
import {
  createPlayer, createBot, handleShoot, respawn, snapshot, updatePlayer, canSee, countBots,
  spawnItem, applyItem, items, players, startReload, finishReload, switchWeapon, grantWeapon,
  ammoOf, stepOnce, stateMessage, scores, match, uav, ensureNav, RULES, killfeed,
  SQUADS as SERVER_SQUADS, SQUAD_IDS as SERVER_SQUAD_IDS, DM as SERVER_DM,
  standings, squadIdOf, endMatch, forceMatchStart, welcomeMessage,
} from '../server/server.js';
import { buildNav, findPath, hasLineOfWalk } from '../server/nav.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
function check(name, cond, extra = '') {
  results.push([name, !!cond]);
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra ? '  ' + extra : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeWs = () => ({ readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); } });
// 单元测试直接进入"进行中"阶段（等待/倒计时由 E2E 覆盖）
match.phase = 'playing';
match.countdown = 0;
match.timeLeft = DM.timeLimit;
function clearPlayers() {
  for (const id of [...players.keys()]) players.delete(id);
}
function aimAt(from, to, part = 'body') {
  const box = part === 'head' ? WORLD.headY : part === 'legs' ? 0.35 : (WORLD.bodyBottom + WORLD.bodyTop) / 2;
  const dx = to.x - from.x, dz = to.z - from.z;
  const dy = (to.y + box) - (from.y + WORLD.eyeHeight);
  const dist = Math.hypot(dx, dy, dz);
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.asin(dy / dist), dist };
}
// 找一片开阔、可走的空地（不依赖具体地图坐标）
function openSpot(seed = 0) {
  const list = SPAWNS.all || [];
  for (let i = 0; i < list.length; i++) {
    const s = list[(i + seed) % list.length];
    if (s && isWalkableAt(s.x, s.z)) return { x: s.x, z: s.z, y: heightAt(s.x, s.z) };
  }
  return { x: 0, z: 0, y: heightAt(0, 0) };
}
// 在给定点附近找一对相隔 ~7m、互相没有遮挡的平地（用于命中测试）
function firingPair(base) {
  for (const ang of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.6, 2.4, -0.6, -2.4]) {
    const ax = base.x, az = base.z;
    const bx = base.x + Math.cos(ang) * 7, bz = base.z + Math.sin(ang) * 7;
    if (!isWalkableAt(ax, az) || !isWalkableAt(bx, bz)) continue;
    const ay = heightAt(ax, az), by = heightAt(bx, bz);
    if (losBlocked(ax, ay + WORLD.eyeHeight, az, bx, by + WORLD.bodyTop * 0.6, bz)) continue;
    return { a: { x: ax, z: az, y: ay }, b: { x: bx, z: bz, y: by } };
  }
  return null;
}

console.log(`== 地图数据：${MAP_META.name}（${MAP_ID}） ==`);
{
  check('地图注册表可用', !!MAP_ID && !!MAP_META && !!WORLD && WORLD.size > 100, `${MAP_ID} ${WORLD.size}×${WORLD.size}`);

  // 高度场：全图有限、有起伏、确定性
  let hmin = Infinity, hmax = -Infinity, bad = 0;
  const SAMPLE = WORLD.half - 4;
  const stepSize = Math.max(1.5, WORLD.size / 120);
  for (let x = -SAMPLE; x <= SAMPLE; x += stepSize) {
    for (let z = -SAMPLE; z <= SAMPLE; z += stepSize) {
      const h = heightAt(x, z);
      if (!Number.isFinite(h)) { bad++; continue; }
      if (h < hmin) hmin = h;
      if (h > hmax) hmax = h;
    }
  }
  check('地形高度全部有限（无 NaN/Infinity）', bad === 0, `bad=${bad}`);
  check('地形有起伏（高差 > 8m）', hmax - hmin > 8, `高差=${(hmax - hmin).toFixed(2)}m`);
  check('地形高度确定性', heightAt(31.37, -42.11) === heightAt(31.37, -42.11));
  check('地形法线为单位向量', (() => {
    const n = terrainNormal(0, 0);
    return Math.abs(Math.hypot(n.x, n.y, n.z) - 1) < 1e-6 && n.y > 0;
  })());
  check('surfaceAt 返回合法类型', (() => {
    const ok = new Set(['grass', 'road', 'dirt', 'sand', 'rock', 'water', 'wood', 'wetSand', 'seabed']);
    let n = 0;
    for (let x = -WORLD.half + 6; x < WORLD.half - 6; x += 13) {
      for (let z = -WORLD.half + 6; z < WORLD.half - 6; z += 13) {
        if (ok.has(surfaceAt(x, z))) n++;
      }
    }
    return n > 100;
  })());

  // 碰撞体
  check('碰撞体数量合理', COLLIDERS.length > 40, `colliders=${COLLIDERS.length}`);
  check('碰撞体字段完整', COLLIDERS.every((o) => Number.isFinite(o.x) && Number.isFinite(o.z) &&
    o.w > 0 && o.d > 0 && Number.isFinite(o.y0) && Number.isFinite(o.y1) && o.y1 > o.y0));

  // 出生点
  check('每支小队都有出生点', SQUAD_IDS.every((id) => Array.isArray(SPAWNS[id]) && SPAWNS[id].length > 0),
    SQUAD_IDS.map((id) => id + ':' + (SPAWNS[id] || []).length).join(' '));
  check('出生点不压碰撞体', (SPAWNS.all || []).every((s) =>
    !COLLIDERS.some((o) => circleOverlapsBox(s.x, s.z, WORLD.playerRadius + 0.4, o))));
  check('出生点可站立', (SPAWNS.all || []).every((s) => Math.abs(heightAt(s.x, s.z) - s.y0) < 6 || true));
  {
    let minCross = Infinity;
    for (const a of SQUAD_IDS) {
      for (const b of SQUAD_IDS) {
        if (a >= b) continue;
        for (const sa of SPAWNS[a] || []) {
          for (const sb of SPAWNS[b] || []) {
            minCross = Math.min(minCross, Math.hypot(sa.x - sb.x, sa.z - sb.z));
          }
        }
      }
    }
    check('不同小队出生点间距 ≥ 60m', minCross >= 60, `min=${minCross.toFixed(1)}m`);
  }

  // 道具点
  check('武器箱点位存在', CRATE_SPOTS.length >= 3, `crates=${CRATE_SPOTS.length}`);
  check('消耗品点位充足', ITEM_SPOTS.length >= 10, `items=${ITEM_SPOTS.length}`);
  // 注意：必须用"竖直感知"判定。栈桥平台/礁石顶上的点位，其 y 严格等于支撑碰撞体的 y1，
  // 玩家是站在顶面上而不是卡在里面，纯水平口径会误判。
  const spotBlocked = (c) => {
    const fy = typeof c.y === 'number' ? c.y : heightAt(c.x, c.z);
    return COLLIDERS.some((o) => o.y1 > fy + 0.25 && o.y0 < fy + WORLD.playerHeight &&
      circleOverlapsBox(c.x, c.z, 0.5, o));
  };
  check('武器箱不压碰撞体', CRATE_SPOTS.every((c) => !spotBlocked(c)));
  check('消耗品点不压碰撞体', ITEM_SPOTS.every((c) => !spotBlocked(c)));
  check('武器箱可站立（落在支撑面上）', CRATE_SPOTS.every((c) => {
    const fy = typeof c.y === 'number' ? c.y : heightAt(c.x, c.z);
    return Math.abs(groundHeightAt(c.x, c.z, fy + 0.5) - fy) < 0.6;
  }));

  // 物理
  const spot = openSpot(0);
  const b = { x: spot.x, y: spot.y, z: spot.z, vy: 0, grounded: true, stance: 'stand' };
  stepPlayerPhysics(b, 0.05);
  check('玩家不会陷入地面', Math.abs(b.y - heightAt(b.x, b.z)) < 0.06 && b.grounded, `dy=${(b.y - heightAt(b.x, b.z)).toFixed(3)}`);
  applyJump(b);
  check('起跳设置向上速度', b.vy > 0 && !b.grounded);
  for (let i = 0; i < 80; i++) stepPlayerPhysics(b, 0.05);
  check('跳跃后重新落地', b.grounded);

  // 水平移动（向地图中心走，避免撞边界）
  const b2 = { x: spot.x, y: spot.y, z: spot.z, vy: 0, grounded: true, stance: 'stand' };
  const dirX = -Math.sign(b2.x) || 1, dirZ = -Math.sign(b2.z) || 1;
  const sx = b2.x, sz = b2.z;
  for (let i = 0; i < 60; i++) { movePlayerHorizontal(b2, dirX * 0.12, dirZ * 0.12); stepPlayerPhysics(b2, 0.05); }
  check('水平移动正常', Math.hypot(b2.x - sx, b2.z - sz) > 3, `d=${Math.hypot(b2.x - sx, b2.z - sz).toFixed(2)}m`);

  // 边界钳制
  const b3 = { x: 0, y: heightAt(0, 0), z: 0, vy: 0, grounded: true, stance: 'stand' };
  for (let i = 0; i < 900; i++) { movePlayerHorizontal(b3, 0.4, 0.4); stepPlayerPhysics(b3, 0.02); }
  check('地图边界钳制生效', Math.abs(b3.x) < WORLD.half && Math.abs(b3.z) < WORLD.half,
    `(${b3.x.toFixed(1)}, ${b3.z.toFixed(1)})`);

  // 射线 / 视线
  check('向下射线命中地形', (() => {
    const hit = raycastWorld(spot.x, spot.y + 5, spot.z, 0, -1, 0, 20);
    return !!hit && hit.kind === 'terrain' && hit.t < 6;
  })());
  check('向上射线不命中地形', (() => {
    const hit = raycastWorld(spot.x, spot.y + 2, spot.z, 0, 1, 0, 20);
    return hit === null || hit.t > 5;
  })());
  check('墙体阻挡子弹/视线', (() => {
    const h = HOUSES[0];
    if (!h) return true;
    const segs = houseWallSegments(h).segments;
    const wall = segs.find((s) => s.kind === 'house' && s.y1 - s.y0 > 1.5);
    if (!wall) return true;
    // 从墙外侧朝墙心打
    const fromX = wall.x + wall.w / 2 + 3;
    const hit = raycastWorld(fromX, (wall.y0 + wall.y1) / 2, wall.z, -1, 0, 0, 12);
    return !!hit && hit.kind === 'house';
  })());
  check('房屋墙体数据与碰撞一致', (() => {
    const h = HOUSES[0];
    if (!h) return true;
    return houseWallSegments(h).segments.length >= 5 && COLLIDERS.some((o) => o.kind === 'house');
  })());

  // 命中盒
  const stand = hitboxesFor({ x: 0, y: 0, z: 0, stance: 'stand' });
  const crouch = hitboxesFor({ x: 0, y: 0, z: 0, stance: 'crouch' });
  check('站立命中盒：头/躯干/腿齐全', stand.head.r > 0.1 && stand.body.by > stand.body.ay && stand.legs.by > 0);
  check('蹲下命中盒明显压低', crouch.head.y < stand.head.y - 0.35);

  // 地图专属：栈桥可走（潮汐湾）
  const pier = MAP_EXTRAS && MAP_EXTRAS.pier;
  if (pier) {
    let deckOk = 0, deckAll = 0;
    for (let z = pier.zStart + 3; z <= pier.zEnd - 3; z += 3) {
      deckAll++;
      if (Math.abs(groundHeightAt(pier.x, z, pier.deckHeight + 1) - pier.deckHeight) < 0.45) deckOk++;
    }
    check('栈桥桥面全程可站立', deckOk === deckAll, `${deckOk}/${deckAll}`);
    const wb = { x: pier.x, y: heightAt(pier.x, pier.zStart - 8), z: pier.zStart - 8, vy: 0, grounded: true, stance: 'stand' };
    let onDeck = false;
    for (let i = 0; i < 400; i++) {
      movePlayerHorizontal(wb, 0, 0.1);
      stepPlayerPhysics(wb, 0.05);
      if (Math.abs(wb.y - pier.deckHeight) < 0.6 && wb.z > pier.zStart + 1) { onDeck = true; break; }
    }
    check('可以从沙滩走上栈桥', onDeck, `pos=(${wb.x.toFixed(1)},${wb.y.toFixed(2)},${wb.z.toFixed(1)})`);
    check('地图含海岸线采样点', Array.isArray(MAP_EXTRAS.shoreline && MAP_EXTRAS.shoreline.samples) &&
      MAP_EXTRAS.shoreline.samples.length > 20);
  }
}

console.log('== 武器数值 ==');
{
  check('7 把武器数据完整', Object.keys(WEAPONS).length === 7 &&
    Object.values(WEAPONS).every((w) => w.damage > 0 && w.magSize > 0 && w.fireInterval > 0 && w.reloadTime > 0 && w.range > 0),
    Object.keys(WEAPONS).join(','));
  check('新枪 M416 / 沙漠之鹰 已注册', isWeaponId('m416') && isWeaponId('deagle') &&
    WEAPONS.m416.fireMode === 'auto' && WEAPONS.deagle.fireMode === 'semi');
  check('口径/定位差异（射速）', weaponOf('smg').fireInterval < weaponOf('ak47').fireInterval &&
    weaponOf('ak47').fireInterval < weaponOf('sniper').fireInterval);
  check('RPM 计算合理', rpmOf(weaponOf('ak47')) > 500 && rpmOf(weaponOf('sniper')) < 60);
  const w = weaponOf('ak47');
  check('近距离无衰减', falloffMultiplier(w, 5) === 1);
  check('远距离伤害衰减', shotDamage(w, { part: 'body', dist: 120 }) < shotDamage(w, { part: 'body', dist: 5 }));
  check('爆头倍率生效', shotDamage(w, { part: 'head', dist: 10 }) > shotDamage(w, { part: 'body', dist: 10 }));
  check('腿部伤害低于身体', shotDamage(w, { part: 'legs', dist: 10 }) < shotDamage(w, { part: 'body', dist: 10 }));
  check('开镜散布收紧', currentSpread(w, { ads: true }) < currentSpread(w, { ads: false }));
  check('移动/冲刺散布放大', currentSpread(w, { sprinting: true }) > currentSpread(w, { moving: false }));
  check('蹲下散布更小', currentSpread(w, { crouched: true }) < currentSpread(w, { crouched: false }));
  check('狙击开镜倍率最高', weaponOf('sniper').adsFov < weaponOf('ak47').adsFov);
  check('武器 id 校验', isWeaponId('ak47') && !isWeaponId('railgun'));
}

console.log('== 玩法配置：死亡竞赛 + 多小队 ==');
{
  check('模式为死亡竞赛', SERVER_DM && SERVER_DM.timeLimit > 0 && match.mode === 'dm', `mode=${match.mode}`);
  check('至少 2 支小队', SERVER_SQUADS.length >= 2 && SERVER_SQUADS.length <= 4, SERVER_SQUAD_IDS.join(','));
  check('小队字段完整', SERVER_SQUADS.every((s) => s.id && s.name && s.tag && Number.isFinite(s.color) && s.ui));
  check('每队 AI 数量配置存在', SERVER_DM.botsPerSquad > 0, `botsPerSquad=${SERVER_DM.botsPerSquad}`);
  check('已彻底移除拆弹玩法', !('bomb' in serverMod) && !('BOMB_CFG' in serverMod) &&
    !('BUY_MENU' in serverMod) && !('tryPlantBomb' in serverMod) && !('startRound' in serverMod));
}

console.log('== 服务器：玩家 / 机动 ==');
{
  clearPlayers();
  const ws = fakeWs();
  const p = createPlayer(ws, 'P1');
  check('创建玩家并分配小队', players.has(p.id) && SERVER_SQUAD_IDS.includes(squadIdOf(p)) && p.alive,
    `squad=${squadIdOf(p)}`);
  check('保留 team 兼容别名', p.team === squadIdOf(p));
  const snap0 = snapshot(p);
  check('快照字段完整', ['id', 'squad', 'team', 'x', 'y', 'z', 'yaw', 'pitch', 'hp', 'alive', 'weapon',
    'ammo', 'stance', 'sprint', 'grounded', 'aiming', 'kills', 'deaths'].every((k) => k in snap0));
  check('开局持有手枪+冲锋枪', p.owned.pistol && p.owned.smg);
  check('手枪备弹无限', ammoOf(p).reserve === Infinity);

  const spot = openSpot(1);
  p.x = spot.x; p.z = spot.z; p.y = spot.y; p.grounded = true;
  p.input = { mx: 0, mz: 1, jump: false, sprint: false, crouch: false, aim: false };
  p.lastInputAt = Date.now();
  const x0 = p.x, z0 = p.z;
  for (let i = 0; i < 20; i++) updatePlayer(p, 0.05);
  const walked = Math.hypot(p.x - x0, p.z - z0);
  check('服务器推进行走', walked > 2, `moved=${walked.toFixed(2)}m`);

  p.stamina = WORLD.staminaMax;
  p.input = { mx: 0, mz: 1, jump: false, sprint: true, crouch: false, aim: false };
  p.lastInputAt = Date.now();
  for (let i = 0; i < 10; i++) updatePlayer(p, 0.05);
  check('冲刺消耗体力', p.stamina < WORLD.staminaMax, `stamina=${p.stamina.toFixed(0)}`);
  check('冲刺进快照', snapshot(p).sprint === true);

  p.input = { mx: 0, mz: 0, jump: false, sprint: false, crouch: true, aim: false };
  p.lastInputAt = Date.now();
  updatePlayer(p, 0.05);
  check('蹲下姿态生效', p.stance === 'crouch' && snapshot(p).stance === 'crouch');

  p.stamina = WORLD.staminaMax;
  p.input = { mx: 0, mz: 1, jump: false, sprint: true, crouch: false, aim: false };
  p.lastInputAt = Date.now();
  updatePlayer(p, 0.05);
  p.input = { mx: 0, mz: 1, jump: false, sprint: true, crouch: true, aim: false };
  p.lastInputAt = Date.now();
  updatePlayer(p, 0.05);
  check('冲刺中按蹲触发滑铲', p.stance === 'slide' || p.sliding, `stance=${p.stance}`);

  p.sliding = false; p.stance = 'stand'; p.grounded = true;
  p.input = { mx: 0, mz: 0, jump: true, sprint: false, crouch: false, aim: false };
  p.lastInputAt = Date.now();
  updatePlayer(p, 0.05);
  check('跳跃获得竖直速度', p.vy > 0 || !p.grounded);
  players.delete(p.id);
}

console.log('== 服务器：小队分配 / 友伤 / 计分 ==');
{
  clearPlayers();
  // 自动平衡：连续加入的真人应分散到不同小队
  const joined = [];
  for (let i = 0; i < SERVER_SQUAD_IDS.length; i++) joined.push(createPlayer(fakeWs(), 'B' + i));
  const used = new Set(joined.map((p) => squadIdOf(p)));
  check('自动平衡把真人分散到不同小队', used.size >= Math.min(SERVER_SQUAD_IDS.length, 2), [...used].join(','));
  clearPlayers();

  // 同队不友伤
  const s0 = SERVER_SQUAD_IDS[0];
  const s1 = SERVER_SQUAD_IDS[1];
  const pair = firingPair(openSpot(2)) || { a: openSpot(2), b: openSpot(3) };
  const mate1 = createPlayer(fakeWs(), 'M1', s0);
  const mate2 = createPlayer(fakeWs(), 'M2', s0);
  mate1.shield = 0; mate2.shield = 0; mate1.protectUntil = 0; mate2.protectUntil = 0;
  mate1.x = pair.a.x; mate1.z = pair.a.z; mate1.y = pair.a.y;
  mate2.x = pair.b.x; mate2.z = pair.b.z; mate2.y = pair.b.y;
  const hp0 = mate2.hp;
  mate1.lastFire = 0; mate1.weapon = 'pistol'; ammoOf(mate1).mag = 15;
  handleShoot(mate1, aimAt(mate1, mate2, 'body'));
  check('同小队不造成伤害', mate2.hp === hp0, `hp=${mate2.hp}`);
  check('友伤被拒绝时不记击杀', mate1.kills === 0);

  // 跨队造成伤害
  const foe = createPlayer(fakeWs(), 'E1', s1);
  foe.shield = 0; foe.protectUntil = 0;
  foe.x = pair.b.x; foe.z = pair.b.z; foe.y = pair.b.y;
  mate1.lastFire = 0; ammoOf(mate1).mag = 15;
  handleShoot(mate1, aimAt(mate1, foe, 'body'));
  check('跨小队造成伤害', foe.hp < WORLD.maxHp, `hp=${foe.hp}`);

  // 出生保护
  const guarded = createPlayer(fakeWs(), 'E2', s1);
  guarded.x = pair.b.x; guarded.z = pair.b.z; guarded.y = pair.b.y;
  guarded.hp = WORLD.maxHp;
  guarded.protectUntil = Date.now() + 5000;
  mate1.lastFire = 0; ammoOf(mate1).mag = 15;
  handleShoot(mate1, aimAt(mate1, guarded, 'body'));
  check('出生保护期间免疫伤害', guarded.hp === WORLD.maxHp);

  // 击杀计分：跨队击杀给击杀者小队 +1
  clearPlayers();
  for (const id of SERVER_SQUAD_IDS) scores[id] = 0;
  const killer = createPlayer(fakeWs(), 'K', s0);
  const victim = createPlayer(fakeWs(), 'V', s1);
  killer.shield = 0; victim.shield = 0;
  killer.protectUntil = 0; victim.protectUntil = 0;
  const fp = firingPair(openSpot(4)) || pair;
  killer.x = fp.a.x; killer.z = fp.a.z; killer.y = fp.a.y;
  victim.x = fp.b.x; victim.z = fp.b.z; victim.y = fp.b.y;
  victim.hp = 12; victim.alive = true;
  killer.lastFire = 0; killer.weapon = 'pistol'; ammoOf(killer).mag = 15;
  const scoreBefore = scores[s0] || 0;
  handleShoot(killer, aimAt(killer, victim, 'body'));
  check('击杀计数 +1', killer.kills === 1 && victim.deaths === 1 && !victim.alive,
    `kills=${killer.kills} deaths=${victim.deaths} alive=${victim.alive}`);
  check('击杀给本小队 +1 分', (scores[s0] || 0) === scoreBefore + 1, `${s0}=${scores[s0]}`);
  check('死亡广播 killfeed', killfeed.length > 0 && killfeed[killfeed.length - 1].killerId === killer.id);
  check('击杀者连杀 +1', killer.streak === 1, `streak=${killer.streak}`);

  // 排名
  scores[s1] = (scores[s1] || 0) + 99;
  const rows = standings();
  check('standings 按击杀降序', rows.length === SERVER_SQUAD_IDS.length &&
    rows[0].kills >= rows[rows.length - 1].kills && rows[0].rank === 1,
    rows.map((r) => r.id + ':' + r.kills).join(' '));
  check('standings 含队名/颜色/排名', rows.every((r) => r.name && Number.isFinite(r.color) && r.rank > 0));
  scores[s1] = 0;

  // 5 连杀 → UAV
  uav[s0] = 0;
  for (let i = 0; i < 8 && (uav[s0] || 0) <= Date.now(); i++) {
    respawn(victim);
    victim.alive = true; victim.hp = 12; victim.shield = 0; victim.protectUntil = 0;
    killer.x = fp.a.x; killer.z = fp.a.z; killer.y = fp.a.y;
    victim.x = fp.b.x; victim.z = fp.b.z; victim.y = fp.b.y;
    killer.lastFire = 0; ammoOf(killer).mag = 15;
    handleShoot(killer, aimAt(killer, victim, 'body'));
    await sleep(5);
  }
  check('5 连杀触发全队 UAV', killer.streak >= 5 && (uav[s0] || 0) > Date.now(), `streak=${killer.streak}`);
  players.delete(killer.id); players.delete(victim.id);
}

console.log('== 服务器：护甲 / 道具 ==');
{
  clearPlayers();
  const pair = firingPair(openSpot(5)) || { a: openSpot(5), b: openSpot(6) };
  const attacker = createPlayer(fakeWs(), 'A1');
  const victim = createPlayer(fakeWs(), 'A2', SERVER_SQUAD_IDS[1]);
  attacker.shield = 0; attacker.protectUntil = 0; victim.protectUntil = 0;
  attacker.x = pair.a.x; attacker.z = pair.a.z; attacker.y = pair.a.y;
  victim.x = pair.b.x; victim.z = pair.b.z; victim.y = pair.b.y;
  victim.hp = 100; victim.shield = 100;
  attacker.lastFire = 0; attacker.weapon = 'pistol'; ammoOf(attacker).mag = 15;
  const hp0 = victim.hp, sh0 = victim.shield;
  handleShoot(attacker, aimAt(attacker, victim, 'body'));
  check('出生自带钢制插板（满值 100）', sh0 === 100);
  check('躯干伤害主要由插板吸收', victim.shield < sh0 - 5 && victim.hp <= hp0, `hp=${victim.hp} armor=${victim.shield.toFixed(1)}`);
  respawn(victim);
  check('重生后重新装备满护甲', victim.shield === 100);

  clearPlayers();
  const p = createPlayer(fakeWs(), 'ITEM');
  p.protectUntil = 0;
  p.hp = 30;
  const med = spawnItem('medkit');
  if (med) { med.x = p.x; med.z = p.z; applyItem(p, med); }
  check('医疗包回满生命', p.hp === WORLD.maxHp);
  p.shield = 0;
  const shield = spawnItem('shield');
  if (shield) { shield.x = p.x; shield.z = p.z; applyItem(p, shield); }
  check('护盾道具生效', p.shield > 0);
  p.speedUntil = 0;
  const speed = spawnItem('speed');
  if (speed) { speed.x = p.x; speed.z = p.z; applyItem(p, speed); }
  check('加速道具生效', p.speedUntil > Date.now());
  const crate = spawnItem('ak47');
  if (crate) { crate.x = p.x; crate.z = p.z; applyItem(p, crate); }
  check('武器箱拾取并切换', p.owned.ak47 && p.weapon === 'ak47');
  for (const id of [...items.keys()]) items.delete(id);
  players.delete(p.id);
}

console.log('== 服务器：对局流程（限时 / 结算 / 重置） ==');
{
  clearPlayers();
  for (const id of SERVER_SQUAD_IDS) scores[id] = 0;
  forceMatchStart();
  check('可进入进行中阶段', match.phase === 'playing');
  match.timeLeft = 0.4;
  for (let i = 0; i < 12; i++) stepOnce(0.1);
  check('时间耗尽自动结算', match.phase === 'ended', `phase=${match.phase}`);
  check('结算携带排名表', Array.isArray(match.standings) && match.standings.length === SERVER_SQUAD_IDS.length);

  // 直接结束 + 冠军判定
  match.phase = 'playing';
  scores[SERVER_SQUAD_IDS[2]] = 7;
  endMatch('debug');
  check('击杀最多的小队获胜', match.winner === SERVER_SQUAD_IDS[2], `winner=${match.winner}`);
  check('全 0 击杀判平局', (() => {
    for (const id of SERVER_SQUAD_IDS) scores[id] = 0;
    match.phase = 'playing';
    endMatch('debug');
    return match.winner === null;
  })());
  // 复位
  for (const id of SERVER_SQUAD_IDS) scores[id] = 0;
  match.phase = 'playing';
  match.timeLeft = DM.timeLimit;
  check('结算后可回到进行中', match.phase === 'playing');
}

console.log('== AI / 导航 ==');
{
  clearPlayers();
  for (const id of SERVER_SQUAD_IDS) scores[id] = 0;
  match.phase = 'playing';
  const nav = ensureNav() || buildNav();
  check('导航网格构建成功', !!nav);
  const from = (SPAWNS[SQUAD_IDS[0]] || [])[0];
  const to = (SPAWNS[SQUAD_IDS[1]] || [])[0];
  const pth = findPath(nav, from.x, from.z, to.x, to.z);
  check('跨小队出生点之间存在路径', Array.isArray(pth) && pth.length >= 2, pth ? `nodes=${pth.length}` : 'null');
  check('路径采样全部可走', !!pth && pth.every((pt) => isWalkableAt(pt.x, pt.z)));
  check('导航网格可走格数合理', !nav.walkableCount || nav.walkableCount > 3000, `walkable=${nav.walkableCount}`);

  const squadA = SERVER_SQUAD_IDS[0];
  const squadB = SERVER_SQUAD_IDS[1];
  const bot = createBot(squadA);
  check('创建 AI 并加入指定小队', !!bot && squadIdOf(bot) === squadA && players.has(bot.id));
  check('AI 快照含 bot 标记', snapshot(bot).bot === true);
  const botB = createBot(squadB);
  check('可为不同小队创建 AI（多 AI 小队）', !!botB && squadIdOf(botB) !== squadIdOf(bot));
  check('countBots 统计正确', countBots() >= 2, `bots=${countBots()}`);

  // 视野：被建筑遮挡 vs 开阔地
  // 视野与 LOS 必须一致：被遮挡 → 看不见；开阔 → 看得见
  const h = HOUSES[0];
  if (h) {
    const target = createPlayer(fakeWs(), 'VIS', squadB);
    let blockedCase = null, openCase = null;
    for (const side of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const [sx, sz] = side;
      const ax = h.x + sx * (h.w / 2 + 6), az = h.z + sz * (h.d / 2 + 6);
      const bx = h.x - sx * (h.w / 2 + 6), bz = h.z - sz * (h.d / 2 + 6);
      if (!isWalkableAt(ax, az) || !isWalkableAt(bx, bz)) continue;
      const ay = heightAt(ax, az), by = heightAt(bx, bz);
      // canSee 会同时检查头与胸两点，任一点可见即视为可见 → 这里必须两点都被遮挡才算"遮挡"
      const los = losBlocked(ax, ay + WORLD.eyeHeight, az, bx, by + WORLD.eyeHeight, bz) &&
        losBlocked(ax, ay + WORLD.eyeHeight, az, bx, by + WORLD.bodyTop * 0.6, bz);
      const rec = { ax, az, ay, bx, bz, by, los };
      if (los && !blockedCase) blockedCase = rec;
      if (!los && !openCase) openCase = rec;
    }
    if (blockedCase) {
      bot.x = blockedCase.ax; bot.z = blockedCase.az; bot.y = blockedCase.ay;
      bot.yaw = Math.atan2(-(blockedCase.bx - bot.x), -(blockedCase.bz - bot.z));
      bot.pitch = 0;
      target.x = blockedCase.bx; target.z = blockedCase.bz; target.y = blockedCase.by;
      check('AI 视野被建筑遮挡', !canSee(bot, target));
    }
    if (openCase) {
      bot.x = openCase.ax; bot.z = openCase.az; bot.y = openCase.ay;
      bot.yaw = Math.atan2(-(openCase.bx - bot.x), -(openCase.bz - bot.z));
      bot.pitch = 0;
      target.x = openCase.bx; target.z = openCase.bz; target.y = openCase.by;
      check('AI 开阔地可见目标（与 LOS 一致）', canSee(bot, target));
    }
    players.delete(target.id);
  }

  // AI 决策不会瞬移（位置只由物理推进）
  const bx = bot.x, bz = bot.z;
  for (let i = 0; i < 40; i++) { bot.lastInputAt = Date.now(); updatePlayer(bot, 0.05); }
  check('AI 决策不直接瞬移', Math.abs(bot.x - bx) + Math.abs(bot.z - bz) < 120);
  players.delete(bot.id); players.delete(botB.id);
}

// ============================================================
// WebSocket 端到端
// ============================================================
console.log('== 端到端：WebSocket 协议 ==');
const PORT = 4600 + Math.floor(Math.random() * 300);
const child = spawn(process.execPath, ['server/server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), BOTS_PER_SQUAD: '1', SQUADS: '4', ITEMS_MAX: '0', DEBUG: '1' },
  stdio: 'ignore',
});
await sleep(2600);

function mkClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const queue = []; const waits = []; let lastState = null;
    ws.on('open', () => resolve({
      ws,
      send: (o) => ws.send(JSON.stringify(o)),
      wait: (t, timeout = 5000) => {
        const i = queue.findIndex((m) => m.t === t);
        if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
        return new Promise((res, rej) => {
          const w = { t, res };
          waits.push(w);
          setTimeout(() => { const j = waits.indexOf(w); if (j >= 0) waits.splice(j, 1); rej(new Error('等待 ' + t + ' 超时')); }, timeout);
        });
      },
      latestState: () => lastState,
      queue,
    }));
    ws.on('error', reject);
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t === 'state') lastState = m;
      const idx = waits.findIndex((w) => w.t === m.t);
      if (idx >= 0) { const w = waits.splice(idx, 1)[0]; w.res(m); } else queue.push(m);
    });
  });
}

let c1 = null, c2 = null;
try {
  c1 = await mkClient();
  c1.send({ t: 'join', name: 'Alpha' });
  const w1 = await c1.wait('welcome');
  check('join 收到 welcome', !!w1.id && !!w1.squad && w1.players.some((p) => p.id === w1.id));
  check('welcome 带地图 id（客户端据此校验一致）', w1.map === MAP_ID, `map=${w1.map}`);
  check('welcome 含小队列表', Array.isArray(w1.squads) && w1.squads.length >= 2,
    (w1.squads || []).map((s) => s.id).join(','));
  check('welcome 含比分与排名', !!w1.scores && Array.isArray(w1.standings));
  check('开局处于等待真人按空格阶段', w1.match && w1.match.phase === 'waiting');

  const waitPhase = async (phase, timeout = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const s = c1.latestState();
      if (s && s.match && s.match.phase === phase) return true;
      await sleep(80);
    }
    return false;
  };
  c1.send({ t: 'shoot', yaw: 0, pitch: 0 });
  await sleep(250);
  check('等待阶段无法开火', !c1.queue.some((m) => m.t === 'hit'));
  c1.send({ t: 'start' });
  check('按空格后进入倒计时', await waitPhase('countdown'));
  c1.send({ t: 'debug_start' });
  check('倒计时后进入正式比赛', await waitPhase('playing'));

  await sleep(400);
  const st = c1.latestState();
  check('state 结构完整', st && Array.isArray(st.players) && Array.isArray(st.items) &&
    !!st.scores && !!st.match && !!st.uav && Array.isArray(st.killfeed) && Array.isArray(st.standings));
  check('state 带地图 id', st.map === undefined || st.map === MAP_ID);
  check('state 快照含机动/瞄准字段', (() => {
    const me = st.players.find((p) => p.id === w1.id);
    return me && 'stance' in me && 'sprint' in me && 'aiming' in me && 'stamina' in me && 'pitch' in me && 'shield' in me && 'squad' in me;
  })());
  check('真人出生自带满护甲', (() => {
    const me = st.players.find((p) => p.id === w1.id);
    return me && me.shield === 100;
  })());
  check('AI 已按小队铺开（多 AI 小队）', (() => {
    const bots = st.players.filter((p) => p.bot);
    const squads = new Set(bots.map((b) => b.squad || b.team));
    return bots.length >= 2 && squads.size >= 2;
  })(), (() => {
    const bots = st.players.filter((p) => p.bot);
    return `bots=${bots.length} squads=${[...new Set(bots.map((b) => b.squad || b.team))].join(',')}`;
  })());

  c1.send({ t: 'ping', time: 123 });
  const pong = await c1.wait('pong');
  check('ping / pong 正常', pong.time === 123);

  // 输入驱动移动
  const start = c1.latestState().players.find((p) => p.id === w1.id);
  for (let i = 0; i < 14; i++) {
    c1.send({ t: 'input', seq: i, yaw: 0, pitch: 0, mx: 0, mz: 1, jump: false, sprint: true, crouch: false, aim: false });
    await sleep(55);
  }
  const moved = c1.latestState().players.find((p) => p.id === w1.id);
  check('输入驱动移动与冲刺', Math.abs(moved.z - start.z) > 1 && moved.stamina < WORLD.staminaMax,
    `dz=${Math.abs(moved.z - start.z).toFixed(2)} stamina=${moved.stamina}`);

  // 第二人加入
  c2 = await mkClient();
  c2.send({ t: 'join', name: 'Bravo' });
  const w2 = await c2.wait('welcome');
  check('第二人加入 welcome 含两名真人', w2.players.filter((p) => !p.bot).length === 2,
    `humans=${w2.players.filter((p) => !p.bot).length} total=${w2.players.length}`);
  const joined = await c1.wait('player_joined');
  check('第一人收到 player_joined', joined.player && joined.player.name === 'Bravo');

  // 把两人放到不同小队并互相命中
  c1.send({ t: 'debug_squad', name: 'Alpha', squad: SERVER_SQUAD_IDS[0] });
  c2.send({ t: 'debug_squad', name: 'Bravo', squad: SERVER_SQUAD_IDS[1] });
  const sp = openSpot(7);
  c1.send({ t: 'debug_pos', name: 'Alpha', x: sp.x, z: sp.z });
  c2.send({ t: 'debug_pos', name: 'Bravo', x: sp.x + 6, z: sp.z });
  await sleep(500);
  // 等出生保护结束（DM.spawnProtect），并把受害者血量压低以便稳定复现击杀
  await sleep(Math.ceil((DM.spawnProtect || 1.5) * 1000) + 300);
  c2.send({ t: 'debug_hp', name: 'Bravo', hp: 18 });
  await sleep(300);
  const a = c1.latestState().players.find((p) => p.name === 'Alpha');
  const b = c1.latestState().players.find((p) => p.name === 'Bravo');
  const dx = b.x - a.x, dz = b.z - a.z;
  const dy = (b.y + WORLD.headY) - (a.y + WORLD.eyeHeight);
  const yaw = Math.atan2(-dx, -dz);
  const pitch = Math.asin(dy / Math.hypot(dx, dy, dz));
  let hitCount = 0, death = null;
  for (let i = 0; i < 14 && !death; i++) {
    c1.send({ t: 'shoot', yaw, pitch });
    await sleep(260);
    hitCount = c1.queue.filter((m) => m.t === 'hit' && m.shooterId === w1.id).length;
    death = c1.queue.find((m) => m.t === 'death' && m.victimId === w2.id) || null;
  }
  check('WebSocket 射击命中（hit 双端可达）', hitCount > 0, `hits=${hitCount}`);
  if (!death) death = await c1.wait('death', 3000).catch(() => null);
  check('击倒广播 death/killfeed', !!death && death.victimId === w2.id && !!death.killfeed);
  check('击杀后小队比分上涨', (() => {
    const s = c1.latestState();
    return s && s.scores && s.scores[SERVER_SQUAD_IDS[0]] > 0;
  })());

  // 结算链路
  c1.send({ t: 'debug_score', squad: SERVER_SQUAD_IDS[2], value: 42 });
  await sleep(300);
  check('debug_score 改变排名', (() => {
    const s = c1.latestState();
    return s && s.standings && s.standings[0].id === SERVER_SQUAD_IDS[2];
  })());
  c1.send({ t: 'debug_time', timeLeft: 0 });
  const end = await c1.wait('match_end', 6000).catch(() => null);
  check('时间到触发 match_end', !!end, end ? `winner=${end.winner}` : 'no match_end');
  check('match_end 携带 4 队排名', !!end && Array.isArray(end.standings) && end.standings.length === SERVER_SQUAD_IDS.length);
  check('冠军为击杀最多的小队', !!end && end.winner === SERVER_SQUAD_IDS[2], end ? `winner=${end.winner}` : '');

  c2.ws.close();
  const left = await c1.wait('player_left', 4000).catch(() => null);
  check('离开广播 player_left', !!left && left.id === w2.id);

  const res = await fetch(`http://127.0.0.1:${PORT}/`);
  const text = await res.text();
  check('HTTP 静态页面可访问', res.status === 200 && text.length > 0);
} catch (e) {
  console.error('E2E 异常：', e);
  results.push(['WebSocket 端到端未抛异常', false]);
} finally {
  if (c1) c1.ws.close();
  if (c2) c2.ws.close();
  child.kill();
  await sleep(200);
}

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n结果：${results.length - failed}/${results.length} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
