# SSE 事件一等化 P2 前端 W1c：待确认门 state 驱动重建与终态卡 —— 设计规格

> 日期：2026-11-12　|　性质：**设计规格（待拍板）**，零代码改动
> 母计划：[`2026-11-11-sse-session-resume-p0-p2.md`](../plans/2026-11-11-sse-session-resume-p0-p2.md) §3（W1c-1/2/3）
> 前置规格：[`2026-11-11-sse-p2-durable-interruption.md`](../plans/2026-11-11-sse-p2-durable-interruption.md)（No-Go 第 2 条把本刀判为独立刀）
> 权威基线：master `ba0592834096fc5107d33328d0ae4b3d0db031bc`（#847 合并部署后的真生产树），
> 源码取证用 `gh api repos/sev7n4/pi-lnk/tarball/ba059283...` 快照。
> ⚠️ 本地工作树 `turnTimeline.ts` / `AgentSideRail.vue` / `AgentTurnTimeline.vue` / `stores/agent.ts` /
> `agent.service.ts` 五个关键文件 **blob 与 master 不等（陈旧）**。本刀实现必须从 master 快照重建，
> 禁止在现有工作树上直接改（纪律见 `MEMORY.md`「判缺接线以 HEAD/master 为准」）。

---

## 0. 一句话

服务端 P2 durable 已上线并生产实证闭环（pending / answered CAS / expired 自然超时 + sweep / 终态卡抑制），
但前端对 `GET /api/agent/threads/:threadId/state` **零消费**；本刀让刷新 / 切出切回 / 换设备后的
ask_user 确认卡由**持久化门状态**裁决，并把已终态的门渲染为只读终态卡。

---

## 1. 现状取证（全部基于 master `ba059283` 快照，路径:行号为权威）

### 1.1 服务端已就位（不需要重做）

| 事实 | 位置 |
|---|---|
| `GET threads/:threadId/state` → `{ code:0, data:{ status, lastGSeq, pendingInterruption } }`，带 `AuthGuard`，属主校验 403 不区分 404 | `apps/server/src/agent/agent.controller.ts:291-297`；`agent.service.ts:1795-1815` |
| `getPending()` **只返回 `status='pending' && expiresAt > now` 的最新一条**；终态门 ⇒ `null` | `apps/server/src/agent/pending-interruption.service.ts:169-195` |
| 摘要形态 `{ callId, kind, questions: unknown[], expiresAt: number, status:'pending' }` | `pending-interruption.service.ts:26-32` |
| `suppressTerminalGateCards()` 把**终态 callId** 的 `canvas_command{ask_user}` 从 `getMessages` 的**响应副本**里 filter 掉（DB 原行不改写） | `agent.service.ts:838-887` |
| P1c 读时 enrichment 把收缩行的全量 `executionEvents` 注入响应副本 | `agent.service.ts:891+` |
| `/answers` 已幂等，回 `ok/deduped/late/expired/prior` | `agent.service.ts:2378-2390`；`apps/web/src/components/agent/agentAnswers.ts:69-91` |

### 1.2 前端现状

| 事实 | 位置 |
|---|---|
| `apps/web/src` 对 `/threads/:id/state`、`lastGSeq`、`pendingInterruption` **零命中**（`grep -rnE` 实测） | 全目录 |
| 旧 `agent/thread-state` 死端点已随 H1-c 退役；静态守卫 `expect(code).not.toContain('thread-state')` | `streamRecovery.ts:13-15`；`AgentSideRail.historyFetchNoStore.test.ts:83-86` |
| `refreshThreadCheckpoint()` 现恒 `syncCancelledFromThreadState(null)`，是死的恢复占位 | `useAgentThread.ts:171-181` |
| 历史重建：`loadHistory()` → `agent.loadHistory(rows)` → `mapPersistedToMessage` → `replayTimelineEvents(meta.executionEvents, ...)` | `AgentSideRail.vue:1087-1143`；`stores/agent.ts:1010-1029`；`turnTimeline.ts:1231-1258` |
| `replayTimelineEvents` 把落库的 `canvas_command{ask_user}` 归一化成原生 `ask_user` 再建 `pending_answer` part | `turnTimeline.ts:1219-1229`、`:847-871`；测试 `turnTimeline.replayAskUser.test.ts` |
| question part 状态联合**只有三态** `pending_answer / answered / declined`，无 `expired` | `turnTimeline.ts:133-148` |
| `waiting_user{resolved}` 按 callId 把 question part 一律翻 `answered`（不按 reason 区分） | `turnTimeline.ts:767-775`；测试 `turnTimeline.callIdResolve.test.ts` |
| 终态呈现：`v-if="part.status==='pending_answer'"` 才出 `AskUserCard`；`v-else` 只输出「已回答 / 已跳过」 | `AgentTurnTimeline.vue:761-770` |
| `AskUserCard` props 只有 `questions`，无 status/disabled/终态入参；提交无防重入 | `AskUserCard.vue:20-36`、`:81-84` |
| `useAgentPropose.onAskSubmit` 已乐观翻终态防双击、`deduped` 降级普通 user message、失败回滚 | `useAgentPropose.ts:121-155` |
| `loadHistory` / `reconcileLatestAssistant` 必须 `cache:'no-store'`（ETag 304 空体 ⇒ 白屏事故） | `AgentSideRail.vue:1104-1107`；`historyFetchNoStore.test.ts:50-75` |

### 1.3 会被触发的棘轮 / 静态守卫（动 `AgentSideRail.vue` 前必读）

| 守卫 | 判据 |
|---|---|
| `scripts/verify-is-mobile-layout-scope.py:25,88,168,173` + `AgentSideRail.closePanelDock.test.ts:158-164` | SFC 内 `isMobileLayout` 读取点**恰好 11**，`isDesktopDock` ≥14；抬 `MAX_ALLOWED` 有方向判据 |
| `AgentSideRail.defineExpose.test.ts:26-41` | `defineExpose` **11 项精确集合相等** |
| `AgentSideRail.historyFetchNoStore.test.ts:83-86` | 组件源码**不得出现 `thread-state` 字面量** |
| `streamRecovery.test.ts:54-70` | `fetchThreadStateSafe` / `ThreadStateRead` / `shouldInjectUnreachableSnippet` / `RECONCILE_NULL_THRESHOLD` 不得复活 |
| `styles/text-token-guard.test.ts:31-44`、`design-token.test.ts:195`、`neoUsageRatchet.test.ts:64-78` | 禁 10/11/12/13px 字号字面量、`var(--lnk-*)` 必须有定义、零 `--neo-*` |
| `agentSingleScrollOwner.test.ts`、`viewUnification.guards.test.ts` | 模板顺序 / 滚动宿主唯一 / 共享 presentation 层不读 `isMobileLayout` |

---

## 2. 根因：终态信息在前后端契约里**双向丢失**（本刀必须先裁决的矛盾）

母计划 W1c-2 写的是「state 为 answered/expired ⇒ 卡片呈终态不可提交」。但当前真实契约：

```
                    ┌── state API：getPending 只查 pending && expiresAt>now
   门已终态  ───────┤   ⇒ pendingInterruption = null（没有任何终态字段）
                    └── getMessages：suppressTerminalGateCards 把该 callId 的
                        canvas_command{ask_user} 从响应副本删除
                        ⇒ replayTimelineEvents 连 question part 都建不出来
```

⇒ **state 不给、历史也不给**，前端既拿不到「已 answered/expired」的事实，也拿不到卡片本体。
结果就是当前生产行为：终态门的卡片**直接消失**，既不是「可点卡」也不是「终态只读卡」。
W1c-2 在现契约下**无法实现**，必须先补一条 additive 的数据通路。

同时 W1c-1 也并非「从零建卡」：P1c enrichment + `normalizePersistedTimelineEvent` 已经能在
刷新时重建 `pending_answer` 卡。真正缺的是**权威性**——重放出的活卡没有经过门状态校验。
若服务端门已 expired 但 1min sweep 尚未跑、或断流丢了 `waiting_user{resolved}` 帧，
前端仍会显示可点卡 ⇒ 正是母计划 §3.1 要消灭的「卡片活着但点了执行不了」假交互。

---

## 3. 决策表（D1 需要用户拍板，其余为规格既定）

### ⭐ D1：终态数据通路怎么补 —— 三案，推荐 A

| 案 | 做法 | W1c-1 | W1c-2 | 代价 / 风险 |
|---|---|---|---|---|
| **A（推荐）** | **服务端 additive 扩展 state**：`getThreadResumeState` 新增 `interruption` 字段，返回该 thread 最近一条 `PendingInterruption` 的完整摘要（含 `status: pending/answered/expired/aborted`、`questions`、`expiresAt`）；原 `pendingInterruption` 字段语义**一字不改**；`suppressTerminalGateCards` **不动** | ✅ 权威校正 + 补建 | ✅ 终态卡可见且不可提交 | 跨前后端一刀；`apps/server` + `apps/web` 合并即触发生产发布 ⇒ 需单独授权；新增 1 个只读字段，零迁移 |
| B | 纯前端，只消费现有 `pendingInterruption` | ✅ 只能校正活卡 | ❌ 终态卡仍消失（历史卡片事件已被删） | 面最小，但 W1c-2 判据无法达标，须显式降级为 No-Go 并回填母计划 |
| C | 改 `suppressTerminalGateCards`：终态卡不删、改打终态标记下发 | ✅ | ✅ | 要重定义 P1c-6「历史无 `pending_answer` 形态」判据、SSE 侧也要同步、动已验收的 P2 服务端判据 ⇒ **不推荐** |

> **推荐 A 的理由**：只加字段、不推翻任何已验收判据（`pendingInterruption` 语义不变 ⇒
> `eventLedger.test.ts:219` / `p2Interruption.test.ts:234-235,249-252` 全部原样绿），
> 一次性把 W1c-1/2 都做成真闭环，且 `expiresAt` 由持久化权威驱动（不依赖 sweep 及时性）。

### D2：state 是**唯一权威**，历史是**呈现素材**
- 有 `interruption.status==='pending' && expiresAt > now` ⇒ 必须存在同 callId 的 `pending_answer` part；
  历史无 part（被抑制 / 老行 / 账本缺口）⇒ 从 `interruption.questions` **补建**。
- 其余情况（终态 / `expiresAt` 已过 / 无记录但该 callId 有活卡）⇒ 把活卡**翻终态**，不删卡。
- 终态且历史无 part ⇒ 补建一个终态 part，保证「卡片可见但不可提交」。

### D3：终态理由映射
`answered → answered` / `aborted → declined` / `expired → expired` / `timeout(过时 but status pending) → expired`。
新增 `question.status: 'expired'`；`AgentTurnTimeline.vue` 的 `v-else` 文案扩为「已回答 / 已跳过 / 已超时」。
`waiting_user{resolved}` 的 live 分支按 callId 翻终态时仍按现理由映射（`resolveProposalStatusByReason` 同构），
但**不改** `:767-775` 现有对 proposal 的行为（避免掀开 P3 多卡判据）。

### D4：单一出处，不动 `AgentSideRail.vue` 模板 / 样式
新增独立纯函数模块 `apps/web/src/components/agent/interruptionState.ts`：
`fetchInterruptionState(threadId, fetchImpl?)`（GET、`cache:'no-store'`、`AbortSignal.timeout`、403/异常 fail-open）
与 `resolveInterruption(summary, now)`（纯决策，输出 `{ callId, targetStatus, questions }`）。
实际应用落在 `turnTimeline.ts` 的 `reconcileTimelineInterruption(timeline, summary, now): boolean`
（它才持有 `TimelinePart` 的稳定 id 语义），store 只暴露 `applyInterruptionState(summary, now): boolean` 转发。
接线收敛到 `loadHistory()` 成功分支 + `reconcileLatestAssistant()` **两处**
（覆盖 bootstrap / selectThread / visibility / pageshow / reconnect / 断流 finally 全部恢复入口）。
`AgentSideRail.vue` 只加 import + 2 处调用，**零模板、零样式、零 `isMobileLayout`、零 `defineExpose` 变更**。

### D5：命名避开 H1-c 退役钉子
新端点路径是 `/api/agent/threads/${threadId}/state`，**不含** `thread-state` 字面量 ⇒ 不撞守卫。
**已核清守卫口径**（`AgentSideRail.historyFetchNoStore.test.ts:28,32,40`）：
`code = stripComments(readFileSync('AgentSideRail.vue'))` ⇒ **注释被剥离**，所以
`AgentSideRail.vue:2091` / `streamRecovery.ts:13` 注释里的 `thread-state` 字样不触发守卫。
⇒ 精确约束：新增的**可执行代码**（含字符串字面量）不得出现 `thread-state`；注释不受限。
本刀仍统一不在新代码里写该词，避免与 H1-c 退役语义混淆；且**不复活**退役导出符号
`fetchThreadStateSafe` / `ThreadStateRead` / `shouldInjectUnreachableSnippet` / `RECONCILE_NULL_THRESHOLD`。
旧 `refreshThreadCheckpoint()` 保持 `syncCancelledFromThreadState(null)` 不动（H1-c 语义），
新逻辑另起入口，不「复活」死端点。

### D6：live 事件优先，state 只用于恢复时刻
state 拉取只在「历史重建 / 恢复」时应用；SSE 实时 `ask_user` / `waiting_user{resolved}` 到达后不再用
陈旧 state 反向降级。竞态护栏：拉取带 threadId 与请求序号，响应回来时若 `agentThreadId` 已变化则丢弃。

---

## 4. 变更设计（按 D1 方案 A）

### 4.1 服务端（additive，零迁移）

| 文件 | 改动 |
|---|---|
| `apps/server/src/agent/pending-interruption.service.ts` | 新增 `getLatest(threadId)`（不限 status，按 `createdAt desc` 取一条），复用 `getPending` 的 questions 解析；`getPending` 原实现不动 |
| `apps/server/src/agent/agent.service.ts` | `getThreadResumeState` 返回类型与返回体新增 `interruption: InterruptionSummary \| null`；**`pendingInterruption` 字段保持原样** |
| `apps/server/src/agent/agent.controller.ts` | 仅注释同步（端点路径、DTO 不变） |
| `apps/server/src/agent/agent.service.eventLedger.test.ts` / `agent.service.p2Interruption.test.ts` | 补 S4/T4 的 `interruption` 断言；新增「终态门返回 `interruption.status`」用例 + 变异自检 |

`InterruptionSummary` 形状（新增类型，与 `PendingInterruptionSummary` 并存）：
```ts
{ callId: string; kind: string; questions: unknown[]; expiresAt: number;
  status: 'pending' | 'answered' | 'expired' | 'aborted' }
```
> 老会话（表无行）⇒ `interruption: null`、`pendingInterruption: null` ⇒ 前端零改动直通（阴性保证）。
> 前后端各自声明同名 `InterruptionSummary`，**不引跨包运行时依赖**（RB-D7 纪律：
> `apps/web` 不 import server 类型，靠形态一致 + 双端单测约束）。

### 4.2 前端

| 文件 | 改动 |
|---|---|
| `apps/web/src/components/agent/interruptionState.ts`（新） | `fetchInterruptionState` + `resolveInterruption(summary, now)`（纯决策）+ `InterruptionSummary` 类型；可注入 fetch |
| `apps/web/src/components/agent/turnTimeline.ts` | question part `status` 联合加 `'expired'`；新增 `reconcileTimelineInterruption(timeline, summary, now): boolean`（稳定 id `question:${callId}`，已存在只改状态/题面，不追加；返回 `changed`） |
| `apps/web/src/stores/agent.ts` | 新增 `applyInterruptionState(summary, now): boolean`：转发到上者，只作用于**最后一条 assistant timeline**；`pendingQuestion` computed 天然只认 `pending_answer` ⇒ 终态卡不再被 `sendMessage` 拦截（`:1680-1709`） |
| `apps/web/src/components/agent/AgentSideRail.vue` | script 块：`loadHistory()` 成功分支 + `reconcileLatestAssistant()` 各挂一次 state 拉取；带 threadId 竞态护栏；`authHeaders()` 复用 `:1380-1383` |
| `apps/web/src/components/agent/AgentTurnTimeline.vue` | `v-else` 文案三态（已回答 / 已跳过 / 已超时）；令牌沿用 `var(--lnk-text-muted)`，不新增字号 / hex |
| `apps/web/src/components/agent/AskUserCard.vue` | **不改**（终态由父级 `v-if` 挡住，`v-if` 不渲染即不可能提交） |

### 4.3 恢复入口覆盖（D4 两处接线即全覆盖）

```
bootstrapThread / selectThread ─┐
reconcileOnVisible(visibility / pageshow) ─┤→ loadHistory() ──────────┐
reconnectStream ────────────────┘                                     ├→ applyInterruptionState
main stream finally / observer settled → reconcileLatestAssistant() ──┘
```

---

## 5. 影响面矩阵

| 改动 | 会静默坏掉什么 | 守卫 |
|---|---|---|
| 新增 `interruption` 字段 | 旧前端不认识（无害）；但**不能改** `pendingInterruption` ⇒ 4 条已上线单测 | `eventLedger.test.ts:219`、`p2Interruption.test.ts:234-235,249-252` |
| 新 GET 忘 `cache:'no-store'` | ETag 304 空体 ⇒ 恢复路径静默中断 | `historyFetchNoStore.test.ts`（新增同款钉子） |
| 新增可执行代码引入 `thread-state` 字面量 / 复活退役导出 | H1-c 棘轮 RED（`code` 已剥注释 ⇒ 注释不算命中） | `historyFetchNoStore.test.ts:40,83-86`；`streamRecovery.test.ts:54-70` |
| `AgentSideRail.vue` 动模板 / 加 `isMobileLayout` | 11 读取点 / `defineExpose` 11 项 / 滚动宿主 / 字号棘轮 | 见 §1.3 全表 |
| `suppressTerminalGateCards` 被改 | P1c-6「终态不下发活卡片」判据失效 | `p2Interruption.test.ts:254+` —— **本刀禁止触碰** |
| state 晚到覆盖 live 事件 | 用户刚答完卡又被翻回 pending | D6 竞态护栏 + 单测 |
| 403 / 超时 / 老会话 | 整页历史不渲染 | fail-open：异常一律 `null`，直通现状 |

---

## 6. No-Go（本刀明确不做）

- ❌ 不改 `suppressTerminalGateCards` / 不动 `PendingInterruption` 表结构 / 不加迁移。
- ❌ 不改 `services/pi-runtime/**`、不改 `skills/**`（独立 K3s 部署单元，P2 plan R3 已裁定）。
- ❌ 不复活 `agent/thread-state` 死端点、不改 `refreshThreadCheckpoint()` 的 H1-c 语义。
- ❌ 不摘除 `waiting_user` / `turn_settled` 的 metadata 直写（P1c R7 边界）。
- ❌ 不回填存量 `waiting_user` 行、不改 `/answers` 契约、不改 `AskUserCard` 交互。
- ❌ 不做 A-6 真机走查（本环境不可代跑）、不做严格「重启前后同一 pending 门」对比（重启有 ~30s 502，需单独授权）。
- ❌ 不动 `propose_plan` / `plan_proposed` 相关分支（#831/#839 主线，避免并行窗口重叠）。

---

## 7. 风险锚

1. **403 fail-open**：`assertThreadOwner` 在无 Session / 跨用户 threadKey 下会 403（生产复测已实证）。
   前端必须把 403 当「无摘要」，绝不告警、绝不阻断历史渲染。
2. **ETag 304**：所有 GET 状态类请求必须 `cache:'no-store'`（2026-10-28 白屏事故同源）。
3. **sweep 时差**：1min sweep 只改 DB `status`，`expiresAt` 本身才是权威 ⇒ 前端必须自判
   `status==='pending' && expiresAt > Date.now()`，不能只信 `status`。
4. **多卡**：生产实证过 4 张 ask_user 卡（`turnTimeline.ts:768` 注释）；补建 / 翻终态必须按
   `callId` 精确匹配，绝不「翻第一张」。
5. **老会话阴性保证**：表无行 ⇒ 零改动直通，避免把有机历史会话渲染出新卡。
6. **`deduped` 已有兜底**：刷新恢复出的卡若提交时门已终态，`useAgentPropose.ts:145-150`
   会把答案降级为普通 user message，不会静默吞答案 ⇒ 本刀不得改这段。

---

## 8. 验收边界（禁止 ALL_PASS）

- 本刀能闭环：W1c-1/2/3 单测 + 变异自检 + CI 全绿 + 合并树 == CI 验证树 + 生产取证（dist 锚点、
  state API 新字段、终态会话不回归）+ 生产复测（受控 pending 门刷新重建 / 终态卡）。
- 本刀**不能**闭环：A-6 真机走查（iOS Safari + Android Chrome + 鉴权会话）、SSE `Last-Event-ID`
  真机抓包、严格重启前后同一 pending 门对比、82 条历史 `truncated` 分层归因、D2–D7 排期。
- 生产复测流量必须显式带 `model:'platform::agnes-2.5-flash'`（默认 `agnes-2.0-flash` 免费额度长期 429）。
- 受控数据清理须「双端 sha256 备份 + Prisma 事务 + 计数硬守卫」，`PointTransaction` 账务不可变不删。
