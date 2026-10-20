# 回合连续性实施计划

> 2026-10-21 · 对应 spec：[`../specs/2026-10-21-turn-continuity-design.md`](../specs/2026-10-21-turn-continuity-design.md)
>
> ⚠️ 本计划分**三批**。第一批已实施并开 PR（#525）；第二、三批是「不治本」的部分，
> 排期由产品决定，**不要**在第一批未上线前就动第二批（会引入两个同时生效的恢复路径）。

---

## 批次 1：恢复层（已实施，PR #525）

**目标**：中断轮的任务状态跨故障存活，下一轮模型能接上。

**为什么这是最小且正的解**：
- 不改「上下文唯一真相源 = pi transcript」这个既有架构决策（那是对的）；
- 只补上「中断时把任务状态写进 transcript」这一环；
- 吃满上游 `appendCustomEntry` + `entryProjectors`，**不 fork vendor**。

### 已完成的 task

| # | Task | 文件 | 状态 |
|---|---|---|---|
| 1 | 回合状态模型 + 渲染 + 投影（纯函数） | `services/pi-runtime/src/turn-state.ts` | ✅ |
| 2 | 上游链路验证（真实 vendor `buildSessionContext`） | `services/pi-runtime/src/turn-state.upstream.test.ts` | ✅ |
| 3 | 端到端（复现事故形态并证明修复） | `services/pi-runtime/src/turn-state.e2e.test.ts` | ✅ |
| 4 | pi-runtime 接入 `entryProjectors` + `recordTurnState` | `services/pi-runtime/src/session-manager.ts` | ✅ |
| 5 | HTTP 端点 `POST /sessions/:id/turn-state` | `services/pi-runtime/src/app.ts` | ✅ |
| 6 | Nest 侧步骤推导 + 记录判据（纯函数） | `apps/server/src/agent/turn-continuity.ts` | ✅ |
| 7 | Nest 侧接线（中断检测 + 记录） | `apps/server/src/agent/agent.service.ts` | ✅ |
| 8 | Nest client 方法 | `apps/server/src/agent/pi-runtime/pi-runtime.client.ts` | ✅ |
| 9 | 先导指标 | `services/pi-runtime/src/metrics.ts` | ✅ |
| 10 | spec + 文档登记 | `docs/superpowers/specs/…`、`docs/README.md` | ✅ |

### 验收判据

- [x] 端到端测试用**真实** vendor 代码复现事故形态并证明修复
- [x] 变异测试 4 处全红（证明断言能证伪）
- [x] 回归：pi-runtime `session-manager` 68/68；Nest `agent.service` 117/117
- [x] `tsc --noEmit` 三个包全 EXIT 0（`apps/server` / `services/pi-runtime` / `packages/agent`）
- [ ] **生产验证**：上线后观测 `pi_runtime_turn_state_records_total{outcome="ok"}` 递增
- [ ] **生产验证**：复现一次中断（临时断上游），确认下一轮 agent 说得出「上一轮要做什么」

---

## 批次 2：事实层 —— 双写对账（未实施）

**目标**：**发现**分叉，而不是等用户投诉。

### 现状（已取证）

- Nest 侧 `AgentMessage` 表：完整（含故障轮的 user 消息）
- pi 侧 transcript：可能缺整轮
- ⚠️ **无任何校验** ⇒ 分叉静默

### 已有基础设施（不需要新造）

`pi-runtime` 的 `GET /sessions/:id/snapshot` 已返回 `transcriptTail`（最近 16 条，含
`seq` / `role` / `stopReason` / `text`，见 `session-manager.ts:205-215`）
⇒ 对账所需的信息**已经在手**。

### 设计

1. **Nest 侧记录「本轮 user 消息的指纹」**：`AgentMessage` 落库时算 `sha256(userText)`，
   存进 `metadata`（不改表结构）。
2. **每轮开始前对账**：调 `snapshot(sessionKey)`，取 `transcriptTail`，
   检查**最近一条 user 消息**的指纹是否与 Nest 侧一致。
3. **不一致 ⇒ 告警 + 自愈**：
   - 告警：新增 Nest 侧指标 `agent_history_divergence_total{kind="missing_user|missing_turn"}`；
   - 自愈：把缺失轮的用户消息**补写**成一条 `lnkpi.turn_state`（复用批次 1 的通道）
     ⇒ 模型下一轮仍能接上。

### 判据（为什么这么判）

- 只比**最近一条 user 消息**：全量比对成本高、且旧轮次分叉不影响当前续跑；
- 用**指纹**而非原文：transcript 尾部的 `text` 是截断的（`SNAPSHOT_TEXT_LIMIT=400`），
  比指纹比比对全文稳。

### 风险

- `snapshot` 是**内存态**的（`this.sessions`），进程重启后 `no_session` ⇒ 对账跳过，
  此时依赖批次 1 已写入的 `turn_state`；
- 对账本身**不能抛错**（它是观测 + 自愈，不是主链路）。

---

## 批次 3：产品层 —— 未完成态可见 + 自动续跑（未实施）

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
  让模型基于 `turn_state` 重新决策，不复用上游 operation 断点。
- ⛔ **把上游 `pi.op.state` 断点接进主链路**：那是恢复「工具级副作用」的机制，
  与本问题（对话层失忆）是两件事，混在一起会让「重放副作用」的幂等性风险扩散到对话主链路。

---

## 风险与回滚

| 批次 | 风险 | 回滚 |
|---|---|---|
| 1 | transcript 多一条 custom entry（无害）；投影消息进上下文（多几十 token） | 移除 `entryProjectors` 注册即失效（`turn-state.ts` 的 projector 是唯一入口） |
| 2 | 对账误报导致重复补写 | 对账自愈走同一条 `turn_state` 通道，重复写入幂等（投影出两条相同说明，模型无感）；必要时先关自愈只留告警 |
| 3 | 自动续跑造成「用户没要求却自己动」 | 复用 `decider` 的 `userOnline` + 每时限流；灰度开关（现有 flag 机制） |

## 观测

| 指标 | 位置 | 判据 |
|---|---|---|
| `pi_runtime_turn_state_records_total{outcome}` | pi-runtime | `ok` 占比应随故障发生率上升；`failed`/`no_session` 升高 ⇒ 恢复链有洞 |
| `agent_history_divergence_total{kind}` | Nest（批次 2） | > 0 ⇒ 双写分叉真实发生（批次 1 之前这个数不可观测） |
