# 批次 3 设计：未完成态可见 + 自动续跑

> 2026-10-21 · 对应 spec：[`../specs/2026-10-21-turn-continuity-design.md`](../specs/2026-10-21-turn-continuity-design.md) §5 L-C
> 计划：[`../plans/2026-10-21-turn-continuity.md`](../plans/2026-10-21-turn-continuity.md)

## 0. 批次 1/2 已交付什么（先对齐，避免重复造）

| 批次 | 交付 | 能力边界 |
|---|---|---|
| 1（PR #530/#533） | `turnState` 落 Nest DB（权威）⇒ 每轮重算注入动态块 + 走既有 `RetentionState` 通道 | **能接上**（模型知道上一轮要什么/卡在哪） |
| 2（PR 待合） | 双写对账（Nest 最近 user 消息 vs pi 侧 `transcriptTail`）⇒ 发现分叉 + 自愈（写 `turnState`） | **能发现**（分叉不再静默） |

⇒ 批次 3 要解决的是**剩下的两个缺口**：

1. **用户看不见**：模型能接上，但**用户**不知道「上次卡在哪」⇒ 仍需用户自己发「继续」；
2. **用户得多说一句话**：失败后要等用户发「继续」才恢复 ⇒ WorkBuddy 是**自动**续跑。

---

## 1. 子项 3.1：画布上可见的「未完成」

### 目标

把「这一轮中断了，还剩什么」做成**画布上的一等公民** —— 用户直接看到「上次卡在出图这一步」，
不必靠 agent 复述、也不必发「继续」才知道有半成品。

### 为什么落在画布而不是聊天流

canvas agent 的产物是**画布上的图元**，「做了一半」是**画布的常态**
（用户手动改一半再让 agent 继续）⇒ 把它做成画布对象才符合场景。
（对齐 WorkBuddy 的做法：半成品节点打 `status: incomplete`。）

### 形态（最小）

`CanvasNode.data.status` 加一个取值 `incomplete`（现有取值：`generating` / `completed` /
`failed` / `pending_confirm` / `fallback_pending` / …，**没有** `incomplete`）。

配套两个字段（在 `data` 里，不动 shared 的节点类型 —— `data` 是 `Record<string, unknown>`）：

| 字段 | 含义 | 来源 |
|---|---|---|
| `incompleteReason` | 中断类型的人话（`上游模型调用报错` / `工具执行期间中断` / …） | `TurnState.interruption` ⇒ `describeTurnInterruption()` |
| `incompleteAt` | 中断时刻（epoch ms） | `TurnState.at` |

### 写入时机与位置

**不新增写入路径** ⇒ 复用已有的 `canvasData` 落库通道：

- 中断发生时（`recordTurnStateOnInterruption` 旁）⇒ 找出**本轮涉及的节点** ⇒ 打 `incomplete`；
- 下一轮成功完成后 ⇒ 把这些节点的 `incomplete` 清掉（恢复 `completed`）。

⚠️ **关键约束**：「本轮涉及的节点」从哪来？
- `executionEvents` 里有 `tool_execution_start` 的 `nodeId`（画布工具会带 nodeId）；
- 取**本轮最后一个**成功创建的节点 + 最后一个未完成的节点 ⇒ 标 `incomplete`；
- 标不到任何节点 ⇒ **不标**（宁可不标，也不乱标）。

### 前端渲染

复用**已存在**的 `pending_confirm` 渲染路径（`CanvasPage.vue` 已有类似标记）⇒
新增 `incomplete` 档（视觉：虚线描边 + 「未完成」角标 + 悬浮显示原因）。

⛔ **不新造视觉体系** ⇒ 用既有 design token（`--lnk-*`），不新增 hex/rgba。

### 判据

| 不变式 | 怎么锁 |
|---|---|
| 中断 ⇒ 目标节点 `status=incomplete` 且带原因 | 后端单元测试（假 canvasData） |
| 成功后续跑 ⇒ `incomplete` 被清掉 | 同上 |
| 标不到节点 ⇒ 不标（不乱标） | 同上 |
| 前端只认 `incomplete` 档 | 前端组件测试（`CanvasPage` 渲染） |

### 风险

- ⛔ 别把**用户手动改一半**的节点误标（用户主动中断 ≠ agent 故障）⇒ 只在 `failed=true` 时标；
- ⛔ 别覆盖**已有终态**（`completed`）⇒ 只标 `generating` / `fallback_pending` / 无 status 的节点。

---

## 2. 子项 3.2：自动续跑（失败不等用户）

### 目标

失败后**不等用户**说「继续」，自动让 agent 接着做。

### 移植 WorkBuddy 的做法（不是照抄文案）

WorkBuddy 在失败时**不等用户**，自动向模型注入：
> *"Output interrupted. Resume directly — no apology, no recap. Pick up mid-thought if that is where the cut happened."*

并原地重试当前轮（带预算）。

⭐ 但**文案不是移植重点，机制才是**：
- 注入「直接接着做」的指令（不道歉、不复盘）⇒ **本仓已有这套指导语**（`renderTurnStateGuidance()`，
  批次 1 写的）⇒ 复用，不重写；
- 带预算的原地重试 ⇒ **本仓已有** `generation-recovery` 派发器形态。

### 复用既有派发器（不新造限流）

`apps/server/src/agent/generation-recovery/recovery-dispatch.decider.ts` 已有：
- `hasActiveRun`（不打断正在跑的轮）
- `userOnline`（用户不在场时才自动）
- 幂等键（同一失败不重复派发）
- 每时限流
- 同因连败降级

⇒ **把「对话轮次」也纳进同一个决策器**，而不是新造一套。

### 形态（最小）

| 维度 | 决策 |
|---|---|
| 触发 | 本轮 `failed=true`（不是用户主动取消） |
| 注入 | 复用 `turnState`（批次 1 通道）⇒ 下一轮动态块自动带上「接着做」的状态 |
| 重试 | **新开一轮**（不是 `lane.resume`）⇒ 幂等、不阻塞 |
| 预算 | 复用 `decider` 的限流口径（每轮最多 N 次） |
| 用户在场？ | `userOnline` ⇒ **不自动**（用户自己会说「继续」，别抢） |

### ⛔ 明确不做

- ⛔ **关键词识别「继续」**：要猜用户意图，「接着改那个组件」即失效；
- ⛔ **`lane.resume()` 自动续上游 LLM**：`lane.drive` 命中「续推」分支会真实 resume 上游 LLM，
  本仓 `cmv3zzid` 事故已证**阻塞 612 s**（`session-manager.ts:1351-1369`）。
  ⇒ 自动续跑只走「**新开一轮**」，让模型基于 `turnState` 重新决策，不复用上游 operation 断点；
- ⛔ **把上游 `pi.op.state` 断点接进对话主链路**：那是恢复「工具级副作用」的机制，
  与本问题（对话层失忆）是两件事；混在一起会让「重放副作用」的幂等性风险扩散到对话主链路。

### 判据

| 不变式 | 怎么锁 |
|---|---|
| 失败 ⇒ 自动派发一轮（带「接着做」状态） | 派发器单元测试（假 client） |
| 用户在场 ⇒ **不**自动派发 | 同上 |
| 用户取消 ⇒ **不**派发 | 同上 |
| 幂等：同一失败只派一次 | 同上（幂等键） |
| 连败 ⇒ 降级（不无限重试） | 同上（`decider` 口径） |

---

## 3. 交付顺序（建议）

| PR | 内容 | 依赖 | 风险 |
|---|---|---|---|
| A（批次 2） | 双写对账 + 自愈 | 批次 1 | 低（纯观测 + 复用既有通道） |
| B（3.1 后端） | 节点 `status: incomplete` 写入 | A | 中（碰 `canvasData` 落库） |
| C（3.1 前端） | `incomplete` 渲染 | B | 中（跨端 + 视觉） |
| D（3.2） | 自动续跑 | A | 中（碰派发器 + 会自动产生新轮次） |

⭐ **不要把 B+C+D 塞进一个 PR** ⇒ 三个不同风险面（画布数据 / 视觉 / 自动行为），
分开才能各自灰度与回滚。
