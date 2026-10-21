# 多端同会话一致性 · 取证报告（附录）

> 日期：2026-10-21 · 样本会话：`cmvgfa46b000npi01znkg9dos`（画布 `layout-smoke-1792484987`）
> 方法：代码取证 + 生产双真相源比对 + 上游 vendor pi 源码研读 + 生态对标（Codex / Claude Code / IM 类）
> **定位：本文是** [`2026-10-21-multi-device-consistency-design.md`](./2026-10-21-multi-device-consistency-design.md)
> **的取证附录** —— 保留全部原始数据与取证过程，供评审核对与实施期复查。
> 实施依据以设计规格为准，本文的方案章节（§4–§5）与规格若有出入，**以规格为准**。
> 实施计划：[`../plans/2026-10-21-multi-device-consistency.md`](../plans/2026-10-21-multi-device-consistency.md)

---

## 0. 结论摘要

| 问题 | 结论 | 是否合理 |
|---|---|---|
| ① SSE 对话记录是否实时同步 | **不同步，且架构上做不到**。增量是「一次性响应体流」，只有发起方拿得到；另一端是纯快照 | ❌ **不合理**（但不是 bug，是设计缺口） |
| ① 刷新后会同步 | 刷新走「整体替换」历史接口，对齐到 **Nest 展示投影**——而这个投影**本身就是残缺的** | ⚠️ **部分合理，但掩盖了更严重的数据丢失** |
| ② 是否允许两边同时发起 | **技术上允许、后端已有优雅降级**（409 → `steer` 队列 + `shadow` 流），但**语义对用户不可见**，且有一类数据永久丢失 | ⚠️ **机制在，体验缺失** |

**取证过程中发现的、比用户报告更严重的问题**（这是本次分析最重要的产出）：

> 生产库该会话 **4 个 run、pi 侧 66 条 entry**，Nest 展示表只有 **7 行**，且**第一个 run（跑了 618 秒、成功结束）的助手消息完全不存在**。
> 根因候选：Nest 侧 SSE 走 nginx，`proxy_read_timeout 300s`，而 run 耗时 618.6s > 300s ⇒ **连接被 nginx 掐断 ⇒ async generator 提前终止 ⇒ `finalizeTurn` 永不可达 ⇒ 整轮不落库**。
> 全库统计：**209 个 thread 中 29 个存在 user 消息多于 assistant 消息**（13.9%）——这不是个案。

---

## 1. 取证：用户看到的差异到底是什么

### 1.1 生产现场（`cmvgfa46b000npi01znkg9dos`）

**Nest 展示表**（`AgentMessage`，生产 SQLite 直查）：

| # | role | 内容 | runId |
|---|---|---|---|
| 0 | user | 生成一只老山羊 风格你给我推荐 | NULL |
| 1 | user | watercolor | NULL |
| 2 | assistant | 用户中止了本次生成… | `01a159b6-0ab6…` |
| 3 | user | 帮我生成一只章鱼用锚勾勒出一副画的传播视频… | NULL |
| 4 | assistant | 生成失败，70积分已退回… | `01a15c46-14c5…` |
| 5 | user | 需要先生成章鱼 | NULL |
| 6 | assistant | 明白，先出章鱼的静帧图…（含 10 个空行） | `01a15c47-31f1…` |

**pi 侧 transcript**（`/data/sessions/cmvgfa46b000npi01znkg9dos_mvgmyu35-typx1ij8n-…/2026-10-20T12-55-30-493Z_01a15961-….jsonl`，2774 行，解析出 **66 条 entry**）：

- role 分布：`toolResult 32 / assistant 28 / user 6`
- stopReason 分布：`null 38 / toolUse 21 / error 4 / stop 3`
- **4 个 run**（`pi.result` namespace）：

| runId | status | 时长 | Nest 表里有对应 assistant？ |
|---|---|---|---|
| `01a15961-97ed-76e3-…` | completed | **618.6s** | ❌ **完全缺失** |
| `01a159b6-0ab6-7023-…` | completed | 20.2s | ✅ |
| `01a15c46-14c5-75d2-…` | completed | 61.2s | ✅ |
| `01a15c47-31f1-75d2-…` | **failed** (429 限流) | 438.1s | ✅ |

**⚠️ 被用户漏看的两条 user entry**（Nest 表里根本没有）：

```
seq=2088  '[用户补充 · 插在本轮回答进行中]\n然后通过章鱼图片参考'
seq=2527  '[用户补充 · 插在本轮回答进行中]\n锚也要先生成给我审核'
```

这两条是**插话（steer）**。`steerPiRun()` 只把消息投进 pi-runtime 队列，**不落 `AgentMessage` 表**（全仓仅 3 处 `agentMessage.create`：正常发送的 user / turn 收尾的 assistant / 内部工具保存）。
⇒ **插话在刷新后 100% 消失**，且它连一个「用户气泡」都不显示（只在 composer 上方的待发槽位里能看到，槽位是本地 state，刷新即消失）。

**全库健康度**：

```
assistant 9443 / user 1219
有 runId 的 assistant: 75     ← 唯一索引 (threadId, runId) 对 9368 条存量数据完全失效
209 个 thread 中，29 个 user 数 > assistant 数   ← 13.9% 的会话有孤儿 user 消息
```

### 1.2 代码层机理（前端）

| 事实 | 证据 |
|---|---|
| 移动端与 PC 端**复用同一组件**（`AgentSideRail.vue`），移动端用 CSS `hidden` 而非 `v-if` | `CanvasPage.vue:5625-5631`（注释明说 `v-if` 会导致 `loadHistory()` 永不执行） |
| ⇒ **同一浏览器标签页内**缩放窗口/切视口，消息状态是同一份，**不会不一致** | `useAgentMobileLayout.ts:7`（`matchMedia` 断点 768px） |
| ⇒ 用户观察到的差异**必然是跨设备**（手机 vs 电脑，两个独立浏览器 realm） | `main.ts:15` 每 realm 一个 `createPinia()` |
| **全仓零 `EventSource` / `WebSocket` / `BroadcastChannel` / `storage` 事件 / `visibilitychange` / `postMessage`** | 逐项全量搜索 `apps/web/src/**` 零匹配 |
| 增量通道 = **一次性 POST 响应体流**，只有发起方拿得到 | `AgentSideRail.vue:2323` `POST /api/agent/chat/conversation` + `:2353` `res.body.getReader()` |
| 历史通道 = **整体替换** `messages` | `stores/agent.ts:670` `messages.value = history.map(...)` |
| 前端**零重连**（无 `Last-Event-ID`、无退避） | 搜索 `Last-Event-ID` / `lastEventId` 零匹配 |

**⇒ 「刷新后同步」的精确机理**：刷新 → `onMounted → bootstrapThread() → loadHistory()` → 拉 Nest 展示表 → 整体替换 → 两端都收敛到同一份（**残缺的**）快照。

**⇒ 因此「刷新后同步」是合理的**——它证明两端**读的是同一个数据源**，问题不在读取路径，而在**写入路径**（有的轮次压根没写进去）和**增量分发路径**（增量不广播给旁观者）。

### 1.3 代码层机理（后端）

| 事实 | 证据 |
|---|---|
| pi-runtime **按 session 广播**（`listeners: Set`，`dispatch` 全量投递） | `session-manager.ts:382/1119/2181/2201`、`dispatch` `:2919-2939` |
| vendor `HarnessEventBus` 也是广播总线 | `vendor/…/harness/events.ts:9-10/134-146` |
| ⇒ **后端具备多端广播能力，但 Nest 把它用成了「每 HTTP 连接一条流」** | `agent.controller.ts:473-512`（`GET /runs/events`）、`:540-622`（`POST /chat/conversation`） |
| Nest 的 `GET /runs/events` **丢掉了 `id:` 帧** ⇒ 白白浪费 pi-runtime 已有的 `Last-Event-ID` 续传能力 | `agent.controller.ts:502` 只写 `data: ...`，而 pi-runtime 侧 `app.ts:474` 有 `id: ${event.seq}` |
| `GET /runs/events` 强制 `from=now`（`live:true`）⇒ **首连漏窗** | `agent.service.ts:645`、pi-runtime `app.ts:502-506` |
| 旁听流有 **30s 空闲闸门** + 前端最多重挂 3 轮 × 20s ⇒ 长任务（视频 ~11min）期间必断 | `agent.controller.ts:494-496/511`、`AgentSideRail.vue:2434-2447` |
| 同一 session 并发第二轮 ⇒ pi-runtime 返 **409 busy** ⇒ Nest 降级 `shadow` + 走 `steer` 队列 | `agent.service.ts:1415-1456` |
| `shadow` 流**只转发不落库** | `agent.service.ts:1759-1794`（`if (turnRole === 'owner')` 才 `finalizeTurn`） |
| user 消息在流**开始前**落库，assistant 在 `agent_end` **之后**落库 ⇒ 中断 ⇒ 孤儿 user 消息 | `agent.service.ts:413` vs `:2032` |
| `runId` 可空 ⇒ SQLite 下 NULL 互不冲突 ⇒ 唯一索引对 9368 条存量数据**完全失效** | `schema.prisma:358-361`、`agent.service.ts:2042` |
| `getMessages` 历史接口**只查 `AgentMessage` 表，从不回查 pi transcript** | `agent.service.ts:237` |

**⇒ 双真相源**：pi transcript（模型上下文的真相）vs `AgentMessage` 表（前端展示的投影）**独立双写、无对账**。任一侧丢失都**不会**被另一侧修复。

---

## 2. 根因排序（按证据强度）

| # | 根因 | 证据强度 | 后果 |
|---|---|---|---|
| **R1** | **长任务超过 nginx `proxy_read_timeout 300s` ⇒ 连接被掐 ⇒ generator 提前终止 ⇒ `finalizeTurn` 不可达 ⇒ 整轮不落库** | **强**：run1 耗时 618.6s > 300s，且**正好是唯一缺失的 run**；生产 nginx `proxy_read_timeout 300s` 确认 | 整轮助手消息永久丢失（pi 侧还在，模型记得，用户看不到） |
| **R2** | **增量流不广播给旁观端**：主流是「请求的附属物」，不是「会话的附属物」 | **强**：代码路径确定 + 零跨端通道 | 移动端看不到 PC 端正在发生的一切 |
| **R3** | **插话（steer）不落 `AgentMessage` 表** ⇒ 刷新即消失 | **强**：生产 transcript 里 2 条插话 user entry，Nest 表 0 条 | 用户的显式表达被丢弃 |
| **R4** | **历史接口是「残缺投影」**：assistant 只在 `agent_end` 后落一条，中断即丢；`runId=NULL` 让唯一索引失效 | **强**：29/209 thread 不平衡 | 刷新后仍不一致（两端一致地错） |
| **R5** | **`loadHistory` 是 `clear()` + 整体替换** ⇒ 与增量 push 存在覆盖竞态 | 中：窗口窄但每次刷新都存在 | 刷新瞬间可能吞掉刚到的消息 |
| **R6** | 本地消息 id 用 `msg-${Date.now()}` ⇒ 同回合 user/assistant **id 撞车** ⇒ Vue `key` 冲突 | 中：`stores/agent.ts:193` 与 `:230`，`AgentSideRail.vue:3662` 用 `:key="msg.id"` | 列表增删时 DOM 复用错位，肉眼看是「记录错乱」 |
| **R7** | 前端零重连 / 零 `visibilitychange` ⇒ 移动端切后台冻结后「假死」 | 中 | 移动端经常「卡在生成中」 |
| **R8** | `shadow` 流不落库 ⇒ 并发第二端的消息不进历史 | 中 | 并发发消息的语义对用户不可见 |

---

## 3. 生态对标（可验证来源）

| 产品 | 一致性机制 | 并发策略 | 断线恢复 | 真相源 |
|---|---|---|---|---|
| **OpenAI Codex** | 服务端 thread 事件流 + rollout JSONL append-only；thread → `connection_ids` 多连接广播 | **跨进程 OS 文件锁**（`rollout/src/writer_lock.rs:42-86` `try_lock` → `WouldBlock`）；进程内 `turn/steer` + `expected_turn_id` 乐观校验（`core/src/session/turn_input.rs:843`） | rollout 文件重放；`thread/fork` 分叉；`thread/revert` 写**新** rollout 文件保留旧记录 | rollout JSONL |
| **Claude Code** | 本地 JSONL append-only，**无锁** | **无保护**，官方明示两终端 resume 同 session 会交错；解法 `--fork-session` / `/branch` | `--resume` 重读 JSONL | 本地 `~/.claude/projects/*/*.jsonl` |
| **Claude Code Remote Control** | **服务端保存 transcript**，多端同步 | 本地进程 = 唯一执行者；多远程端 = 控制端；**「另一连接接管了此会话」**提示 | 断网/睡眠自动重连（server 模式约 10min 后需重跑） | Anthropic 服务器 transcript |
| **Slack / 飞书 / 钉钉** | append-only event log + 单调 seq/ts + 游标分页 | 服务端串行化写入；消息发送走 HTTP + 幂等键 | WS 重连 + **join point 补发**（RTM `hello` 之后补发连接期间事件） | 服务端消息表 |
| **Cursor** | cloud/local 双向 | **git worktree / 远程机器隔离**——并行 agent 各持独立副本 | 平台负责 | 云端 task 存储 |
| **pi-lnk 现状** | 一次性响应体流；历史整体替换；pi-runtime 有内存 buffer(500) + `seq` + `lastEventId` replay | `LaneBusy` → 409 → 降级 `steer` + `shadow`（只转发不落库） | Nest→runtime 指数退避（**无 jitter**）；**前端无重连**；buffer 溢出返 409 | **双真相源，无对账** |
| **pi-lnk 已有但未暴露** | `GET /sessions/:id/snapshot`（`LaneSnapshotProjection`，transcriptTail 限 16 条 / 文本截 400 字）；`GET /agent/thread-timeline` **恒 null** | `runs/steer` / `runs/followup` 端点已存在 | Nest `GET /runs/events` 是唯一常驻 SSE，但**丢 `id:` 帧** | `AgentMessage.runId` 可空 + `@@unique([threadId, runId])`（存量零回填） |

**Codex 源码已在 `/tmp/codex-probe` 验证**（`openai/codex`，sparse checkout `core/src`、`app-server/src`、`rollout/src`、`thread-store/src`）。

### 3.1 上游 pi-agent 能力盘点（`vendor/earendil-works/pi/`）

| 能力 | 有无 | 位置 |
|---|---|---|
| 事件总线多订阅者广播 | **有** | `harness/events.ts:14-28`（`on` 返回 unsubscribe）、`:134-136`（收件人快照）、`:138-162`（单 handler 异常隔离） |
| 事件总线 **seq / buffer / replay** | **无** | `events.ts:9-10` 只有 `listeners` + `watchListeners`，无 ring buffer |
| `BufferedEventWatcher` | 有但**不是回放**：`start()` 后立即清空 buffer | `events.ts:165-286`（`:198-207`） |
| **`lane.watch()` 快照（最重要的多端原语）** | **有** | `runtime/lane.ts:1705-1726`（`watch`）→ `:1729+`（`captureLaneSnapshot`） |
| `watchSession`（session 级快照） | **未实现** | `runtime/harness.ts:305-307` `throw new SliceNotImplemented("watchSession")` |
| `steer` / `followUp` / `nextRun` durable 队列 | **有** | `runtime/lane.ts:1418-1431`（三个入口）→ `:1434-1519`（`enqueue`，**入队即落盘** `pendingEntry`） |
| `queue_update` 事件 | **有**（每次广播**全量**队列快照，非增量） | `runtime/lane.ts:1513`、payload 形态 `agent-harness.ts:219` |
| 队列消费时机 | steer = run 内任意边界；followUp = 收尾边界且无 trigger 时；**同一边界有 steer 则 followUp 被跳过** | `runtime/drive/boundary.ts:85-89`、`:106-111`、`:161-259` |
| `appendCustomEntry` + `entryProjectors` | **有** | `session/session.ts:214-220`、`session/context.ts:47-64`（唯一调用点）、`runtime/harness.ts:72` |
| fork / branch | **有**（`Session.fork` / `branch` / `createBranch`） | `session/session.ts:349-368`、`session/fork.ts:31-60`（**lane 状态重置为 idle**）、`session/fork-policy.ts:10-30`（`pi.op.*`/`pi.pending.*` 全 exclude） |
| 跨进程写保护 | **无** | `session/jsonl/storage.ts:249-262` 纯 `appendFile`，**无 flock** |
| 进程内写串行 | **有** | `session/mutation-line.ts`（`MutationLine`）、`session/session.ts:243-261` |
| `LaneBusy`（单写者不变式） | **有**，3 处抛出 | `runtime/lane.ts:577-585`、`:690-698`、`:802-808` |
| 存储层 durable seq | **有**（entry 级，严格单调，跨重启连续） | `session/in-memory-storage-state.ts:69/78/82/143/148-152`、`session/commit.ts:99-100` |
| client / device 概念 | **无**（全目录搜 `clientId|connectionId|deviceId` 零匹配） | — |

**⭐ 关键洞察**：
1. **vendor 已有「快照 + 增量」范式**（`lane.watch()`），pi-lnk 的 `GET /sessions/:id/snapshot` 已经封装了它——只是裁剪太狠（16 条 / 400 字）且 Nest 侧的 `thread-timeline` 恒 null。
2. **vendor 的 durable seq 在 storage 层**（entry 级），**不在事件层**。pi-runtime 的运行时事件 seq（`dispatch` 独占分配）是**另一套**、且**只在内存**（`BUFFER_LIMIT=500`，`message_update` 每 token 一个事件 ⇒ 溢出是常规路径）。
3. **vendor 没有「同一 session 多写者」的跨进程防护** ⇒ pi-lnk 若要多实例部署，必须自己加（Codex 的 `writer_lock` 是可抄的模板）。
4. **「吃满上游」的第一步不是「上游有没有这个 API」，而是「宿主既有的同类通道我用了没有」**——`lane.watch()` / `snapshot` / `queue_update` / `lastEventId` 都是现成的，pi-lnk 目前**一个都没用透**。

---

## 4. 方案设计

### 4.0 架构原则（对标 Claude Code Remote Control + Codex）

> **执行权单写者 + 观测权多订阅者 + 服务端状态投影为准 + 消息队列化 + 游标传输**

四层职责必须拆开：

```
┌─ 执行面（run）───────────────── 单写者 ────────────────────┐
│  POST /chat/conversation  →  只负责「发起/排入」           │
│  立即返回 runId，不持有长流                                │
│  冲突语义由服务端裁决（idle→新run / busy→steer / busy→followup）│
└───────────────────────────────────────────────────────────┘
┌─ 观测面（session）─────────── 多订阅者 ───────────────────┐
│  GET /agent/sessions/:threadId/stream  (常驻 SSE)          │
│  每帧带 id: <seq>，支持 ?lastEventId= 断点续传            │
│  与「谁发起的 run」完全解耦                                │
└───────────────────────────────────────────────────────────┘
┌─ 投影面（truth）──────────── 服务端权威 ──────────────────┐
│  消息列表 + 回合状态 + 队列 + presence                     │
│  客户端从投影重建，不做增量 append                          │
│  ⭐ 双真相源必须收敛：以投影为唯一读源                    │
└───────────────────────────────────────────────────────────┘
┌─ 队列面（message queue）───── vendor lane ────────────────┐
│  steer / followUp / nextRun（已存在，未暴露给前端）        │
│  入队即 durable 落盘（vendor 已实现）                      │
└───────────────────────────────────────────────────────────┘
```

### 4.1 P0 止血（低风险、高收益，1 个迭代内可上）

| # | 改动 | 落点 | 解决 |
|---|---|---|---|
| **P0-1** | **nginx `proxy_read_timeout` 提到 1800s**（配合已有 15s 心跳，可再降到 600s） | `/etc/nginx/conf.d/lnkpi.conf:32` | **R1**（整轮丢失） |
| **P0-2** | **`finalizeTurn` 与流解耦**：把落库从「generator 正常收尾」改为「独立于请求生命周期的 settle 任务」——在 `pi-runtime` 侧 `agent_end` 事件到达时落库，或 Nest 侧起一个不随请求取消的后台任务 | `agent.service.ts:1759-1794` | **R1** 根除（不依赖 nginx 超时） |
| **P0-3** | **Nest 的 `GET /runs/events` 补上 `id: ${seq}` 帧**，并透传 `?lastEventId=` | `agent.controller.ts:502` | 启用断点续传（pi-runtime 已支持） |
| **P0-4** | **前端主流/旁听流加 `lastEventId` 游标 + 指数退避（带 jitter）重连** | `AgentSideRail.vue:2323/2449` | **R7**（移动端假死） |
| **P0-5** | **前端 `visibilitychange` 监听**：页面重新可见 ⇒ 立即重连 + 拉增量（不等退避计时器） | `AgentSideRail.vue` | **R7**、**R5**（竞态） |
| **P0-6** | **本地消息 id 改 `crypto.randomUUID()`**（或 `msg-${Date.now()}-${counter}`） | `stores/agent.ts:193/230` | **R6**（key 撞车） |
| **P0-7** | **`loadHistory` 改为「按 id 合并」而非「整体替换」**：保留 `persisted.id` 作为唯一键，本地乐观消息用 `clientId` 标记 | `stores/agent.ts:666-670` | **R5** |

### 4.2 P1 结构性改造（解决 R2/R3/R4/R8，多迭代）

#### P1-A：执行面与观测面分离（**最大的一处改动，但是一切的前提**）

**现状问题**：`POST /chat/conversation` 一次请求 = 一次 run + 一条流。**流是 run 的附属物，不是会话的附属物**。B 端打开会话时，没有任何机制能看到 A 端发起的 run。

**目标**：
1. `POST /chat/conversation` 改为**短请求**：发起/排入 → 立即返回 `{ runId, accepted: true, mode: 'run'|'steer'|'followup' }`
2. 新增 `GET /agent/sessions/:threadId/stream`：**常驻 SSE**，与谁发起无关
3. 前端改造：**发消息 = POST 短请求**；**接收 = 独立 SSE 常驻连接**（两件事解耦）

**收益**：任何客户端打开会话都能看到 A 端发起的 run 的全部增量；A 端关掉页面也不影响 B 端。

**风险**：Nest 侧 `streamConversation` 是 40+ 处位置调用的 generator，拆分需保持行为等价 ⇒ 建议**新增端点 + 灰度开关**，而非原地重构。

#### P1-B：服务端状态投影（让客户端「重建」而不是「猜」）

**已有基础**：`GET /sessions/:id/snapshot`（`session-manager.ts:2143-2153`）已封装 vendor 的 `lane.watch()`。

**要做**：
1. 扩展 `LaneSnapshotProjection`：
   - `transcriptTail` 16 条 → **分页**（按 `entryId` 游标向后翻）
   - 文本 400 字截断 → **完整正文**（投影层可从 `AgentMessage` 表补）
   - 新增 `messages[]`：带 `id / role / seq / clientId / runId / status / createdAt` 的**消息级投影**
   - 新增 `queue[]`（vendor `queue_update` 已有数据源）、`activeOperation`、`turnState`
2. **消息级 seq 成为一等公民**：`AgentMessage` 加 `seq`（或 `globalSeq`）列，`@@unique([threadId, seq])` 取代 `@@unique([threadId, runId])`（后者对 `runId=NULL` 的 9368 条存量完全失效）
3. `GET /agent/thread-timeline` **从恒 null 变成真实实现**（现在是死代码，浪费了上游能力）

**⭐ 真相源收敛（必须选一个，不能拖）**：
- **推荐 (iii) 明确分工 + 对账接口**：pi transcript 管「模型看到了什么」，`AgentMessage` 管「人看到了什么」，**差异本身是合法状态**（如 shadow 流事件不上表），但**必须有对账接口**把差异列出来。
- 现状是「双写 + 无对账 + 无补偿」⇒ 故障轮静默分叉，模型失忆。
- 已有基础：`turn-ledger.ts` 的 `isLedgerComplete` / `ledgerGapFrom`（`agent.service.ts:1767-1774` 已在用），但**只在单流内做**，没有跨端/跨 run 做。

#### P1-C：消息队列化 + 显式并发语义（解决 R3/R8）

**目标**：让「我这句话去哪了」可回答。
1. 发消息接口带**意图字段**（或由服务端裁决并回传）：
   - 空闲 → `mode: 'run'`（立即开新 run）
   - 忙碌 → `mode: 'steer'`（本轮边界消费）或 `mode: 'followup'`（下轮消费）
   - **这个决定由服务端告诉客户端，不让客户端猜**（Codex 的 `turn/steer` 就是显式区分）
2. **插话必须落库**：`steerPiRun()` 增加 `AgentMessage` 写入（role=user，带 `metadata.queued=true`），消费后置 `metadata.applied=true`。
   - 否则用户的显式表达在刷新后 100% 消失（已在生产证实 2 条）。
3. **shadow 流的语义显式化**：前端收到 `turn_not_submitted{reason:'not_idle'}` 时显示「已并入进行中的任务」，并在历史里体现（当前该消息只在气泡里，无历史痕迹）。

#### P1-D：乐观插入 + `clientId` 幂等键（跨端一致性的最后一环）

**现状**：无乐观插入（等 SSE 回来才上屏）、`Idempotency-Key` 只在 HTTP 层防重、**没贯穿到消息身份**。

**目标**（业界标准状态机，Ably / Slack 一致）：

```
optimistic(sending, clientId)
   ├─ 服务端 ack → confirmed(serverId, serverTime)   ← 就地 reconcile，不 delete+insert
   ├─ 发布失败   → failed(标红 + Retry，复用同一 clientId ⇒ 幂等)
   └─ 对方设备收到 → delivered → read
```

- `AgentMessage` 加 `clientId` 列（可空，存量零回填，与 `runId` 迁移策略一致）
- **规则**：A 端乐观插入的消息，在 B 端**直接就是已确认态**（服务端已接受）——**不要在 B 端也做乐观插入**
- **规则**：失败分两类——「发布失败」（消息从未进会话，保留 + Retry）vs「唤醒 agent 失败」（消息已进会话，**保留**，只重试唤醒）

### 4.3 P2 长期

| 项 | 内容 |
|---|---|
| **P2-1 设备在场（presence）** | 服务端维护 session 的在场设备列表 + 「当前执行者」。Claude Code Remote Control 的「另一连接接管了此会话」提示是成熟范式 |
| **P2-2 fork 作为逃生舱** | 「手机上想试另一条路」= Codex `thread/fork` / Claude Code `--fork-session` / Cursor worktree。**已有** `POST /sessions/:id/fork` + `branchFromEntryId` 上行字段，但**运行中/压缩中被拒**（`session-manager.ts:2702-2704`）⇒ 手机上想开分支必须等当前 run 结束 |
| **P2-3 多实例就绪** | 事件 buffer 在内存（`BUFFER_LIMIT=500`，`replicas=1` 时无兜底）⇒ 多实例前必须把 buffer 挪到共享存储，或显式拒绝多实例部署 |
| **P2-4 压测** | 套件必须包含「N 端并发订阅同一 session + 断网重连 + buffer 溢出」场景。当前 `BUFFER_LIMIT=500` 配 `message_update` 每 token 一个事件 ⇒ **溢出是常规路径不是边缘情况**（`session-manager.ts:420-436` 注释原话） |

### 4.4 明确不做（避免过度设计）

| 不做 | 理由 |
|---|---|
| **WebSocket** | 需求是单向增量；`Last-Event-ID` 是浏览器自动发的标准；现有 Nest 已是 `text/event-stream`；WS 要自己实现重连 + 游标 + 心跳 + 背压，过代理更脆 |
| **BroadcastChannel 当一致性机制** | 只在同源标签页生效，跨设备无效 ⇒ 需求含「手机」必须走服务端。**可以**用它做同源标签页的**延迟优化**（提示「对端刚发了消息」），但它不是一致性机制 |
| **把 AgentMessage 表当唯一真相** | pi transcript 是模型上下文的真相源；表当真相会让压缩/分支场景失真 |
| **给 pi-lnk 加「禁止并发」的硬锁** | 需求明确要「手机随时插话」⇒ 走队列（`steer`/`followUp`），不是拒绝。Codex 的硬锁适用于「同一份文件并发写」，不适用于「消息队列」 |

---

## 5. 落地顺序建议

```
批次 A（止血，1 迭代，零架构改动）
  ├─ A1 nginx proxy_read_timeout 300s → 1800s        ← 直接止血 R1
  ├─ A2 finalizeTurn 与请求生命周期解耦              ← 根除 R1
  ├─ A3 Nest SSE 补 id: 帧 + 透传 lastEventId        ← 启用续传
  ├─ A4 前端游标 + 退避(jitter) + visibilitychange  ← R7/R5
  └─ A5 本地 id 改 randomUUID                        ← R6

批次 B（结构，2~3 迭代）
  ├─ B1 投影面：消息级 seq + clientId + 分页 snapshot + 真实 thread-timeline
  ├─ B2 观测面：常驻 session SSE 端点 + 前端解耦（灰度开关）
  └─ B3 队列面：插话落库 + 显式 mode 回传 + 乐观插入状态机

批次 C（完善）
  ├─ C1 对账接口（双真相源差异可列出）
  ├─ C2 presence / 接管语义
  └─ C3 fork 逃生舱 + 多实例就绪
```

**A1 是当天就能做的**——一行 nginx 配置，但它止的是「整轮对话永久丢失」这个最严重的用户可感知损失。

---

## 6. 未验证 / 需补充取证

| 项 | 说明 |
|---|---|
| **R1 的因果链最后一环** | 「618.6s > 300s ⇒ nginx 掐断 ⇒ generator 提前终止」是**强相关 + 机制自洽**，但**缺一条直接日志**（生产日志已轮转）。**可复现验证**：在本地/预发跑一个 >300s 的 run，同时观察 Nest 侧是否落库。建议在批次 A 落地时**加一条埋点**：SSE 响应 `close` 事件时记录已运行时长 + 是否已 `finalizeTurn` |
| pi-runtime 事件层 seq 与 vendor storage seq 的对应关系 | 两套 seq 独立，代码里没有交叉引用 |
| Codex `rollout` 是否给每个 item 分配可续传 seq | 只验证了「JSONL 按行追加 + 靠文件位置重放」，未验证 item 级 seq |
| Claude Code session 目录**无文件锁** | 由官方「两终端 resume 同 session 会交错」陈述**反推**，未找到「无锁」原句 |
| Cursor / Windsurf / Cline 的断线恢复与真相源 | 官方未公开；Cline/Windsurf **完全未找到**官方并发机制 |
| pi-lnk 生产是否存在「shadow 流」实例 | 日志已轮转，全库统计 `turn_not_submitted` 计数为 0（该窗口内无）⇒ R8 目前**无生产实例**，属潜在缺陷 |

---

## 附录：关键代码位置索引

**前端**
| 位置 | 内容 |
|---|---|
| `apps/web/src/stores/agent.ts:666-670` | `loadHistory` 整体替换 `messages` |
| `apps/web/src/stores/agent.ts:193/230` | `msg-${Date.now()}` id（撞车源） |
| `apps/web/src/components/agent/AgentSideRail.vue:2323-2372` | 一次性响应体流解析（无 `id:` 帧、无重连） |
| `apps/web/src/components/agent/AgentSideRail.vue:1733-1770` | `loadHistory()` |
| `apps/web/src/components/agent/AgentSideRail.vue:2434-2447` | 旁听尾流 3 轮 × 20s 上限 |
| `apps/web/src/components/agent/streamRecovery.ts:96-127` | `resolveBootstrapThreadId` 启发式选线程 |
| `apps/web/src/pages/CanvasPage.vue:5625-5631` | 移动端用 CSS `hidden` 而非 `v-if` |

**后端**
| 位置 | 内容 |
|---|---|
| `apps/server/src/agent/agent.controller.ts:540-622` | 主对话 SSE 端点（15s 心跳在 `:588-595`） |
| `apps/server/src/agent/agent.controller.ts:473-512` | `GET /runs/events`（**丢 `id:` 帧**，30s 空闲闸门） |
| `apps/server/src/agent/agent.service.ts:409-422` | user 消息落库（流开始前） |
| `apps/server/src/agent/agent.service.ts:1415-1456` | 409 → shadow → steer 降级链 |
| `apps/server/src/agent/agent.service.ts:1759-1794` | owner / shadow 落库分叉 |
| `apps/server/src/agent/agent.service.ts:1989-2079` | `finalizeTurn` |
| `apps/server/src/agent/agent.service.ts:233-257` | `getMessages`（只查 `AgentMessage` 表） |
| `apps/server/src/agent/pi-runtime/pi-runtime.client.ts:474-577` | `streamEvents` 重连（指数退避**无 jitter**） |
| `apps/server/prisma/schema.prisma:337-370` | `AgentMessage`（`runId` 可空 + `@@unique([threadId, runId])`） |

**pi-runtime**
| 位置 | 内容 |
|---|---|
| `services/pi-runtime/src/session-manager.ts:2919-2939` | `dispatch`（seq 独占分配 + buffer + 广播） |
| `services/pi-runtime/src/session-manager.ts:420-436` | `BUFFER_LIMIT=500` 溢出是常规路径 |
| `services/pi-runtime/src/session-manager.ts:2143-2153` | `snapshot()`（封装 vendor `lane.watch()`） |
| `services/pi-runtime/src/app.ts:474` | SSE 帧带 `id: ${event.seq}` |
| `services/pi-runtime/src/app.ts:520-537` | 409 `replay window expired` + `recovery: "rebuild full timeline"` |

**vendor pi**
| 位置 | 内容 |
|---|---|
| `vendor/…/harness/runtime/lane.ts:1705-1726` | **`lane.watch()` 快照（最重要的多端原语）** |
| `vendor/…/harness/runtime/lane.ts:1418-1519` | `steer`/`followUp`/`nextRun` + durable enqueue |
| `vendor/…/harness/runtime/drive/boundary.ts:76-145` | `planBoundaryInbox`（队列消费时机） |
| `vendor/…/harness/events.ts:9-10/134-146` | `HarnessEventBus`（广播，**无 seq/buffer**） |
| `vendor/…/session/mutation-line.ts` | `MutationLine`（进程内串行，跨进程无保护） |
| `vendor/…/session/jsonl/storage.ts:249-262` | 纯 `appendFile`，**无 flock** |
| `vendor/…/harness/runtime/harness.ts:305-307` | `watchSession` **未实现** |
