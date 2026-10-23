// ===== 开发/测试用静态服务器（无打包，原生 ES Module + importmap）=====
// 说明：CI/沙箱环境无法运行 vite（esbuild 需要启动子进程，被沙箱禁止），
// 因此浏览器端到端测试用本脚本直接以原生模块方式托管仓库源码，
// 并把 /ws 反向代理到游戏服务器。生产部署仍然使用 `npm run build` + `npm start`。
//
// 用法：
//   PORT=4174 WS_PORT=3001 node scripts/serve-dev.mjs
// 或在测试中：import { startStaticServer } from './serve-dev.mjs'
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.gz': 'application/gzip',
  '.bin': 'application/octet-stream',
  '.map': 'application/json',
};

const IMPORTMAP = `<script type="importmap">
{
  "imports": {
    "three": "/node_modules/three/build/three.module.js",
    "three/addons/": "/node_modules/three/examples/jsm/"
  }
}
</script>`;

/**
 * 启动静态服务器 + /ws 反向代理。
 * @param {{ port?: number, wsPort?: number, host?: string }} opts
 * @returns {Promise<{ server: http.Server, port: number, close: () => Promise<void> }>}
 */
export async function startStaticServer(opts = {}) {
  const port = opts.port ?? 0;
  const wsPort = opts.wsPort ?? 3001;
  const host = opts.host ?? '127.0.0.1';

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405); res.end('Method Not Allowed'); return;
    }
    const rawUrl = String(req.url || '/');
    const urlPath = decodeURIComponent(rawUrl.split('?')[0]);
    if (urlPath === '/' || urlPath === '/index.html') {
      fs.readFile(path.join(ROOT, 'index.html'), (err, data) => {
        if (err) { res.writeHead(404); res.end('index.html missing'); return; }
        const html = data.toString('utf8').replace('</head>', IMPORTMAP + '\n</head>');
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(html);
      });
      return;
    }
    // 先按仓库根路径找；找不到再回退到 public/（对应 vite 的 publicDir 语义，
    // 例如 /data/tidewater/geo.bin.gz 实际位于 public/data/tidewater/geo.bin.gz）。
    const candidates = [path.normalize(path.join(ROOT, urlPath)), path.normalize(path.join(ROOT, 'public', urlPath))];
    const file = candidates[0];
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
    const tryRead = (i) => {
      if (i >= candidates.length) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found: ' + urlPath); return;
      }
      const target = candidates[i];
      if (!target.startsWith(ROOT)) { tryRead(i + 1); return; }
      fs.readFile(target, (err, data) => {
        if (err) { tryRead(i + 1); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream' });
        res.end(data);
      });
    };
    tryRead(0);
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  const dbg = !!process.env.SF_PROXY_DEBUG;
  wss.on('connection', (client) => {
    if (dbg) console.log('[proxy] client connected');
    const backend = new WebSocket(`ws://127.0.0.1:${wsPort}/ws`);
    const queue = [];
    backend.on('open', () => {
      if (dbg) console.log('[proxy] backend open, queued=' + queue.length);
      for (const m of queue) backend.send(m);
      queue.length = 0;
    });
    backend.on('message', (data) => {
      if (dbg) console.log('[proxy] <- server', String(data).slice(0, 80));
      // 必须转成文本帧：浏览器端 onmessage 拿到 Blob 时 JSON.parse 会失败
      if (client.readyState === WebSocket.OPEN) client.send(typeof data === 'string' ? data : data.toString('utf8'));
    });
    client.on('message', (data) => {
      if (dbg) console.log('[proxy] -> server', String(data).slice(0, 80));
      const text = typeof data === 'string' ? data : data.toString('utf8');
      if (backend.readyState === WebSocket.OPEN) backend.send(text);
      else queue.push(text);
    });
    const close = (why) => {
      if (dbg) console.log('[proxy] close', why || '');
      try { if (client.readyState === WebSocket.OPEN) client.close(); } catch { /* ignore */ }
      try { if (backend.readyState === WebSocket.OPEN) backend.close(); } catch { /* ignore */ }
    };
    client.on('close', () => close('client'));
    client.on('error', () => close('client-error'));
    backend.on('close', () => close('backend'));
    backend.on('error', (e) => { if (dbg) console.log('[proxy] backend error', e.message); close('backend-error'); });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const actualPort = server.address().port;

  return {
    server,
    port: actualPort,
    close: () => new Promise((resolve) => {
      try { wss.close(); } catch { /* ignore */ }
      server.close(() => resolve());
    }),
  };
}

// 直接运行时启动
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const port = Number(process.env.PORT || 4174);
  const wsPort = Number(process.env.WS_PORT || 3001);
  const s = await startStaticServer({ port, wsPort });
  console.log(`[serve-dev] http://127.0.0.1:${s.port}  (WS 代理 → :${wsPort})`);
}
