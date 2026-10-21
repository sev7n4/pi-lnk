# PR 草稿：fix(group): 修「节点在分组框外」+ 分组框 8 方向缩放

> 承接 #523（分组回归 vue-flow 原生父子节点形态）。本批修 #523 上线后用户实测报出的两个问题。

## 背景（用户实测原话）

> 选 2 个节点打组后，**节点还是在分组框外**，且**分组框不支持 8 个方向的拖拽可以拉伸或缩小分组框的大小（和本项目裁剪、扩图的行为一致）**。

## 改动 1：修「节点在分组框外」

**根因是渲染层，不是算法**（像素级 + 生产数据双向钉死）：

| 环节 | 实测 | 判定 |
|---|---|---|
| 生产落库 `groups[].size` | `{width: 560, height: 680}` | ✅ 算法算对、落库也对 |
| 截图框宽高比 | 5.39 | 与 870/160 = 5.44 吻合，与 870/680 = 1.28 不符 |
| 截图框高（÷ zoom 1.61） | ≈162 CSS px | ≈ `.group-node-container` 的 `min-height: 160px` |

机制：`.group-node-container` 是**空 div + 块级** ⇒ `width:auto` 撑满父容器（宽度看起来对，是假象）、`height:auto` 因内容高度为 0 塌到 `min-height:160px`（高度错）。框的真实尺寸由 vue-flow 写在**节点元素**上的 `style.width/height` 决定。

修法：`.group-node-container` 显式 `width:100% / height:100% / box-sizing:border-box`（`height` 写在 `min-height` 之后，同级后者覆盖前者）。

## 改动 2：分组框 8 方向缩放

**交互语义与本项目裁剪 / 扩图一致**（`refine/outpaintGeometry.ts` 同源）：4 角 + 4 边共 8 个手柄，只动该手柄所在边、**对边固定**，单边下限 160px。

**为什么不装 `@vue-flow/node-resizer`**：

- 官方插件群整体停在 1.x 早期（node-resizer **1.5.1** / background 1.3.2 / controls 1.1.3 / minimap 1.5.4 / node-toolbar 1.1.1），而 `@vue-flow/core` 已是 **1.48.2**（差 43 个大版本）；
- 且它走 `dimensions` change（`updateStyle:true`）通道写回，本项目是**受控模式**（`apply-default=false` + `nodes` ref 唯一真值 + `onNodesChange` 手工应用），`style` 才是权威 ⇒ 接它要另开一条写回通道。

⇒ **不新增依赖**，自建 8 手柄 UI + 纯函数几何。

### 分层

| 层 | 文件 | 职责 |
|---|---|---|
| 几何（纯函数） | `useCanvasGrouping.ts` | `resizeGroupByHandle` / `GROUP_HANDLE_DIRS` / `GROUP_HANDLE_MOVING_EDGES` / `GROUP_MIN_SIZE` |
| 手柄 UI | `CanvasNodeGroup.vue` | 8 手柄渲染 + 指针位移 ÷ zoom → 交回页面（⛔ 不直写 nodes） |
| 接线 | `CanvasPage.vue` | `handleGroupResize` → 写 `nodes` + 松手时落库 |

### 关键决策

- **缩放只改框、不动内容**：写 `style.width/height` + `position`；子节点**相对坐标**随框 origin 平移补偿 ⇒ **绝对位置逐个不变**。
- **缩放路径绝不调 `fitGroups()`**：那条通路的语义是「把框贴回子节点包围盒」（拖子节点 / 加载后用），缩放恰恰要脱离包围盒 ⇒ 调了等于立刻撤销用户的缩放。已加守卫锁死。
- **缩放期间不落库**：每帧一次 PUT 会冲垮 undo 栈与 IO ⇒ 只在「松手」信号（`delta === null`）时 `persistUserEdit()` 一次。
- **持久化格式零改动**：`foldGroups` 读 `groupNodeSize(g)` ⇒ 缩放后的尺寸自动进 `CanvasGroup.size`，`CanvasData.groups` 结构一行未动。
- **手柄带 `nodrag` + `nopan`**：vue-flow 官方 `noDragClassName` / `noPanClassName` 默认值（源码 filter 已核）⇒ 不会同时触发「整框拖动 + 画布平移」三个手势打架。
- **移动端无手柄**：页面把注入值置 `null`（与 GC4「移动端不拖分组框」同一口径）。注入用 `Ref<Fn|null>` 而非裸函数 —— 视口运行时会变，provide 一个值会锁死在 setup 那一刻。

## 校验

- `apps/web` `vue-tsc --noEmit` 零错误；`packages/agent` 自身 `tsc` 零错误。
- 定向 vitest：分组纯函数 41 + 组件 29 + 页面接线守卫 4，全绿。
- **变异自检（2 处）**：① 页面缩放路径注入 `fitGroups()` ⇒ 被页面守卫抓住；② 组件删掉 `se` 方向渲染 ⇒ 被「恰好 8 个手柄」+「按下 se 手柄」两条抓住。回滚已核验。
- `--neo-*` 棘轮**不变**（1513）—— 新增手柄全走 `--lnk-*` 令牌。

## Review Focus

1. `resizeGroupByHandle` 的 clamp 语义：只夹住「正在移动的边」，固定边不跳动。
2. 子节点相对坐标补偿：`shiftX = originX - west` / `shiftY = originY - north` ⇒ 子节点绝对位置逐个不变。
3. 页面 `handleGroupResize`：**只改框**、**不调 `fitGroups`**、**只在松手时落库**。
4. 手柄的 `nodrag` / `nopan`（vue-flow d3 filter 认这两个类名）。
5. 移动端：`groupResizeFn.value = mobile ? null : handleGroupResize`。

## 计划文档

`docs/superpowers/plans/2026-10-21-group-frame-size-and-resize.md`
