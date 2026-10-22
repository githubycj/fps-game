// ===== 郊区战场 · 场景模块入口 =====
// 契约（REMAKE_SPEC §6.1）：
//   buildWorld(scene, renderer, opts) -> {
//     raycastTargets, sun, hemi, quality, setQuality(q),
//     update(dt, ctx), render(camera), createItemMesh(type), dispose(),
//   }
// 场景内容：高度场地形 + 顶点色、三层植被（风摆）、可进入民房/谷仓、26m 输电塔与悬链电缆、
// 木栅栏/边界链网/远处树墙、程序化天空+云+PMREM 环境、太阳软阴影、ACES+Bloom+调色后期、拾取物模型。
// 所有地形高度、布局、碰撞数据一律来自 shared/world.js，本模块不复制任何共享常量。
import * as THREE from 'three';
import { SUN, WORLD } from './world/shared.js';
import {
  resolveQuality, presetOf, isQuality, isSoftwareRenderer,
} from './world/quality.js';
import { createSky } from './world/sky.js';
import { createMountains } from './world/mountains.js';
import { createLighting } from './world/lighting.js';
import { createTerrain } from './world/terrain.js';
import { createBuildings } from './world/buildings.js';
import { createPylons } from './world/pylons.js';
import { createProps } from './world/props.js';
import { createVegetation } from './world/vegetation.js';
import { createItemFactory } from './world/items.js';
import { createPost } from './world/post.js';

export function buildWorld(scene, renderer, opts = {}) {
  if (!scene) throw new Error('buildWorld: 需要 THREE.Scene');

  const soft = opts.soft != null ? !!opts.soft : isSoftwareRenderer(renderer);
  let quality = resolveQuality({ ...opts, soft }, renderer);
  let preset = presetOf(quality);

  // 各向异性过滤上限（地面法线、链网纹理用）
  let anisotropy = 1;
  try {
    if (renderer && renderer.capabilities && renderer.capabilities.getMaxAnisotropy) {
      anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy() || 1);
    }
  } catch (e) { anisotropy = 1; }

  // ---------- 基础场景状态 ----------
  scene.background = new THREE.Color(SUN.fogColor);
  scene.fog = null;

  // ---------- 光照（先设置 renderer 的 ACES / 阴影开关）----------
  const lighting = createLighting(scene, { renderer, preset });

  // ---------- 天空 + 云 + PMREM 环境贴图 ----------
  const sky = createSky(scene, { renderer, preset, anisotropy });

  // ---------- 远山（分形噪声 + 光线步进：雪山 / 软阴影 / 大气透视）----------
  let mountains = null;
  try {
    mountains = createMountains(scene, { preset, sunDir: sky.sunDir, anisotropy });
    // 与天空色同步，远山雾化色才能与地平线无缝衔接
    if (mountains.syncSkyColors && sky.skyMat) mountains.syncSkyColors(sky.skyMat);
  } catch (e) {
    console.warn('[world] 远山创建失败：', e && e.message);
    mountains = null;
  }

  // ---------- 地形 ----------
  let terrain = createTerrain({ preset, anisotropy });
  scene.add(terrain.group);

  // ---------- 建筑 / 输电塔 / 道具 / 植被 ----------
  const buildings = createBuildings({ preset, anisotropy });
  scene.add(buildings.group);
  const pylons = createPylons({ preset, anisotropy });
  scene.add(pylons.group);
  const props = createProps({ preset, anisotropy });
  scene.add(props.group);
  const vegetation = createVegetation({ preset });
  scene.add(vegetation.group);

  // ---------- 拾取物工厂（Lead 通过 createItemMesh 创建地面道具）----------
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

  // 供本地视觉射线使用的静态目标（地形网格 + 房屋 / 塔 / 岩石 / 车辆 / 工事合并网格）
  // 注意：该数组引用会一直保持，质量档变化重建地形时原地更新内容，Lead 可以长期持有。
  const raycastTargets = [];
  function refreshRaycastTargets() {
    raycastTargets.length = 0;
    raycastTargets.push(
      ...terrain.raycastTargets,
      ...buildings.raycastTargets,
      ...pylons.raycastTargets,
      ...props.raycastTargets
    );
  }
  refreshRaycastTargets();

  // ---------- 逐帧状态 ----------
  let time = 0;
  let lastDt = 0.016;
  let lastCamera = null;
  const _shadowTarget = new THREE.Vector3();
  const _playerPos = new THREE.Vector3();

  function resolveTargetPos(ctx) {
    if (ctx.playerPos && Number.isFinite(ctx.playerPos.x)) {
      _playerPos.set(ctx.playerPos.x, ctx.playerPos.y || 0, ctx.playerPos.z);
      return _playerPos;
    }
    const cam = ctx.camera || lastCamera;
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

    // 昼夜过渡
    updateEnv(step);

    // 太阳阴影相机跟随玩家（按阴影纹素对齐，避免抖动）
    const target = resolveTargetPos(ctx);
    lighting.update(step, target);

    // 天空/云跟随相机
    sky.update(step, camera);
    // 远山跟随相机（视差）+ 太阳方向同步
    if (mountains) {
      try { mountains.update(step, camera); } catch { /* ignore */ }
    }

    // 植被风摆 + 玩家压草
    vegetation.update(step, target);

    // 拾取物浮动 / 旋转 / 标记脉动
    items.update(step);
  }

  function render(camera) {
    if (!renderer) return;
    if (camera) lastCamera = camera;
    if (!lastCamera) return;
    if (post) {
      post.render(lastCamera, lastDt);
    } else {
      renderer.render(scene, lastCamera);
    }
  }

  // ---------- 昼夜切换（/dark 黑夜、/light 白天）----------
  // 白天/黑夜两套参数，平滑过渡（t: 0=白天 1=黑夜）
  const DAY = {
    exposure: SUN.exposure ?? 1.0,
    sun: SUN.intensity ?? 2.7,
    sunColor: new THREE.Color(SUN.color ?? 0xfff2d6),
    hemiSky: new THREE.Color(SUN.hemiSky ?? 0xbcd6f0),
    hemiGround: new THREE.Color(SUN.hemiGround ?? 0x6d6a52),
    hemi: SUN.hemiIntensity ?? 1.0,
    fill: 0.22,
    fog: new THREE.Color(SUN.fogColor ?? 0xc6d7e4),
    zenith: new THREE.Color(0x4c80b8),
    horizon: new THREE.Color(0xc6d7e4),
    haze: new THREE.Color(0xe9dcc2),
    ground: new THREE.Color(0x6d6a52),
    sunSprite: new THREE.Color(0xffedcd),
    skyIntensity: 1.0,
  };
  const NIGHT = {
    exposure: 0.86,
    sun: 0.30,
    sunColor: new THREE.Color(0x9fb6d8),
    hemiSky: new THREE.Color(0x22304a),
    hemiGround: new THREE.Color(0x0d1119),
    hemi: 0.42,
    fill: 0.06,
    fog: new THREE.Color(0x0a1220),
    zenith: new THREE.Color(0x050a16),
    horizon: new THREE.Color(0x121c2e),
    haze: new THREE.Color(0x1a2438),
    ground: new THREE.Color(0x090c12),
    sunSprite: new THREE.Color(0x9fb6d8),
    skyIntensity: 0.18,
  };
  let envMode = 'day';
  let envT = 0;          // 0 = 白天，1 = 黑夜
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
    // 远山：同步天空色（夜间远山也变暗变蓝）
    if (mountains) {
      try {
        if (mountains.syncSkyColors) mountains.syncSkyColors(sky.skyMat);
        if (mountains.setNight) mountains.setNight(t);
        else if (mountains.material && mountains.material.uniforms && mountains.material.uniforms.uNight) {
          mountains.material.uniforms.uNight.value = t;
        }
      } catch { /* ignore */ }
    }
  }
  function setEnv(mode, instant = false) {
    const m = mode === 'dark' ? 'dark' : 'day';
    envMode = m;
    if (instant) {
      envT = m === 'dark' ? 1 : 0;
      applyEnv(envT);
    }
    // 通知特效/其他子系统（夜间枪口焰照明加强）
    if (typeof envListener === 'function') {
      try { envListener(m); } catch { /* ignore */ }
    }
    return { mode: envMode, t: envT };
  }
  // 注册昼夜变化回调（main.js 用来同步 effects 的夜间模式）
  function onEnvChange(fn) { envListener = fn; }
  function updateEnv(dt) {
    const target = envMode === 'dark' ? 1 : 0;
    if (Math.abs(envT - target) < 0.001) {
      if (envT !== target) { envT = target; applyEnv(envT); }
      return;
    }
    const speed = 0.55;   // 约 1.8s 完成过渡
    envT += Math.sign(target - envT) * Math.min(Math.abs(target - envT), dt * speed);
    applyEnv(envT);
  }

  // ---------- 画质切换（植被密度 / 距离 / 阴影 / 后期 / 地形分辨率）----------
  function setQuality(next) {
    let q = next;
    if (q === 'auto') q = isSoftwareRenderer(renderer) ? 'low' : 'high';
    if (!isQuality(q)) return quality;
    if (q === quality) return quality;

    const prev = preset;
    quality = q;
    preset = presetOf(q);

    // 地形网格分辨率随档位变化：重建内圈+外圈（raycastTargets 原地替换）
    if (preset.terrainSegments !== prev.terrainSegments || preset.outerMilestones !== prev.outerMilestones) {
      const rebuilt = createTerrain({ preset, anisotropy });
      scene.remove(terrain.group);
      terrain.dispose();
      terrain = rebuilt;
      scene.add(terrain.group);
      refreshRaycastTargets();
    }

    lighting.setQuality(preset);
    vegetation.setQuality(preset);
    buildings.setQuality(preset);
    sky.setQuality(preset);
    if (mountains) { try { mountains.setQuality(preset); } catch { /* ignore */ } }
    if (post) post.applyPreset(preset);
    return quality;
  }

  // ---------- 资源释放 ----------
  function dispose() {
    if (post) { post.dispose(); post = null; }
    if (mountains) { try { mountains.dispose(); } catch { /* ignore */ } mountains = null; }
    items.dispose();
    vegetation.dispose();
    props.dispose();
    pylons.dispose();
    buildings.dispose();
    terrain.dispose();
    sky.dispose();
    lighting.dispose();
    raycastTargets.length = 0;
    if (renderer && renderer.shadowMap) renderer.shadowMap.enabled = false;
  }

  // ---------- 对外对象 ----------
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
    get mountains() { return mountains; },
    get terrain() { return terrain; },
    buildings,
    pylons,
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
    // 调试/自测：统计场景静态 draw call（按材质/对象数粗略估计）
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

  // 首帧阴影/天空状态
  lighting.update(0, null);
  vegetation.update(0, null);
  applyEnv(envT);

  return world;
}
