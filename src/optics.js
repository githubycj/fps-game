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

    // ---------- 真实光学：镜内画面与主视角 1:1 对应 ----------
    // 关键：不做任何整体缩放/放大。镜片上的每个像素都直接采样"同一视线方向"的场景，
    // 这样玩家看到的目标大小与不开镜时完全一致，中心点就是准星，绝对不会影响命中判定。
    // 只有在最外圈加入少量桶形畸变（真实凸透镜边缘的可见弯曲）。
    float k = uBarrel;
    vec2 q = p * (1.0 + k * r * r * r * r);   // 四次项：中心完全无畸变，仅边缘弯曲
    // 非常轻微的外圈拉伸，形成"镜片边缘景物被压弯"的真实观感
    q *= 1.0 + 0.045 * pow(r, 8.0);

    // 边缘色散（真实镜片最外圈的彩色镶边，中心为零）
    float disp = 0.008 * pow(r, 5.0);
    vec2 uvR = (q * (1.0 + disp)) * 0.5 + 0.5;
    vec2 uvG = q * 0.5 + 0.5;
    vec2 uvB = (q * (1.0 - disp)) * 0.5 + 0.5;

    vec3 col;
    col.r = texture2D(uScene, uvR).r;
    col.g = texture2D(uScene, uvG).g;
    col.b = texture2D(uScene, uvB).b;

    // 镜片渐晕：只有很靠边的一圈变暗（真实光学系统的边缘渐晕，不影响中心观察）
    float vign = 1.0 - 0.30 * smoothstep(0.75, 1.02, r);
    col *= vign;

    // 抗反射镀膜：极淡冷色偏移 + 最边缘一圈偏红的反射光
    float coat = smoothstep(0.88, 1.0, r);
    col = mix(col, col * vec3(0.97, 0.995, 1.03), 0.25);
    col += vec3(0.045, 0.015, 0.032) * coat * coat;

    // 镀膜细微颗粒（避免"塑料感"）
    col += (hash(vUv * 512.0) - 0.5) * 0.006;

    // ---------- 分划：单个红色发光点（真实 red dot，不是十字）----------
    // 一个锐利的实心亮核 + 柔和光晕，在镜片正中心，与弹着点严格重合。
    float dotCore = 1.0 - smoothstep(0.020, 0.030, r);
    float dotGlow = 1.0 - smoothstep(0.030, 0.085, r);
    float dotA = clamp(dotCore + dotGlow * 0.42, 0.0, 1.0) * uOpacity;
    // 红色光点叠加在画面之上（加色），暗处也清晰可见
    col = mix(col, uReticleColor, dotCore * uOpacity * 0.95);
    col += uReticleColor * (dotGlow * 0.55 + dotCore * 0.65) * uOpacity;

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
      uBarrel: { value: 0.16 },
      uSoftness: { value: 0.045 },
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
