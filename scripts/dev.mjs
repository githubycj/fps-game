import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');

// C 盘空间紧张时，子进程的临时文件统一写到项目所在的 E 盘，避免 ENOSPC
const tmpDir = path.join(root, '.tmp');
try { fs.mkdirSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
const childEnv = {
  ...process.env,
  TEMP: tmpDir,
  TMP: tmpDir,
  TMPDIR: tmpDir,
};

const server = spawn(process.execPath, ['server/server.js'], { cwd: root, stdio: 'inherit', env: childEnv });
const viteArgs = [viteBin, '--cacheDir', path.join(root, '.vite-cache')];
if (process.env.VITE_PORT) viteArgs.push('--port', process.env.VITE_PORT, '--strictPort');
const vite = spawn(process.execPath, viteArgs, { cwd: root, stdio: 'inherit', env: childEnv });

function shutdown() {
  server.kill();
  vite.kill();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
