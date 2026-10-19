# 提议确认单一锚定表面 —— 落地计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each phase task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落实 ADR-0011 —— 把 `propose_generation` 的待确认态从「对话卡 + 画布节点 + 自动 dock」三重并存表面收敛为**单一锚定表面**（节点即确认面），消除画布窗态遮挡，让用户顺畅查看 / 修改提示词。

**Architecture:** 状态机 `pending_confirm →（确认）→ generating →（done）→ 用户选中才开 dock`。SSOT = 画布节点；对话流降权为只读日志；dock 按节点状态门控不自动弹；从对话流"定位"进入画布走纯画布态。

**Tech Stack:** 前端 Vue3（apps/web）：`AgentSideRail.vue`、`turnTimeline.ts`、`CanvasPage.vue`、`stores/agent.ts`、`useCanvasActions.ts`、`useNodeGeneration.ts`、`proposeWaitActions.ts`、画布节点组件（`CanvasNodeImage.vue` 等）。

**ADR / Spec:**
- 决策快照：`docs/adr/0011-propose-confirm-single-surface.md`（Accepted）
- 须保留的既有契约：`docs/superpowers/specs/2026-10-06-propose-confirm-deterministic-design.md`（确认必须走 `POST /answers` 确定性信号，不回退到状态枚举兜推）
- 须延续的拍板：2026-10-06 / 2026-10-13 规格「画布是确认入口，收敛为两处：画布节点生成按钮 + 直接输入文字」

---

## Global Constraints（不可违反）

- **确定性确认信号不动**：节点锚定确认面仍走 `POST /agent/sessions/:id/answers(callId)`（见 `proposeWaitActions.ts` 的 `resolveProposeConfirmCallId` / `useNodeGeneration.ts` 的 clear pending_confirm）。本计划只改"确认面在哪里 / 有几个"，不改"确认由什么信号担保"。
- **不破坏 2026-10-06 规格的 stale-draft 守卫**：`shouldSyncProposePending`（`proposeWaitActions.ts`）与 `useCanvasActions` 的 stale-pending_confirm 守卫继续保留；节点在等待期即同步成 `pending_confirm` 的逻辑不动。
- **不删既有对话流 propose 卡的全部存在**——仅在"画布上下文"下降权为只读；纯对话视图里它依旧是用户确认入口之一（与"两处确认入口"拍板一致）。

---

## Phase 1 — 节点即确认面（核心）

- [ ] **T1 核对并补全 `pending_confirm` 节点内联确认面**：确认 `CanvasNodeImage.vue`（及同类可生成节点）在 `data.status==='pending_confirm'` 时已内联渲染提示词摘要 + 参数（比例 / 分辨率 / 张数）+ 「确认 / 取消」且点击走 `useNodeGeneration` 的 clear-pending + `/answers`。缺哪块补哪块（截图已证明该面基本存在，核对边界即可）。
- [ ] **T2 对话流 propose 卡在画布上下文降权**：`AgentSideRail.vue` 的 `proposeWait` 浮层（约 `:3997-4030`，含"定位 / 取消"按钮）在"画布可见上下文"下不再作为可操作浮层；改为只读提示（"已在画布上待确认：节点 X"）。纯对话视图保持原有可操作卡不变。判定上下文可用 `mobileCanvasView` / 画布可见标志。
- [ ] **T3 `turnTimeline.ts` propose 步骤角色降级**：把 `propose_generation` 在对话时间线里的呈现从"可操作步骤"降级为"只读摘要"（"已提议生成：N 个节点"），与 T2 同源。同步 `toolPresentation.ts` 的 `propose_generation` verb 文案若需区分可操作/只读两态。

## Phase 2 — dock 按状态门控（消除三带叠罗汉）

- [ ] **T4 `CanvasPage.vue:839` 选中态加 pending_confirm 前置**：节点被选中时，若 `data.status==='pending_confirm'`，**不触发** studio dock 自动弹出（`:839` 的"单击图片节点 dock 正常弹出"逻辑加状态门控）。确认 / 取消为该态主交互。
- [ ] **T5 dock 打开时机收敛**：仅当节点 `done`（生成完成）或明确的编辑意图（如点"重绘 / 扩图"等快捷工具）才打开 dock。`CanvasPage.vue:1900` 注释的"三带叠罗汉扳机"应随之消除——补一条注释说明门控已落地。

## Phase 3 — 窗态纪律（从对话定位进入画布）

- [ ] **T6 "定位/查看"进入画布 = 纯画布态**：从对话流点 propose 卡的"定位"按钮（或对话流定位锚）进入画布，走 `mobileCanvasView` 的"页签点入"语义（composer / SSE 收起），而非窗 B 同屏——避免对话卡与画布节点同屏再次出现双可操作表面。仅在用户显式要在画布上继续聊天才开 composer 同屏。
- [ ] **T7 移动端窗态回归**：核对窗 A（◎ 定位锚）/ 窗 B（提议卡定位）/ 纯画布页签三态在改造后的表现，确保 propose 场景走纯画布态。

## Phase 4 — 协议语义对齐（低成本可选）

- [ ] **T8 `waiting_user` ↔ `ui_prompt` 语义对齐**：在文档 / 注释层把"阻塞态（`waiting_user`）vs 工具产出"区分清楚，命名与上游 `ui_prompt_start/end`（`coding-agent/types.ts:745-759`）对齐；前端确认面复用节点组件而非另起一套卡片。不改变自有的画布 host，仅做命名 / 注释收敛。

## Phase 5 — 测试与验收

- [ ] **T9 单测补强**：`turnTimeline.test.ts`（propose 降级为只读摘要）、`AgentSideRail`（画布上下文下降权）、`CanvasPage`（pending_confirm 不弹 dock 的门控）、`proposeWaitActions.test.ts`（确认仍走 `/answers` 确定性信号不被破坏）。
- [ ] **T10 验收判据（全部满足才算闭环）**：
  1. 画布窗态（含从对话定位进入）**零遮挡**：节点 `pending_confirm` 时看不到对话流可操作提议卡叠在画布上；
  2. 节点 `pending_confirm` 时 studio dock **不会自动弹出**；
  3. 对话流里 propose 表现为**只读日志**，不再有第二个可操作确认入口；
  4. 确认仍走 `POST /answers` 确定性信号，生产无"虚假确认 / 误判取消"回归（复用 2026-10-06 规格判据）；
  5. 移动端三窗态表现正确。

---

## 回滚

各任务可独立回退：T2/T3 回退 = 对话流恢复可操作卡；T4/T5 回退 = dock 恢复自动弹（回到"三带叠罗汉"但功能无损）；T6/T7 回退 = 定位进入回到窗 B 同屏。T1 与 T9 是与 ADR-0011 绑定的核心，回退即放弃本决策。

## 验证

- 前端：`pnpm --filter web test`（相关 `.test.ts` 全绿）。
- 生产复测：从对话页发起一次 propose → 进入画布 → 确认节点内联确认面可用、dock 不自动弹、对话卡只读、确认后出图正常、`/answers` 真实入账。
