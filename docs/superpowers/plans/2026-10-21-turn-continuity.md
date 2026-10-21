# 回合连续性实施计划

> 2026-10-21 · 对应 spec：[`../specs/2026-10-21-turn-continuity-design.md`](../specs/2026-10-21-turn-continuity-design.md)
>
> ⚠️ **本计划已按 2026-10-21 的架构修正重写。**
> 初版（批次 1 = PR #525）把状态存在 pi 侧 transcript 的自定义条目里，
> 自我审查发现三处不成立（详见 spec §5 的修正说明）：
> 1. **压缩必丢**（`buildContextEntries` 丢弃 compaction 之前的 custom entry）；
> 2. **第三条真相线**（Nest 已决定不让 `AgentMessage` 进 prompt，再加一份 pi 侧状态 = 多一处分叉面）；
> 3. **绕过了宿主既有通道**（跨压缩保留早就有 `RetentionState`）。
>
> ⇒ 修正后：**权威在 Nest DB**，跨压缩走既有保留段通道，pi 侧只改**一处**
> （给动态块加 `turnstate` 预算档位——实施期发现的缺陷，见下）。
> **修正的净收益**：pi 侧从「一整套 custom entry 机制 + 端点 + projector + 指标」
> 缩到「一个预算档位分类」，上线链路从「两条流水线 + 顺序约束」变成「一条」。

---

## 批次 1：恢复层（修正后实施）

**目标**：中断轮的任务状态跨故障存活，下一轮模型能接上。

**为什么这是最小且正的解**：
- 不改「上下文唯一真相源 = pi transcript」这个既有架构决策（那是对的）；
- 只补上「**第四份状态**」——「上一轮任务进行到哪」不属于任何现有载体；
- 状态在 Nest（模型能算「这一轮要什么」的地方），只**一条**真相线。

### task 清单

| # | Task | 文件 | 状态 |
|---|---|---|---|
| 1 | 共享类型 + 纯函数（构造 / 渲染 / 指导语 / 保留段摘要 / 容错解析） | `packages/shared/src/turnState.ts` | ✅ |
| 2 | 导出 | `packages/shared/src/index.ts` | ✅ |
| 3 | DB 字段（线程级） | `apps/server/prisma/schema.prisma`（`AgentThread.turnState`） | ✅ |
| 4 | 迁移（手写，纯 additive） | `apps/server/prisma/migrations/20261021110000_add_thread_turn_state/` | ✅ |
| 5 | 步骤推导 + 记录判据 + 中断分档（纯函数） | `apps/server/src/agent/turn-state-store.ts` | ✅ |
| 6 | 权威存储服务（写 / 读 / 清 / 渲染块 / 渲染保留段） | `apps/server/src/agent/turn-state.service.ts` | ✅ |
| 7 | Nest 侧接线（中断检测 → 记录；成功收尾 → 清除） | `apps/server/src/agent/agent.service.ts` | ✅ |
| 8 | 动态块注入（每轮重算 ⇒ 跨压缩存活） | 同上（`assembleDynamic` 之后 push） | ✅ |
| 9 | 保留段注入（走**既有** `RetentionState` 通道） | 同上（`collectRetentionState`） | ✅ |
| 10 | DI 注册 | `apps/server/src/agent/agent.module.ts` | ✅ |
| 11 | 撤销 pi 侧实现（`turn-state.ts` / 端点 / `entryProjectors` / 指标） | `services/pi-runtime/**` | ✅ |
| 11b | ⭐ pi 侧**唯一**的新增：动态块加 `turnstate` 预算档位 | `services/pi-runtime/src/dynamic-budget.ts` | ✅ |
| 12 | 清理 client 里的废弃方法 | `apps/server/src/agent/pi-runtime/pi-runtime.client.ts` | ✅ |
| 13 | 纯函数测试 | `apps/server/src/agent/turn-state-store.test.ts` | ✅ |
| 14 | IO 编排测试（假 prisma） | `apps/server/src/agent/turn-state.service.test.ts` | ✅ |
| 15 | spec 纠错（§5 / §6 / §7） | `docs/superpowers/specs/2026-10-21-turn-continuity-design.md` | ✅ |
| 16 | 本计划重写 | 本文件 | ✅ |

### 验收判据

- [x] 状态落在 **Nest DB**（`AgentThread.turnState`），断言在 `turn-state.service.test.ts`
- [x] 每轮**重算**注入动态块 ⇒ 跨压缩存活（与 `todo` 块同机制）
- [x] 压缩保留段走**既有** `RetentionState` 通道（不新开）
- [x] 坏数据不注入（`parseTurnState` → undefined → 不产出空块）
- [x] 指导语不引导模型「靠画布反推意图」（断言落在指导指令上）
- [x] **pi 侧零改动** ⇒ 不需要 `runtime-deploy.yml`
- [ ] `tsc --noEmit` 三包全绿（`packages/shared` / `apps/server` / `services/pi-runtime`）
- [ ] 回归：server agent 相关测试全绿
- [ ] 生产验证：复现一次中断，确认下一轮 agent 说得出「上一轮要做什么」

### 关键设计决策（写下来以免后续重复讨论）

| 决策 | 理由 |
|---|---|
| 状态挂 **AgentThread** 而非 Session | 一个画布多个对话线程，进度是线程级的 |
| 状态用 **JSON 字符串**单列而非多列 | 加字段不必再迁移；读出后 `parseTurnState` 校验，坏数据回落 undefined |
| 清除时机 = **成功收尾后** | 立刻清的话，若该轮又失败状态就没了 ⇒ 再说「继续」又失忆 |
| 动态块 + 保留段**两个通道** | 动态块保证「下一轮可见」；保留段保证「压缩摘要里也带着」（`retainedTail` 只留 `AgentMessage`） |
| **不写** pi 侧 transcript | 压缩必丢 + 第三条真相线 + 绕过既有通道（三条都不成立） |
| pi 侧只改**预算档位** | 状态块落 `general` 档（份额 0 ⇒ 80 字保底）⇒「用户请求」被截掉 ⇒ 方案失效。`todo` 档是同构先例 |
| **不做**关键词识别「继续」 | 要猜意图，「接着改那个组件」即失效（Codex/Claude Code/WorkBuddy 三方共识） |
| **不做** `lane.resume()` | 走 `drive` = 真实 resume 上游 LLM（`cmv3zzid` 事故阻塞 612 s） |

---

## 批次 2：事实层 —— 双写对账

**目标**：**发现**分叉，而不是等用户投诉。

### 现状（已取证）

- Nest 侧 `AgentMessage` 表：完整（含故障轮的 user 消息）
- pi 侧 transcript：可能缺整轮
- ⚠️ **无任何校验** ⇒ 分叉静默

### 已有基础设施（不新造）

pi-runtime 的 `GET /sessions/:id/snapshot` 已返回 `transcriptTail`（最近 16 条，含
`seq` / `role` / `stopReason` / `text`，见 `session-manager.ts:205-215`）
⇒ 对账所需的信息**已经在手**。

### 设计

1. **Nest 侧记录「本轮 user 消息的指纹」**：`AgentMessage` 落库时算 `sha256(userText)`，
   存进 `metadata`（不改表结构）。
2. **每轮开始前对账**：调 `snapshot(sessionKey)`，取 `transcriptTail`，
   检查**最近一条 user 消息**的指纹是否与 Nest 侧一致。
3. **不一致 ⇒ 告警 + 自愈**：
   - 告警：新增 Nest 侧指标 `agent_history_divergence_total{kind="missing_user|missing_turn"}`；
   - 自愈：把缺失轮的用户消息**补写**成 `turnState`（复用批次 1 的通道）
     ⇒ 模型下一轮仍能接上。

### ⭐ 对账范围必须包含 `turn_state`（修正项）

`turn_state` 现在是**第三条需要校验的状态线**（Nest 权威 ⇒ 每轮投影给模型）：

| 状态线 | 权威 | 投影到 | 分叉后果 |
|---|---|---|---|
| 对话历史 | Nest `AgentMessage` | pi transcript（喂模型） | 模型看不到那条 user 消息（2026-10-21 事故） |
| 画布状态 | Nest `Session.canvasData` | 动态块 | 模型看到的节点与画布不一致 |
| **回合状态** | Nest `AgentThread.turnState` | 动态块 + 保留段 | 模型不知道「上一轮要什么」 |

⇒ 批次 2 的对账**不能只查对话历史**：`turn_state` 若被误清/被并发覆盖，
模型会突然退回「读画布猜意图」——**与本次事故同形的静默降级**。

### 判据（为什么这么判）

- 只比**最近一条 user 消息**：全量比对成本高、且旧轮次分叉不影响当前续跑；
- 用**指纹**而非原文：transcript 尾部的 `text` 是截断的（`SNAPSHOT_TEXT_LIMIT=400`），
  比指纹比比对全文稳；
- `turn_state` 用 `userMessageId` 锚点：批次 1 已在 `TurnState` 里留了这个字段，
  ⇒ 可精确定位「是哪一条」，比「最后一条」强得多。

### 风险

- `snapshot` 是**内存态**的（`this.sessions`），进程重启后 `no_session` ⇒ 对账跳过，
  此时依赖批次 1 已写入的 `turnState`；
- 对账本身**不能抛错**（它是观测 + 自愈，不是主链路）。

---

## 批次 3：产品层 —— 未完成态可见 + 自动续跑

**目标**：从「用户说『继续』agent 接上」升级到「**用户不用说『继续』**」。

### 3.1 前端可见的「未完成」

把「这一轮中断了，还剩什么」做成**画布上的一等公民**：

- 节点 `status` 新增 `incomplete` + `interruption` 字段；
- 画布上给中断节点一个可见标记（不是只在聊天流里）；
- 用户能直接看到「上次卡在出图这一步」。

**为什么在画布上而不是只在聊天流**：canvas agent 的产物是画布上的图元，
「做了一半」是**画布的常态**（用户手动改一半再让 agent 继续），
把它做成画布对象才符合场景（对齐 WorkBuddy「半成品节点打 `status: incomplete`」的做法）。

### 3.2 失败时自动续跑（WorkBuddy 模式）

WorkBuddy 在失败时**不等用户**，自动向模型注入：
*"Output interrupted. Resume directly — no apology, no recap. Pick up mid-thought if that is where the cut happened."*
并原地重试当前轮（带预算）。

**移植到 pi-lnk 的形态**（不是照抄文案）：
- 复用本仓已有的 `generation-recovery` 派发器形态
  （`apps/server/src/agent/generation-recovery/recovery-dispatch.decider.ts`：
  `hasActiveRun` / `userOnline` / 幂等键 / 每小时限流 / 同因连败降级）
  ⇒ **不要新造一套限流/幂等**，把「对话轮次」也纳进同一个派发决策器；
- 失败后**同轮自动重试一次**（不是无限重试），预算用 `decider` 现有口径。

### ⚠️ 明确不做

- ⛔ **关键词识别「继续」**：要猜用户意图，「接着改那个组件」即失效。
- ⛔ **自动 resume 上游 LLM**（`lane.resume`）：本仓 `cmv3zzid` 事故已证会阻塞 612 s
  （`session-manager.ts:1351-1369`）。自动续跑只走「**新开一轮**」，
  让模型基于 `turnState` 重新决策，不复用上游 operation 断点。
- ⛔ **把上游 `pi.op.state` 断点接进主链路**：那是恢复「工具级副作用」的机制，
  与本问题（对话层失忆）是两件事，混在一起会让「重放副作用」的幂等性风险扩散到对话主链路。

---

## 风险与回滚

| 批次 | 风险 | 回滚 |
|---|---|---|
| 1 | 状态误清 ⇒ 模型看不到上一轮 | `turnState` 是独立列 ⇒ 回滚只需停用注入（feature flag 或摘掉 module 注册） |
| 1 | 动态块挤占 token 预算 | 动态块有独立预算档位（`classifyBlock` 按前缀分类）⇒ 超限时按档位截断，不会无界膨胀 |
| 2 | 对账误报导致重复补写 | 自愈走同一条 `turnState` 通道，重复写入幂等（覆盖写）；必要时先关自愈只留告警 |
| 3 | 自动续跑造成「用户没要求却自己动」 | 复用 `decider` 的 `userOnline` + 每时限流；灰度开关 |

## 观测

| 指标 | 位置 | 判据 |
|---|---|---|
| `turn_state_recorded` 日志 | Nest（`agent.service.ts`） | 记录失败率上升 ⇒ 状态没落上（DB 故障或 threadId 不对） |
| `agent_history_divergence_total{kind}` | Nest（批次 2） | > 0 ⇒ 双写分叉真实发生（批次 1 之前这个数不可观测） |
| `turn_state_read` 命中率 | Nest（批次 2 可加） | 命中率骤降 ⇒ 状态被误清（批次 1 的主要风险） |
