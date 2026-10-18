// ===== 光照 / 阴影 / 雾 =====
// 金色侧光方向光（软阴影，阴影相机每帧跟随玩家并按阴影贴图纹素对齐，消除抖动）；
// 半球补光 + 冷色反补光；指数雾。数值全部来自 shared/world.js 的 SUN。
import * as THREE from 'three';
import { SUN } from './shared.js';

const SHADOW_EXTENT = 46;      // 阴影相机半尺寸（m）——覆盖玩家周围 92m，2048 贴图约 4.5cm/texel
const SHADOW_DISTANCE = 120;   // 光源距目标距离

export function createLighting(scene, { renderer = null, preset = null } = {}) {
  const sunDir = new THREE.Vector3(SUN.dir[0], SUN.dir[1], SUN.dir[2]).normalize();

  // ---------- 雾 ----------
  // SUN 只给了线性雾 near/far；这里换算成指数雾密度，使 fogFar 处约 90% 雾化
  const fogDensity = Math.sqrt(2.3) / Math.max(40, SUN.fogFar || 210);
  const fog = new THREE.FogExp2(SUN.fogColor, fogDensity);
  scene.fog = fog;

  // ---------- 主光（太阳）----------
  const sun = new THREE.DirectionalLight(SUN.color, SUN.intensity);
  sun.name = 'sunLight';
  sun.position.copy(sunDir).multiplyScalar(SHADOW_DISTANCE);
  scene.add(sun);
  scene.add(sun.target);
  sun.target.position.set(0, 0, 0);
  const sc = sun.shadow.camera;
  sc.left = -SHADOW_EXTENT; sc.right = SHADOW_EXTENT;
  sc.top = SHADOW_EXTENT; sc.bottom = -SHADOW_EXTENT;
  sc.near = 1; sc.far = SHADOW_DISTANCE * 2.4;
  sc.updateProjectionMatrix();
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.035;
  sun.shadow.mapSize.set(2048, 2048);

  // ---------- 半球补光 + 冷色反补 ----------
  const hemi = new THREE.HemisphereLight(SUN.hemiSky, SUN.hemiGround, SUN.hemiIntensity);
  hemi.name = 'hemiLight';
  scene.add(hemi);
  const fill = new THREE.DirectionalLight(0xa9c9e8, 0.22);
  fill.position.set(-sunDir.x * 60, 28, -sunDir.z * 60);
  fill.name = 'fillLight';
  scene.add(fill);

  let currentPreset = preset || null;

  function applyRenderer(rendererInstance) {
    if (!rendererInstance) return;
    rendererInstance.toneMapping = THREE.ACESFilmicToneMapping;
    rendererInstance.toneMappingExposure = SUN.exposure;
    rendererInstance.outputColorSpace = THREE.SRGBColorSpace;
    if (rendererInstance.shadowMap) {
      rendererInstance.shadowMap.enabled = !!(currentPreset && currentPreset.shadows);
      rendererInstance.shadowMap.type = THREE.PCFSoftShadowMap;
    }
  }

  function applyShadow(p) {
    const enabled = !!(p && p.shadows);
    const size = (p && p.shadowSize) || 1024;
    if (renderer && renderer.shadowMap) {
      renderer.shadowMap.enabled = enabled;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    sun.castShadow = enabled;
    if (enabled) {
      if (sun.shadow.map && sun.shadow.mapSize.x !== size) {
        sun.shadow.map.dispose();
        sun.shadow.map = null;
      }
      sun.shadow.mapSize.set(size, size);
      sun.shadow.needsUpdate = true;
    }
    // 需要让阴影相关的材质程序重新编译
    scene.traverse((o) => {
      const m = o.material;
      if (!m) return;
      const list = Array.isArray(m) ? m : [m];
      for (const mat of list) if (mat && mat.needsUpdate !== undefined) mat.needsUpdate = true;
    });
  }

  // 首帧阴影相机跟随原点，避免开场阴影缺失
  const _target = new THREE.Vector3();
  function update(dt, targetPos) {
    if (!sun.castShadow) return;
    _target.set(
      targetPos && Number.isFinite(targetPos.x) ? targetPos.x : 0,
      targetPos && Number.isFinite(targetPos.y) ? targetPos.y : 0,
      targetPos && Number.isFinite(targetPos.z) ? targetPos.z : 0
    );
    // 阴影贴图纹素对齐：目标吸附到纹素网格，避免移动时阴影边缘闪烁
    const texel = (SHADOW_EXTENT * 2) / Math.max(1, sun.shadow.mapSize.x);
    _target.x = Math.round(_target.x / texel) * texel;
    _target.z = Math.round(_target.z / texel) * texel;
    sun.target.position.copy(_target);
    sun.target.updateMatrixWorld();
    sun.position.set(
      _target.x + sunDir.x * SHADOW_DISTANCE,
      _target.y + sunDir.y * SHADOW_DISTANCE,
      _target.z + sunDir.z * SHADOW_DISTANCE
    );
  }

  function setQuality(p) {
    currentPreset = p;
    applyShadow(p);
    // 低档雾稍浓，遮住远景以省填充率
    fog.density = fogDensity * (p && p.label === '低' ? 1.12 : 1);
  }

  if (renderer) {
    applyRenderer(renderer);
    applyShadow(currentPreset || { shadows: true, shadowSize: 2048 });
  }
  update(0, null);

  function dispose() {
    scene.remove(sun);
    scene.remove(sun.target);
    scene.remove(hemi);
    scene.remove(fill);
    if (sun.shadow.map) sun.shadow.map.dispose();
    fill.dispose();
    hemi.dispose();
    sun.dispose();
    if (scene.fog === fog) scene.fog = null;
  }

  return { sun, hemi, fill, fog, sunDir, fogDensity, update, setQuality, dispose };
}
