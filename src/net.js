// ===== WebSocket 客户端封装 =====
export class Net {
  constructor() {
    this.ws = null;
    this.handlers = new Map();
    this.connected = false;
  }

  connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => { this.connected = true; resolve(); };
      ws.onerror = () => reject(new Error('无法连接服务器'));
      ws.onclose = () => {
        this.connected = false;
        this.emit('close', {});
      };
      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg && typeof msg.t === 'string') this.emit(msg.t, msg);
      };
    });
  }

  on(t, fn) {
    if (!this.handlers.has(t)) this.handlers.set(t, []);
    this.handlers.get(t).push(fn);
  }

  emit(t, msg) {
    const list = this.handlers.get(t);
    if (list) for (const fn of list) fn(msg);
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}

export function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  return proto + location.host + '/ws';
}
