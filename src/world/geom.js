// ===== 几何拼装工具 =====
// 把大量程序化小几何（盒子/圆柱/自定义）统一成「position + normal + uv + color」后合并，
// 便于按材质压成单个 draw call。颜色写进顶点色，材质统一用 vertexColors。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _one = new THREE.Vector3(1, 1, 1);

// 统一为非索引几何 + 只保留必要属性（mergeGeometries 要求属性集合一致）
export function normalizeGeo(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
  }
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  if (!g.getAttribute('uv')) {
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
  }
  return g;
}

// 顶点色（线性空间）
export function paintGeo(geo, color) {
  const c = color && color.isColor ? color : new THREE.Color(color);
  const count = geo.getAttribute('position').count;
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

export function pushPainted(list, geo, color) {
  const g = normalizeGeo(geo);
  paintGeo(g, color);
  list.push(g);
  return g;
}

export function addBoxGeo(list, color, cx, cy, cz, w, h, d, rx = 0, ry = 0, rz = 0) {
  const geo = new THREE.BoxGeometry(w, h, d);
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _v.set(cx, cy, cz);
  _m.compose(_v, _q, _one);
  geo.applyMatrix4(_m);
  return pushPainted(list, geo, color);
}

export function addCylGeo(list, color, cx, cy, cz, rTop, rBottom, h, seg = 8, rx = 0, ry = 0, rz = 0) {
  const geo = new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1, false);
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _v.set(cx, cy, cz);
  _m.compose(_v, _q, _one);
  geo.applyMatrix4(_m);
  return pushPainted(list, geo, color);
}

export function addTorusGeo(list, color, cx, cy, cz, radius, tube, seg = 10, tubeSeg = 6, rx = 0, ry = 0, rz = 0) {
  const geo = new THREE.TorusGeometry(radius, tube, tubeSeg, seg);
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _v.set(cx, cy, cz);
  _m.compose(_v, _q, _one);
  geo.applyMatrix4(_m);
  return pushPainted(list, geo, color);
}

// 把任意几何按 位置/欧拉角/缩放 变换后并入列表
export function addTransformedGeo(list, color, geo, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1 } = {}) {
  const g = geo.clone();
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _v.set(x, y, z);
  _m.compose(_v, _q, new THREE.Vector3(sx, sy, sz));
  g.applyMatrix4(_m);
  return pushPainted(list, g, color);
}

// 合并已上色几何（会释放源几何）
export function mergePainted(list) {
  if (!list.length) return null;
  const merged = mergeGeometries(list, false);
  for (const g of list) g.dispose();
  list.length = 0;
  if (merged) merged.computeBoundingSphere();
  return merged;
}
