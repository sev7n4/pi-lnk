# SSE 事件一等化 P1a 实施详设（PR-A 帧契约小刀 + PR-B 事件表主体刀）

> 日期：2026-11-11　|　基线：真 master `ab7a2b40`（干净 tarball 快照核对）　|　性质：实施详设
> 母计划：`docs/superpowers/plans/2026-11-11-sse-session-resume-p0-p2.md` §2
> 本详设先按真实 master 结构修正母计划 §2.2 的前提，再拆刀。

## 0. 基线勘误（必须先读，母计划 §2.2 部分前提已过时）

干净快照实测证明，母计划 P1a 第 1 条（SSE 标准三件套）的**主通道已被「多端一致性 P1（2026-11-04 Task 4）」落地**：

| 母计划假设 | 真实现状（`ab7a2b40`） |
|---|---|
| 主流 `POST chat/conversation` 手写 SSE 无 `id:` | 已 ack 化：生产 env `STREAM_MAIN_FROM_PIRUNTIME=on`（容器 printenv 实证）⇒ POST 回 JSON ack，事件全走 `GET /runs/events`；flag-off 旧 SSE 分支保留为回滚面（承诺逐字节不变） |
| 无 `id:` 行、无 Last-Event-ID | `runEvents`（`agent.controller.ts` 循环内）已逐帧写 `id: ${seq}`（无 seq 的合成事件刻意不写，防游标错位），浏览器断线自动带 Last-Event-ID 续传 |
| `ts` 在 UiEvent 投影被丢 | 属实且**文件内已留 P1 计划注释**：`pi-events.ts` `UiEvent` 注释明言「P1 前端真正按序插入时再补并同步改测试」；`runId` 已透传 |
| 溢出 409 丢事件 | 客户端 `snapshot` resync 已合成（2026-10-18，不断流），但 buffer 溢出 ⇒ 历史永久丢仍在——DB 事件表是兜底真解 |

**因此 P1a 剩余真实缺口**收敛为四项，按小刀纪律拆两个独立 PR：

| PR | 内容 | 风险面 |
|---|---|---|
| **PR-A（本刀，先行）** | ① `/runs/events` 补 `retry:` 行；② `UiEvent` 补 `ts` 透传（兑现文件内既有 P1 承诺） | 零 schema、零新端点、帧契约增量 |
| **PR-B（后续刀）** | `AgentEvent` append-only 表 + 主链路流中即时双写 + `GET threads/:id/state` + `GET threads/:id/events?since=` | 新表迁移 + service 双写 |

## 1. PR-A 详设

### 1.1 改动 ①：`retry:` 行（`agent.controller.ts`）

`runEvents` 端点（`res.setHeader('X-Accel-Buffering', 'no')` 附近）补一行：

```ts
res.write('retry: 3000\n\n')
```

- 位置：`': observer-ready\n\n'` 注释帧**之前**——浏览器须在建立期就拿到重连间隔。
- ⚠️ **flag-off 旧主流 SSE 分支不加**：该分支有「逐字节不变」的兼容回滚面承诺（controller 内注释钉死），且生产 flag on、旧分支废弃中，不碰。
- 语义：显式声明浏览器 EventSource 重连间隔 3s（与既有前端退避一致），不依赖 UA 默认值漂移。

### 1.2 改动 ②：`ts` 透传（`pi-events.ts`）

`PiRuntimeEvent.ts` 本就必填（number）。改三处：

1. `UiEvent` 接口加 `ts?: number`（注释从「暂不透传」改为「P1a 起透传」）。
2. `mapPiEventToUiEvent` 的 `ui()` 帮手：`ts: event.ts`。
3. `createUiEventProjector` 内手写派生对象（canvas_command / canvas_action / task_list / task_update / plan 派生 / error）与 `createThinkingAccumulator` / `createUsageAccumulator` 产物：凡带 `seq: event.seq` 的字面量同步补 `ts: event.ts`。

**同步改测试**（`toEqual({type,data})` 精确比对会因新增键转红）：`pi-events.test.ts` / `pi-events.projector.test.ts` / `pi-events.preferredKind.test.ts` / `pi-events.recovery.test.ts` 中所有精确比对处——用 `toEqual({ type, data, seq: ..., runId: ..., ts: ... })` 或改 `toMatchObject({ type, data })`（择既有风格，最小 diff）。

### 1.3 PR-A 测试用例与变异自检

| # | 用例 | 判据 | 变异自检 |
|---|---|---|---|
| A1 | `runEvents` 静态源码契约（剥注释扫描） | 含 `retry: 3000` 写行；位于 `observer-ready` 注释帧之前；flag-off 旧主流分支**不含** retry 写行 | 删 retry 行 ⇒ RED |
| A2 | `mapPiEventToUiEvent` 全型谱 | 每个 UiEvent 带 `ts === 输入事件.ts`（对 mapped 分支与 pi_ 透传分支逐一断言） | `ui()` 去掉 ts ⇒ RED |
| A3 | `createUiEventProjector` 派生谱 | canvas_command / canvas_action / task_list / thinking / turn_usage / plan 派生逐类带 ts | 任一派生点删 ts ⇒ RED |
| A4 | 阴性对照 | 输入事件无 ts（构造 `ts: undefined` 旁路）⇒ 产物无 ts 键（`'ts' in ev === false`） | 改成硬编码 Date.now() ⇒ RED |

### 1.4 PR-A 验收判据

1. 本地 vitest 全绿（含改动的 4 个 pi-events 测试文件 + 新契约）+ `vue-tsc`/`tsc --noEmit` 零错误。
2. 生产复测（合并后）：`curl -N` 实连 `GET /runs/events`（需鉴权会话）抓原始帧——首行 `retry: 3000`；或无鉴权环境下降级为「部署成功 + health 200 + 单测 A1 契约在 CI 干净 checkout 全绿」双证。
3. 前端回归：P0 全部用例（T1–T9）仍绿（ts 新键对 reducer 透明）。

## 2. PR-B 详设（后续刀，不在本 PR 实施）

### 2.1 Schema（additive，新表零破坏）

```prisma
model AgentEvent {
  id       String   @id @default(cuid())
  threadId String
  gSeq     Int
  runId    String?
  type     String
  ts       DateTime @default(now())
  data     String   // JSON string（UiEvent 形态，与 SSE 帧同构）
  createdAt DateTime @createdAt

  @@unique([threadId, gSeq])
  @@index([threadId, gSeq])
}
```

- **seq 空间**：直接用 pi-runtime 会话内单调 seq（Task 4 已用它当 SSE `id:`）——**不新增第三套 seq**（母计划红线）。gSeq 与 `/runs/events` 的 `id:` 同源同值，前端游标可跨通道通用。
- 迁移：`prisma/migrations/<ts>_add_agent_event/migration.sql`（CREATE TABLE + 唯一索引），SQLite additive。

### 2.2 双写（单一写者）

- 落点：主链路 `streamConversation` 派生段（owner 形态，唯一有落库副作用的通道）。结构性事件（`tool_call`/`tool_result`/`waiting_user`/`canvas_command`/`task_list`/`task_update`/`thinking{done}`/`turn_usage`/`turn_settled`/`error`/`node_status`）**派生即 append**；`text_delta` 沿用 `createTextSegmentPersister` 段折叠，`flush()` 边界落一条完整 `text` 事件（S3「不半条」天然成立）。
- 幂等：`upsert((threadId,gSeq))`，冲突覆盖（SSE 重放/重跑同帧安全）。
- 失败语义：事件表写失败**不阻断主链路**（warn + metrics），executionEvents 落库仍是权威展示快照（P1b 才换读）。

### 2.3 双 API（只读）

- `GET /api/agent/threads/:threadId/state` → `{ status: 'in_progress'|'complete', lastGSeq, pendingInterruption?: {callId, kind, expiresAt} }`（in_progress 判定 = pi-runtime 活跃 run；pending 摘要为 P2 预留位，P1a 先返回 null）。
- `GET /api/agent/threads/:threadId/events?since=<gSeq>&limit=500` → 按 gSeq 升序、带 `nextCursor`；`since` 超尾返回空数组非 404。

### 2.4 PR-B 测试用例

即母计划 §2.3 S1–S7（S1 收窄为「retry/id 帧契约已由 PR-A + Task 4 覆盖」；S2–S7 全新），每条实现级变异自检 RED→还原，验收判据沿用母计划 §2.3 末段。

## 3. 落地纪律

- PR-A 只动 `apps/server` 两文件 + 测试 ⇒ 合并触发 API 镜像构建部署（`deploy.yml` paths 含 `apps/server/**`）⇒ 合并窗口单独授权 + 生产复测。
- 分支纪律 / gh api REST 推送 / `git status --short` 为空 / node24 定向 vitest（`--maxWorkers=1 --no-file-parallelism`）照旧。
- 回滚：PR-A 单 commit revert 即可（无 schema、无数据）。
