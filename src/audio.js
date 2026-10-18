// ===== 程序化音频引擎（WebAudio，零外部资源）=====
// 契约：REMAKE_SPEC.md §6.4
// 设计要点：
// - initAudio() 幂等；AudioContext 不可用（Node 自动化测试 / 浏览器拒绝）时全部接口安全 no-op，绝不抛错。
// - 总线：master gain → DynamicsCompressor → destination；Convolver 混响 send（程序化户外 IR）。
// - 枪声分层：瞬态 crack / 低频胸腔冲击 / 机械声 / 户外拖尾；5 把枪音色参数明显不同。
// - 空间感：距离 → 低通 + 衰减 + 声像 + 传播延迟（343m/s）；>60m 只剩闷响与回音。
// - 环境声：程序化风声（噪声 + LFO）+ 随机鸟叫/虫鸣/狗吠/汽车；定时器在 stopAmbience 清理。
// - 空间定位：setAudioListener(pos, forward) 每帧写入听者；sfx.shoot 支持 {distance, pan}，
//   也支持 {position:{x,y,z}} 或 {x,y,z} 由听者数据实时换算距离与声像。
// - 所有节点惰性创建；不使用任何外部音频文件 / Base64 音频。

let ctx = null;          // AudioContext
let bus = null;          // { master, comp, convolver, wetReturn }
let noiseBuf = null;     // 复用的程序化噪声缓冲
let listener = null;     // { x, y, z, fx, fz } 听者位置与水平朝向
let amb = null;          // 环境声运行状态

// ---------- 基础设施 ----------

function getContextCtor() {
  try {
    const g = typeof globalThis !== 'undefined' ? globalThis : {};
    return g.AudioContext || g.webkitAudioContext || null;
  } catch { return null; }
}

// 生成约 1.1s 的户外脉冲响应：
// 3~6 个早期反射延迟抽头 + 指数衰减扩散噪声（左右微去相关，得到自然立体声尾音）
function makeOutdoorIR(seconds) {
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.floor(sr * seconds));
  const buf = ctx.createBuffer(2, len, sr);
  // 固定 LCG 伪随机：IR 每次生成基本一致，避免听感漂移（运行时特效允许随机，但混响更适合稳定）
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296 * 2 - 1;
  };
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    // 早期反射抽头：模拟房屋 / 地面 / 树木的第一次回声
    const taps = ch === 0
      ? [0.011, 0.021, 0.034, 0.048, 0.065, 0.087]
      : [0.013, 0.024, 0.037, 0.051, 0.069, 0.092];
    const gains = ch === 0
      ? [0.50, 0.42, 0.34, 0.27, 0.20, 0.14]
      : [0.44, 0.38, 0.30, 0.24, 0.18, 0.12];
    for (let i = 0; i < taps.length; i++) {
      const idx = Math.floor(taps[i] * sr);
      if (idx < len) data[idx] += gains[i];
    }
    // 扩散尾：指数衰减噪声（户外空气吸收，低频衰减更慢）
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const env = Math.pow(1 - t, 2.1) * Math.exp(-3.0 * t);
      data[i] += rnd() * env * (ch === 0 ? 0.6 : 0.52);
    }
  }
  // 峰值归一化，避免卷积后音量失控
  let peak = 0;
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(data[i]));
  }
  const norm = peak > 1e-4 ? 0.85 / peak : 1;
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) data[i] *= norm;
  }
  return buf;
}

function ensureNoise() {
  if (noiseBuf) return noiseBuf;
  const sr = ctx.sampleRate;
  const len = Math.max(1024, Math.floor(sr * 2));
  noiseBuf = ctx.createBuffer(1, len, sr);
  const data = noiseBuf.getChannelData(0);
  // 白噪声 + 一阶低通混合，接近"粉噪"，听感更柔和
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    last = last * 0.72 + w * 0.28;
    data[i] = w * 0.55 + last * 0.9;
  }
  return noiseBuf;
}

function ensureBus() {
  if (!ctx) return false;
  if (bus) return true;
  try {
    const master = ctx.createGain();
    master.gain.value = 0.85;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 24;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    master.connect(comp);
    comp.connect(ctx.destination);
    // 混响发送总线：枪声/环境声按比例送入 Convolver，湿声返回 master
    let convolver = null;
    let wetReturn = null;
    try {
      convolver = ctx.createConvolver();
      convolver.buffer = makeOutdoorIR(1.1);
      wetReturn = ctx.createGain();
      wetReturn.gain.value = 0.7;
      convolver.connect(wetReturn);
      wetReturn.connect(master);
    } catch {
      convolver = null;
      wetReturn = null;
    }
    bus = { master, comp, convolver, wetReturn };
    return true;
  } catch {
    bus = null;
    return false;
  }
}

// 惰性初始化 + 恢复被挂起的上下文（幂等）
export function initAudio() {
  try {
    if (ctx && ctx.state === 'closed') {
      ctx = null;
      bus = null;
      noiseBuf = null;
    }
    if (!ctx) {
      const Ctor = getContextCtor();
      if (!Ctor) return false;
      try { ctx = new Ctor(); } catch { ctx = null; return false; }
    }
    if (!ensureBus()) return false;
    if (ctx.state === 'suspended') {
      try {
        const p = ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch { /* 用户手势前恢复失败属正常，静默 */ }
    }
    return true;
  } catch {
    return false;
  }
}

// 声音接口内部使用：必要时补一次 initAudio（例如 Lead 忘记在首个枪声前初始化）
function audioReady() {
  if (ctx && bus) return true;
  return initAudio();
}

// 每帧更新听者（3D 定位用），失败静默
export function setAudioListener(pos, forward) {
  try {
    if (!pos || typeof pos.x !== 'number' || typeof pos.z !== 'number') return;
    let fx = listener ? listener.fx : 0;
    let fz = listener ? listener.fz : -1;
    if (forward && typeof forward.x === 'number' && typeof forward.z === 'number') {
      const h = Math.hypot(forward.x, forward.z);
      if (h > 1e-4) {
        fx = forward.x / h;
        fz = forward.z / h;
      }
    }
    listener = {
      x: pos.x,
      y: typeof pos.y === 'number' ? pos.y : 0,
      z: pos.z,
      fx,
      fz,
    };
  } catch { /* 忽略 */ }
}

// 依据听者数据把声音发射点换算成 { distance, pan }
function spatialOf(opts) {
  let distance = opts.distance;
  let pan = opts.pan;
  const pos = opts.position
    || (typeof opts.x === 'number' && typeof opts.z === 'number'
      ? { x: opts.x, y: opts.y || 0, z: opts.z }
      : null);
  if (listener && pos) {
    const dx = pos.x - listener.x;
    const dy = (typeof pos.y === 'number' ? pos.y : 0) - listener.y;
    const dz = pos.z - listener.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // 听者右向量 = forward × up = (-fz, 0, fx)
    const rightX = -listener.fz;
    const rightZ = listener.fx;
    const horiz = Math.max(0.001, Math.hypot(dx, dz));
    const p = (dx * rightX + dz * rightZ) / horiz;
    if (distance == null) distance = d;
    if (pan == null) pan = p;
  }
  return {
    distance: Math.max(0, Number(distance) || 0),
    pan: Math.max(-1, Math.min(1, Number(pan) || 0)),
  };
}

// ---------- 通用合成单元 ----------

// 指数包络（起音 + 衰减），返回 GainNode
function envelope(t, dur, peak, attack) {
  const g = ctx.createGain();
  const a = Math.max(0.0008, Math.min(attack == null ? 0.002 : attack, dur * 0.5));
  const p = Math.max(0.0002, peak);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(p, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + Math.max(0.005, dur));
  return g;
}

// 单个振荡器音（可带滤波），自带断开清理
function tone(dest, t, o) {
  if (!dest || !ctx) return null;
  const attack = o.attack == null ? 0.003 : o.attack;
  const dur = Math.max(0.01, o.dur || 0.08);
  const osc = ctx.createOscillator();
  osc.type = o.type || 'sine';
  const f0 = Math.max(20, o.f0 || 440);
  const f1 = o.f1 == null ? null : Math.max(20, o.f1);
  osc.frequency.setValueAtTime(f0, t);
  if (f1) osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = envelope(t, dur, o.gain == null ? 0.1 : o.gain, attack);
  let head = osc;
  if (o.filter) {
    const f = ctx.createBiquadFilter();
    f.type = o.filter;
    f.frequency.value = o.cutoff || 1200;
    f.Q.value = o.q == null ? 0.8 : o.q;
    osc.connect(f);
    head = f;
  }
  head.connect(g);
  g.connect(dest);
  osc.start(t);
  osc.stop(t + attack + dur + 0.03);
  osc.onended = () => {
    try {
      osc.disconnect();
      if (head !== osc) head.disconnect();
      g.disconnect();
    } catch { /* 节点可能已断开 */ }
  };
  return osc;
}

// 噪声爆发（带滤波扫频），自带断开清理
function noiseBurst(dest, t, o) {
  if (!dest || !ctx) return null;
  const attack = o.attack == null ? 0.002 : o.attack;
  const dur = Math.max(0.01, o.dur || 0.06);
  const src = ctx.createBufferSource();
  src.buffer = ensureNoise();
  src.loop = true;
  if (o.rate) src.playbackRate.value = o.rate;
  const f = ctx.createBiquadFilter();
  f.type = o.type || 'bandpass';
  const freq = Math.max(40, o.freq || 1200);
  f.frequency.setValueAtTime(freq, t);
  if (o.f1) f.frequency.exponentialRampToValueAtTime(Math.max(40, o.f1), t + dur);
  f.Q.value = o.q == null ? 0.8 : o.q;
  const g = envelope(t, dur, o.gain == null ? 0.1 : o.gain, attack);
  src.connect(f);
  f.connect(g);
  g.connect(dest);
  const off = o.offset == null ? Math.random() * 1.2 : o.offset;
  src.start(t, off);
  src.stop(t + attack + dur + 0.03);
  src.onended = () => {
    try {
      src.disconnect();
      f.disconnect();
      g.disconnect();
    } catch { /* 节点可能已断开 */ }
  };
  return src;
}

// 短促机械声（击锤 / 枪机 / 弹匣卡榫）：短噪声 click + 一点方波金属体
function mechClick(dest, t, freq, gain) {
  if (!dest || !ctx) return;
  const f = Math.max(180, freq || 1800);
  const g0 = Math.max(0.01, gain == null ? 0.1 : gain);
  noiseBurst(dest, t, { dur: 0.026, gain: g0, freq: f, q: 5, type: 'bandpass' });
  tone(dest, t, {
    type: 'square',
    f0: f * 0.55,
    f1: f * 0.34,
    dur: 0.022,
    gain: g0 * 0.3,
  });
}

// 立体声像节点（旧浏览器不支持时退化为单声道，不影响其他功能）
function makePanner(pan) {
  if (!ctx) return null;
  try {
    if (typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan || 0));
      return p;
    }
  } catch { /* 忽略 */ }
  return null;
}

// 送入 Convolver 混响，返回发送增益节点
function sendWet(from, amount) {
  if (!bus || !bus.convolver || !ctx || !(amount > 0)) return null;
  try {
    const g = ctx.createGain();
    g.gain.value = amount;
    from.connect(g);
    g.connect(bus.convolver);
    return g;
  } catch {
    return null;
  }
}

// 定时断开一组节点，避免长期挂在图上造成泄漏
function disposeLater(nodes, seconds) {
  if (!nodes || !nodes.length) return;
  const ms = Math.max(80, (seconds || 1) * 1000 + 150);
  try {
    setTimeout(() => {
      for (let i = 0; i < nodes.length; i++) {
        try {
          if (nodes[i]) nodes[i].disconnect();
        } catch { /* 已断开 */ }
      }
    }, ms);
  } catch { /* 忽略 */ }
}

// ---------- 枪声参数表（5 把枪音色差异的核心） ----------
// 与 shared/weapons.js 的 audio 提示对齐：base = 低频基频，crackFreq = 瞬态带通中心，
// tailHint = 拖尾强度提示，volume = 整体响度。
// body：中频枪身；thump：60~120Hz 低频冲击；mech：击锤/枪机；wet：混响湿声比例；
// pump/bolt：泵动/拉栓时刻；tailDur：拖尾时长（决定距离/回音长度）。
const GUNS = {
  // 手枪：清脆、短促，高频 crack 明显
  pistol: {
    volume: 0.85,
    base: 190,
    crackFreq: 3600,
    tailHint: 0.42,
    wet: 0.16,
    crack: { dur: 0.045, gain: 0.50, f1: 2400, q: 0.9 },
    body: { type: 'sawtooth', f0: 320, f1: 92, dur: 0.10, gain: 0.30 },
    thump: { f1: 62, dur: 0.13, gain: 0.46 },
    mech: { t: 0.012, freq: 2500, gain: 0.22 },
    tailDur: 0.65,
  },
  // 冲锋枪：急促、单发更薄，机械声靠前
  smg: {
    volume: 0.8,
    base: 170,
    crackFreq: 4200,
    tailHint: 0.34,
    wet: 0.13,
    crack: { dur: 0.032, gain: 0.48, f1: 2800, q: 1.1 },
    body: { type: 'square', f0: 380, f1: 120, dur: 0.07, gain: 0.24 },
    thump: { f1: 78, dur: 0.09, gain: 0.40 },
    mech: { t: 0.008, freq: 3000, gain: 0.20 },
    tailDur: 0.52,
  },
  // AK47：中频厚实、低频冲击强、拖尾中等
  ak47: {
    volume: 0.95,
    base: 120,
    crackFreq: 3000,
    tailHint: 0.55,
    wet: 0.22,
    crack: { dur: 0.065, gain: 0.60, f1: 1700, q: 0.8 },
    body: { type: 'sawtooth', f0: 260, f1: 74, dur: 0.14, gain: 0.38 },
    thump: { f1: 58, dur: 0.17, gain: 0.62 },
    mech: { t: 0.016, freq: 1900, gain: 0.24 },
    tailDur: 0.84,
  },
  // 霰弹枪：低频轰 + 稍后的泵动声
  shotgun: {
    volume: 1.0,
    base: 85,
    crackFreq: 2200,
    tailHint: 0.7,
    wet: 0.28,
    crack: { dur: 0.09, gain: 0.62, f1: 900, q: 0.6 },
    body: { type: 'sawtooth', f0: 200, f1: 52, dur: 0.22, gain: 0.44 },
    thump: { f1: 44, dur: 0.28, gain: 0.85 },
    mech: { t: 0.02, freq: 1500, gain: 0.20 },
    pump: 0.34,
    tailDur: 1.05,
  },
  // 狙击枪：极响、低频最重、拖尾最长 + 拉栓声
  sniper: {
    volume: 1.1,
    base: 95,
    crackFreq: 2600,
    tailHint: 1.1,
    wet: 0.4,
    crack: { dur: 0.11, gain: 0.72, f1: 1200, q: 0.7 },
    body: { type: 'sawtooth', f0: 210, f1: 55, dur: 0.30, gain: 0.48 },
    thump: { f1: 40, dur: 0.36, gain: 1.0 },
    mech: { t: 0.02, freq: 1400, gain: 0.22 },
    bolt: 0.5,
    tailDur: 1.65,
  },
};

// ---------- 枪声 ----------

function _shoot(kind, opts) {
  if (!audioReady() || !bus) return;
  const def = GUNS[kind] || GUNS.pistol;
  const o = opts || {};
  const sp = spatialOf(o);
  const dist = sp.distance;
  const pan = sp.pan;
  const indoor = !!o.indoor;
  const t0 = ctx.currentTime + 0.004;
  const travel = Math.min(0.4, dist / 343);   // 声速延迟：远处先看到枪口焰、后听到枪声
  const t = t0 + travel;
  const far = dist > 60;
  // 距离衰减：5m 内近似 1，之后按 Δd 反比衰减
  const att = 1 / (1 + Math.max(0, dist - 4) * 0.045);
  // 距离低通：每远 4m 砍掉一部分高频，>60m 封顶为闷响
  let cutoff = 20000 / (1 + Math.max(0, dist - 4) * 0.26);
  if (far) cutoff = Math.min(cutoff, 850);
  if (indoor) cutoff *= 0.82;
  cutoff = Math.max(300, cutoff);

  // 本发枪声的干声链：层增益 → 低通 → 声像 → master
  const shot = ctx.createGain();
  shot.gain.value = (def.volume || 1) * att * (far ? 0.9 : 1);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = cutoff;
  lp.Q.value = 0.6;
  shot.connect(lp);
  const nodes = [shot, lp];
  const panner = makePanner(pan);
  if (panner) {
    lp.connect(panner);
    panner.connect(bus.master);
    nodes.push(panner);
  } else {
    lp.connect(bus.master);
  }
  // 混响发送：远处/户外湿声更重，室内吸声
  const wetAmt = def.wet * (far ? 2.1 : 1) * (indoor ? 0.6 : 1);
  const wet = sendWet(lp, wetAmt);
  if (wet) nodes.push(wet);

  const crackScale = far ? 0.2 : (indoor ? 0.85 : 1);
  // 1) 瞬态：噪声爆发 + 2~6kHz 带通 crack（"啪"的枪口爆音）
  noiseBurst(shot, t, {
    dur: def.crack.dur,
    gain: def.crack.gain * crackScale,
    freq: def.crackFreq,
    f1: def.crack.f1,
    q: def.crack.q,
    type: 'bandpass',
  });
  // 高频窄带：让近距离枪声有"金属脆裂"感
  noiseBurst(shot, t, {
    dur: def.crack.dur * 0.55,
    gain: def.crack.gain * 0.45 * crackScale,
    freq: 5200,
    q: 2.2,
    type: 'bandpass',
  });
  // 2) 低频胸腔冲击（60~120Hz 正弦 + 三角泛音）
  tone(shot, t + 0.003, {
    type: 'sine',
    f0: def.base,
    f1: def.thump.f1,
    dur: def.thump.dur,
    gain: def.thump.gain * (far ? 0.85 : 1),
  });
  tone(shot, t + 0.001, {
    type: 'triangle',
    f0: def.base * 1.9,
    f1: def.thump.f1 * 1.6,
    dur: def.thump.dur * 0.5,
    gain: def.thump.gain * 0.22,
  });
  // 3) 中频枪身（决定每把枪的"厚/薄"）
  tone(shot, t + 0.002, {
    type: def.body.type,
    f0: def.body.f0,
    f1: def.body.f1,
    dur: def.body.dur,
    gain: def.body.gain * (far ? 0.45 : 1),
    filter: 'lowpass',
    cutoff: 2000,
    q: 0.7,
  });
  // 4) 机械声：击锤 / 枪机；远距离几乎听不到
  if (far) {
    mechClick(shot, t + def.mech.t, def.mech.freq * 0.8, def.mech.gain * 0.35);
  } else {
    mechClick(shot, t + def.mech.t, def.mech.freq, def.mech.gain);
  }
  // 5) 户外拖尾：空气扩散噪声 + Convolver 湿声
  noiseBurst(shot, t + 0.025, {
    dur: def.tailDur * 0.55,
    gain: def.tailHint * 0.2,
    freq: 900,
    f1: 280,
    q: 0.5,
    type: 'bandpass',
  });
  if (far) {
    // >60m：高频基本消失，只剩低频闷响 + 延迟回音
    tone(shot, t + 0.22, { type: 'sine', f0: 70, f1: 46, dur: 0.35, gain: 0.22 });
    noiseBurst(shot, t + 0.3, {
      dur: 0.6,
      gain: 0.07,
      freq: 600,
      f1: 260,
      q: 0.4,
      type: 'bandpass',
    });
  }
  // 6) 霰弹枪泵动 / 狙击枪拉栓：枪声之后的独立机械动作
  if (!far && def.pump) {
    const pt = t + def.pump;
    mechClick(shot, pt, 820, 0.16);
    mechClick(shot, pt + 0.13, 620, 0.13);
    noiseBurst(shot, pt + 0.02, { dur: 0.08, gain: 0.06, freq: 1400, q: 2 });
  }
  if (!far && def.bolt) {
    const bt = t + def.bolt;
    mechClick(shot, bt, 1600, 0.15);
    mechClick(shot, bt + 0.17, 1050, 0.12);
    mechClick(shot, bt + 0.24, 1900, 0.08);
  }
  // 总线节点回收（各层音源由 onended 自行断开）
  disposeLater(nodes, travel + def.tailDur + 0.8);
}

// ---------- 其他音效 ----------

function _dryFire() {
  if (!audioReady() || !bus) return;
  const t = ctx.currentTime + 0.005;
  mechClick(bus.master, t, 3000, 0.16);
  mechClick(bus.master, t + 0.012, 1500, 0.09);
  tone(bus.master, t, { type: 'square', f0: 700, f1: 380, dur: 0.03, gain: 0.05 });
}

// 换弹单步机械音：step 0 卸弹匣 / 1 插弹匣 / 2 拉栓上膛 / 3 单发装填或泵动
const STEP_PITCH = { pistol: 1.15, smg: 1.2, ak47: 0.95, shotgun: 0.8, sniper: 0.9 };

function _reloadStepAt(kind, step, t) {
  if (!bus) return;
  const pitch = STEP_PITCH[kind] || 1;
  const base = 1200 * pitch;
  switch (step) {
    case 0: // 按下弹匣卡榫：清脆 click + 弹匣摩擦
      mechClick(bus.master, t, base * 1.6, 0.14);
      noiseBurst(bus.master, t + 0.01, { dur: 0.12, gain: 0.05, freq: 700, q: 0.7 });
      tone(bus.master, t + 0.02, { type: 'triangle', f0: 220 * pitch, f1: 140 * pitch, dur: 0.08, gain: 0.06 });
      break;
    case 1: // 插入新弹匣并锁定：闷响 + 锁定 click
      tone(bus.master, t, { type: 'sine', f0: 160 * pitch, f1: 90, dur: 0.09, gain: 0.12 });
      mechClick(bus.master, t + 0.035, base * 1.3, 0.16);
      break;
    case 2: // 拉栓 / 拉滑套：两段金属
      mechClick(bus.master, t, base * 1.2, 0.16);
      mechClick(bus.master, t + 0.07, base * 0.9, 0.13);
      noiseBurst(bus.master, t + 0.005, { dur: 0.05, gain: 0.05, freq: 2600, q: 1.5 });
      break;
    default: // 单发装填 / 泵动
      mechClick(bus.master, t, base * 1.5, 0.1);
      tone(bus.master, t, { type: 'triangle', f0: 300 * pitch, f1: 190, dur: 0.05, gain: 0.05 });
      break;
  }
}

// 换弹时序（[步骤, 相对延迟]），不同枪换弹动作节奏不同
const RELOAD_SEQ = {
  pistol: [[0, 0], [1, 0.34], [2, 0.62]],
  smg: [[0, 0], [1, 0.4], [2, 0.72]],
  ak47: [[0, 0], [1, 0.5], [2, 0.88]],
  shotgun: [[3, 0.05], [3, 0.24], [3, 0.42], [2, 0.6]],
  sniper: [[0, 0.1], [1, 0.5], [2, 1.0], [2, 1.26]],
};

function _reload(kind) {
  if (!audioReady() || !bus) return;
  const k = RELOAD_SEQ[kind] ? kind : 'pistol';
  const t = ctx.currentTime + 0.01;
  const seq = RELOAD_SEQ[k];
  for (let i = 0; i < seq.length; i++) _reloadStepAt(k, seq[i][0], t + seq[i][1]);
}

function _reloadStep(kind, step) {
  if (!audioReady() || !bus) return;
  const k = GUNS[kind] ? kind : 'pistol';
  const s = typeof step === 'number' ? step : 0;
  _reloadStepAt(k, s, ctx.currentTime + 0.004);
}

function _switchWeapon() {
  if (!audioReady() || !bus) return;
  const t = ctx.currentTime + 0.005;
  // 背带/衣物摩擦 + 金属卡扣
  noiseBurst(bus.master, t, { dur: 0.16, gain: 0.06, freq: 900, f1: 2200, q: 0.6, type: 'bandpass' });
  tone(bus.master, t + 0.02, { type: 'sine', f0: 180, f1: 110, dur: 0.08, gain: 0.06 });
  mechClick(bus.master, t + 0.09, 1700, 0.12);
}

// 命中反馈（世界音）：子弹打中人体，闷而湿
function _hit(part) {
  if (!audioReady() || !bus) return;
  const head = part === 'head';
  const legs = part === 'legs';
  const t = ctx.currentTime + 0.004;
  tone(bus.master, t, {
    type: 'sine',
    f0: head ? 260 : (legs ? 110 : 170),
    f1: 60,
    dur: head ? 0.13 : 0.11,
    gain: 0.16,
  });
  noiseBurst(bus.master, t, {
    dur: 0.07,
    gain: 0.12,
    freq: head ? 1600 : 900,
    f1: 350,
    q: 0.8,
  });
  if (head) {
    // 头盔 / 骨骼的脆响
    noiseBurst(bus.master, t + 0.004, { dur: 0.05, gain: 0.07, freq: 3200, q: 1.6 });
  }
}

// 命中确认（HUD 反馈音）：短促明亮的电子 tick，与"打中肉体"的 hit 区分
function _hitConfirm(part) {
  if (!audioReady() || !bus) return;
  const head = part === 'head';
  const t = ctx.currentTime + 0.003;
  tone(bus.master, t, {
    type: 'square',
    f0: head ? 2400 : 1700,
    f1: head ? 1800 : 1250,
    dur: 0.045,
    gain: 0.06,
  });
  tone(bus.master, t + 0.012, {
    type: 'sine',
    f0: head ? 3200 : 2400,
    f1: head ? 2500 : 2000,
    dur: 0.03,
    gain: 0.04,
  });
}

function _headshotConfirm() {
  if (!audioReady() || !bus) return;
  const t = ctx.currentTime + 0.003;
  tone(bus.master, t, { type: 'sine', f0: 2200, f1: 2900, dur: 0.09, gain: 0.07 });
  tone(bus.master, t + 0.055, { type: 'sine', f0: 3300, f1: 3900, dur: 0.08, gain: 0.05 });
  mechClick(bus.master, t, 2600, 0.05);
}

function _kill() {
  if (!audioReady() || !bus) return;
  const t = ctx.currentTime + 0.004;
  tone(bus.master, t, { type: 'sine', f0: 120, f1: 55, dur: 0.35, gain: 0.22 });
  tone(bus.master, t + 0.01, {
    type: 'sawtooth',
    f0: 420,
    f1: 110,
    dur: 0.22,
    gain: 0.07,
    filter: 'lowpass',
    cutoff: 1200,
    q: 0.7,
  });
  mechClick(bus.master, t + 0.03, 1800, 0.1);
  noiseBurst(bus.master, t, { dur: 0.28, gain: 0.06, freq: 700, f1: 250, q: 0.6 });
}

function _hurt() {
  if (!audioReady() || !bus) return;
  const t = ctx.currentTime + 0.003;
  noiseBurst(bus.master, t, { dur: 0.18, gain: 0.14, freq: 500, f1: 900, q: 0.7 });
  tone(bus.master, t, {
    type: 'sawtooth',
    f0: 140,
    f1: 70,
    dur: 0.25,
    gain: 0.12,
    filter: 'lowpass',
    cutoff: 700,
    q: 0.8,
  });
  tone(bus.master, t, { type: 'sine', f0: 90, f1: 50, dur: 0.22, gain: 0.12 });
}

function _death() {
  if (!audioReady() || !bus) return;
  const t = ctx.currentTime + 0.004;
  const out = ctx.createGain();
  out.gain.value = 1;
  out.connect(bus.master);
  const nodes = [out];
  const wet = sendWet(out, 0.25);
  if (wet) nodes.push(wet);
  tone(out, t, {
    type: 'sawtooth',
    f0: 220,
    f1: 45,
    dur: 1.1,
    gain: 0.18,
    filter: 'lowpass',
    cutoff: 900,
    q: 0.7,
  });
  tone(out, t, { type: 'sine', f0: 110, f1: 40, dur: 1.2, gain: 0.2 });
  noiseBurst(out, t, { dur: 0.8, gain: 0.1, freq: 600, f1: 200, q: 0.5, type: 'lowpass' });
  // 心跳式闷响
  tone(out, t + 0.22, { type: 'sine', f0: 70, f1: 38, dur: 0.3, gain: 0.16 });
  disposeLater(nodes, 2.2);
}

function _jump() {
  if (!audioReady() || !bus) return;
  const t = ctx.currentTime + 0.003;
  noiseBurst(bus.master, t, { dur: 0.12, gain: 0.07, freq: 900, f1: 2500, q: 0.6 });
  tone(bus.master, t, { type: 'sine', f0: 240, f1: 330, dur: 0.09, gain: 0.05 });
  tone(bus.master, t + 0.02, { type: 'triangle', f0: 520, f1: 700, dur: 0.05, gain: 0.025 });
}

function _land() {
  if (!audioReady() || !bus) return;
  const t = ctx.currentTime + 0.003;
  tone(bus.master, t, { type: 'sine', f0: 100, f1: 48, dur: 0.2, gain: 0.3 });
  noiseBurst(bus.master, t, { dur: 0.12, gain: 0.1, freq: 1100, f1: 400, q: 0.6, type: 'bandpass' });
  mechClick(bus.master, t + 0.01, 900, 0.08);
}

// 脚步声：按地表材质换滤波与共振，速度决定音量（避免机械重复）
const FOOT = {
  grass: { freq: 950, q: 0.7, dur: 0.09, gain: 0.09, thump: 118 },
  dirt: { freq: 700, q: 0.8, dur: 0.1, gain: 0.1, thump: 104 },
  mud: { freq: 520, q: 0.9, dur: 0.12, gain: 0.11, thump: 92 },
  road: { freq: 1700, q: 0.9, dur: 0.08, gain: 0.1, thump: 128 },
  gravel: { freq: 2200, q: 1.1, dur: 0.08, gain: 0.11, thump: 132 },
  stone: { freq: 2600, q: 1.2, dur: 0.07, gain: 0.12, thump: 138 },
  rock: { freq: 2600, q: 1.2, dur: 0.07, gain: 0.12, thump: 138 },
  wood: { freq: 800, q: 3.5, dur: 0.11, gain: 0.12, thump: 176 },
  metal: { freq: 1500, q: 5, dur: 0.16, gain: 0.1, thump: 150 },
  sand: { freq: 880, q: 0.6, dur: 0.11, gain: 0.08, thump: 100 },
};

// 脚步音量系数：兼容数值速度（m/s）与 main.js 的定性标签 'walk'|'run'|'sprint'|'crouch'
function speedFactor(speed) {
  if (typeof speed === 'string') {
    switch (speed.toLowerCase()) {
      case 'sprint': return 1.1;
      case 'run': return 0.9;
      case 'walk': return 0.65;
      case 'crouch': return 0.45;
      default: return 0.7;
    }
  }
  return Math.max(0.3, Math.min(1.1, (Number(speed) || 3) / 8.4));
}

function _footstep(surface, speed) {
  if (!audioReady() || !bus) return;
  const def = FOOT[surface] || FOOT.grass;
  const vol = speedFactor(speed);
  const t = ctx.currentTime + 0.003;
  noiseBurst(bus.master, t, {
    dur: def.dur,
    gain: def.gain * vol,
    freq: def.freq,
    q: def.q,
    rate: (0.9 + Math.random() * 0.2) * (0.94 + vol * 0.1),
  });
  tone(bus.master, t, { type: 'sine', f0: def.thump, f1: def.thump * 0.55, dur: 0.08, gain: 0.1 * vol });
  if (surface === 'wood') {
    tone(bus.master, t, { type: 'triangle', f0: 260, f1: 180, dur: 0.09, gain: 0.05 * vol });
  }
  if (surface === 'metal') {
    tone(bus.master, t, { type: 'sine', f0: 1300, f1: 900, dur: 0.2, gain: 0.035 * vol });
  }
}

function _slide() {
  if (!audioReady() || !bus) return;
  const t = ctx.currentTime + 0.003;
  noiseBurst(bus.master, t, { dur: 0.55, gain: 0.16, freq: 500, f1: 1900, q: 0.6 });
  noiseBurst(bus.master, t + 0.02, { dur: 0.4, gain: 0.12, freq: 300, f1: 150, q: 0.5, type: 'lowpass' });
  tone(bus.master, t, { type: 'sine', f0: 120, f1: 70, dur: 0.3, gain: 0.1 });
}

function _pickup(kind) {
  if (!audioReady() || !bus) return;
  const t = ctx.currentTime + 0.004;
  switch (kind) {
    case 'ak47':
    case 'shotgun':
    case 'sniper':
    case 'smg':
    case 'pistol': // 拾取武器：金属碰撞 + 上膛
      mechClick(bus.master, t, 2600, 0.14);
      mechClick(bus.master, t + 0.05, 1400, 0.1);
      noiseBurst(bus.master, t, { dur: 0.12, gain: 0.05, freq: 1800, q: 1.2 });
      tone(bus.master, t + 0.08, { type: 'square', f0: 900, f1: 1300, dur: 0.06, gain: 0.04 });
      break;
    case 'medkit': // 医疗包：柔和上扬
      tone(bus.master, t, { type: 'sine', f0: 520, f1: 780, dur: 0.25, gain: 0.07 });
      tone(bus.master, t + 0.12, { type: 'sine', f0: 780, f1: 1040, dur: 0.22, gain: 0.05 });
      noiseBurst(bus.master, t, { dur: 0.3, gain: 0.02, freq: 3000, q: 0.8, type: 'highpass' });
      break;
    case 'shield': // 护盾：能量上升 + 高频闪光
      tone(bus.master, t, { type: 'sine', f0: 600, f1: 1500, dur: 0.3, gain: 0.05 });
      noiseBurst(bus.master, t, { dur: 0.25, gain: 0.03, freq: 3200, q: 1.2, type: 'highpass' });
      break;
    case 'speed': // 加速：短促 whoosh
      noiseBurst(bus.master, t, { dur: 0.3, gain: 0.08, freq: 700, f1: 2400, q: 0.6 });
      tone(bus.master, t, { type: 'sine', f0: 900, f1: 1400, dur: 0.18, gain: 0.04 });
      break;
    default:
      tone(bus.master, t, { type: 'sine', f0: 880, f1: 1320, dur: 0.12, gain: 0.07 });
      break;
  }
}

// 重生：轻柔上扬双音 + 高频微光，避免与击杀/胜利音混淆
// 说明：spec §6.4 未列 respawn，但 Lead 的 main.js SFX_NAMES 中调用了 S.respawn()，这里做兼容实现。
function _respawn() {
  if (!audioReady() || !bus) return;
  const t = ctx.currentTime + 0.004;
  const out = ctx.createGain();
  out.gain.value = 1;
  out.connect(bus.master);
  const nodes = [out];
  const wet = sendWet(out, 0.2);
  if (wet) nodes.push(wet);
  tone(out, t, { type: 'sine', f0: 440, f1: 660, dur: 0.3, gain: 0.055, attack: 0.02 });
  tone(out, t + 0.14, { type: 'sine', f0: 660, f1: 880, dur: 0.35, gain: 0.045, attack: 0.02 });
  noiseBurst(out, t, { dur: 0.4, gain: 0.018, freq: 3200, q: 0.8, type: 'highpass', attack: 0.1 });
  disposeLater(nodes, 1.2);
}

function _heal() {
  if (!audioReady() || !bus) return;
  const t = ctx.currentTime + 0.004;
  const out = ctx.createGain();
  out.gain.value = 1;
  out.connect(bus.master);
  const nodes = [out];
  const wet = sendWet(out, 0.2);
  if (wet) nodes.push(wet);
  tone(out, t, { type: 'sine', f0: 440, f1: 880, dur: 0.5, gain: 0.06, attack: 0.06 });
  noiseBurst(out, t, { dur: 0.45, gain: 0.02, freq: 2200, q: 0.8, type: 'highpass', attack: 0.08 });
  disposeLater(nodes, 1.0);
}

function _uiClick() {
  if (!audioReady() || !bus) return;
  const t = ctx.currentTime + 0.003;
  mechClick(bus.master, t, 2400, 0.05);
  tone(bus.master, t, { type: 'square', f0: 1200, f1: 900, dur: 0.02, gain: 0.03 });
}

// 占领进度音：音高随进度上升，音量极小，避免刷屏
function _capture(progress) {
  if (!audioReady() || !bus) return;
  const p = Math.max(0, Math.min(1, Number(progress) || 0));
  const t = ctx.currentTime + 0.003;
  tone(bus.master, t, {
    type: 'triangle',
    f0: 600 + p * 600,
    f1: 700 + p * 700,
    dur: 0.06,
    gain: 0.04,
  });
  tone(bus.master, t, { type: 'sine', f0: 1200 + p * 900, dur: 0.04, gain: 0.02 });
}

function _zoneLost() {
  if (!audioReady() || !bus) return;
  const t = ctx.currentTime + 0.004;
  const out = ctx.createGain();
  out.gain.value = 1;
  out.connect(bus.master);
  const nodes = [out];
  const wet = sendWet(out, 0.25);
  if (wet) nodes.push(wet);
  tone(out, t, {
    type: 'sawtooth',
    f0: 520,
    f1: 300,
    dur: 0.45,
    gain: 0.06,
    filter: 'lowpass',
    cutoff: 1500,
    q: 0.7,
  });
  tone(out, t + 0.1, { type: 'sine', f0: 300, f1: 200, dur: 0.5, gain: 0.05 });
  noiseBurst(out, t, { dur: 0.4, gain: 0.03, freq: 800, f1: 300, q: 0.5 });
  disposeLater(nodes, 1.2);
}

// UAV：无线电提示音（三短一长 + 静噪 + 低鸣）
function _uav() {
  if (!audioReady() || !bus) return;
  const t = ctx.currentTime + 0.004;
  for (let i = 0; i < 3; i++) {
    tone(bus.master, t + i * 0.16, { type: 'square', f0: 1150, dur: 0.06, gain: 0.045 });
  }
  tone(bus.master, t + 0.56, { type: 'square', f0: 1500, dur: 0.12, gain: 0.04 });
  noiseBurst(bus.master, t, { dur: 0.6, gain: 0.015, freq: 2500, q: 0.6, type: 'highpass' });
  tone(bus.master, t, { type: 'sine', f0: 90, dur: 0.45, gain: 0.03 });
}

function _win() {
  if (!audioReady() || !bus) return;
  const t = ctx.currentTime + 0.01;
  const out = ctx.createGain();
  out.gain.value = 1;
  out.connect(bus.master);
  const nodes = [out];
  const wet = sendWet(out, 0.3);
  if (wet) nodes.push(wet);
  // 上行三和弦，钟感长衰减
  const notes = [523.25, 659.25, 783.99, 1046.5];
  for (let i = 0; i < notes.length; i++) {
    tone(out, t + i * 0.13, { type: 'sine', f0: notes[i], dur: 0.9, gain: 0.07, attack: 0.008 });
    tone(out, t + i * 0.13, { type: 'triangle', f0: notes[i] * 2, dur: 0.5, gain: 0.015 });
  }
  disposeLater(nodes, 2.0);
}

function _lose() {
  if (!audioReady() || !bus) return;
  const t = ctx.currentTime + 0.01;
  const out = ctx.createGain();
  out.gain.value = 1;
  out.connect(bus.master);
  const nodes = [out];
  const wet = sendWet(out, 0.3);
  if (wet) nodes.push(wet);
  const notes = [392, 349.23, 293.66, 220];
  for (let i = 0; i < notes.length; i++) {
    tone(out, t + i * 0.18, { type: 'triangle', f0: notes[i], dur: 0.8, gain: 0.055, attack: 0.01 });
  }
  tone(out, t, { type: 'sine', f0: 110, f1: 82, dur: 1.4, gain: 0.05, attack: 0.05 });
  disposeLater(nodes, 2.4);
}

// 子弹擦身：带多普勒感的噪声扫频 + 短促的声像偏移
function _whiz(opts) {
  if (!audioReady() || !bus) return;
  const o = opts || {};
  const pan = o.pan == null ? (Math.random() * 2 - 1) : o.pan;
  const t = ctx.currentTime + 0.002;
  const out = ctx.createGain();
  out.gain.value = 0.9;
  const panner = makePanner(pan);
  const nodes = [out];
  if (panner) {
    out.connect(panner);
    panner.connect(bus.master);
    nodes.push(panner);
  } else {
    out.connect(bus.master);
  }
  noiseBurst(out, t, { dur: 0.16, gain: 0.2, freq: 2800, f1: 600, q: 1.2, type: 'bandpass' });
  tone(out, t, { type: 'sine', f0: 2400, f1: 500, dur: 0.12, gain: 0.04 });
  const wet = sendWet(out, 0.1);
  if (wet) nodes.push(wet);
  disposeLater(nodes, 0.8);
}

// ---------- 环境声 ----------

// 随机点缀：鸟叫 / 虫鸣 / 远处狗吠 / 汽车驶过 / 阵风
function _ambientOneShot() {
  if (!amb || !ctx) return;
  const r = Math.random();
  if (r < 0.42) _ambientBird();
  else if (r < 0.72) _ambientCrickets();
  else if (r < 0.85) _ambientDog();
  else if (r < 0.94) _ambientCar();
  else _ambientGust();
}

function _ambientPanner(pan) {
  const p = makePanner(pan);
  if (!p) return null;
  try {
    p.connect(amb.out);
    disposeLater([p], 3);
  } catch { return null; }
  return p;
}

function _ambientBird() {
  if (!amb) return;
  const t = ctx.currentTime + 0.02;
  const dest = _ambientPanner((Math.random() * 2 - 1) * 0.7) || amb.out;
  const n = 2 + Math.floor(Math.random() * 3);
  const base = 2400 + Math.random() * 1600;
  for (let i = 0; i < n; i++) {
    const tt = t + i * (0.09 + Math.random() * 0.07);
    tone(dest, tt, {
      type: 'sine',
      f0: base * (0.9 + Math.random() * 0.25),
      f1: base * (1.25 + Math.random() * 0.2),
      dur: 0.05 + Math.random() * 0.04,
      gain: 0.035,
    });
  }
}

function _ambientCrickets() {
  if (!amb) return;
  const t = ctx.currentTime + 0.02;
  const dest = _ambientPanner((Math.random() * 2 - 1) * 0.8) || amb.out;
  // 两组脉冲，模拟蟋蟀连续摩擦
  for (let g = 0; g < 2; g++) {
    for (let i = 0; i < 6; i++) {
      tone(dest, t + g * 0.42 + i * 0.052, {
        type: 'sine',
        f0: 4200 + Math.random() * 300,
        f1: 4000,
        dur: 0.028,
        gain: 0.016,
      });
    }
  }
}

function _ambientDog() {
  if (!amb) return;
  const t = ctx.currentTime + 0.02;
  const dest = _ambientPanner(0.45) || amb.out;
  const n = 2 + Math.floor(Math.random() * 2);
  for (let i = 0; i < n; i++) {
    const tt = t + i * (0.26 + Math.random() * 0.08);
    tone(dest, tt, {
      type: 'sawtooth',
      f0: 210,
      f1: 130,
      dur: 0.16,
      gain: 0.03,
      filter: 'bandpass',
      cutoff: 900,
      q: 1.2,
    });
  }
}

function _ambientCar() {
  if (!amb) return;
  const t = ctx.currentTime + 0.02;
  const dur = 2.4;
  const panner = makePanner(-0.6);
  const out = ctx.createGain();
  out.gain.value = 1;
  const src = ctx.createBufferSource();
  src.buffer = ensureNoise();
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.setValueAtTime(420, t);
  f.frequency.linearRampToValueAtTime(700, t + dur * 0.4);
  f.frequency.linearRampToValueAtTime(360, t + dur);
  f.Q.value = 0.8;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.045, t + 0.7);
  g.gain.linearRampToValueAtTime(0.0001, t + dur);
  src.connect(f);
  f.connect(g);
  g.connect(out);
  if (panner) {
    try { panner.pan.linearRampToValueAtTime(0.6, t + dur); } catch { /* 忽略 */ }
    out.connect(panner);
    panner.connect(amb.out);
  } else {
    out.connect(amb.out);
  }
  src.start(t);
  src.stop(t + dur + 0.05);
  src.onended = () => {
    try {
      src.disconnect();
      f.disconnect();
      g.disconnect();
      out.disconnect();
    } catch { /* 忽略 */ }
  };
  disposeLater([panner], dur + 0.4);
}

function _ambientGust() {
  if (!amb) return;
  const t = ctx.currentTime + 0.02;
  noiseBurst(amb.out, t, {
    dur: 1.3,
    gain: 0.05,
    freq: 620,
    f1: 320,
    q: 0.4,
    attack: 0.35,
  });
}

// 递归 setTimeout 调度（不用 setInterval，避免重叠堆积；stopAmbience 会清理）
function scheduleAmbientEvent(delayMs) {
  if (!amb) return;
  const a = amb;
  a.timer = setTimeout(() => {
    a.timer = null;
    if (amb !== a) return;
    try { _ambientOneShot(); } catch { /* 忽略单次失败 */ }
    scheduleAmbientEvent(3000 + Math.random() * 7000);
  }, Math.max(600, delayMs || 4000));
}

export function startAmbience() {
  try {
    if (!initAudio() || !bus) return false;
    if (amb) return true; // 幂等
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.linearRampToValueAtTime(0.9, t + 1.5);
    out.connect(bus.master);
    const nodes = [out];
    const srcs = [];
    const lfos = [];

    // 风声底层：循环噪声 → 低通 → 带通
    const wind = ctx.createBufferSource();
    wind.buffer = ensureNoise();
    wind.loop = true;
    const windLP = ctx.createBiquadFilter();
    windLP.type = 'lowpass';
    windLP.frequency.value = 380;
    windLP.Q.value = 0.5;
    const windBP = ctx.createBiquadFilter();
    windBP.type = 'bandpass';
    windBP.frequency.value = 480;
    windBP.Q.value = 0.45;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.16;
    wind.connect(windLP);
    windLP.connect(windBP);
    windBP.connect(windGain);
    windGain.connect(out);
    wind.start(t);
    srcs.push(wind);
    nodes.push(windLP, windBP, windGain);

    // 阵风 LFO：同时调制风量与低通截止，制造强弱起伏
    const lfo1 = ctx.createOscillator();
    lfo1.type = 'sine';
    lfo1.frequency.value = 0.085;
    const lfo1g = ctx.createGain();
    lfo1g.gain.value = 0.075;
    lfo1.connect(lfo1g);
    lfo1g.connect(windGain.gain);
    const lfo2 = ctx.createOscillator();
    lfo2.type = 'sine';
    lfo2.frequency.value = 0.17;
    const lfo2g = ctx.createGain();
    lfo2g.gain.value = 130;
    lfo2.connect(lfo2g);
    lfo2g.connect(windLP.frequency);
    lfo1.start(t);
    lfo2.start(t);
    lfos.push(lfo1, lfo2);
    nodes.push(lfo1, lfo1g, lfo2, lfo2g);

    // 树叶沙沙：高频窄带噪声，随风强弱（第二 LFO 调制）
    const leaf = ctx.createBufferSource();
    leaf.buffer = ensureNoise();
    leaf.loop = true;
    leaf.playbackRate.value = 1.3;
    const leafHP = ctx.createBiquadFilter();
    leafHP.type = 'highpass';
    leafHP.frequency.value = 2400;
    const leafGain = ctx.createGain();
    leafGain.gain.value = 0.022;
    leaf.connect(leafHP);
    leafHP.connect(leafGain);
    leafGain.connect(out);
    leaf.start(t);
    srcs.push(leaf);
    nodes.push(leafHP, leafGain);
    const lfo3 = ctx.createOscillator();
    lfo3.type = 'sine';
    lfo3.frequency.value = 0.13;
    const lfo3g = ctx.createGain();
    lfo3g.gain.value = 0.012;
    lfo3.connect(lfo3g);
    lfo3g.connect(leafGain.gain);
    lfo3.start(t);
    lfos.push(lfo3);
    nodes.push(lfo3, lfo3g);

    // 环境声轻微混响，避免贴耳
    const wet = sendWet(out, 0.18);
    if (wet) nodes.push(wet);

    amb = { out, nodes, srcs, lfos, timer: null };
    scheduleAmbientEvent(4000);
    return true;
  } catch {
    amb = null;
    return false;
  }
}

export function stopAmbience() {
  try {
    if (!amb || !ctx) return;
    const a = amb;
    amb = null; // 先置空：递归调度与事件回调看到后立即停止
    if (a.timer) {
      clearTimeout(a.timer);
      a.timer = null;
    }
    const t = ctx.currentTime;
    // 淡出，避免突兀切断
    try {
      const v = a.out.gain.value;
      a.out.gain.cancelScheduledValues(t);
      a.out.gain.setValueAtTime(Math.max(0.0001, v), t);
      a.out.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    } catch { /* 忽略 */ }
    const stopAt = t + 0.6;
    for (let i = 0; i < a.srcs.length; i++) {
      try { a.srcs[i].stop(stopAt); } catch { /* 已停止 */ }
    }
    for (let i = 0; i < a.lfos.length; i++) {
      try { a.lfos[i].stop(stopAt); } catch { /* 已停止 */ }
    }
    // 0.8s 后断开全部节点，彻底回收
    disposeLater(a.nodes, 0.8);
  } catch { /* 忽略 */ }
}

// ---------- 对外接口 ----------
// 所有方法都经过 guard：即使底层节点创建失败（测试环境/浏览器限制）也绝不抛错。
function guard(fn) {
  return function guarded(...args) {
    try {
      return fn.apply(null, args);
    } catch {
      return undefined;
    }
  };
}

export const sfx = {
  shoot: guard(_shoot),
  dryFire: guard(_dryFire),
  reload: guard(_reload),
  reloadStep: guard(_reloadStep),
  switchWeapon: guard(_switchWeapon),
  hit: guard(_hit),
  hitConfirm: guard(_hitConfirm),
  headshotConfirm: guard(_headshotConfirm),
  kill: guard(_kill),
  hurt: guard(_hurt),
  death: guard(_death),
  jump: guard(_jump),
  land: guard(_land),
  respawn: guard(_respawn), // 兼容 main.js 的 S.respawn()（spec 之外的附加音效）
  footstep: guard(_footstep),
  slide: guard(_slide),
  pickup: guard(_pickup),
  heal: guard(_heal),
  uiClick: guard(_uiClick),
  capture: guard(_capture),
  zoneLost: guard(_zoneLost),
  uav: guard(_uav),
  win: guard(_win),
  lose: guard(_lose),
  whiz: guard(_whiz),
};
