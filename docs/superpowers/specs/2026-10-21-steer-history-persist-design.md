# 插话落 AgentMessage 表 + 统一 user 消息身份（2026-10-21）

> 分支 `feat-steer-history-persist`。本文回答两个问题：**为什么插话刷新后会消失**，以及**如何避免重复造与互相覆盖**。

## 一、根因

刷新后的历史读的是 `AgentService.getMessages`（`agent.service.ts`），**它只查 `AgentMessage` 表**。
而插话（steer）/ 尾随（followUp）走队列 API：

```
前端 POST /api/agent/runs/steer
  → AgentController.steerRun → AgentService.steerPiRun
    → pi-runtime POST /sessions/:id/steer → vendor lane inbox
      → 下一个 turn 边界才写进 transcript
```

这条链路**从不建 `AgentMessage` 行**（对比正常发送：`streamConversation` 里有 `agentMessage.create`）。
⇒ 用户插过的话，刷新后历史里**凭空消失**，只在刷新前的实时气泡里可见。

雪上加霜的是：`AgentMessage` 原本**没有任何 user 消息的身份键** ——
唯一约束只有 `@@unique([threadId, runId])`，而 `runId` 是 assistant 的 operationId，
user 消息恒为 NULL ⇒ 既无法去重，也无法定位「③ 重跑」的 fork 切点。

## 二、关键机制：entryId 在「入队那一刻」就可得

这是整个方案的地基，实测结论：

| 路径 | 是否回传 entryId | 位置 |
|---|---|---|
| steer / followUp | ✅ **是，且必返** | `pi-runtime/src/session-manager.ts:2517` / `:2583` — `return { queued: true, entryId: res.value.entryId }` |
| prompt（正常发送） | ❌ 只回 `{ accepted }` | 同文件 `:2370` |

vendor 的 `QueueResult` 自带 `{entryId}`，#507（撤回插话）已把它从 Nest 透传到前端。

⇒ **服务端可以在入队成功的那一刻就原子落库**，不需要等消费、不依赖客户端在线、
不需要引入第二把幂等键（曾考虑过 `clientMsgId`，实测后确认没必要）。

> ⚠️ 教训：核机制前务必读 **worktree（当前 master 基线）**，不要读主仓工作树。
> 主仓 HEAD 常在旧分支，按旧代码得出的「响应不带 id」结论是错的（本轮真实踩过）。

## 三、方案

### 3.1 Schema（迁移 `20261021153000_add_agent_message_entry_identity`）

`AgentMessage` 加一列：

```prisma
entryId  String?
@@unique([entryId])
```

**纯 additive**：SQLite 下多个 NULL 互不冲突 ⇒ 存量行与 assistant 行都不受影响，
零回填、可原样回滚（`ALTER TABLE ADD COLUMN` 可空列不需要重建表）。

### 3.2 服务端入队即落库

`steerPiRun` / `followUpPiRun` 在 pi 返回 `queued:true` 后调
`persistQueuedUserMessage`，用 entryId 幂等 upsert。

三条不变量：

1. **键 = entryId**（唯一索引）：重复调用（重试 / 双写 / 事件重放）命中即 no-op。
2. **`update: {}` 空操作 = 先到先得**：后来者**绝不覆盖**既有行的 content。
3. **fail-soft**：落库失败只记 warn 不抛。插话此时**已被 pi durable 收下**，
   抛错会让前端以为「没发出去」而重试 ⇒ 反而制造重复消息。

### 3.3 正常发送：消费时回填

`pi.prompt()` 不回传 entryId ⇒ 正常发送的 entryId 只能从 `pi_message_end` 事件拿。
新增 `attachUserMessageEntryId` + `POST /api/agent/chat/user/entry-id`，
前端在 attach 分支时调用。

定位口径：**thread 内最后一条 `entryId` 为 null 的 user 行**
（与前端 `AgentSideRail.vue` 的 attach 分支同口径）。
⛔ 绝不覆盖已有 entryId —— 那是上一条发言的 fork 切点。

前端 `queueBubbleSync` 新增可选依赖 `persistEntryId`。
⚠️ **回填刻意不绑在「本地是否找到落点」上**：本地那条被丢弃 / 清空 / 多端不一致时
判定返回 `skip`，但服务端那行仍存在、仍需要 entryId。

## 四、如何避免「重复造」与「互相覆盖」

| 风险 | 机制 |
|---|---|
| 重复造（重试 / 事件重放） | entryId 唯一索引 + `update:{}` ⇒ 命中即 no-op，且**不覆盖**既有行 |
| 重复造（客户端 + 服务端双写） | 插话**只有服务端一个写者**；前端 insert 分支**刻意不回填** |
| 重复造（多端 / 多页签） | 每次发言的 entryId 全局唯一 ⇒ 两端各写各的，互不撞 |
| 互相覆盖（刷新后文字变了） | 落库内容是**用户原话**，不是发给 pi 的拼装文本（后者含 `QUEUE_MARK` / `[In=…]` 标记）。显示层与上下文层分离 |
| 互相覆盖（fork 切点被冲掉） | 回填只认「`entryId` 为 null 的行」；已认领的不动（PR #534 同款守卫） |
| 互相覆盖（双写先后打架） | 先到先得 + 空操作 update ⇒ 后写的拿不到写权限 |

## 五、测试

| 文件 | 例数 | 覆盖 |
|---|---|---|
| `agent.service.steer-persist.test.ts` | 12 | 入队即落库 / **内容是原话** / **先到先得** / followUp 同款 / queued=false 不落库 / 无键不落库 / **fail-soft** / 回填定位 / **回填幂等** / 找不到不硬造 / fail-soft |
| `queueBubbleSync.test.ts` | 18（含新增 5） | 回填口径：初始 prompt 回填、**插话不回填**、无落点仍回填、重放幂等、可选依赖不抛 |
| `AgentSideRail.queueBubbleWire.test.ts` | 5（新增 2） | 接线守卫：`persistEntryId` 收敛到判定模块；回填打专用端点且静默失败 |

**变异实测**（三个变异 ⇒ 5 条断言准确变红）：

1. `update: {}` 改成覆盖写 ⇒ 2 条红（先到先得）
2. 改存发给 pi 的拼装文本 ⇒ 2 条红（内容是原话）
3. 前端 insert 分支也回填 ⇒ 1 条红（插话不回填）

## 六、范围外

- **多端同会话可见性**：本方案让「落库正确」，但不解决「设备 B 不刷新就看不到设备 A 的插话」
  —— 那是实时广播的事（见 `2026-10-21-multi-device-consistency-design.md`），本设计不会让它更糟。
- **历史存量回填**：全部存量 user 行的 entryId 仍是 NULL（零回填是刻意取舍），
  老消息的「③ 重跑」维持既有降级兜底。