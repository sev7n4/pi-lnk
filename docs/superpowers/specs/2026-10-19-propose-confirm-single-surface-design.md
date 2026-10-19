# 提议确认单一锚定表面 —— 实现设计稿（Living Spec）

> 关联决策快照：[ADR-0011](../../adr/0011-propose-confirm-single-surface.md)（Accepted）
> 实现排期：[2026-10-19-propose-confirm-single-surface.md](../plans/2026-10-19-propose-confirm-single-surface.md)
> 须保留契约：[2026-10-06-propose-confirm-deterministic-design.md](./2026-10-06-propose-confirm-deterministic-design.md)（确认走 `POST /answers` 确定性信号）
> 本文是**活文档**：实现中若发现锚点漂移 / 更优解，直接改本文并在"实现记录"追加，不回写 ADR。

---

## 1. 问题与目标态

**现状（三带叠罗汉）**：一次 `propose_generation` 的 `pending_confirm` 待确认态，在画布上下文里被渲染成**三个并存且都可操作**的表面，互相遮挡，用户无法顺畅查看 / 修改提示词：

| # | 表面 | 位置 | 现状可操作性 |
|---|---|---|---|
| S1 | 对话流提议卡 | `AgentSideRail.vue` propose-wait-hint（`:3999-4036`） | 「定位」「取消」两个按钮 + 失败警示 |
| S2 | 画布 `pending_confirm` 节点 | `CanvasNodeImage.vue` 等 | 展示提示词，**无内联确认面** |
| S3 | 自动弹出的 studio dock | `CanvasPage.vue` `DockStudioToolbar`（`:5201`，`v-if="!refinePanelNode && !gridSlicePanelNode"`） | 生成按钮 = 实际确认入口 |

代码已自知冲突：`CanvasPage.vue:1900`「选中 → studio dock / 快捷工具行弹出，与拾取流互相踩（三带叠罗汉扳机）」。

**目标态（ADR-0011 六决定收敛）**：
- **单一事实来源 = 画布节点**：节点即确认面，内联「确认 / 取消」。
- **对话流降权为只读日志**：切到画布上下文后，S1 退化为不可操作提示。
- **dock 按状态门控不自动弹**：`pending_confirm` 时 dock 不弹出；确认 → 生成完成 → 用户主动选中才开 dock。
- **窗态纪律**：从对话「定位 / 查看」进入画布 = 纯画布态，不回到「卡 + 节点」同屏双可操作面。
- **确定性确认契约不动**：仍走 `POST /agent/sessions/:id/answers(callId)`。
- **协议语义向 `ui_prompt` 靠拢**（低成本，命名 / 注释收敛）。

---

## 2. 确认机制真相（实现前必须吃透 —— 决定任务依赖顺序）

本轮核对源码，把「确认 / 取消到底由谁触发」钉死（这直接决定 T4 不能先于 T1）：

- **确认（confirm）**：
  1. dock 生成按钮 → `CanvasPage.handleNodeGenerate()`（`:3968`）或原子入口 `handleAgentGenerateNode(nodeId)`（`:4019`，注释「画布确认原子入口」）；
  2. 二者都先 `agentRailRef.value?.confirmProposeWait?.(nodeId)`（`:3978` / `:4023`）——`AgentSideRail.confirmProposeWait`（`:1050`）用 `resolveProposeConfirmCallId`（`proposeWaitActions.ts:48`）取 callId → `submitAnswers` POST `/answers`；
  3. 随后 `useNodeGeneration` 生成路径把 `pending_confirm` → draft → generating（`useNodeGeneration.ts:918-921`）。
  - ⚠️ **确认面当前在 dock 的生成按钮上**（选中节点 → dock 自动弹 → 点生成 = 确认）。节点本体没有独立确认入口。
- **取消（cancel）**：`AgentSideRail.cancelBlockingPropose`（`:1019`）→ `resolveProposeCancelCallId` POST `/answers {decision:'decline'}` + `emit('clearProposeGeneration', nodeId)`。**此函数未 defineExpose 给 CanvasPage**（`:3257` 只 expose 了 `confirmProposeWait`）。

> **推论（关键依赖）**：若先做 T4 把 dock 对 `pending_confirm` 门控掉，用户将**没有任何确认入口**（确认只在 dock 生成按钮）。故 **T1（把确认 / 取消搬到节点内联面）必须严格先于 T4**。这也是本设计与"维持三表面"的差别：不是删功能，是**迁移确认面位置**。

---

## 3. 逐任务实现细节

### Phase 1 — 节点即确认面

#### T1 `pending_confirm` 节点内联确认面（T4 的前置，核心）

**目标**：选中 / 激活一个 `pending_confirm` 节点时，节点附近出现一枚紧凑「确认生成 / 取消」操作面，行为与 dock 生成 / 侧栏取消**完全同源**（复用同一 callId 解析 + 同一状态收敛），不新造第二套确认语义。

**落点选择（低风险优先）**：不改 `NeoBaseNode.vue` / `CanvasNodeImage.vue` 内部结构（它们是全画布复用件，动辄回归）。改为在 `CanvasPage.vue` 复用既有**选区操作条**（`SelectionActionBar`，锚点 `selectionActionBarNode` / `:5211` `tool-row-visible`）：
- 当唯一选中节点 `data.status === 'pending_confirm'` 时，操作条主 CTA 切为「确认生成 ⚡N 积分」+「取消」；其余编辑类快捷工具隐藏（该态主交互就是确认 / 取消）。
- 确认 CTA → 调 `handleAgentGenerateNode(nodeId)`（已有原子入口，内含 `confirmProposeWait` + 清 pending_confirm + 生成）。
- 取消 → 需要一条**节点级 decline** 路径：把 `AgentSideRail.cancelBlockingPropose` 泛化成 `cancelProposeForNode(nodeId)` 并 defineExpose（复用 `resolveProposeCancelCallId`），或 CanvasPage 直接 `agentRailRef` 调一个新增 expose 方法；语义不变（POST decline + `clearProposeGeneration`）。

**验收**：不选中 dock、仅凭节点操作条即可完成确认（出图）与取消（回 draft、run 恢复）；`/answers` 确认 / decline 真实入账。

> 备选（若选区操作条改造面过大）：在 `CanvasPage` 渲染一个挂 `pending_confirm` 选中节点的小浮层（类似既有 `selectionActionBarNode` 定位逻辑）。二者都满足"单表面"，优先操作条方案。

#### T2 对话流提议卡在画布上下文降权为只读

**目标**：`AgentSideRail.vue` propose-wait-hint（`:3999-4036`）在**画布可见上下文**下从「可操作卡」降为「只读提示」，去掉与 dock / 节点重复的「定位 / 取消」按钮；纯对话视图保持原样。

**判定信号**：`mobileCanvasView` prop（`:155`，由 `CanvasPage.mobileCanvasView` 持有真相）。**画布上下文 = `mobileCanvasView === true`**。
- 画布上下文：保留横幅（失败警示 `turnHasFailedStep` 仍显示，安全相关），但按钮区（定位 / 取消）`v-if="!mobileCanvasView"`；正文改为「已在画布上待确认：查看 / 修改提示词后点确认」。
- 纯对话视图（`mobileCanvasView === false`，含桌面）：维持现有「定位 / 取消」可操作卡不变（与 2026-10-06「两处确认入口」拍板一致）。

**注意**：`data-testid="propose-wait-hint"` / `propose-wait-locate` / `propose-wait-cancel` 既有选择器要兼容——只读态隐藏后，测试需按上下文分别断言（见 T9）。

#### T3 `turnTimeline.ts` propose 步骤角色降级为只读摘要

**现状（核对后修正）**：`turnTimeline.ts` 里 `propose_generation` 已是**只读 artifact 日志**（`canvas_action add_node → upsertArtifact`）+ `waiting_user` notice（`:524-561`，「等待你在画布上确认生成」），**并非**可操作步骤卡。故 T3 主要是**文案 / 角色一致性收敛**，非结构性降权：
- 保留 notice（回答"对话流为什么在等"），文案明确指向画布确认面，不诱导在对话流里二次操作。
- 无需改动 `toolPresentation.ts` 的 verb（已是中性的"提议生成"类）；若发现可操作残留再按只读收口。

### Phase 2 — dock 按状态门控

#### T4 选中态加 `pending_confirm` 前置（T1 之后）

**目标**：节点 `pending_confirm` 时**不自动弹** studio dock。

**落点（两处，桌面 + 移动一致）**：
1. 桌面 dock：`CanvasPage.vue:5201` `<DockStudioToolbar v-if="!refinePanelNode && !gridSlicePanelNode" ...>` —— 追加 `&& !isPendingConfirmNode(editorNode)`。抽一个 helper `isPendingConfirmNode(n) = !!n && String(n.data?.status ?? '') === 'pending_confirm'`（与 `:1152`、`:1275` 的既有内联判据同源，收敛成函数）。
2. 移动 dock：`CanvasPage.vue:4803` `mobileStudioDockOpen` 计算追加 `&& !isPendingConfirmNode(editorNode.value)`（控制 SSE / composer 让位与 dock 抬高，一并门控，避免"让了位却不弹 dock"的半态）。

**保留**：`dockCollapsedByOverlay`（`:843`，编辑浮层激活时收成热区）逻辑不动；确认后节点转 `generating` / `done`，用户再选中即正常开 dock。

#### T5 门控注释收敛

`CanvasPage.vue:4800-4802` 现有注释描述的是**旧目标态**（"提议卡定位 → 自动拾取节点 → dock 展开"），与 ADR-0011 相反。改为记录新门控意图：`pending_confirm` 不弹 dock、确认 / 取消为节点主交互；`CanvasPage.vue:1900`「三带叠罗汉扳机」处补一句"propose 态已由 T4 门控消除（节点内联确认为主交互）"。

### Phase 3 — 窗态纪律

#### T6 「定位 / 查看」进入画布 = 纯画布态

从对话流定位锚（`focusNode` / `handleHistoryLocate` / propose 卡定位）进入画布，走**纯画布态**语义（composer / SSE 收起），而非「卡 + 节点 + dock」同屏。核对 `mobileCanvasView` / `mobileCanvasImm` 在定位路径的置位：propose 定位应置 `mobileCanvasView=true` 且不置 `mobileStudioDockOpen` 所需的 editable-done 选中态。

#### T7 移动端三窗态回归

核对窗 A（◎ 定位锚）/ 窗 B（提议卡定位）/ 纯画布页签三态：propose 场景一律走纯画布态，dock 不因 pending_confirm 选中而弹。

### Phase 4 — 协议语义对齐（低成本）

#### T8 `waiting_user` ↔ `ui_prompt` 语义对齐（文档 / 注释层）

在协议注释里区分「阻塞态（`waiting_user`）vs 工具产出」，命名对齐上游 `ui_prompt_start/end`（`vendor/earendil-works/pi/packages/coding-agent/src/core/extensions/types.ts:745-759`）。不改自有画布 host，不改 `POST /answers` 契约。仅注释 / 文档收敛 + 前端确认面复用节点组件。

### Phase 5 — 测试与验收

#### T9 单测补强

| 文件 | 断言 |
|---|---|
| `AgentSideRail` propose-wait-hint | `mobileCanvasView=true` 时隐藏定位 / 取消按钮（只读）；`=false` 时保留 |
| `CanvasPage` dock 门控 | `editorNode.data.status==='pending_confirm'` 时 `mobileStudioDockOpen=false`、`DockStudioToolbar` 不渲染 |
| 节点内联确认（T1） | pending_confirm 选中 → 操作条出现确认 / 取消；确认触发 `confirmProposeWait` + 生成；取消触发 decline + `clearProposeGeneration` |
| `proposeWaitActions.test.ts` | `resolveProposeConfirmCallId` / `resolveProposeCancelCallId` / `shouldSyncProposePending` / `forcePendingConfirmInPayload` 不被破坏（回归护栏） |

> 本机纪律：`./node_modules/.bin/vitest`（禁 npx），`--testTimeout=120000`；全量 web 测试归 CI。

#### T10 验收判据（全满足才算闭环）

1. 画布窗态（含从对话定位进入）**零遮挡**：`pending_confirm` 时看不到对话流可操作提议卡叠在画布 / dock 上；
2. `pending_confirm` 时 studio dock **不自动弹出**；
3. 对话流 propose 表现为**只读日志**，无第二个可操作确认入口；
4. 确认仍走 `POST /answers` 确定性信号，无"虚假确认 / 误判取消"回归（复用 2026-10-06 判据）；
5. 移动端三窗态表现正确，propose 走纯画布态。

---

## 4. 任务依赖与排序（实现顺序，不可打乱）

```
T1（节点内联确认/取消，迁移确认面）
 ├─→ T2（对话卡画布上下文只读）
 ├─→ T4（dock 对 pending_confirm 门控）  ← 必须在 T1 之后
 │    └─→ T5（注释收敛）
 ├─→ T3（timeline 文案一致性）
 └─→ T9（单测：T1/T2/T4 各自断言）
T6/T7（窗态）/ T8（协议注释）可并行收尾
T10（验收）最后
```

**回滚粒度**：T2 回退 = 对话卡恢复可操作；T4 回退 = dock 恢复自动弹（功能无损）；T1 回退 = 放弃"节点即确认面"、退回 dock 确认（但此时 T4 也必须一起回退，否则无确认入口）。**T1 与 T4 必须同进同退。**

---

## 5. 风险

- **确认面迁移回归（最高）**：T1/T4 同进同退；`/answers` 契约与 stale-draft 守卫（`shouldSyncProposePending` / `forcePendingConfirmInPayload` / `useCanvasActions` STALE 守卫）全程不动，只改"确认面在哪渲染"。
- **节点操作条改造面**：优先扩展 `SelectionActionBar`（已存在定位 / 显隐逻辑），不碰 `NeoBaseNode` 内部；若不可行退小浮层备选。
- **桌面 vs 移动分支**：T4 桌面（`:5201`）与移动（`:4803`）两处都要门控，漏一处即半态。
- **cancelBlockingPropose 未 expose**：T1 需新增 expose（或泛化签名），注意不破坏既有 `AgentSideRail.confirmTakedown.test.ts` 对 `clearProposeGeneration` emit 的断言。

---

## 6. 实现记录

- 2026-10-19：建立本文；核对确认机制真相（§2），确立 T1→T4 强依赖；修正 plan 中 T2/T3 描述（timeline 已是只读 artifact，无需结构性降权）。
- 2026-10-19（PR #485）：T2/T5/T9 安全切片上线——`AgentSideRail` 画布上下文只读 + CanvasPage 注释收敛 + `AgentSideRail.proposeReadonly.test.ts`。
- 2026-10-19（T1/T4，本次）：
  - **T1 落点修正**：spec 原首选「复用 SelectionActionBar」不可行——`selectionActionBarNode` 要求 `data.url` 非空（`:881`），pending_confirm 节点无产物，天然互斥。实际落地为**专用节点锚定浮层** `ProposeConfirmOverlay.vue`（屏幕空间，默认锚节点上方、贴顶翻转下方，`data-anchor` 可测；定位走 computed，不引入 raf/resize）。**驱动信号用「画布上 status=pending_confirm 的节点」而非选中态**——「节点即确认面」不需要用户先选中再找确认入口。
  - **T4 设计修正（重要）**：ADR 决定 3 若按字面「pending_confirm 时 dock 一律不弹」，会堵死「改提示词后再确认」用例（dock 是唯一提示词编辑器）。落地为**门控自动弹出 + 保留显式编辑意图**：`dockGatedByPendingConfirm = isPendingConfirmNode(editorNode) && !proposeConfirmEditIntent`；浮层「编辑」按钮置意图并选中节点 ⇒ dock 开门，改完仍走 dock 生成按钮 → `confirmProposeWait` → `/answers`（同一路径，不新造第二套确认语义）。意图在节点离开待确认态或选中切离时收回（双 watcher），防粘滞。
  - 取消入口泛化：`AgentSideRail.cancelBlockingPropose` → `cancelProposeForNode(nodeId?)`（nodeId 与等待不一致安全 no-op），defineExpose 给 CanvasPage；与侧栏取消同函数同语义。
  - 判据收敛：`isPendingConfirmNode` / `NODE_PENDING_CONFIRM_STATUS` 落 `@/constants/dockStudio`（与 isNodeGenerating 同家），替换 CanvasPage 内联判据意图；MultiSelectToolbar blockedTitle 与 CanvasPage ElMessage 的「请先在侧栏确认生成」文案随确认面迁移改为「在节点上确认生成」。
  - 测试：`dockStudio.test.ts` 补 isPendingConfirmNode 三态；`ProposeConfirmOverlay.test.ts` 4 例（三动作 emit / 非待确认不渲染 / above-below 翻转）。CanvasPage 级挂载测试超本机 vitest 天花板（既有纪律：全量 web 测试归 CI）。
- 2026-10-20（T6/T7/T8 收尾）：T6 窗态纪律——`focusNodeById` / `focusNodesByIds` 改为「定位到**待确认**节点 ⇒ 纯画布满屏（`mobileCanvasImm=true`，composer/SSE 全收）」，其余定位（含 ◎ 定位锚）维持窗态；判据复用 `isPendingConfirmNode`。**不改 wire 命名**：`handleCanvasRefPickToggle`（◎ 定位锚）保持窗态是 2026-10-18 裁决，propose 定位改纯画布才是 ADR-0011 决定 4 的增量。T7 三窗态矩阵见下表（回归待人工）。T8 见 §7。

---

## 7. 协议语义对照（T8：`waiting_user` ↔ 上游 `ui_prompt`）

**结论：语义与角色对齐，wire 命名不改。** 改名要动 SSE 契约 + reducer + 回放快照，代价大于收益（ADR-0011 决定 6 本身也标注「低成本、可选」）。

| 角色 | 上游 coding-agent | 本仓（传输名保留） | 渲染落点（ADR-0011 后唯一锚定表面） |
|---|---|---|---|
| 「正在等用户」开始 | `ui_prompt_start` | 时间线事件 `waiting_user`（`status:'waiting'`）+ 轨迹步骤 `ExecutionStepStatus='waiting_user'` | propose → 画布节点内联确认面（`ProposeConfirmOverlay`）；对话流只读 notice |
| 「正在等用户」结束 | `ui_prompt_end` | 同名事件 `status:'resolved'`（+ `POST /answers` 确定性信号） | 节点状态 `pending_confirm → draft/generating`，确认面自动消失 |
| 工具产出 | tool result / `registerTool.renderResult` | `tool_result` / `canvas_action` / `node_status` 时间线事件 | 对话流 artifact 日志（只读）+ 画布节点本体 |
| 阻塞确认的 host 原生表面 | `ui.confirm / select / input`（`ExtensionAPI`） | 画布节点内联确认面（自建 host） | 节点即确认面（ADR-0011 决定 1） |

**关键区分（此前被混为一谈）**：`waiting_user` 是**阻塞态**（run 停在原地等用户），不是「工具还没跑完」；把它当工具产出渲染，就会出现 ADR-0011 记录的三重并存表面。代码注释落点：`turnTimeline.ts` 事件联合类型、`stores/agent.ts#trackWaitingUser`、`executionTraceReducer.ts#ExecutionStepStatus`。

### 7.1 移动端三窗态矩阵（T7 回归用）

| 入口 | `mobileCanvasView` | `mobileCanvasImm` | composer | 适用场景 |
|---|---|---|---|---|
| 页签「画布」/ 传送门 | true | **true** | 收起 | 主动进画布浏览 |
| ◎ 定位锚（引用拾取） | true | false | 保留 | 拾取引图后继续输入（2026-10-18 裁决） |
| **定位到待确认节点**（T6 新增） | true | **true** | 收起 | 去画布看 / 改提示词再确认，零遮挡 |
| 其余定位（历史 / 发布弹窗 / 批量） | true | false | 保留 | 定位后可能继续对话 |
