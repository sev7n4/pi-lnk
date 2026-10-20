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

### L-A 恢复层（本次实施）：上游原生扩展点承载「中断轮任务状态」

**做法**：中断发生时，把「用户要什么 / 做到哪 / 卡在哪」作为**自定义条目**写进 pi transcript，
由上游 `entryProjectors` 在后续每一轮重新投影进模型上下文。

```
Nest（检测到中断）
  └─ POST /sessions/:id/turn-state
       └─ pi-runtime: lane.appendCustomEntry("lnkpi.turn_state", state)
            └─ transcript: CustomEntry{type:"custom", customType, data}
                 └─ 下一轮 buildSessionContext → entryProjectors["lnkpi.turn_state"]
                      └─ 投影成 user 消息 → 进模型上下文
```

**为什么选 user 角色**：assistant 消息会被 `isContextMessage` 按 `stopReason` 过滤；
user 角色 + 无 `stopReason` ⇒ **恒不被过滤**（已由上游真码测试锁定，见 §6）。

**为什么不写 Nest 的 DB**：模型只看得到 pi 侧。
**为什么不用动态块（`dynamicBlocks`）**：动态块每轮被 Nest 整体覆盖（`normalizeTurnContext`），
活不过下一轮；写在 transcript 里则天然参与上游 compaction 的保留机制。

### L-B 事实层：双写对账（后续批次）

给 Nest ↔ pi 的历史加**周期性对账**（例如记录两侧最后一条 user 消息的哈希/序号），
分叉时**告警**并触发一次状态重放。
⇒ 本次不做：需要 pi 侧暴露「本会话 transcript 尾部」查询，成本与收益要单独评估。

### L-C 产品层：前端可见的「未完成」（后续批次）

把「这一轮中断了，还剩什么」做成**画布上的一等公民**（节点 `status: incomplete` + 原因），
用户能直接看到「上次卡在哪」，而不必靠 agent 复述。

## 6. 验证

### 6.1 上游链路验证（真实 vendor 代码，非 mock）

`services/pi-runtime/src/turn-state.upstream.test.ts` 用**真实** `buildSessionContext`
（vendor dist 深路径）验证：

- 自定义条目被投影进模型上下文；
- ⭐ **中断轮的 assistant 消息被上游过滤，但状态消息仍在**（关键不变式）；
- 非本类型条目不投影；坏数据不投影。

**变异实测**（证明测试真能证伪）：

| 变异 | 结果 |
|---|---|
| projector 改成 `assistant` + `stopReason:"error"` | `# pass 3 / # fail 2` ⇒ 红 |
| projector 恒返回 `undefined` | `# pass 2 / # fail 3` ⇒ 红 |
| 还原 | `# pass 5 / # fail 0` ⇒ 绿 |

### 6.2 纯函数测试

- `services/pi-runtime/src/turn-state.test.ts`：26 例（构造 / 渲染 / 投影 / 容错解析）
- `apps/server/src/agent/turn-continuity.test.ts`：15 例（步骤推导 / 记录判据 / 工具事件提取）

### 6.3 生产观测

新增指标 `pi_runtime_turn_state_records_total{outcome}`（`ok` / `no_session` / `failed`）——
这是「故障后续跑能否接上」的**先导指标**：
`failed`/`no_session` 占比升高 ⇒ 越来越多中断轮在下一轮不可见。

## 7. 已知边界

- **不覆盖「pi 侧 transcript 整体丢失」**（如会话目录被删、identity 变更触发 rebuilt）：
  此时 transcript 里没有 `turn_state` 条目可投影。⇒ 需 L-B 对账兜底。
- **只记一次**：同一轮不会落两条状态（`promptAccepted` 守卫）。
- **`userAborted` 当前恒为 `false`**：用户主动取消的路径尚未接入
  （本仓 `abort` 走的是另一条 controller 链路）。
- **不解决「压缩把状态折掉」**：状态条目的内容是 `CustomEntry`，
  compaction 的 `retainedTail` 只保留 `AgentMessage`，custom 条目在压缩点**之后**才安全
  ⇒ 中断状态若发生在压缩前，压缩后可能丢失。**这是已知缺口**，需在 L-B 批次处理
  （把 turn state 也写进 Nest 侧并在压缩时进 retention 段）。
