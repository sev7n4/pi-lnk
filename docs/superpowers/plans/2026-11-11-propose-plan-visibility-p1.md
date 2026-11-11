# propose_plan 方案可见性 P1 实施计划（spec 2026-11-11-propose-plan-visibility-design.md）

> 状态：P0（P0-1/2/3）+ P1-1 已随 PR #831 合并上线（master `d9085d33`，双部署取证齐）。
> 本刀 = **P1-2 全量 + P1-3 最小刀**。按规格风险 3「P1-2 扩大发布面，须与 P0 最小刀拆分，不夹带」——P0 已合并，本刀独立成 PR。

## 0. 实施前真值核对（2026-11-11，master `d9085d33`，逐条回代码）

| 规格条目 | 代码真值 | 结论 |
|---|---|---|
| D5「超时分支触发续跑」 | `plan-gate.ts:37-45`：`markPlanDecision(key,"timeout")` 只置 `pending=true`，**不置 `executedThisRun`**；`plan-gate-wiring.ts:48-57` followUp 只在 `consumePlanExecutionSignal`===true 时注入 | **结构性已闭环**，无需改接线；补回归断言固化（防未来回退） |
| P1-3「ask-user.ts:83/144 统一超时措辞」 | `ask-user.ts:144` 超时语义是 B-1 有意设计（信息类问题超时→自主降级）。若改成「结束 run」会与 20min 死挂治理（规格 §11.4）冲突 | **规格修订**：不统一语义，改为增补护栏措辞——「授权/确认类问题超时≠同意」（只堵 D5 措辞口子，保留 B-1） |
| P1-2「pickLatestSnapshot 识别 details.plan」 | `task-state.ts:66` 只认 `todo_write`；propose_plan 经 `overwriteTodos` 更新 todo store 但**不写 todo_write transcript 条目** ⇒ runtime 重启后 `seedTodoState`（session-manager.ts:1350）播种为空 ⇒ 任务卡与门状态丢失 | 真缺口，实施 |
| P1-2「plan_proposed 一等事件」 | `pi-events.ts:584 extractTaskEvents` 只派生 task_*；`agent.service.ts:2202` pushTraceEvent+yield；`packages/agent/types.ts:45` 联合无 plan_proposed；web `turnTimeline.ts` TimelinePart 无 plan kind | 真缺口，实施 |
| D2「task_tool.md 扩大化措辞」 | 现文 `prompt-registry/rules/task_tool.md` 无「禁止把方案写成正文」残留；P1-1 已改 propose-plan.ts description | **prompt-registry 零改动**（避开 6 处同步 + L6 预算 68 字符风险） |
| 重放可见性（P0 遗留类型缺口） | `turnTimeline.ts:244` ask_user 事件 data.questions **类型缺 `plan?`**（运行时透传，P0 实测 live+重放均出卡；仅 TS 缺口） | 本刀顺手补类型 |

## 1. 改动清单（本刀）

### A. pi-runtime（services/pi-runtime）
1. `tools/task-state.ts` — `pickLatestSnapshot` 扩展：`toolName==='propose_plan'` 时读 `details.todo.snapshot`（P0 形态）?? `details.plan.steps`（兜底），防御式解析与 todo_write 同构（含 message 包裹层）。语义 = 反向扫描最新条目胜出（三态：仅 todo_write / 仅 propose_plan / 二者皆有取最新）。
2. `tools/task-state.test.ts` — 三态单测 + plan.steps 形态（无 id? 不对——plan.steps 来自 overwriteTodos snapshot 含 id；兜底分支对无 id 条目按旧逻辑丢弃）。
3. `gate/plan-gate.test.ts` — 补断言：`timeout/aborted/refine/keep` ⇒ `consumePlanExecutionSignal===false` 且 `isPlanPending===true`（D5 回归锁）。
4. `tools/ask-user.ts` — description 增补：「若是授权/确认类问题（如方案执行确认），超时≠同意，不得把超时当作授权依据」；超时 message L144 尾部加同义句。**不改语义**（B-1 保留）。

### B. server（packages/agent + apps/server）
5. `packages/agent/src/types.ts` — `AgentStreamEvent.type` 联合加 `'plan_proposed'`（注释写明 data 形态与 D4 动机）。
6. `apps/server/src/agent/pi-runtime/pi-events.ts` — 新增 `PlanProposedSchema` + `extractPlanProposedEvent(event)`：`tool_execution_end && !isError && result.details.plan 存在` ⇒ `{type:'plan_proposed', data:{callId, summary, explanation?, steps:[{content, activeForm?}]}}`；否则 null。callId 取 `event.data.toolCallId`（part 稳定 id 依据）。
7. `apps/server/src/agent/pi-runtime/pi-events.test.ts` — 提取断言（有 plan ⇒ 发 / 无 ⇒ null / isError ⇒ null）+ 变异自检：删 `details.plan` ⇒ null（RED 基线）。
8. `apps/server/src/agent/agent.service.ts` — extractTaskEvents 循环后接入：`extractPlanProposedEvent(event)` ⇒ `pushTraceEvent('plan_proposed', data)`（落库 ⇒ 重放可见，D4 核心）+ `yield`。

### C. web（apps/web）
9. `components/agent/turnTimeline.ts` —
   - `TimelineEvent` 加 `{type:'plan_proposed', data:{callId?, summary, explanation?, steps}}`；
   - `TimelinePart` 加 `kind:'plan'` part（id=`plan:${callId ?? counter}` 稳定；status 恒 'proposed'，二期的 confirmed 态留给 plan-gate 事件）；
   - `applyTimelineEvent` 加 `case 'plan_proposed'`（push，不 upsert——refine 后再提案是对话流的独立一步）；
   - `ask_user` data questions 类型补 `plan?`（P0 遗留缺口）。
10. `components/agent/AgentTurnTimeline.vue` — 渲染 `kind:'plan'` part：摘要 + explanation + 有序步骤；样式只消费 `--lnk-*` L2/L3 令牌（墨流纪律；与 AskUserCard 的 `.ask-plan` 视觉对望但不共享 scoped 样式）。
11. `stores/agent.ts` — `trackPlanProposed(data)` → `feedTimeline({type:'plan_proposed', data})`；导出。
12. `components/agent/AgentSideRail.vue` — `handleEvent` 加 `case 'plan_proposed'` → `agent.trackPlanProposed(...)`。
13. 测试：`turnTimeline.test.ts`（part 生成/重放稳定/双提案双 part）；`AgentTurnTimeline.plan.test.ts`（渲染断言：标题/解释/步骤数）。

## 2. 刻意不做（本刀外，防夹带）
- **D6 message_end 事实一致性护栏**：需独立设计（判定词典、变异自检、UI 消费者），且 §11.4 提示与 20min 死挂治理对齐——单独立项，不夹带。
- **D7 callId 重发覆盖复核**：agent.service.ts:2182-2190 已有按 callId splice 逻辑（ask_user/svg_card 落库去重）；propose_plan 的确认卡同走此通道，重发覆盖已被覆盖。复核留到取证阶段顺带核对。
- **plan_updated / 二期面板**：spec §12 二期，本刀不建。
- **prompt-registry 任何改动**：见 §0 真值表。

## 3. 测试与验收
- L1：三层单测全绿（pi-runtime node:test、apps/server vitest、apps/web vitest，单 worker 纪律）+ vue-tsc 0 错误。
- 变异自检：删 `details.plan` ⇒ extractPlanProposedEvent null（判据 RED）；删 pickLatestSnapshot 的 propose_plan 分支 ⇒ 三态单测 RED。
- L3（合并后）：生产取证——runtime 镜像特征串（`plan_proposed` 在 pi-events 编译产物）、web chunk 含 plan part 渲染锚点；真实会话走查留真机。
