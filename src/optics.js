// ===== 真实光学瞄具（RDS / 光学镜）=====
// 思路：开镜时用一台独立相机（与主相机同位置、更小 FOV）渲染场景到 RenderTarget，
// 再把这张图贴到镜片平面上，由镜片自定义 shader 逐像素表现：
//   · 桶形畸变（越靠边缘放大率越高，真实凸透镜效果）
//   · 边缘色散 / 红晕反射镀膜
//   · 光学分划（中心点 + 环形 + 准星柱），随开镜量淡入
// 命中判定完全由共享的 yaw/pitch 决定，镜片只是"显示"，不影响弹道。
import * as THREE from 'three';

const LENS_VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const LENS_FRAG = `
  precision highp float;
  uniform sampler2D uScene;
  uniform float uOpacity;      // 开镜量 0..1
  uniform float uAspect;       // 镜片宽高比
  uniform vec3  uReticleColor;
  uniform float uBarrel;       // 桶形畸变强度
  uniform float uSoftness;     // 镜片边缘柔和度
  varying vec2 vUv;

  // 圆内归一化坐标（半径 1 = 镜片边缘）
  vec2 lensP(vec2 uv) {
    vec2 p = uv * 2.0 - 1.0;
    return p;
  }

  // 简易哈希噪点（镀膜颗粒感）
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  void main() {
    vec2 p = lensP(vUv);
    float r = length(p);

    // 圆形镜片：边缘之外完全透明
    float mask = 1.0 - smoothstep(1.0 - uSoftness, 1.0, r);
    if (mask <= 0.001) discard;

    // 桶形畸变：r' = r * (1 + k r^2)，边缘向外扩张 → 真实凸透镜的"边缘放大 + 微弯"
    // 桶形畸变：r' = r * (1 + k r^2)。k 越大边缘弯曲越强（真实凸透镜的"边缘压不下去"观感），
    // 中心几乎无畸变，保证中心点 = 弹着点。
    float k = uBarrel;
    vec2 q = p * (1.0 + k * r * r * r);   // 三次项：边缘更明显，中心几乎为零
    // 边缘额外向外的"鱼眼"拉伸，让最外圈景物产生弧线弯曲
    q *= 1.0 + 0.10 * pow(r, 6.0);

    // 色散：R/G/B 使用略微不同的畸变量（真实镜片边缘的彩色镶边）
    float disp = 0.010 * pow(r, 3.0);
    vec2 uvR = (q * (1.0 + disp)) * 0.5 + 0.5;
    vec2 uvG = q * 0.5 + 0.5;
    vec2 uvB = (q * (1.0 - disp)) * 0.5 + 0.5;

    vec3 col;
    col.r = texture2D(uScene, uvR).r;
    col.g = texture2D(uScene, uvG).g;
    col.b = texture2D(uScene, uvB).b;

    // 镜片暗角：边缘略暗（真实光学系统的渐晕）
    float vign = 1.0 - 0.42 * smoothstep(0.62, 1.02, r);
    col *= vign;

    // 抗反射镀膜：极淡的冷色偏 + 边缘一圈偏红/紫的反射
    float coat = smoothstep(0.80, 1.0, r);
    col = mix(col, col * vec3(0.96, 0.99, 1.04), 0.35);
    col += vec3(0.055, 0.020, 0.040) * coat * coat;

    // 镀膜细微颗粒（避免"塑料感"）
    col += (hash(vUv * 512.0) - 0.5) * 0.008;

    // ---------- 光学分划 ----------
    float ret = 0.0;
    // 中心点
    ret += 1.0 - smoothstep(0.012, 0.020, r);
    // 中心细环
    ret += (1.0 - smoothstep(0.002, 0.006, abs(r - 0.30))) * 0.55;
    // 准星柱：上 / 下 / 左 / 右各一段（留出中心空档）
    ret += (1.0 - smoothstep(0.0025, 0.0055, abs(p.x))) * step(0.115, abs(p.y)) * step(abs(p.y), 0.92) * 0.85;
    ret += (1.0 - smoothstep(0.0025, 0.0055, abs(p.y))) * step(0.115, abs(p.x)) * step(abs(p.x), 0.92) * 0.85;
    // 四角密位刻度（短横线）
    float ticks = 0.0;
    for (int i = 1; i <= 3; i++) {
      float d = 0.30 + float(i) * 0.155;
      ticks += (1.0 - smoothstep(0.0015, 0.004, abs(p.y - d))) * step(abs(p.x), 0.045);
      ticks += (1.0 - smoothstep(0.0015, 0.004, abs(p.y + d))) * step(abs(p.x), 0.045);
      ticks += (1.0 - smoothstep(0.0015, 0.004, abs(p.x - d))) * step(abs(p.y), 0.045);
      ticks += (1.0 - smoothstep(0.0015, 0.004, abs(p.x + d))) * step(abs(p.y), 0.045);
    }
    ret += ticks * 0.75;
    ret *= uOpacity;

    // 分划带一点发光，暗处也看得清
    col = mix(col, uReticleColor, clamp(ret, 0.0, 1.0) * 0.92);
    col += uReticleColor * clamp(ret, 0.0, 1.0) * 0.35;

    // 最终透明度：只在开镜时显示
    float alpha = mask * uOpacity;
    gl_FragColor = vec4(col, alpha);
  }
`;

/**
 * 创建光学瞄具渲染器。
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 */
export function createOptics(renderer, scene) {
  const size = 384;
  const rt = new THREE.WebGLRenderTarget(size, size, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    depthBuffer: true,
    stencilBuffer: false,
    type: THREE.UnsignedByteType,
  });
  if (rt.texture) rt.texture.colorSpace = THREE.SRGBColorSpace;

  const cam = new THREE.PerspectiveCamera(28, 1, 0.05, 400);
  cam.rotation.order = 'YXZ';

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uScene: { value: rt.texture },
      uOpacity: { value: 0 },
      uAspect: { value: 1 },
      uReticleColor: { value: new THREE.Color(0xff3b2a) },
      uBarrel: { value: 0.30 },
      uSoftness: { value: 0.055 },
    },
    vertexShader: LENS_VERT,
    fragmentShader: LENS_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    toneMapped: true,
  });

  let enabled = true;

  function setEnabled(v) { enabled = !!v; }

  /** 用光学相机渲染场景到贴图（一帧一次） */
  function render(camera, fovDeg) {
    if (!enabled || !renderer || !scene) return false;
    // 跟随主相机的位置与朝向，只改 FOV
    cam.position.copy(camera.position);
    cam.rotation.copy(camera.rotation);
    cam.fov = Math.max(6, Math.min(90, fovDeg || 28));
    cam.aspect = 1;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    // 第一人称武器/手臂不应出现在镜内画面里
    const hidden = [];
    camera.children.forEach((c) => {
      if (c.name === 'fpArms' || c.userData.__isWeaponHolder) {
        if (c.visible) { hidden.push(c); c.visible = false; }
      }
    });
    const prevTarget = renderer.getRenderTarget();
    const prevShadowAuto = renderer.shadowMap ? renderer.shadowMap.autoUpdate : null;
    try {
      renderer.setRenderTarget(rt);
      renderer.clear();
      renderer.render(scene, cam);
    } catch { /* 渲染失败时保持上一帧画面，不影响游戏 */ } finally {
      renderer.setRenderTarget(prevTarget);
      for (const h of hidden) h.visible = true;
      void prevShadowAuto;
    }
    return true;
  }

  function setOpacity(v) { material.uniforms.uOpacity.value = Math.max(0, Math.min(1, v)); }
  function setReticleColor(hex) { material.uniforms.uReticleColor.value.set(hex); }
  function setBarrel(v) { material.uniforms.uBarrel.value = v; }

  function dispose() {
    rt.dispose();
    material.dispose();
  }

  return { material, rt, cam, render, setOpacity, setReticleColor, setBarrel, setEnabled, dispose };
}
