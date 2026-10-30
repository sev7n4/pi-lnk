# 会话历史与多端一致性域审视：从「刷新后对话白屏」到恢复协议的系统性治本

> 2026-10-28 · 讨论文档（方向/决策来源）。姊妹篇：
> [`2026-10-28-canvas-agent-architecture-review-discussion.md`](./2026-10-28-canvas-agent-architecture-review-discussion.md)
> 以「移动端连线不可见」为第一只金丝雀审视了**画布状态同步域**；本文以同日第二只金丝雀
> ——画布 `cmvryhipi00wxnx01hczzkf92`「刷新/切出后对话记录看不到」（18:18 用户报障）——
> 审视**会话历史持久化 → 多端恢复 → 渲染**域。两文共用方法论：生产取证 → 上游能力对照
> → 行业对标 → 分阶段治本，不另起炉灶。
>
> 取证基线：生产 DB / nginx access log / 部署产物直查（119.29.173.89）+
> origin/master 源码实读 + Explore 全链路侦察（31 项缺陷带 文件:行号）+
> Codex / Claude Code 公开工程实践（2026-10 检索核实）。

---

## 0. 结论速览（TL;DR）

1. **「记录看不到」在生产上有两个独立成因，304 只是其一。** 成因一：`ETag` 无 `Cache-Control` 的 304 空体陷阱（当日已修，前端 4 处 `no-store`）。成因二（**未修，规模更大**）：多端统一线程 Phase 1 已上线（最后一条 legacy 随机线程停在 10-26 21:32），但 **J5 部署门禁被违约——归并 backfill 从未执行**：生产库 243 条线程中 **223 条是孤儿线程（id≠sessionId），承载 10,795 条消息、波及 193 个会话**；Phase 1 前端只认共享线程，这批历史在 UI 里「列表可见、点击无效」（§1.2/§1.3）。
2. **304 类缺陷的治本点在服务端不在前端**：Express 对全部动态 GET 默认打 ETag、无全局 Cache-Control 收口，前端逐点补 `no-store` 已累计 **7 处**（含 3 次生产事故）——下一个忘带的调用点必然复发。一行拦截器消灭整个类（§4 H0-a）。
3. **本域的自建机制几乎都处于「半接线」状态**：`AgentMessage.seq` 有列无读写、`clientId` 有唯一索引语义无写入方、`thread-state` 端点恒返 null 仍被前端 3 处调用、`resolveBootstrapThreadId` 的 cachedThreadId/threads 是死参数、localStorage fork key 跨设备发散且仅 owner 可见 fork 通知。上游 pi 的 Branch tip / SessionRepo 单调 seq / snapshot 投影本可承载同一语义且更持久（§3）。
4. **行业可抄的作业很具体**：Codex 的「rollout JSONL = SSOT，索引 = 可重建缓存，分歧时日志赢，resume 必须有回退扫描」；Claude Code 的「加载历史时对畸形消息 sanitize 防崩溃」「对话生命周期独立于上下文窗口」；两者共同点 = **恢复是协议（resume/replay/游标），不是「刷新后全量重拉 + 事后对账」**（§5）。
5. **治本顺序：H0 停血（服务端缓存收口 + legacy 归并 + 失败可见）→ H1 补齐读协议（分页游标 + count 端点 + 死端点处置）→ H2 服务端权威活跃叶子（ADR-0015 Phase 2 本体）→ H3 持久 seq 游标收编自建轮询/续传**（§4）。H0 全部是小时级改动；H2 就是 ADR-0015 Phase 2 已承诺项，本文为其补充取证与优先级论据，不新立规格。

---

## 1. 金丝雀取证（生产直查，2026-10-28）

### 1.1 成因一：304 空体（当日已修，登记归因）

`chat/threads` / `chat/user/messages` 等动态 GET 带 `ETag`、无 `Cache-Control` ⇒ 浏览器条件重校验 ⇒ 304 空体 ⇒ `loadHistory`（`agent.clear()` 已先执行）`res.ok=false`/`json()` 抛错 ⇒ 告警 toast 后 return ⇒ 白屏。nginx access log 实锤：报障同一时刻（18:18:02-05）三连刷新全 304；「发条新消息又能看到」＝内容变 ⇒ ETag 变 ⇒ 回 200。
当日修复：前端 4 处 fetch 加 `cache:'no-store'`（`AgentSideRail.vue`）+ 契约测试 `AgentSideRail.historyFetchNoStore.test.ts`。**但这是前端逐点补丁的第 7/8 处**，系统性根因在服务端（§2 R1 / §4 H0-a）。

### 1.2 成因二：legacy 孤儿线程（未修，生产实测）

```sql
-- /var/lib/docker/volumes/lnkpi_lnkpi-data/_data/lnkpi.db
total_threads            = 243
orphan_threads(id!=sid)  = 223          -- 92%
orphan_thread_messages   = 10,795
distinct_orphan_sessions = 193
first_shared_thread      = 2026-08-22   -- 少量历史同形
last_orphan_thread       = 2026-10-26 21:32:50   -- Phase 1 前端上线时点
```

`scripts/` 下**不存在**任何线程归并工具（仅 repair-duplicate-turns / clean-message-content / backfill-memory-scope）；prisma migrations 无 `*_unify_legacy_thread_messages`。

### 1.3 违约证据：J5 门禁原文 vs 现状

`docs/superpowers/specs/2026-10-26-unified-single-conversation-design.md`：

- §4.1 J5（:60）：**「未跑 backfill 不得部署 Phase 1 之后的 bootstrap 收敛逻辑到生产」**；
- §7 T1（:110）：归并落点 `apps/server/prisma/migrations/<时间戳>_unify_legacy_thread_messages/migration.sql`，幂等判据 `(threadId, runId, seq/clientId)`；
- §10.3 S4（:163）：「backfill 后老用户打开项目看到原历史」。

现状：迁移文件不存在，Phase 1（bootstrap 收敛）已在生产（部署产物含 `lnkpi:agentThreadFork`，`/opt/lnkpi/web/dist` 10-28 18:07 构建）。**门禁违约，1.2 的 10,795 条消息是直接后果。**

### 1.4 孤儿的 UI 形态（比「看不到」更糟）

`selectThread`（`AgentSideRail.vue:1630-1637`）对 `threadId !== sessionId` 直接关面板 return——历史面板照常渲染 legacy 线程为可点击行，点击却静默无效，无「已归档/即将归并」标记。用户看到自己的旧对话列表、点了没反应：**这是当前 193 个会话的日常体验**。

---

## 2. 域内根因（六条）

> 缺陷全量清单（31 项，D1-D31，带 文件:行号 与置信度）见附录 A；此处按结构归因。

| # | 根因 | 实锤 |
|---|---|---|
| R1 | **服务端 HTTP 缓存面无收口**：main.ts 无全局 Cache-Control，ETag 默认全开；修复以「前端逐点 no-store」推进，已 7+ 处、3 次事故 | D27；§1.1 |
| R2 | **线程身份 = 客户端派生而非服务端权威**：bootstrap 收敛到 `threadId==sessionId` 是确定式改进，但「活跃线程到底是谁」仍靠 localStorage fork key（仅 owner 写入、仅本端可读、失败即清）；`thread_forked` 是 owner 主流合成事件，观察端收不到 ⇒ 多端活跃叶子分叉 | D3/D4/D5/D7 |
| R3 | **数据迁移未走 expand→migrate→contract 纪律**：读端收敛（contract）先于数据归并（migrate），且无回退面 | §1.2/§1.3 |
| R4 | **游标/seq 基础设施缺失 ⇒ 恢复 = 全量拉取 + 轮询**：`AgentMessage.seq` 死列、`clientId` 无写入方、getMessages 无分页（take 100 截断头部）、superseded 过滤在 take 之后、恢复轮询以全量消息查询为心跳、SSE Last-Event-ID 绑定易失 lane 的 seq 空间 | D9/D10/D11/D13/D22/D23 |
| R5 | **恢复失败对用户不可见/不可动作**：loadHistory 失败只 toast 无重试；fetchThreads 失败与「真空态」同形；`__new_task__` 过滤清单前后端双份且已漂移；metadata 损坏的回合与「本来就没有过程」不可区分；thread-state 恒 null ⇒ 恢复横幅恒说「上一轮尚未完成」 | D1/D2/D14/D15/D16/D20 |
| R6 | **双写对账的自愈自身有缺陷**：turnState 裸 update 非幂等（键错位时 P2025 静默丢弃）；自愈恒置 `failed:true`（正常完成的轮被定性为中断）；只检测「Nest 有 pi 无」单向分叉；auto-resume 幂等键含 `Date.now()` | D18/D19/D21 |

---

## 3. 上游 pi（v0.85.1）能力对照：自建件 vs 上游原生

> vendor 实读结论（Explore 侦察交叉核实）。判据延续姊妹篇 §3：**每个自建件问一句「上游是否已提供更持久的能力」**。

| 本项目自建件 | 状态 | 上游原生对应 | 差距实质 |
|---|---|---|---|
| localStorage fork key（`lnkpi:agentThreadFork:`） | 半接线：owner 写、仅本端读、失败即清 | **Branch + branchTip**：同会话树内 `fork.ts`/`fork-policy.ts` 切分支，tip 即服务端权威活跃叶子 | 「③ 重跑」本可同会话内切 tip，会话身份永不漂移、多端天然一致；现走 `forkSession` 产出 newKey 新文件，才派生出 fork key/parentThreadId/活跃叶子派生整套自建指针（ADR-0015 Phase 2 T2/T4 正是在补这笔债） |
| `AgentMessage.seq` 死列 | 有列无读写 | **SessionRepo/`session-sequences.ts`**：单调 seq 持久分配 | 分页游标、SSE 续传、幂等去重的地基在数据层不存在，恢复退化为 `createdAt` 排序 + 全量拉取 |
| 恢复链路全量消息表 + 事后对账 | 三份状态 + turnState 第四份 + reconciliation | **snapshot（transcriptTail 带 seq/id/role）**：模型侧权威投影 | 前端恢复渲染从未消费 snapshot；对账自愈还有 R6 的写入缺陷 |
| Last-Event-ID 绑定 lane 内存 seq | lane TTL 30min/重建后错位 | **sqlite Storage 持久驻留** | 「另一端在跑」的实时性全架在易失层上，重放窗口外的丢帧靠 turn_end 兜底 |
| `thread-state` 端点 | 恒返 null 仍被调用 | （LangGraph 退役遗留） | 死端点该删则删、该填则填（turnState 已有数据可暴露），半死状态最易误导 |

**定性**：与姊妹篇 §3.3 同构——不是「错误」，是 vendor+pin 策略下的演进债；但 R4/R6 的每一环都是独立故障面，且本域的债已产生最大规模的生产后果（1.2）。

---

## 4. 治本路线图（H0 → H3）

> 原则：与姊妹篇 P0-P4 及 ADR-0015 Phase 2 合流，不另起炉灶。H0 全部小时级；H1 内小改；H2/H3 走既有规格。

### H0 · 停血（本周随发即走）

| 项 | 内容 | 依据 |
|---|---|---|
| H0-a | **服务端统一缓存收口**：Nest 全局拦截器对 `/api/*` 动态 GET 注入 `Cache-Control: no-store`（静态资源/明确可缓存的除外，白名单制）；前端已修的 8 处 `no-store` 保留为纵深防御 | R1/D27/D28；Codex「index 不得作为可恢复性前提」同构：**读路径的正确性不得依赖每个调用点都记得带对头** |
| H0-b | **legacy 线程归并 backfill**：按规格 T1 落 `migrations/<ts>_unify_legacy_thread_messages`（幂等键 `(threadId,runId,entryId)`，执行前备份，重跑消息数不变），补回 J5 门禁欠账。生产 223 线程/10,795 消息一次性归并到共享线程 | R3/§1.2/§1.3；**这是当前用户可见面最大的一项** |
| H0-c | **legacy 行禁用态**：归并上线前，历史面板对 `id!==sessionId` 行渲染「已归档，即将合并到主对话」禁用态，停止「点了没反应」 | §1.4/D6/D31 |
| H0-d | **loadHistory 失败重试入口**：失败态不再是 toast+空白，渲染「对话历史加载失败 · 重试」卡片（复用既有 REQUEST_FAILED 卡形态） | D1 |

### H1 · 补齐读协议（小改，各自独立可发）

| 项 | 内容 | 依据 |
|---|---|---|
| H1-a | **getMessages 分页游标**：契约加 `before(cursor)/limit`（`agentContract.ts` GetAgentMessagesQuerySchema 扩展），服务端按游标取页；前端「加载更早消息」。顺带把 superseded 过滤移入查询层（D13） | D9/D13/D29 |
| H1-b | **count 轻端点**：`GET /agent/chat/thread-count?sessionId&threadId`（或 threads 响应带 messageCount），替代 bootstrap 下载全量消息体计数；**且失败不得清 fork key**（fail-open 保留现场） | D3 |
| H1-c | **thread-state 死端点处置**：`getThreadState` 返回 `AgentThread.turnState`（数据已存在）或端点退役 + 前端 3 处调用删除。二选一，不许半死 | D20 |
| H1-d | **加载期 sanitize**（Claude 实践）：历史消息进入渲染前对畸形 metadata/空 assistant 行做统一净化与降级标注（「过程数据缺失」），恢复定位改按「最后一条**非空** assistant」 | D14/D15/D16/D17 |
| H1-e | `__new_task__` 等机器载荷清单收敛为 shared 单源，服务端落库前清洗（消灭双份漂移面） | D14 |

### H2 · 服务端权威活跃叶子（= ADR-0015 Phase 2 本体，补充优先级论据）

| 项 | 内容 | 依据 |
|---|---|---|
| H2-a | **activeLeaf 服务端指针**：AgentThread 表加活跃叶子（或复用 turnState 扩展），bootstrap 改读服务端；localStorage fork key 退役 | D4/D5；ADR-0015 T4 原文 |
| H2-b | **thread_forked 会话级广播**：合成事件进 runs/events 旁听流 + shared-subscription 白名单，设备 B 实时跟随 fork | D5/D25；ADR-0015 T3 |
| H2-c | **多对话 UI 退役收尾**：H0-b 归并完成后，历史面板/假新建（newAgentSession）按 ADR-0015 §10.1 退役，消灭 D6/D7 的过渡态残留 | D7/D31 |

### H3 · 持久 seq 游标（与姊妹篇 P2a 合流）

| 项 | 内容 | 依据 |
|---|---|---|
| H3-a | **seq 回填 + 收口**：`AgentMessage.seq` 落实写入（落库时分配单调值 + `@@unique([threadId,seq])`），SSE `id:` 行改绑持久 seq，lane 重建/重启后续传不再错位 | D10/D11/D23 |
| H3-b | **对账自愈修复**：turnState 写入改 upsert + 键源统一；自愈不再恒置 `failed:true`（按当轮真实终态）；评估反向分叉检测的必要性 | D18/D19/D21 |
| H3-c | 前端恢复轮询改游标增量（seq 就绪后），消灭「37 次全量查询」恢复会话 | D22 |

### 明确不做

- 不引入客户端缓存层（SWR/IndexedDB 会话镜像）——恢复正确性优先，镜像即第三个真相源；
- 不做双向实时对账广播（沿用「旁听 + 回合末对账」粒度，seq 就绪前不动）；
- 不为多对话恢复 UI（历史面板分页等）投入——ADR-0015 已裁定退役，只保 H0-c 的过渡态。

---

## 5. 行业对标：Codex / Claude Code / 上游 pi

| 实践 | 来源 | 对本项目的映射 | 对应项 |
|---|---|---|---|
| **SSOT 与索引分层，分歧时日志赢**：rollout JSONL 是唯一权威，SQLite 索引是可重建缓存；「index miss 必须回退扫描日志，不得把可恢复性押在索引新鲜度上」；启动时 `reconcile_rollout` 对账 | Codex（rollout/state_5.sqlite/App Server 架构，2026-10 检索核实） | 我们的等价物：AgentMessage 表（投影/索引）↔ pi transcript（SSOT）。**恢复路径不得依赖投影层健康**——304 事故（投影读失败 ⇒ 白屏）正是把索引当成了 SSOT | H0-a/H0-d；姊妹篇 P2b |
| **Surfaces = thin clients，线程生命周期归服务端**：CLI/Desktop/IDE/Web 连同一 App Server，`thread/start/resume/fork/list/read` 是协议方法，多客户端可同时订阅同一线程 | Codex cross-surface | 前端派生线程身份（localStorage fork key）是反方向；活跃叶子必须服务端权威 | H2-a/b |
| **fork 必须带 ancestry**：`forked_from` 让分支可追溯，「不许把 fork 当成又一条新会话」 | Codex fork 语义 | 我们 fork 后的 parentThreadId 是**计划项**（未落地）；当前 fork key 方案连跨端可见性都没有 | H2 |
| **加载期 sanitize 防崩溃**：resume 时对畸形历史消息（非 string 工具参数、损坏结构）拦截净化，而不是崩溃/静默丢 | Claude Code（malformed tool calls 修复；error boundaries） | D15/D16：metadata 损坏 ⇒ 静默降级且不可区分；应在加载边界统一净化 + 显式降级标注 | H1-d |
| **对话生命周期独立于上下文窗口**：transcript 持久、compaction 只回收活动视图；恢复 = 重放 transcript | Claude Code §9.1 | 我们把「对话历史」绑定在 take-100 的消息表上（D9），长对话头部永久丢失——违反同一条原则 | H1-a |
| **append-only + 单调游标**：JSONL 追加、行有序，一切分页/续传/去重以游标为准 | Codex/Claude 共同形态 | seq 死列（D10）使本域一切「增量」退化为全量 | H3-a |
| **迁移纪律 expand→migrate→contract**：先双写/双读，归并数据，再切读端；门禁化 | 行业通用（Codex resume 的 fallback 设计同理） | J5 违约 = contract 先于 migrate | H0-b |

---

## 6. 与既有规划的关系（不另起炉灶）

| 既有资产 | 本文关系 |
|---|---|
| ADR-0015 / 统一单会话规格（2026-10-26） | H2 = 其 Phase 2 本体（T2/T3/T4/T5），本文补充**违约取证与优先级论据**；H0-b = 其 T1 欠账补课 |
| 姊妹篇画布审视（P0-P4） | H3 与其 P2a（快照+游标）同点合流，实施时合并设计；R1 服务端收口与其 P0「可观测先行」互补（先止血后观测亦可并行） |
| SP-E CAS / PR #625 | 不相交（写并发域 vs 读恢复域） |
| #596 会话级订阅规格 | H2-b 是其「已知限制④」的解法延伸，同姊妹篇 §7 口径 |

## 7. 验收判据

1. **任意一次刷新/切回，历史要么完整呈现、要么呈现可重试的失败态**——不存在「toast+空白」（H0-d）；
2. **「恢复的正确性」不依赖任何单个调用点的自觉**：服务端缓存策略收口后，删掉前端任意一处 `no-store` 也不复发 304 类事故（H0-a）；
3. **193 个 legacy 会话的老用户打开项目能看到原历史**，归并脚本重跑消息数不变（H0-b，S4 原判据）;
4. **长对话不丢头部**：超过 100 条的会话可分页回溯（H1-a）；
5. **两台设备对「当前活跃对话」的答案恒一致**（H2，ADR-0015 Phase 2 判据）；
6. 恢复期无全量轮询心跳（H3-c），SSE 续传跨 lane 生命周期单调（H3-a）。

## 8. 证据置信度分级

| 级别 | 内容 | 实施前要求 |
|---|---|---|
| A（生产实测） | §1.1 access log/304、§1.2 SQL 计数、部署产物指纹、J5 门禁原文比对 | 可直接引用 |
| B（源码实读） | D1-D27/D29-D31 定位、上游 Branch/seq/snapshot 语义 | 可直接引用；行号会漂移，实施 spec 重新锚定 |
| C（grep 级） | D11（clientId 零写入）、D28（agent 域外 304 审计缺失）、seq「无读写路径」 | 立项前按 AGENTS.md grep 纪律复验 |
| D（推断级） | D23 的 lane 重建后错位的具体行为 | 实施前用 staging 复现确认 |

## 附录 A · 全量缺陷清单（D1-D31）

> 由全链路侦察产出，此处收录编号与一句话摘要（详证含 文件:行号 已在侦察底稿核过；实施 spec 时重新锚定行号）。
> 分组：**加载链路** D1 loadHistory 失败无重试重入｜D2 fetchThreads 失败与真空态同形｜D3 messageCountFor 全量下载计数且失败=清 fork key｜D4 resolveBootstrapThreadId 死参数｜D5 fork key 跨设备发散（thread_forked 仅 owner 可见）｜D6 legacy 线程「列表可见点击无效」｜D7 newAgentSession 假新建｜D8 无归并工具。
> **服务端接口** D9 getMessages take-100 截头无游标｜D10 seq 死列｜D11 clientId 无写入方｜D12 共享契约与真实载荷漂移｜D13 superseded 过滤在 take 后。
> **渲染契约** D14 `__new_task__` 过滤清单双份漂移｜D15 metadata 损坏静默降级｜D16 空 assistant 行干扰任务卡恢复定位｜D17 历史恢复只消费最后一回合。
> **turnState/自愈** D18 裸 update 键错位静默丢自愈｜D19 自愈单向且恒置 failed｜D20 thread-state 恒 null 死端点仍被消费｜D21 auto-resume 幂等键含 Date.now()｜D22 恢复轮询=全量查询心跳。
> **SSE/多端** D23 Last-Event-ID 绑易失 lane seq 空间｜D24 旁观端事件契约过窄丢 snapshot/error｜D25 shared-subscription 3 类白名单+200 条缓冲被洪峰挤爆｜D26 presence 单实例内存。
> **缓存面/纪律** D27 无全局 Cache-Control、逐点补丁已 7 处｜D28 agent 域外未做 304 审计｜D29 分页游标契约层缺失｜D30 J5 门禁违约（§1.3）｜D31 ADR 与 UI 现状矛盾且无过渡禁用态。
