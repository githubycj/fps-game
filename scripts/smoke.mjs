// ===== 冒烟测试：服务器逻辑单元测试 + WebSocket 端到端测试 =====
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { WORLD, TERRAIN, SPAWNS, BOTS, stepPlayerPhysics, circleOverlapsBox } from '../shared/map.js';
import { WEAPONS, weaponOf, shotDamage, STARTING_WEAPONS } from '../shared/weapons.js';
import {
  createPlayer, createBot, handleShoot, updatePlayer, aiUpdate, canSee, snapshot,
  spawnItem, applyItem, items, players, startReload, switchWeapon, grantWeapon, ammoOf,
} from '../server/server.js';

const PISTOL = weaponOf('pistol');
const RIFLE = weaponOf('ak47');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4000 + Math.floor(Math.random() * 500);
const results = [];
function check(name, cond) {
  results.push([name, !!cond]);
  console.log((cond ? '  ✓ ' : '  ✗ ') + name);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeWs = () => ({ readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); } });

// ---------- 单元测试：地形物理（120×120 大图） ----------
console.log('== 单元测试：地形与碰撞 ==');
{
  const b1 = { x: 0, y: 0, z: 0, vy: 0, grounded: false };
  b1.x += WORLD.moveSpeed * 0.05;
  stepPlayerPhysics(b1, 0.05);
  const arena = TERRAIN[0];
  check('中心擂台水平推挤', !circleOverlapsBox(b1.x, b1.z, WORLD.playerRadius, arena) && Math.abs(b1.x) > 6);

  // 跳上 0.5 平台（(0,-45) 平台）
  const plat = TERRAIN.find((o) => o.kind === 'platform' && o.h === 0.5 && o.x === 0 && o.z === -45);
  let landed = false;
  {
    const b = { x: 0, y: 0, z: -42.5, vy: WORLD.jumpSpeed, grounded: false };
    let over = false;
    for (let i = 0; i < 80; i++) {
      if (!over && b.z <= -43.5 && b.z >= -46.5) over = true;
      if (!over) b.z -= WORLD.moveSpeed * 0.05;
      stepPlayerPhysics(b, 0.05);
      if (b.grounded && Math.abs(b.y - plat.h) < 0.01) { landed = true; break; }
    }
  }
  check('跳上 0.5 平台并站立', landed);

  // 跳上中央擂台（1.2m，12×12，从东侧起跳）
  const arenaBox = TERRAIN.find((o) => o.kind === 'arena');
  let landedArena = false;
  {
    const b = { x: 7.5, y: 0, z: 0, vy: WORLD.jumpSpeed, grounded: false };
    let over = false;
    for (let i = 0; i < 80; i++) {
      if (!over && b.y >= arenaBox.h - 0.001 && b.x <= arenaBox.x + arenaBox.w / 2) over = true;
      if (!over) b.x -= WORLD.moveSpeed * 0.05;
      stepPlayerPhysics(b, 0.05);
      if (b.grounded && Math.abs(b.y - arenaBox.h) < 0.01) { landedArena = true; break; }
    }
  }
  check('跳上中央擂台（1.2m）', landedArena);

  let fell = false;
  {
    const b = { x: 0, y: 1.2, z: 0, vy: 0, grounded: true };
    for (let i = 0; i < 400 && b.y > 0.01; i++) {
      b.z += WORLD.moveSpeed * 0.05;
      stepPlayerPhysics(b, 0.05);
    }
    fell = b.y === 0 && b.grounded;
  }
  check('走出平台边缘会掉落', fell);

  let stays = true;
  {
    const b = { x: 0, y: 1.2, z: 0, vy: 0, grounded: true };
    for (let i = 0; i < 6; i++) {
      b.x += WORLD.moveSpeed * 0.05;
      stepPlayerPhysics(b, 0.05);
      if (b.y < 1.19 || !b.grounded) stays = false;
    }
  }
  check('站在箱顶不被推开', stays);

  let wallX = 0;
  {
    const b = { x: 0, y: 0, z: -24, vy: 0, grounded: true };
    for (let i = 0; i < 140; i++) {
      b.x += WORLD.moveSpeed * 0.05;
      stepPlayerPhysics(b, 0.05);
    }
    wallX = b.x;
  }
  check('边界墙阻挡（约 58.95）', Math.abs(wallX - 58.95) < 0.1);

  let allClear = true;
  for (const s of SPAWNS) {
    for (const o of TERRAIN) {
      if (circleOverlapsBox(s.x, s.z, WORLD.playerRadius, o)) allClear = false;
    }
  }
  check('所有出生点不与地形重叠', allClear);
}

// ---------- 单元测试：射击 / 击倒 / 重生（开阔车道 z=7） ----------
console.log('== 单元测试：战斗逻辑 ==');
{
  const wa = fakeWs(), wb = fakeWs();
  const a = createPlayer(wa, 'A');
  const b = createPlayer(wb, 'B');
  a.x = -10; a.z = 7; b.x = 10; b.z = 7;   // 20m：处于手枪无衰减射程内

  const dx = b.x - a.x, dy = (b.y + WORLD.bodyY) - (a.y + WORLD.eyeHeight), dz = b.z - a.z;
  const dist = Math.hypot(dx, dy, dz);
  const yaw = Math.atan2(-dx, -dz);
  const pitch = Math.asin(dy / dist);
  const bodyDmg = shotDamage(PISTOL, { part: 'body', dist });
  const headDmg = shotDamage(PISTOL, { part: 'head', dist });

  handleShoot(a, { yaw, pitch });
  check(`身体命中掉 ${bodyDmg}（手枪基础伤害）`, b.hp === WORLD.maxHp - bodyDmg);
  check('hit 消息带 body 与命中点', wa.sent.some((m) => m.t === 'hit' && m.part === 'body' && m.dmg === bodyDmg && typeof m.x === 'number'));

  const dyHead = (b.y + WORLD.headY) - (a.y + WORLD.eyeHeight);
  const headPitch = Math.asin(dyHead / Math.hypot(dx, dyHead, dz));
  a.lastFire = 0; a.burst = 0;
  handleShoot(a, { yaw, pitch: headPitch });
  check(`爆头掉 ${headDmg}（part=head）`, b.hp === WORLD.maxHp - bodyDmg - headDmg);

  b.hp = WORLD.maxHp;
  for (let i = 0; i < 5; i++) { a.lastFire = 0; a.burst = 0; handleShoot(a, { yaw, pitch }); }
  check('5 枪身体击倒（血量归零）', b.hp === 0 && !b.alive);
  check('广播 death 事件', wa.sent.some((m) => m.t === 'death' && m.id === b.id && m.killerId === a.id));

  const before = wa.sent.filter((m) => m.t === 'hit').length;
  a.lastFire = 0;
  handleShoot(a, { yaw, pitch });
  check('射速限制生效', wa.sent.filter((m) => m.t === 'hit').length === before);

  b.respawnAt = Date.now() - 10;
  updatePlayer(b, 0.05);
  check('死亡后自动重生', b.alive && b.hp === WORLD.maxHp && b.weapon === 'pistol');

  const c = createPlayer(fakeWs(), 'C');
  c.x = 0; c.z = -24; c.yaw = 0;
  c.input = { mx: 1, mz: 1, jump: false };
  c.lastInputAt = Date.now();
  const px = c.x, pz = c.z;
  updatePlayer(c, 0.05);
  const moved = Math.hypot(c.x - px, c.z - pz);
  check('移动速度被钳制', moved <= WORLD.moveSpeed * 0.05 + 0.02);

  players.delete(a.id); players.delete(b.id); players.delete(c.id);
}

// ---------- 单元测试：AI 对手（友军/敌军） ----------
console.log('== 单元测试：AI 对手 ==');
{
  const bot = createBot('enemy');
  check('AI 生成且带队伍/武器标志', bot.bot && bot.name.startsWith('AI-') && bot.team === 'enemy' && players.has(bot.id));
  check('快照含 bot/team/weapon', snapshot(bot).bot === true && snapshot(bot).team === 'enemy' && snapshot(bot).weapon === 'pistol');
  const bx = bot.x, bz = bot.z;
  aiUpdate(bot, Date.now());
  updatePlayer(bot, 0.05);
  check('AI 决策驱动移动', Math.abs(bot.x - bx) + Math.abs(bot.z - bz) > 0.001 || !bot.grounded || bot.input.mz > 0);
  players.delete(bot.id);

  // 视野：前方 10m 可见
  const b1 = createBot('enemy');
  const q1 = createPlayer(fakeWs(), 'F');
  b1.x = 0; b1.z = 7; b1.y = 0; b1.yaw = Math.PI; // 面朝 +Z
  q1.x = 0; q1.z = 17; q1.y = 0;
  check('视野：前方 10m 可见', canSee(b1, q1));
  let hitFront = false;
  for (let i = 0; i < 40 && !hitFront; i++) {
    b1.lastFire = 0; b1.nextFireAt = 0;
    aiUpdate(b1, Date.now() + i * 250);
    hitFront = q1.hp < WORLD.maxHp;
  }
  check('前方可见时 AI 会开火打伤', hitFront);
  players.delete(b1.id); players.delete(q1.id);

  // 视野：背后（160° 视锥外）不可见
  const b2 = createBot('enemy');
  const q2 = createPlayer(fakeWs(), 'B');
  b2.x = 0; b2.z = 7; b2.y = 0; b2.yaw = Math.PI;
  q2.x = 0; q2.z = -8; q2.y = 0; // 背后
  check('视野：背后（视锥外）不可见', !canSee(b2, q2));

  // 视野：30m 超出半径不可见
  const b3 = createBot('enemy');
  const q3 = createPlayer(fakeWs(), 'R');
  b3.x = 0; b3.z = 7; b3.y = 0; b3.yaw = Math.PI;
  q3.x = 0; q3.z = 35; q3.y = 0;
  check('视野：30m 超出半径不可见', !canSee(b3, q3));

  // 视野：被中央擂台遮挡不可见（b4 在擂台北侧面朝 -Z，q4 在南侧）
  const b4 = createBot('enemy');
  const q4 = createPlayer(fakeWs(), 'W');
  b4.x = 0; b4.z = -9; b4.y = 0; b4.yaw = Math.PI; // 面朝 +Z（擂台在中间）
  q4.x = 0; q4.z = 9; q4.y = 0;
  check('视野：被中央擂台遮挡不可见', !canSee(b4, q4));
  players.delete(b2.id); players.delete(q2.id);
  players.delete(b3.id); players.delete(q3.id);
  players.delete(b4.id); players.delete(q4.id);

  // 敌军能射击命中真人（伤害减半）
  const bot2 = createBot('enemy');
  const pl2 = createPlayer(fakeWs(), 'Q');
  bot2.x = -10; bot2.z = 7; bot2.y = 0;
  pl2.x = 0; pl2.z = 7; pl2.y = 0;
  const dx = pl2.x - bot2.x, dz = pl2.z - bot2.z;
  const dy = (pl2.y + WORLD.bodyY) - (bot2.y + WORLD.eyeHeight);
  const d = Math.hypot(dx, dy, dz);
  bot2.lastFire = 0; bot2.burst = 0;
  handleShoot(bot2, { yaw: Math.atan2(-dx, -dz), pitch: Math.asin(dy / d) });
  const botDmg = Math.max(1, Math.round(shotDamage(PISTOL, { part: 'body', dist: d }) * BOTS.damageMult));
  check(`敌军 AI 能射击命中真人（伤害减半 = ${botDmg}）`, pl2.hp === WORLD.maxHp - botDmg);
  players.delete(bot2.id); players.delete(pl2.id);
}

console.log('== 单元测试：地面道具与武器 ==');
{
  const pl = createPlayer(fakeWs(), 'P');
  pl.x = 0; pl.z = 0; pl.y = 0;

  // 急救包回满血
  pl.hp = 30;
  const it1 = spawnItem('medkit');
  it1.x = pl.x + 1; it1.z = pl.z;
  applyItem(pl, it1);
  check('急救包回满血', pl.hp === WORLD.maxHp);

  // AK47 切换武器
  const it2 = spawnItem('ak47');
  it2.x = pl.x + 1; it2.z = pl.z;
  applyItem(pl, it2);
  check('拾取 AK47 切换武器', pl.weapon === 'ak47');
  check('快照带 weapon=ak47', snapshot(pl).weapon === 'ak47');

  // 道具在 items 集合中
  const it3 = spawnItem('medkit');
  check('道具生成并进入 items', items.has(it3.id) && it3.type === 'medkit');

  // 射速：AK47 100ms 间隔可开火，手枪 100ms 被拒
  const tg = createPlayer(fakeWs(), 'T');
  tg.x = pl.x + 20; tg.z = pl.z; tg.y = 0;
  const tgYaw = Math.atan2(-(tg.x - pl.x), -(tg.z - pl.z));
  const tgDy = (tg.y + WORLD.bodyY) - (pl.y + WORLD.eyeHeight);
  const tgPitch = Math.asin(tgDy / Math.hypot(20, tgDy, 0));
  pl.weapon = 'ak47';
  pl.swapUntil = 0;   // 跳过拾取后的切枪硬直
  pl.lastFire = Date.now() - 100;
  handleShoot(pl, { yaw: tgYaw, pitch: tgPitch });
  const akAccepted = (Date.now() - pl.lastFire) < 90;
  check('AK47 射速更快（100ms 间隔可开火）', akAccepted);
  pl.weapon = 'pistol';
  pl.lastFire = Date.now() - 100;
  handleShoot(pl, { yaw: tgYaw, pitch: tgPitch });
  const pistolRejected = (Date.now() - pl.lastFire) > 95;
  check('手枪射速较慢（100ms 间隔被拒）', pistolRejected);

  players.delete(pl.id); players.delete(tg.id);
  for (const id of [...items.keys()]) items.delete(id);
}

// ---------- 单元测试：武器系统（弹药 / 换弹 / 切枪 / 衰减 / 霰弹） ----------
console.log('== 单元测试：武器系统 ==');
{
  const ws = fakeWs();
  const p = createPlayer(ws, 'WPN');
  const t = createPlayer(fakeWs(), 'TGT');
  p.x = 0; p.z = 0; p.y = 0;
  t.x = 8; t.z = 0; t.y = 0;
  const aimAt = (from, to) => {
    const ddx = to.x - from.x, ddz = to.z - from.z;
    const ddy = (to.y + WORLD.bodyY) - (from.y + WORLD.eyeHeight);
    return { yaw: Math.atan2(-ddx, -ddz), pitch: Math.asin(ddy / Math.hypot(ddx, ddy, ddz)) };
  };

  check('开局持有手枪与冲锋枪', !!p.owned.pistol && !!p.owned.smg && p.weapon === 'pistol');
  check('初始弹匣已满', ammoOf(p).mag === PISTOL.magSize);
  check('手枪备弹无限', ammoOf(p).reserve === Infinity);
  const snap0 = snapshot(p);
  check('快照带弹药与持有列表', snap0.ammo.mag === PISTOL.magSize && snap0.ammo.reserve === -1 && snap0.owned.includes('smg'));
  check('每把枪数值完整', Object.values(WEAPONS).every((w) => w.damage > 0 && w.magSize > 0 && w.fireInterval > 0 && w.reloadTime > 0 && w.range > 0));

  // 切枪
  switchWeapon(p, 'smg');
  check('切枪生效并进入硬直', p.weapon === 'smg' && p.swapUntil > Date.now());
  switchWeapon(p, 'sniper');
  check('未持有的武器无法切换', p.weapon === 'smg');
  const aimT = aimAt(p, t);
  handleShoot(p, { ...aimT });
  check('切枪硬直期间无法开火', ammoOf(p).mag === weaponOf('smg').magSize);

  // 开火消耗弹药
  p.swapUntil = 0; p.lastFire = 0; p.burst = 0;
  handleShoot(p, { ...aimT });
  check('开火消耗弹药', ammoOf(p).mag === weaponOf('smg').magSize - 1);

  // 换弹：开始 → 期间禁止开火 → 完成补弹
  startReload(p);
  check('换弹进入计时', p.reloadUntil > Date.now());
  p.lastFire = 0;
  handleShoot(p, { ...aimT });
  check('换弹期间无法开火', ammoOf(p).mag === weaponOf('smg').magSize - 1);
  p.reloadUntil = Date.now() - 1;
  updatePlayer(p, 0.05);
  check('换弹完成补满弹匣并扣备弹',
    ammoOf(p).mag === weaponOf('smg').magSize &&
    ammoOf(p).reserve === weaponOf('smg').reserveStart - 1);

  // 打空弹匣 → 空枪 + 自动换弹
  const magBefore = ammoOf(p).mag;
  for (let i = 0; i <= magBefore; i++) { p.lastFire = 0; p.burst = 0; handleShoot(p, { ...aimT }); }
  check('打空弹匣后自动换弹', ammoOf(p).mag === 0 && p.reloadUntil > 0);
  check('空枪发出 dry_fire 提示', ws.sent.some((m) => m.t === 'dry_fire'));

  // 霰弹枪：拾取 + 多弹丸
  p.reloadUntil = 0; p.swapUntil = 0;
  grantWeapon(p, 'shotgun');
  check('拾取霰弹枪后持有并切换',
    p.weapon === 'shotgun' && !!p.owned.shotgun && ammoOf(p).mag === weaponOf('shotgun').magSize);
  const near = createPlayer(fakeWs(), 'NEAR');
  p.x = 0; p.z = 7; p.y = 0;             // 开阔车道，避开中央擂台
  near.x = 3; near.z = 7; near.y = 0;    // 3m 贴脸
  p.swapUntil = 0; p.lastFire = 0; p.burst = 0;
  handleShoot(p, { ...aimAt(p, near) });
  const pelletsHit = ws.sent.filter((m) => m.t === 'hit' && m.targetId === near.id).pop();
  check('霰弹枪一次开火多弹丸命中', !!pelletsHit && pelletsHit.pellets > 1);
  check('霰弹枪贴脸可一发击倒', near.hp === 0 && !near.alive);

  // 距离伤害衰减
  const nearDmg = shotDamage(RIFLE, { part: 'body', dist: 10 });
  const farDmg = shotDamage(RIFLE, { part: 'body', dist: 90 });
  check('近距离不吃衰减', nearDmg === RIFLE.damage);
  check('远距离伤害衰减', farDmg < nearDmg && farDmg === Math.round(RIFLE.damage * RIFLE.falloffMin));
  check('爆头倍率生效', shotDamage(RIFLE, { part: 'head', dist: 10 }) > nearDmg);

  players.delete(p.id); players.delete(t.id); players.delete(near.id);
}

// ---------- 单元测试：瞄准 / 护盾 / 加速 / 计分 ----------
console.log('== 单元测试：瞄准与道具效果 ==');
{
  // 瞄准减速
  const p1 = createPlayer(fakeWs(), 'AIM');
  p1.x = 0; p1.z = -24; p1.yaw = 0;
  p1.aiming = true;
  p1.input = { mx: 0, mz: 1, jump: false };
  p1.lastInputAt = Date.now();
  const z0 = p1.z;
  updatePlayer(p1, 0.05);
  const movedAim = Math.abs(p1.z - z0);
  check('瞄准时移速降低（约 0.55 倍）', Math.abs(movedAim - WORLD.moveSpeed * WORLD.aimSpeedMult * 0.05) < 0.02);
  players.delete(p1.id);

  // 加速道具
  const p2 = createPlayer(fakeWs(), 'SPD');
  p2.x = 0; p2.z = -24; p2.yaw = 0;
  p2.speedUntil = Date.now() + WORLD.speedBoostMs;
  p2.input = { mx: 0, mz: 1, jump: false };
  p2.lastInputAt = Date.now();
  const z1 = p2.z;
  updatePlayer(p2, 0.05);
  const movedBoost = Math.abs(p2.z - z1);
  check('加速道具提升移速（约 1.5 倍）', Math.abs(movedBoost - WORLD.moveSpeed * WORLD.speedBoostMult * 0.05) < 0.02);
  players.delete(p2.id);

  // 护盾吸收伤害
  const wa = fakeWs();
  const att = createPlayer(wa, 'ATK');
  const def = createPlayer(fakeWs(), 'DEF');
  att.x = -10; att.z = 7; def.x = 0; def.z = 7;
  def.shield = WORLD.shieldMax;
  const dx = def.x - att.x, dz = def.z - att.z;
  const dy = (def.y + WORLD.bodyY) - (att.y + WORLD.eyeHeight);
  const d = Math.hypot(dx, dy, dz);
  att.lastFire = 0;
  handleShoot(att, { yaw: Math.atan2(-dx, -dz), pitch: Math.asin(dy / d) });
  check('护盾优先吸收伤害', def.shield < WORLD.shieldMax && def.hp === WORLD.maxHp);
  players.delete(att.id); players.delete(def.id);
}

// ---------- 单元测试：计分与连杀 ----------
console.log('== 单元测试：计分与连杀 ==');
{
  const wk = fakeWs(), wv = fakeWs();
  const killer = createPlayer(wk, 'K');
  const victim = createPlayer(wv, 'V');
  killer.x = -10; killer.z = 7;
  victim.x = 0; victim.z = 7;
  const dx = victim.x - killer.x, dz = victim.z - killer.z;
  const dy = (victim.y + WORLD.bodyY) - (killer.y + WORLD.eyeHeight);
  const d = Math.hypot(dx, dy, dz);
  const yaw = Math.atan2(-dx, -dz);
  const pitch = Math.asin(dy / d);

  victim.hp = WORLD.damage; // 一枪可击倒
  killer.lastFire = 0;
  handleShoot(killer, { yaw, pitch });
  check('击杀计数 +1', killer.kills === 1);
  check('死亡计数 +1', victim.deaths === 1);
  check('连杀计数 =1', killer.streak === 1);

  // 第二次击杀 → 连杀 2 并广播
  const victim2 = createPlayer(fakeWs(), 'V2');
  victim2.x = 0; victim2.z = 7; victim2.hp = WORLD.damage;
  killer.x = -10; killer.z = 7;
  const dx2 = victim2.x - killer.x, dz2 = victim2.z - killer.z;
  const dy2 = (victim2.y + WORLD.bodyY) - (killer.y + WORLD.eyeHeight);
  const d2 = Math.hypot(dx2, dy2, dz2);
  killer.lastFire = 0;
  handleShoot(killer, { yaw: Math.atan2(-dx2, -dz2), pitch: Math.asin(dy2 / d2) });
  check('连杀计数累加 =2', killer.streak === 2);
  check('广播 streak 连杀消息', wk.sent.some((m) => m.t === 'streak' && m.streak === 2));
  players.delete(killer.id); players.delete(victim.id); players.delete(victim2.id);
}

// ---------- 端到端测试：WebSocket ----------
console.log('== 端到端测试：WebSocket ==');
const server = spawn(process.execPath, ['server/server.js'], {
  cwd: root, env: { ...process.env, PORT: String(PORT), BOTS_MAX: '0', ITEMS_MAX: '0' }, stdio: 'pipe',
});
let childErr = '';
server.stderr.on('data', (d) => { childErr += d.toString(); });
server.on('exit', (code) => { if (code !== null && code !== 0) console.log('[child server exit]', code, childErr.slice(0, 500)); });

function mkClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const queue = [];
    const waits = [];
    let lastState = null;
    ws.on('open', () => resolve({
      ws,
      send: (o) => ws.send(JSON.stringify(o)),
      wait: (t, timeout = 4000) => {
        const i = queue.findIndex((m) => m.t === t);
        if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
        return new Promise((res, rej) => {
          const w = { t, resolve: res };
          waits.push(w);
          setTimeout(() => { const j = waits.indexOf(w); if (j >= 0) waits.splice(j, 1); rej(new Error('等待 ' + t + ' 超时')); }, timeout);
        });
      },
      latestState: () => lastState,
    }));
    ws.on('error', reject);
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t === 'state') lastState = m;
      const idx = waits.findIndex((w) => w.t === m.t);
      if (idx >= 0) { const w = waits.splice(idx, 1)[0]; w.resolve(m); }
      else queue.push(m);
    });
  });
}

await sleep(700);
let c1, c2;
try {
  c1 = await mkClient();
  c1.send({ t: 'join', name: 'Alpha' });
  const w1 = await c1.wait('welcome');
  check('加入后收到 welcome', !!w1.id && w1.players.length === 1);

  c2 = await mkClient();
  c2.send({ t: 'join', name: 'Beta' });
  const w2 = await c2.wait('welcome');
  check('第二人收到 welcome（含两人）', w2.players.length === 2);
  const jb = await c1.wait('player_joined');
  check('第一人收到 player_joined', jb.player && jb.player.name === 'Beta');

  c1.send({ t: 'ping', time: 123 });
  const pong = await c1.wait('pong');
  check('ping/pong 正常', pong.time === 123);

  for (let i = 0; i < 10 && !c1.latestState(); i++) await sleep(50);
  const startX = c1.latestState().players.find((p) => p.id === w1.id).x;
  for (let i = 0; i < 10; i++) {
    c1.send({ t: 'input', seq: i, yaw: 0, pitch: 0, mx: 1, mz: 0, jump: false });
    await sleep(50);
  }
  const nowX = c1.latestState().players.find((p) => p.id === w1.id).x;
  check('输入驱动移动（X 增加）', nowX - startX > 1.2);

  c2.ws.close();
  const pl2 = await c1.wait('player_left');
  check('离开广播 player_left', pl2.id === w2.id);

  const res = await fetch(`http://127.0.0.1:${PORT}/`);
  const text = await res.text();
  check('生产模式静态页面可访问', res.status === 200 && text.length > 0);
} finally {
  if (c1) c1.ws.close();
  if (c2) c2.ws.close();
  server.kill();
}

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n结果：${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);