// ===== 天空系统：物理大气散射（瑞利 + 米氏）+ 大气透视 + 体积云 + PMREM 环境 =====
//
// 全部程序化生成：无贴图、无新依赖、无外部 HDR。
//
// 1) 大气单次散射（天空球片元着色器内积分）
//      L(λ) = ∫ T_view(λ) · T_sun(λ) · (βR·ρR·P_R + βM·ρM·P_M) · E · ds
//    · βR = (5.8e-6, 13.5e-6, 33.1e-6) 1/m —— 瑞利体散射系数，蓝光最强 → 天空是蓝的
//    · βM = 21e-6 1/m —— 米氏体散射系数（气溶胶，灰白、前向散射强）
//    · 密度按高度指数衰减：ρR = exp(-h/8000)、ρM = exp(-h/1200)
//    · 相位函数：瑞利 3/16π·(1+μ²)；米氏 Henyey-Greenstein，g = 0.76
//    · 沿视线 8~24 步、太阳方向 4~6 步数值积分，累积 T = exp(-opticalDepth)
//    地平线附近的长路径会把蓝光散射掉 → 暖色/橙红是积分的自然结果，没有任何硬编码渐变。
//
// 2) 大气透视（aerial perspective）
//    把同一套散射积分烘焙进一张 64×32 等距柱状 HDR LUT；再用 onBeforeCompile 给场景里
//    已有的 PBR 材质注入"按视线方向采样天空色 + 指数雾化"，于是远处山/树会向**那个方向
//    的地平线天空色**渐变，而不是混向一个死板的单色。材质只多一次纹理采样，不重复积分。
//
// 3) 体积云
//    云层位于 1200~2600 m；三维 FBM 值噪声（GLSL 内程序化）描述密度；沿视线 8~48 步
//    ray marching，每步再向太阳方向 2~5 步短积分求自阴影，Henyey-Greenstein(g=0.6)
//    做前向散射 → 逆光时云边缘出现金边。云在天空之后合成，因此会自然遮挡日盘与星空。
//
// 4) 画质分级
//    所有步数都是 uniform int，运行时改；循环用常量上界 + break（兼容 WebGL1 的写法）。
//
// ---------------------------------------------------------------------------
// 对外接口（src/world.js 依赖，不可破坏）
//   createSky(scene, { renderer, preset, anisotropy }) => {
//     group, sunDir, skyMat, sunSprite, clouds, envRT, envError,
//     update(dt, camera), setQuality(preset), dispose()
//   }
//   · skyMat.uniforms 必须保留 uZenith / uHorizon / uHaze / uGround / uSunColor / uSunIntensity
//     —— world.js 的昼夜切换 applyEnv() 会直接写这六个
//   · sunSprite.material.opacity 必须可写 —— 昼夜切换会调
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { SUN } from './shared.js';
import { makeSunGlowTexture } from './textures.js';

// ---------- 尺度常量 ----------
const SKY_RADIUS = 300;          // 天空球半径（m）：只用于摆放日晕 sprite；真正的数据是方向
const CLOUD_BASE = 1200;         // 云层底高（m）
const CLOUD_TOP = 2600;          // 云层顶高（m）
const CLOUD_THICK = CLOUD_TOP - CLOUD_BASE;
const CLOUD_WIND = new THREE.Vector2(0.86, 0.51); // 风向（单位向量）
const CLOUD_WIND_SPEED = 3.4;    // 风速 m/s
const CLOUD_OFFSET_WRAP = 60000; // 云偏移取模，避免长时间运行后浮点精度丢失

// ---------- 画质分级 ----------
// scatter = 视线散射积分步数；sun = 太阳方向透过率积分步数
// cloud   = 云 ray marching 步数；oct = 三维 FBM 层数；light = 云向太阳方向的短积分步数
const TIER = {
  low: { scatter: 8, sun: 4, cloud: 8, oct: 2, light: 2 },
  medium: { scatter: 12, sun: 4, cloud: 16, oct: 3, light: 3 },
  high: { scatter: 20, sun: 6, cloud: 32, oct: 4, light: 4 },
  ultra: { scatter: 24, sun: 6, cloud: 48, oct: 5, light: 5 },
};
const TIERS = ['low', 'medium', 'high', 'ultra'];
const LABEL_TIER = { '低': 'low', '中': 'medium', '高': 'high', '极高': 'ultra' };

// 太阳辐照度标定：把物理辐亮度映射到 ACES 曝光下的可用亮度（白天值）
const SUN_E_DAY = 6.5;
// 云量（0..1）：覆盖率噪声的阈值映射；0.72 时天空约一半被云占据
const CLOUD_COVERAGE = 0.72;
// 云消光系数（1/m 每单位密度）与散射增益（标定值，见浏览器实测）
const CLOUD_DENSITY = 0.011;
const CLOUD_SUN_GAIN = 2.0;
const CLOUD_AMB_GAIN = 1.4;
// 能见度：与旧版指数雾保持观感连续
const AERIAL_VISIBILITY = Math.max(60, SUN.fogFar || 210);

// ============================================================
// GLSL 公共部分：常量 / 噪声 / 相位 / 散射积分 / 体积云 / 星空
// ============================================================
const GLSL_COMMON = /* glsl */`
#define PI 3.141592653589793

// ---------- 大气物理常量（米）----------
const float R_PLANET = 6360000.0;                      // 行星半径 6360 km
const float R_ATMOS  = 6420000.0;                      // 大气顶半径 6420 km（约 100 km 厚）
const vec3  BETA_R   = vec3(5.8e-6, 13.5e-6, 33.1e-6); // 瑞利体散射系数 1/m：蓝光最强
const float BETA_M   = 21e-6;                          // 米氏体散射系数 1/m：气溶胶
const float H_R      = 8000.0;                         // 瑞利标高 m
const float H_M      = 1200.0;                         // 米氏标高 m（气溶胶集中在低空）
const float G_MIE    = 0.76;                           // 米氏相位各向异性（前向散射强）
const float G_CLOUD  = 0.60;                           // 云的前向散射各向异性（金边）

// ---------- 云层高度区间 ----------
const float CLOUD_BASE  = ${CLOUD_BASE.toFixed(1)};
const float CLOUD_TOP   = ${CLOUD_TOP.toFixed(1)};
const float CLOUD_INV_T = ${(1 / CLOUD_THICK).toFixed(8)};

// ---------- 哈希 / 噪声（Dave Hoskins 风格，无三角函数、无贴图）----------
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
// 二维值噪声（双线性 + 五次平滑）
float vnoise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// 三维值噪声（8 角点）—— 体积云的核心，必须在 GLSL 内程序化生成
float vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
             mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
// 二维 FBM：Σ amp_i · noise(p · 2^i)
float fbm2(vec2 p, int oct) {
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int i = 0; i < 5; i++) {
    if (i >= oct) break;
    sum += amp * vnoise2(p);
    norm += amp;
    p = p * 2.03 + vec2(11.7, 5.3);   // 每层平移，避免各层自相似
    amp *= 0.5;
  }
  return sum / max(norm, 1e-4);
}
// 三维 FBM：fbm(p) = Σ amp_i · noise(p · 2^i)，层数由 uCloudOctaves 控制（2~5）
float fbm3(vec3 p, int oct) {
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    sum += amp * vnoise3(p);
    norm += amp;
    p = p * 2.02 + vec3(17.3, 9.1, 5.7);
    amp *= 0.5;
  }
  return sum / max(norm, 1e-4);
}

// ---------- 相位函数 ----------
// 瑞利相位：3/(16π)(1+μ²)，前后对称 → 天空整体偏蓝、太阳两侧对称
float phaseRayleigh(float mu) {
  return 3.0 / (16.0 * PI) * (1.0 + mu * mu);
}
// Henyey-Greenstein 相位：(1-g²)/(4π(1+g²-2gμ)^{3/2})；g>0 前向散射
float phaseHG(float mu, float g) {
  float g2 = g * g;
  float d = max(1.0 + g2 - 2.0 * g * mu, 1e-4);
  return (1.0 - g2) / (4.0 * PI * pow(d, 1.5));
}

// ---------- 射线与球求交 ----------
// 返回 (tNear, tFar)，无交点返回 (-1,-1)。
// |o|²-R² 在 6.36e6 量级会灾难性相消，改写为 c=(|o|-R)(|o|+R)，
// 并用稳定根 t0=c/(s-b)、t1=-c/(b+s)（c=|o|²-R², b=o·d, s=√(b²-c)）。
vec2 raySphere(vec3 o, vec3 d, float R) {
  float r = length(o);
  float c = (r - R) * (r + R);
  float b = dot(o, d);
  float disc = b * b - c;
  if (disc < 0.0) return vec2(-1.0, -1.0);
  float s = sqrt(disc);
  return vec2(c / (s - b), -c / (b + s));
}

// 海拔 h 处、指向太阳方向的大气透过率 T_sun(λ)。
// 沿太阳方向做一次短积分（4~6 步，uSunSteps 控制）得到光学厚度。
vec3 sunTransmittance(float h, vec3 sunDir) {
  vec3 o = vec3(0.0, R_PLANET + max(h, 0.0), 0.0);
  vec2 atm = raySphere(o, sunDir, R_ATMOS);
  if (atm.y <= 0.0) return vec3(1.0);
  float tMax = atm.y;
  // 太阳落到地平线以下时，光线被地面截断 → 透过率趋 0（日落自然变暗）
  vec2 gnd = raySphere(o, sunDir, R_PLANET);
  if (gnd.x > 0.0) tMax = min(tMax, gnd.x);
  vec3 od = vec3(0.0);
  float prev = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= uSunSteps) break;
    float f = (float(i) + 1.0) / float(uSunSteps);
    float t = tMax * pow(f, 1.7);
    float ds = t - prev;
    prev = t;
    vec3 p = o + sunDir * (t - ds * 0.5);
    float hh = max(length(p) - R_PLANET, 0.0);
    od += ds * (BETA_R * exp(-hh / H_R) + BETA_M * exp(-hh / H_M));
  }
  return exp(-od);
}

// ---------- 单次散射积分 ----------
// 沿视线累积 T_view(λ) 与入射散射项，返回线性 HDR 辐亮度（未做色调映射）。
vec3 atmosphereScatter(vec3 dir) {
  vec3 o = vec3(0.0, R_PLANET + max(uCamPos.y, 0.0), 0.0);
  vec2 atm = raySphere(o, dir, R_ATMOS);
  if (atm.y <= 0.0) return vec3(0.0);
  float tMax = atm.y;
  vec2 gnd = raySphere(o, dir, R_PLANET);
  if (gnd.x > 0.0) tMax = min(tMax, gnd.x);   // 视线打到地面就截断

  float mu = dot(dir, uSunDir);
  float pR = phaseRayleigh(mu);
  float pM = phaseHG(mu, G_MIE);

  vec3 sumR = vec3(0.0);   // Σ T_view·T_sun·ρR·ds
  vec3 sumM = vec3(0.0);   // Σ T_view·T_sun·ρM·ds
  vec3 od = vec3(0.0);     // 已累积的光学厚度
  float prev = 0.0;
  // 采样点按 pow(f,1.8) 分布：近处密、远处疏（大气密度随高度指数衰减，远处贡献小）
  for (int i = 0; i < 32; i++) {
    if (i >= uScatterSteps) break;
    float f = (float(i) + 1.0) / float(uScatterSteps);
    float t = tMax * pow(f, 1.8);
    float ds = t - prev;
    float tm = prev + ds * 0.5;
    prev = t;

    vec3 p = o + dir * tm;
    float h = max(length(p) - R_PLANET, 0.0);
    float rhoR = exp(-h / H_R);            // 瑞利密度（相对海平面）
    float rhoM = exp(-h / H_M);            // 米氏密度

    vec3 stepOD = (BETA_R * rhoR + BETA_M * rhoM) * ds;
    vec3 Tview = exp(-(od + stepOD * 0.5));    // 相机 → 该点的透过率
    vec3 Tsun = sunTransmittance(h, uSunDir);  // 该点 → 太阳的透过率

    sumR += Tview * Tsun * rhoR * ds;
    sumM += Tview * Tsun * rhoM * ds;
    od += stepOD;
  }
  // 单次散射解：L = ∫ T_view·T_sun·(βR·ρR·P_R + βM·ρM·P_M)·E ds
  return (sumR * BETA_R * pR + sumM * BETA_M * pM) * uSunE;
}

// ---------- 体积云：水平分布（二维低频噪声，成团、有间隙）----------
// 云胞尺度约 2.6km（积云典型尺度）：从地面看能分辨出多个云团与它们之间的蓝天缝隙。
float cloudCoverage(vec2 xz) {
  vec2 q = (xz + uCloudOffset) * (1.0 / 2600.0);
  // 低频：哪里成云（阈值化 → 团块之间留出干净的间隙）
  float cov = smoothstep(0.46, 0.62, fbm2(q, 3));
  // 中频：打碎云团边缘，避免圆滚滚的“棉花糖”
  float n = fbm2(q * 3.3 + 7.7, 2);
  cov *= smoothstep(0.24, 0.60, n * 0.70 + cov * 0.52);
  return cov * uCloudCoverage;
}
// ---------- 体积云：三维密度 ----------
// cov 由调用方传入：云团尺度 6km 远大于向太阳的采样距离（<400m），
// 所以同一条视线上所有步共享同一个覆盖度，省掉大量二维噪声计算。
float cloudShape(vec3 p, float cov, int oct) {
  if (cov < 0.02) return 0.0;
  float hn = (p.y - CLOUD_BASE) * CLOUD_INV_T;
  if (hn < 0.0 || hn > 1.0) return 0.0;
  // 垂直剖面：底部略平、顶部收窄（积云的团块感）
  float vert = smoothstep(0.0, 0.16, hn) * (1.0 - smoothstep(0.58, 1.0, hn));
  vec3 q = vec3(p.xz * (1.0 / 1300.0), p.y * (1.0 / 900.0));
  float det = fbm3(q, oct);
  return max((det * 1.55 - 0.52) * cov * vert, 0.0);
}
// 云层（水平板）与视线的交点区间；相机在云层下方，只有向上看才会命中
bool cloudSlab(vec3 o, vec3 d, out float t0, out float t1) {
  if (abs(d.y) < 1e-4) return false;
  float ta = (CLOUD_BASE - o.y) / d.y;
  float tb = (CLOUD_TOP - o.y) / d.y;
  t0 = min(ta, tb);
  t1 = max(ta, tb);
  if (t1 <= 0.0) return false;
  t0 = max(t0, 0.0);
  return true;
}

// ---------- 体积云：沿视线 ray marching + 向太阳的短积分 ----------
// 返回 (rgb = 云散射亮度, a = 不透明度)，由调用方做 over 合成。
vec4 marchClouds(vec3 dir) {
  if (uCloudEnabled == 0) return vec4(0.0);
  float t0, t1;
  if (!cloudSlab(uCamPos, dir, t0, t1)) return vec4(0.0);
  // 远距离上限：贴近地平线时云层被压成一条带，太远只会产生噪点
  t1 = min(t1, 90000.0);
  float span = t1 - t0;
  if (span <= 1.0) return vec4(0.0);

  float steps = float(max(uCloudSteps, 1));
  float ds = span / steps;
  // 抖动起点：把步进条带打散成噪声（配合后期颗粒，肉眼几乎不可见）
  float t = t0 + ds * hash13(vec3(gl_FragCoord.xy, uTime * 0.37));

  float mu = dot(dir, uSunDir);
  // 双叶相位：主瓣 g=0.6 前向散射（逆光金边）+ 少量背向散射，避免背光面死黑
  float phase = mix(phaseHG(mu, G_CLOUD), phaseHG(mu, -0.15), 0.30);

  // 云层高度的入射太阳光：先过一遍大气透过率 → 日落时云会被自然染成暖色/橙红
  vec3 sunAtCloud = uSunColor * sunTransmittance(mix(CLOUD_BASE, CLOUD_TOP, 0.5), uSunDir)
                    * (uSunE * 0.30);
  // 天光（云的背光面）：取地平线↔天顶的天空色，云底偏暗、云顶偏亮
  vec3 ambTop = mix(uHorizon, uZenith, 0.72);
  vec3 ambCol = mix(uGround, ambTop, 0.62) * (0.30 + uSunE * 0.02);

  vec3 L = vec3(0.0);
  float T = 1.0;
  for (int i = 0; i < 64; i++) {
    if (i >= uCloudSteps) break;
    if (T < 0.012) break;
    vec3 p = uCamPos + dir * (t + ds * 0.5);
    t += ds;
    float cov = cloudCoverage(p.xz);
    float dens = cloudShape(p, cov, uCloudOctaves);
    if (dens <= 0.0008) continue;

    float ext = dens * ds * uCloudDensity;
    float Tl = exp(-ext);

    // 向太阳方向 2~5 步短积分：光在云里被吸收多少 → 云的自阴影 / 亮边
    float tau = 0.0;
    for (int j = 0; j < 6; j++) {
      if (j >= uCloudLightSteps) break;
      float sl = 90.0 + 70.0 * float(j);
      vec3 q = p + uSunDir * (sl * (float(j) + 0.5));
      tau += cloudShape(q, cov, 2) * sl;    // 短积分只需 2 层噪声（细节不可辨）
    }
    float lightT = exp(-tau * uCloudDensity * 1.35);

    float hn = clamp((p.y - CLOUD_BASE) * CLOUD_INV_T, 0.0, 1.0);
    vec3 sunL = sunAtCloud * (phase * lightT * uCloudSunGain);
    vec3 amb = ambCol * ((0.55 + 0.45 * hn) * uCloudAmbGain);   // 云顶受天光更多
    vec3 col = sunL + amb;

    L += T * (1.0 - Tl) * col;
    T *= Tl;
  }
  // 贴地平线时淡出，避免云带被压成一条硬边
  float fade = smoothstep(0.0, 0.045, dir.y);
  return vec4(L * fade, (1.0 - T) * fade);
}

// ---------- 星空（夜间）----------
float starField(vec3 dir) {
  if (uStarAlpha <= 0.001) return 0.0;
  vec3 p = dir * 320.0;
  vec3 id = floor(p);
  vec3 f = fract(p) - 0.5;
  float h = hash13(id);
  float on = step(0.9962, h);                     // 只有极少数格子有星
  float mag = clamp((h - 0.9962) / 0.0038, 0.0, 1.0);
  float blob = 1.0 - smoothstep(0.0, 0.46, length(f));
  float tw = 0.75 + 0.25 * sin(uTime * 2.3 + h * 91.7);   // 轻微闪烁
  return on * blob * (0.35 + 0.9 * mag * mag) * tw * uStarAlpha * smoothstep(0.0, 0.12, dir.y);
}

// ---------- 天空总辐亮度 ----------
vec3 skyRadiance(vec3 dir) {
  vec3 col = atmosphereScatter(dir);

  // 天光基底：由 uZenith / uHorizon 直接给色。白天是很薄的一层（uAmbient=0.06），
  // 夜晚 uAmbient→1 就是夜空本身。这样昼夜切换只改那 6 个契约 uniform 也成立。
  float up = clamp(dir.y, 0.0, 1.0);
  vec3 amb = mix(uHorizon, uZenith, pow(up, 0.55));
  col += amb * uAmbient;

  // 地平线朦胧层（uHaze）：大气路径最长的一段，气溶胶/水汽在这里最明显
  float hz = pow(1.0 - clamp(abs(dir.y) * 2.6, 0.0, 1.0), 3.0);
  col = mix(col, col * 0.55 + uHaze * (0.45 * uAmbient + 0.16), hz * 0.55);

  // 地平线以下：地面色（大部分像素会被地形盖掉，这里只防穿帮）
  col = mix(col, uGround * (0.35 + 0.9 * uAmbient), 1.0 - smoothstep(-0.05, 0.0, dir.y));

#ifndef LUT_PASS
  // 星空（云在后面合成时会自然遮挡）
  col += vec3(0.90, 0.95, 1.0) * starField(dir);

  // 日盘：角半径约 0.27°，边缘柔化。
  // 亮度刻意压到 ACES 刚好接近饱和（而不是远超），否则云层再怎么遮挡都会是纯白，
  // 观感上“云挡不住太阳”；真正的耀眼感交给 Bloom + 日晕 sprite。
  float mu = dot(dir, uSunDir);
  float disk = smoothstep(0.999978, 0.999992, mu);
  if (disk > 0.0) {
    vec3 Tsun = sunTransmittance(max(uCamPos.y, 0.0), uSunDir);
    col += uSunColor * Tsun * disk * (uSunE * 1.45);
  }
#endif

  return max(col, vec3(0.0));
}
`;

// 天空球顶点着色器：球面位置即方向，深度钉在远平面
const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = clip.xyww;   // z/w = 1 → 落在最远处；配合 LessEqual 深度测试只填没有物体的像素
}
`;

// LUT 顶点着色器：全屏四边形，方向由 uv 还原（等距柱状）
const LUT_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// 天空球 / 环境球共用的 uniform 声明（两边是同一批 value 对象）
const SKY_UNIFORM_DECL = /* glsl */`
uniform vec3 uSunDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uHaze;
uniform vec3 uGround;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uCamPos;
uniform float uTime;
uniform float uSunE;          // 太阳辐照度标定（把物理辐亮度映射到 ACES 曝光下的可用亮度）
uniform float uAmbient;       // 天光基底权重（白天 0.06 / 夜晚 1.0）
uniform float uStarAlpha;     // 星空强度（夜晚才亮）
uniform int uScatterSteps;    // 视线散射积分步数
uniform int uSunSteps;        // 太阳方向透过率积分步数
uniform int uCloudEnabled;
uniform int uCloudSteps;
uniform int uCloudLightSteps;
uniform int uCloudOctaves;
uniform vec2 uCloudOffset;    // 云的水平漂移（随风累积）
uniform float uCloudCoverage; // 云量 0..1
uniform float uCloudDensity;  // 云的消光系数标定
uniform float uCloudSunGain;  // 云的太阳散射增益（标定用，把单次散射量级映射到可用亮度）
uniform float uCloudAmbGain;  // 云的天光增益
`;

function buildSkyFragment() {
  return /* glsl */`
${SKY_UNIFORM_DECL}
varying vec3 vDir;

${GLSL_COMMON}

void main() {
  vec3 dir = normalize(vDir);
  vec3 col = skyRadiance(dir);

  // 体积云合成（over）：云在前景时遮住日盘与星空
  vec4 cl = marchClouds(dir);
  col = col * (1.0 - cl.a) + cl.rgb;

  gl_FragColor = vec4(col, 1.0);
  // 注意：WebGLProgram 会为 toneMapped 材质自动注入 tonemapping / colorspace 的 *_pars 声明，
  // 这里不能再 #include 这两个 pars chunk，否则函数重复定义导致着色器编译失败。
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
}

// 大气透视 LUT：等距柱状，输出线性 HDR 辐亮度（不做色调映射）
function buildLutFragment() {
  return /* glsl */`
#define LUT_PASS
${SKY_UNIFORM_DECL}
varying vec2 vUv;

${GLSL_COMMON}

void main() {
  // uv → 方向（与 JS 侧 atan2 / asin 的采样映射完全一致）
  float phi = (vUv.x - 0.5) * 2.0 * PI;
  float theta = (vUv.y - 0.5) * PI;
  float ct = cos(theta);
  vec3 dir = vec3(ct * cos(phi), sin(theta), ct * sin(phi));
  gl_FragColor = vec4(skyRadiance(normalize(dir)), 1.0);
}
`;
}

// ============================================================
// 大气透视：给场景里已有的 PBR 材质注入"按视线方向取天空色"的雾
// ============================================================
// 顶点：像素相对相机的视线方向（世界空间 = viewMatrix 旋转部分的转置 × 视图向量）与距离
const AERIAL_VERT_CODE = /* glsl */`
vAerialDist = length(mvPosition.xyz);
vAerialDir = vec3(
  dot(viewMatrix[0].xyz, mvPosition.xyz),
  dot(viewMatrix[1].xyz, mvPosition.xyz),
  dot(viewMatrix[2].xyz, mvPosition.xyz)
);
`;
// 片元：放在色调映射之前（此时 gl_FragColor 还是线性 HDR）
const AERIAL_FRAG_CODE = /* glsl */`
{
  vec3 aDir = normalize(vAerialDir);
  vec2 aUv = vec2(atan(aDir.z, aDir.x) * 0.15915494 + 0.5,
                  asin(clamp(aDir.y, -1.0, 1.0)) * 0.31830989 + 0.5);
  vec3 aSky = texture2D(uAerialLUT, aUv).rgb;
  // 指数雾（与旧版 FogExp2 同观感）；抬头看时空气柱更短 → 雾更淡
  float aH = mix(1.0, 0.45, clamp(aDir.y, 0.0, 1.0));
  float aF = 1.0 - exp(-pow(vAerialDist * uAerialDensity * aH, 2.0));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, aSky * uAerialTint, clamp(aF * uAerialStrength, 0.0, 0.97));
}
`;

const AERIAL_VERT_DECL = /* glsl */`
varying float vAerialDist;
varying vec3 vAerialDir;
`;
const AERIAL_FRAG_DECL = /* glsl */`
uniform sampler2D uAerialLUT;
uniform float uAerialDensity;
uniform float uAerialStrength;
uniform vec3 uAerialTint;
varying float vAerialDist;
varying vec3 vAerialDir;
`;

// ============================================================
// JS 侧：与 GLSL 完全一致的覆盖度近似（只用于判断"太阳 sprite 是否被云挡住"）
// ============================================================
const fract = (x) => x - Math.floor(x);
function hash12js(x, y) {
  // 对应 GLSL: p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx + 33.33);
  //            return fract((p3.x + p3.y) * p3.z);
  const px = fract(x * 0.1031);
  const py = fract(y * 0.1031);
  const d = px * (py + 33.33) + py * (px + 33.33) + px * (px + 33.33);
  const ax = px + d, ay = py + d, az = px + d;
  return fract((ax + ay) * az);
}
function vnoise2js(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = hash12js(ix, iy);
  const b = hash12js(ix + 1, iy);
  const c = hash12js(ix, iy + 1);
  const d = hash12js(ix + 1, iy + 1);
  const ab = a + (b - a) * ux;
  const cd = c + (d - c) * ux;
  return ab + (cd - ab) * uy;
}
function fbm2js(x, y, oct) {
  let sum = 0, amp = 0.5, norm = 0;
  let px = x, py = y;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise2js(px, py);
    norm += amp;
    px = px * 2.03 + 11.7;
    py = py * 2.03 + 5.3;
    amp *= 0.5;
  }
  return sum / Math.max(norm, 1e-4);
}
function smoothstepJs(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function coverageJs(x, z, ox, oz) {
  const qx = (x + ox) / 2600, qz = (z + oz) / 2600;
  let cov = smoothstepJs(0.46, 0.62, fbm2js(qx, qz, 3));
  const n = fbm2js(qx * 3.3 + 7.7, qz * 3.3 + 7.7, 2);
  cov *= smoothstepJs(0.24, 0.60, n * 0.70 + cov * 0.52);
  return cov;
}

// ============================================================
// 入口
// ============================================================
export function createSky(scene, { renderer = null, preset = null, anisotropy = 1 } = {}) {
  const group = new THREE.Group();
  group.name = 'sky';
  scene.add(group);

  const sunDir = new THREE.Vector3(SUN.dir[0], SUN.dir[1], SUN.dir[2]).normalize();
  const disposables = [];

  // ---------- 共享 uniform（天空球 / 环境球 / LUT 三个材质共用同一批 value 对象）----------
  const uniforms = {
    // —— 与 world.js 的契约：昼夜切换直接写这六个，名字不可改 ——
    uZenith: { value: new THREE.Color(0x4c80b8) },
    uHorizon: { value: new THREE.Color(0xc6d7e4) },
    uHaze: { value: new THREE.Color(0xe9dcc2) },
    uGround: { value: new THREE.Color(0x6d6a52) },
    uSunColor: { value: new THREE.Color(0xffedcd) },
    uSunIntensity: { value: 1.0 },
    // —— 物理 / 渲染参数 ——
    uSunDir: { value: sunDir.clone() },
    uCamPos: { value: new THREE.Vector3(0, 2, 0) },
    uTime: { value: 0 },
    uSunE: { value: SUN_E_DAY },
    uAmbient: { value: 0.06 },
    uStarAlpha: { value: 0 },
    uScatterSteps: { value: TIER.high.scatter },
    uSunSteps: { value: TIER.high.sun },
    uCloudEnabled: { value: 1 },
    uCloudSteps: { value: TIER.high.cloud },
    uCloudLightSteps: { value: TIER.high.light },
    uCloudOctaves: { value: TIER.high.oct },
    uCloudOffset: { value: new THREE.Vector2(0, 0) },
    uCloudCoverage: { value: CLOUD_COVERAGE },
    uCloudDensity: { value: CLOUD_DENSITY },  // 云的消光系数（1/m 每单位密度）
    uCloudSunGain: { value: CLOUD_SUN_GAIN }, // 云的太阳散射增益（标定值）
    uCloudAmbGain: { value: CLOUD_AMB_GAIN }, // 云的天光增益（标定值）
  };

  // ---------- 天空球 ----------
  // 深度钉在远平面 + renderOrder 靠后（但必须早于远山之后的一切），
  // 这样只在没有几何体的像素上跑着色器（省 overdraw）。
  //
  // 【重要】renderOrder 必须小于远山的 -950：天空球是不透明全屏壳，
  // 若在远山之后绘制会把 1500m 外的雪山整片盖住（实测远山完全消失）。
  // 现在顺序：环境球 -1000 → 天空球 -980 → 远山 -950 → 实体 0。
  // 天空球本身 depthWrite:false 且钉在远平面，不会遮挡实体。
  const skyGeo = new THREE.SphereGeometry(SKY_RADIUS, 32, 16);
  const skyMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: SKY_VERT,
    fragmentShader: buildSkyFragment(),
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    depthFunc: THREE.LessEqualDepth,
    fog: false,
  });
  skyMat.toneMapped = true;
  const skyMesh = new THREE.Mesh(skyGeo, skyMat);
  skyMesh.name = 'skyDome';
  skyMesh.renderOrder = -980;
  skyMesh.frustumCulled = false;
  group.add(skyMesh);
  disposables.push(skyGeo, skyMat);

  // ---------- 太阳光晕 Sprite ----------
  // 保留"material.opacity 可写"的契约；云遮挡时在 update 里按遮挡率压暗。
  const glowTex = makeSunGlowTexture();
  let sunSprite = null;
  let sunBaseOpacity = 0.85;   // 外部（world.js 昼夜切换）设定的基准不透明度
  let lastSunOpacity = -1;
  if (glowTex) {
    const glowMat = new THREE.SpriteMaterial({
      map: glowTex,
      color: 0xfff2d8,
      transparent: true,
      opacity: sunBaseOpacity,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    sunSprite = new THREE.Sprite(glowMat);
    sunSprite.scale.setScalar(26);
    // 太阳光晕也在远山之前绘制（-979），否则会盖住 1500m 外的雪山
    sunSprite.renderOrder = -979;
    sunSprite.position.copy(sunDir).multiplyScalar(SKY_RADIUS * 0.98);
    group.add(sunSprite);
    disposables.push(glowTex, glowMat);
  }

  // ---------- 大气透视 LUT（64×32 等距柱状 HDR）----------
  // 天空散射积分烘焙成小图；材质雾只需一次纹理采样就拿到"该方向的天空色"。
  let aerial = null;
  let aerialDirty = true;
  let aerialClock = 0;

  function buildAerial() {
    if (!renderer) return null;
    try {
      const rt = new THREE.WebGLRenderTarget(64, 32, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        colorSpace: THREE.LinearSRGBColorSpace,
        depthBuffer: false,
        generateMipmaps: false,
      });
      rt.texture.name = 'skyAerialLUT';
      const mat = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: LUT_VERT,
        fragmentShader: buildLutFragment(),
        depthTest: false,
        depthWrite: false,
      });
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
      quad.frustumCulled = false;
      const lutScene = new THREE.Scene();
      lutScene.add(quad);
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      return { rt, scene: lutScene, camera, quad, mat };
    } catch (e) {
      return null;
    }
  }
  aerial = buildAerial();

  function renderAerial() {
    if (!aerial || !renderer) return;
    const prevRT = renderer.getRenderTarget();
    const prevTone = renderer.toneMapping;
    try {
      renderer.toneMapping = THREE.NoToneMapping;   // LUT 必须是线性 HDR
      renderer.setRenderTarget(aerial.rt);
      renderer.render(aerial.scene, aerial.camera);
    } catch (e) {
      /* 渲染失败时静默降级 */
    } finally {
      renderer.setRenderTarget(prevRT);
      renderer.toneMapping = prevTone;
    }
    aerialDirty = false;
  }
  renderAerial();

  // ---------- 材质注入：大气透视 ----------
  const patchedMaterials = new WeakSet();
  const aerialUniforms = {
    uAerialLUT: { value: aerial ? aerial.rt.texture : null },
    // 与旧 FogExp2 同观感：density = sqrt(2.3)/fogFar（fogFar 处约 90% 雾化）
    uAerialDensity: { value: Math.sqrt(2.3) / AERIAL_VISIBILITY },
    uAerialStrength: { value: 1.0 },
    uAerialTint: { value: new THREE.Color(1, 1, 1) },
  };

  function patchMaterial(mat) {
    if (!aerial || !mat || patchedMaterials.has(mat)) return false;
    const isMesh = mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial
      || mat.isMeshLambertMaterial || mat.isMeshPhongMaterial
      || mat.isMeshToonMaterial || mat.isMeshBasicMaterial;
    // 透明 / 非普通混合（标记、加色特效）不做大气透视，避免破坏它们的观感
    if (!isMesh || mat.transparent || mat.blending !== THREE.NormalBlending) return false;
    if (typeof mat.onBeforeCompile !== 'function') return false;
    patchedMaterials.add(mat);

    const prevCompile = mat.onBeforeCompile;
    const prevKey = mat.customProgramCacheKey;
    // 关掉内置雾，改用我们自己的方向相关雾（否则会在色调映射之后被叠两次）
    mat.fog = false;
    mat.onBeforeCompile = function (shader, rendererInstance) {
      if (typeof prevCompile === 'function') prevCompile.call(this, shader, rendererInstance);
      shader.uniforms.uAerialLUT = aerialUniforms.uAerialLUT;
      shader.uniforms.uAerialDensity = aerialUniforms.uAerialDensity;
      shader.uniforms.uAerialStrength = aerialUniforms.uAerialStrength;
      shader.uniforms.uAerialTint = aerialUniforms.uAerialTint;
      shader.vertexShader = AERIAL_VERT_DECL + shader.vertexShader;
      if (shader.vertexShader.indexOf('#include <fog_vertex>') >= 0) {
        shader.vertexShader = shader.vertexShader.replace('#include <fog_vertex>', AERIAL_VERT_CODE);
      }
      shader.fragmentShader = AERIAL_FRAG_DECL + shader.fragmentShader;
      if (shader.fragmentShader.indexOf('#include <tonemapping_fragment>') >= 0) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <tonemapping_fragment>',
          AERIAL_FRAG_CODE + '\n#include <tonemapping_fragment>'
        );
      }
    };
    mat.customProgramCacheKey = () => 'aerial1|' + (typeof prevKey === 'function' ? prevKey.call(mat) : '');
    mat.needsUpdate = true;
    return true;
  }

  // 场景材质是陆续加进来的（world.js 先建 sky，再建地形 / 建筑 / 植被），
  // 所以不能只在创建时扫一次：必须每帧检查新出现的材质，直到全部处理完。
  // 用 WeakSet 去重，重复扫描的代价只是遍历一次场景树。
  let scanClock = 1e9;   // 首帧就扫（此时场景还没建完，之后由 update 继续补）
  let patchPending = 0;
  function patchSceneMaterials() {
    let added = 0;
    scene.traverse((o) => {
      const m = o.material;
      if (!m) return;
      const list = Array.isArray(m) ? m : [m];
      for (const mm of list) if (patchMaterial(mm)) added++;
    });
    patchPending = added;
    return added;
  }
  patchSceneMaterials();

  // ---------- PMREM 环境贴图 ----------
  let envRT = null;
  let envError = null;
  let envPMREM = null;
  let bakedNight = 0;
  let envClock = 0;

  function bakeEnvironment() {
    if (!renderer || typeof THREE.PMREMGenerator !== 'function') return;
    try {
      if (!envPMREM) envPMREM = new THREE.PMREMGenerator(renderer);
      const envScene = new THREE.Scene();
      // 环境球用独立材质实例（关深度测试 + 先画），保证地面 / 日盘能覆盖它
      const envMat = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: SKY_VERT,
        fragmentShader: buildSkyFragment(),
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        fog: false,
      });
      envMat.toneMapped = true;
      const envSky = new THREE.Mesh(skyGeo, envMat);
      envSky.renderOrder = -1000;
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
      const haloGeo = new THREE.SphereGeometry(120, 16, 10);
      const haloMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(1.6, 1.35, 1.0), transparent: true, opacity: 0.5, fog: false,
        depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const halo = new THREE.Mesh(haloGeo, haloMat);
      halo.position.copy(disk.position);
      envScene.add(halo);

      // 环境贴图里不放云（省时间，也避免 PMREM 里出现噪声）
      const cloudWas = uniforms.uCloudEnabled.value;
      uniforms.uCloudEnabled.value = 0;
      let rt = null;
      try {
        rt = envPMREM.fromScene(envScene, 0.02, 0.1, 2000);
      } finally {
        uniforms.uCloudEnabled.value = cloudWas;
        envScene.remove(envSky);
        envMat.dispose();
        groundGeo.dispose(); groundMat.dispose();
        diskGeo.dispose(); diskMat.dispose();
        haloGeo.dispose(); haloMat.dispose();
      }
      if (rt) {
        if (envRT) envRT.dispose();
        envRT = rt;
        scene.environment = rt.texture;
        scene.environmentIntensity = 0.85;
      }
    } catch (e) {
      envError = e;
    }
  }
  bakeEnvironment();

  // ---------- 画质 ----------
  const state = { preset, tier: 'high', time: 0, cloudCover: 0 };

  function tierOf(p) {
    if (typeof p === 'string') return TIERS.indexOf(p) >= 0 ? p : 'high';
    if (p && p.label && LABEL_TIER[p.label]) return LABEL_TIER[p.label];
    if (p && p.clouds === false) return 'low';
    return 'high';
  }

  function applyTier(t) {
    const cfg = TIER[t] || TIER.high;
    state.tier = t;
    uniforms.uScatterSteps.value = cfg.scatter;
    uniforms.uSunSteps.value = cfg.sun;
    uniforms.uCloudSteps.value = cfg.cloud;
    uniforms.uCloudOctaves.value = cfg.oct;
    uniforms.uCloudLightSteps.value = cfg.light;
  }

  function setQuality(p) {
    state.preset = p;
    const t = tierOf(p);
    applyTier(t);
    // quality.js 的低档明确写了 clouds:false → 直接关掉体积云
    uniforms.uCloudEnabled.value = (p && p.clouds === false) ? 0 : 1;
    if (sunSprite) sunSprite.visible = true;
    aerialDirty = true;
    return t;
  }
  if (preset) setQuality(preset);
  else applyTier('high');

  // ---------- 逐帧 ----------
  function syncDerived() {
    // 昼夜强度：uSunIntensity 1.0(白天) → 0.18(夜晚)。用它推导天光基底 / 星空 / 太阳辐照度，
    // 这样 world.js 只写那 6 个契约 uniform 也能得到完整的昼夜外观。
    const si = uniforms.uSunIntensity.value;
    const dayF = THREE.MathUtils.clamp((si - 0.16) / 0.84, 0, 1);
    uniforms.uAmbient.value = THREE.MathUtils.lerp(1.0, 0.06, dayF);
    uniforms.uStarAlpha.value = Math.pow(1 - dayF, 1.5);
    // 散射积分里的太阳辐照度：随昼夜按平方衰减（夜晚几乎无直射散射）
    uniforms.uSunE.value = SUN_E_DAY * dayF * dayF;
    return dayF;
  }

  // 太阳 sprite 是否被云挡住：沿太阳方向对云层做一次粗积分（JS 版覆盖度噪声）。
  // 注意：这里积分的是“覆盖度”而不是真实密度，所以用系数 0.12 把它换算成
  // 等效光学厚度（云内部密度只有云团边界的一半左右），否则任何一朵云都会把太阳压到全黑。
  function cloudOcclusion() {
    if (uniforms.uCloudEnabled.value === 0) return 1;
    const camY = uniforms.uCamPos.value.y;
    if (sunDir.y <= 0.02) return 1;
    const t0 = (CLOUD_BASE - camY) / sunDir.y;
    const t1 = (CLOUD_TOP - camY) / sunDir.y;
    const steps = 8;
    const ds = (t1 - t0) / steps;
    let tau = 0;
    for (let i = 0; i < steps; i++) {
      const t = t0 + ds * (i + 0.5);
      const x = uniforms.uCamPos.value.x + sunDir.x * t;
      const z = uniforms.uCamPos.value.z + sunDir.z * t;
      // 与 GLSL 一致：覆盖度噪声再乘上云量 uCloudCoverage
      tau += coverageJs(x, z, uniforms.uCloudOffset.value.x, uniforms.uCloudOffset.value.y)
        * uniforms.uCloudCoverage.value * ds;
    }
    const T = Math.exp(-tau * uniforms.uCloudDensity.value * 0.12);
    state.cloudCover = 1 - T;
    return T;
  }

  function update(dt, camera) {
    const step = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0.016;
    state.time += step;
    uniforms.uTime.value = state.time;

    if (camera) {
      group.position.copy(camera.position);
      uniforms.uCamPos.value.copy(camera.position);
    }

    // 云随风漂移（取模保持浮点精度）
    const off = uniforms.uCloudOffset.value;
    off.x = (off.x + CLOUD_WIND.x * CLOUD_WIND_SPEED * step) % CLOUD_OFFSET_WRAP;
    off.y = (off.y + CLOUD_WIND.y * CLOUD_WIND_SPEED * step) % CLOUD_OFFSET_WRAP;

    const dayF = syncDerived();

    // 太阳 sprite：外部（昼夜切换）改了 opacity 就当作新的基准值，避免逐帧叠乘
    if (sunSprite && sunSprite.material) {
      const mat = sunSprite.material;
      if (lastSunOpacity < 0 || Math.abs(mat.opacity - lastSunOpacity) > 1e-4) {
        sunBaseOpacity = mat.opacity;
      }
      const occ = cloudOcclusion();
      // 下限 0.15：日晕是散射光，厚云后面也不会完全消失（否则看起来像 bug）
      mat.opacity = sunBaseOpacity * (0.15 + 0.85 * occ);
      lastSunOpacity = mat.opacity;
    }

    // 材质注入扫描：新加进场景的材质在一个扫描周期内被补上。
    // 用“本帧新增数”做早停：全部处理完以后退化为 1s 一次的低频扫描。
    scanClock += step;
    if (patchPending > 0 || scanClock > 1.0) {
      scanClock = 0;
      patchSceneMaterials();
    }

    // 大气透视 LUT 重烘焙（64×32，开销可忽略；0.25s 一次足够跟上昼夜过渡）
    aerialClock += step;
    if (aerialDirty || aerialClock > 0.25) {
      aerialClock = 0;
      renderAerial();
    }

    // 环境贴图跟随昼夜重烘焙（过渡期间约 3 次）
    const nightF = 1 - dayF;
    envClock += step;
    if (Math.abs(nightF - bakedNight) > 0.34 && envClock > 0.25) {
      envClock = 0;
      bakedNight = nightF;
      bakeEnvironment();
    }
  }

  function dispose() {
    scene.remove(group);
    for (const d of disposables) if (d && d.dispose) d.dispose();
    if (aerial) {
      aerial.scene.remove(aerial.quad);
      aerial.quad.geometry.dispose();
      aerial.mat.dispose();
      aerial.rt.dispose();
      aerial = null;
    }
    if (envPMREM) { envPMREM.dispose(); envPMREM = null; }
    if (envRT) {
      if (scene.environment === envRT.texture) scene.environment = null;
      envRT.dispose();
      envRT = null;
    }
  }

  // clouds：保持数组形态（world.js 只透传）。元素描述体积云层参数。
  const clouds = [{
    type: 'volumetric',
    base: CLOUD_BASE,
    top: CLOUD_TOP,
    mesh: skyMesh,
    mat: skyMat,
    get coverage() { return state.cloudCover; },
  }];

  return {
    group,
    sunDir,
    skyMat,
    sunSprite,
    clouds,
    get envRT() { return envRT; },
    get envError() { return envError; },
    update,
    setQuality,
    dispose,
    // 调试 / 自测辅助（world.js 不依赖）
    uniforms,
    get tier() { return state.tier; },
    refreshEnv: () => { bakeEnvironment(); aerialDirty = true; },
  };
}
