// ===== Tidewater 烘焙几何加载器 =====
// 读取 /data/tidewater/geo.bin.gz（由 tools/bake-tidewater.mjs 直接运行上游 dgreenheck/tidewater 生成），
// 解析成 three.js 可以直接使用的 typed array。容器格式见 docs/tidewater-data.md。
//
// 本模块在 import 阶段就发起 fetch（顶层 await），因此 buildWorld 可以保持同步；
// vite 构建 target 需要 >= es2022（见 vite.config.js）。
//
// 依赖：DecompressionStream('gzip')（Chrome 80+/Edge/Safari 16.4+）。不可用时抛出明确错误。

import * as THREE from 'three';

const URL_GEO = new URL('data/tidewater/geo.bin.gz', document.baseURI).href;

function inflate(bytes) {
  if (typeof DecompressionStream === 'function') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
  }
  // 极老浏览器：退回同步方式不可行，直接报错（项目只支持现代 Chrome）。
  throw new Error('[tidewater] 浏览器不支持 DecompressionStream，无法解压地图几何');
}

function readHeader(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, 12);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'TDW1') throw new Error('[tidewater] geo.bin.gz 魔数不正确：' + magic);
  const headerLen = dv.getUint32(4, true);
  const headerOff = 12;
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(headerOff, headerOff + headerLen)));
  return { header, payload: bytes.subarray(headerOff + headerLen) };
}

const ATTR_CTOR = {
  i16: Int16Array, u16: Uint16Array, i8: Int8Array, u8: Uint8Array,
  f32: Float32Array, u32: Uint32Array,
};

/**
 * 把容器里的一个 buffer 包成 typed array 视图（不做 dequantize）。
 * @param {object} header 容器头
 * @param {Uint8Array} payload 数据段
 * @param {string} name buffer 名
 */
function viewBuffer(header, payload, name) {
  const b = header.buffers.find((x) => x.name === name);
  if (!b) throw new Error('[tidewater] 缺少 buffer: ' + name);
  const Ctor = ATTR_CTOR[b.type];
  if (!Ctor) throw new Error('[tidewater] 未知 buffer 类型: ' + b.type);
  const count = b.byteLength / Ctor.BYTES_PER_ELEMENT;
  const start = payload.byteOffset + b.byteOffset;
  // 拷贝一份，避免对齐/生命周期问题（一次性加载，成本可接受）
  const src = new Ctor(payload.buffer.slice(start, start + b.byteLength));
  return { array: src, count, type: b.type };
}

function dequant(entry, scale) {
  const src = entry.array;
  const out = new Float32Array(src.length);
  if (scale === 1) { for (let i = 0; i < src.length; i++) out[i] = src[i]; return out; }
  for (let i = 0; i < src.length; i++) out[i] = src[i] * scale;
  return out;
}

class TidewaterGeo {
  constructor(header, payload) {
    this.header = header;
    this.region = header.region;
    this._payload = payload;
    this._attrCache = new Map();
  }

  /** 解析一个 mesh 的全部属性（返回 Float32Array / Uint32Array） */
  mesh(name) {
    const m = this.header.meshes.find((x) => x.name === name);
    if (!m) return null;
    const out = { name: m.name, kind: m.kind, vertexCount: m.vertexCount, groups: m.groups || [], bounds: m.bounds || null, attrs: {} };
    for (const [attr, spec] of Object.entries(m.attrs)) {
      const key = name + ':' + attr;
      if (!this._attrCache.has(key)) {
        this._attrCache.set(key, dequant(viewBuffer(this.header, this._payload, spec.buffer), spec.scale ?? 1));
      }
      out.attrs[attr] = this._attrCache.get(key);
    }
    if (m.indices) {
      const idx = viewBuffer(this.header, this._payload, m.indices.buffer);
      out.index = idx.type === 'u32' ? new Uint32Array(idx.array) : new Uint16Array(idx.array);
    }
    return out;
  }

  /** 生成 three.BufferGeometry（属性/索引就绪，材质由调用方决定） */
  geometry(name) {
    const m = this.mesh(name);
    if (!m) return null;
    const g = new THREE.BufferGeometry();
    for (const [attr, arr] of Object.entries(m.attrs)) {
      // tint/vdata 是自定义属性，three 中保持原名（ShaderMaterial 里直接 attribute 声明）
      g.setAttribute(attr, new THREE.BufferAttribute(arr, attr === 'position' ? 3 : attr === 'normal' ? 3 : attr === 'uv' ? 2 : attr === 'tint' ? 3 : attr === 'vdata' ? 4 : attr === 'ao' ? 1 : 1));
    }
    if (m.index) g.setIndex(new THREE.BufferAttribute(m.index, 1));
    const b = m.bounds;
    if (b) {
      g.boundingBox = new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max));
      g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    }
    return g;
  }

  /** 遮罩：u8，res×res，行优先（j*res+i） */
  mask(name) {
    const spec = (this.header.masks || []).find((x) => x.name === name);
    if (!spec) return null;
    return viewBuffer(this.header, this._payload, spec.buffer).array;
  }

  /** 岩石实例：{ styles:[{style, mesh, start, count}], matrices: Float32Array(stride 16) } */
  rockInstances() {
    const spec = this.header.rockInstances;
    if (!spec) return null;
    const buf = viewBuffer(this.header, this._payload, spec.buffer);
    return { styles: spec.styles || [], matrices: buf.array, stride: spec.stride || 16 };
  }

  /** 植被记录：{ types:[], stride, count, data: Float32Array }，每条 [typeIdx,x,y,z,s,sy,yaw,seed,H,0] */
  vegetation() {
    const spec = this.header.vegetation;
    if (!spec) return null;
    const buf = viewBuffer(this.header, this._payload, spec.buffer);
    return { types: spec.types || [], stride: spec.stride || 10, count: spec.count || 0, data: buf.array };
  }

  /** 窗口高度：Float32Array，res×res（行优先），窗口外为边缘值 */
  heights() {
    const spec = this.header.heights;
    if (!spec) return null;
    const buf = viewBuffer(this.header, this._payload, spec.buffer);
    const scale = spec.scale ?? 0.01;
    const res = spec.res ?? this.region.res;
    const out = new Float32Array(res * res);
    for (let i = 0; i < out.length; i++) out[i] = buf.array[i] * scale;
    return out;
  }

  /**
   * 远景整岛高度（8 m 网格，覆盖可玩窗口外侧的整座岛）。
   * @returns {{region:{x0:number,z0:number,size:number,texel:number,res:number}, heights:Float32Array}|null}
   */
  island() {
    const spec = this.header.island;
    if (!spec) return null;
    const buf = viewBuffer(this.header, this._payload, spec.buffer);
    const scale = spec.scale ?? 0.01;
    const heights = new Float32Array(buf.count);
    for (let i = 0; i < heights.length; i++) heights[i] = buf.array[i] * scale;
    return {
      region: { x0: spec.x0, z0: spec.z0, size: spec.size, texel: spec.texel, res: spec.res },
      heights,
    };
  }
}

async function load() {
  const res = await fetch(URL_GEO);
  if (!res.ok) throw new Error('[tidewater] 无法加载地图几何：' + URL_GEO + '（HTTP ' + res.status + '）');
  const gz = new Uint8Array(await res.arrayBuffer());
  const bytes = new Uint8Array(await inflate(gz));
  const { header, payload } = readHeader(bytes);
  return new TidewaterGeo(header, payload);
}

/** 顶层 await：import 完成后几何就已就绪（buildWorld 因此可以保持同步）。 */
export const GEO = await load();
export const TDW_URL = URL_GEO;
