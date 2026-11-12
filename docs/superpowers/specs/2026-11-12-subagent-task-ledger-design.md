# 子代理一等任务单据（D2）：回合完成判定所有权迁移设计规格

> 日期：2026-11-12　|　状态：**待用户 review**（architectural brainstorming 阶段）　|　路径：architectural
> 前置：`outputs/2026-11-11-subagent-result-delivery-diagnosis.md`（只读取证 + 根因）、`docs/superpowers/specs/2026-11-11-subagent-result-delivery-design.md`（D1 规格）、`docs/superpowers/specs/2026-10-21-turn-continuity-design.md`（「权威在 Nest DB」立规）
> 代码基线：**真 master `ba0592834096fc5107d33328d0ae4b3d0db031bc`**（#847 合并树）；`@earendil-works/pi-agent-core@0.99.2`；本地主仓 `5926ac72` 为 0.85.1 陈旧文档分支，**禁止作为改刀依据**
> 实施计划见 `docs/superpowers/plans/2026-11-12-subagent-task-ledger.md`
> **本文及本轮工作：未写任何产品代码、未合并、未部署、未改生产数据。生产侧只做只读取证。**

---

## 1. 意图与成功标准

### 写回理解

用户要求不是「在三个候选里选一个」，而是：以熟悉 pi-agent 上游源码与生态成熟实践、有 Codex 产品开发经历的视角，**充分研究上游、吃满已有能力、吸取 Codex / Claude / WorkBuddy 经验、审视自身架构与实现缺陷、不重复造轮子**，给出针对「子代理执行后无结果、会话静默停止」的**架构级最佳解**，而非单一解或「加指标不治本」的方案。

D1 已修好「回合级诚实」（`turn_interrupted` 落库、零交付不扣费、界面不说谎）并上线。D2 要治的是根因层：**「完成」被建模成 pi-runtime 进程内的一条内存 promise，而不是独立于连接与进程的持久状态转换**。D2 不是给运维加一张可观测表，而是把完成的**权威状态所有权**从 pi-runtime 进程内迁移到唯一跨 pod 存活的持久层，为 D3（结果回注）、D4（有界恢复）、D5（发布互斥）提供可裁决、可枚举、幂等的一等地基。

### 成功标准（可验收）

| # | 标准 | 判据 |
|---|---|---|
| S1 | 子任务成为**独立于 pi-runtime 进程**的一等持久实体 | `SubagentTask` 行在 pod 被替换后仍可查询；与 `tool_call` 同一条提交创建 |
| S2 | 终态由**单点 CAS** 裁决，终态不复活 | 重复 `tool_result` / 重复 `turn_interrupted` / sweep 竞态下只翻一次 |
| S3 | 运维与用户能回答「派出去的那个去哪了」 | 只读查询面返回在途/终态单据；D1 的 `turn_interrupted` 与单据一一关联 |
| S4 | 零 pi-runtime 改动、零新增跨服务链路 | 发布面仅 `apps/server` + additive migration；不触发 `runtime-deploy`；不改 `await attempt.promise` |
| S5 | 判据贴真实生产记录求值 + 变异自检 | 阳性 A（故障会话）/ 阴性 B（正常会话）；删配对帧、错终态、摘除漏斗三类变异必须 RED |
| S6 | 不误伤正常回合 | 阴性样本 B、纯文本断流、挂起回合、shadow 流全部保持既有行为 |

**非目标**：本次不实现 `onUpdate` checkpoint、`lane.followUp()` 回注、孤儿恢复、`pi-durable` upmerge（D3–D7 排期，见 §9）；不做结果续跑。

---

## 2. 分类与范围

**Architectural**：新增一等子任务单据子系统，把完成判定从 `services/pi-runtime` 进程内迁移到 `apps/server` 持久层，涉及 Prisma schema、SSE 事件漏斗、只读 state API，并为后续刀预留接口契约。

**本轮交付 = 规格 + 实施计划（docs-only）**。按用户纪律：触发生产发布的刀 CI 全绿后停在合并前等单独授权；本轮连产品代码都不写。**不合并、不部署、不改生产数据。**

---

## 3. 取证基线（本轮新增，含对诊断原文的两处纠偏）

### 3.1 生产只读取证（2026-11-12，deploy-cvm）

```
pvc/pi-lnk-runtime-sessions  Bound  pvc-4f25d5c7…  5Gi  RWO  local-path  50d
pv/pvc-4f25d5c7…             5Gi  RWO  RECLAIM POLICY=Delete  Bound
deploy/pi-lnk-runtime        strategy=Recreate  terminationGracePeriodSeconds=30  preStop=False
/data/sessions               200 个 session 目录，.jsonl 留存
SUBAGENT_TIMEOUT_MS          300000（services/pi-runtime/src/gate/subagent.ts:10）
```

**结论（比诊断原文更精确）**：诊断把根因写成「父子 run 与工具 promise 一起蒸发」，容易被读成「数据也没了」。实际是——**transcript 与 `pi.lane.state` 都在 PVC 上留存，蒸发的是进程内存态与恢复入口**：`sessions` Map、`SubagentCoordinator`、`attempt.promise`、metrics counter。且 `Recreate` + **grace 30s + 无 preStop** 对 5min 子任务是结构性腰斩：任何跨发版窗口的长任务必被杀。

⚠️ 另有一条风险锚：PVC `reclaimPolicy=Delete` 且 `local-path` 是单节点 hostPath（非网络共享存储）；`values-prod.yaml` 的 3 副本 + RWO 自注为占位。**不能把 pi-runtime 本地盘当作跨 pod 权威层**。

### 3.2 上游 0.99.2 / pi-durable 源码盘点（干净快照，逐文件精读）

| 发现 | 证据 | 对 D2 的影响 |
|---|---|---|
| **两代不是同代能力** | `vendor/.../pi/VENDORED.md:6` 明写 v0.99.2 是 harness（AgentHarness/Lane/drive）**存续最后一版**，v1.0.0 起整体移除改由 Experimental `pi-durable` 承接 | ❌ **纠偏诊断 §4.3「不需要发明新架构，只需对齐上游已写好的那套」**：在 0.99.2 上 pi-durable 契约**不可调用** |
| pi-durable 的存储全是**单进程本地文件** | `durable/README.md:97-105,414-420`：`Memory`/`SQLite(one database file)`/`JSONL(append-only files in one directory)`；明写 `One process owns a storage at a time; there is no cross-process locking`、`commits survive process crashes; the newest may be lost on power or host failure` | 上游持久化承诺**不覆盖 pod 被替换 + 跨 pod 共享**；源码全仓未涉及 K8s/PVC/外部 DB |
| durable 的 `ownership`/`requestId`/`replay:"safe"` 依赖 storage 索引 | `durable/test/examples/22-subagent-foreground.ts:33,41-56`；`harness/submissions.ts:145-153` `submissionByRequest` 去重；`harness/scheduler.ts:212-238` 重启把 `running` 改回 `pending` 并 `resume()` | 幂等链的宿主前提是「同一 storage 重开 + 允许重跑工具」，本项目两条都不成立（见下行） |
| 本项目**主动丢弃** `open[]` 续跑能力 | `session-manager.ts:1551,1566-1586`：孤儿 operation 一律 `requestAbort + lane.drive` 收尾，**绝不 resume 上游 LLM**；`turn-continuity-design.md:128-130`（`cmv3zzid` 612s 事故）立规「孤儿只能是收尾」 | ❌ 不能照抄 durable 的 `replay:"safe"` / `harness.resume()` |
| fork 时子会话 lane 状态被**强制清空** | `vendor/.../session/fork-policy.ts:55-57`：`case "pi.lane.state"` → `{ currentOperationId:null, lastOperationId:null, inbox:[] }` | fork transcript 里没有在途 operation 可恢复 |
| **`pendingToolOutput`/`tool_update` 是全量快照的中途进度** | `agent/src/harness/types.ts:89-93`「Synchronous full-snapshot progress callback」；`progress.ts:90-101` `setValue`（覆盖）；`drive/tools.ts:382-393` 仅 `options.checkpoint===true` 才落盘；`:515-540` 崩溃后只有「删 checkpoint 从零重跑整工具」或「把快照塞进 `interruptedOutcome`」两条路 | ❌ **纠偏诊断 §5 P1.2/1.4「onUpdate + pendingToolOutput 落盘 checkpoint 做恢复」**：上游**不支持续跑仍在跑的工具**；进度快照只能用于交代，不能用于恢复 |
| 0.99.2 的 `followUp`/`steer` inbox **确实落盘** | `lane.ts:1496-1515` 写 `pi.lane.state` + `pi.pending.entry`；`runtime/restore.ts:164-170` 还原 inbox；`runtime/transcript.ts:86-112` 读回消息体 | ✅ 上游已解，D3 回注可以吃满；但 `open[]` 只是报告清单、不自动续跑，且本项目 inbox 有滞留无终态信号的既有实证 |
| `OperationResultRecord` **不含报告内容** | `session/types.ts:107-117`：仅 `operationId/kind/status/error/fromTipId/tipId/startedAt/endedAt`；`run_end.status ∈ completed\|aborted\|failed` | 报告仍需从 transcript 扫；本项目的 4 态 outcome 反而在 `tool_result.result.details` 里更直接 |
| **两代都没有「子任务单据」一等实体** | durable 物理表 `storage/sqlite/migrations.ts:9-85`：conversations/entries/tasks/submissions/documents；`TaskRecord` 无 `report`/`expiresAt`；全仓 `expiresAt` 零命中。0.99.2 harness 无 Task/Conversation/Submission 实体，无 ownership/requestId | ✅ **D2 建单据不是重复造轮子**，恰落在上游承诺空白区（跨 pod 权威 + 超时租约） |

### 3.3 生态实践对照（本轮外部核实，不采信诊断二手断言）

| 产品 | 机制 | 关键证据 |
|---|---|---|
| **Codex** | 完成通知由**父侧 watcher 订阅子线程状态**注入，V2 走 inter-agent mailbox；结果消息 `trigger_turn=false` 排入父队列 | `codex-rs/core/src/agent/control.rs:639-715` `maybe_start_completion_watcher`；`spawn.rs:800-812` V2 排除 watcher |
| **Codex 缺陷（同构）** | **issue #13244**：child 在 watcher 订阅前消失 ⇒ `subscribe_status` 返回 Err ⇒ watcher 静默退出 ⇒ **父线程挂起、无错误、无日志、无 prompt** | 官方 issue，复现用例 `completion_watcher_missing_child` |
| **Claude Code** | 后台为默认（`async_launched`），完成走 harness 注入 `task-notification`；硬约束 **「Never fabricate or predict a pending agent's results — the notification must be injected by the harness」** | `code.claude.com/docs/.../subagents`；`enqueueAgentNotification` / `completeAsyncAgent` 链路 |
| **pi-durable** | background reporter task 两相位 checkpoint，答案到达后以 `followUp` input 回注父对话；`requestId` 防重启重复发 | `23-subagent-background.ts:78-125,205-208,352-362` |
| **WorkBuddy（本项目既有实证）** | 未完成态写进独立文件 / 状态清单，半截输出 + `status:"incomplete"`，`error-recovery` 注入并原地重试 | `turn-continuity-design.md:112-123` |

**四家同构的一条**：把「完成」建模为**独立于连接与父回合 promise 的持久状态转换**，结果由 harness 注入，模型不得自行宣布完成。

**Codex #13244 的额外含义**：连 watcher 都是内存态，订阅晚于 child 消失就会静默失败 ⇒ **光加通知不够，必须有权威的、可枚举的持久单据 + 独立的过期扫描**。这正是本项目事故与 Codex 缺陷的共同解药，也是 D2 不能退化成「加指标」的理由。

### 3.4 自身架构缺陷审视

1. **C4 的「同步阻塞」是验证期简化，不是终局契约**。`2026-10-10-c4-subagent-design.md:24,48-49,113` 明写「同步阻塞返回最终报告」「不预留异步位：验证期不建编排基础设施」「未来异步的真实形态现在想象不准」。当时的取舍是「跨压缩存活、前端零迁移、协议零新增」（三个设计原则全收），代价就是把完成绑在父回合内存 promise 上。生产事故是这个取舍的到期账单，**不是实现 bug**。
2. **诊断 §4.3 的「对齐上游已写好的那套」在 0.99.2 上不成立**（§3.2 第一行），且在 K3s Recreate 场景下即使换轨 pi-durable 也不覆盖（单进程本地存储 + 无跨进程锁）。照抄 = 造一个跑不起来的轮子。
3. **诊断 §5 P1.2/1.4 的 checkpoint 恢复方向被上游证伪**（§3.2 第六行）。D3 必须改用「结果回注走持久化 inbox」而非「进度快照续跑」。
4. **发布层是触发源，且当前无任何护栏**：`Recreate` + grace 30s + 无 preStop + 5min 子任务。D2 只能让事故「诚实可见 + 可裁决」，**不能降低发生率**；降低发生率是 D5（drain / 发布互斥）。不得在 D2 验收里宣称治了触发源。
5. **诊断原文对「蒸发」的表述不精确**：盘在、内存态与恢复入口不在。这直接决定了 D2 的正确动作是**补权威状态与恢复入口**，而不是「再落一份盘」。

---

## 4. 方案对比与裁决

裁决对象是**「完成的权威状态放在哪、以什么为载体」**，不是「在哪张表加字段」。

| 方案 | 做法 | 取舍 | 裁决 |
|---|---|---|---|
| **A. 照抄 pi-durable 契约** | `ownership{kind:"task"}` + `replay:"safe"` + `requestId` + reporter task，落 pi-runtime 本地 storage | v1.x Experimental、0.99.2 不可调用；单进程本地存储不覆盖 Recreate；与既有「禁止 resume 上游 LLM」立规冲突 | ❌ 否决（诊断 §4.3 需纠偏） |
| **B. pi-runtime 侧自建单据 + `/agent/internal/*` 回写** | 子任务 owner 自报状态，Nest 落库 | 事故形态下 pod 被 30s 强杀，回写同样发不出；新增 HTTP 熔断/令牌面/时序竞态；与「同一条提交」相悖；且 pi-runtime 是 K3s 单元，其本地盘非跨 pod 权威 | ❌ 否决 |
| **C. Nest 侧一等单据 + 权威状态迁移（推荐）** | `SubagentTask` additive 表；`pushTraceEvent` 漏斗在 `tool_call` 同一提交开单据；`tool_result` / `turn_interrupted` / 1min sweep 三路 CAS 收口 | 复用 #840 `AgentEvent` + #846 `PendingInterruption` + 既有 1min scheduler 全套范式；零 pi-runtime 改动；与 `turn-continuity-design.md:151,166-169`「权威在 Nest DB / 只有一条真相线」既有立规一致 | ✅ **采纳** |
| **D. 只加 watcher / 通知 / 指标** | 在父侧订阅子 run 状态，终态注入通知 | Codex #13244 已证明 watcher 订阅竞态会静默失败；且 watcher 仍是内存态，pod 替换一起蒸发。**正是用户反对的「加指标不治本」** | ❌ 否决 |

**C 优于「建一张可观测表」的实质**：单据不是日志，而是**控制面**——D3 的 inbox 回注、D4 的有界恢复、D5 的「发布前查在途任务」全部读这张表；D1 的 `turn_interrupted` 从「回合级一次性事件」升级为「与单据关联的持久裁决」。没有它，后面三刀各自都要重新发明状态与幂等键。

### 4.1 幂等键裁决（回答「单据身份」）

- **`requestId = subagent:{callId}`**，其中 `callId` = `tool_execution_start` 帧里的 `toolCallId`（生产事故 A 中即 `call_334ae8e2832146608be265e9`）。命名对齐 pi-durable 的 `subagent:${api.taskId}`，但用 **Nest 侧唯一可见的稳定 id**，因为 0.99.2 的 `SubagentCoordinator.tryRun()` 只有 `piSessionKey` + 内存 promise，**根本没有 taskId**（`gate/subagent.ts:89-109`）。为此新增一个 taskId 需要改 pi-runtime + 手工 dispatch `runtime-deploy`，收益为零。
- 唯一键沿用 P2 同款 `@@unique([threadId, callId])`，`@@unique([requestId])` 作全局幂等锚。
- `callId` 与 D1 的 `outstandingToolCallIds(turnFactEvents)`、`AgentEvent`、`PendingInterruption.callId` 天然同一编号空间 ⇒ **不造第三套 seq/状态机**（诊断 No-Go）。
- 预留（**不填、不依赖**）`parentSessionKey` / `forkSessionIdHint` 可空字段，供 D4 关联 PVC 上的 fork transcript；D2 不为它付 pi-runtime 改动成本。

### 4.2 范围裁决（回答「D2 边界」）

**D2 = 单据 + 幂等 + 权威终态 + D1 关联 + 只读查询面**，五件一体。

- **必须包含只读查询面**：否则单据无人消费，就退化成「加指标不治本」。查询面走既有 `/threads/:id/state`（P2 已把 `pendingInterruption` 塞进 state 的同族做法），前端零迁移、刷新/换设备可重放。
- **不包含** `onUpdate` checkpoint（已被上游证伪）、`lane.followUp()` 回注（D3）、孤儿恢复（D4）、`pi-durable` upmerge（D7）、部署 drain（D5）。
- **不改** C4 三件套、`await attempt.promise`、工具白名单、`plan-gate`、`finalizeTurnTimeline`、D1 判据、`Math.max(1,…)`。

---

## 5. 设计

### 5.1 数据模型（additive migration，零破坏）

`apps/server/prisma/schema.prisma` 新增（**不建 FK relation**，同 `PendingInterruption` 的理由：`threadId` 可能是前端自定义 threadKey）：

```prisma
/// D2：子代理一等任务单据。完成的权威状态独立于 pi-runtime 进程存活。
/// - additive：只建表 + 索引，不改存量行；status 用 String（SQLite 无原生 enum）。
/// - 唯一键 (threadId, callId)：tool_call 帧重放 / SSE 重投幂等。
/// - 不建 FK：threadId 可能是前端 threadKey（不保证 AgentThread 行存在）。
model SubagentTask {
  id                String    @id @default(cuid())
  threadId          String
  callId            String        // tool_execution_start.toolCallId
  requestId         String    @unique  // subagent:{callId}
  runId             String?       // 父回合 operationId，与 AgentEvent.runId 同源
  parentSessionKey  String?       // piSessionKey = threadId||sessionId；D4 定位 fork transcript 预留
  taskPreview       String?       // args.task 截断（上限 512），不存全文
  status            String    @default("spawned")
  outcomeJson       String?       // 4 态 outcome 摘要，**不存 report 全文**（避免 P1c 530KB 债复刻）
  reason            String?       // no_terminal_event | lease_expired | <subagent_status>；中性、不臆断
  expiresAt         DateTime
  startedAt         DateTime  @default(now())
  endedAt           DateTime?
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  @@unique([threadId, callId])
  @@index([threadId, status])
  @@index([status, expiresAt])
}
```

迁移文件 `apps/server/prisma/migrations/20261112xxxxxx_add_subagent_task/migration.sql`，由 `deploy/docker/docker-entrypoint.sh:32` 的 `prisma migrate deploy` 在生产启动时执行（P2 同款路径，已生产验证）。

### 5.2 状态机（单点 CAS，终态不复活）

```
                 ┌── tool_result(details 4 态) ──→ completed / failed / timeout / budget_exceeded
spawned ─────────┼── turn_interrupted 命中 ──────→ interrupted  reason=no_terminal_event
 (开单据)        └── sweep(expiresAt 过期) ──────→ interrupted  reason=lease_expired
                         ↑ 三路共用一个 CAS：updateMany where status IN (spawned)
```

- **CAS 单点**：`updateMany({ where: { callId, status: 'spawned' }, data: { status, endedAt, ... } }) → count > 0` 才算本次裁决生效；终态行**不复活**（同 `PendingInterruptionService.settleGate`）。
- **`expiresAt`** = `startedAt + SUBAGENT_TIMEOUT_MS(300s) + 宽限`（宽限取 60s，给 1min sweep 与 `tool_result` 在途留窗）。常量在 server 侧定义，**不 import pi-runtime**（两部署单元不共享代码）。
- **sweep 不新起 timer**：复用既有 `AutomationSchedulerService` 的 1min job（新增 handlerKey `subagent-task-sweep`，`runOnStartup: true`）。理由同 P2：进程内 setTimeout 重启即丢，重启后必须有 startup 扫描收口孤儿。
- **诚实边界**：单据状态是 **Nest 观测到的投影**，不是 pi-runtime 子 run 的内部真源。`reason` 恒为可观测事实；禁止 `pod_restarted` / `upstream_disconnected` 等无证据归因。

### 5.3 写入漏斗（唯一写者 = `pushTraceEvent`）

`apps/server/src/agent/agent.service.ts` 的 `pushTraceEvent` 是 `AgentEvent` 账本 append-only 的唯一写者（`:3239`），`pi-events.ts:170-183` 已把工具帧派生为：

```
tool_execution_start → tool_call  { toolCallId, name, toolName, args }
tool_execution_end   → tool_result{ toolCallId, name, toolName, result, isError }
```

新建一个 `SubagentTaskService`（与 `PendingInterruptionService` 同族、同构造姿势），由漏斗在**同一同步段** fire-and-forget 调用；全部方法 **fail-open**（表写失败只留 `subagent_task_*_failed` warn，不阻塞 SSE / 不抛）：

| 触发 | 动作 |
|---|---|
| `pushTraceEvent('tool_call', d)` 且 `d.name === 'spawn_subagent'` | `openTask({ threadId, callId: d.toolCallId, runId: currentPiEvent?.runId, taskPreview: d.args?.task, expiresAt })` |
| `pushTraceEvent('tool_result', d)` 且 `d.name === 'spawn_subagent'` | 从 `d.result?.details`（`textResult` 的 `details` 即返回值）读 `usage.status` / `error`，`settleTask(callId, status, reason)` |
| `pushTraceEvent('turn_interrupted', d)` | 对 `d.outstandingToolCallIds` 逐个 `settleTask(callId, 'interrupted', 'no_terminal_event')` |
| 1min sweep | `updateMany({ where: { status:'spawned', expiresAt:{ lt: now } }, data:{ status:'interrupted', reason:'lease_expired' } })` |

⚠️ **全量事实视图纪律**：D1 已把 `executionEvents` 裁成「最小兼容集」，`turnFactEvents` 才是全量事实视图。D2 的漏斗判据只读 `ev` 本身（当帧数据），**不读被裁剪的数组、不反向依赖账本读回**（D1 规格 §5.1 / 实施补记 §6 同源约束）。

### 5.4 4 态 outcome 的可读性（零 pi-runtime 改动的依据）

`services/pi-runtime/src/tools/spawn-subagent.ts` 的 `textResult(data)` 把 `data` 同时放进 `content[0].text` 与 `details`：

```ts
{ ok: true, report, usage: { turns, durationMs, status: outcome.status } }        // completed
{ ok: false, error: `subagent_${outcome.status}`, report, usage: {...} }         // failed/timeout/budget_exceeded
```

`tool_execution_end` 的 `result` 透传该 `AgentToolResult` ⇒ Nest 侧 `tool_result.result.details` 直接可读 `usage.status` 或 `error`。**判据必须先贴真实生产记录求值**（§6），不能凭类型推断。

### 5.5 只读查询面

`GET /threads/:id/state` 的响应增加 `subagentTasks` 摘要（形状与 `pendingInterruption` 同族，旧客户端忽略未知字段）：

```ts
interface SubagentTaskSummary {
  callId: string; status: string; reason: string | null
  taskPreview: string | null; startedAt: number; endedAt: number | null
}
```

只返回**在途（spawned）+ 最近 5 条终态**，字段裁剪、不含 `outcomeJson` / `requestId` / `parentSessionKey`。前端 D1 的 `interrupted` 工具卡与 notice 不因本刀改变（避免二套呈现判据）；D2 只保证刷新/换设备后 state 仍能裁决。

### 5.6 数据流

```
pi-runtime: tool_start(spawn_subagent) ──SSE──→ Nest pi-events.ts
   → tool_call{toolCallId,...} ──→ pushTraceEvent 漏斗 ─┬─→ AgentEvent 账本（既有）
                                                        ├─→ turnFactEvents（既有，D1 判据用）
                                                        └─→ SubagentTaskService.openTask()  ★D2
                                                              （同一同步段，fail-open）
   正常结束 → tool_result{details.usage.status} ────────→ settleTask(completed/...)
   pod 被杀 → 流耗尽 → D1 classifyTurnEnd=interrupted
                → turn_interrupted{outstandingToolCallIds} → settleTask(interrupted)  ★D2
   连 D1 都没下发（Nest 自身重启/异常）→ 1min sweep(expiresAt) → settleTask(interrupted)
   刷新 / 换设备 → /threads/state.subagentTasks 仍可裁决
```

---

## 6. 判据求值：贴真实生产记录 + 变异自检

遵循项目纪律「按数据形态分支的修复，判据必须先贴真实生产记录求值 + 变异自检」（#815 教训）。夹具沿用 D1 `turn-end.test.ts` 的脱敏生产快照：

**阳性 A**（`cmwbvfp4p000qrk01pch77w13`，故障会话）：
```
tool_call{ call_334ae8e2832146608be265e9, name:'spawn_subagent', gSeq:152 }
（无 tool_result；无 turn_usage；metadata.truncated=true；turn_settled credits:1）
⇒ 开单据 spawned → turn_interrupted 命中 → status=interrupted, reason=no_terminal_event
```

**阴性 B**（`…42ap2hej`，同工具正常返回，78.9s）：
```
tool_call{call_b55c3b4616434aada4967bf4} → tool_result{同 id, details.usage.status:'completed'}
⇒ status=completed, reason='completed', endedAt ≠ null
```

| 变异 | 期望 | 目的 |
|---|---|---|
| 删 `tool_result` 配对帧 | B 转为 `interrupted`（由 turn_interrupted / sweep 收口） | 证明判据真依赖数据形态，非恒真 |
| 把 `usage.status` 改成 `'timeout'` | 终态变 `timeout`，不得落 `completed` | 证明 4 态透传非硬编码 |
| 把 `turn_interrupted` 从漏斗摘除 | A 的单据停在 `spawned`，只能等 sweep ⇒ 断言 RED | 证明中断关联不是死代码 |
| 把 `openTask` 从 `pushTraceEvent` 移出 | A 无单据行 ⇒ 断言 RED | 证明「同一条提交」不是口号 |
| 重复下发两次 `turn_interrupted` | 单据只翻一次、`endedAt` 不变 | 证明 CAS 幂等、终态不复活 |
| 构造 `waiting_user{waiting}` 挂起回合 | 不产生 `interrupted` 单据 | 证明与 D1 `suspended` 互斥 |

⚠️ 变异必须能 RED；「删掉判据后测试仍全绿」判为伪变异，先修判据。**BSD grep 不支持 BRE `\|`，取证命令一律 `grep -E`**。

---

## 7. 错误处理与兼容性

- **fail-open 全覆盖**：`openTask`/`settleTask`/`getSummaries`/`sweepExpired` 各自 try/catch + 稳定 warn tag；表不可用不影响 SSE、不打断对话、不影响 D1 计费判据。读失败按「无在途单据」保守返回 `[]`（不撒谎说有任务，也不阻塞）。
- **幂等**：`@@unique([threadId, callId])` + `@@unique([requestId])`；SSE 重投 / 刷新重放 / sweep 与 `tool_result` 竞态都由 CAS 收口。
- **老消息兼容**：历史 82 条 `truncated` 消息**不回填、不改判**（只追加状态回填偏好）。D2 上线前的会话查不到单据 ⇒ `subagentTasks: []`，前端继续显示 D1 的 `turn_interrupted`（若有）或既有提示。
- **D1 零回归**：`turn-end.ts` / `classifyTurnEnd` / `shouldReleaseHold` / `finalizeTurnTimeline` / 分享页全部不动；D1 的 19+7+8+9 条测试与 P1c 48/48、P2 测试全绿是本刀的回归锁。
- **多实例边界**：`AutomationSchedulerService` 并发权威是进程内 running Map（单实例约束）；本刀不引入分布式锁，sweep 靠 CAS 天然幂等，多实例重复扫无副作用。
- **迁移**：additive `CREATE TABLE` + `CREATE UNIQUE INDEX`，`migrate deploy` 幂等；不改存量表、不回填。

---

## 8. 测试策略（TDD，先 RED 后 GREEN）

| 层 | 文件 | 断言 |
|---|---|---|
| 纯判据 | `apps/server/src/agent/subagent-task.status.test.ts`（新） | 从 `tool_result.details` 解析 4 态；A/B 生产夹具求值；6 组变异自检（§6） |
| 服务 | `apps/server/src/agent/subagent-task.service.test.ts`（新） | 开单据幂等 / CAS 单点 / 终态不复活 / sweep 只翻过期 / 全部方法 fail-open / `runOnStartup` handler 注册 |
| 漏斗接线 | `apps/server/src/agent/subagent-task.wiring.test.ts`（新） | `tool_call{spawn}` 必开单据、`tool_result` 必收口、`turn_interrupted` 必批量收口、**非 spawn 工具零副作用**、账本 append 不受影响 |
| 查询面 | 既有 `agent.controller`/state 测试追加 | `subagentTasks` 只含裁剪字段、上限 6 条、旧形状兼容、无单据时 `[]` |
| 回归锁 | 既有 D1 / P1c / P2 全部测试 | 逐项保持全绿，任何红都视为 D2 破坏既有契约 |

命令（nvm node24、项目纪律）：
```
$HOME/.nvm/versions/node/v24.13.0/bin/... pnpm --filter @lnkpi/server exec vitest run <files> --maxWorkers=1 --no-file-parallelism
env -u NODE_OPTIONS pnpm exec vue-tsc -b          # 勿加 --noEmit（composite TS6310）
pnpm --filter @lnkpi/server exec prisma generate
```
本机 pnpm 须 `env -u NODE_OPTIONS`；断言**禁 `as never`**。

---

## 9. 分刀与依赖（本次只做 D2 的规格与计划）

| 刀 | 内容 | 依赖 | 触发发布 | 本轮状态 |
|---|---|---|---|---|
| D1 | P0 止血（Nest 终态/计费 + 前端卡片 + outcome 埋点） | 无 | ✅ 已上线 | ✅ #847，master `ba059283` |
| **D2** | **一等任务单据 + 幂等 + 权威终态 + D1 关联 + 只读查询面** | D1 | ✅ 仅 `apps/server`（migration） | **本轮：spec + plan，停实施前** |
| D3 | 结果回注走**持久化 inbox**（`lane.followUp/steer`），非 checkpoint 续跑 | D2 | ✅ pi-runtime | ⚠️ 方案需按 §3.2 纠偏 |
| D4 | 有界显式孤儿恢复 + 幂等重放（**禁止自动 `lane.resume()`**） | D3 | ✅ | 排期 |
| D5 | `preStop` + `terminationGracePeriodSeconds ≥ 300s` + 发布前查 `SubagentTask` 在途 | D2 | ✅ 部署配置（需手工 dispatch） | **建议与 D2 同批或紧后**：当前 grace 30s 无 preStop 是触发源 |
| D6 | 前端重连重放（`id:` / `Last-Event-ID`） | #843 → #842 P1b | ✅ Web | 排期 |
| D7 | `pi-durable` upmerge 预研（spec only，并入阶段 C） | D4 | ❌ docs-only | 排期 |

**D3 方案纠偏（只追加状态回填，不改诊断原文）**：诊断 §5 P1.2「`onUpdate` → `tool_update` + `pendingToolOutput` 落盘 checkpoint」与 P1.4「`repo.list()` + `parentSessionId` 发现孤儿 fork 并恢复」两处，被上游 0.99.2 源码证伪：checkpoint 是全量快照的中途进度，崩溃后只能丢弃重跑整工具或塞进 `interruptedOutcome`，**不能续跑仍在跑的工具**；fork 时子 lane 状态被强制清空。D3 应改为「结果由 harness/权威单据**回注**（`followUp` 持久化 inbox，上游已落盘且有 `restore.ts` 还原）+ 进度快照只用于向用户交代」，并把「不自动 resume 上游 LLM」作为硬约束。

**D5 依赖说明**：D2 上线后单据能立刻让发版腰斩「可见可裁决」，但**发生率不变**。D5 的发布互斥判据正好读 `SubagentTask` 在途行 ⇒ D2 是 D5 的前置而非并行发明；建议排期不要把 D5 拖到 D4 之后。

---

## 10. 明确不做（No-Go）

- ❌ **加指标 / 加 watcher 当修复**：Codex #13244 已证明 watcher 订阅竞态静默失败；单据是控制面，不是日志。
- ❌ **照抄 pi-durable / 提前换 1.x**：0.99.2 是 harness 末代，pi-durable Experimental 且单进程本地存储不覆盖 Recreate。
- ❌ **`replay:"safe"` 重跑工具 / 自动 `lane.resume()`**：`cmv3zzid` 612s 事故，`turn-continuity-design.md:128-130` 已立规。
- ❌ **checkpoint 续跑仍在跑的工具**：上游不支持（§3.2）。
- ❌ **改 pi-runtime / 触发 `runtime-deploy` / 新增 `/agent/internal/*` 回写端点**：pod 被强杀时回写发不出，且新增跨服务链路。
- ❌ **新建第三套 seq / 状态机**：复用 `AgentEvent` envelope、`callId` 编号空间、既有 1min scheduler。
- ❌ **把 report 全文写进单据**：复刻 P1c 的 530KB/行债。
- ❌ **回填或改判历史 82 条 `truncated` 消息**。
- ❌ **改 C4 三件套 / `await attempt.promise` / 工具白名单 / `plan-gate`**。
- ❌ **改 D1 判据、`finalizeTurnTimeline` 签名、controller `[DONE]` 补发、`Math.max(1,…)`**。
- ❌ **靠加 prompt 规则解决**：L6 余量紧张，点名走 `promptGuidelines` 动态块（#841 F1/P3）。
- ❌ **把 `reason` 写成 `pod_restarted` / `upstream_disconnected` 等无证据归因**。
- ❌ **本轮合并、部署、改生产数据、写产品代码**。

---

## 11. 风险与未闭环项

1. **单据是观测投影，不是子 run 内部真源**：`iteratePiEvents` 的 `onClosed`/`onError` 都只置 `closed=true`（D1 规格 §11.3 已自认），Nest 无法区分「上游真死」与「Nest 提前收尾、pi 侧仍活」。D2 因此采用中性 `reason` + 三路 CAS 收口 + 可查询在途，不宣称精确归因。
2. **不能降低事故率**：`Recreate` + grace 30s + 无 preStop + 5min 子任务是结构性触发源；D2 只让它诚实可见。降低发生率属 D5，**不得在 D2 验收里宣称**。
3. **PVC `reclaimPolicy=Delete` + `local-path` 单节点 hostPath**：transcript 当前留存（50d / 200 目录），但 release 被删或节点漂移即全丢；`values-prod.yaml` 3 副本 + RWO 自注占位。D4 若要做 transcript 级恢复，需先解决持久卷拓扑，不能假设盘恒在。
4. **Nest 侧自身约束**：SQLite 单文件 + `AutomationSchedulerService` 单实例 running Map；1min sweep 带来最多 60s 终态可见延迟；`runOnStartup` 是必要兜底。
5. **跨服务双写分叉**：`turn-continuity-design.md:196-202` 把 L-B「Nest ↔ pi 周期性对账」列为后续批次，并警告「若不纳入对账，分叉会静默」。D2 单据是第三条状态线，需在 D3 排期时纳入对账范围。
6. **生产取证待补（源码不能断言）**：① 生产 PVC 的实际 storageClass / PV reclaimPolicy 已取证（§3.1），但 helm `--reuse-values` 沿用旧值，release 升级后是否变化需在 D5 实施前复核；② 事故当时 pod 替换究竟由 helm upgrade / rollout restart 还是其他机制触发，需事件取证；③ Nest named volume 是否被 prune / `down -v`、WAL 一致性需运维复核。
7. **本轮未做**：真机走查（本环境不可代跑）、A-6、82 条历史 `truncated` 分层归因、SSE `id:`/`Last-Event-ID` 上线状态验证、P2 严格「重启前后同一 pending 门」对比。**不宣告 ALL_PASS**。
8. **CI 与合并**：D2 触发生产发布；按用户纪律 CI 全绿后停在合并前等单独授权，生产复测另授权。本轮连代码都未写。

---

## 附：可复现取证命令

```bash
# 1) 生产 PVC / 部署策略（只读）
ssh deploy-cvm 'KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl get pvc,pv -n pi-lnk-runtime -o wide'
ssh deploy-cvm 'KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl get deploy -n pi-lnk-runtime -o json | \
  python3 -c "import json,sys;d=json.load(sys.stdin);[print(x[\"metadata\"][\"name\"],x[\"spec\"].get(\"strategy\"),x[\"spec\"][\"template\"][\"spec\"].get(\"terminationGracePeriodSeconds\")) for x in d[\"items\"]]"'

# 2) 上游契约（干净快照 /tmp/pi-lnk-d2，勿用陈旧工作树）
grep -nE "One process owns|host failure|Memory|SQLite|JSONL" \
  /tmp/pi-lnk-d2/vendor/earendil-works/pi/packages/durable/README.md
grep -nE "replay:|ownership:|requestId:" \
  /tmp/pi-lnk-d2/vendor/earendil-works/pi/packages/durable/test/examples/22-subagent-foreground.ts
grep -nE "full-snapshot|checkpoint === true|interruptedOutcome|clearReplayCheckpoint" \
  /tmp/pi-lnk-d2/vendor/earendil-works/pi/packages/agent/src/harness/{types.ts,runtime/drive/tools.ts,runtime/progress.ts}

# 3) 本项目状态所有权
grep -nE "绝不调上游|绝不 resume|settleOrphanOperations|requestAbort" \
  /tmp/pi-lnk-d2/services/pi-runtime/src/session-manager.ts
grep -nE "权威在 Nest|只有一条真相线|双写对账" \
  /tmp/pi-lnk-d2/docs/superpowers/specs/2026-10-21-turn-continuity-design.md

# 4) 真 master（本机 ↔ GitHub 仅 gh api 可达）
gh api repos/sev7n4/pi-lnk/git/ref/heads/master --jq '.object.sha'
```

**一手资料**：`vendor/.../durable/README.md`（Storage / Abort and Subagents / Child Tasks）、`test/examples/22/23/24-*.ts`、`agent/src/harness/{runtime/lane.ts,runtime/drive/tools.ts,runtime/progress.ts,runtime/restore.ts,session/fork-policy.ts,session/types.ts}`、`VENDORED.md`；`outputs/2026-11-11-subagent-result-delivery-diagnosis.md`；`docs/superpowers/specs/2026-10-10-c4-subagent-design.md`；`docs/superpowers/specs/2026-10-21-turn-continuity-design.md`；OpenAI Codex `codex-rs/core/src/agent/control.rs` 与官方 issue #13244；`code.claude.com/docs/zh-TW/agent-sdk/subagents`。
