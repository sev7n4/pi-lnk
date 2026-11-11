# 插话/尾随用户气泡实时化 + 「已接住」上下文验证 设计规格

> **For agentic workers:** REQUIRED SUB-SKILL: 本规格落地请用 superpowers:writing-plans 生成本地实施计划；执行按仓库纪律（apps/server/** + apps/web/** 改动触发生产发布，须独立规格 + 生产复测）。

**Goal:** 让 steering / follow-up 插话内容以用户气泡形式**跨端实时**出现在 SSE 对话流中，并以一条**权威消费事件**作为 SSOT 证明「内容确实进入了模型上下文并被接住」，根除「入队但从未被消费、历史却显示成已发送用户消息」的数据错误。

**Architecture:** 在 `persistQueuedUserMessage` 成功后广播领域事件 `user_utterance_queued`（驱动跨端实时气泡），在 vendor 边界把队列条目真正物化为 transcript `kind:entry` 并被下一轮 LLM 读入时广播 `user_utterance_consumed`（SSOT 翻转 `queued` 终态），并对「在 inbox 但无后续轮次」的滞留条目发 `user_utterance_stuck`。三者经一条 per-thread 事件总线扇出到该 thread 的所有 SSE 订阅者（含断线重连重放），客户端以 `entryId` 幂等插入/翻转。原有 `pi_message_end` 补建路径保留为发起端快速通道，与新事件经 `entryId` 去重共存。

**Tech Stack:** NestJS（SSE `text/event-stream`）、Vue 3（`AgentSideRail.vue` + `stores/agent.ts`）、pi-runtime（`session-manager.ts` 的 `dispatch` 事件总线）、PostgreSQL/SQLite（`AgentMessage.queued`）。改动面：`apps/server/**` + `apps/web/**`（触发生产发布）。

**Spec 关系：**
- 推翻 `docs/superpowers/specs/2026-10-21-steer-history-persist-design.md` §六「多端不刷新可见」范围外决定（本规格改为跨端实时）。
- 推翻 `services/pi-runtime/src/session-manager.ts:1768`「queue_update 刻意不派发进 SSE」的设计意图——但仅针对**新增的用户发言领域事件**（非内部队列记账 `queue_update`），理由见 §4.1。
- 与 `docs/superpowers/specs/2026-11-05-sse-conversation-view-unification-design.md` 的 SSE 视图统一目标一致，本规格补齐「用户侧插话气泡」这一此前留白的子集。

---

## 0. 配图索引

无配图（纯文本规格，避免触发 `verify-spec-figures` 配图校验）。

---

## 1. 问题背景

用户提出两点诉求，均来自真实使用观察：

1. **气泡缺失：** steering 插话内容、follow-up 尾随内容，没有以「用户气泡」的方式在 SSE 对话流中打印出来。「这也属于用户发送的内容」。
2. **可验证性：** 即便补出气泡，还需验证这些内容**是否真正进入了模型上下文并被接住**（而非只入队、永远停在 vendor inbox）。

当前行为（改动前，true master 取证）：
- 插话走 `POST /api/agent/runs/steer`（`agent.controller.ts:420` 附近）/ `runs/followup`（`:466` 附近）入队，返回 JSON `{queued, entryId}`，**不开流、不产生任何 SSE 帧**。
- 发起端靠本地 `pi_message_end` 事件在 `AgentSideRail.vue:2270` 经 `applyPiUserMessageEvent` 补建气泡；各端靠历史 GET（刷新）在 `stores/agent.ts:1024` 读时派生 `queued` 后渲染（`:3245` 徽标）。
- `AgentMessage.queued` 在 DB 中**恒为 true**（落库即 `queued:true`，`agent.service.ts:1689`），所谓「翻 false」只是 `getMessages` 读时派生（`agent.service.ts:717-735`）：只要同窗内有任何更晚的 assistant 行就当已消费。

---

## 2. 分析结论（既有取证，节选自 2026-11-11 生产只读取证）

### 2.1 为什么现在没有「跨端实时用户气泡」

三层机制叠加，非漏写：

- **SSE 从不承载用户发言。** `pi-events.ts` 的 `PiEventType`（`:44` 附近枚举）全是 agent 侧事件（`agent_start/end`、`turn_*`、`message_*`、`tool_*`…），无用户消息事件。连正常发送的用户气泡也不是 SSE 打的：`AgentSideRail.vue:1684/1697` 本地乐观插入，SSE 只回 assistant 增量。
- **steer/followUp 走 REST 入队，不是流。** `useAgentQueue.ts:138` → `POST /runs/steer`；服务端 `steerPiRun`（`agent.service.ts:1556`）把文字塞进 vendor lane inbox，同一请求内 `persistQueuedUserMessage`（`:1662`）落库 `AgentMessage(role=user, queued=true)`——**落库 ≠ 广播**。
- **pi-runtime 刻意把队列关在 SSE 之外。** `session-manager.ts:1768`：「刻意**不**派发进 SSE：队列是内部状态，暴露给前端只会让客户端再去画一层『待发队列』」。`queue_update` 只用于内部积压追踪。
- **气泡是「消费时补建」且用本地原文。** `queueBubbleSync.ts` 的 `decideQueueBubbleSync`（`:93`）仅在 entryId 命中本地 `queuedEntryIds`（`:108`）时 `insertUserMessageBeforeAssistant`，文本取本地冻结 `queuedText` 优先——因为发往 pi 的载荷被拼过 `QUEUE_MARK`/`[In=…]`/skill 前缀（`agent.service.ts:793` 附近），纯机器载荷还会被 `bubbleVisibility.ts` 判为不渲染。

### 2.2 生产实证（只读，66 条 `queued=1` 插话行）

| 结果 | 条数 | 证据 |
|---|---|---|
| 完整链路（pending → transcript `kind:entry` → `message_end{entryId}` → `triggerEntryId` → `parentId=该entry` 的 assistant entry） | **52** | 四态全部命中 |
| **只入队、从未进上下文** | **13** | `pending=2`，但 `entry=0 / msgEnd=0 / assistantChild=0` |
| 会话目录已清理，无法判定 | 1 | `NO_DIR` |

那 13 条**不是撤回**：最后一次 `pi.lane.state.inbox` 快照仍含该 `entryId`（12 条 `steer`、1 条 `followUp`），pending 值从未删除。真实样例 `01a1b192…`（「现在这两只乌龟之间有连线吗？」）入队后模型从未看到。抽样完整链路里，assistant thinking 明确写着「用户说『继续』，我应该继续推进」——「被接住」是可证实的。

**判据与变异自检**（评价前必须做，防伪锚点）：POS 取 4 条不同插话全链路命中；NEG 取随机 UUID 全 0；CTRL 取正常发送（`queued=0`）同样命中 `entry/msgEnd/assistantChild` ⇒ 非恒真、非恒假、非只对插话生效。踩过的伪锚点：全量 `"entryId":"X"` 子串会命中 `queue_update`（虚高到 65/66），必须收紧到 `message_end` 同行或 `"kind":"entry","id":"X"`。

### 2.3 为什么现在「已接住」验证不了

1. `AgentMessage.queued` 66/66 恒 true，从不写 false；true master 的读时派生（`:717-735`）只看「同窗内有没有更晚 assistant 行」就翻 false——与「这条 entry 是否被消费」**无关**。13 条滞留里 12 条所在 thread 后来有过别的回答 ⇒ 徽标照样消失，用户看不出丢消息。
2. `turn_ack{messageId}` 只在 **409 撞 busy 的隐式 steer 分支**（`:3623` 附近的 emit）条件性赋值；显式 `POST /runs/steer` 是独立请求，手动插话的实时清除基本不走。
3. `pi_message_end` **不落** `metadata.executionEvents`（生产 0/9746 命中）；`events.jsonl` 收紧后仅 32/66 有 message_end（疑有轮转）⇒ 重连/多端拿不到证据。
4. `queue_update` 被 `session-manager.ts:1768` 刻意不派发进 SSE ⇒ 没有权威的「已消费」事件。

### 2.4 根因小结

- **气泡缺失根因：** 插话被设计为「内部队列态」，入队即落库但不广播，SSE 契约里根本没有用户发言领域事件。
- **「未接住却显示已发送」根因：** `queued` 终态无权威信号，读时派生以「有后续回答」近似「被消费」，对「入队但滞留 inbox」失效（13/66）。

---

## 3. 目标与范围

**明确纳入：**
- 跨端实时用户气泡：所有订阅同一 thread SSE 的端（含旁听端）在插话入队后立即出现用户气泡（意图已推翻 §六 范围外决定）。
- 权威消费事件 + 终态：`user_utterance_consumed` 作为 `queued` 的 SSOT；`user_utterance_stuck` 暴露滞留。
- 可复跑的取证/验收脚本，固化 §2.2 的判据与变异自检。

**明确不纳入（防范围蔓延）：**
- 不改 vendor `boundary.ts` / `transcript.ts` / `checkpoint.ts` / `generation.ts` 的边界物化与上下文读取机制——只在它们**之上挂钩**（消费点发事件）。
- 不改 pi-runtime 的 SSE 基础传输与 `EVENT_MAP` 主体，只新增两类领域事件类型。
- 不做「待发队列」的可视化面板（`session-manager.ts:1768` 的原意仍成立，本规格只补「用户发言已提交/已接住」而非内部积压）。

---

## 4. 根治方案（设计）

### 4.1 新增领域事件（服务端，刻意进 SSE）

> 与 `session-manager.ts:1768` 的关系：该行禁止的是 `queue_update`（vendor 内部积压记账）进 SSE。本规格新增的是**用户发言领域事件**，语义是「用户对会话说了什么、模型是否接住」，属于 agent 对话流的既有表达范畴（与 `message_*` 同级），故应进 SSE。这是对 §六 与 :1768 的**有意推翻**，理由：用户的插话是「用户发送的内容」，应满足与正常用户输入同等的可见性与可验证性。

| 事件 | 触发点 | 载荷 | 语义 |
|---|---|---|---|
| `user_utterance_queued` | `persistQueuedUserMessage` 落库成功后（`agent.service.ts:1662` 内，覆盖 steer + followup 两条路径） | `{ threadId, entryId, role:'user', content, queued:true, ts }` | 用户发言已提交并落库，驱动跨端实时气泡 |
| `user_utterance_consumed` | vendor 边界把该 entry 物化为 transcript `kind:entry` 且被下一轮 `readBoundedContext` 读入（即 `message_end{entryId}` / `triggerEntryId` / `parentId` 链路成立） | `{ threadId, entryId, consumed:true, ts }` | 内容真进上下文并被接住——`queued` 翻 false 的 SSOT |
| `user_utterance_stuck` | 对账任务发现 entry 仍在 inbox（或 inbox 已不含但无 transcript `kind:entry`）且超过超时窗口无后续轮次 | `{ threadId, entryId, ts }` | 滞留终态，防「未接住却显示已发送」 |

`content` 取**前端入队时传回的原文**（`persistQueuedUserMessage` 已知 `entryId` 与原文），避免把拼过 `QUEUE_MARK`/`[In=…]` 的机器载荷当气泡文本（沿用 `queueBubbleSync.ts` 的「本地原文优先」原则）。

### 4.2 服务端 per-thread 事件总线（跨端实时关键）

**问题：** SSE 端点（`agent.controller.ts:606-718`）每条连接调用 `runEventStream`（`:698`）独立 yield，而 `turn_ack`（`:1374` push 进运行流）只到达**当前运行流所在连接**。POST `/runs/steer` 是另一条 HTTP 请求，无法自然注入到已建立的 SSE 连接。

**方案：** 引入 per-thread 事件总线（in-process `Map<threadId, EventEmitter>`，生产可换 Redis pub/sub）。`runEventStream` 订阅该总线；`user_utterance_*` 由 steer/followup 处理器与边界消费钩子 publish，扇出到该 thread 的**所有** SSE 订阅者，包括 steer 发起**之后**才连上的订阅者（借既有 `Last-Event-ID` / seq 重放窗口，`agent.controller.ts:615/706`）。

- 防内存泄漏：idle thread 的总线在 TTL / 无订阅者后清理（`session-manager.ts` 已有类似 `lastActivityAt` 兜底思路，可复用）。
- 向后兼容：未知事件类型被旧客户端忽略（既有 `mapPiEventToUiEvent` 的 passthrough 默认分支不识别即丢弃）。

### 4.3 `queued` 标志的 SSOT 翻转

- **删除** `agent.service.ts:717-735` 的读时派生（「有更晚 assistant 行即翻 false」）。
- `queued` 改为**权威状态**：
  - 落库即 `true`（`:1689` 不变）；
  - 仅在收到/重放 `user_utterance_consumed` 时翻 `false`（终态「已接住」）；
  - 对账判定 `user_utterance_stuck` 时标记终态「滞留」（此态下徽标显示「未接住/未送达」，绝不再因「有后续回答」而误显已发送）。
- 持久化消费信号：`user_utterance_consumed` 发出时把 `consumedAt` 写入 `AgentMessage`（因 `pi_message_end` 不落 `executionEvents`，不能依赖事件重放），重连/历史以 `persisted.queued` + `consumedAt` 为权威源（`stores/agent.ts:1024` 改为透传权威值，删 `:1041-1043` 的读时清除）。

### 4.4 客户端渲染与事件处理

`AgentSideRail.vue` 的 SSE 事件 switch（`:2270` 附近）新增分支：

- `user_utterance_queued` → 若 `messages` 中无该 `entryId`（`decideQueueBubbleSync` 的 `messages.some(m => m.entryId === entryId)` 幂等，`:104`），插入用户气泡 `queued:true`；用 `stores/agent.ts:308 insertUserMessageBeforeAssistant` 挂 `entryId`。
- `user_utterance_consumed` → 按 `entryId` 找到该消息，设 `queued:false`（终态「已接住」）。
- `user_utterance_stuck` → 按 `entryId` 标记终态滞留（徽标改显「未接住」）。
- **与既有 `pi_message_end` 补建路径共存不双插：** 两条路径都经 `entryId` 幂等判定，先到者建、后到者 skip（`queueBubbleSync.ts:104` 已天然防重）。
- `stores/agent.ts`：`queued` 改为权威透传（删读时派生），实时清除走 `user_utterance_consumed`/`stuck` 事件，不再靠「有更晚 assistant 行」。

### 4.5 「是否进了上下文被接住」的验证方案

`user_utterance_consumed` 本身就是证明：它**只**在 transcript `kind:entry` 落定 + 下一轮 `readBoundedContext` 将其纳入 `messages` 之后才发（`boundary.ts:115-142` 物化 entry、`checkpoint.ts:114-122` 续生成、`generation.ts:101` 读上下文）。因此「事件已发」⇔「已进上下文并被接住」。

验收脚本（把 §2.2 的 throwaway 脚本固化为仓库可复跑版本 `scripts/verify-queue-context.ts`）须满足：
- **POS：** 已知到达 transcript 的 entry → 现也可在权威源（`AgentMessage.consumedAt` 或事件日志）查到 `user_utterance_consumed`。
- **NEG：** 随机 UUID → 0 条 consumed 事件（证明非恒真）。
- **变异自检：** 向 consumed 事件发射路径注入假 `entryId` → 断言 NEG 样本仍 0（证明非恒真）；从 transcript 抠掉某真实 entry → 断言 consumed 事件缺失（证明非恒假）。
- **历史存量对账：** 重跑对 66 条插话的取证，13 条滞留须被标 `stuck` 而非 `delivered`；此后新 steer 须 0 stuck（或显式解释）。

---

## 5. 数据模型 / 持久化

- `AgentMessage.queued`：`boolean`（向后兼容 UI 徽标）。
- 新增 `AgentMessage.consumedAt: DateTime | null`：消费事件发出时写入，作为「已接住」权威终态。
- 滞留终态表达：`queued=true && consumedAt=null && reconciled=true`（对账已判定 stuck）→ 徽标显「未接住」。或新增枚举列 `queueStatus: 'queued'|'consumed'|'stuck'`（实施计划定夺，二者等效）。
- `user_utterance_*` 事件除经 SSE 实时扇出，其消费/滞留结论须落 `AgentMessage`（因事件流不保证重连可达），重连与历史以 DB 为权威。

---

## 6. 测试策略

- **Unit（`apps/server`）：** `persistQueuedUserMessage` 成功后 publish `user_utterance_queued`；边界消费钩子触发 `user_utterance_consumed`；对账判定 `user_utterance_stuck`；`queued` 翻 false 仅由 consumed 驱动（不再被「有更晚 assistant 行」影响）。
- **Unit（`apps/web`）：** `decideQueueBubbleSync` 对 `user_utterance_queued` 幂等插入；`user_utterance_consumed` 按 entryId 翻转；与 `pi_message_end` 路径不双插。
- **Integration：** 模拟 steer → SSE 帧广播 → 旁听端订阅者插入气泡（断言 entryId 一致、≤ 阈值延迟）；模拟边界消费 → consumed 事件 → `queued` 翻 false。
- **Forensic/变异：** `scripts/verify-queue-context.ts`（POS / NEG / 变异三组），作为 PR 的验收 gate 之一。
- **生产复测：** 因 `apps/server/**` + `apps/web/**` 改动，按仓库纪律须独立 `deploy.yml` 发布 + 生产复测，复测判据为 §7 验收标准 + 本规格 §4.5 取证脚本在生产的重跑结果（不以 chunk hash 为锚点，见内存纪律）。

---

## 7. 验收标准（可证伪）

- **AC1（跨端实时气泡）：** 发起端 + 旁听端在 steer/followup 后、模型开始回答前，均出现带 `entryId` 的用户气泡；延迟在合理阈值内（目标 ≤ 1s，具体由实施计划定）。
- **AC2（终态正确）：** 历史 13/66 滞留条目重跑取证后标 `stuck` 而非 `delivered`；此后新 steer 0 stuck（或显式解释每条滞留）。
- **AC3（consumed 非恒真/非恒假）：** `scripts/verify-queue-context.ts` 的 POS/NEG/变异三组全绿。
- **AC4（重连不双插）：** 断线重连（`Last-Event-ID`）后同 `entryId` 不重复插气泡（幂等判定命中即 skip）。
- **AC5（与 pi_message_end 共存）：** 既有补建路径与新事件经 `entryId` 去重，不发双气泡。
- **AC6（向后兼容）：** 旧客户端忽略 `user_utterance_*` 新类型，不报异常、不影响既有 `message_*` 渲染。
- **AC7（生产复测）：** 独立发布后生产取证脚本重跑通过，且 `queued` 徽标在真实多端场景下终态正确。

---

## 8. 风险与回归

- **推翻既有设计决定：** `2026-10-21-steer-history-persist-design.md` §六（多端不刷新可见）与 `session-manager.ts:1768`（queue_update 不进 SSE）被本规格有意推翻，已在 §4.1 给出理由；需在原文档标注 superseded。
- **SSE 契约变更：** 新增事件类型影响所有订阅者，靠 AC6 向后兼容兜底；需回归既有 `mapPiEventToUiEvent` passthrough。
- **总线内存：** per-thread `EventEmitter` 需 TTL/无订阅清理，复用 `session-manager.ts` 的 `lastActivityAt` 兜底思路，防泄漏。
- **生产发布：** 改动命中 `apps/server/**` + `apps/web/**` ⇒ 触发 `deploy.yml` 生产发布，须独立规格-gated 发布 + 生产复测（仓库纪律）。
- **不回归既有保护项：** `docs/design/Agent Composer UI-UX 整改规格.md` 的四态 queued bubble 为反需求，本规格的 `user_utterance_queued` 气泡与既有四态槽位并存（气泡进 `messages` 数组、槽位仍为 composer 上方四态 UI），不冲突。

---

## 9. 实施计划衔接

本规格由 superpowers:writing-plans 生成逐任务实施计划（TDD、频繁提交、每任务独立可测）。建议任务切分：

1. 数据层：`AgentMessage.consumedAt`（+ 可选 `queueStatus` 枚举）+ 迁移。
2. 服务端事件：`user_utterance_*` 三事件定义 + `persistQueuedUserMessage` 发 `queued` + 边界消费钩子发 `consumed` + 对账发 `stuck`。
3. 服务端总线：per-thread 事件总线 + `runEventStream` 订阅扇出 + TTL 清理。
4. `queued` SSOT：删读时派生、改权威翻转、持久化 `consumedAt`。
5. 客户端：SSE 分支处理三事件 + `decideQueueBubbleSync` 扩展 + `stores/agent.ts` 改权威透传。
6. 取证脚本：`scripts/verify-queue-context.ts`（POS/NEG/变异）作为验收 gate。
7. 生产复测：独立发布 + 生产取证重跑 + AC1–AC7 核对。

---

## 附：取证方法与边界（诚实声明）

- 取证方式：只读 `docker cp` 生产 SQLite（无 WAL，副本一致）+ pi-runtime pod 的 `/data/sessions/**/*.jsonl`；生产机 `free` 仅 ~135MB、swap 3GB 用尽，pod 内 node 全量解析两次被 OOM kill（exit 137），改用 grep 轻量扫描（全量 ~10s / 逐条 ~17s）跑通。
- throwaway 脚本留在 `/tmp/verify-queue-context*.{js,sh}`，**未落仓库、未改任何产品代码、零发布**；本规格 §6 将其固化入仓。
- 13 条滞留的「inbox 仍含 entryId」证据来自最后一次 `pi.lane.state.inbox` 快照；若生产会话目录被清理（1 条 `NO_DIR`），该条无法判定，不计入缺失/成功任一侧。

---

## 11. PM/架构师自审裁定（2026-11-11）

自审结论：**通过**。目标与验收标准（§7 AC1–AC7）不变，实现手段收敛 6 条（详见实施计划 `docs/superpowers/plans/2026-11-11-queue-user-bubble-context-verify.md`）：

1. **不新建总线**：复用既有 `SessionEventBus`（`apps/server/src/points/session-event-bus.service.ts`）新增 userUtterance 通道，扇出点 `runEventStream` ⇒ **`services/pi-runtime/**` 零改动**；§4.1 对 `session-manager.ts:1768` 的「推翻」不再需要（`queue_update` 仍不进 SSE，新事件是 Nest 侧领域事件走 Nest 总线，不经 lane buffer）。合成帧无 seq ⇒ 不写 `id:` 行；晚加入者靠 DB 权威源（历史 GET）而非事件重放。
2. **consumed 口径**：服务端观察 `pi_message_end{role=user, entryId}` 且 DB 命中 `queued=true` 行即判 consumed（entry 已物化 ⇒ 必被下一轮 `readBoundedContext` 读入）；主流 + 旁听 `runEventStream` 双挂钩，后者覆盖 followUp 收尾边界消费（主流在 `agent_end` 早收尾）。
3. **读时派生不删**：降级为 `consumedAt==NULL` 时的 legacy fallback（直接删除会让存量 52 条已消费行回显「排队中」）；deploy 后由取证脚本 `--reconcile` 回填存量，此后新行走权威终态。
4. **stuck 由对账脚本声明**（运行时启发式会把「下一轮边界将被消费」误判）。
5. **queued 事件只从显式 steer/followup 端点发**（409 隐式插话的气泡已由正常路径渲染，避免双气泡；其 consumed 翻转照常）。
6. **载荷**：`{threadId, entryId, kind, content?, ts}`，queued 的 content 取落库原文。
