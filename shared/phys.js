// ===== 通用物理 / 射线 / 命中盒（按地图上下文参数化）=====
// shared/world.js（郊区地图）保留了它自己的实现；本文件是**新地图**（潮汐湾）复用的通用版本。
// 逻辑与 shared/world.js 中的同名函数逐行等价，保证客户端预测与服务器权威一致。
//
// 用法：
//   import { createWorldPhysics } from './phys.js';
//   const api = createWorldPhysics({
//     WORLD, heightAt, terrainNormal, surfaceAt,
//     colliders: () => COLLIDERS,     // 惰性取，避免 TDZ
//     zones: () => ZONES,
//     spawns: () => SPAWNS,
//   });
//   export const { movePlayerHorizontal, stepPlayerPhysics, raycastWorld, ... } = api;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function createWorldPhysics(ctx) {
  const WORLD = ctx.WORLD;
  const heightAt = ctx.heightAt;
  const terrainNormal = ctx.terrainNormal;
  const surfaceAt = ctx.surfaceAt || (() => 'grass');
  const colliders = ctx.colliders || (() => []);
  const zones = ctx.zones || (() => []);
  const spawns = ctx.spawns || (() => ({ alpha: [{ x: 0, z: 0 }] }));

  function stanceHeight(b) {
    const s = b.stance || 'stand';
    if (s === 'crouch') return WORLD.crouchHeight ?? WORLD.playerHeight * 0.68;
    if (s === 'slide') return WORLD.slideHeight ?? WORLD.playerHeight * 0.53;
    return b.height ?? WORLD.playerHeight;
  }

  function circleOverlapsBox(x, z, r, o) {
    const hw = o.w / 2, hd = o.d / 2;
    const cx = Math.max(o.x - hw, Math.min(x, o.x + hw));
    const cz = Math.max(o.z - hd, Math.min(z, o.z + hd));
    const dx = x - cx, dz = z - cz;
    return dx * dx + dz * dz < r * r - 1e-9;
  }

  function verticalSpan(b) {
    const h = stanceHeight(b);
    return { feet: b.y, head: b.y + h };
  }

  function resolveColliders(b) {
    const r = b.radius ?? WORLD.playerRadius;
    const { feet, head } = verticalSpan(b);
    const list = colliders();
    for (let n = 0; n < 2; n++) {
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        if (head <= o.y0 + 0.02 || feet >= o.y1 - 0.02) continue;
        if (!circleOverlapsBox(b.x, b.z, r, o)) continue;
        const hw = o.w / 2, hd = o.d / 2;
        const minX = o.x - hw, maxX = o.x + hw;
        const minZ = o.z - hd, maxZ = o.z + hd;
        const cx = Math.max(minX, Math.min(b.x, maxX));
        const cz = Math.max(minZ, Math.min(b.z, maxZ));
        const dx = b.x - cx, dz = b.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 < 1e-8) {
          const pushX = Math.min(b.x - minX, maxX - b.x);
          const pushZ = Math.min(b.z - minZ, maxZ - b.z);
          if (pushX < pushZ) b.x = b.x < o.x ? minX - r : maxX + r;
          else b.z = b.z < o.z ? minZ - r : maxZ + r;
        } else {
          const d = Math.sqrt(d2);
          b.x = cx + (dx / d) * r;
          b.z = cz + (dz / d) * r;
        }
      }
    }
  }

  function movePlayerHorizontal(b, dx, dz) {
    const r = b.radius ?? WORLD.playerRadius;
    const startX = b.x, startZ = b.z;
    const grounded = b.grounded !== false;
    if (dx !== 0) {
      b.x += dx;
      resolveColliders(b);
      if (grounded && heightAt(b.x, b.z) - b.y > WORLD.maxStep) b.x = startX;
    }
    if (dz !== 0) {
      b.z += dz;
      resolveColliders(b);
      if (grounded && heightAt(b.x, b.z) - b.y > WORLD.maxStep) b.z = startZ;
    }
    resolveColliders(b);
    const lim = WORLD.half - 2.4 - r;
    b.x = clamp(b.x, -lim, lim);
    b.z = clamp(b.z, -lim, lim);
    return { blocked: Math.abs(b.x - startX) < 1e-6 && Math.abs(b.z - startZ) < 1e-6 };
  }

  function standableHeight(x, z, r, prevY, curY, grounded) {
    let g = heightAt(x, z);
    const list = colliders();
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o.kind === 'boundary') continue;
      if (o.y1 <= g) continue;
      if (!circleOverlapsBox(x, z, r, o)) continue;
      const canLand = prevY >= o.y1 - 0.06;
      const canStep = grounded && curY + WORLD.maxStep >= o.y1;
      if ((canLand || canStep) && o.y1 > g) g = o.y1;
    }
    return g;
  }

  function groundHeightAt(x, z, feetY = 0, radius = WORLD.playerRadius) {
    return standableHeight(x, z, radius, feetY, feetY, true);
  }

  function stepPlayerPhysics(b, dt) {
    const r = b.radius ?? WORLD.playerRadius;
    const height = stanceHeight(b);
    const prevY = b.y;
    b.vy -= WORLD.gravity * dt;
    b.y += b.vy * dt;
    const list = colliders();
    if (b.vy > 0) {
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        if (o.kind === 'boundary') continue;
        if (!circleOverlapsBox(b.x, b.z, r, o)) continue;
        if (prevY + height <= o.y0 + 0.02 && b.y + height > o.y0) {
          b.y = o.y0 - height;
          b.vy = 0;
          break;
        }
      }
    }
    const g = standableHeight(b.x, b.z, r, prevY, b.y, b.grounded !== false);
    if (b.y <= g) {
      b.y = g;
      if (b.vy < 0) b.vy = 0;
      b.grounded = true;
    } else {
      b.grounded = false;
    }
    resolveColliders(b);
    const lim = WORLD.half - 2.4 - r;
    b.x = clamp(b.x, -lim, lim);
    b.z = clamp(b.z, -lim, lim);
    return b;
  }

  function applyJump(b) {
    if (!b.grounded) return false;
    b.vy = WORLD.jumpSpeed;
    b.grounded = false;
    return true;
  }

  function hitboxesFor(p) {
    const crouched = p.stance === 'crouch' || p.stance === 'slide';
    const k = crouched ? (p.stance === 'slide' ? 0.52 : 0.68) : 1;
    const x = p.x, y = p.y, z = p.z;
    return {
      head: { x, y: y + WORLD.headY * k, z, r: WORLD.headR },
      body: {
        ax: x, ay: y + WORLD.bodyBottom * k, az: z,
        bx: x, by: y + WORLD.bodyTop * k, bz: z,
        r: WORLD.bodyR * (crouched ? 0.95 : 1),
      },
      legs: {
        ax: x, ay: y + WORLD.legsBottom * k, az: z,
        bx: x, by: y + WORLD.legsTop * k, bz: z,
        r: WORLD.legsR,
      },
    };
  }

  function rayTerrain(ox, oy, oz, dx, dy, dz, maxDist) {
    const startH = heightAt(ox, oz);
    if (oy < startH) {
      return { t: 0, point: { x: ox, y: oy, z: oz }, normal: terrainNormal(ox, oz), surface: surfaceAt(ox, oz), kind: 'terrain' };
    }
    let t = 0, prevT = 0, guard = 0;
    while (t < maxDist && guard++ < 600) {
      const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
      const h = heightAt(x, z);
      if (y <= h) {
        let lo = prevT, hi = t;
        for (let i = 0; i < 12; i++) {
          const m = (lo + hi) * 0.5;
          if (oy + dy * m <= heightAt(ox + dx * m, oz + dz * m)) hi = m;
          else lo = m;
        }
        const px = ox + dx * hi, py = oy + dy * hi, pz = oz + dz * hi;
        return { t: hi, point: { x: px, y: py, z: pz }, normal: terrainNormal(px, pz), surface: surfaceAt(px, pz), kind: 'terrain' };
      }
      prevT = t;
      const gap = y - h;
      t += clamp(gap * 0.55, 0.35, 1.8);
    }
    return null;
  }

  function rayAABB(ox, oy, oz, dx, dy, dz, o) {
    const minx = o.x - o.w / 2, maxx = o.x + o.w / 2;
    const miny = o.y0, maxy = o.y1;
    const minz = o.z - o.d / 2, maxz = o.z + o.d / 2;
    let tmin = 0, tmax = Infinity;
    let nAxis = 0, nSign = 0, axis = 0;
    const axes = [[ox, dx, minx, maxx], [oy, dy, miny, maxy], [oz, dz, minz, maxz]];
    for (let i = 0; i < 3; i++) {
      const origin = axes[i][0], dir = axes[i][1], mn = axes[i][2], mx = axes[i][3];
      if (Math.abs(dir) < 1e-9) {
        if (origin < mn || origin > mx) return null;
      } else {
        let t1 = (mn - origin) / dir;
        let t2 = (mx - origin) / dir;
        let sign = -1;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; sign = 1; }
        if (t1 > tmin) { tmin = t1; nAxis = axis; nSign = sign; }
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) return null;
      }
      axis++;
    }
    if (tmin <= 0 || tmin >= 1e9) return null;
    return { t: tmin, nx: nAxis === 0 ? nSign : 0, ny: nAxis === 1 ? nSign : 0, nz: nAxis === 2 ? nSign : 0 };
  }

  function raycastWorld(ox, oy, oz, dx, dy, dz, maxDist = 200) {
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-9) return null;
    dx /= len; dy /= len; dz /= len;
    let best = rayTerrain(ox, oy, oz, dx, dy, dz, maxDist);
    let bestMat = best ? best.surface : 'grass';
    const list = colliders();
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      const hit = rayAABB(ox, oy, oz, dx, dy, dz, o);
      if (!hit) continue;
      if (hit.t > maxDist) continue;
      if (!best || hit.t < best.t) {
        best = {
          t: hit.t,
          point: { x: ox + dx * hit.t, y: oy + dy * hit.t, z: oz + dz * hit.t },
          normal: { x: hit.nx, y: hit.ny, z: hit.nz },
          surface: o.material || 'wood',
          kind: o.kind,
        };
        bestMat = o.material || 'wood';
      }
    }
    if (best) best.surface = bestMat;
    return best;
  }

  function losBlocked(ox, oy, oz, ex, ey, ez) {
    const dx = ex - ox, dy = ey - oy, dz = ez - oz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.05) return false;
    const hit = raycastWorld(ox, oy, oz, dx, dy, dz, dist);
    return !!hit && hit.t < dist - 0.15;
  }

  function zoneOf(x, z) {
    const zs = zones();
    for (let i = 0; i < zs.length; i++) {
      const zn = zs[i];
      const dx = x - zn.x, dz = z - zn.z;
      if (dx * dx + dz * dz <= zn.r * zn.r) return zn;
    }
    return null;
  }

  function pickSpawn(team = 'alpha', rng = Math.random) {
    const all = spawns();
    const list = all[team] || all.alpha || [];
    if (!list.length) return { x: 0, z: 0 };
    for (let i = 0; i < 10; i++) {
      const s = list[Math.floor(rng() * list.length)];
      let blocked = false;
      const cls = colliders();
      for (let k = 0; k < cls.length; k++) {
        if (circleOverlapsBox(s.x, s.z, WORLD.playerRadius + 0.5, cls[k])) { blocked = true; break; }
      }
      if (!blocked) return { x: s.x, z: s.z };
    }
    return { x: list[0].x, z: list[0].z };
  }

  function isWalkableAt(x, z, slopeLimit = WORLD.maxSlope) {
    if (Math.abs(x) > WORLD.half - 3 || Math.abs(z) > WORLD.half - 3) return false;
    const g = heightAt(x, z);
    const R = WORLD.playerRadius + 0.35;
    const list = colliders();
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o.y1 <= g + 0.25) continue;
      if (o.y0 > g + WORLD.playerHeight) continue;
      if (circleOverlapsBox(x, z, R, o)) return false;
    }
    const n = terrainNormal(x, z);
    const slope = Math.hypot(n.x, n.z) / Math.max(0.001, n.y);
    return slope <= slopeLimit;
  }

  return {
    circleOverlapsBox,
    movePlayerHorizontal,
    groundHeightAt,
    stepPlayerPhysics,
    applyJump,
    hitboxesFor,
    raycastWorld,
    losBlocked,
    zoneOf,
    pickSpawn,
    isWalkableAt,
  };
}
