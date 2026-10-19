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
  uniform float uBarrel;       // 桶形畸变强度（镜片最外圈）
  uniform float uSoftness;     // 镜片边缘柔和度
  uniform vec2  uDotOffset;    // 红点视差摆动（归一化镜片坐标，仅视觉）
  uniform float uDotSize;      // 红点半径（归一化）
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

    // ---------- 镜片内放大（PiP）----------
    // uScene 是用"主相机 FOV / 放大倍率"渲染的窄视场画面：
    // 它在镜片圆内铺满显示 → 只有镜片里是放大的，镜片外的世界视角完全不变。
    // 镜片圆心 = 相机正前方 = 弹道方向，所以放大不影响命中判定。
    // 最外圈加入少量桶形畸变：真实凸透镜边缘可见弯曲，中心严格无畸变。
    float rr = min(r, 1.0);
    float k = uBarrel;
    vec2 q = p * (1.0 + k * rr * rr * rr * rr);
    // 边缘极轻微的径向拉伸（鱼眼感），六次幂保证只影响最外圈
    q *= 1.0 + 0.035 * pow(rr, 6.0);

    // 边缘色散：仅最外圈（真实镜片彩色镶边）
    float disp = 0.006 * pow(rr, 6.0);
    vec2 uvR = (q * (1.0 + disp)) * 0.5 + 0.5;
    vec2 uvG = q * 0.5 + 0.5;
    vec2 uvB = (q * (1.0 - disp)) * 0.5 + 0.5;

    vec3 col;
    col.r = texture2D(uScene, uvR).r;
    col.g = texture2D(uScene, uvG).g;
    col.b = texture2D(uScene, uvB).b;

    // RT 用 SRGBColorSpace 存储（three 在 setRenderTarget 时会做 sRGB 编码），
    // 这里采样拿到的已经是显示值，直接使用即可；不要再做 gamma 变换，否则会过曝。
    // 之前发灰发绿的原因是纹理被标成 sRGB 但实际写入的是线性数据 —— 现在两边已对齐。

    // 镜片渐晕：只在最外圈轻微压暗，中心清晰
    col *= 1.0 - 0.22 * smoothstep(0.82, 1.02, r);

    // 抗反射镀膜：极淡冷色偏移 + 最边缘一圈微红反射
    float coat = smoothstep(0.90, 1.0, r);
    col = mix(col, col * vec3(0.975, 0.995, 1.025), 0.22);
    col += vec3(0.035, 0.012, 0.026) * coat * coat;

    // 镀膜细微颗粒
    col += (hash(vUv * 512.0) - 0.5) * 0.005;

    // ---------- 红点：一个小亮点 + 极短光晕（真实 RDS 的成像）----------
    // 视差：红点随人物移动/呼吸在镜窗内轻微摆动（uDotOffset），
    // 但镜片中心（= 弹道方向）永远不变，所以瞄准点不会被影响。
    vec2 dp = p - uDotOffset;
    float dr = length(dp);
    float core = 1.0 - smoothstep(uDotSize * 0.55, uDotSize, dr);
    float glow = 1.0 - smoothstep(uDotSize, uDotSize * 2.6, dr);
    col = mix(col, uReticleColor, core * uOpacity);
    col += uReticleColor * (core * 0.85 + glow * 0.22) * uOpacity;

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
  // 高倍狙击（10×）镜内 FOV 低到 0.7°，画面被放得极大，需要足够分辨率。
  // 768 在 1080p 下镜窗约 300px，有 2.5x 采样余量，放大后不会出现斜纹噪点。
  const size = 768;
  const rt = new THREE.WebGLRenderTarget(size, size, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    depthBuffer: true,
    stencilBuffer: false,
    type: THREE.UnsignedByteType,
  });
  if (rt.texture) {
    // three 渲染到 RenderTarget 时会按目标纹理的 colorSpace 做编码：
    // 标成 sRGB → 写入的就是 sRGB 显示值，镜片 shader 可直接采样使用（与原红点镜一致）。
    // 若标成 NoColorSpace 却仍按 sRGB 采样，就会整体发灰发绿并出现放射状色带。
    rt.texture.colorSpace = THREE.SRGBColorSpace;
    rt.texture.generateMipmaps = false;
    rt.texture.minFilter = THREE.LinearFilter;
    rt.texture.magFilter = THREE.LinearFilter;
  }

  // 近裁剪面推到 0.5m：镜筒内壁/目镜离相机只有 6~10cm，如果 near 太近会被拍进镜内画面，
  // 表现为镜片边缘出现一圈灰黑色的"管子内壁"和放射状条纹。
  const cam = new THREE.PerspectiveCamera(28, 1, 0.5, 500);
  cam.rotation.order = 'YXZ';

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uScene: { value: rt.texture },
      uOpacity: { value: 0 },
      uAspect: { value: 1 },
      uReticleColor: { value: new THREE.Color(0xff3b2a) },
      uBarrel: { value: 0.12 },
      uSoftness: { value: 0.040 },
      uDotOffset: { value: new THREE.Vector2(0, 0) },
      uDotSize: { value: 0.030 },
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
    // 高倍狙击（10×）时镜内 FOV 只有 1.5° 左右，下限必须足够低，否则会被截断成"放大不够"
    cam.fov = Math.max(0.6, Math.min(90, fovDeg || 28));
    cam.aspect = 1;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    // 第一人称武器/手臂/枪口光源都不应出现在镜内画面里：
    // 它们都是主相机的子物体，这里统一隐藏再恢复（渲染一帧后立刻还原）。
    const hidden = [];
    for (const c of camera.children) {
      if (c && c.visible) { hidden.push(c); c.visible = false; }
    }
    const prevTarget = renderer.getRenderTarget();
    const prevShadowAuto = renderer.shadowMap ? renderer.shadowMap.autoUpdate : null;
    try {
      renderer.setRenderTarget(rt);
      // 注意：不能调用 renderer.clear()，它会作用于"当前绑定的目标"，
      // 一旦状态没恢复就会把主画布也清掉，表现为整屏黑闪。
      renderer.render(scene, cam);
      // 渲染到 RT 后必须显式告知纹理已更新：否则下一帧主渲染可能读到未完成的写入，
      // 表现为镜窗里出现撕裂的斜纹（一半正常一半错位）。
      if (rt.texture) rt.texture.needsUpdate = true;
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
  // 红点视差摆动（归一化镜片坐标，纯视觉；镜片中心仍是弹道方向）
  function setDotOffset(x, y) { material.uniforms.uDotOffset.value.set(x, y); }
  function setDotSize(r) { material.uniforms.uDotSize.value = Math.max(0.006, r); }

  function dispose() {
    rt.dispose();
    material.dispose();
  }

  return {
    material, rt, cam, render,
    setOpacity, setReticleColor, setBarrel, setDotOffset, setDotSize, setEnabled, dispose,
  };
}
