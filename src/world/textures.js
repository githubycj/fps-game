// ===== 程序化贴图（Canvas 生成，零外部资源）=====
// 所有贴图都必须在没有 DOM 的环境（Node 冒烟测试）安全返回 null。
// 约定：颜色贴图使用 SRGBColorSpace；法线贴图保持线性、RepeatWrapping。
import * as THREE from 'three';

function makeCanvas(w, h) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function toTexture(canvas, { srgb = true, repeat = true, anisotropy = 1 } = {}) {
  if (!canvas) return null;
  const tex = new THREE.CanvasTexture(canvas);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
  }
  tex.anisotropy = Math.max(1, anisotropy | 0);
  tex.needsUpdate = true;
  return tex;
}

// 周期噪声（整数频率正弦叠加）：保证贴图四边无缝平铺
function periodicHeight(u, v) {
  const TAU = Math.PI * 2;
  let h = 0;
  h += Math.sin(TAU * (3 * u + 2 * v) + 1.7) * 0.42;
  h += Math.sin(TAU * (5 * u - 7 * v) + 4.1) * 0.24;
  h += Math.sin(TAU * (11 * u + 13 * v) + 2.3) * 0.13;
  h += Math.sin(TAU * (17 * u - 19 * v) + 5.9) * 0.07;
  h += Math.sin(TAU * (29 * u + 23 * v) + 0.6) * 0.035;
  return h;
}

function normalFromHeight(fn, size, strength) {
  const canvas = makeCanvas(size, size);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const data = img.data;
  const inv = 1 / size;
  const sample = (x, y) => fn(((x % size) + size) % size * inv, ((y % size) + size) % size * inv);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (sample(x + 1, y) - sample(x - 1, y)) * strength;
      const dy = (sample(x, y + 1) - sample(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      data[i] = (nx * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * 0.5 + 0.5) * 255;
      data[i + 2] = (nz * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(canvas, { srgb: false });
}

// 地面细节法线：泥土/草地的微起伏（约 3m 一个平铺单元）
export function makeGroundNormalTexture(anisotropy = 1) {
  const tex = normalFromHeight(periodicHeight, 256, 9);
  return tex;
}

// 地面细节颜色贴图：与顶点色相乘的灰阶细节（草叶纹理 / 土壤颗粒 / 碎石斑点）
// 顶点色负责大色块，这张贴图负责近处细节，避免大面积平坦单色。
export function makeGroundDetailTexture(anisotropy = 1) {
  const size = 256;
  const canvas = makeCanvas(size, size);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const data = img.data;
  const TAU = Math.PI * 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      // 大颗粒 + 中颗粒（周期噪声保证无缝平铺）
      let n = 0.5 + periodicHeight(u, v) * 0.42;
      n += Math.sin(TAU * (37 * u + 29 * v) + 1.9) * 0.06;
      n += Math.sin(TAU * (71 * u - 53 * v) + 4.7) * 0.04;
      // 细草叶纹理：窄条状明暗
      n += Math.pow(Math.abs(Math.sin(TAU * (113 * u + 17 * v) + Math.sin(TAU * 13 * v))), 10) * 0.07;
      n = Math.max(0.58, Math.min(1.06, 0.72 + n * 0.36));
      const value = Math.round(n * 255);
      const i = (y * size + x) * 4;
      // 轻微暖偏：草地/泥土都能用
      data[i] = value;
      data[i + 1] = Math.min(255, Math.round(value * 0.99));
      data[i + 2] = Math.min(255, Math.round(value * 0.94));
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(canvas, { srgb: true, anisotropy });
}

// 房屋墙板（横向搭接板）法线
export function makeSidingNormalTexture(anisotropy = 1) {
  const tex = normalFromHeight((u, v) => {
    const TAU = Math.PI * 2;
    // 每张贴图 14 条横向板缝
    const bands = Math.sin(TAU * (14 * v)) * 0.8;
    const grain = Math.sin(TAU * (7 * u + 3 * v)) * 0.04;
    return bands + grain;
  }, 128, 5);
  return tex;
}

// 屋顶瓦片法线
export function makeRoofNormalTexture(anisotropy = 1) {
  return normalFromHeight((u, v) => {
    const TAU = Math.PI * 2;
    return Math.sin(TAU * (18 * u)) * 0.35 + Math.sin(TAU * (9 * v)) * 0.25 + Math.sin(TAU * (37 * u + 5 * v)) * 0.08;
  }, 128, 6);
}

// 边界链网（铁丝网）：透明背景 + 菱形网格
export function makeChainlinkTexture(anisotropy = 1) {
  const size = 128;
  const canvas = makeCanvas(size, size);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(208,214,218,1)';
  ctx.lineWidth = 2.4;
  ctx.lineCap = 'round';
  // 两个方向的斜线，形成菱形网格（步长需整除尺寸以保证平铺）
  for (let i = -size; i <= size * 2; i += 16) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + size, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(i, size); ctx.lineTo(i + size, 0); ctx.stroke();
  }
  return toTexture(canvas, { srgb: true, repeat: true, anisotropy });
}

// 天空云层：白色 fbm 透明度贴图
export function makeCloudTexture(seed = 1337, anisotropy = 1) {
  const size = 512;
  const canvas = makeCanvas(size, size);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const data = img.data;
  // 简易 fbm（整数频率 + 固定种子哈希，保证平铺）
  const hash = (ix, iy) => {
    let h = Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263) + Math.imul(seed, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
  const smooth = (t) => t * t * (3 - 2 * t);
  const noise = (x, y) => {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = smooth(x - x0), fy = smooth(y - y0);
    const x1 = (x0 + 1) % size, y1 = (y0 + 1) % size;
    const a = hash(x0 % size, y0 % size), b = hash(x1, y0 % size);
    const c = hash(x0 % size, y1), d = hash(x1, y1);
    const ab = a + (b - a) * fx, cd = c + (d - c) * fx;
    return ab + (cd - ab) * fy;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let n = 0, amp = 0.55, freq = 3 / size;
      let fx = x * (3 / size), fy = y * (3 / size);
      for (let o = 0; o < 5; o++) {
        n += noise(fx, fy) * amp;
        fx *= 2.03; fy *= 2.03; amp *= 0.5;
      }
      const a = Math.max(0, Math.min(1, (n - 0.52) * 3.4));
      const alpha = Math.pow(a, 1.35);
      const i = (y * size + x) * 4;
      data[i] = 255; data[i + 1] = 252; data[i + 2] = 248;
      data[i + 3] = alpha * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(canvas, { srgb: true, repeat: true, anisotropy });
}

// 太阳光晕（Sprite 用，加色混合）
export function makeSunGlowTexture() {
  const size = 128;
  const canvas = makeCanvas(size, size);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, 'rgba(255,252,240,1)');
  g.addColorStop(0.12, 'rgba(255,246,220,0.95)');
  g.addColorStop(0.3, 'rgba(255,232,190,0.42)');
  g.addColorStop(0.62, 'rgba(255,224,180,0.12)');
  g.addColorStop(1.0, 'rgba(255,220,170,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = toTexture(canvas, { srgb: true, repeat: false });
  if (tex) tex.needsUpdate = true;
  return tex;
}

// 锈蚀钢材（输电塔）：灰钢 + 锈斑 + 流锈
export function makeRustTexture(anisotropy = 1) {
  const size = 256;
  const canvas = makeCanvas(size, size);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const data = img.data;
  const hash = (ix, iy) => {
    let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + 981;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
  const smooth = (t) => t * t * (3 - 2 * t);
  const noise = (x, y) => {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = smooth(x - x0), fy = smooth(y - y0);
    const x1 = (x0 + 1) % size, y1 = (y0 + 1) % size;
    const a = hash(x0 % size, y0 % size), b = hash(x1, y0 % size);
    const c = hash(x0 % size, y1), d = hash(x1, y1);
    const ab = a + (b - a) * fx, cd = c + (d - c) * fx;
    return ab + (cd - ab) * fy;
  };
  const base = [106, 100, 92];
  const rust = [128, 76, 46];
  const rustDark = [86, 55, 38];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let n = 0, amp = 0.6, fx = x * 0.09, fy = y * 0.09;
      for (let o = 0; o < 4; o++) { n += noise(fx, fy) * amp; fx *= 2.1; fy *= 2.1; amp *= 0.5; }
      const t = Math.max(0, Math.min(1, (n - 0.46) * 2.6));
      // 竖向流锈
      const streak = noise(x * 0.5, y * 0.03) * 0.35;
      const k = Math.max(0, Math.min(1, t + streak * t));
      const src = k > 0.55 ? rustDark : rust;
      const i = (y * size + x) * 4;
      data[i] = base[0] + (src[0] - base[0]) * k;
      data[i + 1] = base[1] + (src[1] - base[1]) * k;
      data[i + 2] = base[2] + (src[2] - base[2]) * k;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(canvas, { srgb: true, repeat: true, anisotropy });
}

// 旧木板（栅栏/道具箱）：木纹 + 结疤
export function makeWoodTexture(anisotropy = 1) {
  const size = 256;
  const canvas = makeCanvas(size, size);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const data = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 沿 x 方向的木纹
      const grain = Math.sin(y * 0.55 + Math.sin(x * 0.021) * 5.2) * 0.5 + 0.5;
      const fine = Math.sin(y * 2.7 + x * 0.13) * 0.5 + 0.5;
      const v = 0.72 + grain * 0.2 + fine * 0.08;
      const i = (y * size + x) * 4;
      data[i] = 138 * v;
      data[i + 1] = 110 * v;
      data[i + 2] = 82 * v;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(canvas, { srgb: true, repeat: true, anisotropy });
}

// 混凝土（基座/障碍）
export function makeConcreteTexture(anisotropy = 1) {
  const size = 128;
  const canvas = makeCanvas(size, size);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const data = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = (Math.sin(x * 0.7 + y * 0.31) * 0.5 + 0.5) * 0.12 + (Math.sin(x * 2.3 - y * 1.7) * 0.5 + 0.5) * 0.1;
      const v = 0.7 + n;
      const i = (y * size + x) * 4;
      data[i] = 150 * v;
      data[i + 1] = 148 * v;
      data[i + 2] = 140 * v;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(canvas, { srgb: true, repeat: true, anisotropy });
}

export function disposeTextures(list) {
  for (const tex of list) if (tex && tex.dispose) tex.dispose();
}
