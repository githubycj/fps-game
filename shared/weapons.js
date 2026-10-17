// ===== 武器系统数据层（前后端共用，保证手感与判定一致）=====
// 设计取向：每把枪有明确的定位与代价（射速 ↔ 伤害 ↔ 后坐力 ↔ 散布 ↔ 移速）。

// 通用默认值：未配置的字段走这里
const BASE = {
  slot: 1,
  name: '武器',
  damage: 20,
  headshotMult: 2.2,
  fireMode: 'auto',        // auto=全自动 / semi=半自动（需松开再按）
  fireInterval: 0.15,      // 两发之间的最小间隔（秒）
  magSize: 12,
  reserveStart: Infinity,  // 初始备弹（Infinity 表示无限）
  reserveMax: Infinity,
  reloadTime: 1.2,         // 换弹耗时（秒）
  swapTime: 0.35,          // 切枪耗时（秒）
  pellets: 1,              // 单发射出的弹丸数（霰弹枪 >1）
  pelletSpread: 0,         // 弹丸之间的固定扩散（弧度）
  spread: 0.012,           // 腰射基础散布（弧度，半角）
  spreadMoving: 0.03,      // 移动时附加散布
  spreadPerShot: 0.004,    // 连发时每发叠加的散布
  spreadMax: 0.09,         // 散布上限
  spreadRecover: 4.5,      // 散布恢复速率（每秒衰减系数）
  adsSpreadMult: 0.35,     // 瞄准（ADS）散布倍率
  adsFov: 50,              // 瞄准时的 FOV
  moveSpeedMult: 1.0,      // 持枪移速倍率
  range: 70,               // 最大射程
  falloffStart: 30,        // 开始衰减的距离
  falloffEnd: 70,          // 衰减到最低的距离
  falloffMin: 0.65,        // 最远距离的伤害倍率
  // 后坐力：pitch 垂直抬枪（弧度/发）、yaw 水平抖动、ramp 连发递增、recovery 恢复速率
  recoil: { pitch: 0.018, yaw: 0.006, ramp: 0.05, maxRamp: 8, recovery: 9, kick: 0.05, shake: 0.012 },
  tracer: 0x9fe0ff,        // 曳光弹颜色
  muzzle: 0.9,             // 枪口在视图模型 local 空间的 z 偏移
};

function def(cfg) {
  return { ...BASE, ...cfg, recoil: { ...BASE.recoil, ...(cfg.recoil || {}) } };
}

export const WEAPONS = {
  // 手枪：半自动、稳定、无限备弹，永远有兜底输出
  pistol: def({
    slot: 1, name: '手枪', fireMode: 'semi',
    damage: 22, headshotMult: 2.2, fireInterval: 0.15,
    magSize: 12, reserveStart: Infinity,
    reloadTime: 1.15, swapTime: 0.3,
    spread: 0.010, spreadMoving: 0.028, spreadPerShot: 0.006, spreadMax: 0.06,
    adsSpreadMult: 0.3, adsFov: 50,
    range: 70, falloffStart: 28, falloffEnd: 70, falloffMin: 0.7,
    recoil: { pitch: 0.020, yaw: 0.007, ramp: 0.04, maxRamp: 6, recovery: 9.5, kick: 0.055, shake: 0.014 },
    tracer: 0x9fe0ff,
  }),

  // 冲锋枪：高射速低伤害，近身泼水，移动灵活
  smg: def({
    slot: 2, name: '冲锋枪', fireMode: 'auto',
    damage: 15, headshotMult: 2.0, fireInterval: 0.075,
    magSize: 30, reserveStart: 150, reserveMax: 180,
    reloadTime: 1.7, swapTime: 0.35,
    spread: 0.020, spreadMoving: 0.026, spreadPerShot: 0.005, spreadMax: 0.11, spreadRecover: 4,
    adsSpreadMult: 0.45, adsFov: 55,
    moveSpeedMult: 1.06,
    range: 55, falloffStart: 18, falloffEnd: 55, falloffMin: 0.5,
    recoil: { pitch: 0.011, yaw: 0.008, ramp: 0.07, maxRamp: 10, recovery: 11, kick: 0.035, shake: 0.009 },
    tracer: 0xbfe8ff,
  }),

  // 突击步枪：中坚力量，伤害与射速均衡，后坐力明显需要压枪
  ak47: def({
    slot: 3, name: '突击步枪', fireMode: 'auto',
    damage: 20, headshotMult: 2.25, fireInterval: 0.095,
    magSize: 30, reserveStart: 120, reserveMax: 150,
    reloadTime: 2.0, swapTime: 0.4,
    spread: 0.016, spreadMoving: 0.034, spreadPerShot: 0.006, spreadMax: 0.1, spreadRecover: 4.2,
    adsSpreadMult: 0.35, adsFov: 50,
    moveSpeedMult: 0.96,
    range: 85, falloffStart: 35, falloffEnd: 85, falloffMin: 0.62,
    recoil: { pitch: 0.019, yaw: 0.010, ramp: 0.10, maxRamp: 12, recovery: 7.5, kick: 0.06, shake: 0.016 },
    tracer: 0xffc48a,
  }),

  // 霰弹枪：一发 9 弹丸，贴脸毁灭性，远距离几乎无效
  shotgun: def({
    slot: 4, name: '霰弹枪', fireMode: 'semi',
    damage: 12, headshotMult: 1.8, fireInterval: 0.78,
    magSize: 6, reserveStart: 30, reserveMax: 42,
    reloadTime: 2.3, swapTime: 0.45,
    pellets: 9, pelletSpread: 0.075,
    spread: 0.026, spreadMoving: 0.020, spreadPerShot: 0.01, spreadMax: 0.09,
    adsSpreadMult: 0.6, adsFov: 58,
    moveSpeedMult: 0.94,
    range: 30, falloffStart: 8, falloffEnd: 28, falloffMin: 0.25,
    recoil: { pitch: 0.045, yaw: 0.016, ramp: 0.02, maxRamp: 3, recovery: 6, kick: 0.13, shake: 0.032 },
    tracer: 0xffd9a0,
  }),

  // 狙击枪：单发高伤，爆头即秒，腰射极不准，开镜才致命
  sniper: def({
    slot: 5, name: '狙击枪', fireMode: 'semi',
    damage: 62, headshotMult: 2.0, fireInterval: 1.55,
    magSize: 5, reserveStart: 25, reserveMax: 35,
    reloadTime: 2.7, swapTime: 0.55,
    spread: 0.075, spreadMoving: 0.05, spreadPerShot: 0.02, spreadMax: 0.16, spreadRecover: 3.2,
    adsSpreadMult: 0.06, adsFov: 22,
    moveSpeedMult: 0.88,
    range: 140, falloffStart: 90, falloffEnd: 140, falloffMin: 0.85,
    recoil: { pitch: 0.055, yaw: 0.012, ramp: 0.05, maxRamp: 4, recovery: 5, kick: 0.16, shake: 0.038 },
    tracer: 0xd8b0ff,
  }),
};

// 武器栏顺序（数字键 1~5 / 滚轮切换）
export const WEAPON_ORDER = ['pistol', 'smg', 'ak47', 'shotgun', 'sniper'];

// 开局自带（其余靠地图拾取）
export const STARTING_WEAPONS = ['pistol', 'smg'];

// 可在地图上刷新的武器道具
export const PICKUP_WEAPONS = ['ak47', 'shotgun', 'sniper'];

export function weaponOf(id) {
  return WEAPONS[id] || WEAPONS.pistol;
}

export function isWeaponId(id) {
  return Object.prototype.hasOwnProperty.call(WEAPONS, id);
}

// 距离伤害衰减：近距离满伤，远距离衰减到 falloffMin
export function falloffMultiplier(w, dist) {
  if (!(dist > w.falloffStart)) return 1;
  if (dist >= w.falloffEnd) return w.falloffMin;
  const t = (dist - w.falloffStart) / (w.falloffEnd - w.falloffStart);
  return 1 + (w.falloffMin - 1) * t;
}

// 当前散布（弧度，半角）：腰射 + 移动 + 连发累积，ADS 收紧
export function currentSpread(w, { moving = false, ads = false, shots = 0 } = {}) {
  let s = w.spread + (moving ? w.spreadMoving : 0) + Math.min(shots, 30) * w.spreadPerShot;
  if (ads) s *= w.adsSpreadMult;
  return Math.min(s, w.spreadMax);
}

// 单发理论伤害（含部位倍率与距离衰减，不含护盾）
export function shotDamage(w, { part = 'body', dist = 0 } = {}) {
  const base = part === 'head' ? w.damage * w.headshotMult : w.damage;
  return Math.max(1, Math.round(base * falloffMultiplier(w, dist)));
}
