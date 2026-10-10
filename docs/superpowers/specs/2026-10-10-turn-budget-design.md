# C2 turnBudget 轮次硬边界设计规格

| | |
|---|---|
| 版本 | v1.0.0（draft-review） |
| 日期 | 2026-10-10 |
| 模块 | 任务管理模块 §C2（L5 规模控制） |
| 上游 | `2026-10-09-task-management-module-design.md`（原则 §2.2）、`2026-10-09-workbuddy-task-planning-benchmark.md`（L5/P3） |
| 状态 | 已立项，未实现 |

## 1. 背景与目标

对标分析 §结论 4：**「规模必须有硬边界：turns/并发/超时/预算全部是不可禁用的默认值，宁紧勿松」**。现状（对标 §5）：pi-runtime 内核与业务层均无 maxTurns/轮次预算，实际只靠 tool-result-budget、compaction、stall watchdog 间接约束——失控循环（模型反复调工具不收敛）没有任何轮次上限兜底，每轮都是全上下文 LLM 调用，成本无界。

C2 给 **每个 run**（一次用户 prompt 触发的 agentic loop）加轮次硬边界。WorkBuddy CLI 用 `MAX_TURNS=500` 暴露同族能力；我们**照抄其原则（env 可调 + 默认即硬边界），不照抄其数值**——画布 run 粒度远小于 CLI 任务（正常 5-30 轮，复杂任务含 C3 followUp 续轮很少超 60），500 在画布场景等于没有护栏。

**拍板记录**（2026-10-10 与用户确认）：
- 超限行为 = **软着陆 + 硬停双层**（WorkBuddy「护栏组合」哲学；否决仅硬停——长任务用户只见「莫名中止」；否决仅软提示——不构成硬边界，违背立项初衷）。
- 默认预算 = **120 轮**（PI_RUNTIME_TURN_BUDGET 可调，off 关闭）。120 是「不误伤正常复杂 run」约束下的偏紧值，上线后按 metrics 分布再收紧。

## 2. 范围

**做**：per-run turn 计数、软着陆 steer、超限硬停、env 配置、metrics 观测。
**不做**（显式非目标）：并发子代理上限（C4 范畴）、生成预算（已有）、session 生命周期级预算（跨 run 累计——长会话误伤面大，先不做）、硬停的专属用户可见文案（复用既有 stopped/agent_end 展示，与 stall watchdog 同等可见性；产品有要求再迭代）、per-session 配置下发。

## 3. 设计

### 3.1 计数：run 窗口内只数当前 run 的 turn_start

- **计数单位** = `turn_start` 事件（vendor `generation.ts:163`：仅 `nextAttempt === 1` 时发 ⇒ 重试天然不计）。
- **窗口** = `run_start`（`{ runId, startedAt }`）→ `run_end`。`run_start` 时重置计数；`run_end` 清窗口标记。
- **关键排除**：`turn_start.runId` 实为 `drive.operationId`——auto-compaction/navigation 是独立 operation，runId 不同。**只计 `evt.runId === entry 当前 run 的 runId` 的 turn_start**，压缩轮自动排除（这是本设计最重要的一条正确性判据）。
- deferred 轮询轮（`turnId` 含 `:poll:`）runId 与 run 相同 ⇒ 正常计入（它们是真实 LLM 调用）。

### 3.2 软着陆：预算将尽时 steer 一次

- 触发：计数首次达到 `budget - 10`（默认 110）⇒ `lane.steer("轮次预算将尽（剩余约 10 轮），请尽快收尾并总结当前进展。", undefined, this.context)`（session-manager:1799 同款调用）。
- **每 run 只 warn 一次**（`turnBudgetWarned` 标记）——反复插话会把「预算将尽」本身变成噪音源。
- steer 走 vendor 原生插话通道，前端展示复用既有「用户补充 · 插在本轮进行中」链路，零前端改动。

### 3.3 硬停：超限即结算（复用 stall watchdog 模式）

- 触发：计数超过 budget（`turn_start` 处理器内判定）⇒ 与 `stallWatchdogTick`（session-manager:1369-1395）完全同路径：
  1. `entry.userAborted = true`（抑制 abort 引发的假警报 error 事件；aborted 不进错误率，:1238 既有语义）
  2. `entry.cancelRun("turn_budget")` 解开在途 await
  3. `void this.forceSettleLaneOperation(entry)` 释放 lane 锁
  4. `console.warn` 留痕 + metrics 计数
- **只结算一次**（`turnBudgetSettled` 标记，同 watchdog 的 `stallSettled` 闸）。
- 不调用 `harness.abort()`（需要额外 context 构造且与既有取消链路重复）；不注入 followUp/补偿轮——中止就是中止，用户开新对话继续。

### 3.4 配置与 kill switch

- `PI_RUNTIME_TURN_BUDGET`：正整数（默认 `120`）；字面量 `off`（大小写不敏感）= 整体关闭（不计数、不 warn、不硬停）。延续 C1/C3 kill switch 家族惯例：**只做整体开关，不做半开语义**（模块原则 §2.2-4）。
- 落点：`runtime-config.ts` 新增 `turnBudget(env): number | "off"`（`parsePositiveInt` + `off` 特判），经 `RuntimeConfig` 流入 session-manager。

### 3.5 观测

- `pi_runtime_turn_budget_warned_total` / `pi_runtime_turn_budget_exceeded_total`（counter，Metrics 类两字段 + render 块，C3 同款）。
- 正常 run 的轮次分布暂不做 histogram（YAGNI：超限样本本身就是最有价值的信号；要分布时 SSE turn_start 已可离线统计）。

## 4. 不变面（承诺不动）

- 事件格式 / SSE 协议 / 前端 / details 快照 / C1 注入逻辑 / C3 plan-gate 与 generation-gate 行为——零改动。
- `stallWatchdogTick` 与 `forceSettleLaneOperation` 本体不改（C2 只是新增第三个调用方）。
- 不新增表、不新增端点、不新增依赖。

## 5. 风险与 Review Focus

1. **compaction 误计数**（§3.1）：若 vendor 未来改 operationId 语义（runId 与 run 混同），排除逻辑失效。测试钉：伪造异 runId 的 turn_start 断言不计数。
2. **硬停与 C3 followUp 的交互**：plan 确认后的 followUp 续轮属于同一 run ⇒ 共享同一预算窗口。极端长方案执行可能撞预算——这是**预期行为**（预算本就该覆盖续轮），但必须在测试中验证 followUp 轮继续计数而非清零。
3. **硬停时 steer 消息滞留 inbox**：warn 后紧跟失控循环直到超限，steer 已被消费；若 warn 与超限之间 run 被外部中止，steer 滞留 inbox 会由既有 drainAfterRun 排空——不加新逻辑，测试覆盖一次即可。
4. **计数丢失窗口**：budget 结算异步（forceSettle fire-and-forget），结算期间后续 turn_start 仍可能到达——`turnBudgetSettled` 闸后不再重复触发，计数漂移无害。
5. **kill switch off 语义**：off 时 §3.1-3.3 全部旁路，且存量无状态（无播种需求——计数是纯内存 per-run，重启即失）。

## 6. 测试策略（概要，实现计划里展开）

- 单元：`turnBudget` 解析（120 默认 / 自定义 / off / 非法值回落）。
- 集成（faux provider 驱动真实 run，C3 集成测试同骨架）：预算=3 时第 4 轮硬停（metrics+1、无 error SSE、agent_end 到达）；warn 恰好一次；异 runId turn_start 不计数；off 全旁路；run 正常结束后下一 run 从 0 计数。
- 回归：stall watchdog、C1 todo-resume、C3 plan-gate 集成全量不回归。

## 7. 上游 upmerge 重映射

vendor 1.0.0 已迁 `pi-durable`；本设计落点 `session-manager.ts` / `runtime-config.ts` / `metrics.ts` 均在自有层，无 vendor patch；`generation.ts:163` / `lane.ts` 行号引用仅作证据记录，upmerge 时需重新定位（规则同模块全景 §7 规则 2）。
