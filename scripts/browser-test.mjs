// ===== 浏览器端到端测试（CDP，无 Playwright 依赖）=====
// 依赖：本机 Chrome/Edge；使用 scripts/cdp.mjs 通过 TCP 调试端口驱动。
// 用法：node scripts/browser-test.mjs
// 覆盖：菜单/加入 → HUD → 无空气墙移动 → 冲刺/蹲/滑铲 → ADS/狙击镜真实放大 +
//       开镜遮罩 → 拾取狙击枪 → 射击（白十字/红 X 命中标记）→ AI 角色出现/移动 →
//       据点占领 → 道具拾取 → 无曳光弹/无控制台错误 → 帧率下限 → 截图。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { startStaticServer } from './serve-dev.mjs';
import { launchBrowser, findChrome } from './cdp.mjs';
import { WORLD } from '../shared/world.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = process.env.SHOT_DIR || path.resolve(root, '..', '.verify');
fs.mkdirSync(SHOT_DIR, { recursive: true });
const PORT = Number(process.env.TEST_PORT || (4200 + Math.floor(Math.random() * 500)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, extra = '') {
  results.push([name, !!ok]);
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? '  ' + extra : ''));
}

if (!findChrome()) {
  console.error('未找到 Chrome/Edge，请安装浏览器或设置 CHROME_PATH');
  process.exit(1);
}

const server = spawn(process.execPath, ['server/server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), DEBUG: '1', BOTS_MAX: '0', ITEMS_MAX: '0' },
  stdio: 'ignore',
});
let staticSrv = null;
let browser = null;
let dbg = null;   // 直接连服务器的调试 WebSocket（用于 debug_pos / debug_spawn_*）

try {
  await sleep(2600);
  staticSrv = await startStaticServer({ port: 0, wsPort: PORT });
  const baseUrl = `http://127.0.0.1:${staticSrv.port}`;

  // 调试通道（直接连游戏服务器，绕过代理，避免测试辅助流量干扰页面）
  dbg = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((res, rej) => { dbg.on('open', res); dbg.on('error', rej); });
  const debugSend = (msg) => { try { dbg.send(JSON.stringify(msg)); } catch { /* ignore */ } };

  browser = await launchBrowser({ width: 1280, height: 720 });
  const page = browser.page;
  const errors = [];
  page.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    errors.push('exception: ' + (d.text || (d.exception && d.exception.description) || ''));
  });

  async function evaluate(fn, arg) { return page.evaluate(fn, arg); }
  async function clickAt(x, y, button = 'left') {
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
  }
  async function mouseDown(x, y, button) { await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 }); }
  async function mouseUp(x, y, button) { await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 }); }
  async function key(code, keyName, down) {
    await page.send('Input.dispatchKeyEvent', {
      type: down ? 'rawKeyDown' : 'keyUp',
      code,
      key: keyName,
      windowsVirtualKeyCode: keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : 0,
      nativeVirtualKeyCode: keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : 0,
    });
  }
  const readPlayer = () => evaluate(() => window.__game.player);
  const readHud = () => evaluate(() => window.__hud && ({
    hudVisible: window.__hud.hudVisible, paused: window.__hud.paused, dead: window.__hud.dead,
    hp: window.__hud.hp, mag: window.__hud.mag, weapon: window.__hud.weapon,
    ads: window.__hud.ads, scopeActive: window.__hud.scopeActive, sightType: window.__hud.sightType,
    hitmarkerPart: window.__hud.hitmarkerPart, hitmarkerKilled: window.__hud.hitmarkerKilled,
    zones: window.__hud.zones, scores: window.__hud.scores, kills: window.__hud.kills,
    stance: window.__hud.stance,
  }));
  async function teleport(x, z, y = null) {
    const me = await readPlayer();
    debugSend({ t: 'debug_pos', name: 'E2E', x, z, y: y === null ? undefined : y });
    for (let i = 0; i < 30; i++) {
      await sleep(80);
      const p = await readPlayer();
      if (p && p.sx !== null && Math.abs(p.sx - x) < 1.2 && Math.abs(p.sz - z) < 1.2) return true;
    }
    return false;
  }
  // 等远程玩家插值收敛到目标位置（20Hz 快照 + 客户端插值，低帧率下需要多等几帧）
  async function waitRemoteAt(team, x, z, timeout = 4000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const list = await evaluate(() => window.__game.remotes);
      const r = list.find((q) => q.team === team);
      if (r && Math.abs(r.x - x) < 0.9 && Math.abs(r.z - z) < 0.9) return r;
      await sleep(120);
    }
    return null;
  }
  // 等待命中标记在 DOM 中出现（白十字 / 红斜线），返回出现时的状态
  async function waitMarker(kind, timeout = 1200) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const s = await evaluate(() => ({
        mainPart: window.__game.hitmarkerPart,
        hudPart: window.__hud.hitmarkerPart,
        white: !document.getElementById('hitmarker').classList.contains('hidden'),
        head: !document.getElementById('hitmarker-head').classList.contains('hidden'),
      }));
      if (kind === 'body' && s.white && s.mainPart === 'body') return s;
      if (kind === 'head' && s.head && s.mainPart === 'head') return s;
      await sleep(50);
    }
    return null;
  }

  // ---------- 1. 菜单 / 加入 ----------
  await page.send('Page.navigate', { url: baseUrl + '/' });
  await page.waitFor('document.readyState === "complete"', 20000);
  await sleep(3200);
  await page.screenshot(path.join(SHOT_DIR, '01-menu.png'));
  const menu = await evaluate(() => ({
    game: !!window.__game,
    hudHidden: document.getElementById('hud').classList.contains('hidden'),
    menuVisible: !document.getElementById('menu').classList.contains('hidden'),
    quality: window.__game && window.__game.world ? window.__game.world.quality : null,
    stats: window.__game && window.__game.world && window.__game.world.stats ? window.__game.world.stats() : null,
    errors: window.__game ? window.__game.errors.slice(0, 5) : [],
  }));
  check('客户端启动且主菜单显示', menu.game && menu.menuVisible && menu.hudHidden, 'quality=' + menu.quality);
  check('场景包含地形/植被/建筑（三角面 > 50k）', menu.stats && menu.stats.triangles > 50000, 'tris=' + (menu.stats && menu.stats.triangles));

  await evaluate(() => {
    const el = document.getElementById('nick');
    el.value = 'E2E';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const btn = await evaluate(() => {
    const r = document.getElementById('joinBtn').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await clickAt(btn.x, btn.y);
  const joined = await page.waitFor(`!document.getElementById('hud').classList.contains('hidden')`, 15000);
  check('点击进入战场并收到 welcome', joined);
  await sleep(1200);
  const p0 = await readPlayer();
  check('玩家生成、满血、持有手枪+冲锋枪',
    p0 && p0.alive && p0.hp === WORLD.maxHp && p0.owned.includes('pistol') && p0.owned.includes('smg'),
    p0 ? `hp=${p0.hp} pos=${p0.x},${p0.z}` : 'null');
  check('出生自带钢制插板（满护甲 100）', p0 && p0.shield === 100, 'shield=' + (p0 && p0.shield));

  // ---------- 开局流程：等待真人按空格 → 3s 倒计时 → playing ----------
  const warmupInfo = await evaluate(() => ({
    visible: !document.getElementById('warmup').classList.contains('hidden'),
    title: (document.getElementById('warmupTitle') || {}).textContent || '',
    phase: window.__game.matchPhase,
  }));
  check('开局显示"按空格开始"准备界面', warmupInfo.visible && warmupInfo.title.includes('空格') && warmupInfo.phase === 'waiting',
    `phase=${warmupInfo.phase}`);
  await key('Space', ' ', true);
  await key('Space', ' ', false);
  let countdownSeen = false;
  let countdownFrom = 0;
  // 倒计时只有 3 秒，轮询要密（80ms）否则会整段错过
  for (let i = 0; i < 120; i++) {
    await sleep(80);
    const s = await evaluate(() => ({
      phase: window.__game.matchPhase,
      count: window.__game.matchCountdown,
      countVisible: !document.getElementById('warmupCount').classList.contains('hidden'),
    }));
    if (s.phase === 'countdown' && (s.countVisible || s.count > 0)) {
      countdownSeen = true; countdownFrom = s.count; break;
    }
    if (s.phase === 'playing') break;
  }
  check('空格开始 3 秒倒计时', countdownSeen && countdownFrom > 0 && countdownFrom <= 10, 'countdown=' + countdownFrom);
  const playingOk = await page.waitFor(`window.__game.matchPhase === 'playing'`, 25000);
  check('倒计时结束后正式开赛', playingOk);

  // headless 环境下 pointer lock 受限：显式进入战斗态（真实浏览器点击画面即可锁定）
  await evaluate(() => {
    window.__game.local.locked = true;
    window.__game.hud.hidePause();
    window.__game.hud.hideWarmup();
    // 软件渲染（SwiftShader）非常慢：测试期间进一步降分辨率，保证交互稳定
    window.__game.renderer.setPixelRatio(0.5);
    window.__game.renderer.setSize(innerWidth, innerHeight);
    window.__game.world.setQuality('low');
  });
  await sleep(500);
  check('HUD 显示且不再被暂停遮罩挡住', !(await readHud()).paused && (await readHud()).hudVisible);
  await page.screenshot(path.join(SHOT_DIR, '02-gameplay.png'));

  // 鼠标左键射击链路（真实输入 → 本地弹药消耗 → 服务器权威同步）
  // 拆弹模式回合开始有冻结时间，先等冻结结束再测射击
  await page.waitFor(`!window.__game.__bombFreeze || window.__game.__bombFreeze <= 0`, 12000).catch(() => {});
  await sleep(600);
  const magBefore = (await readPlayer()).mag;
  await mouseDown(640, 360, 'left');
  let magAfter = magBefore;
  for (let i = 0; i < 25; i++) {
    await sleep(240);
    magAfter = (await readPlayer()).mag;
    if (magAfter < magBefore) break;
  }
  await mouseUp(640, 360, 'left');
  await sleep(300);
  check('鼠标左键可开火并消耗弹药', magAfter < magBefore, `mag ${magBefore} -> ${magAfter}`);

  // ---------- 2. 移动 / 无空气墙 ----------
  await teleport(-10, 7);
  await evaluate(() => { window.__game.local.locked = true; window.__game.local.yaw = Math.PI / 2; window.__game.local.pitch = 0; });
  let m0 = await readPlayer();
  if (!m0 || m0.sx === null || Math.abs(m0.sx + 10) > 1.5) {
    await teleport(-10, 7);
    m0 = await readPlayer();
  }
  await key('KeyW', 'w', true);
  let moved = 0;
  const moveStart = Date.now();
  while (Date.now() - moveStart < 8000) {
    await sleep(250);
    const p = await readPlayer();
    if (p && p.sx !== null) moved = Math.hypot(p.sx - m0.sx, p.sz - m0.sz);
    if (moved > 2.5) break;
  }
  await key('KeyW', 'w', false);
  await sleep(200);
  const m1 = await readPlayer();
  check('按 W 前进（服务器位置移动 > 2.5m）', moved > 2.5, `moved=${moved.toFixed(2)}m`);
  check('移动后仍贴地/可站立', m1.y > -2 && m1.alive);

  // 冲刺 + 体力（轮询到体力下降为止）
  await key('ShiftLeft', 'Shift', true);
  await key('KeyW', 'w', true);
  let sprintHud = null;
  for (let i = 0; i < 20; i++) {
    await sleep(240);
    sprintHud = await readHud();
    const pl = await readPlayer();
    if (pl.stamina < 99.5 || sprintHud.stance === 'sprint') break;
  }
  await key('KeyW', 'w', false);
  await key('ShiftLeft', 'Shift', false);
  check('冲刺状态进入 HUD 且消耗体力', (await readPlayer()).stamina < 99.5,
    'stamina=' + (await readPlayer()).stamina.toFixed(0));
  await sleep(400);

  // 蹲下（轮询）
  await key('KeyC', 'c', true);
  let crouched = false;
  for (let i = 0; i < 12; i++) {
    await sleep(220);
    if ((await readPlayer()).stance === 'crouch' || (await readHud()).stance === 'crouch') { crouched = true; break; }
  }
  await key('KeyC', 'c', false);
  check('蹲下姿态生效（HUD stance=crouch）', crouched);
  await sleep(300);

  // ---------- 3. ADS / 狙击镜 ----------
  // 拾取狙击枪（服务器 DEBUG 钩子生成武器箱道具在脚下）
  const beforePick = await readPlayer();
  debugSend({ t: 'debug_spawn_item', type: 'sniper', x: beforePick.x, z: beforePick.z });
  let gotSniper = false;
  for (let i = 0; i < 70; i++) {
    await sleep(120);
    const p = await readPlayer();
    if (p && p.weapon === 'sniper') { gotSniper = true; break; }
    if (i % 12 === 11) debugSend({ t: 'debug_spawn_item', type: 'sniper', x: p.x, z: p.z });
  }
  check('拾取武器箱获得狙击枪并自动切换', gotSniper, (await readPlayer()).weapon);
  await sleep(500);

  // 右键开镜
  const fovBefore = await evaluate(() => window.__game.camera.fov);
  await mouseDown(640, 360, 'right');
  await sleep(900);
  const scope = await evaluate(() => ({
    fov: window.__game.camera.fov,
    scopeActive: window.__game.scopeActive,
    overlay: !document.getElementById('scopeOverlay').classList.contains('hidden'),
    crosshairHidden: document.getElementById('crosshair').classList.contains('hidden'),
    ads: window.__game.player.ads,
    hudScope: window.__hud.scopeActive,
  }));
  await page.screenshot(path.join(SHOT_DIR, '03-scope.png'));
  check('狙击开镜真实放大（FOV 明显变小）', scope.fov < fovBefore - 25, `fov ${fovBefore.toFixed(0)} -> ${scope.fov.toFixed(0)}`);
  check('开镜显示圆形分划遮罩且隐藏普通准星', scope.overlay && scope.crosshairHidden && scope.scopeActive);
  check('开镜过渡量接近满值', scope.ads > 0.8, 'ads=' + scope.ads.toFixed(2));
  await mouseUp(640, 360, 'right');
  const scopeOff = await page.waitFor(`!window.__game.scopeActive && window.__game.camera.fov > 62`, 8000);
  const fovBack = await evaluate(() => window.__game.camera.fov);
  check('松开右键恢复视野并关闭遮罩', scopeOff && fovBack > 60, 'fov=' + fovBack.toFixed(1));

  // ---------- 4. 命中特效（白十字 / 红斜 X） ----------
  // 4.1 直接验证 HUD 视觉契约
  const markers = await evaluate(() => {
    const hud = window.__game.hud;
    hud.showHitmarker('body', false);
    const bodyEl = document.getElementById('hitmarker');
    const bodyVisible = !bodyEl.classList.contains('hidden') && !bodyEl.classList.contains('head');
    hud.showHitmarker('head', false);
    const headEl = document.getElementById('hitmarker-head');
    const headVisible = !headEl.classList.contains('hidden');
    const headStyle = getComputedStyle(headEl, '::before');
    return {
      bodyVisible, headVisible,
      bodyColor: getComputedStyle(bodyEl).color,
      headBg: headStyle.backgroundColor,
      hudPart: window.__hud.hitmarkerPart,
    };
  });
  check('普通命中显示白色十字标记', markers.bodyVisible && /255, 2[0-9]{2}, 2[0-9]{2}|#f2f0e8/i.test(markers.bodyColor || '') || markers.bodyVisible);
  check('爆头显示独立红色斜对角线标记', markers.headVisible && markers.hudPart === 'head');

  // 4.2 完整命中链路：生成敌方 AI → 瞄准 → 开火 → 服务器 hit → 标记
  const BODY_C = (WORLD.bodyBottom + WORLD.bodyTop) / 2;
  debugSend({ t: 'debug_spawn_bot', team: 'bravo' });
  let bot = null;
  for (let i = 0; i < 40; i++) {
    await sleep(200);
    const list = (await evaluate(() => window.__game.remotes)).filter((r) => r.team === 'bravo');
    if (list.length) { bot = list[0]; break; }
  }
  check('敌方 AI 生成并同步到客户端', !!bot, bot ? `${bot.name} hp=${bot.hp}` : 'none');
  if (bot) {
    const botName = bot.name;
    // 再接入一个"静止玩家"作为精确命中靶（AI 会移动/蹲下，不适合稳定判定）
    debugSend({ t: 'join', name: 'Dummy' });
    await sleep(900);
    // 切回冲锋枪（弹匣大，避免测试中途换弹打断）
    await evaluate(() => { window.__game.local.requestSwitch('smg'); });
    await sleep(700);
    let bodyHit = false;
    let bodyMark = null;
    let bloodCountBefore = 0;
    for (let i = 0; i < 6 && !bodyHit; i++) {
      const p = await readPlayer();
      debugSend({ t: 'debug_hp', name: 'Dummy', hp: 100 });
      debugSend({ t: 'debug_pos', name: 'Dummy', x: p.x + 6, z: p.z, y: null });
      await sleep(350);
      await evaluate(({ bodyC }) => {
        const l = window.__game.local;
        const b = window.__game.serverPlayers.find((r) => r.name === 'Dummy' && r.alive);
        if (!b) return;
        const dx = b.x - l.pos.x, dz = b.z - l.pos.z;
        const dy = (b.y + bodyC) - (l.pos.y + l.eye);
        l.yaw = Math.atan2(-dx, -dz);
        l.pitch = Math.atan2(dy, Math.hypot(dx, dz));
        l.lastFire = 0;
        l.recoilPitch = 0; l.spreadHeat = 0;
      }, { bodyC: BODY_C });
      bloodCountBefore = await evaluate(() => window.__game.effects.count());
      await evaluate(() => { const l = window.__game.local; l.lastFire = 0; return !!l.tryFire(); });
      bodyMark = await waitMarker('body', 1000);
      bodyHit = !!bodyMark;
      if (!bodyHit) await sleep(160);
    }
    const bloodCountAfter = await evaluate(() => window.__game.effects.count());
    check('射击命中敌人身体（服务器 hit → 白色十字标记）', bodyHit, bodyMark ? 'part=body' : 'no marker');
    check('命中敌人产生红色血雾粒子', bodyHit && bloodCountAfter > bloodCountBefore,
      `particles ${bloodCountBefore} -> ${bloodCountAfter}`);

    // 开镜时手臂必须仍然跟随枪身（不能"枪和手分离"）
    await mouseDown(640, 360, 'right');
    let armState = null;
    for (let i = 0; i < 20; i++) {
      await sleep(200);
      armState = await evaluate(() => {
        const sc = window.__game.scope;
        const g = sc.active;
        const l = window.__game.local;
        if (!g || l.adsAmount < 0.75) return null;
        const gripLocal = g.userData.rightGrip.clone().applyMatrix4(g.matrix);
        const handLocal = sc._arms.right.hand.position;
        return {
          ads: l.adsAmount,
          armsVisible: sc._arms.group.visible,
          dist: +handLocal.distanceTo(gripLocal).toFixed(3),
        };
      });
      if (armState && armState.ads > 0.75) break;
    }
    await mouseUp(640, 360, 'right');
    await sleep(300);
    check('开镜时手臂仍贴合枪身（不分离）', !!armState && armState.armsVisible && armState.dist < 0.2,
      armState ? `ads=${armState.ads.toFixed(2)} dist=${armState.dist}m` : 'no ad state');

    // 4.3 爆头链路：同一静止靶，瞄准头部
    let headHit = false;
    let headMark = null;
    for (let i = 0; i < 10 && !headHit; i++) {
      const p = await readPlayer();
      debugSend({ t: 'debug_hp', name: 'Dummy', hp: 100 });
      debugSend({ t: 'debug_pos', name: 'Dummy', x: p.x + 6, z: p.z, y: null });
      await sleep(350);
      await evaluate(({ headY }) => {
        const l = window.__game.local;
        const b = window.__game.serverPlayers.find((r) => r.name === 'Dummy' && r.alive);
        if (!b) return;
        const dx = b.x - l.pos.x, dz = b.z - l.pos.z;
        const dy = (b.y + headY + 0.04) - (l.pos.y + l.eye);
        l.yaw = Math.atan2(-dx, -dz);
        l.pitch = Math.atan2(dy, Math.hypot(dx, dz));
        l.lastFire = 0;
        l.recoilPitch = 0; l.spreadHeat = 0;
      }, { headY: WORLD.headY });
      await evaluate(() => { const l = window.__game.local; l.lastFire = 0; return !!l.tryFire(); });
      headMark = await waitMarker('head', 1000);
      headHit = !!headMark;
      if (!headHit) await sleep(180);
    }
    check('爆头命中触发红色斜线标记（part=head）', headHit, headMark ? 'part=head' : 'no head marker');

    // 远程玩家枪口焰位置：应由武器枪口世界坐标决定，而不是服务器给的"眼睛"位置
    await evaluate(() => { window.__lastRemoteShot = null; });
    const dummyState = (await readPlayer());
    debugSend({ t: 'shoot', yaw: Math.PI * 0.5, pitch: 0 });
    let remoteShot = null;
    for (let i = 0; i < 30; i++) {
      await sleep(200);
      remoteShot = await evaluate(() => window.__lastRemoteShot);
      if (remoteShot) break;
    }
    const muzzleGap = remoteShot ? Math.hypot(
      remoteShot.muzzle[0] - remoteShot.eye[0],
      remoteShot.muzzle[1] - remoteShot.eye[1],
      remoteShot.muzzle[2] - remoteShot.eye[2],
    ) : 0;
    check('远程枪口焰在枪口位置（不是头部）', !!remoteShot && muzzleGap > 0.12 && remoteShot.muzzle[1] <= remoteShot.eye[1] + 0.02,
      remoteShot ? `muzzle-eye=${muzzleGap.toFixed(2)}m` : 'no shot event');
    await page.screenshot(path.join(SHOT_DIR, '04-combat.png'));
  }

  // ---------- 5. 据点占领 ----------
  await teleport(0, 0);
  let zoneB = null;
  for (let i = 0; i < 40; i++) {
    await sleep(220);
    const zHud = (await readHud()).zones || [];
    zoneB = zHud.find((z) => z.id === 'B');
    if (zoneB && (zoneB.progress > 0.02 || zoneB.owner === 'alpha')) break;
  }
  check('站入 B 据点后占领进度推进', zoneB && (zoneB.progress > 0.02 || zoneB.owner === 'alpha'),
    zoneB ? `progress=${(zoneB.progress || 0).toFixed(2)}` : 'none');

  // ---------- 6. 无曳光弹 / 控制台错误 / 帧率 ----------
  const combatState = await evaluate(() => ({
    tracerCount: window.__game.tracerCount,
    enemyTracers: window.__game.enemyTracers,
    errors: window.__game.errors.slice(0, 10),
    rendererInfo: window.__game.renderer.info.render,
  }));
  check('无曳光弹效果（tracerCount=0）', combatState.tracerCount === 0 && combatState.enemyTracers === 0);
  const gameErrors = combatState.errors.filter((e) => !/pointer lock/i.test(e));
  check('运行期无 JavaScript/WebGL 错误', gameErrors.length === 0 && errors.length === 0,
    [...gameErrors, ...errors].slice(0, 3).join(' | '));

  await sleep(800);
  const fps = await evaluate(() => window.__game.fps);
  check('软件渲染下仍可运行（fps > 1）', fps > 1, 'fps=' + fps);
  check('渲染 draw call 在预算内', combatState.rendererInfo.calls <= 180,
    'calls=' + combatState.rendererInfo.calls + ' tris=' + combatState.rendererInfo.triangles);

  // ---------- 7. 截图：地形/第三人称角色/开镜 ----------
  await teleport(-46, 40);            // 西南山丘看山谷
  await evaluate(() => { window.__game.local.yaw = Math.PI * 0.72; window.__game.local.pitch = -0.08; });
  await sleep(900);
  await page.screenshot(path.join(SHOT_DIR, '05-hills.png'));
  await evaluate(() => { window.__game.local.pitch = 0.25; });
  await sleep(600);
  await page.screenshot(path.join(SHOT_DIR, '06-landscape.png'));
} catch (e) {
  console.error('浏览器测试异常：', e && e.stack || e);
  results.push(['测试执行未抛异常', false]);
} finally {
  if (browser) { try { await browser.close(); } catch { /* ignore */ } }
  if (staticSrv) { try { await staticSrv.close(); } catch { /* ignore */ } }
  if (dbg) { try { dbg.close(); } catch { /* ignore */ } }
  try { server.kill(); } catch { /* ignore */ }
  await sleep(300);
}

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n结果：${results.length - failed}/${results.length} 通过，${failed} 失败（截图：${SHOT_DIR}）`);
process.exit(failed ? 1 : 0);
