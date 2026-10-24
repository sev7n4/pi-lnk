# 多端同会话一致性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让同一画布下任一客户端都能实时看到另一端发起的对话增量，且任何在 pi 侧执行完成的轮次都必定可查、并发发起的消息都有确定归属。

**Architecture:** 把「流」从 run 的附属物改为会话的附属物 —— 拆成执行面（单写者，POST 立即返回）、观测面（常驻 session SSE，带游标可续传）、投影面（服务端权威快照，客户端据此重建）、队列面（复用 vendor `lane` 的 steer/followup）。落库不再依赖 SSE 连接存活。

**Tech Stack:** NestJS（Express 手写 SSE）、Prisma + SQLite、`@earendil-works/pi-agent-core` vendor（`lane` / `HarnessEventBus`）、Vue 3 + Pinia

**Spec:** [`docs/superpowers/specs/2026-10-21-multi-device-consistency-design.md`](../specs/2026-10-21-multi-device-consistency-design.md) —— 实施者须先读完；spec 的 D1–D6 判据是本计划所有验收的总纲。

## Global Constraints

- **分支纪律**：每个 Task 一个分支，`feat/` `fix/` 前缀，走 PR + squash。⛔ 任何情况下不得直接向 master 提交。
- **参数位置纪律**：`streamFromPiRuntime` 与 `streamConversation` 的参数**一律追加在末尾**。⚠️ 中段插参会移位后续同型参数（都是 `string[]`）⇒ 错位是静默的。
- **不要重构既有 generator**：新增端点 + 灰度开关，不原地改 `streamConversation`（40+ 处位置调用）。
- **前端改 `AgentSideRail.vue` 后必跑** `AgentSideRail.mobileMaskTabbar.test.ts`（五条守卫，漏跑会静默破移动端贴底壳契约）。
- **每个改动的包都要跑自己的 tsc**：`cd <pkg> && ./node_modules/.bin/tsc --noEmit -p tsconfig.json`。⛔ 只跑下游包是本仓已犯过的错（#494 漏 `packages/agent`、#525 漏 `pi-runtime` 自身 strict）。
- **落库守卫不许用源码静态断言**（注释会命中 ⇒ 假红）。断言必须落在**可观测出口**（出网 body / DB 调用 / DOM testid / 组件状态）。
- **生产改动纪律**：改线上 DB 前 `cp` 备份 + `BEGIN IMMEDIATE` + `PRAGMA busy_timeout=5000` 短事务；上线判据 = 入口 chunk 变 + 旧 chunk 404。
- **合并 ≠ 上线**：`deploy.yml` 的 paths **不含 `services/**`** ⇒ 改了 `services/pi-runtime` 必须手搓 `runtime-deploy` workflow，且顺序先 runtime 后 web。

## Review Focus

spec 说了系统「应该怎样」，但没说全部。以下五条是 spec 的沉默处 —— 一个理性用户会认为必须成立，而 spec 没写。每个后面都指派给了拥有该代码的 task。

1. **用户 A 断网重连后，B 的对话流不应从头重放**（应从游标续传，否则刷屏且丢中间态）→ Task 5
2. **同一 `clientId` 重复提交两次，数据库里只能有一条消息**（否则重复气泡 + 重复计费）→ Task 9
3. **排队中的插话被模型消费后，历史里那条消息的 `queued` 必须转终态**（否则永远显示「排队中」）→ Task 8
4. **旁听端不订阅对话流却开着页面时，不应持续吃 CPU/带宽**（应按需订阅或明确惰性）→ Task 3
5. **`seq` 回填时同毫秒内的多条消息，顺序必须稳定可重放**（否则重复回填得到不同结果，对账永远有 diff）→ Task 7

---

## 批次 A · 止血（Task 1–3）

### Task 1: 复现长任务丢库根因（证据先行）

**为什么第一个做**：spec 的 P0-2 技术选型建立在「nginx 300s 掐断 ⇒ `finalizeTurn` 不可达」这个**未复现的假设**上。⛔ 若复现失败，改架构就是基于猜测。

**Files:**
- Test: `apps/server/src/agent/__tests__/longturn-persistence.e2e-spec.ts`（新建）
- Modify: 无（纯取证任务）

**Interfaces:**
- Consumes: 无
- Produces: 一份复现结论（写入本 task 的 PR 正文）。若复现成立，产出可复用的测试夹具 `runTurnAndAssertPersistence({ durationSec, breakConnectionAtSec })`，供 Task 2 的测试直接调用。

- [ ] **Step 1: 写复现测试（先让它红）**

在 `apps/server/src/agent/__tests__/` 下新建 e2e 测试，桩掉 `PiRuntimeClient` 使其产出可控时长的事件流：

```ts
// 长任务：产出 400s 的事件流，300s 处（模拟 nginx 掐断）调用 abort
it('长任务在连接被掐断后仍应落库（当前预期：红）', async () => {
  const fake = makeFakePiRuntime({ totalDurationSec: 400, runKind: 'completed' })
  // 300s 处模拟 nginx 掐断：让响应 write 抛错
  const res = makeFakeRes({ failAfterMs: 300_000 })

  await consumeWithAbort(agentService.streamConversation(SID, '测试消息', USER), res)

  const rows = await prisma.agentMessage.findMany({ where: { sessionId: SID } })
  const assistant = rows.find(r => r.role === 'assistant')
  expect(assistant, '长任务完成后历史里必须有助手消息').toBeDefined()
})
```

- [ ] **Step 2: 跑测试确认它红，且红的原因正是「缺 assistant 行」**

```bash
cd apps/server && ./node_modules/.bin/vitest run src/agent/__tests__/longturn-persistence.e2e-spec.ts --testTimeout=60000
```

⚠️ 若红的原因是别的（例如 import 错误、桩没生效），先修桩，别把「测试环境问题」误当复现成功。

- [ ] **Step 3: 用真实生产配置交叉验证因果链**

在生产机确认超时值与心跳间隔的关系：

```bash
ssh -i ~/.ssh/tencent_cloud_deploy root@119.29.173.89 "nginx -T 2>/dev/null | grep -A2 -B2 read_timeout"
```

预期看到 `proxy_read_timeout 300s`。若生产值已是别的数 ⇒ spec §11 的 R1 假设需修正，先更新 spec 再继续。

- [ ] **Step 4: 记录结论并落 PR**

- 若**复现成立**：PR 正文写明「618.6s run 零落库根因 = nginx 300s 掐断」，附测试红→绿的证据（Task 2 才让它绿）。
- 若**复现不成立**：⛔ **停下来**，在 PR 正文写清「假设被证伪」，并列出替代假设（候选：`streamEvents` 120s 重连预算耗尽 / pi-runtime buffer 溢出 409 / 客户端 `AbortController`）。spec 与后续 Task 2 的选型要重评。
- 若**无法复现**（如测试环境跑不出 300s）：降级为「补埋点 + 生产观测」——在 SSE `close` 时记录已运行时长与是否已 `finalizeTurn`，上线后等一个真实长任务。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent/__tests__/longturn-persistence.e2e-spec.ts
git commit -m "test(server): 复现长任务零落库（nginx 300s 掐断假设）"
```

---

### Task 2: 落库与请求生命周期解耦（D2）

**为什么**：只要落库还挂在「generator 正常收尾」上，任何连接中断都会永久丢一整轮。这与 nginx 无关，是结构问题。

**Files:**
- Modify: `apps/server/src/agent/agent.service.ts:1818-1860`（`if (turnRole === 'owner')` 的 `finalizeTurn` 调用块）
- Test: `apps/server/src/agent/__tests__/turn-settle-detached.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `runTurnAndAssertPersistence` 夹具
- Produces: `private scheduleTurnSettle(ctx: TurnSettleContext): void` —— 把落库变成 fire-and-forget 的后台任务，请求断连不影响它。

- [ ] **Step 1: 写失败测试**

```ts
it('请求被掐断后，settle 仍会执行（预期红：当前挂在 generator 收尾上）', async () => {
  const settleSpy = vi.spyOn(agentService as any, 'finalizeTurn')
  const res = makeFakeRes({ failAfterMs: 100 })

  await consumeWithAbort(agentService.streamConversation(SID, '长消息', USER), res)

  await vi.waitFor(() => expect(settleSpy).toHaveBeenCalled(), { timeout: 5000 })
})
```

- [ ] **Step 2: 确认红**

- [ ] **Step 3: 实现 `scheduleTurnSettle`**

把 `agent.service.ts` 中原本在 generator 尾部同步 `await this.finalizeTurn(...)` 的逻辑抽成方法，并让它脱离请求生命周期：

```ts
private scheduleTurnSettle(ctx: TurnSettleContext): void {
  // 落库不再依赖 SSE 连接存活：请求断连后本任务仍须跑完。
  // ⚠️ 错误只记日志不外抛 —— 它已无 HTTP 响应可回写。
  void this.finalizeTurn(ctx.sessionId, ctx.threadId, ctx.userId, ctx.assistantText,
    ctx.canvasActions, ctx.opts)
    .catch((err) => this.piLogger.warn(`turn settle failed: ${err instanceof Error ? err.message : String(err)}`))
}
```

调用点仍在原位置，但**不 `await`**。⚠️ `finalizeTurn` 内的 `billingHold` 结算（`turn_settled`）当前与落库在同一段，拆分时**必须一起搬**，否则中断路径的计费 hold 会走 `finally` 全退（= 白扣又退回，等于没扣）。

- [ ] **Step 4: 变异测试（防空绿）**

把 `scheduleTurnSettle` 改回同步 `await`，确认 Step 1 的测试**变红**。记录变异实测结果到 PR 正文。

- [ ] **Step 5: 跑 agent.service 全家 + tsc**

```bash
cd apps/server && ./node_modules/.bin/vitest run src/agent/ --testTimeout=120000
cd apps/server && ./node_modules/.bin/tsc --noEmit -p tsconfig.json
```

⚠️ 改 `agent.service` 必跑其 test 全家（构造器实例化环是本仓事故家族，改构造器会 exit 0 静默死）。

- [ ] **Step 6: Commit**

---

### Task 3: 前端消息 id 去重与流可见性节流

**为什么先做这个**：它成本极低（改两行 + 一个纯函数），且是后续所有前端改动的基础设施 —— 没有稳定 id，投影重建与乐观插入都无从谈起。

**Files:**
- Modify: `apps/web/src/stores/agent.ts:193`、`:230`（`msg-${Date.now()}` → `crypto.randomUUID()`）
- Modify: `apps/web/src/components/agent/AgentSideRail.vue:3662` 附近（`:key` 保持 `msg.id`，无需改，但要确认无其他 `Date.now()` 派生 key）
- Test: `apps/web/src/stores/agent.messageIdentity.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `nextLocalMessageId(): string`（导出自 `stores/agent.ts`），Task 9 的 `clientId` 复用它。

- [ ] **Step 1: 写失败测试**

```ts
it('同一回合的 user 与 assistant 气泡 id 必须不同（预期红：现在都是 msg-同一毫秒）', () => {
  const store = useAgentStore()
  const a = nextLocalMessageId()
  const b = nextLocalMessageId()
  expect(a).not.toBe(b)
})
```

- [ ] **Step 2: 确认红**（当前 `Date.now()` 同一 tick 内两次调用必相同）

- [ ] **Step 3: 实现**

```ts
// crypto.randomUUID 在非安全上下文（http 局域网 IP）下可能不可用 ⇒ 兜底
export function nextLocalMessageId(): string {
  return typeof crypto?.randomUUID === 'function'
    ? `msg-${crypto.randomUUID()}`
    : `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
```

⚠️ 生产是 `http://119.29.173.89:8888`（非 HTTPS）⇒ `crypto.randomUUID` **在非安全上下文不可用**，兜底分支必须保留，且要有测试覆盖它。

- [ ] **Step 4: 跑移动端贴底壳守卫 + 相关测试**

```bash
cd apps/web && ./node_modules/.bin/vitest run src/components/agent/AgentSideRail.mobileMaskTabbar.test.ts src/stores/ --testTimeout=120000
```

- [ ] **Step 5: Commit**

---

## 批次 B · 结构（Task 4–9）

### Task 4: SSE 游标端到端贯通（D1 的传输基础）

**为什么**：pi-runtime **已经**在每帧发 `id: ${seq}`（`services/pi-runtime/src/app.ts:474`）、**已经**支持 `?lastEventId=` replay（`app.ts:48-55`），但 Nest 在 `agent.controller.ts:567` 只写 `data:` 帧把 `id` 丢了。本任务**不新造任何东西，只做透传**。

**Files:**
- Modify: `apps/server/src/agent/agent.service.ts:636-681`（`runEventStream`：让 yield 出的事件带 seq）
- Modify: `apps/server/src/agent/agent.controller.ts:541-580`（`runEvents`：写 `id:` 帧 + 接受 `lastEventId`）
- Modify: `apps/server/src/agent/pi-runtime/pi-runtime.client.ts`（透传游标）
- Test: `apps/server/src/agent/__tests__/event-stream-cursor.e2e-spec.ts`

**Interfaces:**
- Consumes: 无
- Produces: `AgentStreamEvent & { seq?: number }` —— seq 字段透传到 SSE `id:` 行。Task 5 的前端直接消费它。

- [ ] **Step 1: 写失败测试**

```ts
it('旁听流的每一帧都应带 id 行（预期红：现在只写 data 行）', async () => {
  const frames = await collectSseFrames(fakeRes(), agentService.runEventStream(KEY))
  expect(frames.length).toBeGreaterThan(0)
  for (const f of frames) expect(f.id, '每帧都要有 id 才能续传').toBeDefined()
})

it('带 lastEventId 重连时，服务端应转发该游标（预期红）', async () => {
  // 断言 pi-runtime 收到的 URL 含 lastEventId=N
})
```

- [ ] **Step 2: 确认红**

- [ ] **Step 3: 让 `runEventStream` 透出 seq**

⚠️ **关键约束**：`runEventStream` 当前把 `PiRuntimeEvent` 过 `mapPiEventToUiEvent(event)` 归一，**该函数会丢掉 `seq`**。解法二选一，**优先前者**：

```ts
// 方案 A（推荐）：归一后把原始 seq 挂回去
const ui = mapPiEventToUiEvent(event)
if (!ui) return
;(ui as AgentStreamEvent & { seq?: number }).seq = (event as { seq?: number }).seq
queue.push(ui as AgentStreamEvent)
```

⛔ 方案 B（改 `mapPiEventToUiEvent` 的签名让它透传 `seq`）会波及主对话链路的所有调用点，风险高，本期不用。

- [ ] **Step 4: controller 写 `id:` 行并接受游标**

```ts
// 接受 lastEventId
const lastEventId = typeof req.query.lastEventId === 'string' ? req.query.lastEventId : undefined
for await (const event of this.agentService.runEventStream(key, { lastEventId })) {
  const seq = (event as { seq?: number }).seq
  // ⚠️ seq 可能为 undefined（宿主侧合成事件）⇒ 无 seq 时不写 id 行，
  //    写了会让浏览器的 Last-Event-ID 指到一个不存在的 seq ⇒ 续传错位
  const idLine = seq === undefined ? '' : `id: ${seq}\n`
  res.write(`${idLine}data: ${JSON.stringify(event)}\n\n`)
  idleTimer.refresh()
}
```

⚠️ **`idleTimer` 30s 闸门的处置**：新客户端会常驻（可能几分钟无事件）⇒ 30s 断流会导致重连风暴。改为**仅在首帧前用 30s**（等不到事件就说明订阅没起来），之后靠心跳保活。

- [ ] **Step 5: 变异测试**

去掉 `id:` 行 ⇒ Step 1 的测试必须变红。

- [ ] **Step 6: 跑 server 全家 + tsc，Commit**

---

### Task 5: 前端游标续传 + 退避重连 + 可见性恢复

**Files:**
- Create: `apps/web/src/components/agent/backoff.ts`
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（旁听流消费处，现约 `:2449`）
- Test: `apps/web/src/components/agent/backoff.test.ts`、`AgentSideRail.observerStream.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `seq` 字段
- Produces: `backoffWithJitter(baseMs, capMs, attempt): number`（纯函数，Task 5 自测用）

- [ ] **Step 1: 写退避函数的失败测试**

```ts
it('退避必须带抖动（变异点：去掉随机项）', () => {
  const samples = Array.from({ length: 20 }, () => backoffWithJitter(250, 5000, 3))
  expect(new Set(samples).size, '20 次取样应有多值——无抖动会全是同一个数').toBeGreaterThan(1)
  for (const s of samples) expect(s).toBeGreaterThanOrEqual(250)
  expect(Math.max(...samples)).toBeLessThanOrEqual(5000 * 1.5)
})
```

- [ ] **Step 2: 实现退避并确认绿**

```ts
export function backoffWithJitter(baseMs: number, capMs: number, attempt: number): number {
  const exp = Math.min(baseMs * 2 ** attempt, capMs)
  // 全抖动（AWS 架构博客「Exponential Backoff and Jitter」）：
  // 取 [0.5, 1.5)×exp 而非 [0, exp)——后者在高并发重连时会把请求打在同一时刻
  return Math.floor(exp * (0.5 + Math.random()))
}
```

- [ ] **Step 3: 给旁听流接上游标**

维护 `lastSeenSeq: number | null`，重连时拼 `&lastEventId=${lastSeenSeq}`；收到帧后更新为该帧 `seq`。

⚠️ **`lastEventId` 为 `null` 时不能拼 `lastEventId=`（空值）** —— pi-runtime 的 `resolveEventsSubscribeMode` 用 `Number.isInteger(parsed)` 判定，`NaN` 会落进 `replay afterSeq=-1` 分支而意外全量重放。

- [ ] **Step 4: 加 `visibilitychange` 恢复**

```ts
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !unreachable.value) {
    // 页面冻结期间退避计时器可能已停摆 ⇒ 回来立即重连，不排队
    reconnectNow()
  }
})
```

- [ ] **Step 5: Review Focus #1 的测试**

> 用户 A 断网重连后，B 的对话流不应从头重放。

```ts
it('重连后只补增量，不重放已有事件（变异点：重连时不带 lastEventId）', async () => {
  // 收到 seq 100..110
  // 模拟断线 → 重连
  // 断言第二次连接收到的首个事件 seq > 110
})
```

- [ ] **Step 6: 跑守卫 + vue-tsc（后台，约 11 分钟）+ Commit**

```bash
cd apps/web && ./node_modules/.bin/vue-tsc --noEmit -p tsconfig.json   # 后台跑
cd apps/web && ./node_modules/.bin/vitest run src/components/agent/ --testTimeout=120000
```

---

### Task 6: 执行面改为 ACK 语义 + mode 三态（D4）

**Files:**
- Modify: `apps/server/src/agent/agent.controller.ts`（`POST chat/conversation` 响应形态）
- Modify: `apps/server/src/agent/agent.service.ts:1429-1480`（409 分支回传 mode）
- Test: `apps/server/src/agent/__tests__/conversation-ack.e2e-spec.ts`

**Interfaces:**
- Consumes: 无
- Produces: `ConversationAck = { runId, mode, reason?, messageId? }`

- [ ] **Step 1: 写失败测试（三态）**

```ts
it.each([
  ['空闲',        200, 'run'],
  ['忙碌+steer',  409, 'steer'],
  ['忙碌+队列满', 409, 'followup'],
])('%s 时应返回对应 mode', async (_label, status, expected) => {
  const ack = await postConversation()
  expect(ack.mode).toBe(expected)
})
```

- [ ] **Step 2: 确认红**

- [ ] **Step 3: 实现 ACK**

⚠️ **本期不改「流随请求」的形态** —— 那是 Task 3（P1-B）之后的大改。本 Task 只在现有响应里**额外回传 mode**（放在 SSE 流末尾的一个 `turn_ack` 事件里，与现有 `turn_not_submitted` 并存），让前端能对用户说清「已并入进行中的任务」。

**为什么不直接改短请求**：spec §11 已列 —— `streamConversation` 是 40+ 处位置调用的 generator，改成短请求需要同时重做主链路前端消费，风险远大于收益。**分两期：先让语义可见，再改传输形态。**

- [ ] **Step 4: 变异测试 + Commit**

---

### Task 7: 投影面 —— 消息级 seq + clientId + 分页 snapshot（D6）

**Files:**
- Modify: `apps/server/prisma/schema.prisma`（`AgentMessage` 加 `seq`/`clientId`/`queued`）
- Create: `apps/server/prisma/migrations/<ts>-add_message_seq/migration.sql`
- Create: `apps/server/src/agent/session-projection.controller.ts`
- Create: `apps/server/src/agent/session-projection.service.ts`
- Test: `apps/server/src/agent/__tests__/session-projection.e2e-spec.ts`

**Interfaces:**
- Consumes: 无
- Produces: `GET /api/agent/sessions/:threadId/snapshot?beforeSeq&limit` 返回 `SessionProjection`（spec §5.4）

- [ ] **Step 1: 迁移分五步走（⛔ 不可跳步）**

```sql
-- 步 1：加列，可空，无唯一索引。此时行为与今天完全一致
ALTER TABLE "AgentMessage" ADD COLUMN "seq" INTEGER;
ALTER TABLE "AgentMessage" ADD COLUMN "clientId" TEXT;
ALTER TABLE "AgentMessage" ADD COLUMN "queued" BOOLEAN NOT NULL DEFAULT false;
```

- [ ] **Step 2: 部署并观察一个迭代，确认存量 `seq` 全为 NULL 且无报错**

⚠️ 本仓已因「可空唯一键」付过代价：`runId` 可空 ⇒ SQLite 下 NULL 互不冲突 ⇒ 9443 条 assistant 里 **9368 条（99.2%）唯一索引形同虚设**。所以第 4 步的闸门是硬要求。

- [ ] **Step 3: 写 Review Focus #5 的测试（回填可重放）**

```ts
it('同毫秒内的消息按 id 兜底排序，回填两次结果一致（变异点：只用 createdAt 排序）', () => {
  const rows = [msg('b', T), msg('a', T)]   // 同一毫秒
  expect(computeSeqs(rows)).toEqual(computeSeqs([...rows].reverse()))
})
```

- [ ] **Step 4: 实现回填 + 加唯一索引**

```sql
-- 步 3：回填（按 createdAt, id 排序保证可重放）
UPDATE "AgentMessage" SET "seq" = (
  SELECT COUNT(*) + 1 FROM "AgentMessage" m2
  WHERE m2."threadId" = "AgentMessage"."threadId"
    AND (m2."createdAt" < "AgentMessage"."createdAt"
      OR (m2."createdAt" = "AgentMessage"."createdAt" AND m2."id" < "AgentMessage"."id"))
);
-- 步 4：⚠️ 先断言无 NULL，再加唯一索引
```

⛔ **步 5 的断言必须写进迁移脚本**：存在 `seq IS NULL` 时直接 `RAISE(ABORT)`，否则 SQLite 唯一索引会允许多行 NULL，静默失效。

- [ ] **Step 5: 实现 snapshot 端点**

⚠️ 投影**不要**直接用 `GET /sessions/:id/snapshot` 的 `transcriptTail`（裁剪到 16 条 / 文本 400 字，`session-manager.ts:2143-2153`）⇒ 会重现「历史只有 16 条」的老问题。**消息级投影直接查 `AgentMessage` 表**（它才是「人看到的」真相），pi 侧仅用于对账（Task 10）。

- [ ] **Step 6: tsc + 迁移幂等测试 + Commit**

---

### Task 8: 插话落库（D5）

**边界声明**：PR #534 已在 master 做了插话的**前端气泡层**（消费时补气泡 + 修 fork 切点被冲掉）。本 Task **不改 #534 的既有实现**，只补后端落库。

**Files:**
- Modify: `apps/server/src/agent/agent.service.ts`（`steerPiRun` 附近）
- Test: `apps/server/src/agent/__tests__/steer-persistence.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 7 的 `clientId` 列
- Produces: 插话消息的 `AgentMessage` 行（`role='user'`, `queued=true`, 带 `clientId`）

- [ ] **Step 1: 写失败测试**

```ts
it('插话必须落库（变异点：不调 agentMessage.create）', async () => {
  await agentService.steerPiRun(SID, TID, '然后通过章鱼图片参考', USER)
  const row = await prisma.agentMessage.findFirst({
    where: { sessionId: SID, content: '然后通过章鱼图片参考' } })
  expect(row, '插话是用户的显式表达，刷新后必须还在').toBeDefined()
  expect(row!.queued).toBe(true)
})
```

- [ ] **Step 2: 确认红**（当前只有 3 处 `agentMessage.create`，插话不在其中）

- [ ] **Step 3: 实现落库**

⚠️ **消费后要转终态**：插话被模型消费后把 `queued` 置 false，否则永远显示「排队中」（= Review Focus #3）。消费信号来自 pi 侧 `queue_update` 事件（`lane.ts:1513`，目前被丢弃）。

- [ ] **Step 4: Review Focus #3 的测试**

```ts
it('插话被消费后 queued 应转 false（变异点：不消费 queue_update）', async () => {
  await agentService.steerPiRun(...)
  emitQueueUpdate({ consumedEntryIds: [entryId] })
  await vi.waitFor(async () => {
    const row = await reload()
    expect(row.queued).toBe(false)
  })
})
```

- [ ] **Step 5: 变异实测 + tsc + Commit**

---

### Task 9: 乐观插入状态机 + 投影重建（M1）

**Files:**
- Create: `apps/web/src/components/agent/mergeHistory.ts`
- Modify: `apps/web/src/stores/agent.ts:666-670`（`loadHistory` 从整体替换改合并）
- Test: `apps/web/src/components/agent/mergeHistory.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `nextLocalMessageId()`、Task 7 的 `clientId`/`seq`
- Produces: `mergeHistoryAndLive(history, live): Message[]`

- [ ] **Step 1: 写 Review Focus #2 与 #1（合并）的失败测试**

```ts
it('同一 clientId 重复提交只保留一条（变异点：不去重）', () => {
  const merged = mergeHistoryAndLive(
    [{ id: '1', clientId: 'c1', role: 'user', content: '你好' }],
    [{ id: 'local-1', clientId: 'c1', role: 'user', content: '你好' }])
  expect(merged).toHaveLength(1)
})

it('历史到达时已有本地新增消息，不得整体替换（变异点：改回整体替换 ⇒ M1 复发）', () => {
  const merged = mergeHistoryAndLive(
    [{ id: '1', content: '旧' }],
    [{ id: 'local-2', content: '刚收到的' }])
  expect(merged.map(m => m.id)).toEqual(['1', 'local-2'])
})
```

- [ ] **Step 2: 确认红**

- [ ] **Step 3: 实现合并（以 `clientId` 为合并键，`persisted.id` 为最终键）**

⚠️ 合并键优先级：`clientId` > `id`。本地乐观消息只有 `clientId`，服务端确认后才有 `id`。⛔ 不要用 `id` 合并 —— 两者命名空间不同（本地是 `msg-uuid`，服务端是 cuid）。

- [ ] **Step 4: `loadHistory` 改调合并**

- [ ] **Step 5: 变异实测两条 + 守卫测试 + vue-tsc + Commit**

---

## 批次 C · 收口（Task 10–11）

### Task 10: 双真相源对账接口（D3）

**Files:**
- Create: `apps/server/src/agent/turn-reconciliation.controller.ts`
- Test: `apps/server/src/agent/__tests__/turn-reconciliation.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 7 的 `seq`、Task 8 的 `queued`
- Produces: `GET /api/agent/sessions/:threadId/reconciliation` 返回差异分类（spec 图 5）

- [ ] **Step 1: 写失败测试（三类差异）**

```ts
it('应区分「合法差异」与「缺陷差异」', async () => {
  const r = await getReconciliation(TID)
  expect(r.items.some(i => i.kind === 'shadow_event')).toBe(true)   // 合法
  expect(r.items.some(i => i.kind === 'missing_assistant')).toBe(true) // 缺陷
  expect(r.items.every(i => i.explain)).toBe(true) // 每条都要有解释
})
```

- [ ] **Step 2: 实现（分类口径见 spec §5 图 5 的三个分支）**

⚠️ 对账的分类判据必须**可解释**：每条差异要能回答「为什么这轮没落库」，而不是只报一个 diff。

- [ ] **Step 3: 加告警（差异率超阈值时 warn）**

- [ ] **Step 4: 用生产样本验证**

对 `cmvgfa46b000npi01znkg9dos` 跑对账，**必须能报出那个 618.6s 的缺失 run** —— 这是本任务的验收基准（也是 spec §11 R1 的最终确认）。

- [ ] **Step 5: Commit**

---

### Task 11: 上线与生产验收

**Files:** 无代码改动

- [ ] **Step 1: 先 runtime-deploy 再 deploy.yml**

⚠️ `deploy.yml` 的 paths **不含 `services/**`** ⇒ 合并后 pi-runtime 不发布。顺序反了会让 Nest 打新端点到未上线的 runtime ⇒ 404 ⇒ Nest 侧 fail-soft 降级不阻断对话但功能等于没生效。

- [ ] **Step 2: 上线判据 = 入口 chunk 变 + 旧 chunk 404**

```bash
ssh root@119.29.173.89 "ls -1t /var/log/nginx/access.log" && grep -oE 'CanvasPage-[A-Za-z0-9_-]+\.js' /var/log/nginx/access.log | sort -u | tail
```

- [ ] **Step 3: 生产取证三场景**

| 场景 | 判据 |
|---|---|
| A 双端实时 | PC 发消息，**手机不刷新**能看到进度与结果 |
| B 并发插话 | 手机插话 ⇒ 刷新两端，历史里都在且 `queued` 终态正确 |
| C 长任务 | 跑一个 >300s 的 run ⇒ 完成后历史里**有**该轮（对照生产样本的 618.6s 缺失） |

- [ ] **Step 4: 对账接口观察一周**

看 `missing_assistant` 差异率是否归零。⚠️ 不归零说明 Task 2 的解法有漏 ⇒ 回到 Task 2 而不是继续加补丁。

---

## 批次 B′ · 常驻订阅（2026-10-24 补，收尾 P0）

**为什么补这一批。** #547 合并并上线后做生产取证：`GET /api/agent/runs/events` 共 25 次订阅，
**全部 0 字节**（仅 1 次 34 字节 = 一个心跳帧）。三层原因，缺任何一层都是「功能还在、但看不见」：

1. **订阅入口偏窄**：web 侧唯一入口是 `sendMessage` 的收尾分支 ⇒ 旁观端（另一端发起的那一轮）
   压根不订阅。设计目标里的「常驻 session SSE，与谁发起无关」被实现成了「本轮收尾后的 tail」。
2. **首帧前不写任何字节**：浏览器要等**响应头**才算「连上了」，而改前本链路在首个业务事件
   （可能几十秒后）之前不写任何字节 ⇒ 前端整段静默期都处于「未连接」状态 ⇒ 用户切走 /
   组件卸载 / 重挂即 abort ⇒ nginx access log 只留下「200 + **0 字节**」，看不出原因。
   修复：订阅建立即写就绪帧（`: observer-ready`）。
   ⚠️ **归因订正**：初稿把 0 字节归给「nginx `proxy_buffering on` 憋住心跳」，复核生产配置
   （`/etc/nginx/conf.d/lnkpi.conf` 的 `location /api/` **已** `proxy_buffering off`）后推翻。
   `X-Accel-Buffering: no` 仍保留，但定性为**防御性**（反代配置会变），不是本问题的成因。
3. **闸门把常驻连接杀掉**：首帧前 30s idle 只认**业务事件**，心跳不算 ⇒ 静默会话在第 30s 被
   `res.end()`，只来得及发 1 个心跳 ⇒ 前端每 30s 全量重连，常驻名存实亡。

**改动：**

- `apps/server/src/agent/agent.controller.ts`：订阅建立即写就绪帧（让前端立刻拿到响应头）；
  心跳到达即解除首帧闸门；`X-Accel-Buffering: no`（**防御性**，非本问题成因，见上订正）。
- `apps/web/src/components/agent/follow-up-tail.ts`：默认无轮次上限（常驻，旧值 3 等于「第 4 次
  之后本端又聋了」）；idle 由**任何帧**刷新（默认 45s > 心跳 15s×2）；新增 `onTurnEnd`
  （`done` / `turn_ack` / `error` / `turn_not_submitted` 都是收束）。
- `apps/web/src/components/agent/AgentSideRail.vue`：挂载即订阅；会话/线程切换重挂；本端主流
  起飞前让位（否则同一份 `text_delta` 收两遍）；旁观轮生命周期（新建 assistant 影子 →
  收束后 `finishStreaming` + 拉一次权威历史纠正，传 `0` 跳过终态轮询）。
- 新增 `AgentSideRail.observerWiring.test.ts`：把「什么时候订阅」钉成静态契约（组件 3000 行，
  挂载测试代价过高；不锁住的话，挪回 turn 收尾分支会让功能**静默消失**）。

**验收**：Task 11 场景 A（PC 发消息，手机不刷新能看到进度与结果）在本批之后**首次可达**。

⚠️ **仍有缺口**：打开会话时那一轮若已跑了一半，前半段文本拿不到（订阅是 `from=now` 语义）。
补齐需要 Task 7 步 5 的 snapshot 端点（批次 B 遗留）：客户端「先 snapshot 再增量」。

---

## 回滚顺序

倒序执行，每步独立可回：

1. **Task 7（schema）**：⚠️ **最难回** —— `seq`/`clientId` 是加列，可回滚但回滚后新增数据不兼容。回滚前先确认无依赖它的读路径。
2. Task 10 对账接口：纯新增端点，回滚 = 下线端点。
3. Task 9/5 前端：灰度开关关掉即回退到旧行为。
4. Task 8 插话落库：关开关（不再落库）即回到今天的行为。
5. Task 4/6 游标与 ACK：纯增量字段，旧前端忽略即可。
6. Task 2 settle 解耦：⚠️ 回滚前确认无「已 schedule 未执行」的游离 settle。
7. Task 1 nginx：⚠️ **不要单独回滚** —— 若 Task 2 已上，回滚 nginx 会让长任务重新变成 100% 丢库（因为 settle 解耦已依赖它生效）。**两者要么一起回，要么都不回。**

## 已知的坑（来自取证，实施时勿重犯）

| 坑 | 表现 | 处置 |
|---|---|---|
| 参数中段插入 | `string[]` 同型参数静默错位 | 一律追加末尾 |
| `crypto.randomUUID` 不可用 | 生产是 HTTP 非安全上下文 | 保留兜底分支 + 测试覆盖 |
| `lastEventId=` 空值 | pi-runtime 落进 `replay afterSeq=-1` 全量重放 | `null` 时不拼该参数 |
| 旁听流 30s idle | 新客户端常驻会重连风暴 | 仅首帧前用 idle 闸门，之后靠心跳 |
| 迁移加唯一索引 | 存量 NULL 让索引静默失效 | 脚本内置 `RAISE(ABORT)` 断言 |
| 源码静态断言 | 注释命中导致假红/假绿 | 断言落可观测出口 |
| nginx 与 settle 单独回滚 | 长任务重新 100% 丢库 | 两者一起回滚 |