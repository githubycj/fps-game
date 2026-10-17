import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');

const server = spawn(process.execPath, ['server/server.js'], { cwd: root, stdio: 'inherit' });
const viteArgs = [viteBin];
if (process.env.VITE_PORT) viteArgs.push('--port', process.env.VITE_PORT, '--strictPort');
const vite = spawn(process.execPath, viteArgs, { cwd: root, stdio: 'inherit' });

function shutdown() {
  server.kill();
  vite.kill();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
