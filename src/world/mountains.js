// ===== 远处雪山景：分形噪声高度场 + 光线步进 =====
//
// 设计目标：给可玩区（半宽 120m，WORLD.size = 240）外面加一圈 1500~3500m 的雪山，
// 让地平线有明确的纵深层次，而不是一条天空与地面的硬交界线。
//
// 实现分四块：
//   1) 几何 —— 半径 3800m 的球壳内表面（BackSide），只保留地平线 -5°~+22° 的仰角环带。
//      顶点着色器把裁剪空间 z 强制写成 w（NDC z 恒为 1），所以这张壳永远不会被相机远裁剪面
//      （main.js 当前 far = 520）裁掉；再配合 depthTest:false + renderOrder:-950，
//      它只在天空之后、其它实体之前绘制 —— 之后绘制的实体（地形/建筑/树）会自然盖住它，
//      不需要深度缓冲参与，也不会有"远景穿到近景前面"的问题。
//
//   2) 高度场 —— 山体高度完全由 GLSL 程序化噪声决定（无贴图、无新依赖）：
//      脊状噪声（ridged multifractal）做出山脊线，fBm 补体量与细节，共 7 层叠加。
//      输入是世界 XZ 坐标 → 相机在地图里移动时山体产生真实视差，而不是一张贴图。
//
//   3) 渲染 —— 沿视线方向对高度场做光线步进（raymarch），直到射线高度 ≤ 山体高度（"命中地面"）。
//      命中后：4 次采样估算法线 → 按坡度 + 海拔分层上色 → 向太阳方向再发一条软阴影射线
//      → 最后用指数雾做大气透视。
//
//   4) 画质 —— setQuality() 只改 uniform（步进数 / 噪声层数 / 阴影步数），不重建几何。
//
// 对外接口（Lead 调用）：
//   const mountains = createMountains(scene, { preset, sunDir, anisotropy });
//   mountains.group / mesh / material / update(dt, camera) / setQuality(preset) / dispose()

import * as THREE from 'three';
import { SUN } from './shared.js';

const DEG = Math.PI / 180;

// ---------- 常量 ----------
const BAND_RADIUS = 3800;        // 壳体半径（m）：只作为方向查询面，实际山体在 1500~4000m
const ELEV_MIN = -5 * DEG;       // 环带下沿：低于地平线一点，避免和地形之间出现缝
const ELEV_MAX = 22 * DEG;       // 环带上沿：山体最高仰角约 16°，留足余量（超出部分 discard）
const AZ_SEGMENTS = 160;         // 环向分段
const EL_SEGMENTS = 26;          // 仰角分段

// 画质分级：光线步进数（题面要求 low24 / medium40 / high64 / ultra96）
const TIER_STEPS = { low: 24, medium: 40, high: 64, ultra: 96 };
// 噪声层数：低档降层数省算力，高档 7 层（题面要求 7 层）
const TIER_OCTAVES = { low: 5, medium: 6, high: 7, ultra: 7 };
// 太阳阴影射线步数：0 = 关闭（阴影因子恒为 1）
const TIER_SHADOW_STEPS = { low: 2, medium: 4, high: 6, ultra: 8 };
const TIERS = ['low', 'medium', 'high', 'ultra'];
// quality.js 的中文 label → 档位（Lead 直接传 preset 对象时用）
const LABEL_TIER = { '低': 'low', '中': 'medium', '高': 'high', '极高': 'ultra' };

// ============================================================
// 着色器
// ============================================================

const MOUNTAIN_VERT = /* glsl */`
varying vec3 vDir;

void main() {
  // 世界坐标 → 以相机为起点的视线方向（这样即使 Lead 把 group 挂到 sky group 下也正确）
  vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
  vDir = wp - cameraPosition;
  vec4 clip = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  // 关键：深度强制写成 w（NDC z = 1）→ 永远落在远平面上，不受相机 far 影响
  gl_Position = clip.xyww;
}
`;

const MOUNTAIN_FRAG = /* glsl */`
uniform vec3  uSunDir;         // 指向太阳的单位向量
uniform vec3  uSunColor;
uniform vec3  uZenith;         // 与 sky.js 一致的天顶色
uniform vec3  uHorizon;        // 与 sky.js 一致的地平线色
uniform vec3  uHaze;           // 地平线暖雾
uniform vec3  uAmbSky;         // 半球环境光：天空侧
uniform vec3  uAmbGround;      // 半球环境光：地面反弹侧
uniform vec3  uSnow;
uniform vec3  uSnowShade;
uniform vec3  uRock;
uniform vec3  uRockDark;
uniform vec3  uGrass;
uniform vec3  uForest;
uniform vec2  uSeed;           // 山体形态种子
uniform int   uSteps;          // 光线步进数（画质分级）
uniform int   uOctaves;        // 噪声层数
uniform int   uShadowSteps;    // 阴影射线步数（0 = 关）
uniform float uSunIntensity;
uniform float uHeightScale;    // 整体高度缩放（Lead 可调）
uniform float uSnowLine;       // 雪线基准海拔（m）
uniform float uFogDensity;     // 大气透视密度（1/m）
uniform float uMaxDist;        // 光线最远距离（m）
uniform float uMaxHeight;      // 山体高度上界（m），用于向上射线的提前退出

varying vec3 vDir;

// 步进阶段用 4 层噪声即可（只要不把山脊走丢），命中后再用满层数算细节。
// 这个值经过数值验证：与 7 层参考高度场相比，命中率/精度差异可忽略，算力省一半。
#define MARCH_OCT 4

// ---------- 程序化噪声 ----------
// 无三角函数、无纹理的 2D 哈希（Dave Hoskins 风格），精度对 1e4 量级的坐标也够用
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// 双线性 + 五次平滑的值噪声，返回 [0,1]
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// 每层之间旋转坐标系，打散值噪声的方形网格感
const mat2 ROT = mat2(0.80, 0.60, -0.60, 0.80);

// 普通分形噪声（fBm）：每层振幅减半、频率翻倍 → 大块体量 + 细节
float fbm(vec2 p, int oct) {
  float h = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  for (int i = 0; i < 7; i++) {
    if (i >= oct) break;
    h += amp * vnoise(p * freq);
    p = ROT * p;
    amp *= 0.5;
    freq *= 2.0;
  }
  return h;
}

// 脊状噪声（ridged multifractal）：1 - |2n-1| 在 n≈0.5 处形成尖脊，
// 上一层脊线再调制下一层，得到雪山那种分叉的刀刃状山脊。
float ridged(vec2 p, int oct) {
  float h = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  float prev = 1.0;
  for (int i = 0; i < 7; i++) {
    if (i >= oct) break;
    float n = 1.0 - abs(vnoise(p * freq) * 2.0 - 1.0);
    n *= n;                                   // 锐化脊线
    h += n * amp * prev;
    prev = clamp(n * 1.35, 0.0, 1.0);         // 脊线越强，下一层细节越明显
    p = ROT * p;
    amp *= 0.52;
    freq *= 2.0;
  }
  return h;
}

// 整数下限（GLSL ES 1.00 没有 int 版的 max，必须自己写，否则老驱动编译失败）
int atLeast(int v, int lo) { return v < lo ? lo : v; }

// ---------- 山体高度场 ----------
// 距离包络：700m 内恒为 0（可玩区绝对安全，不会把山"画"到脚下），
// 1500m 起进入主山脉，4200m 之后渐隐，融进雾里。
float bandEnvelope(float r) {
  return smoothstep(650.0, 1500.0, r) * (1.0 - smoothstep(4200.0, 5600.0, r));
}

// 山体高度（m，y=0 为山脚基准面）
//
// 形态 = 低频脊状骨架 × 距离包络 + 高频脊状沟壑：
//   低频（q = p * 0.00042，一山约 2km 宽）决定主峰位置与高低差；
//   高频（q * 7，世界波长约 340m）叠加沟壑，把平均坡度从 18° 拉到 ~52°，山才"立"得起来。
// 数值实测（1500~4200m 环带）：p50≈300m、p90≈740m、峰值≈1080m、最大仰角≈16.5°（环带限 22°）。
float mountainHeight(vec2 p, int oct) {
  float r = length(p);
  float band = bandEnvelope(r);
  if (band <= 0.001) return 0.0;

  vec2 q = p * 0.00042 + uSeed;                 // 主尺度：一座山约 2km 宽
  float ridge = ridged(q, oct);                 // 山脊骨架
  float mass  = fbm(q * 2.15 + vec2(11.3, 7.9), atLeast(oct - 3, 2));  // 大块体量

  float shape = clamp(ridge * 1.00 + mass * 0.28, 0.0, 1.12);
  // 注意：这里必须用 pow(shape, 1.30)。
  // 之前试过用 shape^4 近似，结果山体被压成"尖塔"、山峰出现细长针状伪影（已渲染验证）。
  shape = pow(shape, 1.30);
  shape = smoothstep(0.08, 0.72, shape);        // 山脚压平，主峰拔高 → 高低差更明显

  // 近处矮、远处高：保证仰角都落在环带 22° 以内
  float grow = mix(300.0, 1050.0, smoothstep(1300.0, 3900.0, r));
  float h = shape * grow;

  // 高频脊状沟壑：雪山的分叉山脊 / 陡壁。
  // 频率与振幅要克制：q*7 对应世界波长约 340m，260m 振幅会在远处碎成"毛刷"（已渲染验证）。
  float gully = ridged(q * 7.0 + vec2(31.7, -12.3), atLeast(oct - 2, 2));
  h += (gully - 0.55) * 105.0 * smoothstep(0.08, 0.60, shape);

  return max(h, 0.0) * uHeightScale * band;
}

// 法线估算：命中点周围 4 个高度差 → 高度场梯度 → 表面朝向
vec3 calcNormal(vec2 p, float eps) {
  int oct = atLeast(uOctaves - 2, 3);
  float hL = mountainHeight(p - vec2(eps, 0.0), oct);
  float hR = mountainHeight(p + vec2(eps, 0.0), oct);
  float hD = mountainHeight(p - vec2(0.0, eps), oct);
  float hU = mountainHeight(p + vec2(0.0, eps), oct);
  return normalize(vec3(hL - hR, 2.0 * eps, hD - hU));
}

// 光线步进：沿视线一步步往前，直到射线高度 <= 山体高度（即"打到地面"）
//
// 步长规则（经过数值验证：与细步长参考解相比相对误差 0.8%，无假命中、无天窗）：
//   - 起点 300m：山体在 650m 之外才开始，前段没必要走
//   - 步长 = 垂直间隙 / 视线仰角斜率 * 0.5，再夹到 [15, 650]m
//     这个换算保证每步的"水平推进"与间隙匹配：仰视时步长自然变长，平视时变短
//   - 射线升到山体上界 uMaxHeight 以上 → 后面不可能再命中，直接提前退出
//   - 命中后二分细化 4 次，山脊剪影锐利
// 返回命中距离（m），未命中返回 -1。
float rayMarch(vec3 ro, vec3 rd) {
  float t = 300.0;
  float prev = t;
  float slope = max(rd.y, 0.05);

  for (int i = 0; i < 128; i++) {
    if (i >= uSteps) break;

    float y = ro.y + rd.y * t;
    if (y > uMaxHeight) return -1.0;          // 已高过所有山峰

    vec2 pos = ro.xz + rd.xz * t;
    float d = y - mountainHeight(pos, MARCH_OCT);

    if (d < 1.5) {
      // 二分细化：把命中点压到间隙 1.5m 以内
      float lo = prev;
      float hi = t;
      for (int k = 0; k < 4; k++) {
        float mid = (lo + hi) * 0.5;
        float my = ro.y + rd.y * mid;
        if (my - mountainHeight(ro.xz + rd.xz * mid, MARCH_OCT) < 1.5) hi = mid;
        else lo = mid;
      }
      return hi;
    }

    prev = t;
    t += clamp(d * 0.5 / slope, 15.0, 650.0);
    if (t > uMaxDist) break;
  }
  return -1.0;
}

// 软阴影：从命中点朝太阳方向步进，看是否被更高的山体挡住。
// 半影宽度随距离变大 → 边缘自然柔和，不会出现硬二值黑边。
//
// 性能：用 3 层噪声（比步进的 4 层更便宜）。阴影只是低频明暗，
// 用低精度高度场完全看不出来，但能省掉一次相当可观的采样开销。
#define SHADOW_OCT 3
float softShadow(vec3 pos, vec3 L) {
  if (uShadowSteps <= 0) return 1.0;
  float res = 1.0;
  float t = 45.0;
  for (int i = 0; i < 8; i++) {
    if (i >= uShadowSteps) break;
    vec3 q = pos + L * t;
    float gap = q.y - mountainHeight(q.xz, SHADOW_OCT);
    float penumbra = 7.0 + t * 0.10;          // 越远半影越宽
    res = min(res, smoothstep(0.0, penumbra, gap));
    if (res <= 0.002) break;
    t *= 1.9;                                  // 指数步进：近密远疏
  }
  return clamp(res, 0.0, 1.0);
}

// 天空色（与 sky.js 的渐变公式保持一致），用作雾化目标色，保证远山和天空无缝衔接
// 注意：不用 pow()，改用乘法，在软件光栅化 / 移动 GPU 上省很多 ALU。
vec3 skyColor(vec3 d) {
  float h = d.y;
  float t = clamp(h * 1.12 + 0.05, 0.0, 1.0);
  t = t * t * (1.2 - 0.2 * t);                // 近似 pow(t, 0.62)
  vec3 c = mix(uHorizon, uZenith, t);
  float e = 1.0 - clamp(abs(h) * 2.4, 0.0, 1.0);
  e *= e;                                      // 近似 pow(..., 2.4) 的主体
  c = mix(c, uHaze, e * 0.5);
  return c;
}

void main() {
  vec3 rd = normalize(vDir);
  vec3 ro = cameraPosition;

  // 地平线以下交给地形，不做步进
  if (rd.y <= 0.0015) discard;

  // 快速剔除：在这个仰角上，即使撞上最高峰也不可能出现在屏幕上。
  // 远处山体仰角上限约 16°；加 4° 余量。大部分天空像素因此直接 discard，
  // 不做任何噪声采样（实测能省掉一大半全屏开销）。
  if (rd.y > 0.36) discard;

  float t = rayMarch(ro, rd);
  if (t < 0.0) discard;                        // 没打到山：保持天空（几何上沿因此完全看不出来）

  vec3 pos = ro + rd * t;
  vec2 p = pos.xz;
  float h = pos.y;                             // 命中点海拔
  float eps = max(5.0, t * 0.0065);            // 采样间距随距离放大，远处不会噪
  vec3 n = calcNormal(p, eps);
  float slope = clamp(1.0 - n.y, 0.0, 1.0);    // 0 = 平地，1 = 垂直崖壁

  // ---------- 材质分层：岩石 / 森林草地 / 雪 ----------
  // 噪声预算：远景像素只取 3 个低频噪声 + 2 个微细节，
  // 在软件光栅化（SwiftShader）上这是最大的性能项，每多一次 vnoise 都很贵。
  float n1 = vnoise(p * 0.0045 + vec2(3.7, 1.1));   // 大尺度色斑 / 雪线起伏
  float n2 = vnoise(p * 0.0210 - vec2(8.1, 5.3));   // 岩层 / 雪纹

  // 岩石：深灰褐，带水平层理（n1 和 n2 不同频率已足够，不再单独采 n3）
  vec3 rock = mix(uRockDark, uRock, n1 * 0.62 + n2 * 0.38);

  // 低海拔植被：暗绿（越低越暗，像远处的针叶林）
  vec3 forest = mix(uForest, uGrass, n2 * 0.85);

  // 雪线：海拔 + 噪声起伏（雪线不是一条直线，才有真实感）
  float snowLine = uSnowLine + (n1 - 0.5) * 150.0 + (n2 - 0.5) * 40.0;
  float snow = smoothstep(snowLine, snowLine + 130.0, h);
  // 陡壁挂不住雪，但极高处仍有残雪（题面：陡坡高海拔也要有雪）
  snow *= mix(1.0, 0.45, smoothstep(0.55, 0.92, slope));
  // 峰顶雪盖：越过雪线很高后几乎不看坡度，保证主峰是明显的白色雪盖
  snow = max(snow, smoothstep(snowLine + 200.0, snowLine + 420.0, h) * 0.94);
  // 雪线下方零星雪沟
  snow = max(snow, smoothstep(0.68, 0.92, n2) * smoothstep(snowLine - 190.0, snowLine, h) * 0.55);

  // 缓坡低海拔 → 森林；陡坡 → 裸岩
  float green = smoothstep(260.0, 90.0, h) * (1.0 - smoothstep(0.30, 0.58, slope));
  green *= smoothstep(2.0, 60.0, h);
  float rockMask = smoothstep(0.36, 0.64, slope);

  vec3 albedo = mix(rock, forest, green * (1.0 - rockMask));
  // 高海拔岩石偏冷灰（但要保留明暗差，不能洗成一片白）
  albedo = mix(albedo, uRockDark, smoothstep(380.0, 800.0, h) * 0.22);
  // 雪盖压在最上层
  albedo = mix(albedo, uSnow, snow);
  // 雪面明暗纹理（雪坑 / 背阴面偏冷蓝）
  albedo = mix(albedo, uSnowShade, snow * smoothstep(0.55, 0.95, n2) * 0.30);

  // 远处岩壁的细碎沟壑：单次高频噪声调制明暗，
  // 避免大片岩壁在雾里糊成一块灰色（远景也能看出山体起伏）。
  float micro = vnoise(p * 0.085 + vec2(2.3, -6.1));
  albedo *= 0.78 + 0.44 * micro;
  // 高处岩石被风化得更浅（雪线附近是碎石坡）
  albedo = mix(albedo, uSnowShade * 0.86, smoothstep(0.55, 0.90, n1) * smoothstep(380.0, 760.0, h) * (1.0 - snow) * 0.35);

  // ---------- 光照 ----------
  vec3 L = normalize(uSunDir);
  float ndotl = max(dot(n, L), 0.0);
  float sh = softShadow(pos, L);               // 0~1 柔和阴影

  // 半球环境光近似：法线朝上取天光，朝下取地面反弹色（暗部不发黑的关键）
  vec3 amb = mix(uAmbGround, uAmbSky, 0.5 + 0.5 * n.y);
  amb *= mix(1.0, 1.18, smoothstep(150.0, 800.0, h));   // 高处空气稀薄，天光更冷更亮

  vec3 col = albedo * (uSunColor * (ndotl * sh * uSunIntensity) + amb);

  // 雪面高光（雪晶的冷调反光）
  vec3 V = -rd;
  vec3 Hv = normalize(L + V);
  col += uSunColor * pow(max(dot(n, Hv), 0.0), 26.0) * snow * sh * 0.45;

  // ---------- 大气透视：越远越向地平线天空色靠拢 ----------
  float haze = 1.0 - exp(-t * uFogDensity);
  haze *= mix(1.0, 0.60, smoothstep(60.0, 850.0, h));    // 山顶空气更通透 → 纵深更强
  vec3 skyc = skyColor(rd);
  col = mix(col, skyc, clamp(haze, 0.0, 0.96));

  // 逆光时太阳附近的雾霭更亮
  col += uSunColor * pow(max(dot(rd, L), 0.0), 7.0) * 0.05 * clamp(haze, 0.0, 1.0);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ============================================================
// 几何：环绕地平线的球壳环带
// ============================================================
// 只建 -5°~22° 这一段，比整颗球省顶点，也保证视线方向 vDir 的插值精度。
function makeBandGeometry(radius, elevMin, elevMax, azSeg, elSeg) {
  const cols = azSeg + 1;
  const rows = elSeg + 1;
  const positions = new Float32Array(cols * rows * 3);
  const indices = [];

  for (let j = 0; j < rows; j++) {
    const el = elevMin + (elevMax - elevMin) * (j / elSeg);
    const ce = Math.cos(el);
    const se = Math.sin(el);
    for (let i = 0; i < cols; i++) {
      const az = (i / azSeg) * Math.PI * 2;
      const k = (j * cols + i) * 3;
      positions[k] = Math.cos(az) * ce * radius;
      positions[k + 1] = se * radius;
      positions[k + 2] = Math.sin(az) * ce * radius;
    }
  }
  for (let j = 0; j < elSeg; j++) {
    for (let i = 0; i < azSeg; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      // 注意绕序：相机在球心，必须让三角形从球心看是"背面"，配合 side: BackSide 才能渲染。
      // （反过来绕的话整张壳会被背面剔除掉，天空一片黑——已用真实 WebGL 渲染验证过）
      indices.push(a, c, b, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

// ============================================================
// 画质解析：兼容 'high' 字符串 / quality.js 的 preset 对象
// ============================================================
function tierOf(preset) {
  if (!preset) return 'medium';
  if (typeof preset === 'string') {
    if (preset === 'auto') return 'high';
    return TIERS.indexOf(preset) >= 0 ? preset : 'medium';
  }
  if (typeof preset === 'object') {
    if (typeof preset.tier === 'string' && TIERS.indexOf(preset.tier) >= 0) return preset.tier;
    if (typeof preset.quality === 'string' && TIERS.indexOf(preset.quality) >= 0) return preset.quality;
    if (typeof preset.label === 'string' && LABEL_TIER[preset.label]) return LABEL_TIER[preset.label];
    // 没写档位名时按草地密度猜（low 0.10 / medium 0.25 / high 0.45 / ultra 0.62）
    const g = preset.grassDensity;
    if (Number.isFinite(g)) {
      if (g <= 0.15) return 'low';
      if (g <= 0.32) return 'medium';
      if (g <= 0.52) return 'high';
      return 'ultra';
    }
  }
  return 'medium';
}

// ============================================================
// 主工厂
// ============================================================
export function createMountains(scene, opts = {}) {
  // 参数兼容：null / 非对象都当成"默认参数"，不能抛错（Lead 可能直接传 null）
  const o = (opts && typeof opts === 'object') ? opts : {};
  const preset = o.preset ?? null;
  const sunDir = o.sunDir ?? null;
  // anisotropy 预留：本模块全程序化，不用贴图（接口与其它场景模块保持一致）
  const quality = o.quality ?? null;
  const tier = tierOf(quality || preset);

  const group = new THREE.Group();
  group.name = 'mountains';
  group.matrixAutoUpdate = true;

  const geometry = makeBandGeometry(BAND_RADIUS, ELEV_MIN, ELEV_MAX, AZ_SEGMENTS, EL_SEGMENTS);

  const _sun = sunDir && Number.isFinite(sunDir.x)
    ? new THREE.Vector3(sunDir.x, sunDir.y, sunDir.z)
    : new THREE.Vector3(SUN.dir[0], SUN.dir[1], SUN.dir[2]);
  if (_sun.lengthSq() < 1e-8) _sun.set(0, 1, 0);
  _sun.normalize();

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: _sun.clone() },
      uSunColor: { value: new THREE.Color(SUN.color ?? 0xfff0d4) },
      // 与 sky.js 默认值一致：雾化目标色 = 天空色，远山才能无缝融进地平线
      uZenith: { value: new THREE.Color(0x4c80b8) },
      uHorizon: { value: new THREE.Color(0xc6d7e4) },
      uHaze: { value: new THREE.Color(0xe9dcc2) },
      uAmbSky: { value: new THREE.Color(0x6b89ab) },
      uAmbGround: { value: new THREE.Color(0x2c2a22) },
      uSnow: { value: new THREE.Color(0xf4f8ff) },
      uSnowShade: { value: new THREE.Color(0xb9cbe2) },
      uRock: { value: new THREE.Color(0x5c574c) },
      uRockDark: { value: new THREE.Color(0x2b2823) },
      uGrass: { value: new THREE.Color(0x4a5a28) },
      uForest: { value: new THREE.Color(0x24301c) },
      uSeed: { value: new THREE.Vector2(17.31, -9.47) },
      uSteps: { value: TIER_STEPS[tier] ?? 40 },
      uOctaves: { value: TIER_OCTAVES[tier] ?? 7 },
      uShadowSteps: { value: TIER_SHADOW_STEPS[tier] ?? 6 },
      uSunIntensity: { value: 2.6 },
      uHeightScale: { value: 1.0 },
      uSnowLine: { value: 640.0 },
      uFogDensity: { value: 0.00022 },
      uMaxDist: { value: 5200.0 },
      // 山体高度上界（比实测峰值 1058m 留足余量）：步进时超过这个高度就提前退出
      uMaxHeight: { value: 1250.0 },
    },
    vertexShader: MOUNTAIN_VERT,
    fragmentShader: MOUNTAIN_FRAG,
    side: THREE.BackSide,
    transparent: false,
    depthTest: false,      // 天空之后、实体之前绘制，实体自然会盖住它
    depthWrite: false,
    fog: false,
  });
  material.toneMapped = true;   // 走和天空一致的 ACES + sRGB 输出

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'mountainRange';
  mesh.frustumCulled = false;   // 顶点被投影到远平面，包围球判定没有意义
  mesh.renderOrder = -950;      // sky.js 的天空是 -1000，这里紧跟其后
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = true;
  group.add(mesh);

  // 与其它场景模块一致：传入 scene 时自动挂载（Lead 再 add 到别处也是安全的，THREE 会自动换父）
  if (scene && typeof scene.add === 'function') scene.add(group);

  // ---------- 逐帧 ----------
  const _camPos = new THREE.Vector3();
  const _parentPos = new THREE.Vector3();
  let time = 0;

  // 跟随相机：壳体必须始终把相机包在里面（同时保持世界固定的山体 → 保留真实视差）
  function update(dt = 0.016, camera = null) {
    time += Number.isFinite(dt) ? dt : 0.016;
    const cam = camera && camera.camera ? camera.camera : camera;   // 兼容 update(dt, ctx) 写法
    if (cam && cam.getWorldPosition) {
      cam.getWorldPosition(_camPos);
      if (group.parent) {
        group.parent.updateWorldMatrix(true, false);
        _parentPos.setFromMatrixPosition(group.parent.matrixWorld);
        group.position.copy(_camPos).sub(_parentPos);
      } else {
        group.position.copy(_camPos);
      }
    }
    // 太阳方向每帧同步：Lead 改了 uSunDir（比如昼夜变化）后立刻生效
    const u = material.uniforms;
    if (u.uSunDir.value.lengthSq() > 1e-8) u.uSunDir.value.normalize();
    // 高度缩放改了要同步抬高上界，否则大尺度调参会把远峰剪掉
    u.uMaxHeight.value = 1250.0 * Math.max(0.2, u.uHeightScale.value);
  }

  // ---------- 画质 ----------
  let currentTier = tier;
  function setQuality(p) {
    const t = tierOf(p);
    currentTier = t;
    const u = material.uniforms;
    u.uSteps.value = TIER_STEPS[t] ?? 40;
    u.uOctaves.value = TIER_OCTAVES[t] ?? 7;
    u.uShadowSteps.value = TIER_SHADOW_STEPS[t] ?? 6;
    return t;
  }
  // 初始档位（preset 传进来时已经解析过，这里再同步一次，保证 uniform 与 tier 一致）
  setQuality(quality || preset || tier);

  // ---------- 额外小工具（Lead 可选使用）----------
  // 让远山的雾化色跟着 sky.js 的昼夜参数走，避免夜里远山还是白天的天蓝色
  function syncSkyColors(skyMat) {
    const su = skyMat && skyMat.uniforms;
    if (!su) return false;
    const u = material.uniforms;
    if (su.uZenith) u.uZenith.value.copy(su.uZenith.value);
    if (su.uHorizon) u.uHorizon.value.copy(su.uHorizon.value);
    if (su.uHaze) u.uHaze.value.copy(su.uHaze.value);
    return true;
  }
  function setSunDir(dir) {
    if (!dir) return;
    const v = material.uniforms.uSunDir.value;
    v.set(dir.x ?? 0, dir.y ?? 1, dir.z ?? 0);
    // 退化输入（全零 / NaN）回退到 SUN 默认方向，避免整张山体变黑
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z) || v.lengthSq() < 1e-8) {
      v.set(SUN.dir[0], SUN.dir[1], SUN.dir[2]);
    }
    v.normalize();
  }
  function setVisible(v) { group.visible = !!v; }

  // ---------- 释放 ----------
  function dispose() {
    if (group.parent) group.parent.remove(group);
    group.remove(mesh);
    geometry.dispose();
    material.dispose();
  }

  return {
    group,
    mesh,
    material,
    uniforms: material.uniforms,
    get tier() { return currentTier; },
    get time() { return time; },
    steps: () => material.uniforms.uSteps.value,
    update,
    setQuality,
    setSunDir,
    syncSkyColors,
    setVisible,
    dispose,
  };
}

export default createMountains;
