// ===== 极简 Chrome DevTools Protocol 客户端（浏览器端到端测试用）=====
// 为什么不用 Playwright：当前沙箱禁止子进程命名管道（--remote-debugging-pipe → spawn EPERM），
// 而 CDP over TCP 调试端口可以正常工作。生产/本地机器上两种方式都能用。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

export class CDPPage {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
  }

  async connect() {
    const { WebSocket } = await import('ws');
    this.ws = new WebSocket(this.wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, method } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`CDP ${method}: ${msg.error.message || JSON.stringify(msg.error)}${msg.error.data ? ' | ' + msg.error.data : ''}`));
        else resolve(msg.result);
        return;
      }
      const list = this.handlers.get(msg.method);
      if (list) for (const fn of list) { try { fn(msg.params); } catch { /* ignore */ } }
    });
    this.ws.on('close', () => { this.closed = true; });
    return this;
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
    return () => {
      const list = this.handlers.get(method);
      if (list) { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }
    };
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('CDP closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP timeout: ' + method));
      }, 90000);
      this.pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { this.ws.send(JSON.stringify({ id, method, params })); } catch (e) { this.pending.delete(id); reject(e); }
    });
  }

  async evaluate(expression, arg) {
    let expr = expression;
    // 兼容 Playwright 风格：允许直接传函数（自包含函数体，参数用 arg 传入）
    if (typeof expr === 'function') {
      expr = `(${expr.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`;
    }
    const res = await this.send('Runtime.evaluate', {
      expression: String(expr), returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (res && res.exceptionDetails) {
      throw new Error('evaluate: ' + (res.exceptionDetails.text || '') + ' ' +
        (res.exceptionDetails.exception && res.exceptionDetails.exception.description || ''));
    }
    return res ? res.result.value : undefined;
  }

  async waitFor(expression, timeout = 15000, interval = 100) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        if (await this.evaluate(`!!(${expression})`)) return true;
      } catch { /* 页面导航中可能抛错 */ }
      await sleep(interval);
    }
    return false;
  }

  async screenshot(file) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    const outPath = typeof file === 'string' ? file : (file && file.path);
    if (outPath) fs.writeFileSync(outPath, Buffer.from(res.data, 'base64'));
    return res.data;
  }

  async close() {
    try { await this.send('Page.close'); } catch { /* ignore */ }
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

/**
 * 启动 headless Chrome（TCP CDP），并打开一个页面。
 * 内部带一次重试：机器负载高/上一个实例刚退出时，首次启动偶发失败。
 */
export async function launchBrowser(opts = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await launchBrowserOnce(opts);
    } catch (e) {
      lastErr = e;
      await sleep(900);
    }
  }
  throw lastErr || new Error('Chrome 启动失败');
}

async function launchBrowserOnce(opts = {}) {
  const chromePath = opts.chromePath || findChrome();
  if (!chromePath) throw new Error('未找到 Chrome/Edge 可执行文件（可设 CHROME_PATH）');
  const port = opts.port || (9300 + Math.floor(Math.random() * 500));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-chrome-'));
  const width = opts.width || 1280;
  const height = opts.height || 720;
  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--mute-audio',
    '--hide-scrollbars',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    `--window-size=${width},${height}`,
    'about:blank',
  ];
  const proc = spawn(chromePath, args, { stdio: 'ignore', windowsHide: true });
  let version = null;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      version = await res.json();
      break;
    } catch { await sleep(150); }
  }
  if (!version) {
    try { proc.kill(); } catch { /* ignore */ }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw new Error('Chrome CDP 调试端口未就绪');
  }
  // 新建页面并连接
  let target = null;
  const deadline2 = Date.now() + 10000;
  while (Date.now() < deadline2 && !target) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
      target = await res.json();
    } catch { await sleep(120); }
  }
  if (!target || !target.webSocketDebuggerUrl) {
    try { proc.kill(); } catch { /* ignore */ }
    throw new Error('无法创建浏览器页面');
  }
  const page = new CDPPage(target.webSocketDebuggerUrl);
  await page.connect();
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  });
  await page.send('Runtime.runIfWaitingForDebugger').catch(() => {});

  const consoleErrors = [];
  page.on('Runtime.exceptionThrown', (p) => {
    const d = p && p.exceptionDetails;
    consoleErrors.push('exception: ' + (d && (d.text || (d.exception && d.exception.description)) || ''));
  });
  page.on('Runtime.consoleAPICalled', (p) => {
    if (p && p.type === 'error') {
      consoleErrors.push('console: ' + (p.args || []).map((a) => a.value || (a.description || '')).join(' '));
    }
  });

  const close = async () => {
    try { await page.close(); } catch { /* ignore */ }
    try { proc.kill(); } catch { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  return { page, proc, port, close, consoleErrors };
}
