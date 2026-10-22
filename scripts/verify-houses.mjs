// ===== 房屋窗户 / 家具视觉验证（开发期用，非发布构建）=====
// 用 CDP 启动浏览器，直接加载 three.js + createBuildings，从多个机位渲染房子：
//   1) 室外看窗户（确认窗洞是通的、有窗框、无玻璃）
//   2) 室内看家具（确认桌子/椅子/床/柜子都落在室内且不穿墙）
// 用法：node scripts/verify-houses.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from './serve-dev.mjs';
import { launchBrowser, findChrome } from './cdp.mjs';
import { HOUSES, houseWallSegments, FURNITURE } from '../shared/world.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(root, 'screenshots', 'houses');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!findChrome()) { console.error('未找到 Chrome/Edge'); process.exit(1); }

const TEST_HTML = `<!doctype html><html><head><meta charset="utf-8">
<script type="importmap">
{
  "imports": {
    "three": "/node_modules/three/build/three.module.js",
    "three/addons/": "/node_modules/three/examples/jsm/"
  }
}
</script>
<style>html,body{margin:0;height:100%;background:#8fb4d8;overflow:hidden}canvas{display:block}</style>
</head><body><script type="module">
import * as THREE from 'three';
import { createBuildings } from '/src/world/buildings.js';
import { SUN } from '/shared/world.js';

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(1);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(SUN.fogColor);
const sun = new THREE.DirectionalLight(SUN.color, 2.4);
sun.position.set(40, 70, 30);
scene.add(sun);
scene.add(new THREE.HemisphereLight(SUN.hemiSky, SUN.hemiGround, 1.5));
const fill = new THREE.DirectionalLight(0xffffff, 0.6);
fill.position.set(-30, 20, -40);
scene.add(fill);

const buildings = createBuildings({ preset: {}, anisotropy: 1 });
scene.add(buildings.group);

const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.05, 400);
window.__shot = (v) => {
  camera.position.set(v.x, v.y, v.z);
  camera.lookAt(v.tx, v.ty, v.tz);
  camera.updateMatrixWorld();
  renderer.render(scene, camera);
  return true;
};
window.__ready = true;
</script></body></html>`;

const pagePath = path.join(root, '__verify_houses.html');
fs.writeFileSync(pagePath, TEST_HTML, 'utf8');
const server = await startStaticServer({ port: 0 });
let browser = null;

try {
  browser = await launchBrowser({ width: 1280, height: 720 });
  const page = browser.page;
  await page.send('Page.navigate', { url: `http://127.0.0.1:${server.port}/__verify_houses.html` });

  const ready = await page.waitFor('window.__ready === true', 30000, 200);
  if (!ready) throw new Error('测试页未就绪: ' + browser.consoleErrors.join(' | '));
  await sleep(800);

  const shots = [];
  for (const h of HOUSES) {
    const d = houseWallSegments(h);
    const win = d.windows[0];
    const cy = (win.y0 + win.y1) / 2;
    // 室外：窗洞正前方 4.2m，略高于窗台，正对窗口
    shots.push({
      name: `${h.id}_outside`,
      cam: { x: win.x + win.dirX * 4.2, y: cy + 0.35, z: win.z + win.dirZ * 4.2 },
      target: { x: win.x, y: cy, z: win.z },
    });
    // 室内：站在房屋中心偏门口，看向第一件家具
    const f = FURNITURE.find((x) => x.house === h.id) || { x: h.x, z: h.z };
    shots.push({
      name: `${h.id}_inside`,
      cam: { x: h.x + (f.x - h.x) * -0.25, y: h.padH + 1.62, z: h.z + (f.z - h.z) * -0.25 },
      target: { x: f.x, y: h.padH + 0.55, z: f.z },
    });
  }

  for (const s of shots) {
    await page.evaluate((v) => window.__shot(v), {
      x: s.cam.x, y: s.cam.y, z: s.cam.z,
      tx: s.target.x, ty: s.target.y, tz: s.target.z,
    });
    await sleep(120);
    await page.screenshot(path.join(OUT, s.name + '.png'));
  }
  console.log('截图完成 ' + shots.length + ' 张 -> ' + OUT);
  if (browser.consoleErrors.length) console.log('页面错误: ' + browser.consoleErrors.join(' | '));
} catch (e) {
  console.error('失败:', e && e.message ? e.message : e);
  process.exitCode = 1;
} finally {
  try { fs.unlinkSync(pagePath); } catch { /* ignore */ }
  try { if (browser) await browser.close(); } catch { /* ignore */ }
  try { server.close(); } catch { /* ignore */ }
}
