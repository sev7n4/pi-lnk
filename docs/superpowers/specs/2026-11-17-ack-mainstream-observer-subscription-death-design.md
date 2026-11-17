# ack 化主流收口订阅「建立即死 + 重挂不开 + 无自愈」修复规格

- 日期：2026-11-17
- 状态：立项（待评审后实施）
- 上游：docs/superpowers/specs/2026-11-17-e2e-followup-ui-fixes-design.md（U-1/U-2/U-3）的活体复测未竟项
- 关联：PR #941（`fix(web): run 失败零感知——error 分支文案走 appendTurnNotice 兜底通道`，已合 `586142a1`）修复了「事件到达后的渲染层静默」；本规格处理「事件根本到不了渲染层」的订阅层缺陷。

## 1. 背景与证据链（本轮生产取证，2026-11-17）

U-3 活体复测（model_not_found / 429 失败轮用户零感知）全链逐层取证结论：

| 层 | 行为 | 证据 |
| --- | --- | --- |
| pi-runtime | `agent_end`（status=failed + 结构化 `error{code,message}`）✅ 已发 | CVM events.jsonl 抓帧（seq 序列 turn_start→message_end→turn_end→agent_end failed） |
| Nest 主链路 | `classifyPiRunError` → yield `error` UiEvent ✅ 已派生 | agent.service.ts:3460 既有代码；observer 通道 SSE 抓帧实测 `{"type":"error","data":{"message":"404: {...model_not_found...}","error_type":"unknown"}}`（seq 13） |
| Nest 重放通道 | `lastEventId` 断点续传 ✅ 正常 | 页面内 fetch `?lastEventId=4` 重放拿到 `error/done/turn_usage` 帧全集 |
| **前端常驻订阅** | **建立即死（200 后 ~2ms 被掐）+ 无重连**；sendMessage ack 分支重挂时**不开连接**且无自愈 ❌ | CDP Network 抓帧（详见 §2）；monkey-patch fetch/AbortController 实证 sendMessage 期间零 fetch、零 abort |
| 前端渲染层 | `case 'error'` 裸 `appendText` 在零文本失败轮静默 no-op → **#941 已修**（改 `appendTurnNotice` 兜底通道） | RED→GREEN + 接线契约测试锁死 |

⇒ **候选刀「runtime run 失败应向 SSE 发 error 事件」不成立**：Nest 已从 agent_end 派生 error（吃满上游、不重复造轮子）。UI 零感知的真正根因是前端订阅层两刀叠加：渲染层 no-op（#941 已修）+ 订阅层死亡（本规格）。

## 2. 缺陷描述与实测行为

### 2.1 页面加载：订阅建立即死、不重连

CDP Network 域抓帧（headless 单 tab、全新 profile，两者一致；生产 bundle `586142a1`）：

```
t=377ms  req1 GET /api/agent/runs/events?...   （带 Authorization）
t=378ms  req2 同 URL                           （1ms 后双挂）
t=379ms  req1 net::ERR_ABORTED (canceled=true)  （被新一轮 start 取代）
t=671ms  req2 → 200 text/event-stream          （响应头到达）
t=673ms  req2 net::ERR_FAILED (canceled=false)  （200 后 2ms 被掐，帧未读）
其后 60s  零重连请求
```

手工在页面内以完全相同的 URL + token fetch 并读流 25s：**稳定正常**（收到 retry + observer-ready 注释帧）⇒ 服务端/网络无问题，是前端消费侧主动断。

### 2.2 sendMessage：重挂不开连接、零 abort 记录

monkey-patch `window.fetch` + `AbortController` 后经 UI 发消息（owner 形态，agnes-3.0-flash 自然 429 场景）：**30s 内零 `/runs/events` fetch、零 abort 调用**，runtime 侧 agent_end failed 正常产生，UI 零渲染。

### 2.3 关键语义前提

- POST `/api/agent/chat/conversation` 生产返回 ack JSON（`{accepted:true, threadId, sinceSeq}`）——**ack 化主流已开**：回合事件（文本收口 / error / task 卡 / credit_tx）全部依赖 `GET /runs/events` 常驻订阅收口（`useAgentObserver` onEvent 排他分派 + `finishOwnTurnViaObserver`）。
- 订阅死亡 ⇒ 不只是旁观同步失效，**本端主回合的实时收口也失效**。

### 2.4 涉事机制（multi-device P0 / 共享订阅栈）

- `useAgentObserver.ts`：`listenFollowUpTail` → `ensureSseSlotSubscription`（全局槽位频道 `lnkpi:agent-sse-slot`）+ `ensureSharedSubscription`（会话频道 `lnkpi:agent-sub:<sessionId>:<threadId>`）→ `evaluateConnection()`。
- `evaluateConnection` 判据：`shouldOpenConnection({degraded, isLeader, visible}) && holdsGlobalSseSlot()`；allowed=false ⇒ `followUpTail.abort()`。
- `follow-up-tail.ts`：`start()` = `abort()` + `launch()`；`run()` 开头 `if (state !== 'idle') { onReady(); return }`（**早退不发请求**）；重连预算 5 次 + 30s 冷却；`reader.cancel()` 连接卫生。
- `shared-subscription.ts`：BroadcastChannel 选举（tick 1s 心跳、3s 接管阈值、alivePeers 含可见的自己）。

### 2.5 竞态画像（待实施期精确定位）

实测时间线与代码结构相容的假说（按可能性排序）：

1. **三连 start 竞态**：mount 与 watch([sessionId, threadId]) 各触发 `listenFollowUpTail`，`start()` 先 abort 旧轮再 launch；若某次 `run()` 在旧轮 finally（`reader.cancel()` 异步）完成前进入，`state !== 'idle'` 早退 ⇒ 该轮**不发请求**；同时旧轮已被掐 ⇒ **零轮在飞**且无任何重估触发 ⇒ 永久死亡。
2. **选举窗口误判**：多层频道（槽位 + 会话）选举完成前 `evaluateConnection` 判 not allowed → abort；选举完成后的 `onLeadership` 若先于该判定消费过（或 leader 身份未变化不再触发）⇒ 无人重开。
3. **错误路径静默退出**：200 后被 cancel 的连接走 `catch → delay(round.signal) → token.stopped → return`，无指标、无日志、无宿主通知。

⇒ 共同点：**存在一条「state 离开 idle 但没有任何连接在飞」的孤儿态，且全部现有触发点（onMounted / watch / visibilitychange / onLeadership / onDegrade）都不会在此态出现时再触发**。

## 3. 影响面

- **主场景**：ack 主流回合的实时收口（文本流式、turn_settled、任务卡、error 渲染）依赖订阅——死亡即「发消息后 UI 静默直到刷新」。刷新后 `loadHistory` 拉权威历史可恢复内容（历史回放不含 error 事件，失败轮在历史中无痕迹——既有边界，另立候选）。
- **旁观场景**：多端一致性的常驻同步失效（follower 等 leader 转发，leader 死则全灭）。
- **触发条件**：页面加载即中（与单/双 tab、profile 新旧无关，本轮已控制变量复现）。用户日常「发消息 → 刷新才看到回复」类体感与此吻合。

## 4. 修复方向候选（实施期定稿，本节先立约束）

**硬约束**：
- 不得破坏 multi-device P0 既有裁决：follower 不开连接、隐藏页不占连接、任何时刻 ≤1 条连接、重连预算防死循环。
- 不得引入双份消费（text_delta 双倍文本是既有生产事故）。
- 判据落在可观测出口（连接是否产出 data 帧），不靠时长猜测（既有 2026-10-24 豁免裁决同源）。

**候选**：
- **A. run() 早退改重试**：`state !== 'idle'` 早退路径改为「等待在飞轮结束（上限若干 ms）后重试 launch」，消除三连 start 竞态的丢轮。
- **B. 孤儿态自愈（守卫面最宽）**：`followUpTail` 增加轻量一致性检查——`state !== 'idle'` 但 `live.size === 0`（无在飞轮）⇒ 复位 idle 并重开；挂接在 tick / onLeadership 等既有周期触发点上，fail-soft。
- **C. 评估后强制重估**：`listenFollowUpTail` / ack 分支重挂后延迟一次 `evaluateConnection`（选举稳定窗后），保证「最后一轮 start 必然落连接」。
- **D. 主流 fallback**：ack 分支在订阅未确认建立（T+2s 无在飞连接）时回落消费 POST 响应体流（回归非 ack 路径）——兜底但复杂度高，作最后防线。

**推荐**：B（守卫面最宽、不依赖对竞态时序的精确枚举）+ A（消掉已证实的丢轮早退）；C 视 B/A 实测效果决定是否追加；D 暂不。

## 5. 验收标准

1. 页面加载 T+5s：`/runs/events` 存在**存活连接**（duration 持续增长、非秒断），且 60s 观察窗内不出现「零连接」态。
2. ack 主流 E2E：UI 发消息（模型选 agnes 渠道触发自然 429）→ 30s 内对话流出现 `⚠️ AI 服务当前限频`（#941 渲染层在事件到达后生效）+ dock 失败提醒。
3. 旁观 E2E：第二标签页打开同会话，第一标签页发消息失败 ⇒ 第二标签页同样可见失败提示（共享层转发语义不变）。
4. 回归：multi-device P0 契约测试（共享订阅/槽位/可见性）全绿；`vitest` 全量 + `vue-tsc -b` 干净；变异自检（移除自愈守卫 ⇒ RED）。
5. 生产取证：部署后 CDP 复跑 §2.1/2.2 两个探针，行为翻转。

## 6. 实施切分

- S1：竞态精确定位（临时 patch/日志版 bundle 或 vitest fake-timers 重建时序），定稿 §2.5 假说。
- S2：按 §4 推荐组合实施 + 单测（fake timers 模拟三连 start / 选举窗 / 孤儿态）。
- S3：E2E（CDP 脚本沉淀为 `.workbuddy/e2e-cdp/` 可重放探针）+ 全量门禁 + 部署复测（§5）。
