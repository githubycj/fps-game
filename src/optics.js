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
  uniform float uReticle;      // 0 = 红点（RDS），1 = 十字缺上竖（狙击）
  uniform float uZoomCrop;     // 从 PiP 贴图中心裁取的比例（1 = 全贴图，0.2 = 只取中间 20%）
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
    // PiP 相机用"较宽 FOV"渲染（避免极小 FOV 下的投影精度走样），
    // 这里只从贴图中心裁出 uZoomCrop 比例的区域放大铺满镜片 —— 等效于放大，
    // 但渲染时的 FOV 足够大，三角面边缘不会出现放射状摩尔纹。
    float rr = min(r, 1.0);
    float k = uBarrel;
    vec2 q = p * (1.0 + k * rr * rr * rr * rr);
    // 边缘极轻微的径向拉伸（鱼眼感），六次幂保证只影响最外圈
    q *= 1.0 + 0.035 * pow(rr, 6.0);

    // 中心裁切：crop=1 时铺满整张贴图；crop 越小 = 放得越大
    float crop = clamp(uZoomCrop, 0.02, 1.0);
    q *= crop;

    // 边缘色散：只在最外圈极轻微（真实镜片彩色镶边）。
    // 注意：色散会让 RGB 三个通道用不同 UV 采样，在镜片被放大显示时会放大成彩色噪点，
    // 因此这里几乎关闭，只在最边缘保留极少量。
    float disp = 0.0015 * pow(rr, 8.0);
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

    // 镀膜颗粒：在镜片被放大显示时会变成明显噪点，这里完全去掉，
    // 只保留上面的镀膜色偏与边缘反射（已经足够真实）。


    // ---------- 分划 ----------
    if (uReticle > 0.5) {
      // 狙击分划：十字「缺上竖」——左/右/下三条臂 + 中心点，上方留空（不挡目标）。
      // 线宽按镜片归一化半径计算，保证不同分辨率下粗细一致。
      float w = 0.010;                 // 线宽（归一化）
      float gap = 0.045;               // 中心留空半径，避免完全糊住准点
      float armLen = 0.82;             // 三条臂长度
      vec2 q2 = p;

      // 左臂
      float left = (1.0 - smoothstep(w * 0.5, w * 1.5, abs(q2.y)))
                 * (1.0 - smoothstep(armLen - 0.02, armLen, abs(q2.x)))
                 * step(gap, -q2.x);
      // 右臂
      float right = (1.0 - smoothstep(w * 0.5, w * 1.5, abs(q2.y)))
                  * (1.0 - smoothstep(armLen - 0.02, armLen, abs(q2.x)))
                  * step(gap, q2.x);
      // 下臂（上竖故意缺失）
      float down = (1.0 - smoothstep(w * 0.5, w * 1.5, abs(q2.x)))
                 * (1.0 - smoothstep(armLen - 0.02, armLen, abs(q2.y)))
                 * step(gap, q2.y);

      float line = max(max(left, right), down);
      // 中心小点（真正的瞄准点）
      float centerDot = 1.0 - smoothstep(0.006, 0.016, length(q2));

      // 分划用深色描边 + 亮色芯，保证在亮/暗背景下都清晰
      col = mix(col, vec3(0.02, 0.02, 0.02), line * 0.55 * uOpacity);
      col = mix(col, uReticleColor, line * 0.85 * uOpacity);
      col = mix(col, vec3(0.02), centerDot * 0.6 * uOpacity);
      col += uReticleColor * centerDot * 0.9 * uOpacity;
    } else {
      // 红点：一个小亮点 + 极短光晕（真实 RDS 的成像）
      // 视差：红点随人物移动/呼吸在镜窗内轻微摆动（uDotOffset），
      // 但镜片中心（= 弹道方向）永远不变，所以瞄准点不会被影响。
      vec2 dp = p - uDotOffset;
      float dr = length(dp);
      float core = 1.0 - smoothstep(uDotSize * 0.55, uDotSize, dr);
      float glow = 1.0 - smoothstep(uDotSize, uDotSize * 2.6, dr);
      col = mix(col, uReticleColor, core * uOpacity);
      col += uReticleColor * (core * 0.85 + glow * 0.22) * uOpacity;
    }

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
  // 镜内画面分辨率：3× 固定倍率下 FOV 约 2.3°，1024 配合 mipmap 缩小采样可消除摩尔纹。
  const size = 1024;
  const mkRT = () => {
    const t = new THREE.WebGLRenderTarget(size, size, {
      // 开启三线性 mipmap：镜窗只有约 300px，而贴图 1024 需要缩小采样，
      // 没有 mipmap 时会出现扇形摩尔纹（尤其在极小 FOV 下非常明显）。
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      depthBuffer: true,
      stencilBuffer: false,
      type: THREE.UnsignedByteType,
      generateMipmaps: true,
    });
    if (t.texture) {
      // three 渲染到 RenderTarget 时会按目标纹理的 colorSpace 做编码：
      // 标成 sRGB → 写入的就是 sRGB 显示值，镜片 shader 可直接采样使用。
      t.texture.colorSpace = THREE.SRGBColorSpace;
      // 不用 mipmap：镜片是被【放大】采样到屏幕上的（贴图 1024 → 镜窗约 300px 是缩小，
      // 但 crop 后实际有效区域只有 ~200px，属于放大），mipmap 的层间插值会在
      // 斜向细节上产生细密网格伪影。改用各向异性 + 双线性，画面最干净。
      t.texture.generateMipmaps = false;
      t.texture.minFilter = THREE.LinearFilter;
      t.texture.magFilter = THREE.LinearFilter;
      t.texture.anisotropy = 4;
    }
    return t;
  };
  // 双缓冲：主渲染读 A 时写 B，下一帧交换。
  // 单缓冲会出现"同一帧内既写又读同一张纹理"，GPU 上表现为镜窗里撕裂的斜纹。
  const rtA = mkRT();
  const rtB = mkRT();
  let rt = rtA;          // 当前"正在写入"的目标
  let readRT = rtB;      // 当前"可供采样"的目标（上一帧结果）

  // 近裁剪面推到 0.5m：镜筒内壁/目镜离相机只有 6~10cm，如果 near 太近会被拍进镜内画面，
  // 表现为镜片边缘出现一圈灰黑色的"管子内壁"和放射状条纹。
  const cam = new THREE.PerspectiveCamera(28, 1, 0.5, 500);
  cam.rotation.order = 'YXZ';

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uScene: { value: readRT.texture },
      uOpacity: { value: 0 },
      uAspect: { value: 1 },
      uReticleColor: { value: new THREE.Color(0xff3b2a) },
      uBarrel: { value: 0.12 },
      uSoftness: { value: 0.040 },
      uDotOffset: { value: new THREE.Vector2(0, 0) },
      uDotSize: { value: 0.030 },
      // 分划样式：0 = 红点（RDS），1 = 十字缺上竖狙击分划
      uReticle: { value: 0 },
      // 从 PiP 贴图中心裁取的比例（由 render() 按目标放大倍率换算）
      uZoomCrop: { value: 1 },
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

  /**
   * 用光学相机渲染场景到贴图（一帧一次，双缓冲）。
   * 写入 rt，读上一帧的 readRT；渲染完成后交换，主渲染永远采样"已写完"的那张。
   *
   * @param {THREE.Camera} camera 主相机
   * @param {number} fovDeg 期望的"等效"镜内 FOV（已经过倍率换算）
   */
  function render(camera, fovDeg) {
    if (!enabled || !renderer || !scene) return false;
    // 关键：不要真的用极小 FOV 渲染。FOV 低于 ~10° 时顶点投影精度不足，
    // 三角面边缘会出现放射状摩尔纹（表现为镜窗里的"扇形斜纹"）。
    // 做法：用 SAFE_FOV 渲染，再在 shader 里只取中心 crop 区域放大 → 等效放大不变。
    const SAFE_FOV = 12;
    const want = Math.max(0.2, Math.min(90, fovDeg || SAFE_FOV));
    const crop = Math.min(1, want / SAFE_FOV);     // 等效放大 = SAFE_FOV / want
    if (material.uniforms.uZoomCrop) material.uniforms.uZoomCrop.value = crop;

    // 跟随主相机的位置与朝向
    cam.position.copy(camera.position);
    cam.rotation.copy(camera.rotation);
    cam.fov = SAFE_FOV;
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
    try {
      renderer.setRenderTarget(rt);
      // 不能调用 renderer.clear()：它会清掉"当前绑定的目标"，状态没恢复就会黑闪。
      renderer.render(scene, cam);
    } catch { /* 渲染失败时保持上一帧画面，不影响游戏 */ } finally {
      renderer.setRenderTarget(prevTarget);
      for (const h of hidden) h.visible = true;
    }
    // 交换：刚写完的这张变成下一帧可采样纹理
    const done = rt;
    rt = readRT;
    readRT = done;
    if (material.uniforms.uScene.value !== readRT.texture) {
      material.uniforms.uScene.value = readRT.texture;
    }
    return true;
  }

  function setOpacity(v) { material.uniforms.uOpacity.value = Math.max(0, Math.min(1, v)); }
  function setReticleColor(hex) { material.uniforms.uReticleColor.value.set(hex); }
  function setBarrel(v) { material.uniforms.uBarrel.value = v; }
  // 红点视差摆动（归一化镜片坐标，纯视觉；镜片中心仍是弹道方向）
  function setDotOffset(x, y) { material.uniforms.uDotOffset.value.set(x, y); }
  function setDotSize(r) { material.uniforms.uDotSize.value = Math.max(0.006, r); }
  /** 分划样式：0 = 红点，1 = 十字缺上竖（狙击） */
  function setReticleStyle(v) { material.uniforms.uReticle.value = v ? 1 : 0; }

  function dispose() {
    rtA.dispose();
    rtB.dispose();
    material.dispose();
  }

  return {
    material, get rt() { return readRT; }, rtA, rtB, cam, render,
    setOpacity, setReticleColor, setBarrel, setDotOffset, setDotSize, setReticleStyle, setEnabled, dispose,
  };
}
