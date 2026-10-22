// ===== 潮汐湾 TIDEWATER · 场景装配层 =====
// 把海岛地形、海面、渔村、栈桥、道具、植被、天空/光照/后期装配成与 buildWorld 同形的对象。
// 契约与 src/world.js（郊区地图）保持一致，main.js 只依赖这份接口，不关心是哪张地图。
//
// 数据一律来自 shared/active.js（MAP_ID=tidewater 时即 shared/tidewater.js），
// 本模块不复制任何地形高度、碰撞体或布局常量。
import * as THREE from 'three';
import { SUN, WORLD, TREES, MAP_EXTRAS } from '../shared.js';
import { resolveQuality, presetOf, isQuality, isSoftwareRenderer } from '../quality.js';
import { createSky } from '../sky.js';
import { createLighting } from '../lighting.js';
import { createItemFactory } from '../items.js';
import { createPost } from '../post.js';
import { createTerrain } from './terrain.js';
import { createOcean } from './ocean.js';
import { createVillage } from './village.js';
import { createPier } from './pier.js';
import { createProps } from './props.js';
import { createVegetation } from './vegetation.js';

export function buildTidewaterWorld(scene, renderer, opts = {}) {
  if (!scene) throw new Error('buildTidewaterWorld: 需要 THREE.Scene');

  const soft = opts.soft != null ? !!opts.soft : isSoftwareRenderer(renderer);
  let quality = resolveQuality({ ...opts, soft }, renderer);
  let preset = presetOf(quality);

  let anisotropy = 1;
  try {
    if (renderer && renderer.capabilities && renderer.capabilities.getMaxAnisotropy) {
      anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy() || 1);
    }
  } catch (e) { anisotropy = 1; }

  const extras = MAP_EXTRAS || {};

  // 地形网格分辨率按地图尺寸放大：320m 的地图若沿用郊区 240m 的分段数，
  // 每个格会到 2.8m，沙滩/坡面会出现明显大三角面。
  const TERRAIN_SCALE = Math.max(1, WORLD.size / 240);
  function terrainPresetOf(p) {
    return { ...p, terrainSegments: Math.round(Math.max(160, (p.terrainSegments || 176) * TERRAIN_SCALE)) };
  }

  // ---------- 基础场景 ----------
  scene.background = new THREE.Color(SUN.fogColor);
  scene.fog = null;

  const lighting = createLighting(scene, { renderer, preset });
  const sky = createSky(scene, { renderer, preset, anisotropy });

  // ---------- 海岛地形 ----------
  let terrain = createTerrain({ preset: terrainPresetOf(preset), anisotropy, extras });
  scene.add(terrain.group);

  // ---------- 海面（Gerstner 波 + 近岸白沫）----------
  let ocean = null;
  try {
    ocean = createOcean({ preset, anisotropy, extras });
    scene.add(ocean.group);
  } catch (e) {
    console.warn('[tidewater] 海面创建失败：', e && e.message);
    ocean = null;
  }

  // ---------- 渔村 / 栈桥 / 道具 / 植被 ----------
  const village = createVillage({ preset, anisotropy, extras });
  scene.add(village.group);
  const pier = createPier({ preset, anisotropy, extras });
  scene.add(pier.group);
  const props = createProps({ preset, anisotropy, extras });
  scene.add(props.group);
  const vegetation = createVegetation({ preset, anisotropy, extras, trees: TREES });
  scene.add(vegetation.group);

  // ---------- 拾取物工厂 ----------
  const items = createItemFactory({ preset });

  // ---------- 后期 ----------
  let post = null;
  if (preset.post && renderer) {
    try {
      post = createPost(scene, renderer, preset);
    } catch (e) {
      post = null;
    }
  }

  // ---------- 视觉射线目标 ----------
  const raycastTargets = [];
  function refreshRaycastTargets() {
    raycastTargets.length = 0;
    raycastTargets.push(
      ...terrain.raycastTargets,
      ...village.raycastTargets,
      ...pier.raycastTargets,
      ...props.raycastTargets
    );
  }
  refreshRaycastTargets();

  // ---------- 逐帧状态 ----------
  let time = 0;
  let lastDt = 0.016;
  let lastCamera = null;
  const _target = new THREE.Vector3();
  const _playerPos = new THREE.Vector3();

  function resolveTargetPos(ctx) {
    if (ctx && ctx.playerPos && Number.isFinite(ctx.playerPos.x)) {
      _playerPos.set(ctx.playerPos.x, ctx.playerPos.y || 0, ctx.playerPos.z);
      return _playerPos;
    }
    const cam = (ctx && ctx.camera) || lastCamera;
    if (cam) {
      _playerPos.set(cam.position.x, Math.max(0, cam.position.y - WORLD.eyeHeight), cam.position.z);
      return _playerPos;
    }
    return null;
  }

  function update(dt = 0.016, ctx = {}) {
    const step = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0.016;
    time += step;
    lastDt = step;
    const camera = ctx.camera || lastCamera;
    if (camera) lastCamera = camera;

    updateEnv(step);

    const target = resolveTargetPos(ctx);
    if (target) _target.copy(target);
    lighting.update(step, target);

    sky.update(step, camera);
    if (ocean) ocean.update(step, { camera, playerPos: target, time });
    vegetation.update(step, target);
    village.update(step, target);
    pier.update(step, target);
    props.update(step, target);
    items.update(step);
  }

  function render(camera) {
    if (!renderer) return;
    if (camera) lastCamera = camera;
    if (!lastCamera) return;
    if (post) post.render(lastCamera, lastDt);
    else renderer.render(scene, lastCamera);
  }

  // ---------- 昼夜切换（/dark /light），热带海岸版本的配色 ----------
  const DAY = {
    exposure: SUN.exposure ?? 1.02,
    sun: SUN.intensity ?? 3.0,
    sunColor: new THREE.Color(SUN.color ?? 0xfff2dd),
    hemiSky: new THREE.Color(SUN.hemiSky ?? 0xbcd6dd),
    hemiGround: new THREE.Color(SUN.hemiGround ?? 0x8f8a6e),
    hemi: SUN.hemiIntensity ?? 1.1,
    fill: 0.20,
    fog: new THREE.Color(SUN.fogColor ?? 0xbcd6dd),
    zenith: new THREE.Color(0x2f6fa8),
    horizon: new THREE.Color(0xc4dde3),
    haze: new THREE.Color(0xf0e2c8),
    ground: new THREE.Color(0x8f8a6e),
    sunSprite: new THREE.Color(0xfff3d8),
    skyIntensity: 1.0,
  };
  const NIGHT = {
    exposure: 0.82,
    sun: 0.28,
    sunColor: new THREE.Color(0x9fb6d8),
    hemiSky: new THREE.Color(0x1d2c44),
    hemiGround: new THREE.Color(0x0b1018),
    hemi: 0.40,
    fill: 0.06,
    fog: new THREE.Color(0x081018),
    zenith: new THREE.Color(0x040814),
    horizon: new THREE.Color(0x101a2c),
    haze: new THREE.Color(0x182234),
    ground: new THREE.Color(0x080b12),
    sunSprite: new THREE.Color(0x9fb6d8),
    skyIntensity: 0.18,
  };
  let envMode = 'day';
  let envT = 0;
  let envListener = null;
  const _c1 = new THREE.Color();

  function applyEnv(t) {
    const lerp = THREE.MathUtils.lerp;
    if (renderer) renderer.toneMappingExposure = lerp(DAY.exposure, NIGHT.exposure, t);
    const sun = lighting.sun;
    const hemi = lighting.hemi;
    const fill = lighting.fill;
    if (sun) {
      sun.intensity = lerp(DAY.sun, NIGHT.sun, t);
      _c1.copy(DAY.sunColor).lerp(NIGHT.sunColor, t);
      sun.color.copy(_c1);
    }
    if (hemi) {
      hemi.intensity = lerp(DAY.hemi, NIGHT.hemi, t);
      _c1.copy(DAY.hemiSky).lerp(NIGHT.hemiSky, t);
      hemi.color.copy(_c1);
      _c1.copy(DAY.hemiGround).lerp(NIGHT.hemiGround, t);
      hemi.groundColor.copy(_c1);
    }
    if (fill) fill.intensity = lerp(DAY.fill, NIGHT.fill, t);
    if (lighting.fog) {
      _c1.copy(DAY.fog).lerp(NIGHT.fog, t);
      lighting.fog.color.copy(_c1);
      if (scene.fog && scene.fog.color) scene.fog.color.copy(_c1);
      if (scene.background && scene.background.isColor) scene.background.copy(_c1);
    }
    const u = sky.skyMat && sky.skyMat.uniforms;
    if (u) {
      if (u.uZenith) u.uZenith.value.copy(DAY.zenith).lerp(NIGHT.zenith, t);
      if (u.uHorizon) u.uHorizon.value.copy(DAY.horizon).lerp(NIGHT.horizon, t);
      if (u.uHaze) u.uHaze.value.copy(DAY.haze).lerp(NIGHT.haze, t);
      if (u.uGround) u.uGround.value.copy(DAY.ground).lerp(NIGHT.ground, t);
      if (u.uSunColor) u.uSunColor.value.copy(DAY.sunSprite).lerp(NIGHT.sunSprite, t);
      if (u.uSunIntensity) u.uSunIntensity.value = lerp(DAY.skyIntensity, NIGHT.skyIntensity, t);
    }
    if (sky.sunSprite && sky.sunSprite.material) {
      sky.sunSprite.material.opacity = lerp(1, 0.12, t);
    }
    // 海面在夜里整体压暗（颜色由着色器统一乘 uniform）
    if (ocean && ocean.uniforms && ocean.uniforms.uNight) {
      ocean.uniforms.uNight.value = t;
    }
  }

  function setEnv(mode, instant = false) {
    const m = mode === 'dark' ? 'dark' : 'day';
    envMode = m;
    if (instant) {
      envT = m === 'dark' ? 1 : 0;
      applyEnv(envT);
    }
    if (typeof envListener === 'function') {
      try { envListener(m); } catch { /* ignore */ }
    }
    return { mode: envMode, t: envT };
  }
  function onEnvChange(fn) { envListener = fn; }
  function updateEnv(dt) {
    const target = envMode === 'dark' ? 1 : 0;
    if (Math.abs(envT - target) < 0.001) {
      if (envT !== target) { envT = target; applyEnv(envT); }
      return;
    }
    const speed = 0.55;
    envT += Math.sign(target - envT) * Math.min(Math.abs(target - envT), dt * speed);
    applyEnv(envT);
  }

  // ---------- 画质切换 ----------
  function setQuality(next) {
    let q = next;
    if (q === 'auto') q = isSoftwareRenderer(renderer) ? 'low' : 'high';
    if (!isQuality(q)) return quality;
    if (q === quality) return quality;

    const prev = preset;
    quality = q;
    preset = presetOf(q);

    if (preset.terrainSegments !== prev.terrainSegments) {
      const rebuilt = createTerrain({ preset: terrainPresetOf(preset), anisotropy, extras });
      scene.remove(terrain.group);
      terrain.dispose();
      terrain = rebuilt;
      scene.add(terrain.group);
      refreshRaycastTargets();
    }
    if (ocean && ocean.setQuality) ocean.setQuality(preset);
    lighting.setQuality(preset);
    sky.setQuality(preset);
    vegetation.setQuality(preset);
    village.setQuality(preset);
    pier.setQuality(preset);
    props.setQuality(preset);
    if (post) post.applyPreset(preset);
    return quality;
  }

  function dispose() {
    if (post) { post.dispose(); post = null; }
    items.dispose();
    vegetation.dispose();
    props.dispose();
    pier.dispose();
    village.dispose();
    if (ocean) ocean.dispose();
    terrain.dispose();
    sky.dispose();
    lighting.dispose();
    raycastTargets.length = 0;
    if (renderer && renderer.shadowMap) renderer.shadowMap.enabled = false;
  }

  const world = {
    raycastTargets,
    sun: lighting.sun,
    hemi: lighting.hemi,
    get quality() { return quality; },
    get preset() { return preset; },
    get soft() { return soft; },
    get time() { return time; },
    fog: lighting.fog,
    sunDir: lighting.sunDir,
    sky,
    get terrain() { return terrain; },
    get ocean() { return ocean; },
    village,
    pier,
    props,
    vegetation,
    items,
    get post() { return post; },
    createItemMesh: (type) => items.createItemMesh(type),
    forgetItem: (group) => items.forget(group),
    setQuality,
    update,
    render,
    dispose,
    setEnv,
    onEnvChange,
    get envMode() { return envMode; },
    get envT() { return envT; },
    stats() {
      let meshes = 0, instanced = 0, lines = 0, triangles = 0;
      scene.traverse((o) => {
        if (o.isInstancedMesh) {
          instanced++;
          const g = o.geometry;
          if (g && g.index) triangles += (g.index.count / 3) * o.count;
          else if (g && g.attributes.position) triangles += (g.attributes.position.count / 3) * o.count;
        } else if (o.isMesh) {
          meshes++;
          const g = o.geometry;
          if (g && g.index) triangles += g.index.count / 3;
          else if (g && g.attributes.position) triangles += g.attributes.position.count / 3;
        } else if (o.isLineSegments) {
          lines++;
        }
      });
      return { meshes, instanced, lines, triangles: Math.round(triangles), quality };
    },
  };

  lighting.update(0, null);
  vegetation.update(0, null);
  applyEnv(envT);

  return world;
}

export default buildTidewaterWorld;
