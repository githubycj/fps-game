# 郊区战场 · SUBURBAN FRONT — 重制规格书（唯一契约）

> 本文件是所有模块的唯一接口契约。任何实现都必须先读完本文件。
> 目标：把《霓虹战场 NEON ARENA》从"低多边形赛博竞技场"重制为**写实郊区战场**：
> 草地起伏地形、小房子、大型输电塔、杂草灌木、真实光照、精密枪械、真实开镜、
> 真实枪声、重构命中反馈、无曳光弹、真人级人物骨骼协调、真实 AI 寻路与视野，
> 并加入据点争夺（Domination）+ 战术机动 + 连杀 UAV 的玩法创新。

---

## 0. 硬性约束

1. **技术栈不变**：Vite + Three.js 0.170 + Node ws。**不得新增 npm 依赖**，不得改 package.json。
2. **零外部资源**：全部程序化建模、程序化贴图、程序化音频（Canvas / Geometry / WebAudio）。
3. **无曳光弹**：代码里不允许出现 tracer 视觉效果（曳光弹/光柱弹道）。弹道反馈只用枪口焰、弹壳、烟尘、命中粒子、弹着点。
4. **前后端共享数值**：`shared/` 下的地形、物理、武器数值必须同时被浏览器与 Node 使用，保证预测/权威一致。
5. **确定性**：地形高度、树木/石头/房屋布局必须是**纯函数**（固定种子哈希），客户端与服务器逐位一致，禁止 `Math.random()` 参与地形生成（运行时特效可随机）。
6. **性能分档**：检测到软件渲染（SwiftShader/llvmpipe）或低帧率时自动降档；低档仍须可玩（headless 测试用 SwiftShader）。
7. **不要破坏**：`index.html` / `src/main.js` / `src/player.js` / `src/hud.js` / `src/scope.js` / `shared/*` / `scripts/*` 属于 Lead 或指定 Owner，**禁止越界修改**。
8. 中文注释、UTF-8、2 空格缩进、单引号风格与现有一致。

## 1. 文件所有权（写作用域）

| 文件 | Owner | 说明 |
| --- | --- | --- |
| `shared/world.js` | **Lead** | 地形高度场、布局、碰撞体、物理、射线、出生点/据点/道具点 |
| `shared/weapons.js` | **Lead** | 武器数值 + 开镜/瞄准镜元数据 + 音效参数 |
| `shared/map.js` | **Lead** | 兼容层，re-export world/weapons |
| `src/world.js` (+ `src/world/*.js`) | **env-scene** | 场景：地形网格、草地/杂草、树、房子、输电塔、光照、后期、道具模型 |
| `src/models/weapons.js` | **weapon-models** | 精密第一/第三人称枪械模型 + 瞄具/准星/红点/镜片几何 + 握持点 |
| `src/models/character.js` | **character-rig** | 人物骨骼、双骨骼 IK、持枪对准、步态/战术动作 |
| `src/audio.js` | **audio-fx** | 程序化枪声/环境声/空间化/混响 |
| `src/effects.js` | **audio-fx** | 枪口焰、弹壳、命中尘土/火花/血雾（无曳光弹） |
| `src/hud.js` | **ui-hud** | HUD 逻辑、小地图、击杀信息、命中标记、开镜遮罩 DOM |
| `index.html`, `src/style.css` | **ui-hud** | 页面结构与样式（id 契约见 §7） |
| `src/main.js`, `src/player.js`, `src/scope.js` | **Lead** | 集成、输入、相机、网络、开镜、FPS 相机、调试接口 |
| `server/server.js` | **game-server** | 权威服务器、模式、计分、协议、道具、出生、匹配 |
| `server/ai.js`, `server/nav.js` | **ai-nav** | A* 寻路/导航网格 + AI 感知与战斗决策 |
| `scripts/*`, `README.md` | **Lead** | 测试与文档 |

**并行规则**：只写自己作用域；不要 `git commit`；不要运行 `npm install`；不要改 `dist/`；不跑会占端口的常驻服务（用 `node --check` / 短脚本验证）。完成后向 Lead 报告：改了哪些文件、接口是否按契约、如何自测。

## 2. 全局视觉/手感方向

- 美术：**写实郊区 · 初秋下午 4 点金色侧光**。草绿偏黄、泥土路、白色/米色墙板房、灰褐色木栅栏、锈蚀输电塔、蓝灰远山、暖色阳光 + 冷色天光补光。禁止霓虹发光/赛博糖衣；发光只用于准星、红点、极少量仪表。
- 光照：PBR（MeshStandardMaterial，roughness/metalness 合理）、PMREM 环境贴图（程序化天空）、太阳方向光（软阴影、跟随玩家移动保证阴影分辨率）、半球补光、指数雾、ACES 色调映射、Bloom（很轻）、暗角/轻微色偏。
- 尺度：1 unit = 1 m，玩家 1.8m，房子墙高 3.2m，输电塔高 26m。
- 性能预算：满档 draw call ≤ 180，三角面 ≤ 600k；低档 draw call ≤ 80，三角面 ≤ 180k；同屏粒子 ≤ 400。静态几何一律合并/InstancedMesh。

## 3. 共享世界数据 — `shared/world.js`（Lead 实现，其余模块只读 import）

```js
export const WORLD = {
  size: 140, half: 70, maxPlayers: 8,
  playerRadius: 0.42, playerHeight: 1.8,
  eyeHeight: 1.64, crouchEyeHeight: 1.05,
  walkSpeed: 5.4, sprintSpeed: 8.4, crouchSpeed: 2.5,
  gravity: 22, jumpSpeed: 6.8, maxStep: 0.6, maxSlope: 0.9,
  maxHp: 100, respawnTime: 3, stateHz: 20, shootRange: 200,
  adsSpeedMult: 0.55, staminaMax: 100,
  // 命中盒（站立）：头球 + 躯干胶囊 + 腿胶囊
  headY: 1.68, headR: 0.23,
  bodyBottom: 0.42, bodyTop: 1.57, bodyR: 0.33,
  legsBottom: 0.1, legsTop: 0.92, legsR: 0.27,
  // 蹲下时整体高度缩放（见 hitboxesFor）
};
export const SUN = { dir: [-0.42, 0.74, 0.52], color: 0xfff0d4, intensity: 3.1,
  hemiSky: 0xbcd6f0, hemiGround: 0x8a7c5c, hemiIntensity: 1.15,
  fogColor: 0xc9d6e2, fogNear: 55, fogFar: 210, exposure: 1.05 };
export const ZONES = [
  { id: 'A', name: '西村', x: -34, z: 6, r: 9 },
  { id: 'B', name: '中央广场', x: 0, z: 0, r: 10 },
  { id: 'C', name: '东站', x: 34, z: 6, r: 9 },
];
export const ZONE_CAPTURE_TIME = 6;      // 单人从 0 到满占秒数
export const ZONE_SCORE_RATE = 1;        // 每占领一个据点每秒得分
export const MATCH_SCORE_TARGET = 240;   // 先到获胜
export const MATCH_TIME_LIMIT = 600;     // 秒
export const HOUSES = [ /* 见 §4 布局 */ ];
export const PYLONS = [...];
export const TREES = [...];   // { x, z, type:'pine'|'oak'|'bush', scale, rot }
export const FENCES = [...];  // { x1,z1,x2,z2,h } 自动生成碰撞体
export const ROCKS = [...];
export const BOUNDARY = [...]; // 4 面隐形墙碰撞体 {x,z,w,d,y0,y1}
export const COLLIDERS = [...]; // 所有实心 AABB：{x,z,w,d,y0,y1,kind}，kind: house|fence|rock|tree|pylon|wall|boundary
export const SPAWNS = { alpha: [...{x,z}], bravo: [...{x,z}], all: [...] };
export const CRATE_SPOTS = [ {x,z,type:'ak47'|'shotgun'|'sniper'} ... ];
export const ITEM_SPOTS = [ {x,z} ... ];
export function heightAt(x, z): number             // 地形高度（双线性插值，确定性）
export function terrainNormal(x, z): {x,y,z}
export function surfaceAt(x, z): 'grass'|'road'|'dirt'|'rock'
export function circleOverlapsBox(x, z, r, o): boolean
export function groundHeightAt(x, z, feetY, radius?): number
export function movePlayerHorizontal(b, dx, dz): {blocked:boolean}
   // b = {x,y,z,vy,grounded,stance:'stand'|'crouch', ...}；处理地形坡度限制 + 碰撞体推出
export function stepPlayerPhysics(b, dt): void      // 重力/落地/贴地；b 含 y,vy,grounded
export function hitboxesFor(p): { head:{x,y,z,r}, body:{...capsule...}, legs:{...} }
   // p 含 x,y,z,stance；胶囊 {ax,ay,az,bx,by,bz,r}
export function raycastWorld(ox,oy,oz,dx,dy,dz,maxDist=200):
   null | { t, point:{x,y,z}, normal:{x,y,z}, surface:string, kind:string }
export function losBlocked(ox,oy,oz,ex,ey,ez): boolean
export function zoneOf(x, z): ZONES[number] | null  // 玩家所在据点（圆内）
export function pickSpawn(team, rng): {x,z}
export function spawnYaw(spawn): number
```

- 地形高度场：`res = 140`（1m 网格，141×141），模块加载时一次算好存 Float32Array；`heightAt` 双线性插值。
- 高度构成：多层 value-noise（固定哈希种子）+ 6 座高斯山丘 + 边缘抬升 + 平整垫（广场/据点/房屋/输电塔/出生区）。山丘最大高差 8m，坡度始终可步行（`maxSlope` 只在极少数岩壁处限制）。
- `TERRAIN` 旧导出可以删除；但 `shared/map.js` 要兼容旧 import（见 §3.1）。
- 射线：先对地形做步进+二分，再对各 AABB 求 slab 最近交点，取最近；`surface` 用于粒子材质（草/泥土/木/石/金属）。
- 物理：玩家先 `movePlayerHorizontal`（地形台阶/坡度限制 + AABB 水平推出），再 `stepPlayerPhysics`（重力、落地、贴地）。服务器与客户端必须共享同一套。

### 3.1 `shared/map.js`
只做兼容 re-export：`export * from './world.js'; export * from './weapons.js';`（保留 `WORLD`, `COLLIDERS`, `SPAWNS`, `BOTS`, `stepPlayerPhysics`, `circleOverlapsBox` 等名字可用，旧测试与脚本还能跑）。

## 4. 地图布局（Lead 在 shared 中实现；env-scene 用这些数据建几何）

- 地图 140×140，边界隐形墙在 ±68，视觉铁丝网篱笆 + 密林遮挡边缘。
- 中央：十字泥土路（南北宽 8，东西宽 7）+ 广场圆盘半径 13（平整垫），据点 B 在广场。
- 据点 A(-34,6,r9) 在西北侧草地，据点 C(34,6,r9) 在东北侧草地，周围有矮墙/车辆残骸掩体（可加，碰撞体需登记）。
- 山丘 6 座（近似）：SW(-52,54,r30,h7.5)、NE(56,-50,r26,h6.5)、NW(-58,-44,r24,h4.2)、SE(48,48,r20,h3.2)、N(-8,-58,r28,h3.0)、S(8,56,r22,h2.4)。
- 房子（墙高 3.2，人字屋顶，**可进入**，正面留 1.4×2.1 门洞；墙碰撞分段）：
  - H1(-38,-26,12×9) 门朝 +Z；H2(38,-30,10×8) 门朝 +Z；H3(-40,30,13×9) 门朝 -Z；H4(36,32,10×8) 门朝 -Z；谷仓 BARN(2,-52,16×11,墙高4.2) 门朝 +Z；工具房 SHED(-14,48,6×5,墙高2.4) 门朝 -Z。
- 大型输电塔 2 座：(−30,22) 与 (32,−24)，高 26m，四腿斜桁架 + 横担 + 绝缘子 + 塔间悬链电缆（纯视觉），底座混凝土块（可站）。
- 树 ~70（松树/阔叶/灌木，树干碰撞体），石堆 ~26（部分可跳上），栅栏若干（1.1m 高，可蹲后掩护），道路两侧电线杆（纯视觉）。
- 出生点：alpha（玩家 + 友军 AI）南侧 z≈48~60；bravo（敌军 AI）北侧 z≈−48~−60。
- 武器箱：A→ak47、B→sniper、C→shotgun（固定点、定时刷新）；消耗品道具点 12 个（医疗/护盾/加速/弹药）。
- 所有出生点/据点/道具点不得与碰撞体重叠（Lead 用脚本校验）。

## 5. 玩法规则（game-server 实现）

- **模式：据点争夺 Domination**。两队 alpha（玩家+友军 AI）vs bravo（敌军 AI）。
- 占领：据点内一方存活人数 > 另一方时进度按人数加快；双方都有人 → 争夺暂停；无人 → 缓慢回退。占领完成归属该队。
- 得分：每拥有一个据点 +1 分/秒；先到 240 分或 10 分钟时间到（分高者）获胜；赛后 8 秒重置比分与据点。
- 击杀：身体伤害按武器表 + 距离衰减；爆头倍率；死亡 3 秒后在本队出生区重生；死亡不丢已拾取武器但补满弹药。
- 连杀奖励：**5 连杀（不死）→ 全队 UAV 10 秒**：敌方位置在 HUD 小地图/头顶高亮（服务器在 state 中广播 `uav` 计时）。
- 战术机动：**Shift 冲刺**（消耗体力，移速 8.4，开枪前需收枪/精度大幅下降）、**C 蹲下**（移速 2.5，散布减小、命中盒降低）、**冲刺中按 C 滑铲**（0.7s 高速低姿态，冷却 1.2s）、跳跃保留。体力 100，冲刺 -22/s，停冲 0.8s 后 +18/s，跳跃 -12。
- 换弹/切枪/开镜：沿用现机制并加 `adsTime` 开镜过渡；开镜移速 ×0.55、散布收紧；狙击开镜 6 倍且腰射极不准。
- 拾取：武器箱（ak47/shotgun/sniper）与医疗/护盾/加速；武器箱 30 秒刷新。
- AI：默认 5 个（2 友军 + 3 敌军，可用环境变量 `BOTS_MAX` 调整总量、`BOTS_TEAM_SPLIT` 可忽略），AI 会占点、找掩体、包抄、听枪声支援、低血撤退。
- 保持 8 真人上限、20Hz 状态同步、客户端预测 + 服务器权威。

## 6. 模块契约

### 6.1 `src/world.js` — env-scene

```js
export function buildWorld(scene, renderer, opts = {}) -> world
// opts: { soft?: boolean, quality?: 'auto'|'ultra'|'high'|'medium'|'low' }
// world = {
//   raycastTargets: Object3D[],        // 供本地视觉射线（地形网格 + 房屋/塔/岩石合并网格）
//   sun, hemi,                         // 灯光引用
//   quality: string,                   // 实际档位
//   setQuality(q),                     // 重建/开关草地、阴影、后期
//   update(dt, ctx),                   // ctx = { camera, playerPos, time, aiming, scope }；太阳阴影跟随、风、拾取物浮动
//   render(camera),                    // 若启用后期则走 composer，否则 renderer.render(scene,camera)
//   createItemMesh(type),              // 返回 THREE.Group（地面拾取物：武器箱/医疗/护盾/加速）
//   dispose(),
// }
```
必须实现：
1. 天空：程序化渐变天空球 + 太阳光晕 + 少量程序化云；PMREM 环境贴图给 PBR。
2. 地形：由 `heightAt` 采样生成 ~200×200 段网格，顶点色（草地绿黄渐变 / 泥土路 / 广场碎石 / 山坡岩石），边缘细节噪声法线；`receiveShadow`。
3. 草地/杂草：InstancedMesh 多层（近处草叶 + 高杂草 + 野花），顶点着色器风摆（uniform time + 玩家位置压草可选），**按距离分布**：广场/道路/房屋内不长草；低档大幅减少数量。
4. 树（松树/阔叶/灌木）、石堆、电线杆：用 shared 布局数据，低面数程序化；树冠可用 InstancedMesh + 顶点风摆。
5. 房屋：墙体 + 门洞 + 窗（夜间微亮/白天玻璃反射）+ 人字屋顶 + 门廊台阶 + 烟囱；用 `HOUSES` 与 `houseWallSegments()` 数据，**视觉碰撞与共享碰撞体一致**。
6. 输电塔：桁架（细杆合并）+ 横担 + 绝缘子串 + 塔间悬链电缆（CatmullRom 曲线 TubeGeometry，下垂感），金属锈蚀材质。
7. 篱笆/铁丝网边界：程序化木栅栏 + 边界链网 + 远处树墙；不遮挡战场视线太多。
8. 光照与后期：`SUN` 方向光（shadow map 2048，跟随玩家更新 shadow camera）+ 半球光 + 环境贴图；ACES 色调映射 + UnrealBloomPass（极轻）+ 自定义 ShaderPass（暗角、轻微对比/色温、胶片颗粒 0.02）+ OutputPass。**软件渲染/低档直接关后期与阴影**。
9. 道具模型：武器箱（木箱+武器剪影+微光标记）、医疗箱、护盾球、加速装置；`createItemMesh(type)` 返回可动画 Group。
10. `update` 里维护风时间、太阳 target、拾取物浮动旋转、远处 LOD 淡出。

### 6.2 `src/models/weapons.js` — weapon-models

```js
export function createWeaponModel(kind, { firstPerson = false, simple = false } = {}) -> THREE.Group
// kind: 'pistol'|'smg'|'ak47'|'shotgun'|'sniper'
// 局部约定：握把在原点，枪口朝 -Z，上为 +Y，右手在 +X。
// group.userData = {
//   kind,
//   muzzle: THREE.Vector3,       // 枪口局部坐标（枪焰/弹壳起点）
//   sightPoint: THREE.Vector3,   // 瞄准光学轴上的点（开镜对齐用：该点对齐屏幕中心，且枪身 -Z 与视线同向）
//   sightType: 'iron'|'reddot'|'scope',
//   scopeLens: THREE.Vector3|null, // 狙击镜前镜片局部坐标（PiP/遮罩定位用）
//   rightGrip: THREE.Vector3,     // 右手握把位置（第三人称 IK）
//   leftGrip: THREE.Vector3,      // 左手护木位置（第三人称 IK）
//   boltAxis?: THREE.Vector3,     // 拉栓轴（狙击/霰弹枪泵动动画）
// }
// firstPerson=true：整体缩放到合适视野（枪身不穿帮、不挡准心），并保留机瞄对齐
// simple=true：合并为少量 Mesh / 保留最大体块，用于第三人称与地面道具
export const WEAPON_KIND_LIST = ['pistol','smg','ak47','shotgun','sniper'];
```
要求：每把枪 **40+ 部件**级别的细节（机匣倒角、抛壳口、拉机柄、导轨、护木散热孔、弹匣弯折、握把纹理、枪托、背带环、瞄具、枪口装置）；用 `RoundedBox`/`ExtrudeGeometry`/`LatheGeometry`/`CylinderGeometry` 组合出金属质感；材质搓 roughness/metalness 与轻微色差；第一人称视图模型不能遮挡中心准心超过 15% 屏幕；第三人称版自动简化。
瞄具：pistol 机械瞄具、smg 红点镜（镜片 + 红点 sprite）、ak47 机械准星 + 可选红点、shotgun 光点准星、sniper 6 倍镜（镜筒/镜片/调节旋钮/镜桥，`sightPoint` 在镜筒轴线上）。
**枪身方向必须与 `sightPoint` 对齐**：开镜时 Lead 会把 `sightPoint` 平移到相机中心，枪口方向必须正好是 -Z（不能歪）。

### 6.3 `src/models/character.js` — character-rig

```js
export function createCharacter({ color = 0x8899aa, team = 'alpha', variant = 0 } = {}) -> char
// char = { root, head, update(state, dt), attachWeapon(group|null), dispose() }
// state = {
//   speed: number, grounded: bool, alive: bool,
//   aiming: bool, pitch: number,            // 瞄准俯仰（-1.5..1.5）
//   stance: 'stand'|'crouch', sprint: bool,
//   firing: bool, reloading: bool,
//   hitAt?: number,                          // 受击抖动
// }
```
要求：
- 结构：root（外部设位置/朝向 yaw=服务器 yaw，模型面朝 -Z）→ 髋 → 脊柱 → 胸 → 颈 → 头，双腿/双臂关节树；脚底 y=0，身高 1.8m（蹲下 1.2m）。
- **双骨骼 IK**：右手 IK 到武器 `rightGrip`、左手 IK 到 `leftGrip`；武器世界朝向 = 本地 aim（root 的 yaw + 武器绕 X 轴 pitch），枪口方向必须与瞄准方向一致（禁止斜举/倒持）。无武器时双手自然下垂/战术持枪姿态。
- 步态：行走/冲刺/蹲行/滑铲/跳跃/落地缓冲，脚掌尽量踩实（可做简化两骨 IK + 步幅相位），身体起伏与手臂反相协调。
- 战术动作：换弹（左手卸弹匣→插弹匣→拉栓）、开火后坐（躯干/枪身后座）、受击抽搐、死亡倒地（关节松垂侧倒，不穿地）。
- 外观：战术头盔 + 护目镜/面罩、防弹背心 + 弹匣袋、护膝护肘、战术靴、背包、手套；队伍颜色只在臂章/头盔条纹/背包灯体现（alpha 蓝青 / bravo 红橙），主色为灰绿/沙色迷彩。
- 性能：每个角色 draw call ≤ 12（按材质合并，骨骼关节用 Group 旋转即可，不用 SkinnedMesh 也行）。

### 6.4 `src/audio.js` — audio-fx

```js
export function initAudio() -> bool
export function setAudioListener(pos, forward)          // 每帧调用，用于 3D 定位
export const sfx = {
  shoot(kind, opts),        // opts: { distance, pan, indoor }；每把枪独立音色
  dryFire(), reload(kind), reloadStep(kind, step), switchWeapon(),
  hit(part), hitConfirm(part), headshotConfirm(), kill(), hurt(), death(),
  jump(), land(), footstep(surface, speed), slide(),
  pickup(kind), heal(), uiClick(), capture(progress01), zoneLost(), uav(), win(), lose(),
  whiz(),                   // 子弹擦身
  explosion? 不需要
}
export function startAmbience() / stopAmbience()
```
要求（真实感关键）：
- 枪声分层合成：**瞬态**（噪声爆发 + 带通 2–6kHz 的 crack）+ **低频胸腔冲击**（60–120Hz 正弦/三角包络）+ **机械声**（击锤/枪机，短方波 clicks）+ **户外拖尾**（ConvolverNode：程序化生成户外 IR = 早期反射 3~6 个延迟抽头 + 指数衰减噪声，湿声 0.18~0.35）。每把枪参数不同：手枪清脆、冲锋枪密集短促、步枪中频厚实、霰弹低频轰 + 泵动声、狙击超响长拖尾 + 拉栓声。
- 远处枪声：低通（随距离降低截止频率）+ 增益衰减 + 立体声 pan + 轻微延迟（距离/343）。距离 > 60m 只留闷响 + 回音。
- 环境声：程序化风声（滤波噪声 + LFO）、鸟叫/虫鸣随机点缀、远处偶尔狗吠/汽车（低概率）；`startAmbience` 幂等。
- 总线：master gain → DynamicsCompressor → destination；混响 send。所有节点在 `initAudio` 后惰性创建，AudioContext 不可用时全部安全 no-op（自动化测试环境不能报错）。
- 禁止外部音频文件、禁止 Base64 音频资源。

### 6.5 `src/effects.js` — audio-fx

```js
export class Effects {
  constructor(scene, renderer)          // 可选 renderer 用于质量判断
  muzzleFlash(position, direction, kind)   // 枪口焰（短促星形 sprite + 点光源 + 烟）+ 弹壳抛壳
  shellEject(position, direction, kind)
  impact(point, normal, surface, kind)     // 按 surface：草/泥→土尘碎屑，石→火花+碎渣，木→木屑，金属→火花
  bloodImpact(point, direction, headshot)  // 血雾/血点（爆头更多更红）
  update(dt, camera)
  setQuality(level)
  count()                                  // 活跃粒子数（测试用）
  dispose()
}
```
要求：无曳光弹；所有粒子对象池化（上限 256 个系统）；枪口焰 40–70ms、有方向性（沿枪管锥形）；弹着灰尘用加色+普通混合分层；低档减少粒子；第一人称不要遮挡视野中心。

### 6.6 `src/hud.js` + `index.html` + `src/style.css` — ui-hud

`hud.js` 导出：
```js
export function initHud()
export const hud = {
  showMenu(), hideMenu(), setMenuStatus(text, kind),
  setHp(hp, max), setShield(v, max), setStamina(v, max), setStance(stance),
  setWeapon(kind, name, mag, reserve), setReload(progress01OrNull),
  setWeaponSlots(ownedMap, activeId, order),
  setCrosshair(spreadPx, opts),          // opts: { ads, hidden }
  setAiming(ads, sightType),             // ads=true 时触发开镜 UI（狙击显示遮罩）
  setScope(active, sightType, zoomLabel),
  showHitmarker(part, killed),           // part: 'head'|'body'|'legs'；head+killed 特殊
  flashDamage(headshot), showDamageFrom(angleRad),
  setScores(scores), setZones(zonesRuntime), setTimer(sec), setUav(active, secLeft),
  setKills(kills), setDeaths(deaths), setPing(ms), setPlayers(list),
  addKillFeed({ killer, victim, headshot, weapon }), addToast(text),
  showDeath(text, sub), hideDeath(), showPause(text), hidePause(),
  showMatchEnd({ winner, scores }), hideMatchEnd(),
  setMinimapState(state),   // { x,z,yaw, allies:[{x,z,color,name}], enemies:[{x,z}], zones, uav }
  setVisible(v),
}
```
`index.html` 必须保留：`#game` canvas、`#menu`（昵称 `#nick` + `#joinBtn` + `#connStatus`）、`#hud`、`#pause`、`#death`、`#toasts`、`#crosshair`、`#hitmarker`。可新增：`#minimap` canvas、`#killfeed`、`#compass`、`#scoreBar`、`#zoneBar`、`#scopeOverlay`（含 SVG 十字分划 + 圆形遮罩 + 暗角）、`#staminaBar`、`#stanceBadge`、`#dmgIndicators`、`#matchEnd`、`#settings`（可选）。
- **命中特效硬要求**：普通命中 = **白色十字**（`+`，26px，0.18s 缩放淡出）；爆头 = **红色斜对角线 ×**（两条 45° 红线，40px，更强发光/更久 0.4s），击杀叠加强化动画。不要用旧的颜色混用。
- 开镜遮罩：狙击开镜时显示圆形视野（CSS 径向渐变黑色外圈、细十字分划、密位点、镜身阴影、轻微色差），中心必须留出透明区域看到真实 3D 画面（Lead 负责真实放大渲染）。红点/机瞄不显示遮罩。
- 小地图：Canvas 绘制地形高度感底色（可从 `shared/world.js` 的 `heightAt` 采样一次）+ 据点 + 队友 + UAV 敌人 + 玩家朝向箭头；右上角。
- 顶部罗盘条（方向 + 据点方位标记 A/B/C），底部状态条：生命/护盾/体力/弹药/武器槽。
- 风格：写实军事 HUD——低饱和、细线条、半透明深色面板、等宽数字字体、无霓虹发光、轻微动态。中文文案。
- 弹窗：菜单（郊区战场标题、操作说明、画质选项、灵敏度滑块→写 localStorage）、结算面板、死亡面板。
- `window.__hud` 暴露当前状态供自动化测试断言（如 `{ hitmarkerPart, scopeActive, hp, ... }` 返回给 Lead 约定用 `window.__game`）。

### 6.7 `server/nav.js` + `server/ai.js` — ai-nav

```js
// nav.js
export function buildNav(): Nav             // 1m 网格，用 heightAt/COLLIDERS/maxSlope，标记可走/不可走/代价
export function findPath(nav, sx, sz, tx, tz): {x,z}[] | null   // A* 8 邻接 + 平滑
export function nearestWalkable(nav, x, z): {x,z}
export function randomWalkable(nav, rng): {x,z}
export function sampleCover(nav, x, z, threatX, threatZ): {x,z}|null // 找能挡住视线的邻近点
export function hasLineOfWalk(nav, ax, az, bx, bz): boolean
// ai.js
export function createBrain(botId): brain
export function aiUpdate(bot, now, ctx): void
// ctx = { players, nav, zones, items, eventBus, world: { losBlocked, heightAt, WORLD }, rand }
// bot 由 server 创建，字段见 §5/§8；aiUpdate 只能读写 bot 的 input/yaw/pitch/aiming/stance/sprint/fireAt/nextFireAt/brain 等，
// 不能直接改 x/z/hp（移动由 server 的 updatePlayer 用 bot.input 推进；开火由 server 调 handleShoot）
```
要求：
- 感知：视锥（110°，远 55m）+ 距离衰减发现时间（近处 0.25s，远处 1.2s）+ LOS 检查（头/胸两点）+ 听觉（枪声 45m / 脚步 12m）+ 队友共享情报 + 记忆（最后已知位置 6s，插值预测）+ 被击时立即警觉。
- 寻路：A* 网格路径（1m，8 向，octile 启发），路径平滑（LOS 拉直），沿路 steering；卡住检测→重规划；越障（可跳过矮石）；定期刷新。
- 战斗：目标选择（距离/可见/威胁）、转向速率限制、瞄准误差随追踪时间收敛、点射（3~5 发）与全自动切换、换弹、低血撤退、找掩体、包抄、不隔墙开枪、友军不误伤、占点目标优先。
- 难度：`AI_CONFIG` 中可调（反应、误差、射速、血量倍率）；默认接近"普通 FPS 玩家"但不是神枪手；AI 数量 ≤5。
- 性能：每个 AI 每 200ms 决策一次；路径最多 2s 重算；共享 nav 网格只建一次（模块级缓存）。

### 6.8 `server/server.js` — game-server

保持导出（供测试 import）：`createPlayer, createBot, handleShoot, respawn, snapshot, updatePlayer, aiUpdate, canSee, countBots, spawnItem, applyItem, items, players, startReload, finishReload, switchWeapon, grantWeapon, ammoOf, makeLoadout`，可新增、不要删除已有名字（测试会使用）。
协议（JSON）：
- C→S：`join{name}`、`input{seq,yaw,pitch,mx,mz,jump,sprint,crouch,aim}`、`shoot{yaw,pitch}`、`reload`、`switch{weapon}`、`ping{time}`、调试 `debug_pos{name,x,z,y}`/`debug_spawn_bot{team}`/`debug_spawn_item{type,x,z}`/`debug_zone{id,team}`/`debug_hp{name,hp}`（仅 `DEBUG=1`）
- S→C：`welcome{id,color,team,spawn,maxPlayers,players,zones,mode}`、`state{ts,players[],items[],zones[],scores{alpha,bravo},match{mode,timeLeft,target},uav{alpha,bravo},killfeed?}`、`hit{...}`、`death{...}`、`shot{...}`、`reload_start/reload_done`、`weapon_switch`、`dry_fire`、`pickup`、`player_joined/player_left`、`zone_capture{...}`、`zone_lost`、`match_end`、`uav_start`、`pong`、`error`
- 快照每玩家：`id,name,color,team,x,y,z,yaw,pitch,hp,alive,weapon,stance,sprint,grounded,aiming,kills,deaths,shield,speed,uav` 等。
- 服务器权威：移动（共享物理）、命中（共享 hitboxes + LOS）、弹药、开镜散布、据点、计分、重生、AI。
- 反作弊基础：位置校验（速度上限）、消息频率限制。
- 生产静态托管 dist 不变；`PORT`、`BOTS_MAX`、`DEBUG` 环境变量兼容。
- HTML 与 WS 同端口；无需房间系统，单局。

## 7. 关键 DOM id 契约（ui-hud 必须提供，Lead 依赖）

`#game #menu #nick #joinBtn #connStatus #hud #pause #pauseText #death #deathText #deathSub #toasts #crosshair #hitmarker #hitmarker-head #minimap #killfeed #compass #scoreBar #zoneBar #scopeOverlay #staminaBar #stanceBadge #dmgIndicators #matchEnd #hpFill #hpNum #shieldWrap #shieldFill #ammoMag #ammoReserve #reloadWrap #reloadFill #weaponSlots #weapon #score #status #players #hint`
`window.__hud`（可选）与 `window.__game` 由 main.js 提供；HUD 只负责 DOM。

## 8. Lead 集成（main.js / player.js / scope.js）

- 渲染器：WebGLRenderer antialias（非软渲染），ACES，exposure `SUN.exposure`；软件渲染自动低档 + pixelRatio 0.6。
- 相机：FOV 75（非开镜），狙击开镜 FOV 由武器 `scopeFov` 决定（约 18°），ADS 过渡 0.18s；相机旋转 + 后坐力 + 镜头晃动 + 开镜呼吸摆动。
- 第一人称武器：每把枪由 `createWeaponModel(kind,{firstPerson:true})`；腰射位/开镜位由 `sightPoint` 计算对齐（**不是手工猜位置**）；后坐力抬枪、换弹下沉、切枪抬起、疾跑收枪、落地缓冲。
- 开镜：`scope.js` 提供 `ScopeController`；狙击开镜 = 真实放大 + DOM 遮罩 + 轻微暗角/色差/呼吸；红点 = 3D 红点与机械瞄具对齐；机瞄 = 枪身几何对齐。
- 命中特效：服务器 `hit` 消息 → HUD 白十字/红 X + Effects 血雾 + 声音；本地射击即时反馈（枪口焰/弹壳/弹着尘土），无曳光弹。
- 网络插值：远程玩家 20Hz 快照插值 + 速度估计 + 动作状态（瞄准/蹲/冲刺/换弹/开火）。
- 调试：`window.__game = { camera, local, player, remotes, killCount, fps, errors, itemCount, zoneState, setQuality, scopeActive, hitmarkerPart, ... }` 供自动化测试。
- 自适应画质：fps < 45 逐步降档（关后期→关阴影→降草密度→降分辨率）。

## 9. 验收标准（必须全部满足）

1. 地图：起伏草地 ≥6 座山丘、可进入小房子、26m 输电塔 + 电缆、杂草/树/石、泥土路、真实光照与阴影；**无平坦大地面**观感。
2. 人物：第三人称持枪时枪口方向与瞄准方向一致（水平/上下都不歪）；手脚动作协调；蹲/冲刺/换弹/死亡动画正确。
3. 开镜：狙击开镜有真实放大、镜头晃动、呼吸、圆形遮罩与分划；红点/机瞄真实对齐；腰射与开镜精度有显著差异。
4. 枪声：5 把枪音色可区分、有拖尾与空间感、远处闷响；环境风声鸟鸣。
5. 命中特效：普通命中白十字、爆头红斜对角线 X；无曳光弹。
6. 预瞄光点：准星/红点为真实动态（随散布/移动/开镜变化）；红点开镜时与视线对齐。
7. AI：能绕障寻路、占点、找掩体、听枪声、记忆目标；不隔墙开枪、不直线撞墙。
8. 玩法：据点争夺可完整进行（占领/得分/胜负/重置）、冲刺/蹲/滑铲、5 连杀 UAV。
9. `node scripts/smoke.mjs` 全部通过（Lead 重写，≥70 断言）；`node scripts/browser-test.mjs` 通过（Playwright + SwiftShader）；无 console error。
10. 文件结构清晰、README 更新、无外部资源、无新增依赖。

## 10. 运行与自测

```bash
cd 3Dtest
node --check src/world.js            # 语法自测
node -e "import('./shared/world.js').then(m=>console.log(m.heightAt(0,0)))"
node server/server.js                 # PORT=3001
node scripts/smoke.mjs                # 服务器/共享逻辑
node scripts/browser-test.mjs         # 浏览器端到端（Lead 用）
npm run build                         # vite build（Lead 用）
```
