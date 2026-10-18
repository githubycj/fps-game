// ===== 建筑：可进入民房 / 谷仓 / 工具房 + 木栅栏 + 边界链网 =====
// 墙体直接由 shared/world.js 的 houseWallSegments(h).segments 生成（世界空间 AABB），
// 因此视觉墙体 / 门洞 / 门楣与物理碰撞体逐位一致。
// 静态几何按材质合并：墙、屋顶、木构件、玻璃、链网、边界金属各 1 个 draw call。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { HOUSES, FENCES, BOUNDARY, WORLD, heightAt, houseWallSegments } from './shared.js';
import { makeChainlinkTexture, makeRoofNormalTexture, makeSidingNormalTexture } from './textures.js';

const WALL_COLOR = 0xd8d2c4;

// ---------- 几何工具 ----------
function paint(geo, colorHex) {
  const c = new THREE.Color(colorHex);
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

// 统一转成非索引几何并清理多余属性，保证可以 mergeGeometries
function normalize(geo) {
  let g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  const keep = new Set(['position', 'normal', 'uv', 'color']);
  for (const name of Object.keys(g.attributes)) {
    if (!keep.has(name)) g.deleteAttribute(name);
  }
  if (!g.getAttribute('uv')) {
    const n = g.getAttribute('position').count;
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  return g;
}

function pushGeo(list, geo, colorHex) {
  const g = normalize(geo);
  paint(g, colorHex);
  list.push(g);
}

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3(1, 1, 1);

function addBox(list, colorHex, cx, cy, cz, w, h, d, rx = 0, ry = 0, rz = 0) {
  const geo = new THREE.BoxGeometry(w, h, d);
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _v.set(cx, cy, cz);
  _m.compose(_v, _q, _s);
  geo.applyMatrix4(_m);
  pushGeo(list, geo, colorHex);
}

function addCylinder(list, colorHex, cx, cy, cz, r, h, seg = 7, ry = 0) {
  const geo = new THREE.CylinderGeometry(r, r, h, seg, 1, false);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0));
  const m = new THREE.Matrix4().compose(new THREE.Vector3(cx, cy, cz), q, new THREE.Vector3(1, 1, 1));
  geo.applyMatrix4(m);
  pushGeo(list, geo, colorHex);
}

// 三角山墙棱柱（本地：u 沿墙长，y 向上，挤出方向为墙厚）
function addGable(list, colorHex, h, side) {
  const d = h.d, roofH = h.roofH, t = 0.34;
  const shape = new THREE.Shape();
  shape.moveTo(-d / 2, 0);
  shape.lineTo(d / 2, 0);
  shape.lineTo(0, roofH);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 1 });
  // 旋转：挤出方向对齐世界 ±X
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, side > 0 ? Math.PI / 2 : -Math.PI / 2, 0));
  const cx = h.x + side * (h.w / 2 - t / 2);
  const m = new THREE.Matrix4().compose(new THREE.Vector3(cx - side * t / 2, h.padH + h.wallH, h.z), q, new THREE.Vector3(1, 1, 1));
  geo.applyMatrix4(m);
  pushGeo(list, geo, colorHex);
}

// ---------- 主体 ----------
export function createBuildings({ preset, anisotropy = 1 } = {}) {
  const p = preset || {};
  const group = new THREE.Group();
  group.name = 'buildings';
  const disposables = [];

  const walls = [];      // 墙板
  const roofs = [];      // 屋面
  const woods = [];      // 门窗框 / 门 / 门廊 / 室内地板 / 栅栏
  const glasses = [];    // 玻璃
  const metals = [];     // 边界立柱/横杆
  const chainlinks = []; // 边界链网

  // ================= 房屋 =================
  for (const h of HOUSES) {
    const { segments, door } = houseWallSegments(h);
    const padH = h.padH;
    const wallTop = padH + h.wallH;
    const wallColor = h.color || WALL_COLOR;
    const wallColorDark = new THREE.Color(wallColor).multiplyScalar(0.82).getHex();

    // ---- 墙体（与碰撞体同源）----
    for (const s of segments) {
      addBox(walls, wallColor, s.x, (s.y0 + s.y1) / 2, s.z, s.w, Math.max(0.05, s.y1 - s.y0), s.d);
    }
    // ---- 山墙（视觉填充，子弹可穿，属于约定允许）----
    addGable(walls, wallColorDark, h, 1);
    addGable(walls, wallColorDark, h, -1);

    // ---- 室内地板 ----
    const floorY = padH + 0.02;
    const isBarn = h.style === 'barn';
    addBox(woods, isBarn ? 0x6e5a44 : 0x8a7257, h.x, floorY, h.z, h.w - 0.5, 0.05, h.d - 0.5);

    // ---- 屋顶（人字坡，沿 X 起脊；出檐）----
    const overhang = isBarn ? 0.65 : 0.5;
    const overhangX = overhang * 0.8;
    const run = h.d / 2 + overhang;
    const halfD = h.d / 2;
    const rise = h.roofH;
    const eaveDrop = rise * overhang / halfD;
    const slopeLen = Math.hypot(run, rise + eaveDrop);
    const angle = Math.atan2(rise + eaveDrop, run);
    const roofColor = isBarn ? 0x6a4a3c : (h.style === 'shed' ? 0x54504a : (h.style === 'red' ? 0x5b4a42 : 0x4c4a46));
    const roofThick = 0.17;
    for (const side of [1, -1]) {
      const midZ = side * run / 2;
      const midY = wallTop + rise - (rise + eaveDrop) / 2;
      addBox(roofs, roofColor, h.x, midY + roofThick * 0.5, h.z + midZ,
        h.w + overhangX * 2, roofThick, slopeLen,
        side * angle, 0, 0);
    }
    // 屋脊盖板
    addBox(roofs, new THREE.Color(roofColor).multiplyScalar(0.85).getHex(), h.x, wallTop + rise + 0.08, h.z,
      h.w + overhangX * 2, 0.16, 0.42);
    // 檐口封板
    for (const side of [1, -1]) {
      addBox(woods, 0x6f6355, h.x, wallTop - eaveDrop + 0.02, h.z + side * run,
        h.w + overhangX * 2, 0.22, 0.12);
    }

    // ---- 窗户 ----
    const sides = [
      { name: 'north', nx: 0, nz: -1, face: h.z - halfD - 0.17, spanAxis: 'x' },
      { name: 'south', nx: 0, nz: 1, face: h.z + halfD + 0.17, spanAxis: 'x' },
      { name: 'west', nx: -1, nz: 0, face: h.x - h.w / 2 - 0.17, spanAxis: 'z' },
      { name: 'east', nx: 1, nz: 0, face: h.x + h.w / 2 + 0.17, spanAxis: 'z' },
    ];
    const winW = 0.95, winH = 1.15, sill = padH + 1.02;
    for (const side of sides) {
      const hasDoor = h.doorSide === side.name;
      const span = side.spanAxis === 'x' ? h.w : h.d;
      const tangent = side.spanAxis === 'x' ? 'x' : 'z';
      const n = Math.max(1, Math.min(3, Math.floor((span - 1.4) / 2.7)));
      for (let i = 0; i < n; i++) {
        const u = n === 1 ? 0 : ((i / (n - 1)) - 0.5) * (span - 2.2);
        if (hasDoor && Math.abs(u) < (h.doorW || 1.5) / 2 + 0.9) continue;
        const cx = side.spanAxis === 'x' ? h.x + u : side.face + side.nx * 0.02;
        const cz = side.spanAxis === 'x' ? side.face + side.nz * 0.02 : h.z + u;
        const cy = sill + winH / 2;
        // 玻璃（薄盒子，免朝向问题）
        if (p.glass !== false) {
          if (side.spanAxis === 'x') addBox(glasses, 0xa7c2d6, cx, cy, cz, winW, winH, 0.05);
          else addBox(glasses, 0xa7c2d6, cx, cy, cz, 0.05, winH, winW);
        }
        // 窗框（外凸 0.06）
        const frameColor = isBarn ? 0x6b5540 : 0xe7e2d6;
        const fw = 0.09, fd = 0.1;
        const off = 0.06;
        if (side.spanAxis === 'x') {
          const zz = side.face + side.nz * off;
          addBox(woods, frameColor, cx - winW / 2, cy, zz, fw, winH + 0.2, fd);
          addBox(woods, frameColor, cx + winW / 2, cy, zz, fw, winH + 0.2, fd);
          addBox(woods, frameColor, cx, cy + winH / 2, zz, winW + fw * 2, fw, fd);
          addBox(woods, frameColor, cx, cy - winH / 2, zz, winW + fw * 2, fw, fd);
          addBox(woods, 0xcfc8b8, cx, cy - winH / 2 - 0.05, zz + side.nz * 0.06, winW + 0.3, 0.07, 0.22);
        } else {
          const xx = side.face + side.nx * off;
          addBox(woods, frameColor, xx, cy, cz - winW / 2, fd, winH + 0.2, fw);
          addBox(woods, frameColor, xx, cy, cz + winW / 2, fd, winH + 0.2, fw);
          addBox(woods, frameColor, xx, cy + winH / 2, cz, fd, fw, winW + fw * 2);
          addBox(woods, frameColor, xx, cy - winH / 2, cz, fd, fw, winW + fw * 2);
          addBox(woods, 0xcfc8b8, xx, cy - winH / 2 - 0.05, cz - side.nx * 0.06, 0.22, 0.07, winW + 0.3);
        }
      }
    }

    // ---- 门框 + 半开的门扇 ----
    if (door) {
      const dirX = door.dirX, dirZ = door.dirZ;
      const tangentX = -dirZ, tangentZ = dirX;
      const frameColor = isBarn ? 0x5a4634 : 0xe4dfd2;
      const faceOff = 0.2;
      const cxf = door.x + dirX * faceOff;
      const czf = door.z + dirZ * faceOff;
      // 左右门框 + 门楣
      if (dirZ !== 0) {
        addBox(woods, frameColor, cxf + tangentX * (door.w / 2 + 0.09), padH + door.h / 2, czf, 0.18, door.h, 0.24);
        addBox(woods, frameColor, cxf - tangentX * (door.w / 2 + 0.09), padH + door.h / 2, czf, 0.18, door.h, 0.24);
        addBox(woods, frameColor, cxf, padH + door.h + 0.09, czf, door.w + 0.36, 0.18, 0.24);
      } else {
        addBox(woods, frameColor, cxf, padH + door.h / 2, czf + tangentZ * (door.w / 2 + 0.09), 0.24, door.h, 0.18);
        addBox(woods, frameColor, cxf, padH + door.h / 2, czf - tangentZ * (door.w / 2 + 0.09), 0.24, door.h, 0.18);
        addBox(woods, frameColor, cxf, padH + door.h + 0.09, czf, 0.24, 0.18, door.w + 0.36);
      }
      // 门扇：以门洞一侧为轴向外开 100°
      const open = 1.75; // rad
      const hingeX = cxf + tangentX * (door.w / 2 - 0.04);
      const hingeZ = czf + tangentZ * (door.w / 2 - 0.04);
      // 门扇方向 = 外法线绕 Y 旋转 open
      const dx = dirX * Math.cos(open) - dirZ * Math.sin(open);
      const dz = dirX * Math.sin(open) + dirZ * Math.cos(open);
      const leafW = door.w - 0.1;
      const leafCx = hingeX + dx * leafW / 2;
      const leafCz = hingeZ + dz * leafW / 2;
      const ry = Math.atan2(-dz, dx);
      addBox(woods, isBarn ? 0x4a3a2c : 0x74604a, leafCx, padH + door.h / 2 + 0.02, leafCz,
        leafW, door.h - 0.04, 0.08, 0, ry, 0);
      // 门把手（小金属块）
      addBox(woods, 0x8f8a80, leafCx + dx * (leafW / 2 - 0.14) - tangentX * 0.09,
        padH + 1.05, leafCz + dz * (leafW / 2 - 0.14) - tangentZ * 0.09, 0.07, 0.07, 0.16, 0, ry, 0);

      // ---- 门廊：台面 + 立柱 + 雨棚 + 台阶 ----
      if (!isBarn && h.id !== 'SHED') {
        const porchW = Math.max(2.6, door.w + 1.3);
        const porchD = 1.9;
        const deckY = padH + 0.12;
        const pcx = door.x + dirX * (porchD / 2 + 0.17);
        const pcz = door.z + dirZ * (porchD / 2 + 0.17);
        if (dirZ !== 0) {
          addBox(woods, 0x8a7257, pcx, deckY, pcz, porchW, 0.12, porchD);
          addBox(woods, 0x7d6950, pcx, padH + 0.03, pcz + dirZ * (porchD / 2 + 0.25), porchW + 0.2, 0.06, 0.42);
          // 立柱
          addBox(woods, 0xd9d3c4, pcx - porchW / 2 + 0.14, deckY + 1.15, pcz + dirZ * (porchD / 2 - 0.16), 0.15, 2.3, 0.15);
          addBox(woods, 0xd9d3c4, pcx + porchW / 2 - 0.14, deckY + 1.15, pcz + dirZ * (porchD / 2 - 0.16), 0.15, 2.3, 0.15);
          // 雨棚
          addBox(roofs, roofColor, pcx, deckY + 2.42, pcz, porchW + 0.4, 0.12, porchD + 0.3, dirZ * 0.14, 0, 0);
          // 台阶
          addBox(woods, 0x7d6950, pcx, padH + 0.07, pcz + dirZ * (porchD / 2 + 0.06), porchW * 0.7, 0.14, 0.3);
        } else {
          addBox(woods, 0x8a7257, pcx, deckY, pcz, porchD, 0.12, porchW);
          addBox(woods, 0x7d6950, pcx + dirX * (porchD / 2 + 0.25), padH + 0.03, pcz, 0.42, 0.06, porchW + 0.2);
          addBox(woods, 0xd9d3c4, pcx + dirX * (porchD / 2 - 0.16), deckY + 1.15, pcz - porchW / 2 + 0.14, 0.15, 2.3, 0.15);
          addBox(woods, 0xd9d3c4, pcx + dirX * (porchD / 2 - 0.16), deckY + 1.15, pcz + porchW / 2 - 0.14, 0.15, 2.3, 0.15);
          addBox(roofs, roofColor, pcx, deckY + 2.42, pcz, porchD + 0.3, 0.12, porchW + 0.4, 0, 0, -dirX * 0.14);
          addBox(woods, 0x7d6950, pcx + dirX * (porchD / 2 + 0.06), padH + 0.07, pcz, 0.3, 0.14, porchW * 0.7);
        }
      }
    }

    // ---- 烟囱（木屋才有）----
    if (!isBarn && h.id !== 'SHED') {
      const chX = h.x + h.w * 0.26;
      const chZ = h.z + h.d * 0.16;
      const chBottom = padH + h.wallH * 0.55;
      const chTop = padH + h.wallH + h.roofH * 0.62;
      addBox(woods, 0x8a5a48, chX, (chBottom + chTop) / 2, chZ, 0.72, chTop - chBottom, 0.62);
      addBox(woods, 0x9c6a54, chX, chTop + 0.06, chZ, 0.86, 0.14, 0.76);
    }

    // ---- 谷仓大门斜撑 ----
    if (isBarn) {
      const dirZ = door ? door.dirZ : 1;
      const faceZ = h.z + dirZ * (h.d / 2 + 0.2);
      const cx = h.x;
      addBox(woods, 0x5c4636, cx, padH + h.wallH * 0.5, faceZ, h.w * 0.92, 0.12, 0.1);
      addBox(woods, 0x5c4636, cx - h.w * 0.24, padH + h.wallH * 0.5, faceZ - dirZ * 0.02, h.w * 0.52, 0.1, 0.1, 0, 0, 0.62);
      addBox(woods, 0x5c4636, cx + h.w * 0.24, padH + h.wallH * 0.5, faceZ - dirZ * 0.02, h.w * 0.52, 0.1, 0.1, 0, 0, -0.62);
    }
  }

  // ================= 木栅栏 =================
  for (const f of FENCES) {
    const dx = f.x2 - f.x1, dz = f.z2 - f.z1;
    const len = Math.hypot(dx, dz);
    if (len < 0.2) continue;
    const h = f.h || 1.05;
    const base = Math.min(heightAt(f.x1, f.z1), heightAt(f.x2, f.z2)) - 0.15;
    const alongX = Math.abs(dx) >= Math.abs(dz);
    const cx = (f.x1 + f.x2) / 2, cz = (f.z1 + f.z2) / 2;
    const postColor = 0x7c6a52;
    const railColor = 0x8a7659;
    // 立柱（两端 + 中间每 ~2.2m）
    const n = Math.max(2, Math.ceil(len / 2.2) + 1);
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const px = f.x1 + dx * t, pz = f.z1 + dz * t;
      const gy = heightAt(px, pz);
      addBox(woods, postColor, px, gy + h / 2 - 0.12, pz, 0.15, h + 0.2, 0.15);
    }
    // 横杆（3 道）
    for (const k of [0.24, 0.55, 0.86]) {
      const y = base + h * k;
      if (alongX) addBox(woods, railColor, cx, y, cz, len, 0.1, 0.075);
      else addBox(woods, railColor, cx, y, cz, 0.075, 0.1, len);
    }
  }

  // ================= 边界：链网 + 立柱 =================
  const doFence = p.boundaryFence !== false;
  if (doFence) {
    const fenceH = 2.6;
    const linkTex = makeChainlinkTexture(anisotropy);
    const linkMat = new THREE.MeshStandardMaterial({
      color: 0xb9c1c5,
      map: linkTex || null,
      alphaTest: linkTex ? 0.42 : 0,
      side: THREE.DoubleSide,
      metalness: 0.55,
      roughness: 0.55,
      transparent: false,
      dithering: true,
    });
    disposables.push(linkMat);
    if (linkTex) disposables.push(linkTex);

    const posts = [];
    // 四面边界：直接从 shared 的 BOUNDARY 碰撞体推导视觉栅栏位置/长度，保证与隐形墙完全重合
    const sides = BOUNDARY.map((b) => {
      const alongX = b.w >= b.d;
      const inner = b.z < -(WORLD.half - 4) ? 0
        : b.z > (WORLD.half - 4) ? Math.PI
          : b.x < 0 ? Math.PI / 2 : -Math.PI / 2;
      return {
        cx: b.x, cz: b.z,
        len: alongX ? b.w : b.d,
        axis: alongX ? 'x' : 'z',
        ry: inner,
      };
    });
    for (const s of sides) {
      // 链网：沿边界切成 6m 小段，逐段贴合地面高度（UV 按段长缩放，网眼尺寸一致）
      const segCount = Math.max(2, Math.ceil(s.len / 6));
      const segLen = s.len / segCount;
      for (let i = 0; i < segCount; i++) {
        const t = ((i + 0.5) / segCount - 0.5) * s.len;
        const px = s.axis === 'x' ? t : s.cx;
        const pz = s.axis === 'x' ? s.cz : t;
        const plane = new THREE.PlaneGeometry(segLen, fenceH);
        const uv = plane.getAttribute('uv');
        for (let k = 0; k < uv.count; k++) {
          uv.setXY(k, uv.getX(k) * (segLen / 2.3), uv.getY(k) * (fenceH / 2.3));
        }
        const geo = normalize(plane);
        // 平面默认朝 +Z：按 ry 旋转并贴到边界线上
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, s.ry, 0));
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3(px, heightAt(px, pz) + fenceH / 2 - 0.32, pz),
          q, new THREE.Vector3(1, 1, 1)
        );
        geo.applyMatrix4(m);
        chainlinks.push(geo);
      }
      // 立柱 + 上下横杆
      const count = Math.ceil(s.len / 4);
      for (let i = 0; i <= count; i++) {
        const t = (i / count - 0.5) * s.len;
        const px = s.axis === 'x' ? t : s.cx;
        const pz = s.axis === 'x' ? s.cz : t;
        const gy = heightAt(px, pz);
        addCylinder(posts, 0x8d9498, px, gy + fenceH / 2 - 0.3, pz, 0.065, fenceH + 0.5, 6);
      }
      if (s.axis === 'x') {
        addBox(posts, 0x9aa1a5, s.cx, heightAt(s.cx, s.cz) + fenceH - 0.35, s.cz, s.len, 0.09, 0.09);
        addBox(posts, 0x9aa1a5, s.cx, heightAt(s.cx, s.cz) + 0.12, s.cz, s.len, 0.06, 0.06);
      } else {
        addBox(posts, 0x9aa1a5, s.cx, heightAt(s.cx, s.cz) + fenceH - 0.35, s.cz, 0.09, 0.09, s.len);
        addBox(posts, 0x9aa1a5, s.cx, heightAt(s.cx, s.cz) + 0.12, s.cz, 0.06, 0.06, s.len);
      }
    }
    for (const g of posts) metals.push(g);
    const chainGeo = mergeGeometries(chainlinks, false);
    if (chainGeo) {
      const chainMesh = new THREE.Mesh(chainGeo, linkMat);
      chainMesh.name = 'boundaryChainlink';
      chainMesh.castShadow = false;
      chainMesh.receiveShadow = false;
      group.add(chainMesh);
      disposables.push(chainGeo);
    }
  }

  // ================= 合并各材质 =================
  const raycastTargets = [];

  function buildMerged(list, material, name, { cast = true, receive = true, raycast = true } = {}) {
    if (!list.length) return null;
    const merged = mergeGeometries(list, false);
    for (const g of list) g.dispose();
    if (!merged) return null;
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = name;
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    group.add(mesh);
    disposables.push(merged);
    if (raycast) raycastTargets.push(mesh);
    return mesh;
  }

  const sidingNormal = makeSidingNormalTexture(anisotropy);
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.88, metalness: 0.02, dithering: true,
    normalMap: sidingNormal || null, normalScale: new THREE.Vector2(0.9, 0.9),
  });
  const roofNormal = makeRoofNormalTexture(anisotropy);
  const roofMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.82, metalness: 0.05,
    normalMap: roofNormal || null, normalScale: new THREE.Vector2(0.4, 0.4), dithering: true,
  });
  const woodMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.86, metalness: 0.02, dithering: true,
  });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.08, metalness: 0.15,
    transparent: true, opacity: 0.55, envMapIntensity: 1.7, dithering: true,
  });
  const metalMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.55, metalness: 0.6, dithering: true,
  });
  disposables.push(wallMat, roofMat, woodMat, glassMat, metalMat, roofNormal || null, sidingNormal || null);

  // 屋顶法线平铺（合并后统一按世界 UV 无法做到，这里保持缺省 UV，仅作为细节）
  if (roofNormal) { roofNormal.repeat.set(3, 3); roofNormal.needsUpdate = true; }

  buildMerged(walls, wallMat, 'houseWalls');
  buildMerged(roofs, roofMat, 'houseRoofs');
  buildMerged(woods, woodMat, 'houseWood');
  buildMerged(glasses, glassMat, 'houseGlass', { cast: false, receive: false, raycast: false });
  buildMerged(metals, metalMat, 'boundaryMetal');

  const fenceList = FENCES;
  const counts = { houses: HOUSES.length, fences: fenceList.length };

  function setQuality(next) {
    const np = next || {};
    const glassMesh = group.getObjectByName('houseGlass');
    if (glassMesh) glassMesh.visible = np.glass !== false;
  }

  function dispose() {
    for (const d of disposables) if (d && d.dispose) d.dispose();
    if (group.parent) group.parent.remove(group);
  }

  return { group, raycastTargets, counts, setQuality, dispose };
}
