// ===== 武器系统数据层（前后端共用）=====
// 设计取向：写实枪械手感 —— 每把枪有明确定位与代价（射速↔伤害↔后坐力↔散布↔移速），
// 开镜（ADS/狙击镜）是真实有效的精度/视野手段，腰射与开镜差异显著。
//
// 字段说明：
//   fireInterval  两发最小间隔（秒）
//   fireMode      'auto' 全自动 / 'semi' 半自动（需松开扳机再按）
//   pellets       单发弹丸数（霰弹枪 > 1）
//   pelletSpread  弹丸锥形扩散（弧度）
//   spread*       散布（弧度，半角），由 shared 的 currentSpread 汇总
//   recoil        视角后坐力（客户端使用）：pitch 垂直抬升、yaw 水平随机、ramp 连发递增、
//                 maxRamp 递增上限、recovery 恢复速率、kick 视图模型后坐位移、shake 镜头抖动
//   sightType     'iron' 机械瞄具 / 'reddot' 红点镜 / 'scope' 光学狙击镜
//   adsFov        开镜后的相机 FOV（狙击枪即真实放大倍率对应的 FOV）
//   scopeMagnification  光学倍率（仅显示/说明用，真实放大由 adsFov 决定）
//   audio         供程序化音效合成的参数提示

const BASE = {
  slot: 1,
  name: '武器',
  category: 'rifle',
  damage: 24,
  headshotMult: 2.4,
  legMult: 0.8,
  fireMode: 'auto',
  fireInterval: 0.1,
  magSize: 30,
  reserveStart: 120,
  reserveMax: 180,
  reloadTime: 2.1,
  reloadEmptyTime: 2.4,
  swapTime: 0.42,
  adsTime: 0.2,
  pellets: 1,
  pelletSpread: 0,
  spread: 0.015,
  spreadMoving: 0.03,
  spreadSprint: 0.09,
  spreadPerShot: 0.005,
  spreadMax: 0.1,
  spreadRecover: 4.5,
  spreadCrouchMult: 0.72,
  adsSpreadMult: 0.35,
  moveSpeedMult: 1,
  sightType: 'iron',
  adsFov: 50,
  scopeMagnification: 1,
  reticle: 'cross',
  range: 100,
  falloffStart: 35,
  falloffEnd: 100,
  falloffMin: 0.62,
  // 后坐力默认值
  recoil: { pitch: 0.018, yaw: 0.006, ramp: 0.06, maxRamp: 8, recovery: 9, kick: 0.05, shake: 0.012 },
  // 音效合成参数提示
  audio: { base: 150, crack: 3000, tail: 0.5, gain: 0.9 },
};

function def(cfg) {
  return {
    ...BASE,
    ...cfg,
    recoil: { ...BASE.recoil, ...(cfg.recoil || {}) },
    audio: { ...BASE.audio, ...(cfg.audio || {}) },
  };
}

export const WEAPONS = {
  // 9mm 手枪：半自动、稳定、无限备弹，永远有兜底输出
  pistol: def({
    slot: 1, name: '手枪', category: 'pistol', fireMode: 'semi',
    damage: 26, headshotMult: 2.4, legMult: 0.8, fireInterval: 0.155,
    magSize: 15, reserveStart: Infinity, reserveMax: Infinity,
    reloadTime: 1.5, reloadEmptyTime: 1.7, swapTime: 0.32, adsTime: 0.16,
    spread: 0.009, spreadMoving: 0.026, spreadSprint: 0.085, spreadPerShot: 0.008, spreadMax: 0.065, spreadRecover: 5.0,
    adsSpreadMult: 0.32, moveSpeedMult: 1.02,
    sightType: 'iron', adsFov: 55, reticle: 'cross',
    range: 60, falloffStart: 22, falloffEnd: 60, falloffMin: 0.62,
    recoil: { pitch: 0.021, yaw: 0.006, ramp: 0.05, maxRamp: 6, recovery: 9.5, kick: 0.05, shake: 0.012 },
    audio: { base: 190, crack: 3600, tail: 0.42, gain: 0.85 },
  }),

  // 冲锋枪：高射速低伤害，近身泼水，红点镜快速索敌
  smg: def({
    slot: 2, name: '冲锋枪', category: 'smg', fireMode: 'auto',
    damage: 16, headshotMult: 2.2, legMult: 0.75, fireInterval: 0.078,
    magSize: 30, reserveStart: 150, reserveMax: 180,
    reloadTime: 1.9, reloadEmptyTime: 2.15, swapTime: 0.36, adsTime: 0.18,
    spread: 0.018, spreadMoving: 0.024, spreadSprint: 0.09, spreadPerShot: 0.005, spreadMax: 0.11, spreadRecover: 4.2,
    adsSpreadMult: 0.45, moveSpeedMult: 1.06,
    sightType: 'reddot', adsFov: 55, reticle: 'dot',
    range: 55, falloffStart: 14, falloffEnd: 55, falloffMin: 0.5,
    recoil: { pitch: 0.011, yaw: 0.008, ramp: 0.08, maxRamp: 10, recovery: 11, kick: 0.035, shake: 0.009 },
    audio: { base: 170, crack: 4200, tail: 0.34, gain: 0.8 },
  }),

  // 突击步枪：中坚力量，伤害与射速均衡，后坐力明显需要压枪
  ak47: def({
    slot: 3, name: '突击步枪', category: 'rifle', fireMode: 'auto',
    damage: 24, headshotMult: 2.45, legMult: 0.8, fireInterval: 0.1,
    magSize: 30, reserveStart: 120, reserveMax: 150,
    reloadTime: 2.15, reloadEmptyTime: 2.45, swapTime: 0.42, adsTime: 0.2,
    spread: 0.015, spreadMoving: 0.032, spreadSprint: 0.1, spreadPerShot: 0.006, spreadMax: 0.105, spreadRecover: 4.2,
    adsSpreadMult: 0.3, moveSpeedMult: 0.96,
    sightType: 'iron', adsFov: 48, reticle: 'cross',
    range: 100, falloffStart: 38, falloffEnd: 100, falloffMin: 0.62,
    recoil: { pitch: 0.021, yaw: 0.011, ramp: 0.11, maxRamp: 12, recovery: 7.5, kick: 0.06, shake: 0.016 },
    audio: { base: 120, crack: 3000, tail: 0.55, gain: 0.95 },
  }),

  // 泵动霰弹枪：8 弹丸，贴脸毁灭，远距离急剧衰减
  shotgun: def({
    slot: 4, name: '霰弹枪', category: 'shotgun', fireMode: 'semi',
    damage: 11, headshotMult: 1.7, legMult: 0.9, fireInterval: 0.85,
    magSize: 6, reserveStart: 30, reserveMax: 42,
    reloadTime: 2.4, reloadEmptyTime: 2.75, swapTime: 0.46, adsTime: 0.22,
    pellets: 8, pelletSpread: 0.065,
    spread: 0.03, spreadMoving: 0.015, spreadSprint: 0.06, spreadPerShot: 0.01, spreadMax: 0.09, spreadRecover: 3.6,
    adsSpreadMult: 0.65, moveSpeedMult: 0.94,
    sightType: 'iron', adsFov: 60, reticle: 'dot',
    range: 32, falloffStart: 7, falloffEnd: 28, falloffMin: 0.25,
    recoil: { pitch: 0.05, yaw: 0.018, ramp: 0.02, maxRamp: 3, recovery: 6, kick: 0.14, shake: 0.032 },
    audio: { base: 85, crack: 2200, tail: 0.7, gain: 1.0 },
  }),

  // 栓动狙击枪：6 倍镜，开镜一击重伤/爆头必杀，腰射极不准
  sniper: def({
    slot: 5, name: '狙击步枪', category: 'sniper', fireMode: 'semi',
    damage: 95, headshotMult: 2.4, legMult: 0.7, fireInterval: 1.3,
    magSize: 5, reserveStart: 25, reserveMax: 35,
    reloadTime: 2.9, reloadEmptyTime: 3.3, swapTime: 0.55, adsTime: 0.32,
    spread: 0.07, spreadMoving: 0.05, spreadSprint: 0.12, spreadPerShot: 0.02, spreadMax: 0.16, spreadRecover: 3.2,
    adsSpreadMult: 0.05, moveSpeedMult: 0.88,
    sightType: 'scope', adsFov: 18, scopeMagnification: 3, reticle: 'cross-gap',
    // 射程覆盖整张地图对角线（≈198m），保证远距离（含地图两端）子弹不会被"忽略"
    range: 260, falloffStart: 100, falloffEnd: 200, falloffMin: 0.85,
    recoil: { pitch: 0.06, yaw: 0.012, ramp: 0.05, maxRamp: 4, recovery: 5, kick: 0.16, shake: 0.020 },
    audio: { base: 95, crack: 2600, tail: 1.1, gain: 1.1 },
  }),
};

// 武器栏顺序（数字键 1~5 / 滚轮切换）
export const WEAPON_ORDER = ['pistol', 'smg', 'ak47', 'shotgun', 'sniper'];

// 开局自带（其余靠地图拾取）
export const STARTING_WEAPONS = ['pistol', 'smg'];

// 可在地图上刷新的武器箱
export const PICKUP_WEAPONS = ['ak47', 'shotgun', 'sniper'];

// AI 可用武器池（按定位分配）
export const AI_WEAPONS = ['smg', 'ak47', 'shotgun', 'pistol'];

export function weaponOf(id) {
  return WEAPONS[id] || WEAPONS.pistol;
}

export function isWeaponId(id) {
  return Object.prototype.hasOwnProperty.call(WEAPONS, id);
}

// 是否光学狙击镜（开镜走真实放大 + 遮罩）
export function isScopeWeapon(w) {
  return w.sightType === 'scope';
}

// 距离伤害衰减：近距离满伤，远距离衰减到 falloffMin
export function falloffMultiplier(w, dist) {
  if (!(dist > w.falloffStart)) return 1;
  if (dist >= w.falloffEnd) return w.falloffMin;
  const t = (dist - w.falloffStart) / (w.falloffEnd - w.falloffStart);
  return 1 + (w.falloffMin - 1) * t;
}

// 当前散布（弧度，半角）：腰射 + 移动 + 冲刺 + 连发累积；蹲下收紧、开镜按倍率收紧
export function currentSpread(w, { moving = false, ads = false, shots = 0, sprinting = false, crouched = false } = {}) {
  let s = w.spread
    + (moving ? w.spreadMoving : 0)
    + (sprinting ? (w.spreadSprint || 0.09) : 0)
    + Math.min(shots, 30) * w.spreadPerShot;
  if (crouched) s *= w.spreadCrouchMult ?? 1;
  if (ads) s *= w.adsSpreadMult;
  return Math.min(s, w.spreadMax);
}

// 单发理论伤害（含部位倍率与距离衰减，不含护盾）
export function shotDamage(w, { part = 'body', dist = 0 } = {}) {
  let base = w.damage;
  if (part === 'head') base *= w.headshotMult;
  else if (part === 'legs') base *= (w.legMult ?? 0.8);
  return Math.max(1, Math.round(base * falloffMultiplier(w, dist)));
}

// 显示用射速（RPM）
export function rpmOf(w) {
  return Math.round(60 / Math.max(0.001, w.fireInterval));
}
