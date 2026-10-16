# 回合身份与单一写者 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除「一次 run 被记 N 本账」类事故（生产实证：画布 `cmv9hmpph001qoa017y9rv312` 一次 run 落 4 条助手消息，全库 69/400 带漂移签名）。做法是补齐**两层标识**（回合身份 `runId` + 全局序号 `gSeq`），并把写者唯一性交给**上游 409（LaneBusy）+ DB 唯一索引**裁决。

**Architecture:** 三层递进。① **止血**：Nest 不再吞 409 —— 409 即 `NotIdle`，把该流转为**纯旁听**（转发事件、`finalizeTurn` 不落库）并下发结构化 `turn_not_submitted{reason}`。② **立身份**：pi-runtime 归一化补 `runId`，Nest 落库字段补 `gSeq`，落库改 `(threadId, runId)` upsert（先到先得，后来者 no-op）。③ **呈现降级**：孤儿 `tool_result` 不再伪造工具行，阻塞期出三态确认卡。**不引入进程内 run 注册表与 owner 提升机制**（见 §规格 §2 明确不做）。

**Tech Stack:** apps/server（NestJS + Prisma/SQLite）、services/pi-runtime（TypeScript ESM、`@earendil-works/pi-agent-core` 0.85.1）、apps/web（Vue 3 + Pinia）。

**Spec:** [docs/superpowers/specs/2026-10-17-agent-turn-identity-design.md](../specs/2026-10-17-agent-turn-identity-design.md)；审核依据 [Codex 源码对照审核](../specs/2026-10-17-agent-turn-identity-codex-review.md)。

## Global Constraints

- 分支：`feat/turn-identity-single-writer`（已从 `origin/master` 建于 worktree `.worktrees/turn-identity`）。每 Task 独立 commit（conventional commits）；**禁 `git add -A`**，只 add 本任务点名的文件；push 前 `git status --short` 必须为空。
- ⚠️ **Bash cwd 会话内会静默重置回主仓根**：每条命令自带绝对路径或 `git -C <abs>`；跨命令零信任。
- 测试（**targeted，本机不跑全量套件** —— 全量是 CI 的活，见 `docs/agent/delivery.md`）：
  - `cd .../apps/server && npx vitest run src/agent/<文件>.test.ts`
  - `cd .../services/pi-runtime && node --import tsx --test src/<文件>.test.ts`
  - 类型检查：`cd .../services/pi-runtime && npx tsc --noEmit`（Nest 侧 `npx tsc --noEmit -p tsconfig.json`）。
  - vitest 单文件超时 ≠ 失败；字符串逻辑断言可用 `node -e` 秒级替代。
- zsh 纪律：变量紧跟冒号必加花括号（`${R}:path`）；诊断命令**禁** `2>/dev/null` 吞 `fatal:`。
- **两处待批准（AGENTS.md 红线）**：① `schema.prisma` 加 `runId` 列 + 唯一索引的一次 additive 迁移（Task 8）；② pi-runtime 镜像需**手工 dispatch `runtime-deploy`**（tag = master 短 SHA）才到生产（Task 7 之后）。
- 注释纪律：写「为什么」，正面记录被删历史/既有约束；禁占位 TODO。

## Review Focus

规格隐含但单测之外的失败模式（每条已在 owning Task 钉测试或验证步骤）：

1. **驱动流全断** ⇒ PR1 期间可能无人落库（比重复更糟）。→ PR1→PR2 间隔必须短；Task 9 的 upsert 补上后消除。
2. **`generation-recovery.drainConversation` 是第三个写者**（生产 `GENERATION_RECOVERY_ENABLED=true`）。→ Task 10 必须纳入同一 upsert 键，否则前功尽弃。
3. **序号被淘汰**（buffer 滑动）⇒ 补不全。→ Task 9 标 `partial` + `gapFrom`，**不**冒充全量（N4）。
4. **阻塞期 steer 消费不到**（上游注释：连 checkpoint 边界都没有）。→ 不得退化成新开流；只能走 `/answers`（Task 12）。
5. **内容指纹误判**：同一句话 5 分钟后重发是合法新回合。→ 主判据必须是因果围栏，hash 只辅助（N5，Task 13）。
6. **历史修复误杀**：互不为子集的两条一律不动。→ Task 14 输出清单供人工抽样，不全自动删。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `apps/server/src/agent/agent.service.ts` | Modify | 409 判定分流（Task 2）、`pushTraceEvent` 加 `gSeq`（Task 3）、`finalizeTurn` upsert + 补全（Task 9） |
| `apps/server/src/agent/pi-runtime/pi-events.ts` | Modify | `UiEvent` 增 `runId?`（Task 1） |
| `apps/server/src/agent/agent.service.pi-runtime.test.ts` | Modify | 分流与落库断言（Task 2/3/9） |
| `services/pi-runtime/src/session-manager.ts` | Modify | `NormalizedEvent` 增 `runId` + dispatch 打戳（Task 7） |
| `services/pi-runtime/src/session-manager.test.ts` | Modify | runId 透传断言（Task 7） |
| `apps/server/prisma/schema.prisma` | Modify（**待批准**） | `runId` 列 + `@@unique([threadId, runId])`（Task 8） |
| `apps/web/src/components/agent/turnTimeline.ts` | Modify | 排序 `gSeq ?? seq`（Task 4）、孤儿降级（Task 11） |
| `apps/web/src/components/agent/AgentSideRail.vue` | Modify | 阻塞期三态卡（Task 12） |
| `apps/server/src/agent/agent.service.ts:661` | Modify | `getThreadState` 填真值（Task 13） |
| `scripts/repair-duplicate-turns.ts` | Create | 历史扫描 + 软标记（Task 14） |

---

## PR1 · 止血（无 pi-runtime 依赖，可独立上线）

### Task 1 · UiEvent 预留 runId 字段 ✅ 已完成

- [x] `apps/server/src/agent/pi-runtime/pi-events.ts`：`PiRuntimeEvent` / `UiEvent` 均增 `runId?: string`，`ui()` 构造处透传 `event.runId`（runtime 尚无该字段时为 `undefined`，零回归）。
- [x] 验收：`pi-events.test.ts` 定向跑通（`toEqual` 忽略 undefined 字段）。

### Task 2 · 409 判定分流（核心止血）✅ 已完成

- [x] `agent.service.ts`（原 `void client.prompt(...).catch(...)`）改为 **await 判定后分流**：
  - 200 ⇒ `owner`：沿用现行累积 + `finalizeTurn`。
  - 409 ⇒ `shadow`：事件**照常转发**（进度可见），但**不结算、不 `finalizeTurn`**；下发 `turn_not_submitted{reason:'not_idle'}`；发言走 `steer` 队列。
  - 其他错误 ⇒ **刻意不置 shadow**（网络超时时 run 可能已被接受，误判会让整轮消息彻底不落库，比重复更糟），维持现状交给 SSE error 事件。
- [x] steer 入队失败 ⇒ `reason:'not_steerable'` + `piLogger.warn`。
- [x] `AgentStreamEvent` 联合类型增 `turn_not_submitted`（`packages/agent/src/types.ts`）—— 409 是传输层信号，语义太薄，UI 拿不到 reason 就分不出「已并入 / 当前不可插话」。
- [x] 验收：新增 `agent.service.turn-identity.test.ts`（5 例全绿），覆盖 owner / 409 / 409+steer 失败 / 非 409 / gSeq。
- [ ] **变异验证**（待做）：把 409 分支改回 owner，测试必须红。

> **实现要点（与计划的两处偏离，均为实证驱动）**
> 1. **可以安全 await prompt**：`client.prompt` 是「接受即返回」（pi-runtime 内 `void lane.prompt(...)` 后立刻回 202），不会等到 run 结束；且订阅已先建立（`live:true` from=now），等待期间的事件由 `iteratePiEvents` 内存队列承接 ⇒ 拿到确定身份且不丢首事件。**因此不需要「进程内 run 注册表 + 断流提升」**。
> 2. **shadow 不另设累积开关**：`executionEvents` 的唯一出口就是 `finalizeTurn`，掐掉落库即掐掉记账；少改一处就少一处分叉风险。

### Task 3 · 落库持久化全局序号 gSeq ✅ 已完成

- [x] `packages/shared/src/agentTrace.ts`：`PersistedExecutionEvent` 增 `gSeq?: number`（附「与局部 `seq` 的区别」注释）。
- [x] `agent.service.ts`：`pushTraceEvent` 写入 `gSeq: currentPiEvent?.seq`。
  - ⚠️ 实现取舍：原计划是给 11 个调用点逐个透传，实际改为**事件循环在每轮开头赋值 `currentPiEvent`、pushTraceEvent 只读** —— 避免把改动面扩散到每段事件提取逻辑（那些逻辑本身不关心 seq）。单线程生成器内无并发写。
- [x] 验收：单测断言 `gSeq === 4242` 且局部 `seq === 1`（两条编号空间的差异被钉住）。
- [x] **变异验证**：把 `if (turnRole === 'shadow')` 改成 `if (false)` ⇒ 409 两例立刻转红（另 3 例仍绿），已还原。

### Task 4 · 前端排序改 gSeq 优先 ✅ 已完成

- [x] `apps/web/src/components/agent/turnTimeline.ts` `replayTimelineEvents`：排序键改 `gSeq ?? seq`（`sortKey` 提取为局部函数，`events.every` 的类型守卫同步跟上）。
- [x] 全仓检索确认：**只有这一处**按 `seq` 排序（无其他排序点遗漏）。
- [ ] 验收：`turnTimeline.test.ts` 定向跑通；老消息无 `gSeq` 维持原序（回退分支已保留）。

### Task 5 · 观测指标（PR1 部分 ✅；余量在 PR2）

- [x] `turn_not_submitted{reason=...}` —— 已以 `piLogger.warn` 稳定 token 落盘（Nest 侧无 metrics 服务，项目现有惯例就是可 grep 的 warn token）。
- [x] `turn persist skipped (role=shadow, reason=...)` —— shadow 跳过落库时同样留痕。
- [ ] `duplicate_turn_persist`（**恒 0**）、`persist_ordinal_gap`（**恒 0**）随 PR2 的唯一索引与重放补全一并落地（Task 9/10）。

### Task 6 · PR1 收尾

- [ ] `npx tsc --noEmit` 过；`git status --short` 空；commit + push；开 PR 盯 CI 全绿。

---

## PR2 · 立身份（**依赖 pi-runtime 手工发版**）

### Task 7 · pi-runtime 透传 runId

- [ ] `services/pi-runtime/src/session-manager.ts`：`NormalizedEvent` 增 `runId?: string`；`run_start` 置 `entry.currentRunId`、`run_end` 清；`dispatch` 打戳取 `evt.runId ?? entry.currentRunId`（`message_start/end` 上游 runId 是 optional，必须靠当前 run 兜）。
- [ ] 单测：`session-manager.test.ts` 追加「run 内事件 runId 一致、run 结束清空」。
- [ ] 合入后**手工 dispatch `runtime-deploy`**（待批准）。

### Task 8 · 数据模型（**待批准红线**）

- [ ] `apps/server/prisma/schema.prisma`：`AgentMessage` 增 `runId String?` + `@@unique([threadId, runId])`。
- [ ] 迁移为 additive 可空列：SQLite 下 NULL 互不冲突，存量零回填，可回滚。

### Task 9 · 落库改 upsert + 账本补全

- [ ] `finalizeTurn` 改按 `(threadId, runId)` upsert：先到先得，后来者 no-op 并计 `duplicate_turn_persist`。
- [ ] 落库前取 `run_start` 的 `gSeq` 为 `startSeq`；`isReplayComplete(startSeq)` 为假 ⇒ 标 `metadata.partial=true` + `gapFrom`，**不**冒充全量（N4）。
- [ ] 纯函数 `mergeExecutionEvents`（按 gSeq 归并去重）+ `isLedgerComplete` 单测；**变异**：删去重分支必须红。

### Task 10 · recovery 纳入同一键

- [ ] `generation-recovery.service.ts` 的 `drainConversation` 走同一 upsert 键（第三写者）。
- [ ] 验收：模拟「recovery 与主流同时结束」⇒ 库内 1 条。

---

## PR3 · 交互与降级（可与 PR1/PR2 并行）

### Task 11 · 孤儿事件与 partial 降级

- [ ] `turnTimeline.ts:326-345`：`tool_result` 找不到前置 `tool_call` 且时间线内无更早同工具 ⇒ 渲染 notice「本轮前半段事件未捕获」，**不** push 工具行。
- [ ] `partial` 回合顶部标注缺口。
- [ ] 验收：用生产 bundle 已确认的逻辑对照；单测覆盖「空 parts 上的首个 tool_result」。

### Task 12 · 阻塞期三态卡

- [ ] `AgentSideRail.vue`：propose 等待态出确认卡（确认 / 取消 → `/answers` `decision:"decline"` / 改需求 → answers 文本通道）；三态 UI：等待中 → 已并入当前提议 → 已取消。
- [ ] **decline 后必须回可输入空闲态**（否则制造第二次沉默）。
- [ ] 验收：S6 真跑一遍。

### Task 13 · 服务端权威门控

- [ ] `agent.service.ts:661` `getThreadState` 从「恒 null」填为 `{ activeRun, runId, phase }`（端点、鉴权、前端调用方均已存在，零新增接口面）。
- [ ] `streamRecovery.ts:134-138` 幂等键：主判据改**因果围栏**（客户端带 `lastTurnId`），内容 hash 降为辅助（N5）。

---

## PR4 · 历史数据（必须在 PR2 上线后跑）

### Task 14 · 扫描与软标记

- [ ] `scripts/repair-duplicate-turns.ts`：按 `(threadId)` 分组，用 **`ts + type + 数据指纹`** 判定子集关系（**不能用 seq** —— 落库 seq 是本地序）。
- [ ] owner 取**事件集最大者**；互不为子集 ⇒ **不动**（宁放过不误杀）。
- [ ] 输出待处理清单供人工抽样复核；影子行写 `metadata.supersededBy`，`linkedOutputs` 去重合并到 owner；读取出口统一过滤。
- [ ] **不**物理删除（观察 1–2 周后再议）；本画布 3 条黄金样本最后处理。

---

## 验收硬表（跨 PR）

| 编号 | 判据 | 方法 | 期望 |
|---|---|---|---|
| A | 同 run 重复落库 | `SELECT threadId,runId,COUNT(*) ... HAVING COUNT(*)>1` | 空集 |
| B | 漂移签名 | 扫描首事件类型占比 | 非 thinking = 0 |
| C | 全局序号连续 | `persist_ordinal_gap` | 恒 0 |
| D | S1 真跑 | propose 等待期发第二条 | 库内 1 条 assistant + UI 确定性反馈 |
| E | 归并幂等 | 变异测试 | 删去重分支必须红 |
| F | 孤儿降级 | 单测 + 生产 bundle 复验 | 不再置顶工具行 |
| G | 历史软标记 | 抽样 3 条 | 前端不渲染、linkedOutputs 无重复 |
