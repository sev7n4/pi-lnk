# 插话/尾随用户气泡实时化 + 「已接住」上下文验证 实施计划

> 规格：`docs/superpowers/specs/2026-11-11-queue-user-bubble-context-verify-design.md`
> 流程：superpowers writing-plans；TDD、每任务独立可测；改动命中 `apps/server/**` + `apps/web/**` ⇒ 独立 squash PR + 生产复测。

## PM/架构师自审裁定（2026-11-11，规格 §11 同步追加）

自审结论：**通过**。目标（跨端实时气泡 + 权威消费终态）不变，实现手段收敛为 6 条：

1. **不新建 per-thread 总线，复用既有 `SessionEventBus`**（`apps/server/src/points/session-event-bus.service.ts`，已有 credit_tx / turn_settled / turn_ack 三通道与 listenerCount 泄漏清理）。新增 `userUtterance` 通道；扇出点在 `runEventStream`（multi-device P1 后发起端与旁听端同源的权威通道）。**因此 `services/pi-runtime/**` 零改动**，规格 §4.1 对 `session-manager.ts:1768` 的「推翻」不再需要——`queue_update` 仍不进 SSE，新事件是 Nest 侧用户发言领域事件，走 Nest 总线而非 lane buffer。合成事件无 pi-runtime seq ⇒ 不写 `id:` 行（controller 既有规则天然兼容）；**晚加入者的气泡不靠事件重放**，靠 DB 权威源（历史 GET 返回 `queued`/`reconciled`）。
2. **consumed 触发点落地口径**：服务端观察到 `pi_message_end{role=user, entryId}` 且 DB 命中 `queued=true` 行 ⇒ 判定 entry 已物化进 transcript（vendor `boundary.ts:115-142` 物化 + `checkpoint.ts:114-122` 续生成 ⇒ 必被下一轮 `readBoundedContext` 读入）。在**主流 `streamConversation` 事件循环**与**旁听 `runEventStream` 投影路径**双挂钩——后者覆盖 followUp 收尾边界消费（主流在 `agent_end` 收尾，早于收尾边界，P3 G3 注释为证）。UPDATE 幂等（`WHERE queued=true`）。
3. **读时派生不删，降级为 legacy fallback**：存量 52 条已消费行 `consumedAt=NULL` 且事件流不重放历史，直接删派生会让全部历史插话显示「排队中」（回归）。规则改为：`consumedAt != null` ⇒ 权威值优先（queued=false）；`consumedAt == null` ⇒ 沿用「同窗有更晚 assistant 行」派生。deploy 后由取证脚本 `--reconcile` 一次性回填存量，之后新行全部走权威终态。
4. **stuck 终态由对账脚本声明（v1）**：运行时不做启发式（「无活跃 run + 超时」会把「下一轮边界将被消费」的条目误判为 stuck）。`scripts/verify-queue-context.ts` 以 transcript 扫描为准绳判 consumed/stuck，`--reconcile` 回填 DB（`reconciled=true`）。运行时 UI：`queued && !reconciled` 显「待接住」（比现状诚实——它确实还没被消费）；`queued && reconciled` 显「未接住」。
5. **`user_utterance_queued` 只从显式 `POST /runs/steer` / `runs/followup` 路径发**：409 隐式插话的用户气泡已由正常发送路径乐观渲染（行在 prompt 前已落库），再发 queued 事件会与本地气泡重复（本地行尚无 entryId，`decideQueueBubbleSync` 的 entryId 幂等拦不住）。隐式路径的行经 `markQueuedUserMessage` 带 entryId，consumed 翻转照常生效。
6. **事件载荷**：`{ type:'user_utterance_queued'|'user_utterance_consumed'|'user_utterance_stuck', data:{ threadId, entryId, content?, ts } }`。queued 的 `content` 取落库原文（`persistQueuedUserMessage` 已知），不用拼过 `QUEUE_MARK`/`[In=…]` 的机器载荷。AC4 重连不双插由 entryId 幂等 + 历史权威源共同保证（合成帧无 id 行 ⇒ Last-Event-ID 不指向它们，重连后经历史 hydration 拿终态）。

## 任务分解（TDD）

### Task 1：数据层（Prisma + getMessages）
- `apps/server/prisma/schema.prisma` `AgentMessage` 增列：`consumedAt DateTime?`、`reconciled Boolean @default(false)`（纯 additive，存量零回填，可原样回滚；注释写明 SSOT 语义）。
- 新迁移 `20261111xxxxxx_add_agent_message_utterance_terminal`。
- `getMessages` 映射：输出行增 `consumedAt`/`reconciled`；`queued` 判定改为 `role==='user' && persisted.queued===true && !persisted.consumedAt && !persisted.reconciled && legacyDerivation`（legacy 派生保留在最后一位）。⚠️ 现映射在 `paginateVisibleRows` 输入行上做派生（`:728-737`），改在派生处叠加权威门。
- 测试：`agent.service.messages.test.ts` 追加——consumedAt 非 null ⇒ queued 恒 false（即使无更晚 assistant 行）；reconciled ⇒ queued false 且透出 reconciled。

### Task 2：SessionEventBus userUtterance 通道
- `session-event-bus.service.ts`：`userUtteranceEmitters` registry + `emitUserUtterance(ev)` + `subscribeSessionUserUtterance(key, fn)`（仿 turnAck，含双键路由说明）。
- 类型 `UserUtteranceBusEvent { sessionId(路由键=threadId||sessionId), data:{ threadId, entryId, kind:'queued'|'consumed'|'stuck', content?, ts } }`。
- 测试：仿 `session-event-bus.turn-ack.test.ts`——订阅/退订/泄漏清理/双键。

### Task 3：queued 事件发射
- `agent.service.ts`：`persistQueuedUserMessage` 落库成功后（upsert create 分支实际写入时）`this.eventBus?.emitUserUtterance({ sessionId: threadKey, data:{ threadId: threadKey, entryId, kind:'queued', content, ts } })`。⚠️ update 分支（重放命中既有行）不 emit（先到者的请求已 emit 过）。
- 测试：`agent.service.steer-persist.test.ts` 追加——steer/followup 落库后 emit queued（content=原文）；重放不重复 emit；eventBus 缺省 fail-soft。

### Task 4：consumed 观察挂钩
- `agent.service.ts` 新私有方法 `noteUtteranceConsumed(threadKey: string, entryId: string)`：`updateMany({ where:{ entryId, queued:true }, data:{ queued:false, consumedAt: new Date() } })`；`count>0` ⇒ emitUserUtterance(kind:'consumed')；try/catch fail-soft（fail-soft 理由同 persist：消费已发生，写不进去不影响对话）。
- 挂钩点 A：`streamConversation` 主循环处理 `message_end` 处（`:3498` 附近，role=user && entryId 存在 ⇒ note）。挂钩点 B：`runEventStream` 投影循环（observer 侧，覆盖 followUp drain 生成）。
- 测试：queued 行 + 模拟 message_end ⇒ 行翻转 + emit consumed；非 queued 行/无 entryId ⇒ no-op；重放幂等（第二次 count=0 不 emit）。

### Task 5：runEventStream 扇出
- `runEventStream` 订阅 `subscribeSessionUserUtterance(sessionKey, ...)` push 进既有 queue（与 turnAck 补桥同口径），finally 退订。
- 帧形态 `{ type:'user_utterance_queued'|'user_utterance_consumed'|'user_utterance_stuck', data }`（无 seq ⇒ 无 id 行）。
- 测试：`agent.service.pi-runtime.test.ts` 追加——emit 后 generator yield 对应帧；退订后不 yield。

### Task 6：前端
- `AgentSideRail.vue` switch（`:2261`）加三 case：
  - `user_utterance_queued`：`messages.some(m=>m.entryId===entryId)` 幂等 ⇒ skip；否则 `store.insertUserMessageBeforeAssistant`（或同等）插入带 `entryId, queued:true` 的用户气泡（content 用事件 data）。
  - `user_utterance_consumed`：按 entryId 翻 `queued:false`（store 新 action `markMessageUtteranceConsumed`）；未命中时顺带走 attach 兜底（镜像 pi_message_end attach 口径：最后一条无 entryId 的 user 行挂 entryId+翻 queued）。
  - `user_utterance_stuck`：按 entryId 标 `reconciled:true`。
  - `pi_message_end` 既有分支（`:2270`）：attach 命中/已有行的消息若 `queued` ⇒ 一并翻 false（与 consumed 事件幂等共存，AC5）。
- `stores/agent.ts`：新增 `markMessageUtteranceConsumed(entryId)` / `markMessageUtteranceStuck(entryId)`；历史映射（`:1022-1024`）透传 `reconciled`；模板徽标：`queued && reconciled` ⇒「未接住」，`queued` ⇒「排队中」。
- 测试：queueBubbleSync/store 纯函数级——三事件幂等、与 pi_message_end 不双插、终态不被后续事件误翻。

### Task 7：取证脚本固化
- `scripts/verify-queue-context.ts`：移植 `/tmp/verify-queue-context*.{js,sh}` 判据（POS 4 条全链路 / NEG 随机 UUID 全 0 / 变异注入假 entryId 仍 NEG / `"kind":"entry","id":"X"` 收紧锚点防 queue_update 伪锚点）；`--reconcile` 模式：对 `queued=true && consumedAt=null` 行逐条扫 transcript 判 consumed/stuck 并回填（consumed ⇒ consumedAt+queued=false；stuck ⇒ reconciled=true）。
- 运行环境说明（README 注释）：operator 机器经 ssh/kubectl 访问 CVM DB 与 pi-runtime pod sessions；判据与 §2.2 一致。

### Task 8：本地验证门
- `env -u NODE_OPTIONS` + nvm node24；受影响 vitest（messages/steer-persist/pi-runtime/bus/queueBubbleSync/AgentSideRail 相关）`--maxWorkers=1 --no-file-parallelism`；`vue-tsc -b`；`npx tsc --noEmit`（server 侧）；干净快照内跑，禁主仓脏树。

### Task 9：PR + CI + 合并
- 干净 master tarball 快照内实现（软链主仓 node_modules）；gh api REST 推分支：逐路径裸 blob sha（`sha1("blob %d\0"+data)`）比对 master，只推改动路径 base_tree；推后 `git/trees?recursive=1` 核对 DELTA 恰为改动路径 + ALL_PARALLEL_KEPT。
- PR CI 全绿（Build monorepo / Verify spec figures / Build API Docker image）后停合并前，等授权 → squash merge → 核对合并树内改动文件 blob 与已验证 head 一致。

### Task 10：部署 + 生产复测
- deploy.yml 生产发布（server+web 双侧）；502 窗恢复 + `/api/health` 200。
- 生产跑 `--reconcile`：52 条回填 consumedAt、13 条标 stuck（1 条 NO_DIR 显式解释）；此后新插话观察 queued→consumed 全链路（AC1/AC2/AC7）；AC3 脚本三组全绿；AC4/AC5/AC6 由测试 + 代码路径覆盖证明。
- 复测锚点：不用 chunk hash（纪律）；用 `/api/health` + 新事件帧在 /runs/events 实测 + DB 权威值。

## 已知缺口（诚实边界，v2 候选）
- **零观察者窗口**：followUp 在收尾边界被消费时若无任何 SSE 订阅者（用户已关页面），consumed 观察缺失 ⇒ 行停留「待接住」。下次该 thread 任意流建立时主流不重放 buffer（live:true），历史 GET 也无从判定 ⇒ 需要 pi-runtime 侧「utterance-state 查询端点」（v2）。v1 由 `--reconcile` 脚本兜底（operator 手动/定期跑）。
- 真·多端实时 AC1 的物理双端走查需真机 + 鉴权会话，本环境以「/runs/events 实测帧 + 旁听端代码路径」证明，不宣称真机验收完成。
