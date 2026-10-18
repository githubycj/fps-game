// ===== 天空 / 云 / 太阳光晕 / PMREM 环境贴图 =====
// 程序化渐变天空球（顶点方向决定颜色）+ 日盘与大气辉光 + 两层程序化云 + 太阳光晕 Sprite。
// 天空球跟随相机（无限远），并生成 PMREM 环境贴图供 PBR 材质反射。
import * as THREE from 'three';
import { SUN } from './shared.js';
import { makeCloudTexture, makeSunGlowTexture } from './textures.js';

const SKY_RADIUS = 300;

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = clip.xyww;
}
`;

const SKY_FRAG = /* glsl */`
uniform vec3 uSunDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uHaze;
uniform vec3 uGround;
uniform vec3 uSunColor;
uniform float uSunIntensity;
varying vec3 vDir;

// 注意：WebGLProgram 会为 toneMapped 材质自动注入 tonemapping/colorspace 的 *_pars 声明，
// 这里不能再 #include 这两个 pars chunk，否则函数重复定义导致着色器编译失败。
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  // 天顶 → 地平线渐变
  float t = pow(clamp(h * 1.12 + 0.05, 0.0, 1.0), 0.62);
  vec3 col = mix(uHorizon, uZenith, t);
  // 地平线附近的暖色雾霭（下午 4 点侧光）
  col = mix(col, uHaze, pow(1.0 - clamp(abs(h) * 2.4, 0.0, 1.0), 2.4) * 0.5);
  // 球体下半部压暗，避免俯视穿帮
  col = mix(col, uGround, smoothstep(-0.02, -0.24, h));
  // 太阳：日盘 + 大气辉光
  float sd = max(dot(d, normalize(uSunDir)), 0.0);
  col += uSunColor * (pow(sd, 1500.0) * 26.0 + pow(sd, 28.0) * 0.55 + pow(sd, 6.0) * 0.09) * uSunIntensity;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createSky(scene, { renderer = null, preset = null, anisotropy = 1 } = {}) {
  const group = new THREE.Group();
  group.name = 'sky';
  scene.add(group);

  const sunDir = new THREE.Vector3(SUN.dir[0], SUN.dir[1], SUN.dir[2]).normalize();
  const disposables = [];

  // ---------- 天空球 ----------
  const skyGeo = new THREE.SphereGeometry(SKY_RADIUS, 32, 16);
  const skyMat = new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: sunDir.clone() },
      uZenith: { value: new THREE.Color(0x4c80b8) },
      uHorizon: { value: new THREE.Color(0xc6d7e4) },
      uHaze: { value: new THREE.Color(0xe9dcc2) },
      uGround: { value: new THREE.Color(0x6d6a52) },
      uSunColor: { value: new THREE.Color(0xffedcd) },
      uSunIntensity: { value: 1.0 },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  skyMat.toneMapped = true;
  const skyMesh = new THREE.Mesh(skyGeo, skyMat);
  skyMesh.name = 'skyDome';
  skyMesh.renderOrder = -1000;
  skyMesh.frustumCulled = false;
  group.add(skyMesh);
  disposables.push(skyGeo, skyMat);

  // ---------- 太阳光晕 Sprite ----------
  const glowTex = makeSunGlowTexture();
  let sunSprite = null;
  if (glowTex) {
    const glowMat = new THREE.SpriteMaterial({
      map: glowTex,
      color: 0xfff2d8,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    sunSprite = new THREE.Sprite(glowMat);
    sunSprite.scale.setScalar(38);
    sunSprite.renderOrder = -999;
    sunSprite.position.copy(sunDir).multiplyScalar(SKY_RADIUS * 0.98);
    group.add(sunSprite);
    disposables.push(glowTex, glowMat);
  }

  // ---------- 云层（两层水平大平面，贴图缓慢漂移）----------
  const clouds = [];
  const cloudTex = makeCloudTexture(1337, anisotropy);
  if (cloudTex) {
    const layers = [
      // 尺寸/高度控制在相机远裁剪面（Lead 用 ~420）以内，避免云层被裁出硬边
      { y: 96, size: 660, opacity: 0.5, repeat: 2.4, color: 0xfffaf2, speed: 0.0035 },
      { y: 148, size: 760, opacity: 0.34, repeat: 1.7, color: 0xf2f6fa, speed: 0.0021 },
    ];
    for (const layer of layers) {
      const tex = cloudTex.clone();
      tex.needsUpdate = true;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(layer.repeat, layer.repeat);
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        color: layer.color,
        transparent: true,
        opacity: layer.opacity,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        fog: false,
      });
      mat.toneMapped = true;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(layer.size, layer.size), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = layer.y;
      mesh.renderOrder = -998;
      mesh.frustumCulled = false;
      group.add(mesh);
      clouds.push({ mesh, mat, tex, speed: layer.speed });
      disposables.push(mesh.geometry, mat, tex);
    }
    disposables.push(cloudTex);
  }

  // ---------- PMREM 环境贴图 ----------
  let envRT = null;
  let envError = null;
  if (renderer && typeof THREE.PMREMGenerator === 'function') {
    try {
      envRT = buildEnvironment(renderer, scene, sunDir, skyGeo, skyMat, disposables);
    } catch (e) {
      envRT = null;
      envError = e;
    }
  }

  const state = { preset, time: 0 };

  function setQuality(p) {
    state.preset = p;
    for (const c of clouds) c.mesh.visible = p ? p.clouds !== false : true;
    if (sunSprite) sunSprite.visible = true;
  }
  if (preset) setQuality(preset);

  function update(dt, camera) {
    state.time += dt;
    if (camera) group.position.copy(camera.position);
    for (const c of clouds) {
      // 云随风缓慢漂移
      const tex = c.tex;
      if (tex) {
        tex.offset.x = (tex.offset.x + dt * c.speed) % 1;
        tex.offset.y = (tex.offset.y + dt * c.speed * 0.35) % 1;
      }
    }
  }

  function dispose() {
    scene.remove(group);
    for (const d of disposables) if (d && d.dispose) d.dispose();
    if (envRT) {
      if (scene.environment === envRT.texture) scene.environment = null;
      envRT.dispose();
      envRT = null;
    }
  }

  return { group, sunDir, skyMat, sunSprite, clouds, envRT, envError, update, setQuality, dispose };
}

// 用一个小型环境场景烘焙天空：天空球 + 地面色 + 高亮日盘 → PMREM 全反射贴图
function buildEnvironment(renderer, scene, sunDir, skyGeo, skyMat, disposables) {
  const envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(skyGeo, skyMat);
  envSky.frustumCulled = false;
  envScene.add(envSky);

  // 地面色半球（避免下半球全黑，PBR 材质暗部有环境色）
  const groundGeo = new THREE.CircleGeometry(1200, 24);
  const groundMat = new THREE.MeshBasicMaterial({ color: 0x77714f, side: THREE.DoubleSide, fog: false });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1.5;
  envScene.add(ground);

  // 高亮日盘（HDR 值 > 1，产生金属高光）
  const diskGeo = new THREE.SphereGeometry(26, 12, 8);
  const diskMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(9.0, 8.0, 6.2), fog: false });
  const disk = new THREE.Mesh(diskGeo, diskMat);
  disk.position.copy(sunDir).multiplyScalar(760);
  envScene.add(disk);
  // 日盘周围的暖色大气光晕
  const haloMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(1.6, 1.35, 1.0), transparent: true, opacity: 0.5, fog: false,
    depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const halo = new THREE.Mesh(new THREE.SphereGeometry(120, 16, 10), haloMat);
  halo.position.copy(disk.position);
  envScene.add(halo);

  const pmrem = new THREE.PMREMGenerator(renderer);
  let rt = null;
  try {
    rt = pmrem.fromScene(envScene, 0.02, 0.1, 2000);
    scene.environment = rt.texture;
    scene.environmentIntensity = 0.85;
  } finally {
    pmrem.dispose();
    envScene.remove(envSky);
    groundGeo.dispose(); groundMat.dispose();
    diskGeo.dispose(); diskMat.dispose();
    haloMat.dispose();
    halo.geometry.dispose();
  }
  if (rt) disposables.push(rt);
  return rt;
}
