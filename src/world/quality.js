// ===== 画质分档 =====
// 四个档位一次定义，所有场景模块从这里读参数；软件渲染（SwiftShader / llvmpipe）
// 自动落到 low。低档必须仍然可玩：关后期、关阴影、大幅降草/树细节。
export const QUALITY_ORDER = ['low', 'medium', 'high', 'ultra'];

export const QUALITY_PRESETS = {
  low: {
    label: '低',
    terrainSegments: 112,
    outerMilestones: 5,      // 外圈远景地形采样层数（越少越省）
    pixelDetail: 0.35,       // 地面法线等精细纹理缩放
    grassDensity: 0.10,      // 草叶密度系数（相对满档）
    weedDensity: 0.12,
    flowerDensity: 0,
    grassFade: [16, 30],     // 草的距离淡出（m）
    bushes: 0.55,
    treeShadows: false,
    shadows: false,
    shadowSize: 512,
    post: false,
    bloom: false,
    clouds: false,
    cableSegments: 10,       // 电缆 Tube 分段
    towerBraces: 1,          // 塔身斜撑层数（1=仅下部）
    boundaryFence: true,     // 边界铁丝网（视觉上必须有，否则会看到隐形墙）
    glass: false,            // 房屋玻璃
    props: 0.55,             // 装饰小物件比例
  },
  medium: {
    label: '中',
    terrainSegments: 144,
    outerMilestones: 6,
    pixelDetail: 0.6,
    grassDensity: 0.38,
    weedDensity: 0.4,
    flowerDensity: 0.35,
    grassFade: [24, 42],
    bushes: 0.8,
    treeShadows: false,
    shadows: true,
    shadowSize: 1024,
    post: true,
    bloom: false,
    clouds: true,
    cableSegments: 20,
    towerBraces: 2,
    boundaryFence: true,
    glass: true,
    props: 0.8,
  },
  high: {
    label: '高',
    terrainSegments: 176,
    outerMilestones: 7,
    pixelDetail: 0.85,
    grassDensity: 0.72,
    weedDensity: 0.72,
    flowerDensity: 0.7,
    grassFade: [34, 56],
    bushes: 1,
    treeShadows: true,
    shadows: true,
    shadowSize: 2048,
    post: true,
    bloom: true,
    clouds: true,
    cableSegments: 40,
    towerBraces: 3,
    boundaryFence: true,
    glass: true,
    props: 1,
  },
  ultra: {
    label: '极高',
    terrainSegments: 200,
    outerMilestones: 8,
    pixelDetail: 1,
    grassDensity: 1,
    weedDensity: 1,
    flowerDensity: 1,
    grassFade: [40, 62],
    bushes: 1,
    treeShadows: true,
    shadows: true,
    shadowSize: 2048,
    post: true,
    bloom: true,
    clouds: true,
    cableSegments: 48,
    towerBraces: 4,
    boundaryFence: true,
    glass: true,
    props: 1,
  },
};

// 软件渲染检测：WebGL_debug_renderer_info 上的渲染器名
export function isSoftwareRenderer(renderer) {
  if (!renderer) return false;
  try {
    const gl = renderer.getContext ? renderer.getContext() : null;
    if (!gl) return false;
    const ext = gl.getExtension ? gl.getExtension('WEBGL_debug_renderer_info') : null;
    const name = ext && gl.getParameter ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '') : '';
    return /swiftshader|software|llvmpipe|basic render|mesa offscreen/i.test(name);
  } catch (e) {
    return false;
  }
}

export function isQuality(q) {
  return typeof q === 'string' && Object.prototype.hasOwnProperty.call(QUALITY_PRESETS, q);
}

// 解析实际档位：opts.quality 显式指定优先；否则软渲染 → low，其余 high
export function resolveQuality(opts = {}, renderer = null) {
  const soft = opts.soft != null ? !!opts.soft : isSoftwareRenderer(renderer);
  if (isQuality(opts.quality)) return opts.quality;
  return soft ? 'low' : 'high';
}

export function presetOf(q) {
  return QUALITY_PRESETS[isQuality(q) ? q : 'high'];
}
