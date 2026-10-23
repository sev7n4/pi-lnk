# 移动端节点重构 R4：操作类补齐 + 提议内容可见

> 主线：`docs/design/2026-10-22-mobile-node-refactor.md`（移动端画布节点重构）
> R1（#555）R2（#560）R3（#562）已上线。**R4 = 补齐移动端节点的操作类闭环 + 让「提议」在移动端可读。**
> 起因：2026-10-23 代码级审视发现移动端节点的操作类存在多处断链，提议内容在移动端**完全不可见**。

## 0. 代码级取证：移动端操作类现状

| 动作 | 状态 | 根因（证据行号） |
|---|---|---|
| **重命名** | 🔴 **完全失效**（点了零反馈） | 动作声明 `MobileNodeActionSheet.vue:21` → 接线 `CanvasPage.vue:4684`（写 `renameRequestNodeId`）→ provide `CanvasPage.vue:2559` → **唯一消费端 `NeoBaseNode.vue:133` 在移动端被旁路**（`NodeRenderer.vue:35` 移动端渲染 `MobileNodeTile`，不渲染 `NeoBaseNode`）⇒ 无人消费 ⇒ 静默失效 |
| **引用** | 🟠 有静默 no-op + 结果不可见 | `CanvasPage.vue:4690` → `handleAddToAgentRefs` 用可选链 `agentRailRef.value?.addFromCanvasNodes(...)`（`:4513`）⇒ ref 为 null 时**整条静默**；且结果落 Agent 侧栏 pendingAttachments，移动端画布视图下 composer 隐藏（`AgentSideRail.vue:5351`）⇒ **画布上看不到「引用成功」** |
| **副本** | 🟢 可用 | `CanvasPage.vue:4693` → `handleDuplicateSelection`（`:4570`）与 PC 同源 |
| **多选** | 🟠 逻辑通、**无勾选徽标** | 磁贴不 inject `CANVAS_MULTI_SELECT_ACTIVE_KEY`；`.neo-node-multi-badge`（`neo-node.css:428`）/`.neo-node.selected`（`:422`）选择器绑定 `.neo-node`，不匹配 `.mobile-node-tile`（`MobileNodeTile.vue:201`）⇒ **用户看不出哪些被选中**。另动作 sheet 文案恒「多选」，PC 会变「加入/移出多选」 |
| **编辑** | 🟠 能改能存，但**改完无法生成** | `DockStudioRouter` 的 `@generate` / `@removeRef` / `@continueShot` / `@refine` **四个 emit 未接**（`MobileNodeEditorSheet.vue:60` 只接 patch/close）⇒ 移动端编辑 sheet 里点「生成」被吞、**无法删引用芯片** |
| **删除** | 🟢 可用 | `CanvasPage.vue:4696` → `removeSingleNode`（`:4603`）与 PC 同源 |
| **（共用）动作 sheet** | 🔴 选完不自动关 | `handleMobileNodeAction`（`CanvasPage.vue:4682`）从不调 `closeMobileNodeAction()`（`:2605`）⇒ sheet 盖在屏幕底部 |
| **提议内容可见性** | 🔴 **移动端任何位置都不显示** | 磁贴 props 的 `data` 类型无 `prompt`/`label`/模型字段（`MobileNodeTile.vue:22`）；模板无内容渲染。PC 有 `NodePendingPrompt`（`CanvasNodeImage.vue:191`）而移动端没有 |

### 0.1 「提议」在两端的真实形态（避免误解）

- PC 的 `ProposeConfirmOverlay` **不显示任何提议内容**——它只是「待确认」标签 + 确认/编辑/取消三个按钮（`ProposeConfirmOverlay.vue:114-151`），props 只有 `id` + `data.status`（`:26-33`）。
- PC 真正显示提议内容的是**节点体内的 `NodePendingPrompt`**（`CanvasNodeImage.vue:191` / `CanvasNodeVideo.vue:248` / `CanvasNodeAudio.vue:216`；⚠️ `CanvasNodeText.vue` 没有）。
- 提议的 prompt / model / 比例**早于 propose 就写进了 node.data**（`agent-canvas-tools.service.ts:1004-1023` 建节点时写 `prompt` + `imageAspect` + `videoSettings`）；`propose_generation` 只把 status 打成 `pending_confirm`（`proposeWaitActions.ts:92`）⇒ **数据已在节点上，只是移动端没渲染**。

## 1. 设计决策

### D1 · 提议内容直接长在瓦片上，**不新增「查看」入口**

用户的原始设计意图：**「提示词直接在节点瓦片上，省去了点击的二次动作」**。本 R4 完整承接：

- 移动端磁贴 pending 态渲染 `NodePendingPrompt`（**复用 PC 组件，零新判据**——它内部已判 `status === 'pending_confirm' && prompt 非空`）。
- 追加一行**参数摘要**（模型 · 比例 · 分辨率）—— 移动端特有补偿（移动端无常驻 dock，PC 靠参数面板承载这些）。
- **不显示** PC 那句 hint「可在提示词卡片上「编辑」后确认」（PC 语境：编辑在 dock；移动端编辑在 sheet）。
- 「待确认」标识由 `NodePendingPrompt` 自带的 chip 承担 ⇒ 磁贴角标在 pending 态**不再重复渲染**（避免「角标：待确认 + chip：待确认」冗余）。
- ⇒ **不需要「查看」按钮**：用户直接在画布上读提议内容；确认/拒绝仍在 R3 的壳层聚合状态栏（跨节点聚合动作），改参数走二级（编辑 sheet）。

### D2 · 编辑 → 生成闭环（移动端补 `@generate`）

移动端新增独立生成函数，**复用 PC 的判据纯函数**（`isNodeBusy` / `isDockGenerateBusy` / `resolveNodeRefs` / `shouldConfirmDirectGenerateWithoutRefs` / `generateForNode`），**PC 零 diff**（不动 `handleNodeGenerate`，避免 PC 漂移）。移动端 patch 是立即落库（`applyMobileEditorPatch`），故无 PC 的 `debouncedNodePatch.flush()` 步骤。

### D3 · 重命名：动作 sheet 内联，不依赖 PC 行内输入框

`NeoBaseNode` 的行内重命名在移动端不存在 ⇒ 移动端在**动作 sheet 内**做重命名（长按已是二级入口，再点输入框符合移动端手势）。提交后走既有 `renameNodeById`（`CanvasPage.vue:2498`，`patchNodeData({title})` 合并语义，不丢 prompt/参数）。

### D4 · 动作 sheet 选完即关；多选给视觉反馈

- `handleMobileNodeAction` 末尾统一 `closeMobileNodeAction()`。
- 磁贴 inject `CANVAS_MULTI_SELECT_ACTIVE_KEY` + `node.selected` ⇒ 渲染勾选徽标（**不复用 `.neo-node-multi-badge`**，那个绑定 `.neo-node`；改为磁贴自有类名 + `--lnk-accent` 令牌）。

## 2. Global Constraints

- **PC 零 diff**：不动 `CanvasNode*` / `NeoBaseNode` / `ProposeConfirmOverlay` / `dock-studio/**` / `neo-node.css`。移动端只加自己的组件与接线。
- **复用优先**：提议内容复用 `NodePendingPrompt`；生成判据复用 PC 的纯函数；重命名复用 `renameNodeById`；多选复用既有 `enterMultiSelectMode` / `toggleNodeInMultiSelect`。
- 令牌纪律：只用 `--lnk-*`（禁裸 hex / `rgba(` / Tailwind 任意值）；44px 触控目标。
- 守卫强度：**行为级**（挂载组件 + 断言可观测出口），静态 `toContain` 只作辅助（R2 轮教训：`if (false)` 变异能骗过静态断言）。
- 分支：`feat/mobile-node-refactor-r4`（自 origin/master）。

## 3. 任务清单

| Task | 内容 | 主要文件 |
|---|---|---|
| **T1** | 提议内容上瓦片（复用 `NodePendingPrompt` + 参数摘要；pending 态角标去重） | `MobileNodeTile.vue` + 新增测试 |
| **T2** | 编辑 sheet 补 `@generate` / `@removeRef` 透传 → 移动端生成闭环 | `MobileNodeEditorSheet.vue` / `MobileCanvasShell.vue` / `CanvasPage.vue` |
| **T3** | 重命名：动作 sheet 内联输入 + 提交 | `MobileNodeActionSheet.vue` / `CanvasPage.vue` |
| **T4** | 动作 sheet 选完即关 + 多选勾选徽标 | `CanvasPage.vue` / `MobileNodeTile.vue` |

## 4. 不在本 release（防范围蔓延）

- 引用结果在移动端的可见反馈（需动 Agent 侧栏 composer 的移动端可见性 ⇒ 跨模块，另包）
- 移动端「含上游的副本」（PC 有 `duplicate-upstream`）
- 提议内容的**就地编辑**（编辑仍走二级 sheet，保持单一编辑语义——同 PC 的 `NodePendingPrompt` 只读约定）
- PC 端 `CanvasNodeText` 缺 `NodePendingPrompt`（PC 侧问题，本包不动 PC）
- #393 那条线的 PR1/2/3 台账回填（另一条主线，代码已由 #396/#397/#398 落地）
