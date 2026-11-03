# 多端同会话一致性 · P0+P1 实现计划（修正版 v2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让同一账号跨设备（WEB/移动端）、跨角色（发起端/旁观端）看到的 SSE 流在「移动网络抖动」下不再误判失败、且两端事件一致；为后续 P2–P4（durable 后端 / 投影重建 / 插话落库）奠定统一传输基座。

**Architecture:** 把「主流（自己发消息）」从 `POST /chat/conversation` 的响应体流，改成与「旁观流」共用同一条 `GET /runs/events` 权威通道（带 `id:` 帧 + `lastEventId` 游标续传）。`POST` 仅负责触发 run 并返回 `{threadId, sinceSeq}` ack。前端断流时先进入「对账中」暂态、调服务端真相对账，主推「继续/恢复」而非「重试」——根治 2026-11-01 红车断线误报+双图根因。

**Tech Stack:** NestJS (controller/service, SSE `text/event-stream`)、Vue 3 (`AgentSideRail.vue` + `follow-up-tail.ts` + `streamRecovery.ts` + `networkFault.ts`)、pi-runtime client (`runEventStream`)、Vitest、node24（nvm）。

**Spec:** `docs/superpowers/specs/2026-10-21-multi-device-consistency-design.md`（2026-11-04 修订版）

**执行状态（2026-11-04 Native，两次交付）**：P0（Task 1–3）经 PR #704 squash 合并（master `c7a3a80e`）；P1（Task 4–7）branch `feat/stream-consistency-p1` 提交 4285a8d7→bac54d8a。Task 7 集成测试实证并修复 P0 probe 缺陷（终态名单 vs 真实 UiEvent 产物错配 + 首帧即返回 ⇒ 完结回合恒误判 active）。关键设计落地：ack.sinceSeq=触发时刻 lane head（取锚先于 drain）；headSeq 不对称取舍（404⇒0 / 未知错误⇒省略防历史重放污染）；fork 合成事件不进 lane ⇒ ack 携带新线程 id，失败 accepted:false；前端 Content-Type 分派（不猜服务端 flag）+ setLastSeq 绝对游标 + onEvent 排他全量分派。Task 8（canary 上线）待用户单独授权。

**计划整合声明（2026-11-04 自审）**：本计划**吸收并取代** `docs/superpowers/plans/2026-11-01-red-car-disconnect-misreport-duplicate-rootfix.md` 的 T0+T1+T3 批次作为 P0+P1 执行基线；该计划的 T2（意图幂等）/T4（resume）/T5（durable）分别对应后续 P3/P4/P2 包，其文档保留作为那三包的输入，不再单独执行。

## 已落地事实（自审核实，执行时不得重做）

| 事实 | 证据 |
|---|---|
| 规格观测面 Task 4/5 **已落地**：`GET /runs/events` 已发 `id: ${seq}`、`lastEventId` 已透传、前端游标+退避+409 处理已存在 | `agent.controller.ts:666-680`、`follow-up-tail.ts:267-354`、`streamRecovery.ts`+`networkFault.ts`（含测试）已存在 |
| `streamConversation(sessionId, userMessage, ...)` 首事件**可能是 `thread_forked`**（③ 重跑场景），不保证首个就带 runId | `agent.service.ts:338-420` |
| `getThreadState`/`getThreadTimeline` 是**已退役 stub，恒返回 `Promise<null>`**（LangGraph 退役）——**不得**作为对账真相源 | `agent.service.ts:1090-1095` |
| nginx 配置真实路径是 **`deploy/nginx.conf`**（非 spec §9 写的 `deploy/nginx/lnkpi.conf`，spec 已同步修正） | `grep -rln proxy_read_timeout deploy` 唯一命中 |
| `IdempotencyRecord` 表已存在，键 `ik_{threadId}_{Date.now()}_{随机4位}`，`registerIdempotencyKey` 在 `streamConversation` 入口调用 | `agent.service.ts:348-350`、rootfix 设计 §4-P4 |
| 主流与旁观流读**同一份 pi-runtime lane buffer**（BUFFER_LIMIT=500，不传 `lastEventId`=全量重放、`from=now`=只收未来） | `agent.service.ts:665-676` 注释 |

## Global Constraints

- 分支约定：feature 分支 + PR + **squash merge**；**在新 worktree 开发**（主检出被并行会话占用、38 脏文件，一律不碰），基线 = `origin/master`（`7a53963f`）。
- 测试纪律：vitest 用 nvm node24 + `--maxWorkers=1 --no-file-parallelism`，分批 ≤12 文件；改前端组件后必跑 `vue-tsc -b`。
- `STREAM_MAIN_FROM_PIRUNTIME` 灰度开关：**默认 off**；off 路径行为逐字节不变（兼容回滚）。
- `agentMessage` schema 本次**不动**；不触碰 `prisma/schema.prisma`、`agent-canvas-tools.service.ts`（P2 包处理，接缝已于规格 §7.1/§9 闭合）。
- 帧解析：主流改造后必须复用既有 `extractSseFrames`/`parseSseFrameSeq`（`observer-stream.ts`），禁止第二套 `split('\n')`。
- 终止语义：on 路径统一以事件 `turn_end` 收尾，不再产生/依赖 `data: [DONE]`。
- 前端改 `AgentSideRail.vue` 后必跑 `AgentSideRail.mobileMaskTabbar.test.ts`（五条守卫）。
- 多实例维持 `replicas=1`（事件 buffer 内存态，本期不做共享存储）。

## Review Focus

1. **flag off 回归**：off 时主流仍走 POST 响应体流 + `[DONE]`，行为不可变 ⇒ Task 4 双分支测试。
2. **断流误报**：on 路径下网络中断后**不得**立即标红，须先「对账中」⇒ Task 3。
3. **首连漏窗（M3）**：POST 触发 run 与前端订阅之间的事件**不丢**——pi-runtime lane buffer 已缓冲，前端用 ack 返回的 `sinceSeq` 订阅即可从断点续放 ⇒ Task 4/5 测试「ack 后订阅无漏事件、无重复」。
4. **reconcile 误判 missing**：run 实际 active 却返回 missing ⇒ 误杀轮次 ⇒ Task 2（用 IdempotencyRecord/GenerationRecord + 流探测双源，不依赖退役 stub）。
5. **后台 drain 不落库**：ack 提前返回后，drain 循环必须完整消费 generator（保留 `finalizeTurn` 等副作用）⇒ Task 4 测试「ack 后回合最终落库」。

---

### Task 1 (P0, config): nginx 读超时 300s→1800s

**Files:**
- Modify: `deploy/nginx.conf`（定位 `proxy_read_timeout`）

**Interfaces:** 产出：更宽松代理超时，降低误断触发率（规格 Task 1）。

- [x] **Step 1: 确认现值并修改**：`deploy/nginx.conf` 中 `proxy_read_timeout 300s;` → `1800s;`（注释注明「长任务 SSE 不被掐断，多端一致性 P0」）。
- [x] **Step 2: 语法校验**：`nginx -t -c $(pwd)/deploy/nginx.conf` 或 CI 校验。
- [x] **Step 3: Commit**：`git add deploy/nginx.conf && git commit -m "chore(nginx): proxy_read_timeout 300s->1800s for long SSE runs (P0)"`

### Task 2 (P0, backend): reconcile 对账接口

**Files:**
- Create: `apps/server/src/agent/turn-reconciliation.controller.ts`
- Modify: `apps/server/src/agent/agent.service.ts`（新增 `reconcileLatestAssistant(threadId, sinceSeq)`）
- Test: `apps/server/src/agent/turn-reconciliation.spec.ts`

**Interfaces:**
- Produces: `GET /api/agent/chat/reconcile?threadId=T&sinceSeq=N` →
  ```ts
  type ReconcileResult = {
    outcome: 'active' | 'settled' | 'missing'
    lastSeq: number
    evidence?: { idempotencyStatus?: string; generationStatus?: string }
  }
  ```

**真相源设计（⭐ 不依赖退役 stub）**——三源裁决，任一命中即定：
1. **流探测**：`runEventStream(threadId, { lastEventId: String(sinceSeq) })` 带 5s 超时探测——能立刻续到事件 ⇒ 会话活跃（结合事件内容含 `turn_end` 与否判 active/settled）。
2. **IdempotencyRecord**：查同 threadId 近窗（如 30min）记录——`in-progress` ⇒ `active`；`completed` ⇒ `settled`。
3. **GenerationRecord**：查同 thread 最近记录——`generating` ⇒ `active`；`completed/failed` ⇒ `settled`。
4. 三源全空 ⇒ `missing`。

- [x] **Step 1: 写失败测试**（stub 注入三个源，覆盖 active/settled/missing + 探测超时降级）
- [x] **Step 2: `cd apps/server && npx vitest run turn-reconciliation.spec.ts` 确认 FAIL**
- [x] **Step 3: 实现 `reconcileLatestAssistant`（三源裁决 + 5s 探测超时）+ controller 注册到 `agent.module.ts`**
- [x] **Step 4: 测试 PASS → Commit** `feat(agent): reconcile endpoint for verify-before-fail (P0)`

### Task 3 (P0, frontend): verify-before-fail 状态机 + UX 翻转

**Files:**
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（主流 catch 逻辑，rootfix 计划所指 `catch@2705` 一带）
- Modify: `apps/web/src/components/agent/networkFault.ts`（`classifyRequestError` 增加「对账中」中性态）
- Modify: `apps/web/src/components/agent/streamRecovery.ts`（新增 `deriveObserverFromSeq(seq)`：有 seq→`lastEventId`，无→`from=now`）
- Test: `AgentSideRail.reconcile.test.ts`（新建）+ 扩展 `networkFault.test.ts`/`streamRecovery.test.ts`

**Interfaces:**
- Consumes: Task 2 reconcile；`follow-up-tail.ts` 订阅（用 `deriveObserverFromSeq` 结果续接）
- Produces: 断流后 `reconciling` 暂态 → resume（旁观流按游标续）或 `failed`（仅 missing）；UX 主按钮「继续/恢复」，次选「重新发送」

- [x] **Step 1: 写失败测试**（断流→reconciling→active→resume / missing→failed / Abort 不触发对账）
- [x] **Step 2: `cd apps/web && npx vitest run AgentSideRail.reconcile.test.ts networkFault.test.ts streamRecovery.test.ts` 确认 FAIL**
- [x] **Step 3: 实现状态机 + 中性态 + `deriveObserverFromSeq` 纯函数**
- [x] **Step 4: 测试 PASS + `AgentSideRail.mobileMaskTabbar.test.ts` PASS + `npx vue-tsc -b` 0 error**
- [x] **Step 5: Commit** `feat(web): verify-before-fail + UX flip on stream disconnect (P0)`

### Task 4 (P1, backend + flag): POST 仅回 ack，run 后台执行

**Files:**
- Modify: `apps/server/src/agent/agent.controller.ts`（`@Post('chat/conversation')` `:728` 顶部加 flag 分支）
- Modify: `apps/server/src/agent/agent.service.ts`（新增 `startConversationRun(...)`：以与 `streamConversation` **完全相同的位置参数**调用它，后台 drain，ack 返回 `threadId + sinceSeq`）
- Test: `agent.controller.conversation-flag.spec.ts`

**Interfaces:**
- Produces: flag on 时响应 `200 JSON`：
  ```ts
  type ConversationAck = {
    accepted: true
    threadId: string        // ③ 重跑 fork 场景下为 fork 后的新线程 id
    sinceSeq: number        // 订阅游标锚点：触发时刻会话事件头 seq
    forkedThreadId?: string // 仅 fork 场景
  }
  ```
  说明：`mode` 三态归属规格 Task 6（P3 包）；本切片 ack 恒为新 run（steer/followup 仍走既有独立端点）。`runId` 不入 ack——订阅是 threadId 级，前端无需 runId。

**实现要点**：
- `startConversationRun` 以**末尾追加参数**方式调用既有 `streamConversation`（⛔ 禁止中段插参——~40 处按位置调用的测试会静默错值，spec §11 风险）。
- 后台 drain：`void (async () => { try { for await (const ev of gen) { if (typeof ev?.seq === 'number') sinceSeq = ev.seq; /* 保留全部既有副作用 */ } } catch (e) { /* 记日志，不影响 ack */ } })()`——`for await` 立即开始执行 ⇒ `client.prompt()` 被触发（Review Focus 5）。
- `sinceSeq` 初始值：drain 捕获的首个带 seq 事件；ack 需在首个事件前返回——用触发时刻的「当前会话头 seq」：向 pi-runtime 发 `GET /sessions/:key/events?lastEventId=0` 只取最新 seq（或 pi-runtime 已有 head seq 端点，实现时核实，无则用探测首帧 seq-1，最差退化为 `0`=全量重放+前端按 `thread_forked`/`turn_started` 边界去重）。
- flag off：原 `:748` 起流式分支一字不改。

- [x] **Step 1: 写失败测试**（off：SSE+`[DONE]`；on：JSON ack + 后台 run 跑完落 lane buffer + 副作用保留）
- [x] **Step 2: `cd apps/server && npx vitest run agent.controller.conversation-flag.spec.ts` 确认 FAIL**
- [x] **Step 3: 实现 flag 分支 + `startConversationRun`**
- [x] **Step 4: 测试 PASS（双分支）→ Commit** `feat(agent): POST /conversation returns ack, run drains server-side (P1, flag-gated)`

### Task 5 (P1, frontend + flag): 主流改走 GET /runs/events

**Files:**
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（`sendMessage` flag on 分支）
- Modify: `apps/web/src/components/agent/follow-up-tail.ts`（`createFollowUpTailListener` 支持显式 `startSeq`（默认仍 `from=now` 语义不变——旁观首连行为不动）；**移除「本端 isStreaming 时跳过订阅」的分支**（现 `:2771`/`:3039` 一带）——主流已并入本通道，跳过逻辑反成漏窗）
- Test: `follow-up-tail.main.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `ConversationAck`（`threadId`/`sinceSeq`）
- Produces: 主流 ack 后以 `sinceSeq` 为游标开订阅，事件经同一 `applyTextDelta/applyCanvasAction/applyTurnEnd` 落 store；终止 = `turn_end`

- [x] **Step 1: 写失败测试**（ack→按 sinceSeq 订阅→帧含 `id:` 被解析→事件进 reducer；off 分支不受影响）
- [x] **Step 2: 确认 FAIL → 实现 → PASS**
- [x] **Step 3: `AgentSideRail.mobileMaskTabbar.test.ts` + `vue-tsc -b` 全绿**
- [x] **Step 4: Commit** `feat(web): main turn consumes GET /runs/events via shared listener (P1, flag-gated)`

### Task 6 (P1, frontend): 终止语义统一 + 回归收口

**Files:**
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（on 路径终止判 `turn_end`，移除 `[DONE]` 依赖——off 路径保留）
- Test: 扩展 `follow-up-tail.main.test.ts`

说明：退避与游标续传**已存在**（`follow-up-tail.ts:267-354`），本任务不重写，只做终止语义对齐 + 断言 on 路径无 `[DONE]`。

- [x] **Step 1: 失败测试（on 路径 `turn_end` 结束且无 `[DONE]` 处理）→ 实现 → PASS → Commit** `feat(web): unify end-of-stream to turn_end (P1)`

### Task 7 (integration): 双端一致性 + 变异测试

**Files:**
- Create: `apps/server/test/integration/multi-device-stream.consistency.spec.ts`

**验收（规格 §10）**：
1. A 发起（flag on），B 全程订阅 `GET /runs/events`——B 与 A 事件序列**逐条相同**（type+data 比对）。
2. A 发起后 5s 强断 A 连接——回合完整落 lane buffer，`reconcile` 非 `missing`，B 补齐。
3. 变异：去 `id:` 帧 ⇒ 续传红；去 jitter ⇒ 退避红；on 路径出现 `[DONE]` ⇒ 红。

- [x] **Step 1: 写集成测试 → 跑 PASS → Commit** `test: multi-device stream consistency + mutation guards (P0+P1)`

### Task 8 (deploy gate): Canary 上线 + 行为级复测

**流程闸门**（无新文件）：
1. CI 全绿 → squash merge（⭐ 本仓 git https 被代理挡死：push 走 api.github.com REST Git Data API，blob sha 与本地 `git hash-object` 逐项核对）。
2. 部署到 CVM（`root@119.29.173.89`，容器 `lnkpi-api` 宿主 5100→容器 3001；重启窗 ~30s 502 正常）。
3. **canary**：白名单账号 `STREAM_MAIN_FROM_PIRUNTIME=on`；行为复测：① 拔主 POST 流仅靠旁观流，回合完整无重复；② 误报失败卡消失、3s 内借旁观流拿 `done`；③ PC 发/手机旁观 ≤1s pending。
4. PASS ⇒ 全量；FAIL ⇒ `off` 回滚（行为回归今日）。
5. ⛔ **本步骤需用户单独授权后才执行**（生产纪律）。

---

## 自我审查记录（2026-11-04 v2，执行前修正）

1. **spec 覆盖**：P0 = T1(nginx)+T2(reconcile)+T3(verify-before-fail+UX)；P1 = T4(ack)+T5(统一通道)+T6(终止语义)；验收 = T7；上线 = T8。规格 Task 4/5 已落地（见「已落地事实」表），不重做。Task 2/3/6/7/8/9（落库解耦/schema/ACK 三态/插话/投影重建）属 P2–P4 后续包。✅
2. **v1 错误修正**：① nginx 路径 `deploy/nginx/lnkpi.conf`→`deploy/nginx.conf`；② reconcile 真相源弃用退役 stub `getThreadState`/`getThreadTimeline`，改 IdempotencyRecord+GenerationRecord+流探测三源；③ ack 设计弃用「首事件取 runId」（fork 场景首事件是 `thread_forked`），改 `threadId+sinceSeq` 锚点；④ 补「主流 isStreaming 时跳过订阅」须随 T5 移除。✅
3. **占位符扫描**：`sinceSeq` 获取方式标注「实现时核实 pi-runtime head seq 端点」属已知未知+退化路径明确，非占位。✅
4. **类型一致性**：`ConversationAck`/`ReconcileResult`/`deriveObserverFromSeq` 各任务签名一致。✅

## 后续计划（不在本包）

- **P2**：上游 `session-backends`（sqlite-node/JsonlSessionRepo）替换 `sessions:Map`+TTL（治 D6；rootfix T5）。
- **P3**：意图级幂等 `threadId+归一化意图+近窗`（治 D5；rootfix T2）+ ACK mode 三态（规格 Task 6）。
- **P4**：`finalizeTurn` 落库与连接解耦（治 D2；rootfix T4 resume）+ `agentMessage` schema `seq/clientId/queued`（含 E1 接缝 `agent-canvas-tools.service.ts:3365` 补 `seq`）。
