// ===== Tidewater 地图截图/体检脚本（CDP，无 Playwright）=====
// 用途：给"用上游 dgreenheck/tidewater 真实地图数据重建"的渲染层做快速视觉验证。
//   node scripts/shot-tidewater.mjs                 # 拍默认机位到 screenshots/tidewater-verify/
//   node scripts/shot-tidewater.mjs --keep          # 拍完后保留服务器/浏览器（便于手工调试）
// 环境变量：SHOT_DIR（输出目录）、TEST_PORT、VIEWS（逗号分隔的机位名）、QUALITY（high/medium/low）
//
// 机位用上游世界坐标（米制，海平面 y=0，海在南 +z，村落 x≈40 z≈-118）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { startStaticServer } from './serve-dev.mjs';
import { launchBrowser, findChrome } from './cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = process.env.SHOT_DIR || path.resolve(root, 'screenshots/tidewater-verify');
fs.mkdirSync(SHOT_DIR, { recursive: true });
const PORT = Number(process.env.TEST_PORT || (4200 + Math.floor(Math.random() * 500)));
const KEEP = process.argv.includes('--keep');
const QUALITY = process.env.QUALITY || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 机位：pos 是玩家脚底坐标；look 是视线方向（度，0=+z 南方/朝海，90=+x 东，180=-z 北方/朝村）
const VIEWS = [
  { name: 'pier', x: 55, z: 22, y: null, yaw: 180, pitch: -2, note: '栈桥中段朝村落' },
  { name: 'pier-head', x: 55, z: 38, y: null, yaw: 150, pitch: -4, note: 'T 形桥头朝海蚀柱' },
  { name: 'village-plaza', x: 41.5, z: -108, y: null, yaw: 250, pitch: 2, note: '市场广场' },
  { name: 'village-street', x: 40, z: -95, y: null, yaw: 200, pitch: 0, note: '村口望向主街' },
  { name: 'boathouse', x: 84, z: -60, y: null, yaw: 90, pitch: 0, note: '船屋与船坞' },
  { name: 'beach', x: -60, z: 28, y: null, yaw: 180, pitch: 0, note: '沙滩朝内陆' },
  { name: 'beach-sea', x: -40, z: 40, y: null, yaw: 10, pitch: -6, note: '沙滩朝海/礁石' },
  { name: 'ridge-view', x: 0, z: -196, y: null, yaw: 170, pitch: -8, note: '北侧山脊俯瞰全村' },
];

if (!findChrome()) {
  console.error('未找到 Chrome/Edge，请安装浏览器或设置 CHROME_PATH');
  process.exit(1);
}

const server = spawn(process.execPath, ['server/server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), DEBUG: '1', BOTS_PER_SQUAD: '0', SQUADS: '1', ITEMS_MAX: '0' },
  stdio: 'ignore',
});
let staticSrv = null, browser = null, dbg = null;
const summary = { views: [], errors: [], stats: null, map: null, quality: null };

try {
  await sleep(2600);
  staticSrv = await startStaticServer({ port: 0, wsPort: PORT });
  const baseUrl = `http://127.0.0.1:${staticSrv.port}`;
  dbg = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((res, rej) => { dbg.on('open', res); dbg.on('error', rej); });
  const debugSend = (msg) => { try { dbg.send(JSON.stringify(msg)); } catch { /* ignore */ } };

  browser = await launchBrowser({ width: 1600, height: 900 });
  const page = browser.page;
  page.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    summary.errors.push('exception: ' + (d.text || (d.exception && d.exception.description) || ''));
  });
  page.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') summary.errors.push('console: ' + (p.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
  });
  const evaluate = (fn, arg) => page.evaluate(fn, arg);

  await page.send('Page.navigate', { url: baseUrl + '/' });
  await page.waitFor('document.readyState === "complete"', 20000);
  await sleep(3500);
  const boot = await evaluate(() => ({
    game: !!window.__game,
    menu: !document.getElementById('menu').classList.contains('hidden'),
    stats: window.__game && window.__game.world ? window.__game.world.stats() : null,
    errors: window.__game ? window.__game.errors.slice(0, 5) : [],
  }));
  summary.stats = boot.stats;
  summary.errors.push(...boot.errors.map((e) => 'game: ' + e));
  console.log('[shot] 启动：', JSON.stringify(boot));
  if (!boot.game) throw new Error('游戏未启动');
  if (QUALITY) await evaluate((q) => window.__game.world.setQuality(q), QUALITY);

  await page.screenshot(path.join(SHOT_DIR, '00-menu.png'));

  // 加入战场
  await evaluate(() => {
    const el = document.getElementById('nick');
    el.value = 'SHOT';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const btn = await evaluate(() => {
    const r = document.getElementById('joinBtn').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
  }
  await page.waitFor(`!document.getElementById('hud').classList.contains('hidden')`, 15000);
  summary.map = await evaluate(() => window.__game.map);
  summary.quality = await evaluate(() => window.__game.world.quality);
  console.log(`[shot] 已进入地图 ${summary.map}（quality=${summary.quality}）`);

  // 进入战斗态：按空格开始 → 等倒计时结束（否则截图被"按空格开始"遮罩+背景虚化盖住）
  await page.waitFor(`window.__game.matchPhase !== undefined`, 10000);
  for (const type of ['rawKeyDown', 'keyUp']) {
    await page.send('Input.dispatchKeyEvent', {
      type, code: 'Space', key: ' ', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32,
    });
  }
  const playing = await page.waitFor(`window.__game.matchPhase === 'playing'`, 25000);
  if (!playing) console.log('[shot] 注意：未进入 playing 阶段（继续拍摄）');
  await evaluate(() => {
    window.__game.local.locked = true;
    window.__game.hud.hidePause();
    window.__game.hud.hideWarmup();
  });
  await sleep(600);

  const only = process.env.VIEWS ? new Set(process.env.VIEWS.split(',').map((s) => s.trim())) : null;
  let idx = 1;
  for (const v of VIEWS) {
    if (only && !only.has(v.name)) continue;
    // 服务器侧传送（会按地形/碰撞把落点修正到地面）；debug_pos 有延迟，轮询到位再拍
    debugSend({ t: 'debug_pos', name: 'SHOT', x: v.x, z: v.z, y: v.y === null ? undefined : v.y });
    let arrived = false;
    for (let i = 0; i < 40; i++) {
      await sleep(150);
      const p = await evaluate(() => {
        const p = window.__game.player;
        return p ? { x: p.x, z: p.z } : null;
      });
      if (p && Math.hypot(p.x - v.x, p.z - v.z) < 3) { arrived = true; break; }
    }
    if (!arrived) console.log(`[shot] 注意：${v.name} 传送未精确到位（继续拍摄）`);
    // 摆镜头：yaw 转成本项目玩家朝向（弧度），pitch 向上为正
    await evaluate(({ yaw, pitch }) => {
      const p = window.__game.player;
      if (!p) return;
      p.yaw = yaw * Math.PI / 180;
      p.pitch = pitch * Math.PI / 180;
      p.vy = 0;
      if (window.__game.camera) window.__game.camera.rotation.set(p.pitch, p.yaw + Math.PI, 0, 'YXZ');
    }, { yaw: v.yaw, pitch: v.pitch });
    await sleep(800);
    await evaluate(() => {
      if (window.__game.hud.hidePause) window.__game.hud.hidePause();
      if (window.__game.hud.hideWarmup) window.__game.hud.hideWarmup();
      window.__game.local.locked = true;
    });
    const file = path.join(SHOT_DIR, `${String(idx++).padStart(2, '0')}-${v.name}.png`);
    await page.screenshot(file);
    const pos = await evaluate(() => {
      const p = window.__game.player;
      return p ? { x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1) } : null;
    });
    console.log(`[shot] ${v.name} → ${path.basename(file)}  pos=${JSON.stringify(pos)}  ${v.note || ''}`);
    summary.views.push({ name: v.name, file: path.relative(root, file), pos });
  }

  // 帧率采样
  const perf = await evaluate(async () => {
    let frames = 0;
    const t0 = performance.now();
    await new Promise((res) => {
      const tick = () => { frames++; if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else res(); };
      requestAnimationFrame(tick);
    });
    return { fps: +(frames / ((performance.now() - t0) / 1000)).toFixed(1), tris: window.__game.world.stats().triangles };
  });
  summary.perf = perf;
  console.log('[shot] 帧率：', JSON.stringify(perf));
  summary.stats = await evaluate(() => window.__game.world.stats());

  fs.writeFileSync(path.join(SHOT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  const bad = summary.errors.filter((e) => !/AudioContext|autoplay|favicon/i.test(e));
  console.log(`[shot] 完成：${summary.views.length} 张截图 → ${SHOT_DIR}`);
  if (bad.length) {
    console.log('[shot] 错误：\n  ' + bad.slice(0, 8).join('\n  '));
    process.exitCode = 1;
  }
} catch (e) {
  console.error('[shot] 失败：', e && e.stack ? e.stack : e);
  process.exitCode = 1;
} finally {
  if (!KEEP) {
    if (browser) { try { await browser.close(); } catch { /* ignore */ } }
    if (staticSrv) { try { await staticSrv.close(); } catch { /* ignore */ } }
    try { dbg && dbg.close(); } catch { /* ignore */ }
    try { server.kill(); } catch { /* ignore */ }
  }
}
