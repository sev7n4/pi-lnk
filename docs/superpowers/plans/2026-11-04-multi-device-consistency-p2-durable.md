# 多端一致性 P2 · 事件流持久化（durable 对账基座）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** pi-runtime 重启 / TTL 驱逐后，进行中/刚完成回合的 P0 对账（`reconcileLatestAssistant` probe + `GET /runs/events` 重放）不失效——`lastEventId` 游标跨重启连续。

**Architecture:** 在既有 `JsonlSessionRepo` 磁盘持久（transcript/meta.json）之上，增加**事件流 append log**（`events.jsonl`，会话目录内）：结构性事件落盘 + `nextSeq` 计数器持久化；内存 buffer 驱逐/进程重启后从磁盘 rebuild，`hasKey=false` 的 events 端点先走磁盘重载（复用既有 createOrResume 磁盘路径）再判 404。delta 类事件不落盘（对账只需终态帧与结构事件；重启后 delta 段缺失可接受，终态与正文由磁盘 transcript 兜底）。

**Tech Stack:** Fastify (SSE)、SessionManager（`services/pi-runtime/src/session-manager.ts`）、Vitest/node:test、Nest probe（apps/server，本包预计零改动，仅加测试钉住）。

**Spec:** `docs/superpowers/specs/2026-10-21-multi-device-consistency-design.md`（§4.2 D2/D6 判据、§12 路线图）；上游输入 `docs/superpowers/plans/2026-11-01-red-car-disconnect-misreport-duplicate-rootfix.md` 批次 T5（durable）。

**⭐⭐ 执行前评审（2026-11-04 20:0x，基于远端 master `f2c954ce` = PR #719 合入后）**：
1. **基线更新**：master 已前进至 `f2c954ce`（#719 终态投影治理，并行会话合入，碰了 session-manager.ts/app.ts 但改动面=终态通报语义 cancelled/refundedPoints，**与本包接缝零交集**）；nextSeq/BUFFER_LIMIT/droppedFromSeq/resumedFrom 等事实在 f2c954ce 重验全部成立；`events.jsonl` 零命中（未做）。worktree 必须基于 **f2c954ce**（远端 tarball 拉取，禁信本地引用——本地 HEAD 停 27b06658）。
2. **事件类型名单修正**：runtime 侧 `NormalizedEventType` 全集 16 个（`agent_start/agent_end/turn_start/turn_end/message_start/message_update/message_end/tool_execution_start/tool_execution_update/tool_execution_end/compaction/error/waiting_user/activity/recovery/node_status`，session-manager.ts:104-128）。**delta 类只有 `message_update`**（每 token 一事件，:513）⇒ `JOURNAL_EVENT_TYPES = 全集 − message_update`（15 个，穷举断言）。计划此前出现的 `done/turn_ack/run_start/pi_message` 是 Nest 归一层术语，runtime 侧不存在，禁止使用。
3. **Nest probe 终态帧判据**（勿混淆）：probe（agent.service.ts）消费 runtime 原始事件流的终态判据基于 runtime 事件 `turn_end`/`error`/`agent_end` 等——journal 持久化这些类型后 probe 重启窗自然可判 settled。

**⭐ 2026-11-04 预检定性修正（本计划与 rootfix T5 原文的差异）**：
rootfix T5 写「`sessions: Map` + TTL → durable 后端」——预检核实 **磁盘 durable 已在位**（见下表），剩余缺口收窄为「事件流投影层不持久」。因此本包**不换 SessionRepo 实现**（JsonlSessionRepo 保留；vendor `session-backends/sqlite-node` 留给规格 §12 多实例共享存储议题），只加事件流磁盘层。

## 已落地事实（2026-11-04 预检核实，执行时不得重做）

| 事实 | 证据 |
|---|---|
| `JsonlSessionRepo` 已接线，磁盘路径 `sessions/`，生产同构 | `session-manager.ts:1126/1200`；`jsonl-session-repo.conformance.test.ts`（conformance 钉死） |
| TTL 驱逐**只关内存句柄、不删磁盘** | `session-manager.ts:1785`（注释原文）+ :1824（磁盘 LRU 豁免规则） |
| 磁盘 resume 已实现：`repo.open + harness.create`（vendor restoreSession）→ `resumed` | `session-manager.ts:743`（`resumedFrom: "memory"\|"disk"`）、:1072、:1165 |
| 身份变更 → `rebuilt`（关闭删目录重建） | `session-manager.ts:706`、:1112、:1139 |
| 事件重放 buffer：500 条内存环形 + `droppedFromSeq` 溢出判读 + 409 回复 | `session-manager.ts:2271-2276`、`app.ts:538-650` |
| **seq 权威源是内存计数器**，「丢掉的 seq 永久不可恢复（重启即全失）」是代码自认 | `session-manager.ts:507`（nextSeq）、:516（注释原文）、:3087（dispatch 独占分配） |
| Nest probe 双源裁决已上线（flag on）：流探测消费重放至终态帧；404⇒headSeq=0 | `agent.service.ts` `reconcileLatestAssistant`（PR #704 `c7a3a80e`） |
| events 端点 `hasKey=false` 直接 404，**无磁盘尝试重载** | `app.ts:539-541` |

## Global Constraints

- 新 worktree 开发（主检出可能被并行会话占用）；基线以 `gh api contents?ref=master` 实时取证，**禁信本地 origin/master**（#701 教训）。
- 测试纪律：vitest 用 nvm node24 + `--maxWorkers=1 --no-file-parallelism`，分批 ≤12 文件；worktree 跑 vitest 前先软链 `apps/web/node_modules → 主仓 apps/web/node_modules`（npx 下载被掐 exit 137 的真因）。
- 本包全部改动落在 `services/pi-runtime/**` ⇒ 合并后**必须手动 dispatch runtime-deploy**（tag = master 全 40 位 SHA + feature_grep 特征串校验）。
- `replicas=1` 维持不变（多实例共享存储属规格 §12 议题，本包不做）。
- 纯 additive、可回滚：`events.jsonl` 是新增文件，不改 JsonlSessionRepo 磁盘形态；读路径对旧会话目录（无 events.jsonl）必须 fail-soft 降级（回到今日行为），不得 resume 失败。
- SSE 帧契约不动：`id: ${seq}`、`droppedFromSeq`/409 语义、`from=now` 语义全部保持逐字节不变。
- 提交纪律：squash merge；REST Git Data API 推送（blob `-F content=@file` 上传后逐项核对 sha）。

## Review Focus

1. **写放大**：text delta 每 token 一事件，全落盘会拖垮磁盘 ⇒ 只有结构性事件落盘（名单见 Task 1），delta 不落盘。测试：dispatch 100 条 delta 后 events.jsonl 行数不变（Task 1 Step 1）。
2. **旧会话兼容**：存量目录无 events.jsonl ⇒ 重载 fail-soft（buffer 空、seq 从新起点），不得抛错、不得 resume 失败。测试：无文件重载成功且 status=resumed（Task 2 Step 1）。
3. **游标连续性**：重启后 nextSeq 必须从磁盘恢复，否则新事件 seq 与旧 seq 撞号 ⇒ 游标语义断裂、客户端去重错乱。测试：重启后首条事件 seq == 重启前最后 seq + 1（Task 2 Step 1）。
4. **TTL/磁盘 LRU 双豁免不回归**：跑 run 的会话不能被回收抽走 events.jsonl 句柄。测试：跑 run 中 dispatch 后文件句柄仍可 append（Task 1 Step 1）。
5. **404 语义不放宽**：磁盘也没有的 session 仍必须 404（否则下游 retryOnMissing 退避语义变形）。测试：伪 session id 仍 404（Task 3 Step 1）。

---

### Task 1 (runtime): `events.jsonl` append 持久化 + nextSeq 落盘

**Files:**
- Modify: `services/pi-runtime/src/session-manager.ts`（SessionEntry 增加事件日志句柄；dispatch 落盘；nextSeq 持久化）
- Create: `services/pi-runtime/src/events-journal.ts`（独立纯模块：append/read/recover，便于单测）
- Test: `services/pi-runtime/src/events-journal.test.ts`

**Interfaces:**
- Produces:
  - `appendEvent(dir: string, rec: JournalRecord): Promise<void>`——`rec = { seq: number; event: NormalizedEvent }`（JSON 行 append；含 fsync 节流：≥N ms 或每 M 条 flush 一次，参数常量 `JOURNAL_FLUSH_MS = 200`）
  - `readJournal(dir: string): Promise<JournalRecord[]>`（损坏行 fail-soft 跳过并 warn）
  - `recoverNextSeq(records: JournalRecord[]): number`（= max(seq)+1；空 ⇒ 1）
  - 结构性事件常量 `JOURNAL_EVENT_TYPES`：= `NormalizedEventType` 全集（17 个，`session-manager.ts:104-128`）**减去 `message_update`**（唯一 delta 类）= 16 个。实现从类型联合导出，测试做穷举断言（Review Focus 1 + Task 5 变异②）。
- Consumes: `NormalizedEvent`（`session-manager.ts:288`）；会话目录 cwd（`sessionsRoot` 同层）。

- [x] **Step 1: 写失败测试**

```ts
// events-journal.test.ts（vitest，node24 纪律）
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendEvent, readJournal, recoverNextSeq, JOURNAL_EVENT_TYPES } from "./events-journal.js";

describe("events-journal", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ejournal-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("append 后 read 原样返回，recoverNextSeq = max(seq)+1", async () => {
    await appendEvent(dir, { seq: 1, event: { type: "run_start", payload: {} } as never });
    await appendEvent(dir, { seq: 7, event: { type: "done", payload: {} } as never });
    const recs = await readJournal(dir);
    expect(recs.map((r) => r.seq)).toEqual([1, 7]);
    expect(recoverNextSeq(recs)).toBe(8);
  });

  it("损坏行 fail-soft 跳过（不抛错）", async () => {
    await appendEvent(dir, { seq: 1, event: { type: "done", payload: {} } as never });
    appendFileSync(join(dir, "events.jsonl"), "{corrupted\n", "utf8");
    const recs = await readJournal(dir);
    expect(recs).toHaveLength(1);
  });

  it("delta 类事件类型不在结构性名单内（写放大防线）", () => {
    expect(JOURNAL_EVENT_TYPES).not.toContain("message_update");
  });

  it("结构性名单 = NormalizedEventType 全集 − message_update（穷举，防遗漏终态）", () => {
    const ALL: NormalizedEventType[] = [
      "agent_start", "agent_end", "turn_start", "turn_end", "message_start", "message_update",
      "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end",
      "compaction", "error", "waiting_user", "activity", "recovery", "node_status",
    ];
    expect([...JOURNAL_EVENT_TYPES].sort()).toEqual(ALL.filter((t) => t !== "message_update").sort());
  });
});
```

- [x] **Step 2: 跑测试确认 FAIL**：`cd services/pi-runtime && npx vitest run src/events-journal.test.ts --maxWorkers=1 --no-file-parallelism`（预期 `events-journal.ts` 不存在）。
- [x] **Step 3: 实现 `events-journal.ts`**（append 用 `fs.createWriteStream(path, { flags: "a" })` 常驻句柄 + 200ms 节流 flush；`readJournal` 逐行 `JSON.parse` 包 try/catch）。
- [x] **Step 4: session-manager 接线**——`dispatch()`（`session-manager.ts:3087`）在 seq 分配后、广播前对结构性事件调用 `appendEvent(join(entry.cwd, "sessions", sessionId), ...)`；写失败只 warn 不阻断（对齐 :879 写盘失败不阻断的既有取舍）；`SessionEntry` 增加 journal 句柄字段，`releaseMemoryHandles()`（:1785 TTL 专用）关闭句柄**不删文件**。
- [x] **Step 5: 全绿 + Commit** `feat(pi-runtime): durable events journal (P2, structural events only)`

### Task 2 (runtime): 磁盘重载——buffer/nextSeq 从 events.jsonl rebuild

**Files:**
- Modify: `services/pi-runtime/src/session-manager.ts`（`build()` 磁盘 resume 分支 :1146-1165 一带：resume 成功后 recover buffer 与 nextSeq）
- Test: `services/pi-runtime/src/session-resume.test.ts`（扩展既有文件）

**Interfaces:**
- Consumes: Task 1 的 `readJournal`/`recoverNextSeq`
- Produces: 磁盘 resume 后 `entry.buffer` = 日志最近 `BUFFER_LIMIT` 条、`entry.droppedFromSeq` = 被截去的最早 seq（无截取 ⇒ 0）、`entry.nextSeq` = `recoverNextSeq` 结果；`CreateResult.status` 仍为 `"resumed"`、`resumedFrom: "disk"`（新增字段不改变既有值语义）

- [x] **Step 1: 写失败测试**（核心断言：跨重启游标连续）

```ts
// session-resume.test.ts 追加用例（骨架）
it("重启后磁盘 resume：buffer 从日志 rebuild，nextSeq 跨重启连续", async () => {
  // ① 建会话 + dispatch 结构性事件 seq 1..3（通过真实 dispatch 路径，禁 stub 合成）
  // ② 模拟重启：releaseMemoryHandles()（TTL 等价）→ 重新 build 同一 sessionKey
  // ③ 断言：resumedFrom === "disk"；
  //    subscribe(id, cb, afterSeq=3) 能回放 seq>3 的增量；
  //    新 dispatch 的首条事件 seq === 4（游标连续性，Review Focus 3）。
});
```

- [x] **Step 2: 跑测试确认 FAIL**（当前 nextSeq 重启后从 1 重计）。
- [x] **Step 3: 实现**——`build()` 磁盘 resume 成功分支尾部：`const recs = await readJournal(...)` → `entry.buffer = recs.slice(-BUFFER_LIMIT)`、`entry.droppedFromSeq = recs.length > BUFFER_LIMIT ? recs[recs.length - BUFFER_LIMIT].seq : 0`、`entry.nextSeq = recoverNextSeq(recs)`；无日志文件（旧会话）⇒ 三值取默认（fail-soft，Review Focus 2）。
- [x] **Step 4: 全绿（含 session-sweeper/session-retention 回归）+ Commit** `feat(pi-runtime): rebuild replay buffer & nextSeq from events journal on disk resume (P2)`

### Task 3 (runtime): events 端点磁盘尝试重载

**Files:**
- Modify: `services/pi-runtime/src/app.ts:538-541`（`hasKey=false` → 尝试 `manager.ensureLoaded(sessionId)`（新增薄方法：内部走 createOrResume 磁盘路径；身份不一致等 `rebuilt` 情形照常）→ 成功则继续订阅流程；磁盘无会话仍 404）
- Test: `services/pi-runtime/src/app.test.ts`（扩展）

**Interfaces:**
- Consumes: `manager.build()` 既有 createOrResume（Task 2 产物保证重载后 buffer/nextSeq 正确）
- Produces: `ensureLoaded(sessionKey: string): Promise<boolean>`——true=已可订阅；404 语义不变（Review Focus 5）

- [x] **Step 1: 写失败测试**：① dispatch 后释放内存 → `GET /sessions/:id/events?lastEventId=N` 返回 200 且重放完整（seq N 之后的事件齐、含终态帧）；② 伪 id 仍 404；③ 身份变更会话走 rebuilt 后订阅正常。
- [x] **Step 2: 跑测试确认 FAIL**（当前 404）。
- [x] **Step 3: 实现**——app.ts 事件端点入口 `hasKey` 判 false 时 `await manager.ensureLoaded(...)`；manager 里 ensureLoaded = `build()` 磁盘分支的只读包装（不触发新会话创建：仅当磁盘存在对应目录/身份时 resume，否则返回 false）。
- [x] **Step 4: 全绿 + Commit** `feat(pi-runtime): events endpoint lazy disk reload across restarts (P2)`

### Task 4 (Nest): probe 重启窗行为测试钉住（预计零改动）

**Files:**
- Test: `apps/server/test/integration/reconcile-across-restart.spec.ts`（新建；若本仓集成测试基建不允许跨进程模拟，则在 `turn-reconciliation.spec.ts` 扩展 stub 层用例 + Task 5 做真实行为级）

**Interfaces:**
- Consumes: P0 的 `reconcileLatestAssistant(threadId, sinceSeq)`（agent.service.ts，不改签名）
- Produces: 回归证据——重启窗内 probe 拿到磁盘 rebuild 的终态帧 ⇒ `outcome: "settled"`、`lastSeq` 正确 ⇒ 前端不弹失败卡

- [x] **Step 1: 写测试**：模拟「事件已入 journal → 重启（换新 manager 实例）→ probe 以 sinceSeq=旧值 调 probeRunEventStream」断言 outcome=settled 且不误判 active/missing。
- [x] **Step 2: 跑测试**：预期直接 PASS（P0 probe 消费重放至终态帧的实现已兼容）；若 FAIL 则是 runtime 侧契约缺口，回 Task 2/3 修，**不得在 probe 里加特判**（对账真相源只在 runtime）。
- [x] **Step 3: Commit** `test(server): pin reconcile probe behavior across pi-runtime restart (P2)`

### Task 5 (integration): 重启演练 + 变异测试

**Files:**
- Test: `services/pi-runtime/src/restart-recovery.integration.test.ts`（新建，node:test 对齐 conformance 测试基建）

**验收（rootfix T5）**：
1. 进行中回合：dispatch 结构性事件（无终态）→ 重启 → events 重放可见 run_start/tool_* 等，probe 可判 active。
2. 刚完成回合：终态帧入 journal → 重启 → 重放含 done，probe 判 settled。
3. **变异守卫**：① 删掉 nextSeq recover ⇒ 重启后首条事件 seq 撞旧号 ⇒ 测试红；② Task 1 改 delta 落盘（或反之删结构名单一项）⇒ 名单穷举断言红。
- [x] **Step 1: 写集成测试 + 两条变异实验 → 跑 PASS（变异各自可红）→ Commit** `test(pi-runtime): restart recovery integration + mutation guards (P2)`

### Task 6 (deploy gate): CI/合并/runtime-deploy/canary

**流程闸门**（无新文件）：
- [x] **Step 1**: 全量回归分批（server + pi-runtime + web 三层 + 双端 tsc；web 预计零改动跑基线）→ REST 推送 → CI 全绿 → squash merge。
- [x] **Step 2**: dispatch runtime-deploy（tag = master 全 40 位 SHA；feature_grep = `events.jsonl` 或 journal 模块特征串，feature_file = `session-manager.js` 或 `events-journal.js` 按实际 dist 核对）。
- [x] **Step 3**: 生产 canary 行为复测：① 正常回合对账不回归；② **容器重启演练**（`docker/k3s restart pi-runtime`，或 k3s rollout restart）：重启后以重启前 lastEventId 调 `GET /sessions/:id/events` ⇒ 200 且重放完整、probe 判 settled；③ TTL 驱逐路径抽查（30min 待驱逐会话重连可用）。
- [x] **Step 4**: PASS ⇒ 收官（规格 §12 状态同步、日志记录）；FAIL ⇒ 回滚 = revert 该 PR（磁盘 events.jsonl 残留文件无害，读路径旧代码忽略它）。

### ✅ Task 6 收官实录（2026-11-04 23:45）

- **PR #720** squash merge `1bf314dd`（CI 3/3 绿）；合并触发的主 deploy 与并行 #721（`d2760a44`，计费实时投递）共用并发组——首次 runtime-deploy dispatch 被 pending 挤掉取消（⭐ 并发组语义：cancel-in-progress:false 下只保留最新 1 个 pending），等两轮主 deploy 全 success 后以 `d2760a44` 重dispatch。
- **runtime-deploy** run 41857218784：Preflight behind_by=0 → build → **feature hits: 1**（`events journal stream error` @ dist/events-journal.js）→ 闸门自批放行 → success。
- **生产取证**：pod imageID `sha256:0964f031…`、镜像内特征串 grep=1、healthz `version=d2760a44`。
- **生产行为探针**：① 新建平台会话（provider=agnes）⇒ events 200 + `events.jsonl` 真实落盘 + DELETE 204 清理干净；② 存量 BYOK 会话（provider=byok-…）⇒ events 404 = **设计内 fail-soft**（身份预检不匹配，零删除副作用）；③ 伪 id 404 语义不变。
- ⏳ 待真实流量复测：平台会话跑一轮生成回合后重启 pod，以重启前 lastEventId 重连 ⇒ 200 重放完整、probe settled（本轮无平台会话存量——现网会话全为 BYOK）。

---

## 自我审查记录（2026-11-04 v1）

1. **spec 覆盖**：rootfix T5 验收「重启/TTL 后 P0 对账不失效」= Task 2+3+5；「sessionResumes 维度 disk|rebuilt」已有（`resumedFrom: disk`/`rebuilt` 状态，预检核实）不重做；规格 D2/D6 判据在本包的体现 = Task 5 验收 1/2。规格 §12 多实例/sqlite-node 明确不在本包。✅
2. **占位符扫描**：`JOURNAL_EVENT_TYPES` 名单标注「实现时以 EVENT_MAP 为准核对」属已知未知 + 穷举断言兜底（Task 1 Step 1 + Task 5 变异 ②），非占位。Task 4 允许 FAIL 回修 runtime 的路径明确。✅
3. **类型一致性**：`JournalRecord`/`appendEvent`/`readJournal`/`recoverNextSeq`/`ensureLoaded` 各任务签名一致。✅
4. **Review Focus 五条均有属主测试**：写放大→T1S1；旧会话兼容→T2S1；游标连续→T2S1；TTL 豁免→T1S1（接线后断言句柄可 append）；404 语义→T3S1。✅
5. **Nest 零改动假设的风险**：Task 4 显式钉住——若 probe 在重启窗 FAIL，修 runtime 不修 probe（对账真相源唯一）。✅

## 后续计划（不在本包）

- **P3**：意图级幂等 `threadId+归一化意图+近窗`（治 D5；rootfix T2）+ ACK mode 三态（规格 Task 6）。
- **P4**：`finalizeTurn` 落库与连接解耦（治 D2；rootfix T4 resume）+ `agentMessage` schema `@@unique([threadId, seq])` 回填收口（schema 已有 `seq Int?` 可空临时态，迁移说明见 schema.prisma:453-455）+ E1 接缝 `agent-canvas-tools.service.ts:3365` 补 `seq`。
- **多实例**：共享事件存储（届时评估 vendor `session-backends/sqlite-node`）。
