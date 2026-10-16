# 回合身份与单一写者 · Codex 源码对照审核

状态：评审记录（非规格）—— 审核对象为「提议生成卡片漂移」诊断结论 + 设计 §1/§2
日期：2026-10-17
审核视角：**架构师 + 产品经理**，判据取自 openai/codex 主干源码（逐文件拉取核对，非二手解读）

> 本文档**无配图**：全部结论可用表格与源码坐标表达，命中 `SPEC-CONVENTIONS.md` §1 反面判据（能用表格讲清的不要画图）。

---

## 0 审核结论（TL;DR）

**方向正确，但根因要再下移一层，且有两处方案弱于上游。**

| 结论 | 判定 |
|---|---|
| 「缺回合身份 ⇒ 一次 run 被记 N 本账」的主链 | ✅ 成立（生产实证坐实） |
| 但根因不止「缺 runId」：**全局单调序号也被丢弃了** | 🔴 修正（R1，且使 P0-4 当前不可实现） |
| 「只有 owner 落库 + DB 唯一索引兜底」 | ✅ 与 Codex 写锁同构，保留 |
| 「幂等键改内容 hash」 | 🔴 修正（R2，弱于上游因果围栏） |
| 「409 → steer 兜底」 | 🔴 修正（R3，正是 Codex 明令禁止的形态） |
| 「进程内 Map 注册表」 | 🟡 降级为 fast-path，不是所有权令牌（R4） |
| 「阻塞期走 /answers 出确认卡」 | ✅ 方向对，但缺一等状态语义（R6） |
| 「不自研事件总线」 | ✅ 复核维持（Codex 也没有 broker） |

---

## 1 审核方法

不采信任何转述。三件事同时做：

1. **拉上游源码原文**（`raw.githubusercontent.com/openai/codex/main`），只引用能 grep 到的符号；
2. **回生产库复验**（不靠代码推断）：`seq` 作用域、切片子序列关系；
3. **回我方源码定位丢弃点**（`pi-runtime` → `Nest` 两层归一化各丢什么）。

---

## 2 Codex 的五条相关机制（源码坐标）

| # | 机制 | 坐标 | 原文要点 |
|---|---|---|---|
| C1 | **事件自带回合身份** | `protocol/src/protocol.rs:1451-1456` | `Event{ id, msg }`，`id` 注释 = "Submission `id` that this event is correlated with" ⇒ 每个事件都带提交号 |
| C2 | **回合生命周期有一等事件** | `protocol.rs:2271-2307 / 4365-4371` | `TurnStartedEvent{turn_id, turn_attribution}`、`TurnCompleteEvent{turn_id, root_turn_id}`、`TurnAbortedEvent{turn_id, reason}` |
| C3 | **准入是原子的、拒绝是一等类型** | `core/src/session/turn_input.rs:515-531`；`:455-458` | 持 `active_turn` 锁：`is_some()` ⇒ `NotSubmitted{NotIdle}`；检查与占位 `get_or_insert_with` 必须原子（clippy 注解原文："the previous turn check and idle reservation must be atomic"） |
| C4 | **绝不把拒绝退化成新回合** | `turn_input.rs:373-451` | `start_or_steer`：先 `steer_input`；**只有** `Err(NoActiveTurn)` 才 spawn 新回合；其余 reason 一律原样返回 `NotSubmitted` |
| C5 | **写者所有权是跨进程锁 + 持久单调序号** | `rollout/src/writer_lock.rs:1-2,42-79`；`rollout/src/ordinal.rs:46-52,86-99` | `acquire()` 冲突返回 `WouldBlock` = "thread {id} already has an active writer"（文件锁，跨进程）；`RolloutLine{timestamp, ordinal, item}`，`advance()` 单调推进，恢复时 `next = 末条 ordinal + 1`，并校验子代理继承前缀连续 |

补充两条设计哲学：

- **因果围栏而非内容指纹**：`turn_input.rs:522-528` 用 `expected_previous_turn_id` 对比 `last_started_turn_id` ⇒ `Superseded`；`:799-851` `steer_input` 用 `expected_turn_id != active_turn_id` ⇒ `ExpectedTurnMismatch`（CAS）。**没有一处用"消息内容 hash"判定重复。**
- **调用方生命周期与回合解耦**：`codex_thread.rs:529` 原文 "The session processes an accepted request even if its caller disconnects."；`:533+` `suspend_turn_and_shutdown` 支持把回合所有权移交另一个 worker 并**恢复原 turn id**。

---

## 3 我方现状的对照发现

### R1 🔴 全局单调序号在落库时被丢弃 ⇒ 根因比「缺 runId」更深，且 P0-4 当前不可实现

| 层 | 事实 | 坐标 |
|---|---|---|
| pi-runtime | 会话级全局单调 `seq`：`{ ...event, seq: entry.nextSeq++ }` | `session-manager.ts:2624` |
| pi-runtime | `replay(afterSeq)` 过滤 `e.seq > afterSeq`；`isReplayComplete(afterSeq, droppedFromSeq)` | `:1888`、`:171-175` |
| Nest | 全局 seq **已透传**到 `UiEvent.seq` | `pi-events.ts:20,57,115` |
| Nest | 落库时**丢弃它**，改用本地计数 `traceSeq`（注释："数组下标即序，seq 冗余但抗裁剪"） | `agent.service.ts:1307-1317` |
| 生产实证 | 同一次 run 的两条切片 seq 均为本地计数：`a = 1..72`、`b = 1..55` | 生产库实测 |

**后果（三条，逐条都是硬伤）**：

1. 落库序号与 pi-runtime 的 `afterSeq` **不在同一编号空间** ⇒ 规格 P0-4「落库前按 afterSeq 重放补全」**在现有数据上无法实现**；
2. 跨流无法归并 ⇒ 无法用 SQL 判定"这两条是不是同一次 run"；
3. 前端 `replayTimelineEvents` 按 seq 排序，排序的是一个**局部计数** ⇒ 顺序看着单调、实则错误（这正是"卡片置顶"能伪装成合法顺序的原因）。

**修正**：新增 `gSeq` 字段存上游全局 seq（保留 `seq` 作本地序以兼容存量），排序取 `gSeq ?? seq`。
**关键利好**：全局 seq **已经在 `UiEvent.seq` 里了** ⇒ 这条**零 pi-runtime 依赖，PR1 就能做**。

### R2 🔴 幂等键用「内容 hash」弱于上游的「因果围栏」

内容 hash 无法区分两种情形：① 用户 5 分钟后**真的又发了一遍同样的话**（合法新回合）；② 同一条消息**重复投递**（应并入）。Codex 两处判定都用**因果围栏**（`expected_previous_turn_id` / `expected_turn_id`），从不看内容。

**修正**：主判据改为客户端带上一次看到的 `lastTurnId`，服务端判定 `NotSubmitted{Superseded}`；内容 hash **降为辅助**（同一 `lastTurnId` 下识别重复投递）。

### R3 🔴 409 → steer → 流不关 → 各自落库 = Codex 明令禁止的形态

Codex `start_or_steer` 只在 `NoActiveTurn` 时新开回合；`steer_input` 另有 `ActiveTurnNotSteerable` 一态（`:831-836`），即"当前回合此刻不可插话"是**可枚举状态**。我方的组合最坏：阻塞期 steer 消费不到（上游注释：连 checkpoint 边界都没有）⇒ 输入既没进当前回合，又开了一条会落库的流。

**修正（两条）**：

1. **steer 结果必须三态** `Steered / NotSteerable / NoActiveTurn`；`NotSteerable` **不得**新建流并落库，只能转 `/answers` 或回前端。
2. **拒绝要下发给前端结构化事件**：`turn_not_submitted{ reason }`（对位 Codex 的 `NotSubmittedReason` 可呈现枚举）。409 是传输层信号，语义太薄——UI 拿到 reason 才能分别渲染"已并入当前任务 / 当前不可插话 / 已过期请刷新"。

### R4 🟡 进程内 Map 注册表不是所有权令牌

Codex 的所有权是**跨进程文件锁**（`writer_lock`）。我方的 Nest 进程内 `Map<sessionKey, {runId, ownerStreamId}>` 在多副本/restart 即失效。

**修正**：定位写清楚——Map 是 **fast-path 快速拒绝**，正确性由 `(threadId, runId)` 唯一索引裁决（**这才是我们的 writer_lock 等价物：持久、跨进程**）。`generation-recovery` 的 `drainConversation` 必须纳入同一键（它是第二个进程内写者）。

### R5 🟡 「owner 断流提升 shadow」是补丁，非终态

Codex 的解法是**落库由回合本身驱动**（调用方断开不影响，`codex_thread.rs:529`）。我方是"HTTP 流 = 回合 = 写者"，所有权随连接漂移。

**修正**：保留提升机制（短期唯一可行），但在规格中标注为**过渡方案**，并加 `owner_lost` 指标；终态写进"已知差距"：落库由 run 驱动、与 HTTP 连接解耦。

### R6 🟡 阻塞期缺一等状态语义（产品失信，不只是 bug 源）

300s 无反馈本身就是失信。Codex 把"不可插话"做成可枚举状态并由 host 呈现。

**修正**：propose 等待态出**三态 UI**——`等待中（可取消/可改需求）` → `已并入当前提议` → `已取消（回空闲）`。`/answers` 的 `decision:"decline"` 已支持（`app.ts:320-328`，registry 三态 `answered/timeout/aborted` 齐备）⇒ **纯前端工作，不需要动 pi-runtime**。⚠️ `decline` 后必须回到可输入空闲态，否则制造第二次沉默。

### R7 ⚪ 落库事件应带回合身份（对位 C1/C2）

维持 PR2 的 `runId` 透传；与 R1 的 `gSeq` 属于同一层"标识补齐"，建议同批落库字段扩展。

### R8 ⚪ 观测补两个计数器

| 指标 | 对位 | 预期 |
|---|---|---|
| `turn_start_refused{reason}` | Codex `NotSubmittedReason` 枚举分布 | 非 0 属正常，但分布异常直接暴露哪类拒绝最多 |
| `persist_ordinal_gap` | `RolloutLine.ordinal` 连续性 | **恒为 0**，非 0 = 丢事件 |

### R9 ⚪ 历史修复的对齐键

因落库 `seq` 是本地序（R1），跨消息比对**不能用 seq**，须用 `(ts, type, 数据指纹)` 多重匹配。已有实证：b 在 a 中 54/55 命中 ⇒ 子序列判据可行。

---

## 4 对实施切分的修订（增量）

| PR | 原内容 | 本轮修订 |
|---|---|---|
| **PR1 止血** | owner/shadow + 注册表 + 幂等键 + 观测 | **+ 落库改存上游全局 `gSeq`（R1，零 runtime 依赖）**；+ 结构化拒绝事件 `turn_not_submitted{reason}`（R3）；+ `persist_ordinal_gap` / `turn_start_refused` 指标（R8） |
| **PR2 立身份** | runtime 透传 runId → 加列 + upsert + 重放补全 | 幂等主判据改 **因果围栏**（R2）；补全判据改为：`startSeq = run_start 事件的 gSeq`，`droppedFromSeq > startSeq` ⇒ 标 `partial` + `gapFrom`（**R1 修好后本条才可实现**） |
| **PR3 交互** | 确认卡 + 孤儿降级 + thread-state 填真值 | + 三态 UI 与 decline 后回空闲（R6）；+ 按 reason 渲染（R3） |
| **PR4 历史** | 扫描 + 软标记 + linkedOutputs 去重 | 对齐键改 `(ts, type, 指纹)`（R9） |

---

## 5 复核后仍维持的"不做"清单

- **不自研事件总线/broker**：Codex 亦无 broker，靠 session 单循环 + 写锁达成单一写者。维持。
- **不改 vendor 上游源码**：本次所有缺口都在适配层（归一化丢弃标识、落库写者语义），维持。
- **不靠前端去重**：维持（唯一性由 DB 索引裁决）。
- **不引入 fan-out 层**：`SessionRouter` attachment 模型留给真正的多端接管需求，维持。

---

## 6 待确认（影响 PR2 排期）

1. **R1 是否并进 PR1**：技术上可以（零 runtime 依赖），但会扩大 PR1 评审面——建议并入，因为它是 PR2 重放补全的前置。
2. **`schema.prisma` 加 `runId` 列 + 唯一索引的一次 additive 迁移**：AGENTS.md 红线，需你批准。
3. **pi-runtime 镜像需手工打 tag 发版**（`runtime-deploy.yml` 不自动跑）：PR2 的 runId 透传依赖它。
