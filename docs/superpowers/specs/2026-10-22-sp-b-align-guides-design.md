# SP-B 对齐与参考线 Implementation Design

> 本规格是 agent 画布布局能力缺口评审（`outputs/agent-canvas-layout-gap-review.html`）的
> P0 ⑥⑦ 与 P1 的落地规格，是 SP-A（`2026-10-20-agent-canvas-batch-layout-design.md`）的后续包。
> 设计决策已在 2026-10-22 与用户逐一拍板（见 §4）。

## 1. 目标与动机

缺口评审 G3/G4 实证：今天画布「防凌乱」基础设施 **agent 侧与用户侧同时缺失** ——

- 多选一排节点后，唯一的重排手段是「整理布局」下拉里的两个粗粒度模式（方阵 / 沿边拓扑），
  **无 align 六向、无 distribute、无拖拽智能参考线**；
- 用户拖拽排版时 1:1 跟手、拖拽中无任何对齐感知，松手才吸一次 20px 网格（见
  `apps/web/src/composables/useCanvasGrouping.ts:54 applySnapOnRelease`），只能凭眼睛瞄。

这被评审认定为「画布很凌乱」的最大交互来源。SP-B 把「多选精排」与「拖拽对齐感知」从无到有补齐：

- **align 六向 + distribute H/V**：纯函数入 `packages/shared/src/canvas/layout.ts`，
  agent 工具（`arrange_nodes` 扩 mode）与用户工具条**同源同内核**；
- **拖拽智能参考线**：拖拽中实时 8px 阈值边缘/中心吸附 + guide 线渲染，参考线优先于松手网格吸附。

## 2. 范围

### 2.1 本规格做

- 新增 shared 纯函数 `alignNodes` / `distributeNodes` / `computeSnapGuides`（§6）；
- **坐标类变更一律走前端 canvas_command 通道**（已核实：与 `arrange_nodes` / 分组三工具同铁律——
  CanvasPage 消费命令、用 shared 纯函数算坐标、`setNodes` 后 `persistUserEdit` 落库；
  直调 Nest 改库会被下一次 `saveCanvas` 整份覆盖，见 `CanvasPage.vue:2162` 注释）。故 **不新增
  Nest `applyLayoutOps` 的 HTTP op**：用户工具条与 agent 工具都下发同一 `arrange_nodes` canvas_command，
  `mode` 扩 `'align' | 'distribute'`，由前端执行器分支消费 shared 纯函数；
- pi 工具 `arrange_nodes` schema 扩 `mode: 'align' | 'distribute'` + 必填参数（不点名 prompt，靠 description 承载发现能力）；
- 桌面 `MultiSelectToolbar` 增加 align 六向 + distribute H/V 按钮组；
- 移动端 `MobileMultiSelectMoreSheet` 增加 align 六向（进「更多」sheet）；
- 拖拽参考线：拦截 vue-flow 拖拽位置变更，调 `computeSnapGuides` 实时吸附 + 渲染 guide 线。

### 2.2 明确不做（登记在 §11，不隐性扩范围）

- 标尺（ruler）、多参考线同时显示的间距标注（gap 数值）；
- agent 直传坐标（维持 HN1 纪律：坐标永远后端算）；
- 分组内对齐的特殊语义（组内 rearrange 已有 `arrange_nodes` 的 grid/along_edges，不在本包扩展）；
- resize 手柄 / z-order / 旋转（SP-G，缓议）；
- 滑块式微调 / 像素输入框。

## 3. 社区最佳实践吸收（不重复造轮子）

拖拽智能参考线是成熟问题，社区有经广泛验证的算法，本包**直接吸收其算法与常量，不重造**：

- **官方 React Flow「Helper Lines」示例**（xyflow 团队，MIT；其文档明确写
  "copy the types.ts, utils.ts, config.ts, useHelperLines.tsx and HelperLinesRenderer.tsx
  files to your own project"）。核心算法已被 langflow、manta 等多个生产项目采用。
- **关键算法共识（本包逐条采用）**：

  1. **Anchor 模型**：每个节点有 6 个锚点 `top / bottom / left / right / centerX / centerY`，
     分属 `horizontal` / `vertical` 两个朝向。吸附 = 被拖节点某锚点对齐到候选节点同朝向锚点。
  2. **单方向取最近线**：每个朝向（水平/垂直）在阈值内**只显示一条** guide —— 取距离被拖
     节点锚点最近的候选锚点。多个节点同时进入阈值时不会刷屏（React Flow 官方要点）。
  3. **hysteresis 防抖（0.5px）**：一旦吸附，需超出 `SNAP_RADIUS + 0.5` 才解除，避免拖拽
     临界点 guide 闪烁/位置抖动（manta `useHelperLines` 实证）。
  4. **视口缩放无关**：guide 坐标在 flow（画布）坐标系计算，渲染时经 vue-flow 的
     viewport transform/scale 投到屏幕 —— 缩放/平移后 guide 仍精确（React Flow 官方要点）。
  5. **空间索引 / 候选裁剪**：大画布性能护栏 = 只把**视口内节点**纳入候选，且用排序数组做
     区间检索（manta `SpatialIndex`）；跳过被拖节点自身与其父节点（父子同批移动不该互相吸）。

- **移植方式**：纯几何算法（`computeSnapGuides` + 锚点解析）进 `packages/shared/src/canvas/layout.ts`
  （框架无关、可单测、与 align/distribute 同层）；Vue 渲染与拖拽拦截（hook + guide 渲染组件）
  在 `apps/web` 内以 Vue 惯用写法移植官方算法的**等价数学与常量**（SNAP_RADIUS=8、hysteresis=0.5、
  6 锚点、单方向最近线），**不照搬 React 组件**，但算法行为一致。
- **内部复用**：尺寸一律走既有 `getNodeSize` / `getAbsolutePosition`（SP-A 已上移），
  不重造节点包围盒计算。

## 4. 设计决策（2026-10-22 拍板）

| # | 议题 | 决定 |
|---|---|---|
| D1 | SP-B 是否含 agent 侧对齐 | **含**：给 `arrange_nodes` 扩 `align`/`distribute` 模式，走 `applyLayoutOps` 通道；prompt 不点名，靠工具 description 承担发现能力（零 L6 预算成本，先例同分组三工具） |
| D2 | align/distribute 基准口径 | **标准 Figma 口径**：六向 = 左缘/水平中/右缘、上缘/垂直中/下缘；distribute = 相邻包围盒**空隙相等**（Figma "distribute spacing"），首尾锚定 |
| D3 | 拖拽参考线形态 | **边缘 + 中心 6 锚点吸附**，阈值 8px，guide 线渲染；**参考线优先于松手 20px 网格吸附**（共存不叠加） |
| D4 | 移动端 | 对齐六向进「更多」sheet（复用 shared 原语）；参考线通用（触控拖拽同样生效） |

## 5. 架构总览

```
┌─ packages/shared/src/canvas/layout.ts ─────────────────────┐
│  alignNodes(nodes, ids, mode)       纯函数（Figma 六向）    │
│  distributeNodes(nodes, ids, axis)  纯函数（等空隙 gap）    │
│  computeSnapGuides(dragBox, cands, opts)  纯函数（参考线）   │
│  getNodeSize / getAbsolutePosition（SP-A 既有，复用）        │
└─────────────────────┬───────────────────┬──────────────────┘
                      │ import             │ import
        ┌─────────────┴──────┐   ┌─────────┴──────────┐
        ▼                    ▼   ▼                     ▼
  CanvasPage 执行器       arrange_nodes      apps/web MultiSelectToolbar
  （消费 shared 纯函数）    工具扩 mode        + MobileMultiSelectMoreSheet
  用户/agent 同 canvas_command          │
  │                                     │
  └──────────────┬──────────────────────┘
                 ▼
          拖拽拦截（onNodesChange）
          调 computeSnapGuides
          + GuideLines 渲染组件
```

三层共享同一份几何内核：**用户工具条**与 **agent 工具**走同一条前端 `arrange_nodes` canvas_command
（与现有「整理布局」下拉、分组三工具同构——坐标变更必须前端执行，避免被 `saveCanvas` 整份覆盖）；
**拖拽参考线**是纯前端实时层，同样消费 shared 纯函数，不进 HTTP 通道。

## 6. 原语规格（shared/canvas/layout.ts 扩展）

所有函数框架无关、确定性、可单测；尺寸统一经 `getNodeSize`/`getAbsolutePosition`。

### 6.1 `alignNodes(nodes, ids, mode)`

- `mode ∈ 'left' | 'centerH' | 'right' | 'top' | 'centerV' | 'bottom'`
- 取 `ids` 的节点的**绝对包围盒**（含 parentNode 偏移，用 `getAbsolutePosition` + `getNodeSize`）；
- 计算基准值：
  - `left` → 选中集最小左缘；`right` → 最大右缘；`centerH` → 选中集水平中心（bbox 中心）或各节点中心平均（取 bbox 中心，直觉稳定）；
  - 垂直三向同理（上缘 / 下缘 / 垂直中心）；
- 返回 `{ [id]: {x,y} }`：仅受影响 id 的新**绝对位置**；未选中节点返回空映射；
- 无 parent 节点则绝对=局部，调用方负责回填局部坐标（与 `applyLayoutOps` 既有做法一致）。

### 6.2 `distributeNodes(nodes, ids, axis)`

- `axis ∈ 'x' | 'y'`；`ids.length < 3` → 直接返回空映射（no-op）；
- 按当前左缘（x）/ 上缘（y）排序；**首尾锚定不动**；
- 相邻包围盒**空隙相等**：解 `gap = (lastEdge - firstEdge - Σ其他宽度) / (n-1)`，
  中间节点依次落位使 `prevEdge + width + gap = curEdge`；
- 返回受影响中间节点的新绝对位置映射；
- 与 D2 一致：是"等空隙"而非"等中心距"（窄节点旁不会显松）。

### 6.3 `computeSnapGuides(dragBox, candidateBoxes, opts)`

- `dragBox: {x,y,w,h}`（被拖节点**实时绝对**包围盒）；
- `candidateBoxes: {id, box:{x,y,w,h}, parentId?}[]`（**调用方已限视口内**，性能护栏在外层）；
- `opts: { snapRadius=8, hysteresis=0.5, prev?: {horizontal?, vertical?} }`；
- 算法（吸收 §3）：每个节点 6 锚点（top/bottom 属 horizontal；left/right 属 vertical；
  centerX 属 vertical；centerY 属 horizontal）；
- 对每个朝向，在被拖节点 6 锚点 × 候选 6 锚点中，找**同朝向、距离最小且 ≤ snapRadius** 的配对；
  每个朝向只取一条最近线（单方向取最近线）；
- hysteresis：若 `prev` 该朝向已有命中且当前距离 ≤ `snapRadius + hysteresis`，保留原线不切换
  （去抖）；
- 返回：
  ```
  {
    horizontal?: { position, sourceNodeId },  // 屏幕需画的水平 guide（flow 坐标 y）
    vertical?:   { position, sourceNodeId },  // 垂直 guide（flow 坐标 x）
    snapped: { x, y }                          // 被拖节点吸附后的新左上角
  }
  ```
- 若无任何命中，`snapped` 返回原 `dragBox` 左上角，guide 字段缺失。

## 7. 派发通道（前端 canvas_command，与 arrange_nodes / 分组工具同铁律）

> 已回代码核实（`CanvasPage.vue:2162`）：坐标类变更必须在前端执行——画布活动态 `nodes.value`
> 是真相源，走 Nest 改库会被下一次 `saveCanvas` 整份覆盖。故 align/distribute **不新增 HTTP op**，
> 复用既有 `arrange_nodes` canvas_command，由前端执行器分支消费 shared 纯函数。

### 7.1 前端执行器分支（CanvasPage + useCanvasGrouping）

- `useCanvasGrouping.applyArrangeLayout` 的 `ArrangeMode` 联合扩 `'align' | 'distribute'`，
  新增 `AlignRequest { nodeIds; mode:'align'; alignMode: AlignSixWay }` 与
  `DistributeRequest { nodeIds; mode:'distribute'; axis:'x'|'y' }`；
- 分支：`align` → 调 shared `alignNodes(nodes, ids, alignMode)`；`distribute` → 调
  `distributeNodes(nodes, ids, axis)`；结果与 `grid`/`along_edges` 同处理：`setNodes` +
  `persistUserEdit` + 自动聚焦；
- `handleArrangeNodes`（CanvasPage:2166）payload 联合扩为四 mode，按 mode 派发到对应纯函数。

### 7.2 pi 工具 `arrange_nodes` 扩 mode

- `services/pi-runtime/src/tools/arrange-nodes.ts` schema 扩：
  `mode: enum['grid','along_edges','align','distribute']`，选 `align` 时必填 `align_mode`，
  选 `distribute` 时必填 `axis`；canvasCommand 仍 `type:'arrange_nodes'`（`AgentSideRail` 透传）；
- **不进 prompt-registry 点名**：description 承担发现能力（先例分组工具），零 L6 预算成本；
  `tiering.test.ts` 归属登记（现有 `ui_command` tier）；
- 维持 HN1：agent 仍不传坐标，`align_mode`/`axis` 由模型给语义、坐标前端算；
- `AgentSideRail.vue` 的 `ArrangeRequest` 类型与 `emit('arrangeNodes')` 同步扩联合。

## 8. 用户侧 UI

### 8.1 桌面 `MultiSelectToolbar.vue`（691 行现状）

- 在现有「打组/解组/整理布局/批量生成/复制/删除」后增设 **align 六向 + distribute H/V**
  按钮组（图标用既有 `src/assets/icons/*.png` mask 资产风格，颜色走 design-token，禁新增 hex）；
- 点击 → emit `align` canvas_command（与整理布局同通道：`MultiSelectToolbar` 的 `layout` emit
  经 `handleLayoutSelection` → `handleArrangeNodes`，align 走同构的 `handleAlignNodes`），
  前端用 shared 纯函数算完 `setNodes` + `persistUserEdit`；
- 守卫：先跑 `design-token.test.ts` + `theme-usage.test.ts`（AGENTS.md 前端铁律）。

### 8.2 移动端 `MobileMultiSelectMoreSheet.vue`

- align 六向（distribute 移动端低频，可只放六向）进「更多」sheet，复用同一 `applyLayoutOps`。

### 8.3 拖拽参考线接线（核心拦截点）

- 复用现有受控模式：`apps/web/src/pages/CanvasPage.vue` 的 `onNodesChange`（line 1960，
  拖拽中 vue-flow 逐 tick 发 position 变更）是**唯一实时拦截点**；
- 在其中 `position` 分支：若当前处于节点拖拽（有 `dragStartPositions`），对**被拖节点**
  调 `computeSnapGuides`（候选 = 视口内其他节点绝对包围盒），用 `snapped` 覆盖该节点位置，
  并把 `horizontal`/`vertical` 写入 guide 渲染状态；
- 新增 `GuideLines.vue` 渲染组件：以 flow 坐标画全幅水平/垂直线（design-token 颜色，
  经 viewport transform 投射，缩放无关 —— 见 §3.4）；
- `onNodeDragStop`（line 2046）：**参考线优先** —— 若本帧拖拽有 guide 命中，则跳过现有
  `applySnapOnRelease`（20px 网格），否则维持原网格吸附逻辑（共存不叠加）；之后 `fitGroups()`
  + `persistUserEdit()` 不变；
- 拖拽开始（`onNodeDragStart`）重置 guide 状态。

## 9. 性能护栏

- 候选节点由调用方在 `onNodesChange` 内按**当前视口四至 + 边距**裁剪（大画布不遍历全量）；
- 可选：把候选锚点预排序存结构（manta `SpatialIndex` 思路），本包先采纳"视口裁剪 + 线性扫描"
  即可（候选量已被视口约束）；若实测大画布掉帧，再上排序索引（登记 §11 后续）；
- `computeSnapGuides` 纯函数、零副作用，可脱离渲染每帧高频调用。

## 10. 变更影响面与同步矩阵

- **改 `useCanvasGrouping` 的 `ArrangeMode` 联合 + `handleArrangeNodes` payload 联合** ⇒
  既有 `useCanvasGrouping.arrange.test.ts` 须全绿 + 新增 align/distribute 分支用例；
- **改 `arrange_nodes` schema** ⇒ `services/pi-runtime/src/tools/tiering.test.ts` 登记
  + `arrange-nodes.test.ts` 扩 mode 校验用例；
- **改 `MultiSelectToolbar` / `MobileMultiSelectMoreSheet` 样式** ⇒ design-token + theme-usage 守卫；
- **新增 shared 纯函数** ⇒ 既有 `packages/shared` `layout.ts` 测试须全绿 + 新增金样；
- 不触碰 prompt-registry（align/distribute 不点名，绕过 AGENTS.md §同步矩阵的 6 处同步）。

## 11. 后续 / 关联登记

- 本包完成缺口评审的 **G3（对齐能力全军覆没）+ G4（拖拽无感知）** 两条核心缺口；
- 标尺、间距数值标注、resize/z-order/旋转 → 留在 SP-G（缓议池）；
- 大画布空间索引优化 → 本包留口（§9），按需升级；
- 与 SP-A §12 路线图对齐：SP-B 完成后剩 **SP-C 视口恢复 / SP-D 连线校验 / SP-E 并发与暂存 /
  SP-F 分组深化+内核合一 / SP-G 缓议池**；SP-B 的 shared 原语是 SP-F「前端布局实现迁入 shared」的
  前置依赖。

## 12. 测试与守卫

| 层 | 用例 |
|---|---|
| packages/shared | `alignNodes` 六向 × 混排尺寸（text/image/video）× 含 parentNode 偏移；`distributeNodes` 等空隙数学（n≥3、n<3 no-op、首尾锚定）；`computeSnapGuides` 6 锚点命中/未命中/单方向最近线/hysteresis/跳过自身与父 |
| apps/web | `useCanvasGrouping.applyArrangeLayout` 扩 `align`/`distribute` 分支（既有 3 处 arrange 用例同绿）；`handleArrangeNodes` payload 联合；`MultiSelectToolbar` align 按钮触发命令；`GuideLines` 渲染；`MobileMultiSelectMoreSheet` 六向入口；design-token + theme-usage 守卫必跑 |
| services/pi-runtime | `arrange_nodes` schema 校验（mode×必填参数）+ `tiering.test.ts` 归属登记 |
| apps/web | `MultiSelectToolbar` align 按钮触发 `applyLayoutOps`；`GuideLines` 渲染；`MobileMultiSelectMoreSheet` 六向入口；design-token + theme-usage 守卫必跑 |
| 全局 | `pnpm build` 六包全绿；`vue-tsc --noEmit`（改 .vue 后必跑，AGENTS.md 铁律） |

## 13. 配图规范自检

本规格无 SVG 附件、无 Mermaid 图（§5 框图为 ASCII，不参与 `verify-spec-figures` 扫描）。
如需补 Mermaid 架构图，后续补并跑 `pnpm verify-spec-figures --file <本文件>`。
