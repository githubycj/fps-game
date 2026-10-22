# 潮汐湾 · 死亡竞赛 — 团队契约 v1

> 本文件是本次改版的**唯一契约**。所有智能体动手前必须读完。
> 前序快照已提交 git（`bb2aba5`），任何破坏性改动都可以回滚。

## 0. 目标

1. **新增地图「潮汐湾 TIDEWATER」**：参考 https://github.com/dgreenheck/tidewater 的海岛渔村美术方向与空间布局，
   在我们的 Three.js + 程序化建模技术栈里重建为一张**射击地图**（不是钓鱼游戏）。
2. **删除拆弹玩法**（Search & Destroy：炸弹、包点、回合、购买、经济、安包/拆包）**与据点争夺**。
3. **新玩法：死亡竞赛 Deathmatch** —— 限时内**击杀数（人头）最多的小队获胜**，支持**多支 AI 小队**（默认 4 队 × 3 AI）。

## 1. 硬约束

- 技术栈不变：Vite + Three.js 0.170 + Node ws。**不新增 npm 依赖**。
- **零外部资源**：全部程序化建模 / 贴图 / 音频。**不复制 tidewater 仓库的 GLB/OGG/JPG 资源**（只在 `.tmp/tidewater-src/` 里阅读参考）。
- 确定性：地形高度、布局、碰撞体必须是纯函数（固定种子），客户端与服务器逐位一致，**禁止 Math.random() 参与静态布局**。
- 中文注释、UTF-8、2 空格缩进、单引号。
- 不要 `git commit`、不要 `npm install`、不要改 `dist/`、不要起常驻服务占端口。
- 只写自己作用域的文件（见 §7）。

## 2. 已由 Lead 落地的地基

| 文件 | 作用 |
| --- | --- |
| `shared/mode.js` | **玩法唯一契约**：`DM` 配置、`SQUADS`（4 队）、`AI_CONFIG` |
| `shared/phys.js` | `createWorldPhysics(ctx)`：通用物理/射线/命中盒/出生点工厂（新地图复用） |
| `shared/active.js` | 地图注册表：按 `MAP_ID` 把 `shared/world.js` 或 `shared/tidewater.js` 的导出透出 |
| `shared/tidewater.js` | **占位**，map-data 负责替换成真正的海岛地图 |
| `shared/world.js` | 郊区地图（**保持不动**，只作为旧地图与参照实现） |

地图选择：服务器 `MAP=suburban|tidewater`（默认 `tidewater`）；浏览器 `?map=` 或 `globalThis.__MAP_ID__`。
服务器在 `welcome` 回传 `map`，客户端不一致时自动 `?map=` 刷新。

## 3. 新地图「潮汐湾」规格（map-data 实现 `shared/tidewater.js`）

### 3.1 坐标系与尺度
- `WORLD.size = 320`，`WORLD.half = 160`。1 unit = 1 m。**海平面 y = 0**。
- x 向东，z 向南。**南侧（+z）是大海**，北侧（-z）是岛体与山脊。玩家 yaw=0 看向 -Z。
- 玩家/命中盒/移动参数**沿用郊区那套数值**（直接抄 `shared/world.js` 的 WORLD 里那些字段，别改）。

### 3.2 地形（必须纯函数 + 1m/1.25m 高度场双线性插值）
- 海岸线：`shoreZ(x)` 在 z ≈ 20~34 之间缓慢起伏（正弦 + valueNoise），x=±160 处收口。
- 沙滩：`shoreZ - 30 < z < shoreZ + 45`，坡度平缓（3°~7°），高度从 0.4m 缓升到 3m。
- 岛体：z < shoreZ 逐级抬升；西侧岬角 (x≈-118, z≈-30) 高 30m，东侧岬角 (x≈120, z≈-16) 高 26m，
  北侧主脊 z≈-150 高 55m（作背景，超出边界）。
- 海床：z > shoreZ 高度下降，`z = shoreZ + 20` 处约 -3m，`+80` 处 -16m。
- 村落地台：`(x≈28, z≈-62)` 半径 46 的平整台地，高 8.5m，**必须完全平整**（房屋/广场）。
- 礁石浅滩：`(-78, 58)` 半径 58 的浅水区，海床抬高到 -1.2m 左右，露出若干礁石。
- 所有高度必须 `|h| <= 120`，避免物理炸掉。

### 3.3 地标与掩体（全部要登记碰撞体）
1. **长栈桥 PIER**（地图灵魂，狙击位）：`x = 52`，从沙滩 `z = 18` 延伸到 `z = 96`；
   桥面 `deckHeight = 2.8`（高出海面），桥宽 3.4m，尽头 T 形平台 16m × 9m。
   桥面可走（碰撞体 y0=deckHeight-0.35, y1=deckHeight），栏杆 1.05m 高（可越/可蹲掩）。
   从沙滩有一条木栈道接上桥头（斜坡/台阶，坡度可走）。
2. **渔村**（6~8 栋可进入建筑，复用 `HOUSES` 数据结构 + `houseWallSegments`）：
   - 吊脚渔屋 ×3（西侧，wallH 3.0，屋顶 corrugated）
   - 船屋 BOATHOUSE（东侧，wallH 4.0，大门朝海）
   - 杂货铺 CHANDLERY（村中心，wallH 3.2）
   - 鱼摊棚 FISHSTAND（半开放，无墙，只有顶棚 + 柱子）
   - 工具棚 SHED（北侧）
   风格字段 `style`: `'stilt' | 'boathouse' | 'chandlery' | 'fishstand' | 'shed'`（scene 侧据此换材质/造型）。
3. **木栈道 BOARDWALK**：从沙滩上到村广场的木板路，宽 3m。
4. **码头 DOCK**：东侧 `(96, 30)` 一个小码头 + 2 艘搁浅渔船（可跳上船头作掩体，要碰撞体）。
5. **礁石 SEA_STACKS**：浅滩上 6~8 块礁石（`ROCKS`），部分可跳上。
6. **掩体道具**：木箱、油桶、龙虾笼、渔网架、破船板（`DEFENSES` 或新 `PROPS` 数组，必须有碰撞体）。
7. **植被**：棕榈 ×40（`TREES` 里 `type: 'palm'`）、阔叶树 ×20（`type: 'broadleaf'`）、灌木 ×40（`type: 'bush'`）、
   沙丘草（视觉，无碰撞）。

### 3.4 出生点（4 队）
`SPAWNS = { alpha, bravo, charlie, delta, all }`，每队 5~8 个点，分布在地图四角/四边，
**互相距离 ≥ 70m**，且不得与碰撞体重叠（用 `isWalkableAt` 校验）。
`spawnYaw(spawn)` 让玩家朝地图中心。

### 3.5 道具点
- `CRATE_SPOTS`：5 个武器箱（ak47 / sniper / shotgun / m416 / deagle），放在高价值点位（栈桥尽头、船屋、礁石、村广场、西岬角）。
- `ITEM_SPOTS`：14~18 个消耗品点（医疗/护盾/加速），固定种子采样，避开碰撞体，彼此间距 ≥ 8m。

### 3.6 必须导出的完整 API（与 `shared/world.js` 同名同义）
```
WORLD, SUN, ZONES, HOUSES, PYLONS, CARS, DEFENSES, FENCES, ROADS, TREES, ROCKS,
BOUNDARY, COLLIDERS, SPAWNS, CRATE_SPOTS, ITEM_SPOTS, FURNITURE, FURNITURE_DEF,
WINDOW_SPEC, WORLD_INFO, MAP_EXTRAS,
heightAt, terrainNormal, surfaceAt, houseSides, houseFloorTop, houseWallSegments,
seedOf, circleOverlapsBox, movePlayerHorizontal, groundHeightAt, stepPlayerPhysics,
applyJump, hitboxesFor, raycastWorld, losBlocked, zoneOf, pickSpawn, spawnYaw,
isWalkableAt, hash2i, valueNoise, mulberry32
```
- 物理/射线直接用 `createWorldPhysics({ WORLD, heightAt, terrainNormal, surfaceAt, colliders: () => COLLIDERS, zones: () => ZONES, spawns: () => SPAWNS })`。
- `SUN`：午后热带海岸光。太阳高度角高、色温偏暖白，天空偏青蓝，海雾淡。
  建议 `dir: [-0.30, 0.86, 0.41]`, `color: 0xfff2dd`, `intensity: 3.0`,
  `fogColor: 0xbcd6dd`, `fogNear: 140`, `fogFar: 700`, `exposure: 1.02`。
- `ZONES`：死亡竞赛不再用据点，返回 `[]`（保留字段避免下游报错）。
- `PYLONS` / `CARS`：返回 `[]`（村子不需要输电塔；车可用 `CARS` 放 2 辆废弃皮卡，可选）。
- `MAP_EXTRAS`：地图专属数据，供 scene 使用：
  ```js
  export const MAP_EXTRAS = {
    seaLevel: 0,
    pier: { x, zStart, zEnd, deckHeight, width, headWidth, headDepth, railH },
    boardwalk: [{ x1, z1, x2, z2, w, y }],
    docks: [{ x, z, rot, w, d, y }],
    boats: [{ x, z, rot, len, beam, hullY, tilt }],
    stalls: [{ x, z, rot, w, d, h }],
    reef: { x, z, r },
    shoreline: { samples: [{ x, z }] },   // 每 4m 一个采样点，scene 用来做湿沙带/浪花
  };
  ```

### 3.7 自检脚本 `scripts/validate-tidewater.mjs`（map-data 写）
必须断言：
- `heightAt` 在 321×321 网格上全部有限、无 NaN。
- 出生点 `isWalkableAt` 全部 true，两两距离 ≥ 60。
- `CRATE_SPOTS` / `ITEM_SPOTS` 不与碰撞体重叠。
- 栈桥桥面沿线 `groundHeightAt` ≈ deckHeight（可走）。
- 房屋门洞可通行（门口点 `isWalkableAt` true）。
- 沙滩→村落地台存在一条可走路径（粗略：沿路径采样 `isWalkableAt`）。

## 4. 玩法规格（game-server 实现 `server/*.js`）

### 4.1 删除
- `bomb` 状态机、`BOMB_CFG`、`credits`、`BUY_MENU`、`tryPlantBomb/tryDefuseBomb/explodeBomb/updateBomb`、
  `startRound/endRound/resetBomb/respawnForRound/checkRoundElimination`、回合比分。
- 据点占领：`updateZones/updateScores/onZoneCaptured/zoneRuntime` 的得分逻辑（`zoneRuntime` 可保留但不再计分；
  **更干净的做法是整段删除**，`ZONES` 字段留着但不用）。
- `mode: 'domination' | 'bomb'` 分支 → 只有 `'dm'`。

### 4.2 新增
- `match.mode = 'dm'`，`match.phase: 'waiting' | 'countdown' | 'playing' | 'ended'`。
- `match.timeLeft` 从 `DM.timeLimit` 倒数；到 0 → 按击杀数排名结束。
- `DM.killTarget > 0` 时先到即结束。
- 计分：`scores = { alpha: n, bravo: n, charlie: n, delta: n }`（**小队击杀数**）。
- 玩家 `team` 字段改叫 `squad`（保留 `team` 别名，值相同，避免旧代码/测试崩）。
- 加入：自动分配到人数最少的小队（`DM.autoBalance`）。
- 友伤关闭：`canDamage` 只允许跨小队。
- 击杀归属：`onKill` 给 killer 所在小队 +1，写 killfeed（含小队颜色/名称），触发连杀 UAV。
- 复活：`DM.respawnTime`，出生保护 `DM.spawnProtect` 秒（`p.protectUntil`，期间 `canDamage` 返回 false）。
- AI：每队 `DM.botsPerSquad` 个，`AI_CONFIG.max` 上限。环境变量 `BOTS_PER_SQUAD`、`SQUADS`（2/3/4）可覆盖。
- AI 行为改为死亡竞赛：**无据点目标**。改为：巡逻 → 听到枪声/看到敌人 → 交战 → 找掩体 → 追击最后已知位置 → 低血撤退 → 重新巡逻。
  `server/ai.js` 里对 `zones` 的依赖必须去掉（`ctx.zones` 可以继续传空数组，但决策逻辑不能依赖它）。
- 玩家数上限 `DM.maxPlayers`。

### 4.3 协议（JSON over ws）
**C→S**：`join{name}`、`input{...}`、`shoot{yaw,pitch}`、`reload`、`switch{weapon}`、`ping{time}`、
`start{ }`（原按空格开始）、调试 `debug_*`（仅 DEBUG=1）。
**S→C**：
- `welcome{ id, name, color, squad, squads, spawn, maxPlayers, players, map, mode, match }`
- `state{ ts, players[], items[], scores{squadId: kills}, standings[], match{mode,phase,timeLeft,killTarget}, uav{}, killfeed[] }`
- `hit`、`death`、`shot`、`reload_start/reload_done`、`weapon_switch`、`dry_fire`、`pickup`、
  `player_joined/player_left`、`match_start`、`match_end{ winner, standings }`、`uav_start`、`pong`、`error`
- **删除**：`zone_capture`、`zone_lost`、`bomb_*`、`credits`、`buy`、`round_*`。
- 快照每玩家：`id,name,color,squad,team,x,y,z,yaw,pitch,hp,alive,weapon,stance,sprint,grounded,aiming,kills,deaths,shield,speed,uav,streak`。

### 4.4 必须保留的导出（`scripts/smoke.mjs` 会 import）
`createPlayer, createBot, handleShoot, respawn, snapshot, updatePlayer, aiUpdate, canSee, countBots,
spawnItem, applyItem, items, players, startReload, finishReload, switchWeapon, grantWeapon, ammoOf, makeLoadout`
（可新增，不要删除已有名字）。新增建议导出：`scores, match, SQUADS`, `startMatch`, `endMatch`, `assignSquad`。

## 5. 客户端规格

### 5.1 场景（scene-terrain-ocean / scene-village）
- `src/world/tidewater/terrain.js`：海岛地形网格（顶点色：湿沙/干沙/草地/岩石/海床），
  按 `heightAt` 采样；沙滩带做湿沙渐变（靠近水面更深色）。
- `src/world/tidewater/ocean.js`：海面。要求：
  - 大平面网格（不需要 FFT），顶点着色器 3~4 组 Gerstner 波叠加，远处降低细节；
  - 颜色：深水青蓝 → 浅水翠绿（按水深 lerp），菲涅尔反射天空色，太阳镜面高光；
  - 近岸白沫：按 `水深 < 1.2m` + 噪声生成泡沫带，随时间推移；沙滩上做一条"冲浪线"（`shoreline` 采样点）。
  - 低档：降低网格分辨率、关泡沫细节。
  - 导出 `createOcean({ preset, extras, heightAt })` → `{ group, update(dt, ctx), dispose() }`。
- `src/world/tidewater/village.js`：渔村建筑（吊脚屋/船屋/杂货铺/鱼摊/工具棚）+ 木栈道 + 广场。
  复用 `createBuildings` 的结构思路，但材质换成"风化木板 + 波纹铁皮 + 茅草"，并加**吊脚支柱**。
- `src/world/tidewater/pier.js`：长栈桥 + T 形平台 + 栏杆 + 系船桩 + 桥头台阶。
- `src/world/tidewater/props.js`：渔船、木箱、油桶、龙虾笼、渔网架、破船板、鱼摊遮阳棚。
- `src/world/tidewater/vegetation.js`：棕榈（弯曲树干 + 羽状叶 InstancedMesh）、阔叶树、灌木、沙丘草（风摆）。
- 全部模块统一签名：`createX({ preset, anisotropy, extras })` → `{ group, update?(dt, ctx), dispose?(), raycastTargets? }`。
- **Lead 负责 `src/world/tidewater/index.js` 的装配**（把上面这些拼成 `buildTidewaterWorld`）。

### 5.2 UI / 网络（client-ui）
- 菜单：地图名/副标题/描述来自 `MAP_META`；玩法说明改为死亡竞赛；**移除**拆弹与购买说明。
- HUD：
  - `#scoreBar` 改为 **4 队排名条**：每队一行（颜色块 + 队名 + 击杀数），按击杀降序，自己的队伍高亮；
  - 中间显示倒计时 `#timer` + 目标 `#modeLabel`（"死亡竞赛"）+ `#scoreTarget`（"先到 N 击杀" 或 "限时 8:00"）；
  - 删除 `#bombHud`、`#buyMenu`、`#bombPrompt` 相关 DOM 与逻辑；
  - 小地图：队友按小队颜色、敌人仅 UAV 期间显示；
  - 击杀信息：`杀手[队色] ▸ 受害者[队色]`；
  - 个人 K/D + 连杀 + UAV 计时保留；
  - 结算面板：`#matchEnd` 显示 4 队排名表 + 自己的名次。
- `src/main.js`：处理新协议，删除 bomb/credits/round 事件；`window.__game` 增加 `scores/standings/squad` 供测试。
- `index.html`：删除 `#bombHud/#buyMenu/#bombPrompt`，新增 `#squadBoard` 容器。
- `src/style.css`：新增 4 队配色 `.squad-alpha/.squad-bravo/.squad-charlie/.squad-delta` 与排名条样式。

## 6. 验收标准

1. `node --check` 全部改动文件通过。
2. `node scripts/validate-tidewater.mjs` 全绿。
3. `node scripts/smoke.mjs` 全绿（Lead 会重写断言）。
4. `npm run build` 通过。
5. `MAP=tidewater node server/server.js` 起服，浏览器能进入潮汐湾，看到海面、沙滩、栈桥、渔村。
6. 4 队各 3 个 AI 会互相交战、击杀计数上涨、时间到出结算。
7. 无 console error。

## 7. 文件所有权（写作用域，互不重叠）

| Owner | 文件 |
| --- | --- |
| **Lead** | `shared/mode.js` `shared/phys.js` `shared/active.js` `src/world.js` `src/world/tidewater/index.js` `src/world/shared.js` `index.html`(引导脚本) `scripts/smoke.mjs` `scripts/validate-world.mjs` `README.md` `DESIGN_TIDEWATER_DM.md` |
| **map-data** | `shared/tidewater.js` `scripts/validate-tidewater.mjs` |
| **scene-terrain-ocean** | `src/world/tidewater/terrain.js` `src/world/tidewater/ocean.js` `src/world/tidewater/vegetation.js` |
| **scene-village** | `src/world/tidewater/village.js` `src/world/tidewater/pier.js` `src/world/tidewater/props.js` |
| **game-server** | `server/server.js` `server/ai.js` `server/nav.js` |
| **client-ui** | `src/main.js` `src/hud.js` `src/style.css` |

> 归属不明或需要跨域改动时，先发消息给 Lead，不要自己动手。

## 8. 参考：tidewater 仓库

已 clone 到 `.tmp/tidewater-src/`（**只读参考，不要 import、不要复制资源**）。
关键参考文件：
- `src/world/WorldLayout.js` —— 世界尺度/栈桥/村/礁/出生点布局
- `src/world/terrain/IslandShape.js` —— 山脊骨架、海蚀柱、小径（可以借鉴 ridgeEnvelope 的思路）
- `src/world/village/Buildings.js` —— 渔村建筑造型语言
- `src/world/Pier.js` —— 栈桥
- `src/world/Vegetation.js` —— 棕榈/沙丘草
- `src/ocean/*` —— 海面与浪花（我们只需要简化版）
- `docs/screenshot.jpg` `docs/screenshot-beach.jpg` —— 美术方向（可以 `read_image` 看）
