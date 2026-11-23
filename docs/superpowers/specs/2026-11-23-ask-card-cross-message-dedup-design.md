# 规格：ask_user 确认卡「整卡重复 ×2」根治——跨消息单门 + 历史重放自洽

- 日期：2026-11-23
- 状态：已拍板（用户选 A+B 组合）
- 生产案例：会话 `cmwta4mxl09b2ld014nml823m`（确认卡「完成QA质检 + 继续推进EP03剧本」出现 2 个实例，用户各点一次「开始执行」）；同族前案 `cmw7kmv3x01q4r401i7ir33b4`（4 张卡，PR 只修了翻牌错位）
- 关联：`2026-11-23-plan-confirm-duplicate-title-rootfix-design.md`（PR #991，修的是**卡内**双标题，是另一个真实缺陷，与本规格的**整卡 ×2** 互不替代）

## 1. 问题描述与边界

用户在 SSE 对话流中看到**同一张确认卡出现两个实例**，均为可点击状态，各点一次「开始执行」。服务端幂等（pending-registry deduped）兜住了双执行，但渲染层重复成立。

**边界**：本规格只治「整卡多实例」。卡内标题分层（question vs plan.summary）见关联规格。

## 2. 根因链（四环，生产取证 + 代码级证实）

数据层铁证：整轮 1 次 `propose_plan`（callId `call_c805...`）、1 条 `waiting_user{resolved,answered}`、1 条 `decision=execute`。**重复纯在前端渲染层**。

| # | 环节 | 位置 | 机制 |
|---|------|------|------|
| 1 | **读面剔除终态卡事件** | `apps/server/src/agent/agent.service.ts:842,852` `suppressTerminalGateCards` | 门 answered 后，响应副本剔除 `canvas_command{ask_user}` ⇒ **answered 后的历史重放建不出卡**。其前提（reducer 无条件翻 pending）已被现行 replay 翻牌（`turnTimeline.ts` waiting_user resolved 按 callId 翻）+ W1c 兜底取代，剔除如今只制造「重放无卡」缺口 |
| 2 | **恢复靠 W1c 安全网补建** | `apps/web/src/components/agent/turnTimeline.ts:1444` | replay 无卡时从服务端 interruption state 补建卡（设计即知「历史无该事件」场景） |
| 3 | **双 assistant 消息并存** | `apps/web/src/stores/agent.ts:988` `loadHistory` 合并判定 | 仅 `streaming` 状态的本地气泡让位；断流/恢复后 finalized 的本地消息（本地 id 不命中 historyIds）**永不让位** ⇒ 同一轮两条 assistant 消息共存 |
| 4 | **跨消息单门失效**（致命） | `apps/web/src/stores/agent.ts:1193` `applyInterruptionState` | 只 reconcile **最后一条** timeline；`waiting_user{resolved}` 也只喂当前活跃消息 ⇒ 旧消息里的活卡无人翻牌，长期 pending 可点 |

**用户视角还原**：旧消息卡A（live 建，pending）+ 恢复补建卡B（pending/终态）同屏；点卡A「开始执行」生效、点卡B 被 deduped（或反之）；resolved 事件只翻一条，另一张永远挂着。

## 3. 第一原则·等价物检索结论表

| 判据 | 结论 | 证据 |
|------|------|------|
| ① 等价物检索 | **有**：W1c 单门语义（`reconcileTimelineInterruption`）已是权威设计，缺的只是**作用域**（单条→跨消息）；服务端账本（AgentEvent）+ 读时 enrichment（`enrichAssistantPage`）已保证活门事件可重放 | `turnTimeline.ts:1388`；`agent.service.ts:905-952` |
| ② 接线优先于新建 | **接线**：A 方案全部复用 `reconcileTimelineInterruption` 的翻牌语义与 `waiting_user{resolved}` 的 reason→终态映射；B 方案是**删除**一段失效防线（P2 剔除），不新增机制 | 见 §4 |
| ③ 禁造数/禁自报 | 判据全部来自生产 executionEvents 回读与代码行号，无自报 | §2 |

上游参照：pi-agent-core 0.99.2 无内置确认卡原语（自建合理）；上游 `ui_prompt_start/end` 是嵌套深度计数的生命周期信号、无跨消息去重职责——跨消息对账属宿主职责，本仓已有 W1c 框架，补全作用域即吃满自身资产。

## 4. 方案（A+B 组合，已拍板）

### A1 跨消息单门（前端）

- `turnTimeline.ts` 新增 `retireStaleQuestionParts(timeline, summary)`：非权威消息 timeline 里所有 `pending_answer` 的 question part 一律终态化（summary.status==='answered' ⇒ 'answered'，否则 'expired'）。**不补建、不保位语义之外的动作**——权威卡只在最后一条消息由 `reconcileTimelineInterruption` 维护。
- `stores/agent.ts` `applyInterruptionState`：先对最后一条有 timeline 的 assistant 跑 `reconcileTimelineInterruption`（现行为），再对**其余** assistant 消息逐条跑 `retireStaleQuestionParts`。

### A2 waiting_user{resolved} 全局翻牌（前端）

- `stores/agent.ts` `trackWaitingUser`（waiting_user 喂入口）：`status==='resolved' && callId` 时，先**全局**扫描所有 assistant 消息 timeline，把同 callId 的 pending question part 翻终态（reason 映射与 reducer 一致：answered→answered、aborted→declined、timeout/其他→expired）；proposal part 同构处理（同 callId pending_confirm 翻终态）。然后照旧 feedTimeline（当前活跃消息 reducer 逻辑不变，幂等）。

### B 删除读面终态卡剔除（服务端）

- `agent.service.ts` 删除 `suppressTerminalGateCards` 方法与 `:842` 调用。理由：
  1. 其前提（reducer 无条件翻 pending）已失效——replay 事件序 `canvas_command`(建 pending) → `waiting_user{resolved}`(按 callId 翻终态) **自洽**，终态卡不会复活；
  2. W1c 兜底（state 权威翻终态）+ A1 跨消息单门构成双保险，覆盖 resolved 事件缺失的老行；
  3. 保留事件让历史回看保真（确认卡可见），并消除「重放无卡 → 安全网补建 → 跨消息双卡」的温床。
- 同步改 `agent.service.p2Interruption.test.ts`：原用例锁「终态卡被剔除」；改为锁「终态卡保留 + 重放自洽翻终态」（配合前端 replay 测试）。**注释里不得出现受看守 token 字面量**（CI 棘轮纪律）。

### 明确不做

- 不改 `loadHistory` 的 streaming 让位判定（双消息在分段落库模型下部分合法，A1/A2 已把跨消息卡状态收敛，双消息仅剩展示冗余、无双活卡风险）。
- 不在 UI 层做任何字符串/文本相等隐藏。

## 5. 验收判据

1. 前端测试：新增「双消息 + W1c answered ⇒ 旧消息卡翻终态、新消息权威卡唯一」用例；`waiting_user{resolved}` 跨消息翻牌用例；现有 mergeHistory/turnTimeline 测试全绿。
2. 服务端测试：p2Interruption 用例改写后全绿；`tsc --noEmit` 0。
3. 变异自检：还原 `applyInterruptionState` 旧行为（只 reconcile 最后一条）⇒ 新用例 RED。
4. 生产复测：复测会话中构造「点击确认 → 刷新/断流恢复」序列 ⇒ 对话流中同 callId 卡唯一且终态正确；连续两次点击第二次 deduped。
