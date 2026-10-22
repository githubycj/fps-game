// ===== 兼容层：re-export 当前地图 + 武器数值 =====
// 历史原因保留这个名字；真正的地图实现由 shared/active.js 按 MAP 环境变量分发
// （shared/tidewater.js 潮汐湾 / shared/world.js 郊区战场）。
// 新代码请直接 import './active.js'，不要再走这里。
export * from './active.js';
export * from './weapons.js';
