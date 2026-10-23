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
- 返回 `{ [id]: {x,y} }`：仅受影响 id 的新位置；未选中节点返回空映射；
- **坐标口径（2026-10-23 落地审计订正）**：实现返回的是**局部坐标**（父相对；父节点偏移已在
  函数内扣除，见 `packages/shared/src/canvas/layout.ts` `alignNodes` 注释「返回**局部坐标**新位置
  （已减 parent 绝对偏移）」）—— 与本节原表述「返回绝对位置、调用方负责回填局部坐标」相反。
  ⇒ 以**实现口径为准**（局部坐标更安全：调用方直接写 `node.position` 即可，不需要再拿父偏移做
  反算，避免二次偏移 bug）；调用方 `applyArrangeLayout` 按局部消费，与既有 `applyLayoutOps`
  行为一致。本条只订正表述，**不改实现**。

### 6.2 `distributeNodes(nodes, ids, axis)`

- `axis ∈ 'x' | 'y'`；`ids.length < 3` → 直接返回空映射（no-op）；
- 按当前左缘（x）/ 上缘（y）排序；**首尾锚定不动**；
- 相邻包围盒**空隙相等**：解 `gap = (lastEdge - firstEdge - Σ其他宽度) / (n-1)`，
  中间节点依次落位使 `prevEdge + width + gap = curEdge`；
- 返回受影响中间节点的新位置映射（坐标口径同 §6.1：**局部坐标**，父偏移已扣除）。
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

---

## 14. R1 addendum（2026-10-23 实测反馈：「能用但不丝滑 / 被吸住 / 步阶太大」）

#554 上线后真机走查发现拖拽吸附手感缺陷。定位到**两条独立缺陷叠加**，本 addendum 记录裁决与修复口径；
§3/§6.3 的算法共识不变，以下为修正与增强。

### 14.1 缺陷 A：吸附几何用方框兜底估媒体节点尺寸（视觉根因）

- 现象：拖 16:9 视频节点靠近别节点时，视觉边还没贴线就被弹回一大截，guide 线悬在节点旁边。
- 根因：媒体节点真实尺寸随素材比例（`CanvasNodeVideo/Image` 的 displaySize：长边 320/280 包络），
  而 §6.3 依赖的 `getNodeSize` 在 `node.dimensions` 缺失时按 NODE_SIZES **方框**兜底
  （video 320×320）——而受控模式下 `onNodesChange` **整条丢弃** vue-flow 的
  `dimensions` 变更（ResizeObserver 实测 offsetWidth/Height），兜底永远生效。
- 裁决（D5）：**接入实测尺寸，但绝不进持久化 JSON**。web 侧维护非持久化
  `measuredNodeSizes` Map（dimensions 变更只填表、不置 changed）；`buildSnapCandidates`
  增 `opts.sizeOf` 注入点；CanvasPage 的 `snapSizeOf` 解析链 =
  实测 > `groupNodeSize`（分组框 style 权威）> `getNodeSize` 兜底。
  存储格式零改动（SP-A 纪律：只认 position/style）。

### 14.2 缺陷 B：prev 参考线无限粘滞 + 阈值不随缩放换算（手感根因）

- 现象：吸上后拖到哪都粘着（只有别的线更近才顶掉）；放大细看时 8px 吸入距离在屏幕上
  变成 16px 起跳的大步阶。
- 根因：旧实现 `if (!keepPrev && dist > radius) continue` 对 prev 线配对**不设距离上限**
  ——与 §6.3 规格「超出 snapRadius + hysteresis 才解除」相反；且 SNAP_RADIUS=8 是 flow
  坐标，未按 1/zoom 换算成屏幕空间。
- 裁决（D6）：
  1. **释放带**：prev 线在 `radius + hysteresis` 内保持，超出即脱钩（回归规格原文）；
  2. **切换余量**：挑战线需比 prev 线**近过 hysteresis 余量**才接管——防两条邻近线
     （相距几 px）中点附近鼠标微抖造成节点在两线间反复横跳；
  3. **屏幕空间阈值**：CanvasPage 传 `snapRadius: 8/zoom`、`hysteresis: 3/zoom`
     （SNAP_SCREEN_RADIUS / SNAP_SCREEN_HYSTERESIS）⇒ 任意缩放手感一致；
  4. 每帧成本：视口 rect 在拖拽中缓存（zoom 不变直接返回），免逐帧强布局。

### 14.3 回归守卫

- `layout.test.ts`：释放带脱钩 / 切换余量接管 / 迟滞窗口对称 / 阈值由调用方传入（zoom 无关）；
- `useCanvasGrouping.snapCandidates.test.ts`：sizeOf 注入后候选盒取实测值、实测盒决定命中；
- `CanvasPage.snapGuides.test.ts`：dimensions 捕获、zoom 换算、snapSizeOf 解析链、视口缓存
  （静态断言）；「prev 无限粘滞」的两条旧期望（9px 仍保持）按规格修正为释放带语义。

---

## 15. 落地审计（2026-10-23）

审计对象 = **SP-A**（`2026-10-20-agent-canvas-batch-layout-design.md`）+ **SP-B**（本规格）两个包。
方法 = **代码级逐条核对**（不采信台账声明；台账可能漏项或与实现漂移），基准 = `origin/master` @ `7fc3672f`。

### 15.1 SP-A 落地核对（§9 文件级改动 9 项 + §1.2 核心目标）

| 规格条目 | 代码证据 | 判定 |
|---|---|---|
| shared 放置内核 + 原语上移（§9-1） | `packages/shared/src/canvas/layout.ts`：`placeBatchNodes` / `snapToGrid` / `rectsOverlap` / `NODE_SIZES` / `getNodeSize` / `getAbsolutePosition` / `LayoutNode` 齐备 | ✅ |
| shared barrel 导出（§9-2） | `@lnkpi/shared` 转出 canvas 模块（web 与 server 两侧均可 import） | ✅ |
| Nest `canvas-layout.util.ts` 切 re-export（§9-3） | `apps/server/src/agent/canvas-layout.util.ts`：3 处 `from '@lnkpi/shared'` | ✅ |
| `addNodesBatch` 扩展：edges 同事务解析 + key 校验 + items cap + 放置内核（§9-4） | `agent-canvas-tools.service.ts`：`:76 BATCH_NODES_MAX=12`、`:929 addNodesBatch`、`:989 placeBatchNodes` | ✅ |
| controller DTO：+edges + `@ArrayMaxSize`（§9-5） | `agent-canvas-tools.controller.ts`：`:161 @ArrayMaxSize(BATCH_NODES_MAX)`、`:171-172 edges?: EdgeDto[]` | ✅ |
| pi-runtime `create_nodes_batch` + 单批上限（§9-6） | `services/pi-runtime/src/tools/canvas-write.ts`：`:1002` 工具定义、`:1044` 上限校验 | ✅ |
| tiering 常驻登记（§9-7） | `services/pi-runtime/src/tools/tiering.ts`：`:101 "create_nodes_batch"` | ✅ |
| 前端回合末视口分流（§9-8） | `CanvasPage.vue`：`:1738` 有新节点 `fitView({ nodes: newNodeIds, … })` / `:1740` 无新节点维持现状分支 | ✅ |
| prompt 点名 + contentHash 同步（§9-9） | `prompt-registry/rules/canvas_daily_ops.md:15`「多节点用 create_nodes_batch。」（12 字 ≤ 30） | ✅ |
| **§1.2 核心目标**：单建与批建同享一个内核 | `upsertMediaNode`(`:1076`) → `addNodesBatch`(`:1116`) → `placeBatchNodes`(`:989`) 链路成立 | ✅ |
| §8.2 登记的另两处旧网格公式 | `agent-canvas-tools.service.ts:1707`、`:2856`（`uploadMediaToCanvas` 等其他创建路径）仍在 | ✅ **有意不做**（§8.2 原文「本规格只替换 addNodesBatch 这一处……避免改动面静默扩大」，登记 §12） |

⇒ **SP-A 代码 100% 落地，无功能缺口**（台账另记有 3 处「计划不完备」的偏离与 1 处自身回归，均已在
`plans/2026-10-20-agent-canvas-batch-layout.md` 执行台账中登记并修正）。

### 15.2 SP-B 落地核对（§2.1 六项范围 + Task 1~10 + 生产）

| 规格条目 | 代码证据 | 判定 |
|---|---|---|
| shared 三原语（§2.1-1） | `layout.ts`：`alignNodes` / `distributeNodes` / `computeSnapGuides` | ✅ |
| 坐标变更走前端 canvas_command、**不新增** Nest HTTP op（§2.1-2 / §7） | `CanvasPage.vue` `handleArrangeNodes` 分支消费；Nest 侧无新 op | ✅ |
| pi 工具 `arrange_nodes` 扩 `mode: align/distribute`（§2.1-3） | `services/pi-runtime/src/tools/arrange-nodes.ts`：align/distribute 共 10 处 | ✅ |
| PC 工具条六向 + 等距按钮组（§2.1-4） | `MultiSelectToolbar.vue`（19 处）+ `MultiSelectToolbarOverlay.vue`（4 处） | ✅ |
| 移动端「更多」sheet（§2.1-5） | `MobileMultiSelectMoreSheet.vue`（18 处） | ✅ |
| 拖拽参考线（§2.1-6） | `GuideLines.vue` + `CanvasPage.vue` 接线 + `CanvasPage.snapGuides.test.ts` | ✅ |
| 生产上线 | web 入口 chunk / CanvasPage 分包含新特征；容器 `lnkpi-api:<sha>` healthy；**pi-runtime 生产镜像 = `pi-runtime:7471901a`，而 `7471901a` 正是 master 上 `services/pi-runtime` 的最新提交**（此后 master 未再动该目录）⇒ agent 通道在生产可用 | ✅ |
| 手感缺陷（R1） | §14 两处根因已修；5 项变异验证「改回即红」；用户真机确认 ok | ✅ |

⇒ **SP-B 代码与生产 100% 落地**。

### 15.3 三处未闭合（均**非功能缺失**）

| # | 缺口 | 性质 | 处置 |
|---|---|---|---|
| G1 | **真机走查清单 §1~§7 未确认**（对齐六向 / 等距分布 / 参考线基础行为 / 移动端一致 / agent 自然语言触发 / SP-A 回归 / 生产复测；用户仅确认了 §8 的手感 7 条） | **验收未闭环**（规格 §10 的「目视 + 生产复测」是 SP-B 的验收标准） | 待用户登录态 + 硬刷新执行 `2026-10-22-sp-b-align-guides-verify-checklist.md` |
| G2 | **本包 plan 的执行台账未回填**（checkbox 全为未勾选；SP-A 同类文档有完整台账 + 偏离记录） | 交付记录缺失 | 已回填（见 `plans/2026-10-22-sp-b-align-guides.md` 执行台账节） |
| G3 | **§6.1/§6.2 坐标口径表述与实现相反**（规格写「返回绝对位置」，实现返回局部坐标） | 文档口径漂移 | **以实现为准**（局部更安全：调用方直接写 `node.position`，无需反算父偏移），已订正规格表述，**不改实现** |

### 15.4 与 SP-A §12 路线图对齐（SP-B 之后的剩余包）

**SP-C 视口恢复**（viewport 入序列化 + loadSession 恢复 + 回合末无新节点分支的 fitView 劫持）/
**SP-D 连线校验**（isValidConnection + 服务端端点/环校验 + add_edge 去重）/
**SP-E 并发与暂存底座**（canvasVersion CAS + stage 透传 UI + 回合 checkpoint）/
**SP-F 分组深化+内核合一**（parentNode 序列化 + 分组折叠 + 前端布局实现迁入 shared）/
**SP-G 缓议池**（resize / z-order / 旋转 / 分页摘要 / 只读接口鉴权）。
SP-B 的 shared 原语是 SP-F「前端布局实现迁入 shared」的**前置依赖** ⇒ 该前置现已具备。
