# Tidewater 地图数据契约（提取自上游 dgreenheck/tidewater）

本项目**不再手工重建 Tidewater**。地图的全部地形高度、遮罩、村落/码头/道具几何、岩石与植被布置
都由 `tools/bake-tidewater.mjs` 在 Node 中**直接运行上游开源代码**（`vendor/tidewater/`，MIT）生成，
产物提交进仓库，游戏在运行时只消费这些数据。

```
vendor/tidewater/            上游源码快照（commit 4811ba4）+ 3 处 headless 补丁，见 VENDOR.md
tools/bake-tidewater.mjs     烘焙脚本：node tools/bake-tidewater.mjs [--only=terrain,...]
data/tidewater/              烘焙中间产物（JSON，便于调试/校验）
shared/tidewater-baked.js    ★ 生成物，提交：同构（Node + 浏览器）共享的地形高度/碰撞/元数据
public/data/tidewater/geo.bin.gz  ★ 生成物，提交：仅浏览器使用的几何/遮罩/植被实例（gzip）
```

## 1. 坐标系

与上游完全一致：米制，y 向上，海平面 y = 0，海在南（+z），岛在北（−z），太阳东升西落。
本游戏直接使用上游世界坐标，不做平移/缩放。

可玩区域（烘焙窗口）`region = { x0:-182, z0:-232, size:384, res:385, texel:1 }`：
`x ∈ [-182, 202]`，`z ∈ [-232, 152]`，1 m 采样，`res = size + 1 = 385` 个采样点（含两端）。

## 2. `shared/tidewater-baked.js`（生成，同构，约 0.5 MB）

```js
export const BAKED = {
  source: { repo, commit, license },
  region: { x0, z0, size, res, texel },
  heights: { b64, type: 'i16', scale },       // row-major: index = j*res + i, i 沿 x, j 沿 z
  heightAt(x, z),                              // 双线性采样，窗口外 clamp 到边缘
  colliders: {
    boxes: [{ x, y, z, hx, hy, hz, rotY, walkable, tag }],   // 与上游 Colliders.addBox 同参
    cylinders: [{ x, z, r, yMin, yMax, tag }],
  },
  meta: { pier, village, buildings, footprints, paths, lights, spawn, start },
  spawns: [{ x, z, y, yaw, tag }],             // 已按地形/碰撞校正落点
};
export function heightAt(x, z);                // 同 BAKED.heightAt
export function normalAt(x, z, out);           // out: {x,y,z} 或三分量数组
```

上游 `heightAt` 对窗口外返回 −90；本模块对窗口外先 clamp 到窗口边缘再采样（游戏边界本身由 BOUNDARY 限制）。

## 3. `public/data/tidewater/geo.bin.gz`（生成，仅浏览器）

gzip 压缩的二进制容器，布局：

```
magic  'TDW1'           4 bytes ASCII
u32    headerLen
bytes  header            UTF-8 JSON，形如下
bytes  payload           所有 buffer 顺序拼接
```

### header

```jsonc
{
  "version": 1,
  "region": { "x0": -182, "z0": -232, "size": 384, "res": 385, "texel": 1 },
  "buffers": [
    { "name": "village_pos", "type": "i16", "count": 208530, "byteOffset": 0, "byteLength": 1251180 },
    ...
  ],
  "meshes": [
    {
      "name": "village",
      "kind": "village",            // village | debris | rockProto
      "attrs": {                    // 属性名 → { buffer, size, scale }（解码后 = raw * scale）
        "position": { "buffer": "village_pos", "size": 3, "scale": 0.015625 },
        "normal":   { "buffer": "village_nrm", "size": 3, "scale": 0.0078740157 },
        "uv":       { "buffer": "village_uv",  "size": 2, "scale": 0.03125 },
        "tint":     { "buffer": "village_tint","size": 3, "scale": 0.0078431373 },
        "vdata":    { "buffer": "village_vdata","size": 4, "scale": 0.0009765625 }
      },
      "indices": { "buffer": "village_idx", "type": "u32" },
      "vertexCount": 208530,
      "groups": [ { "slot": "wood", "start": 0, "count": 293790 }, ... ],  // drawRange，单位=索引
      "bounds": { "min": [x,y,z], "max": [x,y,z] }
    }
  ],
  "rockProtos": [ { "style": 0, "lod": 0, "name": "rocks-boulder-near", "mesh": "rock0_near" } ],  "rockInstances": {
    "buffer": "rock_mtx", "type": "f32", "stride": 16, "count": 714,
    "styles": [ { "style": 0, "name": "boulder", "count": 227 }, ... ]
  },
  "vegetation": {
    "types": ["palms", "trees", "bananas", "shrubs", "youngPalms", "ferns",
              "monsteras", "elephantEars", "heliconias", "strelitzias", "villagePalms"],
    "buffer": "veg_rec", "type": "f32", "stride": 10, "count": 4539
    // [typeIdx, x, y, z, scale, scaleY, yaw, seed, height, leaf] 每 10 个 f32 一条记录
  },
  "masks": [
    { "name": "rock", "buffer": "mask_rock", "type": "u8", "res": 385 },
    { "name": "sand" }, { "name": "path" }, { "name": "gully" },
    { "name": "seagrass" }, { "name": "rubble" }, { "name": "scarp" }
  ],
  // 远景整岛高度：8 m 网格，覆盖可玩窗口外侧（x ∈ [-560, 720]，z ∈ [-640, 640]），
  // 渲染层用它铺窗口外的地形，避免 384 m 窗口边缘在山脊上出现断崖。
  "island": {
    "buffer": "island_h_i16", "type": "i16", "scale": 0.01,
    "x0": -560, "z0": -640, "size": 1280, "texel": 8, "res": 161
  },
  "shore": { ... }   // 可选：浅海深度场，暂不使用
}
```

### 属性量化约定

| 属性 | 类型 | scale | 说明 |
| --- | --- | --- | --- |
| position | i16 | 1/64 | 精度 1.6 cm，范围 ±512 m |
| normal | i8 | 1/127 | 单位法线三通道 |
| uv | u16 | 1/32 | 与上游一致，含「端面 offset 1000」编码（3.1 cm 精度） |
| tint | u8 | 2/255 | 上游 tint 可超过 1（最亮 1.35），按 0..2 量化 |
| vdata | i16 | 1/1024 | [paint/seed, patternOffset, patternId(0..9), metal] |
| ao | u8 | 1/255 | 岩石原型 |
| index | u32 | — | 顶点数 > 65535 |

### 材质槽（`groups[].slot`）

`wood` `hard` `roofMetal` `thatch` `stone` `fabric` `net`（村庄），`debris`（瓦砾），
`rock`（岩石原型）。客户端按槽选择材质/着色分支；不要假设 slot 顺序。

## 4. 上游语义（供渲染实现参考）

- `tint` = 基础色（含随机化/彩绘）；`vdata[0]`≈漆面磨损/木纹种子，`vdata[1]`≈图案偏移，
  `vdata[2]` = 图案 ID（0=无，1..9 见上游 `villageMaterialModule`），`vdata[3]`≈金属度/粗糙度。
- `uv` 以米为单位平铺，`uv.x >= 1000` 表示端面（端面纹理偏移 1000）。
- 岩石原型属性 `ao` 是烘焙的环境光遮蔽，需要乘到间接光上。
- 高度遮罩：`rock`(0..1) `sand` `path` `gully` `seagrass` `rubble` `scarp`（0..255 → /255）。

## 5. 已知取舍

- 只提取**静态地图数据**。上游的 WebGPU 渲染器/DWGSL 材质、海面 FFT、鱼群/鲸鱼/海鸟、
  船与角色、粒子特效**不提取**；本游戏保留自己的 three.js 渲染管线、天空、海洋与后期。
- 礁石珊瑚（7362 株/区域 4.2 万）暂不提取（水下、本游戏不可到达）。
- 植被提取**布置记录**（位置/朝向/缩放/种类），客户端用本项目的简化原型渲染。
