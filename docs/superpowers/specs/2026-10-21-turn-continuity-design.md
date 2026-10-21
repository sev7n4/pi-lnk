# 回合连续性设计：故障后说「继续」能接上

> 2026-10-21 · 起因：生产事故（移动端 canvas agent，用户说「继续」后 agent 只剩「感知画布」）
>
> 本文档是 **spec**（设计为什么）。实施计划见 `docs/superpowers/plans/2026-10-21-turn-continuity.md`。

## 1. 事故现象

用户在移动端给 agent 发了两张图 +「让他们抱在一起」，中途因故障中断。
20 分钟后用户发「继续」，agent 回答：

> 当前画布上有：1. **河马摸鱼图** — 已完成 2. **小男孩图** — 刚生成，戴着草帽的水彩风格小男孩 🎨
> 接下来想做什么？比如：- 继续调整小男孩的样式/姿势 - 生成其他角色或场景 …

agent 的内部思考原文：

> 用户说"继续"，但没有明确的新指令。让我看看当前画布状态，确认有什么可以做。
> 从之前的操作来看，画布上有：- 河马摸鱼图（已完成） - 小男孩摸鱼（已完成，戴帽子）

**问题**：用户明确说过「让他们抱在一起」，agent 却完全不知道这句话的存在，
只能靠读画布反推「继续」是什么意思 ⇒ 相当于失忆。

## 2. 生产取证（不是推测）

### 2.1 Nest 侧 `AgentMessage` 表时间线（北京时间）

```
2026-10-20 16:31:21 | assistant | 参数已更新：风格=写实 + 绘本插图
2026-10-21 00:40:48 | user     | 继续
2026-10-21 00:40:52 | assistant| 生成校验暂时不可用，无法自动执行。…
2026-10-21 00:57:11 | assistant| 小男孩已生成完成！戴着一顶可爱的草帽…
2026-10-21 01:03:50 | user     | 让他们抱在一起          ← 故障轮：assistant 行缺失
2026-10-21 01:24:30 | user     | 继续
2026-10-21 01:24:46 | assistant| 当前画布上有：1. 河马摸鱼图 …      ← 只谈画布
```

⇒ Nest 侧**有** 01:03:50 的 user 消息。

### 2.2 pi 侧 transcript 时间线（`/data/sessions/<key>/sessions/*.jsonl`，8.2 MB，2777 行）

```
seq=2759  00:57:11  assistant  stop=stop     "小男孩已生成完成！戴着一顶可爱的草帽…"
          ← 27 分钟真空：seq 2759 → 2768 之间 0 条 entry →
seq=2768  01:24:31  user      "继续"
seq=2883  01:24:33  assistant  toolUse      [get_canvas_summary][view_canvas_media]
seq=3137  01:24:46  assistant  stop=stop    "当前画布上有：1. 河马摸鱼图 …"
```

- `COMPACTION_COUNT=0` ⇒ **排除**上下文压缩导致的历史折叠。
- 全文 grep「抱在一起」**零命中** ⇒ pi 侧 transcript **没有** 01:03 那一轮。

### 2.3 结论：两份历史静默分叉

| 存储 | 有「让他们抱在一起」？ | 模型能看到？ |
|---|---|---|
| Nest `AgentMessage` 表 | ✅ | ❌（不进 prompt） |
| pi transcript | ❌ | — |

`apps/server/src/agent/agent.service.ts:410` 明写：

> P0-①：不再查 AgentMessage 历史喂 prompt —— 会话跨轮常驻，历史已在 pi 侧原生 context 里。

**这个假设在故障轮上不成立。** 而两份历史是独立双写，**无任何一致性校验** ⇒ 静默分叉。

## 3. 根因（三层，逐层可修）

### L1 事实层：上游主动把中断轮排除出上下文

`vendor/earendil-works/pi/packages/agent/src/harness/session/context.ts:24-29`：

```ts
function isContextMessage(message: AgentMessage): boolean {
	return (
		message.role !== "assistant" ||
		(message.stopReason !== "error" && message.stopReason !== "aborted" && message.stopReason !== "deferred")
	);
}
```

⇒ 中断轮的 assistant 输出**虽然落盘**，但**不进下一轮上下文**。这是上游的**刻意设计**
（半截输出不可信），不是 bug。但 pi-lnk 没有任何补偿机制。

### L2 结构层：双写无对账 + 无「未完成状态」

- 两份历史独立写、**无一致性校验**；
- 项目里**没有任何**「上一轮未完成的意图」的结构化表示
  （`grep resumeBrief|recoveryBrief|contextRebuild|lastTurnSummary|interruptedTurn|pendingIntent` ⇒ 零命中）；
- `todo` 是**纯内存** Map（`services/pi-runtime/src/tools/todo.ts:22`），进程重启即空。

⇒ 中断后模型能看到的「状态」只有**画布** ⇒ 它只能读画布。

### L3 能力层：上游提供的续跑能力全部未用

| 上游能力 | 位置 | pi-lnk 现状 |
|---|---|---|
| `AgentLane.resume(context)` | `harness/agent-harness.ts:560` | **零调用** |
| `harness.create()` 返回 `open: OpenOperation[]` | `harness/runtime/harness.ts:389-404` | 只用来 **abort** 结算孤儿，从不 resume |
| `appendCustomEntry` + `entryProjectors` | `harness/runtime/lane.ts:1919` / `harness/runtime/harness.ts:72` | **零使用** |
| `pi.op.state` / `pi.op.preparation`（operation 断点） | `harness/session/values.ts:164-171` | 主动丢弃 |
| `ToolCall.status` + `replay: "never"｜"safe"` | `harness/session/types.ts:156-162` | 未用 |

## 4. 行业最佳实践对照

### 4.1 跨产品共识（Codex / Claude Code / WorkBuddy 三方一致）

1. **任务状态 ≠ 对话历史**：任务状态独立持久化，历史被压缩/丢弃时它仍存活。
2. **中断轮保留 + 显式标记**（`status: "incomplete"` / `isPartialAborted`），而非丢弃。
3. **恢复靠「信息在状态里」，不靠猜用户意图**。
4. **压缩不删原文**，只折叠摘要并把 transcript 路径交给模型。
5. **状态写入与实质动作同一条消息**（WorkBuddy：*"a ledger append in the same call as the commit, never in a call of its own"*）。

### 4.2 WorkBuddy（本机实证，`/Applications/WorkBuddy.app/…/cli/dist/*.mjs`）

- **无「继续」关键词识别**（全量检索 `继续`/`接着`/`go on` ⇒ **0 命中**）；
  它靠「上一轮 assistant 的半截输出 + `status:"incomplete"` **就在历史里**」，
  模型自己知道「我上次说到一半被打断了」。
- `error-recovery` 机制：失败后 runtime 主动向模型注入
  *"Output interrupted. Resume directly — no apology, no recap. Pick up mid-thought if that is where the cut happened."*
  并**原地自动重试当前轮**（带预算）——**用户根本不用说「继续」**。
- 任务清单独立成文件：`~/.workbuddy/tasks/<storageId>/<n>.json`（原子写 + 文件锁），
  与对话历史**零耦合**。
- 压缩不删原文，且给模型 transcript 路径
  （*"If you need specific details from before compaction … read the full transcript at: `<path>`"*）。

### 4.3 明确**不该**抄的

- ❌ **关键词识别「继续」**：要猜意图，在「接着改那个组件」「刚才那个先放着」上立刻失效。
- ❌ **自动 resume 上游 LLM**：本仓 2026-10-12 事故 `cmv3zzid` 已证明
  —— `lane.drive` 命中「续推」分支会真实 resume 上游 LLM，阻塞 612 s
  （`services/pi-runtime/src/session-manager.ts:1351-1369`）。孤儿只能是「收尾」。

## 5. 方案：三层防线

> ⚠️ **2026-10-21 修正说明（本节已重写）**
>
> 初版（PR #525）把状态写成 pi 侧自定义条目（`appendCustomEntry` + `entryProjectors`）。
> 自我审查发现**三处不成立**，本节已按修正后的形态重写：
>
> 1. **压缩必丢**——`buildContextEntries`（`vendor/…/harness/session/context.ts:10-23`）在有
>    compaction 时返回 `[compaction, ...compaction之后的entries]` ⇒ compaction **之前**的
>    自定义条目被丢弃；且 `CompactionEntry.retainedTail: AgentMessage[]`（`types.ts:36`）
>    **只含 message，不含 custom entry**。
>    ⇒ 初版所说「写在 transcript 里则天然参与上游 compaction 的保留机制」是**错的**。
> 2. **第三条真相线**——Nest 已决定「不再查 AgentMessage 历史喂 prompt」
>    （`agent.service.ts:410`），再加一份 pi 侧状态 = 多一处分叉面。
> 3. **绕过了宿主既有通道**——跨压缩保留早就有
>    （`services/pi-runtime/src/compaction-retention.ts` 的 `RetentionState`
>    → `lane.compact({ customInstructions })` ⇒ 拼进压缩摘要 prompt）。
>    另开通道违背「吃满上游」的第一步：**先穷尽宿主既有的同类通道**。
>
> ⇒ 修正后的形态：**权威在 Nest DB**，pi 侧只改**一处**（见下）。

### L-A 恢复层（本次实施）：Nest 侧权威状态 + 每轮重算注入

**做法**：中断发生时，把「用户要什么 / 做到哪 / 卡在哪」记进 **Nest DB**
（`AgentThread.turnState`，权威副本）；每轮装配 prompt 时读出、渲染成**动态块**喂给模型。

```
Nest（检测到中断）
  └─ AgentThread.turnState = { userText, completedSteps, pendingSteps, interruption, at }
       └─ 下一轮装配 prompt：
            ├─ 动态块（systemPrompt 尾部）⇒ 模型当轮就看到「上一轮要什么/做到哪/卡在哪」
            └─ 保留段（RetentionState.keyToolConclusions）⇒ 压缩摘要里也带着
```

**为什么权威在 Nest**：
- 模型只看得到 pi 侧上下文 ⇒ 权威必须在能算「这一轮要什么」的地方（Nest）；
- Nest 侧 DB 天然跨压缩、跨进程、跨 transcript 重建存活；
- 只有一条真相线 ⇒ 不加剧「Nest 表 vs pi transcript」的双写分叉面。

**为什么动态块能跨压缩存活**（关键，与 `todo` 块同机制）：
`assembleDynamicBlocks`（`session-manager.ts:2361-2369`）在**每次 LLM 请求前重新求值**
systemPrompt ⇒ 压缩后重新组装，块恒在。注释原话：
*"todo 块在**组装时**从内存 store 实时读取——不进 turn 状态（turn 是 Nest 整体覆盖语义，
存进去会被下一轮 Nest 载荷冲掉），这才是「跨压缩存活」的实现点"*。
⇒ turn state 走**同一模式**（状态在 Nest 侧持久，块每轮重算）。

**为什么还要保留段**（两个通道**互补**，不是重复）：
动态块保证「**下一轮**模型看到」；保留段保证「**压缩摘要里**也带着」——
因为上游压缩时 `retainedTail` 只留 `AgentMessage`，压缩前的动态块**不在**其中。

**⚠️ pi 侧唯一的一处改动：给动态块加 `turnstate` 预算档位**

`classifyBlock`（`dynamic-budget.ts:50-59`）按块首前缀分档，未识别的落 `general`
⇒ `general` 份额 **0** ⇒ 只享 `MIN_BLOCK_CHARS = 80` 字符保底。
状态块全文约 400~2000 字符 ⇒ **「用户当时的请求：让他们抱在一起」会被截掉**
⇒ 模型看不到用户要什么 ⇒ **退回「读画布猜意图」= 本次事故的形态本身**。

⇒ 与 `todo` 档**完全同构**（既有注释原话：*"任务清单截断=静默丢任务，故给独立 kind
而非落 general 80 字保底"*）⇒ 给 `turnstate` 独立 kind + 5% 份额（从 canvas 挪出）。

> ⭐ 这是**实施期才发现的缺陷**：初版方案（pi 侧 custom entry）不经过动态块预算，
> 所以没暴露。改走动态块后才暴露 ⇒ **「同一份状态换通道」会带出新约束**。
> 已在 `dynamic-budget.test.ts` 钉死（变异实测：去掉 `turnstate` kind ⇒ 测试红）。

### L-B 事实层：双写对账（后续批次）

给 Nest ↔ pi 的历史加**周期性对账**（例如记录两侧最后一条 user 消息的哈希/序号），
分叉时**告警**并触发一次状态重放。
⇒ 本次不做：需要 pi 侧暴露「本会话 transcript 尾部」查询，成本与收益要单独评估。
> ⚠️ 批次 2 的对账范围**必须包含 `turn_state`**：它现在是第三条需要校验的状态线
> （Nest 权威 ⇒ pi 侧投影），若不纳入对账，分叉会静默。

### L-C 产品层：前端可见的「未完成」（后续批次）

把「这一轮中断了，还剩什么」做成**画布上的一等公民**（节点 `status: incomplete` + 原因），
用户能直接看到「上次卡在哪」，而不必靠 agent 复述。

## 6. 验证

> ⚠️ 本节已按修正后的形态重写（初版的验证是针对 pi 侧 custom entry 方案的）。

### 6.1 纯函数测试（shared + Nest）

- `packages/shared/src/turnState.ts` + `apps/server/src/agent/turn-state-store.test.ts`：
  构造 / 渲染 / 指导语措辞纪律 / 保留段摘要 / 容错解析 / 步骤推导 / 中断分档。
- `apps/server/src/agent/turn-state.service.test.ts`：IO 编排（写进 `AgentThread.turnState`、
  读出、清除、渲染动态块、渲染保留段），用**假 prisma**（不连真库）。

### 6.2 ⭐ 关键不变式的锁定方式

| 不变式 | 怎么锁 |
|---|---|
| 状态落在 **Nest DB**（权威） | `turn-state.service.test.ts` 断言 `update` 的 `where.id` 与 `data.turnState` |
| 状态**跨压缩**存活 | 状态在 DB（不随 transcript 被丢）+ 走**既有** `RetentionState` 通道 ⇒ 压缩摘要里也带着 |
| 模型**当轮**就看到 | 动态块每轮重算（`assembleDynamicBlocks` 同 `todo` 块机制） |
| 指导语**不引导模型反推意图** | 断言落在**指导指令**上（`renderTurnStateGuidance`），而非整块文本 |
| 坏数据**不注入** | `parseTurnState` 返回 undefined ⇒ `renderBlock` 返回 undefined ⇒ 不产出空块 |

**变异实测**（证明断言真能证伪）：

| 变异 | 结果 |
|---|---|
| projector 改 `assistant` + `stopReason:"error"`（初版方案） | `# pass 3 / # fail 2` ⇒ 红 |
| projector 恒返回 `undefined`（初版方案） | `# pass 2 / # fail 3` ⇒ 红 |
| `deriveSteps` 把失败当已完成 | `4 failed | 11 passed` ⇒ 红 |
| `shouldRecordTurnState` 恒 false | `2 failed | 13 passed` ⇒ 红 |

### 6.3 生产观测

- 指标：Nest 侧 `turn_state_recorded` 日志（记录成功/失败）+ pi 侧**不需要**新指标
  （初版加的 `pi_runtime_turn_state_records_total` 随方案修正一并撤掉）。

## 7. 已知边界

- **不覆盖「pi 侧 transcript 整体丢失」**（如会话目录被删、identity 变更触发 rebuilt）：
  此时 pi 侧历史全丢，但 **turn state 在 Nest DB 里仍活** ⇒ 下一轮动态块仍能告诉模型
  「上一轮要什么」⇒ **本方案对该场景天然更鲁棒**（初版 pi 侧方案会一起丢）。
  ⇒ 仍需 L-B 对账来发现「历史分了叉」这件事本身。
- **只记一次**：同一轮不会落两条状态（`promptAccepted` 守卫）。
- **状态在「成功收尾」后才清除**：若该轮又失败，状态保留 ⇒ 用户再说「继续」时仍能接上。
- **`userAborted` 当前恒为 `false`**：用户主动取消的路径尚未接入
  （本仓 `abort` 走的是另一条 controller 链路）。
- **不解决「压缩把**对话历史**折掉」**：那是上游 compaction 的固有行为
  （WorkBuddy 的做法是「压缩不删原文 + 把 transcript 路径交给模型」），
  本方案只保证**任务状态**不被压缩吞掉。
