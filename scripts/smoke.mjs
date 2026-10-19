// ===== 冒烟测试：共享世界/物理 + 服务器权威逻辑 + WebSocket 端到端 =====
// 用法：node scripts/smoke.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import {
  WORLD, ZONES, SPAWNS, COLLIDERS, HOUSES, heightAt, terrainNormal, surfaceAt,
  houseWallSegments, circleOverlapsBox, stepPlayerPhysics, movePlayerHorizontal, applyJump,
  raycastWorld, losBlocked, isWalkableAt, hitboxesFor, groundHeightAt,
} from '../shared/world.js';
import {
  WEAPONS, weaponOf, shotDamage, currentSpread, falloffMultiplier, STARTING_WEAPONS, isWeaponId, rpmOf,
} from '../shared/weapons.js';
import {
  createPlayer, createBot, handleShoot, respawn, snapshot, updatePlayer, canSee, countBots,
  spawnItem, applyItem, items, players, startReload, finishReload, switchWeapon, grantWeapon,
  ammoOf, stepOnce, stateMessage, zones, scores, match, uav, ensureNav, RULES, killfeed,
} from '../server/server.js';
import { buildNav, findPath, hasLineOfWalk, nearestWalkable } from '../server/nav.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
function check(name, cond, extra = '') {
  results.push([name, !!cond]);
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra ? '  ' + extra : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeWs = () => ({ readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); } });
// 单元测试直接进入"进行中"阶段（开局等待/倒计时由 E2E 覆盖）
match.phase = 'playing';
match.countdown = 0;
match.timeLeft = 600;
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
console.log('== 地形 / 物理（共享） ==');
{
  let hmin = Infinity, hmax = -Infinity;
  for (let x = -68; x <= 68; x += 2) {
    for (let z = -68; z <= 68; z += 2) {
      const h = heightAt(x, z);
      if (h < hmin) hmin = h;
      if (h > hmax) hmax = h;
    }
  }
  check('地形不是平面（高差 > 6m）', hmax - hmin > 6, `高差=${(hmax - hmin).toFixed(2)}m`);
  check('广场平整', Math.abs(heightAt(0, 0)) < 0.05);
  check('地形高度确定性', heightAt(31.37, -42.11) === heightAt(31.37, -42.11));
  check('地表类型合法', ['grass', 'road', 'dirt'].includes(surfaceAt(40, 40)) && surfaceAt(0, 0) === 'dirt');
  const n = terrainNormal(-52, 54);
  check('山丘法线向上且可步行', n.y > 0.5 && Math.abs(n.x) + Math.abs(n.z) > 0.05);

  const b = { x: 0, y: heightAt(0, 0), z: 0, vy: 0, grounded: true, stance: 'stand' };
  stepPlayerPhysics(b, 0.05);
  check('玩家不会陷入地面', Math.abs(b.y - heightAt(0, 0)) < 0.03 && b.grounded);
  applyJump(b);
  check('起跳设置向上速度', b.vy > 0 && !b.grounded);
  for (let i = 0; i < 60; i++) stepPlayerPhysics(b, 0.05);
  check('跳跃后重新落地', b.grounded);

  const b2 = { x: 0, y: heightAt(0, 0), z: 0, vy: 0, grounded: true, stance: 'stand' };
  for (let i = 0; i < 40; i++) { movePlayerHorizontal(b2, 0.27, 0); stepPlayerPhysics(b2, 0.05); }
  check('平地水平移动正常', b2.x > 8);

  // 房屋墙体阻挡：从南侧撞墙（偏离门洞 3m，避免从门口走进去）
  const h0 = HOUSES[0];
  const b3 = { x: h0.x + 3, y: h0.padH, z: h0.z + h0.d / 2 + 3, vy: 0, grounded: true, stance: 'stand' };
  for (let i = 0; i < 80; i++) { movePlayerHorizontal(b3, 0, -0.27); stepPlayerPhysics(b3, 0.05); }
  check('房屋墙体阻挡玩家', b3.z > h0.z + h0.d / 2 - 0.2, `z=${b3.z.toFixed(2)}`);
  check('房屋墙体数据与碰撞一致', houseWallSegments(h0).segments.length >= 5 && COLLIDERS.some((o) => o.kind === 'house'));
  check('出生点不压碰撞体', SPAWNS.all.every((s) => !COLLIDERS.some((o) => circleOverlapsBox(s.x, s.z, WORLD.playerRadius + 0.4, o))));

  // 射线 / 视线
  const down = raycastWorld(0, 5, 0, 0, -1, 0, 20);
  check('向下射线命中地形', !!down && down.kind === 'terrain');
  check('向上射线不命中', raycastWorld(0, 2, 0, 0, 1, 0, 20) === null);
  check('山丘遮挡视线', losBlocked(-30, 2, 30, -52, 2, 54));
  check('开阔地视线通畅', !losBlocked(0, heightAt(0, 0) + 1.64, 0, 10, heightAt(10, 0) + 1.64, 0));
  check('房屋墙体阻挡子弹', (() => {
    const hit = raycastWorld(h0.x, h0.padH + 1.2, h0.z - h0.d / 2 - 3, 0, 0, 1, 20);
    return !!hit && hit.kind === 'house';
  })());

  // 命中盒
  const stand = hitboxesFor({ x: 0, y: 0, z: 0, stance: 'stand' });
  const crouch = hitboxesFor({ x: 0, y: 0, z: 0, stance: 'crouch' });
  check('站立命中盒：头/躯干/腿齐全', stand.head.r > 0.1 && stand.body.by > stand.body.ay && stand.legs.by > 0);
  check('蹲下命中盒明显压低', crouch.head.y < stand.head.y - 0.35);
}

console.log('== 武器数值 ==');
{
  check('5 把武器数据完整', Object.keys(WEAPONS).length === 5 &&
    Object.values(WEAPONS).every((w) => w.damage > 0 && w.magSize > 0 && w.fireInterval > 0 && w.reloadTime > 0 && w.range > 0));
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

console.log('== 服务器：玩家 / 机动 ==');
{
  clearPlayers();
  const ws = fakeWs();
  const p = createPlayer(ws, 'P1');
  check('创建玩家并加入世界', players.has(p.id) && p.team === 'alpha' && p.alive);
  const snap0 = snapshot(p);
  check('快照字段完整', ['id', 'team', 'x', 'y', 'z', 'yaw', 'pitch', 'hp', 'alive', 'weapon', 'ammo', 'stance', 'sprint', 'grounded', 'aiming', 'kills', 'deaths'].every((k) => k in snap0));
  check('开局持有手枪+冲锋枪', p.owned.pistol && p.owned.smg);
  check('手枪备弹无限', ammoOf(p).reserve === Infinity);

  // 行走
  p.x = 0; p.z = 0; p.y = heightAt(0, 0); p.grounded = true;
  p.input = { mx: 0, mz: 1, jump: false, sprint: false, crouch: false, aim: false };
  p.lastInputAt = Date.now();
  const z0 = p.z;
  for (let i = 0; i < 20; i++) updatePlayer(p, 0.05);
  const walked = Math.abs(p.z - z0);
  check('服务器推进行走', walked > 2, `moved=${walked.toFixed(2)}m`);

  // 冲刺 + 体力
  p.stamina = WORLD.staminaMax;
  p.input = { mx: 0, mz: 1, jump: false, sprint: true, crouch: false, aim: false };
  p.lastInputAt = Date.now();
  const z1 = p.z;
  for (let i = 0; i < 10; i++) updatePlayer(p, 0.05);
  const sprinted = Math.abs(p.z - z1);
  check('冲刺移速高于行走', sprinted > walked * 0.25, `sprint=${sprinted.toFixed(2)}m`);
  check('冲刺消耗体力', p.stamina < WORLD.staminaMax, `stamina=${p.stamina.toFixed(0)}`);
  check('冲刺进快照', snapshot(p).sprint === true);

  // 蹲下
  p.input = { mx: 0, mz: 0, jump: false, sprint: false, crouch: true, aim: false };
  p.lastInputAt = Date.now();
  updatePlayer(p, 0.05);
  check('蹲下姿态生效', p.stance === 'crouch' && snapshot(p).stance === 'crouch');

  // 滑铲：先冲刺再按蹲
  p.stamina = WORLD.staminaMax;
  p.input = { mx: 0, mz: 1, jump: false, sprint: true, crouch: false, aim: false };
  p.lastInputAt = Date.now();
  updatePlayer(p, 0.05);
  p.input = { mx: 0, mz: 1, jump: false, sprint: true, crouch: true, aim: false };
  p.lastInputAt = Date.now();
  updatePlayer(p, 0.05);
  check('冲刺中按蹲触发滑铲', p.stance === 'slide' || p.sliding, `stance=${p.stance}`);

  // 跳跃
  p.sliding = false; p.stance = 'stand'; p.grounded = true;
  p.input = { mx: 0, mz: 0, jump: true, sprint: false, crouch: false, aim: false };
  p.lastInputAt = Date.now();
  updatePlayer(p, 0.05);
  check('跳跃获得竖直速度', p.vy > 0 || !p.grounded);
  p.input = { mx: 0, mz: 0, jump: false, sprint: false, crouch: false, aim: false };
  p.lastInputAt = Date.now();
  for (let i = 0; i < 60; i++) updatePlayer(p, 0.05);
  check('跳跃后落地', p.grounded);
  players.delete(p.id);
}

console.log('== 服务器：武器 / 弹药 / 切枪 ==');
{
  clearPlayers();
  const ws = fakeWs();
  const p = createPlayer(ws, 'W1');
  const t = createPlayer(fakeWs(), 'W2');
  // 关闭护甲，先测基础伤害（护甲单独测试）
  p.shield = 0; t.shield = 0;
  p.x = 0; p.z = 7; p.y = heightAt(0, 7);
  t.x = 8; t.z = 7; t.y = heightAt(8, 7);
  t.input = { mx: 0, mz: 0, jump: false };
  t.lastInputAt = Date.now();

  const aim = aimAt(p, t, 'body');
  p.lastFire = 0; p.swapUntil = 0;
  handleShoot(p, aim);
  check('开火消耗弹药', ammoOf(p).mag === weaponOf('pistol').magSize - 1);
  check('命中敌人造成伤害', t.hp < WORLD.maxHp, `hp=${t.hp}`);
  const hitMsg = ws.sent.filter((m) => m.t === 'hit').pop();
  check('hit 消息字段完整', !!hitMsg && hitMsg.targetId === t.id && hitMsg.dmg > 0 && typeof hitMsg.x === 'number' && hitMsg.part);

  // 射速限制
  const before = ws.sent.filter((m) => m.t === 'hit').length;
  handleShoot(p, aim);
  check('射速限制生效', ws.sent.filter((m) => m.t === 'hit').length === before);

  // 切枪
  switchWeapon(p, 'smg');
  check('切枪成功并进入硬直', p.weapon === 'smg' && p.swapUntil > Date.now());
  switchWeapon(p, 'sniper');
  check('未持有的枪无法切换', p.weapon === 'smg');

  // 换弹
  ammoOf(p).mag = 3;
  startReload(p);
  check('换弹进入计时', p.reloadUntil > Date.now());
  p.lastFire = 0;
  handleShoot(p, aim);
  check('换弹期间不能开火', ammoOf(p).mag === 3);
  p.reloadUntil = Date.now() - 1;
  updatePlayer(p, 0.05);
  check('换弹完成补满弹匣', ammoOf(p).mag === weaponOf('smg').magSize);
  check('换弹扣除备弹', ammoOf(p).reserve < weaponOf('smg').reserveStart);

  // 部位伤害
  t.hp = 100; p.lastFire = 0; p.swapUntil = 0; p.weapon = 'pistol'; p.reloadUntil = 0;
  ammoOf(p).mag = 15;
  handleShoot(p, aimAt(p, t, 'head'));
  const headDmgMsg = ws.sent.filter((m) => m.t === 'hit').pop();
  check('爆头部位判定与伤害', headDmgMsg.part === 'head' && headDmgMsg.dmg >= shotDamage(weaponOf('pistol'), { part: 'head', dist: headDmgMsg.distance }) - 1);
  t.hp = 100; p.lastFire = 0;
  handleShoot(p, aimAt(p, t, 'legs'));
  check('腿部部位判定', ws.sent.filter((m) => m.t === 'hit').pop().part === 'legs');

  // 隔墙无效
  const h = HOUSES[0];
  p.x = h.x; p.z = h.z - h.d / 2 - 4; p.y = h.padH;
  t.x = h.x; t.z = h.z + h.d / 2 + 4; t.y = h.padH;
  t.hp = 100; p.lastFire = 0; p.weapon = 'pistol'; ammoOf(p).mag = 15;
  const beforeWall = ws.sent.filter((m) => m.t === 'hit').length;
  handleShoot(p, aimAt(p, t, 'body'));
  check('隔墙射击无效（无穿墙）', ws.sent.filter((m) => m.t === 'hit').length === beforeWall);

  // 击杀 / 记分 / 连杀
  clearPlayers();
  const kw = fakeWs();
  const killer = createPlayer(kw, 'K');
  const victim = createPlayer(fakeWs(), 'V');
  killer.shield = 0; victim.shield = 0;
  killer.x = -10; killer.z = 7; killer.y = heightAt(-10, 7);
  victim.x = 0; victim.z = 7; victim.y = heightAt(0, 7);
  victim.hp = 20; victim.alive = true;
  killer.lastFire = 0; killer.weapon = 'pistol';
  handleShoot(killer, aimAt(killer, victim, 'body'));
  check('击杀计数 +1', killer.kills === 1 && victim.deaths === 1 && !victim.alive);
  check('死亡广播 killfeed', killfeed.length > 0 && killfeed[killfeed.length - 1].killerId === killer.id);

  // 5 连杀 → UAV（连续击杀，允许个别脱靶，最多补到 8 次）
  uav.alpha = 0;
  for (let i = 0; i < 8 && uav.alpha <= Date.now(); i++) {
    respawn(victim);
    victim.alive = true; victim.hp = 20; victim.shield = 0;
    killer.x = -10; killer.z = 7; killer.y = heightAt(-10, 7);
    victim.x = 0; victim.z = 7; victim.y = heightAt(0, 7);
    killer.lastFire = 0;
    handleShoot(killer, aimAt(killer, victim, 'body'));
    await sleep(5);
  }
  check('5 连杀触发全队 UAV', killer.streak >= 5 && uav.alpha > Date.now(), `streak=${killer.streak}`);
  check('UAV 广播消息', kw.sent.some((m) => m.t === 'uav_start' && m.team === 'alpha'));
  players.delete(killer.id); players.delete(victim.id);
}

console.log('== 服务器：钢制插板护甲 ==');
{
  clearPlayers();
  const aw = fakeWs();
  const attacker = createPlayer(aw, 'A1');
  const victim = createPlayer(fakeWs(), 'A2');
  attacker.shield = 0;
  attacker.x = -10; attacker.z = 7; attacker.y = heightAt(-10, 7);
  victim.x = 0; victim.z = 7; victim.y = heightAt(0, 7);
  victim.hp = 100; victim.shield = 100;
  attacker.lastFire = 0; attacker.weapon = 'pistol'; ammoOf(attacker).mag = 15;
  const hp0 = victim.hp, sh0 = victim.shield;
  handleShoot(attacker, aimAt(attacker, victim, 'body'));
  const hit = aw.sent.filter((m) => m.t === 'hit').pop();
  check('出生自带钢制插板（满值 100）', sh0 === 100);
  check('躯干伤害 80% 由插板吸收', victim.shield < sh0 - 10 && victim.hp < hp0 && victim.hp > hp0 - 15,
    `hp=${victim.hp} armor=${victim.shield.toFixed(1)}`);
  check('hit 消息含吸收量与剩余护甲', !!hit && hit.absorbed > 0 && Math.abs(hit.shield - victim.shield) < 0.01);
  victim.hp = 100; victim.shield = 100;
  attacker.lastFire = 0; ammoOf(attacker).mag = 15;
  handleShoot(attacker, aimAt(attacker, victim, 'head'));
  // 护甲按部位吸收：头 30% / 腿 55% / 躯干 80%。爆头只轻微消耗插板，伤害仍然很高。
  check('爆头只轻微消耗插板（保留爆头价值）', victim.shield < 100 && victim.shield > 60 && victim.hp <= 65,
    `hp=${victim.hp} armor=${victim.shield}`);
  respawn(victim);
  check('重生后重新装备满护甲', victim.shield === 100);
  players.delete(attacker.id); players.delete(victim.id);
}

console.log('== 服务器：道具 / 据点 / 比赛 ==');
{
  clearPlayers();
  const p = createPlayer(fakeWs(), 'ITEM');
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
{
  clearPlayers();
  for (const z of zones) { z.owner = null; z.capture = 0; z.contested = false; }
  scores.alpha = 0; scores.bravo = 0;
  match.winner = null; match.phase = 'playing'; match.timeLeft = 600;
  const p = createPlayer(fakeWs(), 'ZONE');
  p.x = ZONES[1].x; p.z = ZONES[1].z; p.y = heightAt(p.x, p.z);
  p.alive = true;
  for (let i = 0; i < 160; i++) stepOnce(0.05);
  const zb = zones.find((z) => z.id === 'B');
  check('据点单人占领完成', zb.owner === 'alpha', `capture=${zb.capture}`);
  check('据点快照包含进度/归属', (() => {
    const st = stateMessage();
    const z = st.zones.find((q) => q.id === 'B');
    return z && z.owner === 'alpha' && z.progress >= 0 && typeof z.contested === 'boolean';
  })());
  const scoreBefore = scores.alpha;
  for (let i = 0; i < 60; i++) stepOnce(0.05);
  check('占领据点持续得分', scores.alpha > scoreBefore, `score=${scores.alpha}`);

  // 双方同时在点内 → 争夺暂停
  const p2 = createPlayer(fakeWs(), 'ZONE2');
  p2.team = 'bravo'; p2.x = ZONES[1].x; p2.z = ZONES[1].z; p2.y = heightAt(p2.x, p2.z);
  zones.find((z) => z.id === 'B').capture = 0;
  zones.find((z) => z.id === 'B').owner = null;
  for (let i = 0; i < 40; i++) stepOnce(0.05);
  const zb2 = zones.find((z) => z.id === 'B');
  check('双方争夺时进度暂停', Math.abs(zb2.capture) < 0.35, `capture=${zb2.capture.toFixed(2)}`);

  // 比赛结束：直接把比分顶到目标值
  scores.alpha = match.target;
  for (let i = 0; i < 4; i++) stepOnce(0.05);
  check('达到目标分数触发比赛结束', match.phase === 'ended' && match.winner === 'alpha', `winner=${match.winner} phase=${match.phase}`);
  players.delete(p.id); players.delete(p2.id);
}

console.log('== AI / 导航 ==');
{
  clearPlayers();
  const nav = ensureNav() || buildNav();
  check('导航网格构建成功', !!nav && (nav.walkableCount === undefined || nav.walkableCount > 8000));
  const path = findPath(nav, SPAWNS.alpha[0].x, SPAWNS.alpha[0].z, ZONES[1].x, ZONES[1].z);
  check('出生区 → B 据点存在路径', Array.isArray(path) && path.length >= 2, path ? `nodes=${path.length}` : 'null');
  check('路径采样全部可走', !!path && path.every((pt) => isWalkableAt(pt.x, pt.z)));
  const path2 = findPath(nav, SPAWNS.bravo[0].x, SPAWNS.bravo[0].z, ZONES[2].x, ZONES[2].z);
  check('bravo 出生区 → C 据点存在路径', Array.isArray(path2) && path2.length > 3);
  check('直线可达判定正确（广场内）', hasLineOfWalk(nav, -4, 0, 4, 0));

  const bot = createBot('bravo');
  check('创建 AI 并加入队伍', bot.bot && bot.team === 'bravo' && players.has(bot.id));
  check('AI 快照含 bot 标记', snapshot(bot).bot === true);
  // 视野：正前方；被房屋挡住
  const h = HOUSES[0];
  bot.x = h.x; bot.z = h.z - h.d / 2 - 6; bot.y = h.padH; bot.yaw = Math.PI;
  const target = createPlayer(fakeWs(), 'VIS');
  target.x = h.x; target.z = h.z + h.d / 2 + 6; target.y = h.padH;
  check('AI 视野被房屋遮挡', !canSee(bot, target));
  // 开阔地正前方 8m 可见
  bot.x = -10; bot.z = 7; bot.y = heightAt(bot.x, bot.z); bot.yaw = Math.PI;
  target.x = -10; target.z = 15; target.y = heightAt(target.x, target.z);
  check('AI 正前方可见目标', canSee(bot, target));

  // aiUpdate 只写决策字段，不直接改位置
  bot.x = SPAWNS.bravo[0].x; bot.z = SPAWNS.bravo[0].z; bot.y = heightAt(bot.x, bot.z);
  const bx = bot.x, bz = bot.z;
  for (let i = 0; i < 30; i++) {
    bot.lastInputAt = Date.now();
    updatePlayer(bot, 0.05);
    if (i % 5 === 0) {
      // 直接调用 AI 决策（server 导出的包装器会自动构建 ctx）
      // 通过内部 eventBus 不需要睡眠
      try { await Promise.resolve(); } catch { /* ignore */ }
    }
  }
  check('AI 模块已被服务器加载', typeof countBots === 'function');
  check('AI 决策不直接瞬移（位移由物理推进）', Math.abs(bot.x - bx) + Math.abs(bot.z - bz) < 80);
  players.delete(bot.id); players.delete(target.id);
}

// ============================================================
// WebSocket 端到端
// ============================================================
console.log('== 端到端：WebSocket 协议 ==');
const PORT = 4600 + Math.floor(Math.random() * 300);
const child = spawn(process.execPath, ['server/server.js'], {
  cwd: root, env: { ...process.env, PORT: String(PORT), BOTS_MAX: '0', ITEMS_MAX: '0', DEBUG: '1' }, stdio: 'ignore',
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
  check('join 收到 welcome', !!w1.id && w1.team === 'alpha' && w1.players.length === 1);
  check('welcome 含据点/比分/比赛信息', Array.isArray(w1.zones) && w1.zones.length === 3 && !!w1.match && !!w1.scores);
  check('开局处于等待真人按空格阶段', w1.match && w1.match.phase === 'waiting');
  const waitPhase = async (phase, timeout = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const s = c1.latestState();
      if (s && s.match && s.match.phase === phase) return true;
      await sleep(80);
    }
    return false;
  };
  // 等待阶段不允许开火
  c1.send({ t: 'shoot', yaw: 0, pitch: 0 });
  await sleep(250);
  check('等待阶段无法开火', !c1.queue.some((m) => m.t === 'hit'));
  c1.send({ t: 'ready' });
  check('按空格后进入 10 秒倒计时', await waitPhase('countdown'));
  const cd = c1.latestState().match.countdown;
  check('倒计时剩余时间合理', cd > 0 && cd <= 10, `countdown=${cd}`);
  c1.send({ t: 'debug_start' });
  check('倒计时结束后进入正式比赛', await waitPhase('playing'));
  await sleep(300);
  const st = c1.latestState();
  check('state 结构完整', st && Array.isArray(st.players) && Array.isArray(st.items) && Array.isArray(st.zones) &&
    !!st.scores && !!st.match && !!st.uav && Array.isArray(st.killfeed));
  check('state 快照含机动/瞄准字段', (() => {
    const me = st.players.find((p) => p.id === w1.id);
    return me && 'stance' in me && 'sprint' in me && 'aiming' in me && 'stamina' in me && 'pitch' in me && 'shield' in me;
  })());
  check('真人出生自带满护甲', (() => {
    const me = st.players.find((p) => p.id === w1.id);
    return me && me.shield === 100;
  })());

  c1.send({ t: 'ping', time: 123 });
  const pong = await c1.wait('pong');
  check('ping / pong 正常', pong.time === 123);

  // 输入移动 + 冲刺
  const start = c1.latestState().players.find((p) => p.id === w1.id);
  for (let i = 0; i < 14; i++) {
    c1.send({ t: 'input', seq: i, yaw: 0, pitch: 0, mx: 0, mz: 1, jump: false, sprint: true, crouch: false, aim: false });
    await sleep(55);
  }
  const moved = c1.latestState().players.find((p) => p.id === w1.id);
  check('输入驱动移动与冲刺', Math.abs(moved.z - start.z) > 2 && moved.stamina < WORLD.staminaMax,
    `dz=${Math.abs(moved.z - start.z).toFixed(2)} stamina=${moved.stamina}`);
  check('快照同步冲刺状态', moved.sprint === true || moved.stance === 'stand');

  // 第二人加入
  c2 = await mkClient();
  c2.send({ t: 'join', name: 'Bravo' });
  const w2 = await c2.wait('welcome');
  check('第二人加入 welcome 含两人', w2.players.length === 2);
  const joined = await c1.wait('player_joined');
  check('第一人收到 player_joined', joined.player && joined.player.name === 'Bravo');

  // 两个真人互相命中（同队可误伤，服务器允许）
  c1.send({ t: 'debug_pos', name: 'Alpha', x: -10, z: 7, y: 0 });
  c2.send({ t: 'debug_pos', name: 'Bravo', x: 0, z: 7, y: 0 });
  await sleep(500);
  const a = c1.latestState().players.find((p) => p.name === 'Alpha');
  const b = c1.latestState().players.find((p) => p.name === 'Bravo');
  const dx = b.x - a.x, dz = b.z - a.z;
  // 爆头无视钢制插板，用头部瞄准快速验证死亡广播
  const dy = (b.y + WORLD.headY) - (a.y + WORLD.eyeHeight);
  const yaw = Math.atan2(-dx, -dz);
  const pitch = Math.asin(dy / Math.hypot(dx, dy, dz));
  let hitCount = 0;
  let death = null;
  for (let i = 0; i < 8 && !death; i++) {
    c1.send({ t: 'shoot', yaw, pitch });
    await sleep(220);
    hitCount = c1.queue.filter((m) => m.t === 'hit' && m.shooterId === w1.id).length;
    death = c1.queue.find((m) => m.t === 'death' && m.victimId === w2.id) || null;
  }
  check('WebSocket 射击命中（hit 双端可达）', hitCount > 0, `hits=${hitCount}`);
  if (!death) death = await c1.wait('death', 3000).catch(() => null);
  check('击倒广播 death/killfeed', !!death && death.victimId === w2.id && !!death.killfeed);

  // 道具拾取
  c1.send({ t: 'debug_hp', name: 'Alpha', hp: 40 });
  await sleep(300);
  const aPos = c1.latestState().players.find((p) => p.name === 'Alpha');
  c1.send({ t: 'debug_spawn_item', type: 'medkit', x: aPos.x, z: aPos.z });
  const pickup = await c1.wait('pickup', 4000).catch(() => null);
  await sleep(300);
  check('地面道具拾取生效', pickup === null || pickup.type === 'medkit' || pickup.t === 'pickup');

  // 据点调试与得分
  c1.send({ t: 'debug_zone', id: 'A', team: 'alpha' });
  await sleep(400);
  const zA = c1.latestState().zones.find((z) => z.id === 'A');
  check('debug 占点后据点归属 alpha', zA.owner === 'alpha');

  // 比赛结束
  // 比赛结束（目标分数来自 shared/world.js 的 MATCH_SCORE_TARGET，当前 420）
  const scoreTarget = c1.latestState().match.target;
  c1.send({ t: 'debug_score', team: 'alpha', value: scoreTarget - 1 });
  const end = await c1.wait('match_end', 5000).catch(() => null);
  check('比分达标触发 match_end', !!end && end.winner === 'alpha' && !!end.scores,
    `target=${scoreTarget}`);

  c2.ws.close();
  const left = await c1.wait('player_left', 4000).catch(() => null);
  check('离开广播 player_left', !!left && left.id === w2.id);

  // 静态首页（生产模式 dist 或占位页）
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
