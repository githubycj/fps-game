// ===== 浏览器端到端测试：加入/点击进入 → 无空气墙 → 跳擂台 → 爆头 → 击杀 → 重生 → AI 出现移动 → FPS =====
// 断言基于服务器权威位置（serverPos），不受客户端渲染帧率/后台标签节流影响。
// 依赖：机器上已安装 Chrome，且可解析 playwright。
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { weaponOf, shotDamage } from '../shared/weapons.js';

const PISTOL = weaponOf('pistol');
const DUEL_DIST = 12;   // 近距离对决：手枪无衰减射程内，腰射散布可控
const HEAD_DMG = shotDamage(PISTOL, { part: 'head', dist: DUEL_DIST });

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = process.env.SHOT_DIR || root;
const PORT = 4000 + Math.floor(Math.random() * 500);

let require2;
const localPw = path.join(root, 'node_modules', 'playwright', 'package.json');
if (fs.existsSync(localPw)) require2 = createRequire(localPw);
else {
  const runtime = 'C:/Users/abcde/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json';
  if (fs.existsSync(runtime)) require2 = createRequire(runtime);
  else { console.error('未找到 playwright，请先 npm i -D playwright 或使用 Codex 运行时'); process.exit(1); }
}
const { chromium } = require2('playwright');

// 确定性阶段关闭自动 AI，之后用 debug_spawn_bot 手动生成
const srv = spawn(process.execPath, ['server/server.js'], {
  cwd: root, env: { ...process.env, PORT: String(PORT), DEBUG: '1', BOTS_MAX: '0' }, stdio: 'pipe',
});
srv.stderr.on('data', (d) => process.stdout.write('[srv err] ' + d.toString().trim() + '\n'));
await new Promise((r) => setTimeout(r, 700));

const errors = [];
const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-webgl'],
});
const results = [];
const check = (n, ok) => { results.push([n, ok]); console.log((ok ? '  ✓ ' : '  ✗ ') + n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newPlayer(name) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => errors.push(name + ' pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(name + ' console: ' + m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.fill('#nick', name);
  await page.click('#joinBtn');
  await page.waitForSelector('#hud:not(.hidden)', { timeout: 8000 });
  await page.waitForTimeout(600);
  return page;
}
const readPlayer = (page) => page.evaluate(() => window.__game.player);
const listRemotes = (page) => page.evaluate(() => window.__game.remotes || []);

const dbg = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise((r) => dbg.on('open', r));
async function teleportTo(page, name, x, z, ty = 0) {
  for (let attempt = 0; attempt < 16; attempt++) {
    dbg.send(JSON.stringify({ t: 'debug_pos', name, x, z, y: ty }));
    for (let i = 0; i < 8; i++) {
      const p = await readPlayer(page);
      if (p && p.sx !== null && Math.abs(p.sx - x) < 0.8 && Math.abs(p.sz - z) < 0.8 && Math.abs(p.sy - ty) < 0.05) return true;
      await sleep(100);
    }
  }
  return false;
}

try {
  const A = await newPlayer('Alpha');
  const B = await newPlayer('Beta');
  await A.waitForTimeout(500);
  await B.waitForTimeout(500);
  check('双人加入且均存活', (await readPlayer(A)).alive && (await readPlayer(B)).alive);

  const pauseVisible = () => A.evaluate(() => !document.getElementById('pause').classList.contains('hidden'));
  check('显示“点击屏幕进入战斗”覆盖层', await pauseVisible());
  await A.mouse.click(640, 360);
  await A.waitForTimeout(600);
  check('点击覆盖层后锁定鼠标并进入战斗',
    (await A.evaluate(() => !!document.pointerLockElement)) && !(await pauseVisible()));

  // 右键瞄准（ADS）：FOV 拉近 + 准星收紧 + 松开恢复
  const fov0 = await A.evaluate(() => window.__game.camera.fov);
  await A.mouse.down({ button: 'right' });
  await A.waitForTimeout(800);
  const fovAim = await A.evaluate(() => window.__game.camera.fov);
  const aimingClass = await A.evaluate(() => document.getElementById('crosshair').classList.contains('aiming'));
  await A.mouse.up({ button: 'right' });
  await A.waitForTimeout(800);
  const fovBack = await A.evaluate(() => window.__game.camera.fov);
  console.log('[info] ADS FOV:', fov0.toFixed(1), '->', fovAim.toFixed(1), '->', fovBack.toFixed(1), '| crosshair.aiming =', aimingClass);
  check('右键瞄准：视野拉近且准星收紧', fovAim < fov0 - 10 && aimingClass);
  check('松开右键恢复视野', Math.abs(fovBack - 75) < 3);

  // 无空气墙直线移动
  await teleportTo(A, 'Alpha', -10, 7);
  await A.evaluate(() => { window.__game.local.locked = true; });
  await A.evaluate((y) => { window.__game.local.yaw = y; window.__game.local.pitch = 0; }, -Math.PI / 2);
  const p0 = await readPlayer(A);
  await A.keyboard.down('KeyW');
  // 帧级平滑测量：相机插值后应每帧都在动（无 20Hz 静止帧）
  const smooth = await A.evaluate(() => new Promise((resolve) => {
    const cam = window.__game.camera;
    let frames = 0, movedFrames = 0, prev = cam.position.x;
    function step() {
      const x = cam.position.x;
      frames++;
      if (Math.abs(x - prev) > 1e-4) movedFrames++;
      prev = x;
      if (frames < 20) requestAnimationFrame(step);
      else resolve({ frames, movedFrames });
    }
    requestAnimationFrame(step);
  }));
  await A.waitForTimeout(700); // 补足移动时间
  await A.keyboard.up('KeyW');
  const p1 = await readPlayer(A);
  check('沿直线移动无空气墙（服务器X 前进≥5m）', p1 && p1.sx !== null && p1.sx - p0.sx >= 5);
  console.log('[info] 帧级平滑采样:', JSON.stringify(smooth));
  check('移动平滑（相机每帧都在动，无 20Hz 跳变）', smooth.frames >= 10 && smooth.movedFrames / smooth.frames > 0.8);

  // 跳上中央擂台
  await teleportTo(A, 'Alpha', 7.5, 0);
  await A.evaluate(() => { window.__game.local.locked = true; });
  await A.evaluate((y) => { window.__game.local.yaw = y; window.__game.local.pitch = 0; }, Math.PI / 2);
  await A.keyboard.down('KeyW');
  await A.keyboard.down('Space');
  await A.waitForTimeout(150);
  await A.keyboard.up('Space');
  let onArena = false;
  for (let i = 0; i < 40; i++) {
    const p = await readPlayer(A);
    if (p && p.sy !== null && Math.abs(p.sy - 1.2) < 0.05 && p.sx >= -4 && p.sx <= 4) { onArena = true; break; }
    await sleep(100);
  }
  await A.keyboard.up('KeyW');
  check('跳跃登上中央擂台', onArena);

  // 爆头验证：A 瞄准 B 头部，一枪掉手枪爆头伤害（A 置前避免后台节流影响开火）
  await A.bringToFront();
  await teleportTo(A, 'Alpha', -DUEL_DIST / 2, 7);
  await teleportTo(B, 'Beta', DUEL_DIST / 2, 7);
  const pb = await readPlayer(B);
  await A.evaluate(() => { window.__game.local.locked = true; window.__game.shotsFired = 0; });
  await A.evaluate((t) => {
    const me = window.__game.player;
    const dx = t.bx - me.sx, dy = 1.68 - (me.sy + 1.55), dz = t.bz - me.sz;
    const d = Math.hypot(dx, dy, dz);
    window.__game.local.yaw = Math.atan2(-dx, -dz);
    window.__game.local.pitch = Math.asin(dy / d);
  }, { bx: pb.sx, bz: pb.sz });
  await A.mouse.down();
  await A.waitForTimeout(200);
  await A.mouse.up();
  await sleep(600);
  const afterHead = await readPlayer(B);
  check(`爆头一枪掉 ${HEAD_DMG}（B hp=${100 - HEAD_DMG}）`, afterHead && afterHead.hp === 100 - HEAD_DMG);

  // 击杀：开镜补几枪（ADS 收紧散布，结果稳定） → B 死亡界面 → 重生
  await A.mouse.down({ button: 'right' });
  await A.waitForTimeout(120);
  for (let i = 0; i < 5; i++) {
    await A.mouse.down();
    await A.waitForTimeout(200);
    await A.mouse.up();
    await A.waitForTimeout(200);
    if (process.env.SHOOT_DEBUG) {
      console.log('[dbg] shot', i, 'A =', JSON.stringify(await readPlayer(A)), 'B hp =', (await readPlayer(B)).hp);
    }
    // 击倒即停：避免 B 重生后继续开火，导致后续断言读到中间态
    if (await A.evaluate(() => window.__game.killCount || 0) >= 1) break;
  }
  await A.mouse.up({ button: 'right' });
  const shots = await A.evaluate(() => window.__game.shotsFired || 0);
  const kills = await A.evaluate(() => window.__game.killCount || 0);
  console.log('[info] 补枪: shots =', shots, '| kills =', kills, '| B =', JSON.stringify(await readPlayer(B)));
  check('补枪后 B 被击倒', shots >= 3 && kills >= 1);
  await A.screenshot({ path: path.join(shotDir, 'shoot_scene.png') });
  await B.screenshot({ path: path.join(shotDir, 'death_screen.png') });

  await B.waitForTimeout(3300);
  const reborn = await readPlayer(B);
  const deathHidden = await B.evaluate(() => document.getElementById('death').classList.contains('hidden'));
  check('B 自动重生（死亡界面自动隐藏，无需点击）', reborn && reborn.alive && reborn.hp === 100 && deathHidden);

  // AI：手动生成一个友军 AI，确认出现（AI+友队标）且会移动
  dbg.send(JSON.stringify({ t: 'debug_spawn_bot' })); // 第一个按平衡规则为友军
  let botSeen = false;
  for (let i = 0; i < 50; i++) {
    botSeen = await A.evaluate(() => document.querySelectorAll('#players .ai-tag').length > 0);
    if (botSeen) break;
    await sleep(100);
  }
  check('AI 出现且玩家列表带 AI 标签', botSeen);
  dbg.send(JSON.stringify({ t: 'debug_pos', name: 'AI-01', x: 25, z: -25, y: 0 }));
  await sleep(600);
  const bot1 = (await listRemotes(A)).find((r) => (r.name || '').startsWith('AI-'));
  await sleep(2000);
  const bot2 = (await listRemotes(A)).find((r) => (r.name || '').startsWith('AI-'));
  const botMoved = bot1 && bot2 && Math.hypot(bot2.x - bot1.x, bot2.z - bot1.z) > 1;
  console.log('[info] bot:', JSON.stringify(bot1), '->', JSON.stringify(bot2));
  check('AI 会移动', !!botMoved);

  // 敌军 AI 会开枪打玩家（放视野内 10m 且面朝玩家）
  await teleportTo(A, 'Alpha', -10, 7);
  dbg.send(JSON.stringify({ t: 'debug_pos', name: 'Beta', x: 50, z: -50, y: 0 }));
  dbg.send(JSON.stringify({ t: 'debug_spawn_bot', team: 'enemy' }));
  await sleep(400);
  dbg.send(JSON.stringify({ t: 'debug_pos', name: 'AI-01', x: 0, z: 7, y: 0, yaw: Math.PI / 2 })); // yaw=π/2 → 面朝 -X（玩家方向）
  const aHp0 = (await readPlayer(A)).hp;
  const et0 = await A.evaluate(() => window.__game.enemyTracers);
  let aiShot = false, hpDropped = false;
  for (let i = 0; i < 60; i++) {
    const p = await readPlayer(A);
    if (p && p.hp < aHp0) hpDropped = true;
    if (await A.evaluate(() => window.__game.enemyTracers) > et0) aiShot = true;
    if (hpDropped && aiShot) break;
    await sleep(120);
  }
  const et1 = await A.evaluate(() => window.__game.enemyTracers);
  const aHp1 = (await readPlayer(A)).hp;
  console.log('[info] 敌军攻击: hp', aHp0, '->', aHp1, '| enemyTracers', et0, '->', et1);
  check('敌军 AI 会对玩家开枪（出现敌方曳光）', aiShot);
  check('敌军 AI 能打伤玩家', hpDropped);

  // 道具：急救包回满血 + AK47 换武器
  dbg.send(JSON.stringify({ t: 'debug_pos', name: 'AI-01', x: 50, z: 50, y: 0 }));
  dbg.send(JSON.stringify({ t: 'debug_spawn_item', type: 'medkit', x: -25, z: 12 }));
  await sleep(500);
  await teleportTo(A, 'Alpha', -25, 10.5);
  await sleep(700);
  const hpAfterMed = (await readPlayer(A)).hp;
  check('急救包回满血', hpAfterMed === 100);
  dbg.send(JSON.stringify({ t: 'debug_spawn_item', type: 'ak47', x: -25, z: 16 }));
  await sleep(500);
  const itBefore = await A.evaluate(() => window.__game.itemCount);
  await teleportTo(A, 'Alpha', -25, 14.5);
  await sleep(700);
  const wpn = (await readPlayer(A)).weapon;
  const itAfter = await A.evaluate(() => window.__game.itemCount);
  console.log('[info] AK47: weapon =', wpn, '| itemCount', itBefore, '->', itAfter, '| A =', JSON.stringify(await readPlayer(A)));
  check('拾取 AK47 切换武器', wpn === 'ak47');

  // 护盾道具
  dbg.send(JSON.stringify({ t: 'debug_spawn_item', type: 'shield', x: -25, z: 20 }));
  await sleep(500);
  await teleportTo(A, 'Alpha', -25, 18.5);
  await sleep(700);
  const shieldOn = await A.evaluate(() => !document.getElementById('shieldWrap').classList.contains('hidden'));
  check('护盾道具生效（HUD 显示护盾）', shieldOn);

  // 加速道具
  dbg.send(JSON.stringify({ t: 'debug_spawn_item', type: 'speed', x: -25, z: 24 }));
  await sleep(500);
  await teleportTo(A, 'Alpha', -25, 22.5);
  await sleep(700);
  const speedOn = await A.evaluate(() => !document.getElementById('speedBadge').classList.contains('hidden'));
  check('加速道具生效（HUD 显示加速）', speedOn);

  // 击杀计分
  const scoreText = await A.evaluate(() => document.getElementById('score').textContent);
  console.log('[info] score =', scoreText);
  check('击杀计分显示', /击杀\s*[1-9]/.test(scoreText));

  // FPS（无头软件渲染下应 ≥25）：先关掉 B，A 置前避免后台节流
  await B.close();
  await A.bringToFront();
  await A.waitForTimeout(2500);
  const fps = await A.evaluate(() => window.__game.fps || 0);
  console.log('[info] fps =', fps);
  check('帧率达标（≥25）', fps >= 25);
} catch (e) {
  console.log('ERROR:', e.message);
}

dbg.close();
await browser.close();
srv.kill();

console.log('--- 页面错误 ---');
if (errors.length === 0) console.log('（无错误）');
else errors.slice(0, 20).forEach((e) => console.log(e));
const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n结果：${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);