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

- [x] **T1 核对并补全 `pending_confirm` 节点内联确认面**（2026-10-19 落地）：核对结论——`CanvasNodeImage` 等节点本体**没有**内联确认面（确认入口实际在 dock 生成按钮），且 `selectionActionBarNode` 要求 url 非空复用不了。落地为专用节点锚定浮层 `ProposeConfirmOverlay.vue`（屏幕空间、上方锚点+贴顶翻转、由「画布上 pending_confirm 节点」驱动而非选中态），确认走 `handleAgentGenerateNode`（同 dock 路径）、取消走 `AgentSideRail.cancelProposeForNode`（新增 expose，与侧栏同源）。落点修正详见 spec §6。
- [x] **T2 对话流 propose 卡在画布上下文降权**（2026-10-19，PR #485）：`AgentSideRail` propose-wait-hint 在 `mobileCanvasView=true` 时定位 / 取消按钮收起、正文改「已在画布上待确认……在节点上点确认生成」；纯对话视图（含桌面）维持可操作卡。测试 `AgentSideRail.proposeReadonly.test.ts`。
- [x] **T3 `turnTimeline.ts` propose 步骤角色降级**（2026-10-19）：核对后 timeline 内 propose 早已是只读 artifact 日志（`canvas_action add_node → upsertArtifact`）+ waiting notice，无需结构性降权；本轮只做文案一致性收敛——MultiSelectToolbar blockedTitle 与 CanvasPage ElMessage 的「请先在侧栏确认生成」随确认面迁移改为「在节点上确认生成」。

## Phase 2 — dock 按状态门控（消除三带叠罗汉）

- [x] **T4 `CanvasPage.vue:839` 选中态加 pending_confirm 前置**（2026-10-19）：桌面 dock `v-if` 与移动 `mobileStudioDockOpen` 两处一并门控（`dockGatedByPendingConfirm = isPendingConfirmNode(editorNode) && !proposeConfirmEditIntent`）。设计修正：ADR 决定 3 字面执行会堵死「改提示词后再确认」，故保留**显式编辑意图**覆盖——节点浮层「编辑」按钮置意图并选中节点，dock 开门，改完仍走 dock 生成按钮 → `confirmProposeWait` → `/answers`；意图随节点离开待确认态 / 选中切离收回（双 watcher）。判据收敛为 `isPendingConfirmNode`（`@/constants/dockStudio`）。
- [x] **T5 dock 打开时机收敛**（2026-10-19）：`mobileStudioDockOpen` 上方旧目标态注释已改录门控意图（PR #485）；`:1941`「三带叠罗汉扳机」处补注「propose 态已由 T4 门控消除」。

## Phase 3 — 窗态纪律（从对话定位进入画布）

- [ ] **T6 "定位/查看"进入画布 = 纯画布态**：从对话流点 propose 卡的"定位"按钮（或对话流定位锚）进入画布，走 `mobileCanvasView` 的"页签点入"语义（composer / SSE 收起），而非窗 B 同屏——避免对话卡与画布节点同屏再次出现双可操作表面。仅在用户显式要在画布上继续聊天才开 composer 同屏。
- [ ] **T7 移动端窗态回归**：核对窗 A（◎ 定位锚）/ 窗 B（提议卡定位）/ 纯画布页签三态在改造后的表现，确保 propose 场景走纯画布态。

## Phase 4 — 协议语义对齐（低成本可选）

- [ ] **T8 `waiting_user` ↔ `ui_prompt` 语义对齐**：在文档 / 注释层把"阻塞态（`waiting_user`）vs 工具产出"区分清楚，命名与上游 `ui_prompt_start/end`（`coding-agent/types.ts:745-759`）对齐；前端确认面复用节点组件而非另起一套卡片。不改变自有的画布 host，仅做命名 / 注释收敛。

## Phase 5 — 测试与验收

- [x] **T9 单测补强**（2026-10-19，按本机纪律分批）：`AgentSideRail.proposeReadonly.test.ts`（T2 三态）、`dockStudio.test.ts` 补 `isPendingConfirmNode`（T4 判据）、`ProposeConfirmOverlay.test.ts` 4 例（T1 三动作 emit / 非待确认不渲染 / above-below 翻转）——本地全绿。`CanvasPage` 级挂测（dock 门控 + 浮层集成）超本机 vitest 天花板，按既有纪律交 CI 全量 web 测试；`proposeWaitActions.test.ts` 回归护栏不动（`/answers` 契约未改）。
- [~] **T10 验收判据（资产级已验，交互项待人工冒烟）**（2026-10-19 上线：master `5c81d911`，deploy 39268123182 success）：
  1. 画布窗态**零遮挡**：代码侧达成（对话卡 T2 只读 + dock T4 门控 + 节点浮层 T1），待人工在提议态截图确认；
  2. `pending_confirm` 时 studio dock **不自动弹出**：代码侧达成（桌面 v-if + 移动 `mobileStudioDockOpen` 双门控），待人工确认；
  3. 对话流 propose 表现为**只读日志**：代码侧达成（纯对话视图仍保留可操作卡，2026-10-06 拍板），待人工确认；
  4. 确认仍走 `POST /answers` 确定性信号：✅ 已验（confirm/cancel/edit 三路径全部同源复用 `confirmProposeWait` / `cancelProposeForNode`；`/answers` 契约与 stale-draft 守卫零改动，CI 3 轮全绿）；
  5. 移动端三窗态表现正确：待人工回归（T6/T7 窗态纪律本身仍未收口，见下）。
  - 生产取证：入口 chunk `index-bycYtjHS.js` → `index-CDrSLx70.js`（旧两枚均 404）；`CanvasPage-C5qU5PIE.js` 含 `propose-confirm-overlay` + 三 testid + 「确认生成」；`CanvasPage-DSYCsVdU.css` 含 propose-confirm-btn/dot/label；`/api/health` 200。

---

## 回滚

各任务可独立回退：T2/T3 回退 = 对话流恢复可操作卡；T4/T5 回退 = dock 恢复自动弹（回到"三带叠罗汉"但功能无损）；T6/T7 回退 = 定位进入回到窗 B 同屏。T1 与 T9 是与 ADR-0011 绑定的核心，回退即放弃本决策。

## 验证

- 前端：`pnpm --filter web test`（相关 `.test.ts` 全绿）。
- 生产复测：从对话页发起一次 propose → 进入画布 → 确认节点内联确认面可用、dock 不自动弹、对话卡只读、确认后出图正常、`/answers` 真实入账。
