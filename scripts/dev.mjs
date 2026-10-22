import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');

// C 盘空间紧张时，子进程的临时文件统一写到项目所在的 E 盘，避免 ENOSPC
const tmpDir = path.join(root, '.tmp');
try { fs.mkdirSync(tmpDir, { recursive: true }); } catch { /* ignore */ }

// ---------------------------------------------------------------------------
// 游戏服务器端口自动选择
// 部分 Windows 机器（Hyper-V / WSL / Docker 的"动态端口保留"）会把某些端口段整段保留，
// 对它们 listen 会直接报 EACCES。例如本机会保留 2927~3026，导致默认的 3001 起不来，
// 而 Vite 的 /ws 代理就连不上（浏览器表现为 "ws proxy error: ECONNREFUSED"、无法加入游戏）。
// 这里在启动前探测一个真正可绑定的端口，并同时告诉服务器和 Vite（GAME_PORT），两边永远一致。
// ---------------------------------------------------------------------------
function canBind(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => { try { srv.close(); } catch { /* ignore */ } resolve(false); });
    srv.listen(port, '0.0.0.0', () => { srv.close(() => resolve(true)); });
  });
}
async function pickPort(preferred) {
  for (let i = 0; i < 120; i++) {
    const p = preferred + i;
    if (p > 65000) break;
    if (await canBind(p)) return p;
  }
  return 0;   // 交给系统分配
}

const preferredPort = Number(process.env.PORT) || 3001;
const gamePort = await pickPort(preferredPort);
if (!gamePort) {
  console.error('[dev] 找不到可用的游戏服务器端口，请用 PORT=xxxx 显式指定');
  process.exit(1);
}
if (gamePort !== preferredPort) {
  console.warn(`[dev] 端口 ${preferredPort} 不可用（可能被系统保留或占用），改用 ${gamePort}`);
}
console.log(`[dev] 游戏服务器端口：${gamePort}（Vite 的 /ws 代理已同步到该端口）`);

const childEnv = {
  ...process.env,
  PORT: String(gamePort),
  GAME_PORT: String(gamePort),
  TEMP: tmpDir,
  TMP: tmpDir,
  TMPDIR: tmpDir,
};

const server = spawn(process.execPath, ['server/server.js'], { cwd: root, stdio: 'inherit', env: childEnv });
// 注意：Vite 6 的 CLI 没有 --cacheDir 参数（会报 CACError: Unknown option），
// 缓存目录通过 vite.config.js 的 cacheDir 配置（已设为项目内 .vite-cache）。
const viteArgs = [viteBin];
if (process.env.VITE_PORT) viteArgs.push('--port', process.env.VITE_PORT, '--strictPort');
const vite = spawn(process.execPath, viteArgs, { cwd: root, stdio: 'inherit', env: childEnv });

function shutdown() {
  server.kill();
  vite.kill();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
