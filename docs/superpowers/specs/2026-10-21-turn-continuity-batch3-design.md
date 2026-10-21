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

### ⭐ 实施期发现：能复用的既有机制（使本项成本远低于预估）

调研（2026-10-21）发现三处现成通道 ⇒ **零新增落库路径**：

| 机制 | 位置 | 复用方式 |
|---|---|---|
| **节点状态事件已存在** | pi 侧 `node_status` 事件，载荷 `{ nodeId, status, url, error }`（`pi-events.ts:216`） | 从 `executionEvents` 里取 `node_status` ⇒ **带 nodeId**，判据单一可靠 |
| **改节点已有动作** | 画布动作 `update_node`：`payload.data` 走 `mergeNodeData` **深合并**（`useCanvasActions.ts`） | 只发要改的字段 ⇒ **不覆盖**节点其它 `data` |
| **落库已有通道** | `finalizeTurn(..., canvasActions, …)` 把 `canvasActions` 落进 `Session.canvasData` | 中断时往 `canvasActions` 推 action ⇒ 同一次落库 |

⇒ 节点 status 的写入散落在 **80+ 处**（`studio.service` / `material.service` /
`agent-canvas-tools.service`），但**标记「未完成」只需要一个写入点**（中断发生的当下）。

### 形态（最小）

`CanvasNode.data.status` 加一个取值 `incomplete`（现有取值：`generating` / `completed` /
`failed` / `pending_confirm` / `fallback_pending` / …，**没有** `incomplete`）。

配套两个字段（在 `data` 里，不动 shared 的节点类型 —— `data` 是 `Record<string, unknown>`）：

| 字段 | 含义 | 来源 |
|---|---|---|
| `incompleteReason` | 中断类型的人话（`上游模型调用报错` / `工具执行期间中断` / …） | `TurnState.interruption` ⇒ `describeTurnInterruption()` |
| `incompleteAt` | 中断时刻（epoch ms） | `Date.now()` |

### 判据（已实现，`incomplete-node.ts`）

- **只标未到终态的节点**：`generating` ⇒ 中断时它还在跑 ⇒ 未完成；
  `completed` / `failed` / `error` ⇒ 已有终态 ⇒ **不标**（不覆盖既有终态）；
- **同一节点取最后一次状态**（先 `generating` 后 `completed` ⇒ 不算未完成）；
- **只认 `node_status` 事件**（不从工具事件猜 nodeId —— 工具事件的 nodeId 语义不统一，猜错会标错节点）；
- **标不到节点就不标**（本轮没碰画布 ⇒ 宁可不标也不乱标）；
- **只在 `failed=true` 时标**（用户主动取消 ≠ agent 故障 ⇒ 标「未完成」会误导）。

### ⭐ 刻意不实现「清除未完成标记」

`incomplete` 是**事实陈述**（这个节点在中断那一刻没跑完），**不是**状态机的一环：

- 节点后来跑完了 ⇒ 生成流程写 `completed` ⇒ `mergeNodeData` 深合并 ⇒ **自然覆盖** ⇒ 角标消失 ✅
- 节点后来又失败了 ⇒ 流程写 `failed` ⇒ 自然覆盖 ✅
- 节点**再也没被碰** ⇒ 保留 `incomplete` ⇒ **正确**（它确实还没完成）✅

⇒ 主动清除反而会**说谎**（把没完成的节点标成 completed）。
⇒ 「什么时候清」的答案是：**不主动清**。

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

### 复用既有派发器（不新造限流）—— ⭐ 实施后修正

`apps/server/src/agent/generation-recovery/recovery-dispatch.decider.ts` 已有：
- `hasActiveRun`（不打断正在跑的轮）
- `userOnline`（用户不在场时才自动）
- 幂等键（同一失败不重复派发）
- 每时限流
- 同因连败降级

⇒ **把「对话轮次」也纳进同一个决策器**，而不是新造一套。

#### ⭐⭐ 实施修正：**机制复用，判据分开**（2026-10-21）

实际实施时发现：**两个场景的「在线门」语义相反**，不能塞进同一个函数。

| 场景 | 用户在场 | 用户不在场 | 理由 |
|---|---|---|---|
| 生成失败回注 | **回注** | skip | 失败要当面告诉用户；人不在时说了也白说 |
| 对话轮次自动续跑 | **skip** | **续跑** | ⭐ 用户在场时他会自己说「继续」，别抢他的意图 |

⇒ 若塞进同一个 `decideRecoveryDispatch`，那个函数的在线分支会变成「看场景决定」的双态逻辑
⇒ 既有测试要跟着改，且新增场景时容易踩错分支。
⇒ **判据独立**（`turn-auto-resume/auto-resume.decider.ts`），但**限流/在线代理/注入通道全复用**。

#### ⭐ 实施发现：不需要自造注入内容

批次 1 的 `renderTurnStateGuidance()`（`packages/shared/src/turnState.ts`）已含
「不道歉、不复盘」指导语（措辞对齐 WorkBuddy 的 "Resume directly — no apology, no recap"）
⇒ 自动续跑只需**新开一轮**，那一轮自然吃到 `turnState` 动态块
⇒ **零新增注入通道**；注入文本只点明「接着做」，**不重复**状态内容
（重复会让模型以为状态出现两次）。

#### ⭐ 两道防线互补（不是冗余）

- 限流 = **短窗口**（1 小时内最多 1 次）⇒ 防刷屏；
- 连败 = **长窗口**（同一会话连续 2 次同因失败就停）⇒ 跨过小时额度重置后仍拦得住
  ⇒ 故障持续时不会每小时自动重试一次。

⭐ 自动续跑的上限取**更严值**（1 次/h vs 回注 2 次/h）：它会**真的再跑一轮 LLM**（消耗额度）。

#### ⭐ DI 破环

`AgentService → TurnAutoResumeService → AUTO_RESUME_AGENT_PORT → AgentService`
会成 Nest 实例化环 ⇒ 进程静默 exit 0（#398/#399 部署事故教训）。
⇒ 与 `agent-canvas-tools` 的 `generationRecovery` getter 同款：
**`ModuleRef` 运行时惰性 get**（`@Optional`，单测手工构造零破坏）。

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
