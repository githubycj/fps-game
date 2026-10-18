// ===== 兼容层：旧代码可以继续从 shared/map.js 导入世界与武器数据 =====
// 实际实现在 shared/world.js（地形/物理/射线/布局）与 shared/weapons.js（武器数值）。
export * from './world.js';
export * from './weapons.js';
