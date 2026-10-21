# PC 分组框：修复「节点在框外」+ 新增 8 方向缩放

> 日期：2026-10-21 · 分支 `fix/group-parent-size-and-resize` · 基线 `origin/master` = `6db11100`
> 承接 #523（分组回归原生节点形态）。本批修 #523 上线后用户实测报出的两个问题。

## Goal

1. **修「节点在分组框外」**：用户实测打组后两个图片节点明显溢出虚线框下方。
2. **新增 8 方向缩放**：分组框支持四边 + 四角拖拽拉伸/缩小，交互语义与本项目
   裁剪 / 扩图（`outpaintGeometry.ts` 的 `HANDLE_DIRS` / `HANDLE_MOVING_EDGES`）一致。

## Architecture

### 根因（已像素级 + 生产数据双向钉死，非猜测）

**问题 1 的根因是渲染层，不是算法。**

证据链：

| 环节 | 实测 | 判定 |
|---|---|---|
| 生产落库 `groups[].size` | `{width: 560, height: 680}` | ✅ 算法算对、落库也对 |
| 截图框的宽高比 | 5.39 | 与 870/160 = 5.44 吻合，与 870/680 = 1.28 不符 |
| 截图框高（÷zoom 1.61） | ≈162 CSS px | ≈ `.group-node-container` 的 `min-height: 160px` |
| 截图框宽（÷zoom 1.61） | ≈870 CSS px | ✅ 与计算值一致 |

⇒ 框的**高度塌成了 `min-height`**，宽度却是对的。

机制（`neo-node.css` 的 `.group-node-container`）：

```css
.group-node-container {
  min-width: 280px;
  min-height: 160px;
  /* ⛔ 没有 height: 100% */
  padding: 12px;
}
```

- `.vue-flow__node` 拿到 `node.style = { width: '870px', height: '680px' }`
  （vue-flow `getStyle` 把 `node.style` 展开到节点元素 style，已核源码）。
- 我们的 `CanvasNodeGroup.vue` 根元素 `.group-node-wrapper` 有 `width: 100%; height: 100%`，
  所以 wrapper 确实是 870×680。
- 但 `.group-node-container` 是**块级空 div**：
  - **宽度** = `auto` ⇒ 撑满父容器 ⇒ 看起来对（假象）；
  - **高度** = `auto` ⇒ 内容为空 ⇒ 塌到 `min-height: 160px` ⇒ **错**。

⇒ **修法：`.group-node-container` 补 `height: 100%`。**
（`width` 也显式写 `100%`，避免以后改成 flex/grid 时宽度也塌。）

**问题 2 的现状**：分组框完全没有缩放手柄。

### 为什么不装 `@vue-flow/node-resizer`

用户要求「优先复用开源社区生态、不重复造轮子」。已查证官方插件群：

| 包 | 最新版 | 我们的 core |
|---|---|---|
| `@vue-flow/core` | 1.48.2 | — |
| `@vue-flow/node-resizer` | **1.5.1** | peer 要求 `^1.23.0` |
| `@vue-flow/background` | 1.3.2 | — |
| `@vue-flow/controls` | 1.1.3 | — |
| `@vue-flow/minimap` | 1.5.4 | — |
| `@vue-flow/node-toolbar` | 1.1.1 | — |

⇒ 官方插件群**整体停在 1.x 早期**，与 core 差 43 个大版本。且其写回通道是
`dimensions` change（`updateStyle: true`），而本项目是**受控模式**（`apply-default=false`，
`nodes` ref 为唯一真值 + `onNodesChange` 手工应用），`dimensions` 通道与我们的
`style` 权威模型不吻合，接入需另开一条写回路径 —— 属于「引入新依赖 + 自造适配层」，
比自建 8 个手柄更重、更易碎。

⇒ **决策：复用 vue-flow 原生的节点交互模型（父子节点 + 拖拽语义）+ 项目已有的
8 方向几何常量**（`apps/web/src/components/canvas/refine/outpaintGeometry.ts` 的
`HandleDir` / `HANDLE_DIRS` / `HANDLE_MOVING_EDGES`），在 `CanvasNodeGroup.vue` 内
自建手柄 UI。**不新增依赖，不改持久化格式。**

### 数据流（不变）

```
持久化  CanvasData.groups + 子节点绝对坐标
   ↓ materializeGroups()  加载时物化
运行态  group 节点（type:'group'，style.width/height = 框尺寸）
        + 子节点 parentNode/extent/expandParent + 相对坐标
   ↓ foldGroups()  保存时折叠
持久化  CanvasData.groups + 子节点绝对坐标
```

`size` 已经是 `CanvasGroup` 的既有字段（生产落库实测 `{width:560,height:680}`），
缩放后的尺寸直接写回 `style` ⇒ `foldGroups` 自动带进 `size` ⇒ **持久化格式零改动**。

### 缩放语义（与裁剪 / 扩图一致）

对齐 `outpaintGeometry.ts` 的核心约定：

- 8 个手柄：`nw n ne e se s sw w`（4 角 + 4 边）。
- **只移动该手柄所在的边，对边固定**（`HANDLE_MOVING_EDGES`）。
- 单边下限：不得小于 `GROUP_MIN_SIZE`（框不能缩到比最小尺寸还小）。
- 缩放**只改框**（`style.width/height` + `position`），**不动子节点绝对位置**。
  子节点相对坐标随框的新 origin 平移，保证「子节点在屏幕上的绝对位置不变」。
  ⇒ 这正是「框是容器、子节点是内容」的语义，与裁剪/扩图「内容不动、框变」一致。

⚠️ 与 vue-flow `expandParent` 的冲突：`expandParent: true` 时 vue-flow **不**做
`extent: 'parent'` 约束（已核源码 `getExtent`：`!item.expandParent` 才约束），
所以缩放框不会把子节点挤出去 —— 两者不打架。

## Tech Stack

- Vue 3 `<script setup>` + TypeScript（`strict`）
- `@vue-flow/core` 1.48.2（**不新增依赖**）
- Vitest（单元 + 源码扫描守卫）
- 设计令牌：`--lnk-*`（新代码**零** `--neo-*` 消费）

## Spec

### S1 `.group-node-container` 撑满父高（修问题 1）

`neo-node.css`：

```css
.group-node-container {
  width: 100%;
  height: 100%;   /* ⭐ 新增：块级空 div 高度 auto 会塌到 min-height */
  ...
}
```

守卫（`CanvasNodeGroup.test.ts`，源码扫描口径，**剥注释**）：
- `.group-node-container` 必须同时含 `width: 100%` 与 `height: 100%`。

### S2 缩放几何纯函数（`useCanvasGrouping.ts`）

```ts
export type GroupHandleDir = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
export const GROUP_HANDLE_DIRS: GroupHandleDir[] = ['nw','n','ne','e','se','s','sw','w']
export const GROUP_HANDLE_MOVING_EDGES: Record<GroupHandleDir, {west,east,north,south: boolean}>
export const GROUP_MIN_SIZE = 160   // 框最小边长

/** 按手柄方向缩放分组框：只动该手柄所在边，对边固定；子节点绝对位置不变。 */
export function resizeGroupByHandle(
  nodes: FlowNode[], groupId: string, dir: GroupHandleDir, delta: {dx:number; dy:number}
): FlowNode[]
```

契约：
- 目标不是 group 节点 / 无子节点 ⇒ 原样返回（幂等，零扰动）。
- 缩到 `GROUP_MIN_SIZE` 以下 ⇒ 该轴 clamp 到下限。
- 子节点**绝对位置逐个不变**（相对坐标随 origin 平移补偿）。
- 框尺寸写回 `style.width/height`（字符串 px），`position` 随 origin 变化。
- 结果不写 `dimensions`（受控模式下 `style` 才是权威）。

### S3 手柄 UI（`CanvasNodeGroup.vue`）

- 8 个手柄，仅在**该分组被选中**时显示（与「选中才出现操作点」的常规一致）。
- 手柄 `position: absolute`，落在框的 4 边 + 4 角；`pointer-events: auto`。
- 手柄按下时**必须阻止画布平移 / 节点拖动**（`stopPropagation` + `nodrag` 类）。
- 拖动中用 `delta` 调 `resizeGroupByHandle`，通过 `inject` 的回调把结果交回
  `CanvasPage`（组件不直接改 `nodes` —— `nodes` 是页面级单一真值）。
- 手柄视觉走 `--lnk-*` 令牌，**零 `--neo-*`**。

### S4 页面接线（`CanvasPage.vue`）

- `provide` 一个 `CANVAS_GROUP_RESIZE_KEY` 回调：`nodes.value = resizeGroupByHandle(...)`。
- 缩放结束（pointerup）时 `persistUserEdit()`（落库 `size`）。
- 移动端沿用现状：**不显示缩放手柄**（与「移动端不拖框」一致）。

## Global Constraints

- **持久化格式零改动**（`CanvasData.groups` 结构、`CanvasGroup` 类型、server 侧一律不动）。
- **不新增 npm 依赖**。
- 新代码 **零 `--neo-*` 消费**；`--neo-*` 棘轮基线只许减不许增（若减少则同步下调）。
- 受控模式铁律：`nodes` ref 是唯一真值；组件**不得**直接改 `nodes`。
- 移动端不引入缩放手柄（避免与触屏手势冲突）。
- 分组**不支持嵌套**（沿用旧口径）。
- 本机 4 核：测试串行跑，不并行全量。

## Review Focus

1. **`.group-node-container` 的 `height: 100%` 是否会被 `box-sizing` 影响** — 项目未设全局
   `box-sizing: border-box`（已查 `apps/web/src/styles/*.css` 无 `box-sizing`），
   `.group-node-container` 有 `padding: 12px` + `border: 2px dashed` ⇒
   `height: 100%` 时**内容盒 100% + padding + border 会溢出 28px**。
   ⇒ 需 `box-sizing: border-box`（在同一条规则里显式声明）。
2. **缩放时子节点相对坐标的补偿**是否正确（绝对位置必须逐个不变）。
3. **`style` 权威 vs `dimensions`**：受控模式下不要让两条通道打架。
4. **手柄拖动不能触发画布平移**（`nodrag` + `stopPropagation`）。
5. **`foldGroups` 是否把缩放后的尺寸带进 `size`**（应自动带上，因为读的是 `style`）。
6. 移动端 `applyGroupDraggable` 的既有口径不要被改坏。

## Tasks

### Task 1 — RED：写 S1/S2 的断言
- [x] `CanvasNodeGroup.test.ts`：`.group-node-container` 必须有 `width: 100%` + `height: 100%` + `box-sizing: border-box`
- [x] `useCanvasGrouping.native.test.ts`：`resizeGroupByHandle` 的 12 条断言（8 方向 × 语义 + clamp + 幂等 + 非 group 目标）
- [x] 跑测试确认**红灯**（判据能真失败）

### Task 2 — GREEN：修 S1（CSS）
- [x] `neo-node.css` 改 `.group-node-container`
- [x] 跑测试转绿

### Task 3 — GREEN：实现 S2（缩放几何）
- [x] `useCanvasGrouping.ts` 加 `GroupHandleDir` / `GROUP_HANDLE_DIRS` / `GROUP_HANDLE_MOVING_EDGES` / `GROUP_MIN_SIZE` / `resizeGroupByHandle`
- [x] 跑测试转绿
- [x] **变异自检**：把「子节点绝对位置补偿」改成不补偿 ⇒ 必须变红

### Task 4 — S3：手柄 UI
- [x] `CanvasNodeGroup.vue` 加 8 手柄 + 拖拽逻辑
- [x] 新增 `CANVAS_GROUP_RESIZE_KEY`（放 `useCanvasGrouping.ts` 或独立 `canvasNodeActions.ts`）
- [x] `CanvasNodeGroup.test.ts` 加手柄存在性 / 方向覆盖 / `nodrag` / 零 `--neo-*` 断言
- [x] **变异自检**：删掉某个方向的渲染 ⇒ 必须变红

### Task 5 — S4：页面接线
- [x] `CanvasPage.vue`：`provide` 缩放回调 + 落库 + 移动端不显示手柄
- [x] 源码扫描守卫（`src/pages/CanvasPage.*.test.ts`）不得破

### 实施记录（2026-10-21）
- **Task 4 实现要点**：`CANVAS_GROUP_RESIZE_KEY` 放 `canvasNodeActions.ts`，注入类型是
  `Ref<CanvasGroupResizeFn | null>`（**不是裸函数** —— 视口运行时会变，provide 一个值会
  锁死在 setup 那一刻）。组件只做「指针位移 ÷ zoom → 交回页面」，⛔ 不直写 nodes。
  手柄带 `nodrag` + `nopan`（vue-flow 官方 `noDragClassName` / `noPanClassName` 默认值，
  源码 filter 已核）⇒ 不会同时触发「整框拖动 + 画布平移」。
- **Task 4/5 变异自检结果**：注入两个变异 —— ① 页面缩放路径加 `fitGroups()` ⇒ 被页面守卫
  抓住；② 组件删掉 `se` 方向渲染 ⇒ 被「恰好 8 个手柄」+「按下 se 手柄」两条抓住。
  回滚已核验（`fitGroups()` 不在缩放路径 / import 恢复 / `GROUP_HANDLE_DIRS_FULL` 已消失）。
- **本批踩坑（已入 memory）**：`Boolean(computedRef)` 恒为 true（对象都是真值）⇒
  `canResize` 必须写 `Boolean(resizeGroup.value)`；jsdom 事件坐标只读 ⇒ 用
  `new Event` + `defineProperty` 造 pointer 事件；本机 load 200+ ⇒ vitest 单文件 4–6 分钟，
  且常在 5 分钟处报 `[vitest-worker]: Timeout calling "onTaskUpdate"`（**环境噪音，非失败**）。

### Task 6 — 全量校验
- [x] `apps/web` `vue-tsc --noEmit` 零错误
- [x] 根 `pnpm build` 全绿
- [x] 定向 vitest 全绿
- [x] `--neo-*` 棘轮计数（若减少 ⇒ 同步下调基线）
- [x] `git status --short` 为空

### Task 7 — PR + 合并 + 部署
- [x] 推分支 + 开 PR（四必填项）
- [x] 盯 CI 三个 required check
- [x] squash 合并
- [x] 盯部署 + 生产取证
- [x] 清理 worktree / 远端分支

## 交付结果（2026-10-21 已上线）

- **PR #535** squash 合并 ⇒ master `39aff272`；CI 三个 check 全绿；部署 run `39551789106` success
  （`Build API on CVM` 被 paths 过滤 skipped —— 本批只改 web，符合预期）。
- **生产取证**（`/opt/lnkpi/web/dist/assets/`）：
  - `CanvasPage-BK2v0S6m.js` 内含 `class:xe(["group-resize-handle nodrag nopan",[`group-resize-handle--${N}`,...]])`、
    `"data-handle":N`、`"aria-label":`调整分组框尺寸 ${N}``；
  - `const I6=["nw","n","ne","e","se","s","sw","w"]`（3 处）+ `S6={nw:{west:!0,east:!1...`；
  - `CanvasPage-CTgc1ipQ.css` 内手柄规则 25 条（`var(--lnk-text-primary)` / `var(--lnk-accent)`）；
  - `index-BAfcD8SB.css` 内 `.group-node-container{...min-height:160px;width:100%;height:100%;box-sizing:border-box;...}`
    且 **height 在 min-height 之后**（min-height@114 < height:100%@142）。
- **对照判据**（防「本来就有的」误判）：`git show fa5baa32:…` 旧版无手柄、旧版 CSS 无
  `height:100%` / `width:100%` / `box-sizing` ⇒ 生产确实换上了新代码。
- ⭐ **取证坑（又一次印证）**：`group-resize-handle--${dir}` 是**运行时模板字符串**，
  产物里没有 `group-resize-handle--nw` 这种字面量 ⇒ 按方向名 grep 必然 0 命中，
  **不能据此判「没上线」**。正解：grep **属性名 / 中文文案 / 方向数组字面量**。
