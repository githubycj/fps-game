# 第三方源码：dgreenheck/tidewater

本目录是开源海岛地图项目 [dgreenheck/tidewater](https://github.com/dgreenheck/tidewater) 的源码快照，
用于在 Node 中**直接运行上游的地图生成代码**，把 Tidewater 这张地图的地形、村落、码头、道具、岩石、
植被布置提取成本游戏可用的数据（见 `tools/bake-tidewater.mjs` 与 `docs/tidewater-data.md`）。
这不是重新制作地图，而是提取并复用上游作者的成果。

| 项 | 值 |
| --- | --- |
| 仓库 | https://github.com/dgreenheck/tidewater |
| 快照 commit | `4811ba48d795197de5621985f404e765c0b7c0ef`（2026-09-24，main） |
| 许可证 | MIT，`Copyright (c) 2026 DRG Software Solutions LLC`（见本目录 `LICENSE`） |
| 引入范围 | 仅 `src/`（地图生成与 CPU 几何需要的模块）、`LICENSE`、`CREDITS.md`、`README.md`、`package.json` |
| 未引入 | `public/`（约 54 MB 的贴图/音频/模型资源，本游戏不需要）、`test/`、`docs/` 的大图 |

## 相对上游的改动（全部标注 `[DSH-PATCH n]`，共 3 处）

上游当前版本是原生 WebGPU 渲染器。本仓库只复用它的 **CPU 地图生成**部分，运行在 Node（headless，无 GPU）。
为了让这些模块在无 WebGPU device 的环境下能跑通，做了以下最小改动：

1. **`src/world/Props.js`** — `FishProps`（上游用 WebGPU storage buffer 渲染鱼的实例）替换为
   空实现 `{ tailAnchor, gillAnchor, restHeight, build: () => null }`；`fishProps()` 返回
   `{ add(){}, build(){ return null } }`。鱼不属于地图静态数据。
2. **`src/world/Village.js`** — `_assemble()` 里 `B.fishProps.build()` 返回值可能为 `null`，加判空。
3. **`src/world/terrain/DetailTextures.js`** — 当 `globalThis.__TIDEWATER_HEADLESS__` 为真时跳过
   `tex.getGPU()/generateMipmaps()`（没有 GPU 会崩），保留 CPU 端 `tex.image.data`，植被散布规则照常采样。

除上述 3 处外，`src/` 与上游 commit 完全一致（可用 `git diff` 对照上游仓库验证）。
`src/engine/` 是上游自带的 three.js 兼容 CPU 引擎，**没有**被替换成 three.js。

## 其它

- `src/world/Reef.js`（珊瑚礁）可以运行，但本游戏当前不提取礁石数据，烘焙脚本不调用它。
- 上游 `src/world/Terrain.js`、`TerrainGPU.js`、以及所有 `*.wgsl` 材质属于渲染层，本仓库不执行它们。
- 若将来更新上游：重新克隆对应 commit，覆盖 `src/`，然后按上面 3 处重新打补丁，再跑
  `node tools/bake-tidewater.mjs` 即可。数据契约不变则游戏侧无需改动。
