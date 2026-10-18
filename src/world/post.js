// ===== 后期处理 =====
// RenderPass → UnrealBloomPass（极轻）→ 自定义调色 ShaderPass（暗角 / 轻对比 / 色温 / 胶片颗粒）→ OutputPass。
// OutputPass 负责 ACES 色调映射 + sRGB 输出（renderer.toneMapping / toneMappingExposure 由 lighting 设置）。
// 软件渲染或低档不创建本模块，world.render 直接走 renderer.render。
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export const GradeShader = {
  name: 'SuburbanGradeShader',
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uVignette: { value: 0.55 },
    uGrain: { value: 0.02 },
    uContrast: { value: 1.045 },
    uWarmth: { value: 1.0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uContrast;
    uniform float uWarmth;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      vec3 rgb = max(color.rgb, 0.0);

      // 暗角（椭圆，避免上下裁切感）
      vec2 q = vUv - 0.5;
      float r = length(q * vec2(1.0, 0.94));
      float vig = smoothstep(0.82, 0.2, r);
      rgb *= mix(1.0, vig, uVignette);

      // 轻色温：整体 1% 左右暖偏移
      rgb *= vec3(1.0 + uWarmth * 0.013, 1.0 + uWarmth * 0.004, 1.0 - uWarmth * 0.012);

      // 线性空间轻对比（以 0.18 中灰为轴）
      rgb = (rgb - 0.18) * uContrast + 0.18;
      rgb = max(rgb, vec3(0.0));

      // 胶片颗粒：暗部更明显
      float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
      float g = hash(vUv * uResolution + fract(uTime) * 137.31) - 0.5;
      rgb += g * uGrain * (0.45 + 0.55 * (1.0 - clamp(luma, 0.0, 1.0)));

      gl_FragColor = vec4(max(rgb, vec3(0.0)), color.a);
    }
  `,
};

export function createPost(scene, renderer, preset) {
  if (!renderer) return null;
  const composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, new THREE.PerspectiveCamera());
  composer.addPass(renderPass);

  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.16, 0.42, 0.88);
  bloom.threshold = 0.88;
  bloom.strength = 0.16;
  bloom.radius = 0.42;
  composer.addPass(bloom);

  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);

  const output = new OutputPass();
  composer.addPass(output);

  let currentPreset = preset || null;
  const sizeVec = new THREE.Vector2();

  function syncSize() {
    const pr = renderer.getPixelRatio ? renderer.getPixelRatio() : 1;
    if (renderer.getSize) renderer.getSize(sizeVec);
    else sizeVec.set(1, 1);
    if (composer._pixelRatio !== pr) composer.setPixelRatio(pr);
    if (composer._width !== sizeVec.x || composer._height !== sizeVec.y) {
      composer.setSize(Math.max(1, sizeVec.x), Math.max(1, sizeVec.y));
      grade.uniforms.uResolution.value.set(
        Math.max(1, sizeVec.x) * pr,
        Math.max(1, sizeVec.y) * pr
      );
    }
  }

  function applyPreset(p) {
    currentPreset = p;
    const bloomOn = !!(p && p.bloom);
    bloom.enabled = bloomOn;
    // 低档关掉颗粒，减少逐像素噪声（软件渲染本来就模糊）
    grade.uniforms.uGrain.value = bloomOn ? 0.02 : 0.0;
    grade.uniforms.uVignette.value = 0.55;
  }
  applyPreset(currentPreset);
  syncSize();

  let time = 0;
  function render(camera, dt = 0.016) {
    if (!camera) return false;
    time += dt;
    renderPass.camera = camera;
    grade.uniforms.uTime.value = time;
    syncSize();
    composer.render();
    return true;
  }

  function dispose() {
    composer.dispose();
    bloom.dispose();
    grade.dispose();
    output.dispose();
  }

  return {
    composer, bloom, grade, output,
    applyPreset, render, syncSize, dispose,
    get enabled() { return true; },
  };
}
