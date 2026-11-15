# 子代理 pending-work barrier + 上下文隔离 + 结果交付根治 设计规格（P1-P2-P3）

> 状态：待评审（superpowers HARD-GATE——spec 批准后才会写 plan / 产品代码）
> 日期：2026-11-15
> 输入：生产会话 `cmwhln39d006yqp01d56ryc0q` 原始 JSONL 取证 + 对抗性复审 + 上游 pi-agent-core 0.99.2 / 行业（Claude Code / Codex / 结构化并发）对照
> 基线 worktree：`.worktrees/fix-subagent-pending-barrier`，分支 `fix/subagent-pending-barrier`，master 锚 `f6a22d4a`
> 相关规格：`2026-11-14-subagent-contract-d2-nonblock-design.md`（D2 现状）、`2026-10-10-c4-subagent-design.md`（C4 原始）、`2026-11-11-subagent-result-delivery-diagnosis.md`（同族早期诊断）

---

## 1. 背景：本次生产会话到底发生了什么

取证来源（均从生产 K3s pod `pi-lnk-runtime-5b685dcf85-qrrv5` 的 PVC 拷出，存于 `.workbuddy/forensics/cmwhln39d006yqp01d56ryc0q/`）：

- `mainrun.jsonl`（877 行）：主 run 事件流。
- `subA.jsonl`（551 行）/ `subB.jsonl`（389 行）：两个后台子任务事件流。
- `subtasks.jsonl`（94 行）：全局 `SubtaskLedger` 账本。

还原的真实时间线：

1. 主 run `load_skill` 加载 `research-delegate`。
2. `spawn_subagent` ×3：`fff03879…`、`dd5e7bf5…` 成功，`mode:'background'`；第三个撞 `SUBAGENT_MAX_CONCURRENT=2` 返回 `subagent_concurrency_full`。
3. `web_search` ×4（主 run 自行联网）。
4. `collect_subagent_result` ×1——**只查了第一个 callId**，返回 `status:"running"`。
5. 主 run 停止工具调用，进入收尾结算。
6. 两个后台子任务随后各自 `failed`：
   - `fff03879…`：`turns=4, durationMs=32397, reportChars=23, report="我来先检查已派发的子代理状态，再决定后续路径。"`
   - `dd5e7bf5…`：`turns=4, durationMs=32997, reportChars=31, report="后台调研收集失败，我直接用联网调研补充。让我并行搜索关键资料。"`
7. 子任务尾部**只有 toolCall/toolResult，无最终 assistant synthesis、无 `agent_end`**；主 run 与子任务共出现 8 处 `AgnesAI_error`，usage=0。

**排除的错误假设**（复审已证伪，spec 不再采纳）：

- ❌ "pod 滚动更新导致内存 promise 蒸发"——两个 callId 都有 `terminal` 账本记录，pod 未重启蒸发。
- ❌ "普通 429 / turnBudget 强结算是主因"——真因是 provider 断流（`AgnesAI_error` + usage=0），非预算。
- ❌ "spawn 工具本身终止 run"——工具返回正常 background envelope。
- ❌ "模型 lazy-stop 是根因"——那只是表层症状（见 L1）。

---

## 2. 四层根因（从症状到本质）

| 层 | 根因 | 证据 | 性质 |
|---|---|---|---|
| **L1** | 主 run 模型 `collect` 一次拿 `running` 后即收尾，父 run 在子任务存活时结束 | mainrun.jsonl：collect×1 → 停止工具调用 | 症状（缺机制约束，不是模型偷懒） |
| **L2** | 子代理 fork 主会话**全量历史** + 复用 `source.basePrompt`，继承 `research-delegate` skill 与 "回合结束前必须 collect" 纪律；但 `collect_subagent_result` 不在 `SUBAGENT_TOOL_WHITELIST`，首调撞 vendor 硬编码 `Tool "...": is unavailable`，无恢复路径 | subA/subB 首调即 unavailable，随后 `web_search`×9/×6 自救 | 关键遗漏（工具集层面 fail-open） |
| **L3** | `extractSubagentReport` 倒序取第一条非空 assistant 文本；子任务 provider 断流无最终 synthesis，于是开场白/过渡话术被当作 report 落账 | 两条 terminal report 均为过渡话术，非调研结论 | 报告污染（状态语义缺失） |
| **L4** | 完成契约绑在**内存 promise** 上：无 pending-work barrier（父可在子存活时结束）、无完成通知主动回注（子 settle 只进内存 + 账本）、fail-open 工具隔离靠提示词而非工具集 | `SubagentCoordinator` 只有 `#inFlight`/`#settled`（按 callId），无 per-session 未收口集合；settle 不写回父会话 | 底层架构根因 |

一句话本质：**D2 解决了"能派、能记账、能被动查"，但没有解决"父 run 必须等所有子任务收口、子任务结果必须主动回到父会话、子任务上下文必须与父编排上下文隔离"。** 这三件事在 Claude Code / Codex 里都是一等机制，不是提示词纪律。

---

## 3. 目标 / 非目标

### 目标（三把刀）

- **P1 pending-work barrier**：框架保证——只要本会话存在未收口的 background 子任务，父 run 不得正常结算；框架主动等到终态（带 deadline / cancel / fail-soft），把结果作为 `followUp` 回注父会话，父模型看到结果后再合成最终答复。
- **P2 子任务上下文隔离**：子代理使用**干净会话**（无主 run 的 skill 注入历史、无 spawn hint、无 collect 纪律文本），只注入结构化 task；编排类工具在工具集层面就不存在（fail-closed），不靠提示词禁止。
- **P3 结果交付完整性**：报告提取区分 synthesis 与开场白；断流/partial 有显式状态语义；可观测性能回答"派出去的回来没、状态是什么、报告是不是真的"。

### 非目标（明确不做）

- 不做跨 pod 子任务**恢复执行**（重启后仍只能标 `interrupted` 供取证，续跑属 D2 二期）。
- 不改 `SUBAGENT_TOOL_WHITELIST` 的只读范围、并发上限 2、超时 5min、预算 30 turn 的**值**。
- 不 patch vendor（`pi-agent-core` 源码零改动）。
- 不建独立 Planner 子代理、不加 prompt 条文治标、不把 `collect_subagent_result` 加进子代理白名单。
- 不改前端协议（子任务结果仍经既有事件管道 + followUp 合成 user 消息，前端零迁移）。

---

## 4. 为什么不重复造轮子（上游 + 行业对照）

### 4.1 上游 pi-agent-core 已给的现成能力

- `before_run_end` hook（agent-harness.d.ts:501-509）：event = `{runId, messages}`，handler 可 async，返回 `{followUp?: string}`；boundary.js:95-100 把 followUp 变成一条 user 消息续跑。**这是 pending barrier 的现成挂点，不需新建状态机。**
- `lane.steer / lane.followUp / nextRun`（session-manager.ts 已封装）：inbox 三类是上游一等原语。
- `build()` 不传 `existingFs.session` 时走 `repo.create({cwd}, ctx)` 建**全新空 session**（session-manager.ts:1314）——P2 干净子会话的现成路径。
- `storeScopeKey: opts.subagentTools ? key : ...`（session-manager.ts:1347）：子会话状态隔离已实现，本 spec 沿用不重做。
- 已知上游边界：harness 路径吞掉工具 `isError`（恒 `isError:false`），所以 fail-closed 必须靠 `ok:false` + 内容文本 / 工具集缺席，不靠 `isError`。经典 loop 0.99.2 消费 `result.isError`，但本项目走 harness。

### 4.2 行业成熟形态（吸收而非照抄）

- **Claude Code**：foreground/background 双模式；后台完成通知在**后续 turn** 到达；父 agent 等完成通知再汇报；编排类工具**从子代理工具集中移除**——"工具不在 session 里，而不是提示模型不要用"。→ 对应 P1 followUp 回注 + P2 工具集隔离。
- **Codex**：等所有请求结果再汇总；`report_agent_job_result exactly once`；`wait` / `monitor`；`max_depth=1` 封递归。→ 对应 P1 barrier 的"等到全部终态"与报告一次交付、P2 白名单禁嵌套。
- **结构化并发（Structured Concurrency）**：父不能在子存活时结束；pending-work barrier；错误上传、取消下传；future 不得逃逸 scope。→ 对应 P1 的 barrier 语义与 cancel/deadline 传播。

### 4.3 结论

自研 spawn/collect **不是**重复造轮子（上游公共 harness 无 subagent handle；experimental pico3 的 durable Task/waitForTask 是下一代方向，当前不可直接用于生产）。本次修复应**复用项目已有原语**（before_run_end + followUp + repo.create + 白名单），只在缺口处补最小机制。

---

## 5. P1：pending-work barrier（核心）

### 5.1 机制：单点融合，不建新状态机

在 `before_run_end` 单点做三件事（复用 plan-gate-wiring 范式）：

```
harness.hooks.on("before_run_end", async () => {
  const pending = subagentCoordinator.pendingFor(sessionId);   // 本会话未收口 background
  if (pending.length === 0) return undefined;                  // 无待办 → 零影响
  const results = await subagentCoordinator.awaitSettled(pending, { deadline }); // 等到终态
  return { followUp: composeBarrierFollowUp(results) };        // 结果回注父会话
});
```

关键点：hook 是 async（boundary.js:95 `await runWithGate`），所以在 hook 内 await 子任务到终态**天然把父 run 的收尾边界挂住**——这正是"父不能在子存活时结束"的结构化并发语义，无需另起轮询/定时器。

### 5.2 必须补的数据结构：`SubagentCoordinator.pendingFor(sessionId)`

现状缺口：`#inFlight` / `#settled` 按 callId 索引，没有"按会话聚合的未收口 background 集合"。新增：

- `#pendingBySession: Map<piSessionKey, Set<callId>>`，仅 background 模式登记（block 模式本就同步等，无需 barrier）。
- `tryRun()` 成功且 `mode==='background'` 时登记；promise `.finally()`（settle）时移出该集合。
- `pendingFor(sessionId): string[]` 返回快照。
- `awaitSettled(callIds, {deadline}): Promise<...>`：对仍在途的 promise 做 `Promise.race([promise, deadline])`；返回每个 callId 的 `{callId, status, report}`；deadline 到仍未 settle 的标 `interrupted`（诚实语义：本进程未收口）。

### 5.3 deadline / cancel / fail-soft 边界（防死循环、防卡死）

- **deadline**：`SUBAGENT_TIMEOUT_MS + 缓冲`（子任务自身 5min 硬超时先到；barrier deadline 略大，作为第二道网）。全局单例计时，不随会话数累加。
- **cancel 传播**：主 run 被用户"停止"时，既有 `chordCtx.abortSignal → runSubagent.run.cancel` 链保留；barrier 等待的 promise 随之 settle 为 failed，不会悬挂。
- **fail-soft**：barrier 本身任何异常（coordinator 未 attach、账本读失败）都不得让父 run 崩——catch 后返回 undefined 或一条软提醒，绝不 throw。
- **幂等 / 防双执行**：`pendingFor` 在 `.finally()` 移除 callId 后为空，下一次 before_run_end 不再注入；followUp 合成 user 消息续跑，模型消费结果后正常收尾，不再有 pending → 收敛。需行为级测试钉死"不会无限续跑"。

### 5.4 硬约束：与 plan-gate 的 followUp 冲突（last-write-wins）

⚠️ 上游 `hooks.js:65-71` 对多个 `before_run_end` handler 的 followUp 聚合是**后注册覆盖先注册**（last-write-wins）。index.ts:215 已注册 `registerPlanGateHooks` 的 before_run_end。若 barrier 独立注册第二个 handler，两者同时返回 followUp 时会**静默吞掉一个**。

决策（spec 建议，待评审拍板）：
- **推荐**：改为**单一 before_run_end handler**产生合成 followUp——把 plan-gate 的 "consumePlanExecutionSignal → 下一步 todo" 与 barrier 的 "pending 子任务结果" 合并成一段文本。实现上让 `plan-gate-wiring` 暴露纯函数 `planGateFollowUp(planKey)`（只算不注册），与 barrier followUp 在 index.ts 的唯一 handler 内拼接。
- 备选：barrier 注册在 plan-gate 之后并自行合并 plan-gate 的信号（耦合更差，不推荐）。
- 无论哪种，**必须有一条行为测试**钉死"plan-gate 与 barrier 同时命中时两个 followUp 都不丢"。

### 5.5 报告回注格式

`composeBarrierFollowUp(results)` 产出固定的合成 user 消息，例如：

```
【后台子任务已完成，以下为结果，请据此合成最终答复】
- <callId1> [completed] <report>（来源/未核实标注随报告）
- <callId2> [failed] 子任务失败：<原因>
（若有 interrupted：）另有 N 个后台任务在本进程未收口，结果不可恢复。
```

只回注**父会话自己派发的** background 结果；子会话（isSubagentSessionKey）不注册 barrier（与 index.ts:214 现有守卫一致，防回灌）。

---

## 6. P2：子任务上下文隔离（干净会话 + 结构化注入）

### 6.1 现状缺陷（L2）

`runSubagent` fork 主会话全量历史（session-manager.ts:3239-3243，`{scope:'branch', branch:MAIN_LANE}` 无 entryId → 到 tip），并 `systemPrompt: source.basePrompt`（:3248）。于是子代理继承：

- 主 run 加载的 `research-delegate` skill 文本（含 "回合结束前必须 collect"）；
- spawn hint / 编排纪律；
- 而 `collect_subagent_result` 恰不在子代理白名单 → 首调撞 vendor 硬编码 unavailable。

复审定性：这是**工具集层面的 fail-open**——提示词说"可以用 collect"，工具集说"不存在"，模型必然撞墙。行业做法是让编排工具在子会话里根本不存在，且不注入任何编排纪律。

### 6.2 seam 事实（决定实现路径）

- `repo.fork` 的 `ForkOptions` 仅 `scope:'branch'|'tree'` + `entryId/position/id`（vendor types.d.ts:474-500）——**没有"清空 transcript"选项**。fork 无法得到干净上下文。
- `build()` 不传 `existingFs.session` 时 `repo.create({cwd}, ctx)`（session-manager.ts:1314）建全新空 session——**这才是干净子会话的正道**。
- `canvasSessionId` 保留（子代理读画布工具仍可用）、`storeScopeKey` 用子键（:1347 已隔离）、`setActiveTools(白名单)`（:3279-3281 已实现）——这些既有机制原样沿用。
- `composeSubagentPrompt(task, background, reportFormat)`（spawn-subagent.ts:34-40）已把 task 结构化 —— 干净会话里把这段作为**首条 user 消息**注入即可。

### 6.3 设计

runSubagent 的会话构建从"fork 全量历史"改为"新建干净会话 + 结构化 task 注入"：

1. **新建空会话**：`build(subKey, {subagentTools:true, ...}, ...)` 不传 `session`（走 `repo.create`）。保留 `canvasSessionId / models / model / identity / workingDir / userId / thinkingLevel`（沿用来源身份与画布指针）。
2. **systemPrompt 用专门的 subagent prompt**：不含主 run 的 skill index / spawn hint / collect 纪律；只含"你是只读调研子代理 + 工具边界 + 报告契约（结论先行/来源清单/未核实标注）"。保留一个 `fork` 保留 seam 的环境开关用于 A/B 验证（默认关闭，验证后可删），但**不进 spec 交付路径**——避免两套上下文语义长期并存。
3. **任务注入**：`lane.prompt(composeSubagentPrompt(...))` 作为首条 user 消息，独占干净会话，模型看不到任何编排历史。
4. **白名单不变**：`spawn_subagent` / `collect_subagent_result` 仍不在 `SUBAGENT_TOOL_WHITELIST`——工具集层面 fail-closed（L2 根治点）。子代理 prompt 不再出现任何 collect 纪律（消除 L2 的提示词诱导）。
5. **清理铁律不变**：只摘内存 + 关子 harness，绝不 `releaseHandles`（env/repo 共享，见 session-manager.ts:3201-3202 注释）。

### 6.4 兼容与风险

- **block 模式同样受益**：干净上下文对 block/background 一致，不改对外契约。
- **画布上下文丢失风险**：子代理不再看到主 run 对话历史（这是有意的）。若调研需要"用户之前说过什么"，由 task / background 显式注入——这正是 Codex/Claude 的做法（task 自包含）。需行为测试确认子代理仍能通过 `get_canvas_summary` 等白名单工具读到画布状态。
- **首轮延迟**：新建空会话比 fork 略快（无历史拷贝），无性能回归风险。

---

## 7. P3：结果交付完整性（报告 / 断流 / 可观测）

### 7.1 报告提取（L3）

现状 `extractSubagentReport`（session-manager.ts:3337-3362）倒序取第一条非空 assistant 文本——断流时抓到开场白。改为：

- 优先取**最后一条** assistant 文本（synthesis 通常在末尾）；
- 若末尾是 toolCall/toolResult 且无后续 assistant 文本 → 判定为**断流**，report 用部分结果（最后一段有实质内容的 assistant 文本，或空串）+ 显式 `partial:true` 标记；
- 开场白/过渡话术不得被当最终报告：加一个最小启发式（文本长度阈值 + 是否含结构标记），或更稳妥——依赖 `outcome.status` 而非文本猜测：非 completed 的 report 一律带状态前缀，不让模型把 failed 报告当成功结论。

### 7.2 断流状态语义（L3）

- `SubagentStatus` 增补：`"stream_interrupted"`（provider 断流，无 synthesis）——与 `timeout / budget_exceeded / failed` 区分。
- 判定信号：`AgnesAI_error` / usage=0 / 尾部 toolCall 无 agent_end（取证已确认这些信号存在）。
- terminal 账本与 collect 返回都带此状态；barrier 回注时明确标注"子任务结果不完整"。

### 7.3 可观测性（L4 支撑）

- 新增指标：`pi_runtime_subagent_barrier_total{outcome=waited|deadline|cancelled|none}`、`pi_runtime_subagent_report_total{kind=synthesis|partial|empty}`。
- 需求可回答：某个 run 派了几个 background、几个收口、几个 deadline、回注了几次报告、报告是不是 partial。
- 沿用现有 `observeSubagentXxx`（metrics.ts）风格，additive。

---

## 8. 状态模型（汇总）

```
spawn(background) → [pendingBySession += callId] → inFlight
    ├─ settle(completed/failed/timeout/budget_exceeded/stream_interrupted)
    │     → #settled += outcome; pendingBySession -= callId; ledger.append(terminal)
    └─ deadline/cancel → interrupted（诚实：本进程未收口）; pendingBySession -= callId
父 run before_run_end → pendingFor(sessionId)
    ├─ [] → 不注入（零影响）
    └─ [callIds] → awaitSettled → followUp(结果) → 父模型合成 → 下一轮 pending=[] → 收敛
```

关键不变量：
- **I1**：父 run 结算时，若 `pendingFor(sessionId)` 非空，必先经 barrier。（结构化并发）
- **I2**：每个 background callId 只回注一次（`.finally()` 移除 + 幂等）。
- **I3**：子会话工具集在构造期就不含编排工具（fail-closed，非提示词级）。
- **I4**：非 completed 的报告带显式状态前缀，永不被当成功 synthesis。

---

## 9. No-Go（明确禁止的伪修复）

- ❌ 只加指标 / 只改日志——治标不治本（用户明确否）。
- ❌ 只在 prompt 里加"必须等 collect"——L1 已证明提示词纪律在断流下失效。
- ❌ 把 `collect_subagent_result` 加进子代理白名单——与递归封死/越权隔离冲突，且没解决"父不等"的根因。
- ❌ patch vendor / 依赖 experimental pico3 作为本次交付——CI 类型是 0.99.2 权威，experimental 不可上生产。
- ❌ 建独立 Planner 子代理 / task_create 三工具族 / ask_user 强制阶段——roadmap 已 No-Go。

---

## 10. 验证策略（行为级 + 变异自检）

### 10.1 行为级测试（不是 unit-level collect）

1. **B1 barrier 阻塞**：spawn background（runner 故意延迟 settle）→ 驱动主 run 到收尾 → 断言 before_run_end 挂住直到 settle，且 followUp 含报告；未 settle 前不得产出终态。
2. **B2 主动回注**：两个 background 分别 completed/failed → 断言 followUp 一次含两条、状态正确。
3. **B3 deadline**：runner 永不 settle → 断言 deadline 后标 `interrupted`，父 run 不被永久挂住。
4. **B4 cancel**：主 run abort → 断言子 run 收 failed、barrier 不悬挂。
5. **B5 幂等收敛**：followUp 续跑后 pending 清空 → 断言第二次 before_run_end 不注入（不会无限续跑）。
6. **B6 plan-gate 与 barrier 并发命中**：两个 followUp 同时存在 → 断言都不丢（覆盖 5.4 last-write-wins）。
7. **B7 上下文隔离**：起真子会话 → 断言其 transcript 无主 run skill/spawn hint 文本、工具集无 collect/spawn。
8. **B8 报告提取**：构造"开场白 + toolCall 断流"transcript → 断言 report 不是开场白、带 partial / stream_interrupted。

### 10.2 变异自检（判据必须能 RED）

对每把刀做行级变异，确认对应行为测试转 RED：

- P1：把 `pendingFor` 改成恒返回 `[]` → B1/B2 必须 RED。
- P1：把 `.finally()` 的 pending 移除删掉 → B5 必须 RED。
- P2：把干净 `build` 改回 fork 全量历史 → B7 必须 RED。
- P2：把 collect/spawn 加进子代理工具表 → B7 必须 RED。
- P3：把报告提取改回倒序取第一条 → B8 必须 RED。

⚠️ 判 RED 用**完整 stdout 的失败标记**（`AssertionError` / `failing tests`），不用 `| tail`（会吞退出码）——项目已多次踩此坑。

### 10.3 静态门禁 + 类型

- `vue-tsc -b`（勿加 `--noEmit`，composite TS6310），PATH 用 nvm node24 绝对路径。
- 工具契约静态门禁（scripts/verify-tool-contract.ts）覆盖新增 hook 用法。
- vitest nvm node24 + `--maxWorkers=1 --no-file-parallelism`。

---

## 11. 分刀实施顺序与交付边界

| 刀 | 内容 | 主要改动面 |
|---|---|---|
| **P1** | pendingBySession + awaitSettled + 单一 before_run_end handler 合成 followUp + deadline/cancel/fail-soft | gate/subagent.ts、gate/subagent-barrier.ts（新）、gate/plan-gate-wiring.ts（暴露纯函数）、index.ts、metrics.ts |
| **P2** | runSubagent 干净会话 + subagent systemPrompt + 结构化首注入 + 保留 fork A/B seam（验证后删） | session-manager.ts、spawn-subagent.ts（prompt 组装复用） |
| **P3** | 报告提取修复 + stream_interrupted 状态 + 可观测 | session-manager.ts、gate/subagent.ts（状态类型）、metrics.ts、subtask-ledger.ts |

单 PR 三 commit 分段（P1 / P2 / P3），TDD 红-绿推进。

**交付边界（用户已确认）**：spec + plan + 实现（走完 TDD）。CI 全绿后停在合并前，等用户单独授权合并-部署-生产取证-复测；本 spec 阶段严禁写产品代码。

---

## 12. 待评审决策点（HARD-GATE 请拍板）

- **D1（5.4）**：plan-gate 与 barrier 的 followUp 合并方式——推荐"单一 handler 合成"，是否采纳？
- **D2（6.3）**：P2 子代理 systemPrompt 用专门精简版（不含 skill 纪律）——是否接受"子代理看不到主 run 对话历史"这一语义变化（task 需自包含）？
- **D3（7.2）**：是否新增 `stream_interrupted` 状态（additive 到 SubagentStatus / 账本 / collect）？
- **D4（5.3）**：barrier deadline 取 `SUBAGENT_TIMEOUT_MS + 缓冲` 具体缓冲值（建议 30s），是否认可？

> spec 批准后再进入 writing-plans。任何一条 No-Go 被触碰或决策点未定，不得开工。
