# 移动端画布节点连线手柄修复 — 规格 + 实施计划

> 关联缺陷：`MobileCanvasEdge.css:15` 自注"锚点退化（MobileNodeTile 无 Handle）…属 P3"。
> 日期：2026-11-10 ｜ 状态：待评审（方案，未实施）

## 0. 配图索引

- 图 1 · PC 与移动端节点渲染树差异（根因）
- 图 2 · 修复后移动端节点连线锚点结构

## 1. 问题复述（根因）

用户在移动端看到的画布节点：没有像 PC 一样的"hover 显示左右两侧圆形 + 手柄"；且连线看起来从节点**上下/中心**走，而不是 PC 那样"从 A 右 → B 左"。

代码实证：

- `NodeRenderer.vue:40-42` 在移动端把节点组件切成 `MobileNodeTile`（PC 走 `CanvasNodeImage/Video/...` → 内部包 `NeoBaseNode`）。
- `MobileNodeTile.vue → NodeTileView.vue` 通篇**没有任何 `<Handle>`**（仅 `import getNeoNodeMeta` 取图标/标题），所以移动端节点上既无左右圆形 + 号，也没有可被 VueFlow 识别的连接锚点。
- PC 的手柄在 `NeoBaseNode.vue:272-295`：`id="target"`（`Position.Left`）+ `id="source"`（`Position.Right`），带 `handle-plus` 圆形 + 号；显隐由 `showHandles = selected || isHovered`（`NeoBaseNode.vue:109`）控制。
- 移动端节点没有这些 `Handle` 元素 ⇒ VueFlow 找不到 `sourceHandle/targetHandle` 对应锚点 ⇒ 边**退化到节点包围盒中心/就近边框**画贝塞尔曲线，视觉上就成了"从上下绕"。这正是 `MobileCanvasEdge.css` 注释里说的 P3 锚点退化。

**结论**：这不是配置错误，是移动端节点渲染路径被替换后、连接手柄这一层没有跟着补回的已知缺陷。修复点单一且明确：**在移动端节点子树里补回等价的左右 `Handle`**。

## 2. 目标

1. 移动端节点本体显示与 PC 一致的左右连接手柄（左侧 target、右侧 source，圆形 + 号）。
2. 既有连线与新建连线都从 **A 右（source）→ B 左（target）** 干净路由，不再从中心/上下绕。
3. 触摸交互下可发起并落定连线（拖动 right 手柄 → 落到另一节点 left 手柄或其节点体）。
4. 与 PC 共用同一套 `onConnect` / 边校验 / 落库通道，**不新增**任何连线语义分支。

## 3. 方案总览

- 新建一个 `MobileNodeHandles.vue`，渲染两个 `<Handle>`：`id="target" type="target" :position="Position.Left"` 与 `id="source" type="source" :position="Position.Right"`，id 与 PC 完全一致 → 直接复用既有边的 `sourceHandle:'source'`/`targetHandle:'target'`（`CanvasPage.vue:1528-1529`），无需迁移存量边。
- 在移动壳 `MobileNodeTile.vue` 模板里，把 `<MobileNodeHandles />` 作为 `<NodeTileView>` 的兄弟节点挂进节点子树（仍在 `NodeRenderer` 这个 VueFlow 节点组件的渲染上下文内，Handle 可被 VueFlow 注册）。
- 手柄显隐策略见 §4.2（**需用户拍板的决策点**）。
- 不动 `onConnect` / `isValidConnection` / 边类型；手柄一补，VueFlow 自动按左右锚点重算边路径。
- 触摸连线已具备底层支持：`onConnectStart/onConnectEnd` 接收 `TouchEvent`（`CanvasPage.vue:1545,1567`），`getConnectEndClientPoint` 已处理 `changedTouches`；`onConnectEnd` 仅当 `handleType==='source'` 时进入"拖到空白→打开建节点选择器"分支，落在节点体则走正常连线。

## 4. 关键设计决策

### 4.1 锚点 id / 位置（固定，无歧义）

| 手柄 | id | type | position | 对应 PC |
|------|----|------|----------|---------|
| 入边锚（B 左） | `target` | `target` | `Position.Left` | `NeoBaseNode` target |
| 出边锚（A 右） | `source` | `source` | `Position.Right` | `NeoBaseNode` source |

- `connectable` 默认 `true`；移动端不传 `hideTargetHandle/hideSourceHandle`（移动瓦片始终需要双向锚点）。
- `:nodes-connectable="!viewportSettings.viewLocked"`（`CanvasPage.vue:6206`）对移动端同样生效 ⇒ 视图锁定时自然禁连，无需另加判断。

### 4.2 触摸端手柄显隐策略（已拍板：方案 A）

PC 靠 `hover` 显隐，触摸无 hover。已与用户确认采用 **方案 A：移动端常驻紧凑手柄**（2026-11-10）。

- 触摸没有 hover，常驻即"hover 等价物"。手柄放在瓦片**左右中轴线**（`Position.Left/Right` 默认贴边），不与已置于 `top:-24px` / `bottom:-22px` 的头部、底部属性行冲突。
- 点瓦片主体仍走 tap→查看器；点手柄由 VueFlow 捕获 pointerdown 发起连线，**两者不冲突**。
- 风险最低、与"节点上就有左右 + 号"的诉求最贴合。
- （已否决的备选：方案 B 选中才显隐——需额外"选中但不打开"手势，改动面大；长按菜单"连线"入口——需多加状态分支。）

### 4.3 触摸命中区与样式

- 复用 PC 的 `neo-node.css` 手柄类（`neo-flow-handle` / `handle-hitbox` / `handle-plus` / `handle-plus-inner`），并针对移动端加 `@media (max-width:767px)` 覆盖：**`handle-hitbox` ≥ 44px 触控目标**、`handle-plus` 常显（去掉 hover 依赖）。
- 手柄挂在 `.mobile-node-tile` 根（无 `overflow:hidden`）内，可半露于瓦片左右边，不被裁切；`.mobile-node-tile-card` 的 `overflow:hidden` 不包裹手柄。

### 4.4 手势冲突消解

- 连线 vs 单指平移：`pan-on-drag` 在移动端为单指平移；从手柄发起的 pointerdown 由 VueFlow Handle 接管并 `stopPropagation` ⇒ 不会误触平移。实施时需在真机/模拟器验证一次。
- 连线落点 vs 缩放手势：双指缩放与单指连线天然分流，依赖 VueFlow 既有逻辑；验证即可。
- 可选增强：移动端把 `:connection-radius` 略调大，让手指落在目标节点体更易命中对侧 `target` 手柄。

## 5. 改动文件清单

新增：
- `apps/web/src/components/mobile/MobileNodeHandles.vue` — 两个 `<Handle>`（target/source）+ 移动端样式。

修改：
- `apps/web/src/components/mobile/MobileNodeTile.vue` — 模板内引入 `<MobileNodeHandles />`（`<NodeTileView>` 兄弟节点）；按 §4.2 接入显隐（方案 A：无条件渲染；方案 B：绑 `selected`）。
- `apps/web/src/components/mobile/MobileNodeTile.vue` 的 `<style scoped>` 或新建 `MobileNodeHandles.css` — 移动端手柄命中区/常显样式（44px 触控 + 常显 +）。
- `apps/web/src/components/mobile/MobileCanvasEdge.css` — **不改**（锚点退化问题由本方案解决；文件注释可顺手把"属 P3"一句更新为"已修复于 2026-11-10"，属可选文档清理）。

不动（确认无影响）：
- `CanvasPage.vue` 的 `onConnect` / `isValidConnection` / `onConnectStart/End` / 边类型 / `nodes-connectable` 绑定。
- `NodeTileView.vue` 保持"设备无关、零手势"契约（手柄放进移动壳，不污染共享渲染层）。

## 6. 测试与守卫（行为级 + 变异自检）

- **单元/组件测试** `MobileNodeHandles.test.ts`（或并入 `MobileNodeTile` 测试）：
  - 移动端节点渲染出**恰好两个** `<Handle>`，`id` 分别为 `target`/`source`，`position` 为 `Left`/`Right`。
  - 变异自检：删掉其中一个 Handle / 改错 id ⇒ 断言变 RED（证明断言非恒真）；改 `Position` 为 Top/Bottom ⇒ 断言变 RED。
  - tap 落在手柄区域**不**触发 `tap`/`open-reader`（由 VueFlow 接管），点瓦片主体仍触发打开。
- **画布集成测试**（移动视口）：
  - 模拟从 A 的 `source` 手柄 touchstart → 拖动 → 落到 B 节点体 → `onConnect` 被调用且 `connection.sourceHandle==='source'`、`targetHandle==='target'`、`source===A`、`target===B`。
  - 既有存量边（带 `source/target` handle）在补手柄后，边路径端点落于 A 右 / B 左（可断言 `getBezierPath`/边 DOM 端点坐标差符号，或截图比对）。
- **守卫复用**：既有 `NodeRenderer.policy` 测试、`mobileNodeOpenPolicy` 不受影响；新增手柄不得破坏"单击=查看""长按=动作 sheet"既有契约（测试已覆盖，须全绿）。

## 7. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 手柄被父级 `overflow:hidden` 裁切 | 置于 `.mobile-node-tile` 根（非 `.mobile-node-tile-card`），半露贴边 |
| 连线 drag 误触单指平移 | 真机验证 Handle pointerdown 拦截；必要时显式 `stopPropagation` |
| 命中区过小（手指点不准） | 移动端 `handle-hitbox` ≥ 44px；可加大 `connection-radius` |
| 手柄与头部/底部属性行/选择指示器叠压 | 手柄居左右中线，与 `top/bottom` 浮层正交；右上选择指示器不动 |
| 常驻手柄视觉过重（方案 A） | 用次级色 + 小尺寸 + 低不透明度，仅在激活/拖拽时高亮 |
| 存量边不重算路径 | 手柄注册后 VueFlow 响应式重算；集成测试覆盖 |

## 8. 验收标准

1. 移动端（≤767px）每个节点本体左右两侧出现圆形 + 手柄。
2. 拖动 A 右手柄 → 落到 B 节点 → 生成边，连线从 **A 右 → B 左**（非上下/中心）。
3. 既有在 PC 上创建、从右到左的连线，在移动端同样从右到左渲染，不再退化。
4. 点瓦片主体仍正常打开查看器/阅读器；点手柄发起连线，不会误开。
5. 视图锁定（`viewLocked`）时移动端不可连线（与桌面一致）。
6. 全量 vitest（含 `NodeRenderer.policy`、`mobileNodeOpenPolicy`、新增手柄测试）通过；`vue-tsc -b` 通过。
7. 真机（iOS Safari + Android Chrome）走查连线手势一遍（本环境不可代跑，须标注为待验收项）。

## 9. 决策记录

- **§4.2 手柄显隐策略**：已拍板 **方案 A（移动端常驻紧凑手柄）**，2026-11-10。
- **§4.4 `connection-radius`**：采纳"略调大"建议（低成本、提升手指落点命中率），实施时取值以真机手感为准，不硬设过大以免误连。
- 其余实施项（§5 文件清单、§6 测试、§7 风险、§8 验收）待进入实施阶段执行。
