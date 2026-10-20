# PC 分组回归「原生节点形态」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 让 PC 端分组框重新成为「一等对象」——单击整块框即选中、按住框任意处即整组拖动、选中后与单节点同样可改名 / 换背景色 / 解组；同时根治拖动时分组框「像塞进信封一样被逐步淹没」的裁剪 bug。交互层不再自研，全部白拿 `@vue-flow/core` 的父子节点分组（`parentNode` + `extent:'parent'` + `expandParent`）。

**Architecture:** 三层切分，**持久化格式一行不改**。
- **持久化层（不动）**：`CanvasData.groups[]`（`CanvasGroup`：id/title/colorKey/childIds/position/size），子节点 `position` 恒为**画布绝对坐标**。服务端 `canvas.controller.ts` / `agent-canvas-tools` / `packages/shared` 零改动，agent 契约零改动。
- **运行层（改）**：加载时 `materializeGroups()` 把每个 `CanvasGroup` 物化成一个 `type:'group'` 的 vue-flow 节点（`style.width/height` + `zIndex:0`），并把 `childIds` 里的节点挂 `parentNode / extent:'parent' / expandParent:true / zIndex:1`，坐标改为**相对父节点**；保存时 `foldGroups()` 反向折叠（子节点回绝对坐标、剔除 group 节点、重算 `CanvasGroup.size`）。
- **交互层（白拿）**：选中 / 拖动 / 层级 / 命中测试全由 vue-flow 提供。已核库源码：`getDragItems()` 会排除「父节点也在拖」的子节点，且 `updateNodePositions()` 对有 `parentNode` 的节点发出的是**相对** position ⇒ 受控模式（`apply-default=false` + `onNodesChange`）下直接写回即可，不会写坏相对坐标。
- **`groups` ref 退化为保存边界的纯函数投影**，不再是第二份真值（消除 #494 以来「nodes 与 groups 两份状态互相同步」的漂移面）。

**Tech Stack:** Vue 3 + `@vue-flow/core@1.48.2`（apps/web）/ TypeScript / vitest（定向跑）/ pnpm workspace（根目录 `pnpm build`）。

**Spec:** 本文件「背景与裁决」章（含用户截图的像素级根因取证）。分支 `feat/group-native-node`（worktree `.worktrees/group-native-node`，基线 `origin/master` = `0e41a175`）。

## 背景与裁决

**① 只能点左上角小胶囊 —— 是刻意的，但不合理。**
`CanvasGroupOverlay.vue` 头部注释自陈：「分组**不是节点**……只有标题条可交互（框体 `pointer-events: none`）—— 否则整块框会吃掉子节点的点击」。这是 #494（2026-10-19）侧车化时的**工程妥协**，不是产品决策。三条判定：
1. 违背直接操作原则 —— Figma / Miro / FigJam 都是「框即对象」，框面就是把手；现交互把全部能力塞进 26px chip，违反 Fitts 定律。
2. 能力不对等 —— 改名只有「chip 双击」一条路，色卡藏在 hover 下拉里，用户根本发现不了。
3. 注释里的技术顾虑不成立 —— 分组层 `z-index: 0` 本就在节点层**之下**；真正会冲突的是「框面拖动 vs 画布平移」「框面点击 vs 框选」，而这正是 vue-flow 原生父子分组已经解决的事。

**② 「塞进信封」根因（已像素级钉死，不限于拖动）。**
`.canvas-group-layer` 同时带 `transform`（手搓 viewport 变换）与 `overflow: hidden`。CSS 规范下 `overflow` 在变换元素上按**元素本地坐标空间**裁剪 ⇒ 裁剪边界是「层本地流空间的 pane 矩形」，经层变换映射到屏幕后 ≠ 可见屏幕区。实测（截图 1734×1380，zoom≈1.57、pan≈(75,-1150)）：裁剪线落在屏幕 y≈1012，框底约 240px（含整条底边框）被吞；拖动时框的流坐标持续增大、逐帧越过流空间 y=1380 ⇒ 「框逐步被淹没」。节点免疫（`.vue-flow__viewport` 的 `overflow:clip` 在**未变换**容器上 = 屏幕空间裁剪），chip 免疫（teleport body + `position:fixed`）。
**修复：整层删除。** 回归 vue-flow 原生节点后，分组框由 `.vue-flow__viewport` 正确裁剪，手搓变换层与 overflow 一并消失 —— 根因在架构上被消除，而不是打补丁。

## Global Constraints

- **GC1 持久化格式零变更**：落库永远是 `CanvasData.groups` + 子节点绝对坐标。`nodes` 里**绝不**出现 `type:'group'`（保存前必须 `foldGroups`）。跨包零改动：`apps/server` / `packages/shared` / `packages/agent` 一行不动。
- **GC2 旧令牌棘轮只减不增**：`neoUsageRatchet.test.ts` 全仓基线 **1557**。新写的 `CanvasNodeGroup.vue` **禁止出现任何 `--neo-`**；分组色一律消费 `--lnk-group-*`（真源已在 `design-tokens.css`，`--neo-group-*` 已是别名）。改令牌/组件样式后必须跑 `design-token.test.ts` + `theme-usage.test.ts`。
- **GC3 不支持嵌套分组**：`materializeGroups` 遇到 `childIds` 指向 group 节点的脏数据直接跳过该 child（与 pre-#494 行为一致）。
- **GC4 移动端不改手势**：group 节点 `draggable` 随 `isMobileLayout`（PC 整盒可拖 = 本次诉求；移动端沿用现状「不拖分组框」，避免整块框吃掉平移/长按手势）。`isMobileLayout` 翻转时同步 patch。
- **GC5 分支纪律**：只在 `feat/group-native-node` worktree 内改；主仓不写代码。push 前 `git status --short` 必须为空；PR 四必填项；CI 三 required check 全绿才 squash 合并。
- **GC6 校验口径**：跨包/跨文件改动跑根目录 `PATH=/tmp/pnpm-shim:$PATH pnpm build`；web 测试用 `./node_modules/.bin/vitest run <path>` 定向跑（本机 4 核，禁全量；`--testTimeout=120000`）。判据必须能真的失败（改一行应变量应见红，必要时做一次变异验证）。
- **GC7 组件不建 Handles**：分组不是内容节点，不提供连线端点（pre-#494 版本有 target/source Handle，本次显式去掉 —— 连到分组框没有语义）。

## Review Focus

以下输入类边界最可能咬到真实用户，每条已固定到拥有该代码的任务：

1. **子节点保存坐标必须回绝对**（GC1 的兑现点）：物化后子节点是相对坐标，若直接 `flowToCanvasData` 落库，agent 布局 / 导出 / 服务端看到的坐标全错。→ Task 1 折叠测试。
2. **删除分组 ≠ 连子节点一起删**：vue-flow 移除父节点会让子节点 `parentNode` 悬空（渲染错乱 + 整组消失）。产品语义是「解组」：删 group 节点、子节点转绝对坐标保留。→ Task 5。
3. **选中 group 不得污染 `selectedNodeId`**：`selectedNodeId` 驱动 dock / studio 打开（CanvasPage:3760 watch、:5237 prop）。若把 group id 塞进去，会打开一个 `neoNodeMeta` 里已不存在的 `group` 面板。→ Task 5。
4. **`extent:'parent'` 的钳制**：子节点被约束在父框内，拖到边缘靠 `expandParent` 撑大父框；撑大后必须重算 `CanvasGroup.size`，否则下次加载框尺寸回退。→ Task 2 / Task 6。
5. **存量画布自愈**：`CanvasGroup.size` 缺失 / 为 0 / NaN，或 `childIds` 指向已删节点时，`materializeGroups` 必须 fail-open（用子节点包围盒兜底，脏 child 直接丢），不能让整块画布白屏。→ Task 1。
6. **拖动中的写库频率**：受控模式下 `onNodesChange` 每帧改 `nodes.value`（正常），但 `persistUserEdit()` 只能在 drag-stop 调（沿用现状 `handleGroupMoveEnd` 的语义）。→ Task 6。
7. **打组的 reselect / merged 语义不丢**：选中的节点本就同属一个分组 ⇒ 只重选不新建；横跨多组 ⇒ 先从原组摘出再归并（#494 加的容错，用户已见过对应 toast）。→ Task 2。
8. **分组名最小空位**：`nextGroupTitle` 沿用 pre-#494 的「扫描现存 title 取最小空位」口径（旧的 `分组 ${groups.length+1}` 会让删组后重名）。→ Task 2。

---

## Task 1: 纯函数层 —— 物化 / 折叠（`useCanvasGrouping.ts`）

**Files:**
- `apps/web/src/composables/useCanvasGrouping.ts`（改：追加分组节点段落，保留 `getNodeSize` / `getAbsolutePosition` / 布局家族不动）
- `apps/web/src/composables/useCanvasGrouping.native.test.ts`（新）

**背景（必读）**：pre-#494 的同名实现可从 `git show 053f6a35^:apps/web/src/composables/useCanvasGrouping.ts` 取回（`restoreGroupHierarchy` / `createGroupFromNodes` / `resizeGroupToFitChildren` / `ungroupNodes` / `nextGroupTitle`），本次在其基础上补「折叠回 `CanvasGroup`」这一 #494 才有的能力。

- [x] **RED**：写 `useCanvasGrouping.native.test.ts`，先落 4 条断言（此时函数不存在，必红）：
  1. `materializeGroups`：2 个绝对坐标子节点 + 1 个 `CanvasGroup` ⇒ 产出 1 个 `type:'group'` 节点（`style.width/height` 取自 `group.size`、`zIndex:0`、`data:{title,childIds,colorKey}`）+ 2 个子节点（`parentNode`、`extent:'parent'`、`expandParent:true`、`zIndex:1`、`position` = 绝对 − group.position）。
  2. `foldGroups`：上一步的输出折回 ⇒ `nodes` 里**没有** `type:'group'`、子节点坐标等于最初的绝对坐标（逐值相等）、`groups[0].size` 等于物化时的 size。往返幂等：`foldGroups(materializeGroups(n,g)) ≈ (n,g)`。
  3. **脏数据 fail-open**：`CanvasGroup.size` 为 `{width:0,height:0}` / `NaN` / 缺失 ⇒ 回退到「子节点包围盒 + `GROUP_PADDING`」；`childIds` 指向不存在的 id ⇒ 静默丢弃；有效子节点 < 2 ⇒ 该分组不物化。
  4. **嵌套防护**：`childIds` 里含另一个 group 节点 id ⇒ 跳过该 child（GC3），不产生 group-of-group。
- [x] **GREEN**：实现，签名固定为：
  ```ts
  export const GROUP_NODE_TYPE = 'group'
  export function isGroupNode(n: FlowNode): boolean
  export function groupNodeSize(n: FlowNode): { width: number; height: number }   // style → dimensions → 兜底 280×160
  export function materializeGroups(nodes: FlowNode[], groups: CanvasGroup[] | undefined): FlowNode[]
  export function foldGroups(nodes: FlowNode[]): { nodes: FlowNode[]; groups: CanvasGroup[] }
  ```
- [x] 跑 `./node_modules/.bin/vitest run apps/web/src/composables/useCanvasGrouping.native.test.ts --testTimeout=120000` 转绿。
- [x] **变异自检**（判据必须能真红）：把 `foldGroups` 里的「子节点转绝对坐标」改成直接返回 `node.position`，确认测试 2 立刻失败；改回。

**Acceptance:** 4 条断言全绿；往返幂等；`foldGroups` 输出中 `nodes.every(n => n.type !== 'group')`。

---

## Task 2: 纯函数层 —— 打组 / 解组 / 改色 / 摘除 / 自适应尺寸

**Files:** `apps/web/src/composables/useCanvasGrouping.ts` + 同测试文件

- [x] **RED**：追加 6 组断言：
  1. `createGroupFromSelection(nodes, ids)`：`mode:'created'`（全新打组，group id 形如 `group-<base36>`）；`mode:'reselect'`（所选节点全属同一现存分组 ⇒ 原样返回、不新建）；`mode:'merged'`（横跨两个分组 ⇒ 先从原组摘出再归并成一个新组）；可用节点 < 2 ⇒ `null`。
  2. `ungroupById(nodes, groupId)`：group 节点消失，子节点 `parentNode/extent/expandParent` 清空且坐标转绝对（用 `getAbsolutePosition` 校验），非组内节点零改动；groupId 不存在 ⇒ `null`。
  3. `patchGroupNodeData(nodes, groupId, { title })` / `({ colorKey })`：只改该 group 节点 `data`，子节点零改动；非法 colorKey 由 `normalizeGroupColorKey` 兜 neutral（组件侧保证，此处只测透传）。
  4. `detachNodesFromGroupNodes(nodes, removedIds)`：被删节点从 `data.childIds` 摘掉；剩余有效子节点 < 2 ⇒ **该 group 节点自动解散**且子节点转绝对坐标（沿用 #494 `syncGroupsToChildren` 的自解散语义）。
  5. `resizeGroupToFitChildren(nodes, groupId)`：按子节点（真实 `dimensions` 优先）包围盒 + `GROUP_PADDING` 重算 group 的 `position` 与 `style`，子节点相对坐标同步平移使**绝对位置不变**；`syncGroupsToFitChildren(nodes)` 对已贴合（±1px）的分组跳过并返回**原数组引用**（幂等，避免 nodes 引用抖动）。
  6. `nextGroupTitle(nodes)`：现存「分组 1」「分组 3」 ⇒ 返回「分组 2」（最小空位口径）；空画布 ⇒ 「分组 1」。
- [x] **GREEN**：实现上述函数（签名固定）：
  ```ts
  export function createGroupFromSelection(nodes: FlowNode[], selectedIds: string[], title?: string):
    { nodes: FlowNode[]; groupId: string; mode: 'created' | 'reselect' | 'merged'; childIds: string[] } | null
  export function ungroupById(nodes: FlowNode[], groupId: string): FlowNode[] | null
  export function patchGroupNodeData(nodes: FlowNode[], groupId: string, patch: { title?: string; colorKey?: string | null }): FlowNode[]
  export function detachNodesFromGroupNodes(nodes: FlowNode[], removedIds: Iterable<string>): FlowNode[]
  export function resizeGroupToFitChildren(nodes: FlowNode[], groupId: string): FlowNode[]
  export function syncGroupsToFitChildren(nodes: FlowNode[]): FlowNode[]
  export function nextGroupTitle(nodes: FlowNode[]): string
  ```
- [x] 删除已无调用方的 `CanvasGroup[]` 版本旧函数：`groupRectForChildren` / `createGroupFromSelection`(旧) / `ungroupById`(旧) / `patchGroupColorKey` / `renameGroup` / `moveGroupWithChildren` / `syncGroupsToChildren` / `detachNodesFromGroups` / `nextGroupTitle`(旧) / `GroupFromSelectionResult`。保留 `CanvasGroup` 类型导出与 `GROUP_PADDING`。
- [x] 删除 `apps/web/src/composables/useCanvasGrouping.groups.test.ts`（它测的正是被替换掉的 `CanvasGroup[]` API）；其中「自解散」「reselect/merged」两条语义已在上面重新落地。
- [x] 定向跑测试转绿；**变异自检**：把 `detachNodesFromGroupNodes` 的「<2 自动解散」阈值改成 1，确认断言 4 失败；改回。

**Acceptance:** 全部断言绿；`grep -rn "moveGroupWithChildren\|patchGroupColorKey" apps/web/src` 只剩测试文件中的 0 处引用（即生产代码零引用）。

---

## Task 3: 恢复 `CanvasNodeGroup.vue`（节点形态 + 令牌迁移）

**Files:**
- `apps/web/src/components/canvas/CanvasNodeGroup.vue`（新；基线 `git show 053f6a35^:apps/web/src/components/canvas/CanvasNodeGroup.vue`，187 行）
- `apps/web/src/components/canvas/CanvasNodeGroup.test.ts`（新）

- [x] 取回基线版本，逐项改造：
  - **令牌迁移（GC2，硬约束）**：`--neo-node-text`→`--lnk-text-primary`、`--neo-node-title-color`→`--lnk-text-secondary`、`--neo-node-text-muted`→`--lnk-text-muted`、`--neo-border-strong`→`--lnk-border-strong`、`--neo-hover-bg`→`--lnk-hover-overlay`、`--neo-accent`→`--lnk-accent`；色卡注入改 `'--group-accent': \`var(--lnk-group-${normalizeGroupColorKey(props.data.colorKey)})\``。**文件内不得出现 `--neo-`**。
  - **去掉两个 `<Handle>`**（GC7）与 `showHandles` / `neo-flow-handle` / `handle-hitbox` / `handle-plus` 相关代码及 `Position` 导入。
  - 保留：`.group-node-wrapper`（`position:relative; width/height:100%; cursor:grab`）、外沿标题条 `.group-drag-handle`（`top:-32px`，含 2×2 网格图标 + 标题 + 「N 个节点」计数 + 双击改名 input）。
  - 改名入口：`@dblclick.stop="startRename"` + `inject(CANVAS_NODE_RENAME_KEY)` 调 `renameNode(nodeId, title)`（CanvasPage 已 provide，对 group 节点走 `patchNodeData(id,{title})` 分支）。
- [x] **RED**：写 `CanvasNodeGroup.test.ts`（jsdom 无布局引擎 ⇒ 断言落在 DOM 结构 + 内联样式字符串，与既有 `CanvasGroupOverlay.visual.test.ts` 同手法）：
  1. `data.colorKey='moss'` ⇒ 根节点内联 style 含 `--group-accent` 且值为 `var(--lnk-group-moss)`；`colorKey` 缺省/非法 ⇒ `var(--lnk-group-neutral)`。
  2. 标题条存在且为外沿化（源码断言 `top: -32px`）+ 标题前 2×2 网格图标存在 + 计数为 `childIds.length`。
  3. 整盒可拖：wrapper 的 scoped CSS 含 `cursor: grab`，且**不出现** `dragHandle` 限定（否则又退回「只能抓标题条」）。
  4. 双击标题条 ⇒ 出现输入框并回车 ⇒ `renameNode` 被以 `(nodeId, '新名字')` 调用（用 `provide` 注入 spy）。
  5. **棘轮自证**：读本文件源码，`expect(src.match(/--neo-/g) ?? []).toEqual([])`。
- [x] **GREEN**：组件实现到位，`mount` 时 stub `Handle`（已删则不需要）与 `useNode`（用 `@vue-flow/core` 的真实 `useNode` 需要 VueFlow 上下文 ⇒ 改为 `vi.mock('@vue-flow/core', ...)` 只 mock `useNode` 返回 `{ id: 'group-1' }`）。
- [x] 定向跑测试转绿；**变异自检**：把 `normalizeGroupColorKey` 去掉（非法 key 直通），确认断言 1 的非法分支失败；改回。

**Acceptance:** 5 条断言绿；文件内 `--neo-` 计数为 0。

---

## Task 4: 样式层 —— `neo-node.css` 分组规则去 overlay 化

**Files:** `apps/web/src/styles/neo-node.css`（:1398-1427 分组块）

- [x] `.group-node-container` 的 `--group-accent` 兜底改消费新令牌真源：
  `--group-accent: var(--lnk-group-accent, var(--lnk-group-neutral));`（原为 `var(--neo-group-accent, var(--neo-group-neutral))` —— 顺带 -2 棘轮计数）。
- [x] 同步改写块头注释：去掉「由 CanvasGroupOverlay 渲染 / 注入」的表述，改为「由 `CanvasNodeGroup.vue`（`type:'group'` 节点）按 colorKey 注入 `--group-accent`」。
- [x] `.is-active` 规则里的 `--neo-border-strong` **保留不动**（不在本次改动面内，避免无谓的视觉变化）。
- [x] 补 `.group-node-wrapper` 的 `touch-action: none`（PC 拖动靠 vue-flow 的 d3-drag，移动端本就不拖；此行仅为防止触屏误触发浏览器滚动 —— 若与移动端手势冲突则在 Task 6 一并回归）。
- [x] 跑令牌守卫：`./node_modules/.bin/vitest run apps/web/src/test/design-token.test.ts apps/web/src/test/theme-usage.test.ts apps/web/src/components/agent/neoUsageRatchet.test.ts --testTimeout=120000`，棘轮计数须 ≤ 1557（本次应下降）。

**Acceptance:** 三个令牌测试全绿，棘轮计数未上升。

---

## Task 5: `CanvasPage.vue` —— 加载物化 / 保存折叠 / 选中态 / 删除语义

**Files:** `apps/web/src/pages/CanvasPage.vue`

- [x] **加载（:4434-4454）**：`nodes.value` 落库后追加
  `nodes.value = materializeGroups(nodes.value as FlowNode[], data.data.canvasData.groups) as EditableFlowNode[]`；随后 `syncGroupsToFitChildren` 精修一次。两处空画布分支（:4465 / :4477）的 `groups.value = []` 改为 `selectedGroupId.value = null`（`groups` ref 已不存在）。
- [x] **保存（:4257-4267）**：改为
  ```ts
  const folded = foldGroups(nodes.value as unknown as FlowNode[])
  const canvasData = flowToCanvasData(folded.nodes as any, edges.value as any,
    extrasForCanvasSave({ ..., groups: folded.groups }))
  ```
  注释写明「分组节点永不落库（GC1）」。
- [x] **选中态**：删除 `const groups = ref<CanvasGroup[]>([])` 与 `selectedGroupId = ref`；新增
  ```ts
  const selectedGroupId = computed(() => nodes.value.find(n => n.selected && isGroupNode(n))?.id ?? null)
  ```
  `multiSelectCanUngroup` / `multiSelectGroupColorKey` / `toolbarSelectionIds` 改为从该 computed 派生（`multiSelectGroupColorKey` 取 group 节点 `data.colorKey`）。
  删除 `selectedGroupRect`（group 已是节点，`MultiSelectToolbarOverlay` 走 `getSelectionBounds` 即可）。
- [x] **`syncMultiSelectionFromNodes`（:1836）**：把 group 节点从「节点单选」里摘出去 —— 若选中集合里只有 group，`selectedNodeId` 保持 null（`clearEditorSelection()`），只让 `selectedGroupId` 生效（RF-3：否则 dock/studio 会尝试打开一个已不存在的 `group` 面板）。
- [x] **删除语义（:2019 `handleDeleteSelection`）**：先 `const groupIds = ids.filter(id => isGroupNode(...))`；对每个 groupId 调 `ungroupById(nodes.value, id)`（解组 = 保留子节点、坐标转绝对，RF-2）；再对剩余的**非 group** id 执行原有删除流程；最后 `nodes.value = detachNodesFromGroupNodes(nodes.value, removedNonGroupIds)`。
- [x] **`forgetGroupsForRemovedNodes`（:1060）**：改为 `nodes.value = detachNodesFromGroupNodes(...)`；`syncGroupRects`（:1064）改名 `fitGroups()` → `nodes.value = syncGroupsToFitChildren(nodes.value)`。
- [x] **类型**：`apps/web/src/composables/useSelectedNodeEditor.ts` 的 `EditableFlowNode` 补 `style?: Record<string, string>` / `draggable?: boolean` / `dimensions?: { width?: number; height?: number }`（`parentNode/extent/expandParent/zIndex` 已存在）。
- [x] **RED→GREEN**：给「删除分组 = 解组」补一条纯函数级回归（已在 Task 2 断言 2 覆盖）；本任务额外在 `useCanvasGrouping.native.test.ts` 补一条「解组后再 fold，子节点坐标与解组前的绝对坐标一致」（防 `parentNode` 悬空导致坐标漂移）。
- [x] `./node_modules/.bin/vue-tsc --noEmit -p tsconfig.json`（apps/web，约 11 分钟，后台跑）。

**Acceptance:** 类型检查通过；`grep -n "CanvasGroup\b" CanvasPage.vue` 只剩 import 类型与 `foldGroups` 返回值处。

---

## Task 6: `CanvasPage.vue` —— 工具条 / 改名 / 拖动 / 移动端

**Files:** `apps/web/src/pages/CanvasPage.vue`、`apps/web/src/components/canvas/MultiSelectToolbarOverlay.vue`

- [x] **打组（:982）**：改调 `createGroupFromSelection(nodes.value, multiSelectedIds.value)`；设 `nodes.value = result.nodes` 并把该 group 节点置为唯一 `selected`（其余 `selected:false`）；保留三档 toast（reselect / merged / created，文案沿用 `result.mode` 与 `childIds.length`）。
- [x] **解组（:1013）**：改调 `ungroupById`；清 `selected`。
- [x] **改色（:1022）**：`patchGroupNodeData(nodes.value, id, { colorKey: key })`。
- [x] **改名（:1047）**：`handleGroupRename` 删掉 —— 改名统一走 `renameNodeById`（CanvasPage:2199，已 provide 给 `CANVAS_NODE_RENAME_KEY`，group 节点走 `patchNodeData(id,{title})` 分支，自动 persist）。
- [x] **拖动**：删掉 `handleGroupMove` / `handleGroupMoveEnd`（:1030-1044）与 overlay 的 `move`/`move-end` 事件；改在既有 `onNodeDragStop`（:1951）里加 `nodes.value = syncGroupsToFitChildren(nodes.value)` 再 `persistUserEdit()`（RF-6：拖动中只改内存、松手才落库）。`onNodeDragStart`（:1939）已有的 zIndex 抬升逻辑沿用。
- [x] **移动端 draggable（GC4）**：`materializeGroups` 产出的 group 节点 `draggable` 取 `!isMobileLayout.value`；加 `watch(isMobileLayout, v => { nodes.value = nodes.value.map(n => isGroupNode(n) ? { ...n, draggable: !v } : n) })`。`isMobileLayout` 来自 CanvasPage:4609 的 `useAgentMobileLayout()`（该行在文件更下方，watch 需放在其后或改用 computed 惰性读取 —— 实现时以不触发 TDZ 为准）。
- [x] **`MultiSelectToolbarOverlay.vue`**：删掉 `groupRect` prop 与其分支（:11-16、:60-70）—— group 已是节点，统一走 `getSelectionBounds(flowNodes, ids)`；同步更新其 `groupRect` 注释。CanvasPage 侧移除 `:group-rect` 传参。
- [x] 定向跑 `MultiSelectToolbar.groupColor.test.ts`（147 行，断言色卡 8 色与内环跟随；本次不改其实现，仅确认未破）。

**Acceptance:** 拖动路径无 `moveGroupWithChildren`；`grep -n "groupRect" apps/web/src` 为 0。

---

## Task 7: 删除 `CanvasGroupOverlay` 与端口断言

**Files:**
- 删：`apps/web/src/components/canvas/CanvasGroupOverlay.vue`（427 行）
- 删：`apps/web/src/components/canvas/CanvasGroupOverlay.visual.test.ts`（375 行）
- 改：`apps/web/src/pages/CanvasPage.vue`（移除 :113 import 与 :4932-4942 挂载块）

- [x] 删除上述三处（② 的根因 `.canvas-group-layer{overflow:hidden}` 随文件一起消失 —— 见「背景与裁决」）。
- [x] **端口关键断言到 `CanvasNodeGroup.test.ts`**（Task 3 已覆盖：分组图标、色卡注入/默认 neutral、外沿标题条）。额外补一条**根因回归断言**（必须能真红）：
  源码扫描 `apps/web/src` 里不得再出现 `canvas-group-layer`，且 `CanvasPage.vue` 不得再引用 `CanvasGroupOverlay` —— 防止手搓视口变换层被重新引回（那正是「塞进信封」的复现条件）。
- [x] `mobile` 侧确认：`grep -rn "CanvasGroupOverlay" apps/web/src` 为 0。
- [x] 定向跑 `apps/web/src/components/canvas/` 下全部分组相关测试。

**Acceptance:** 三处删除完成；两条源码扫描断言绿；分组相关定向测试全绿。

---

## Task 8: 全量校验 + 交付

- [x] 根目录 `PATH=/tmp/pnpm-shim:$PATH pnpm build`（GC6；本机 pnpm 不在 PATH，需 corepack shim）。
- [x] 定向 vitest：`useCanvasGrouping.native.test.ts`、`CanvasNodeGroup.test.ts`、`MultiSelectToolbar.groupColor.test.ts`、`design-token.test.ts`、`theme-usage.test.ts`、`neoUsageRatchet.test.ts`（本机加 `--testTimeout=120000`；`uptime` 看负载，load ≫ 100 时的超时是假红）。
- [x] `git status --short` 为空后 push `feat/group-native-node` + 开 PR（四必填项：背景 / 变更 / 验证 / 风险；PR 描述里写明 ① 的产品裁决与 ② 的根因取证结论）。
- [x] 盯 CI 三 required check；squash 合并；合并后删 worktree 与分支。

**Acceptance:** build 绿、定向测试绿、CI 三 check 绿、PR 已 squash 合入 master。

## 非目标（本批明确不做）

- 移动端分组框拖拽手势（保持现状不拖；等移动端画布重构的手势分流结论再评估）。
- `CanvasReadonlyPage` / `ReplayPage` 的分组渲染（现状本就不渲染分组，本次不动）。
- agent 主动建组 / 改组能力（`CanvasData.groups` 对 agent 只读语义不变）。
- `MultiSelectToolbar.vue` 里色卡的 `--neo-group-*` → `--lnk-group-*` 迁移（别名指向同一真源，行为一致；留作独立清扫批次，可再降棘轮）。
