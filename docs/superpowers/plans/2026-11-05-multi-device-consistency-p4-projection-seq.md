# 多端一致性 P4：投影面收口（seq 唯一化 + M1 投影重建）

**Date:** 2026-11-05
**Spec:** `docs/superpowers/specs/2026-10-21-multi-device-consistency-design.md`（§5.4 投影面 / §7.1 迁移五步走 / §8 mergeHistoryAndLive / §10.2 变异测试）
**Goal:** 把 2026-10-22 迁移遗留的「临时可空 seq」收口为数据库事实（回填 + 唯一索引 + 全部写方接线），并修复 M1 覆盖竞态（历史加载整体替换吞掉本地增量）。

## 0. 预检结论（2026-11-05，基线 = 远端 master `94a682d5`）

**第三次预检反转**：P4 原始定义的主体「finalizeTurn 落库与连接解耦（治 D2）」**已被先前工作落地**，不重做：

| 原始范围（P0+P1 计划 §后续包定义） | 远端代码事实 | 裁决 |
|---|---|---|
| D2 落库解耦 | `agent.service.ts:3450-3519` finally 兜底落库 + detached `finalizeTurn` + truncated 标注；测试 `turn-settled-detached.test.ts` / `longturn-persistence.test.ts` / `agent.service.test.ts` ⑥ 全覆盖 | ✅ 已落地，关闭 |
| rootfix T4 resume（lane.resume） | P1 ack+drain 架构下 drain 与连接存活无关（`agent.service.ts:1223-1236` 后台消费到底）；且 `lane.resume()` 有禁令（真相源=pi transcript） | ✅ 被架构取代，关闭 |
| D3 对账接口 | `agent.controller.ts:412` `GET chat/reconcile` 已存在（P0 T2） | ✅ 已落地 |
| schema `queued` 列 + 消费终态 | #547 列 + P3 G3 读时派生 | ✅ 已落地 |
| schema `seq` 列 | 迁移 `20261022043000` 只加列未回填；`@@unique([threadId, seq])` 未建；**全仓 0 个 seq 写方**；唯一读路径依赖它之前「行为与今天完全一致」 | ⏳ **本包 T1/T2** |
| E1 接缝补 seq（§7.1） | `agent-canvas-tools.service.ts:3750` 简报 create 无 seq | ⏳ **本包 T1** |
| Task 9 投影重建（M1） | `stores/agent.ts:916` `messages.value = history.map(...)` 仍整体替换 | ⏳ **本包 T3** |
| clientId 贯通 + 唯一索引（§5.5 乐观插入） | 无客户端发送方 | ⛔ 刻意不做（见 §刻意不做） |
| 步 5 独立 snapshot 端点 | `getMessages` 已是分页投影快照（P3 读时派生加持） | ⛔ 刻意不做（见 §刻意不做） |

**迁移五步走现状**（`20261022043000/migration.sql` 自述）：步 1 加列 ✅ → 步 2 部署观察 ✅ → 步 3 回填排序单测 ✅（`computeSeqs` + `session-projection.service.test.ts`）→ **步 4 回填+唯一索引 ⏳ → 步 5 snapshot 端点 ⛔（由 getMessages 承担）**。

## 1. 关键代码事实（预检取证）

- `computeSeqs`（`session-projection.service.ts:39`）：回填口径 = `(threadId, createdAt, id)` 全序、每 thread 从 1 连续、与输入顺序无关（可重放）。SQLite `ROW_NUMBER() OVER (PARTITION BY "threadId" ORDER BY "createdAt", "id")` 与之**逐行同序**（createdAt 为 DateTime 恒可解析，`msOf` 的 NaN→0 分支在 SQL 路径不存在）。
- agentMessage 写点全集（非测试，4 处）：
  - `agent.service.ts:904` user 行（prompt 前落库）
  - `agent.service.ts:1650` upsert user 行（queued 落库，P3 G2；`update: {}` 先到先得）
  - `agent.service.ts:4145` assistant 行（`finalizeTurn`，owner/shadow/回合外三路共用）
  - `agent-canvas-tools.service.ts:3750` E1 回合外简报（`notifyTerminalsOnce` onDelivered）
- 生产存量 ~9k+ 行，回填一次性；单实例部署（`replicas=1`），写并发低。
- `getMessages` 返回整行（含 seq 字段自动透出）；web `PersistedAgentMessage` 需补 `seq?` 类型。
- 回滚安全：SQLite 唯一索引下 NULL 互不冲突 ⇒ 回滚到无 seq 写方的旧镜像时新行 seq=NULL 不炸索引（迁移注释原判据复用）。

## 2. 刻意不做

| 不做 | 理由 |
|---|---|
| clientId 贯通 + 唯一索引 | §5.5 乐观插入状态机是独立失败面（web 发送路径 + DTO + 幂等语义）；无客户端发送方时加索引只会挡住正常写入（迁移注释同判据）。M1 先用内容+时间窗去重解（T3）。后续包另立。 |
| 步 5 独立 snapshot 端点（session-projection.controller） | `getMessages` 已是权威分页投影（含 queued 读时派生）；新增并行端点 = 制造双真相源，违背本规格自己的 D3 精神。 |
| D2 落库解耦 / resume | 见预检结论——已落地或被架构取代，重做即回归风险。 |
| seq 列 NOT NULL（重建表） | SQLite 加 NOT NULL 需重建表（外键/索引逐一复刻），风险远大于收益；闸门 RAISE(ABORT) + 写方保证已满足 D6 的实质（唯一索引不因 NULL 失效）。 |

## 3. Tasks

### Task 1: seq 写路径统一（helper + 4 写点）
- [x] 新增 `apps/server/src/agent/agent-message-seq.ts`：`allocateSeq(tx, threadId)` = `aggregate({_max:{seq}})` + 1；unique violation 时重读重试（≤3 次，防并发同毫秒窗口）。
- [x] 4 写点接线（:904 / :1650 upsert 的 create 分支 / :4145 / canvas-tools :3750）。
- [x] 测试 `agent-message-seq.test.ts`：单调递增、重放幂等（同批两行不重不漏）、冲突重试路径、canvas-tools 简报行带 seq。

### Task 2: 迁移步 4（回填 + 唯一索引）
- [x] 新迁移 `20261105xxxxx_backfill_message_seq`：`UPDATE` 回填 `ROW_NUMBER() OVER (PARTITION BY "threadId" ORDER BY "createdAt","id")`（仅 `seq IS NULL` 行）→ 断言无 NULL（RAISE(ABORT) 闸门，硬要求）→ `CREATE UNIQUE INDEX ... ON "AgentMessage"("threadId","seq")`。
- [x] `schema.prisma`：AgentMessage 加 `@@unique([threadId, seq])`。
- [x] fixture 验证：本地临时库跑 migration.sql，断言与 `computeSeqs` 结果逐行一致（口径双实现互证）。

### Task 3: web M1 投影重建（mergeHistoryAndLive）
- [x] `stores/agent.ts`：`loadHistory` 改合并语义——历史权威 + 保留历史未覆盖的本地增量；去重键 = id 优先，回落「role=user && content 相同 && 时间窗 60s」（clientId 未贯通的过渡口径，注释钉明）。
- [x] `prependHistory` 同口径审查（翻页只补头部，天然不整体替换，确认即可）。
- [x] 测试：M1 场景（历史到达时本地已有新增 ⇒ 不被吞）+ **变异测试**：改回整体替换 ⇒ 测试红（spec §10.2 硬要求）。

### Task 4: 收官
- [x] server/web vitest 全家 + `vue-tsc -b` + server/shared tsc。
- [x] REST push（blob sha 双向核对）→ PR → CI 3/3 → squash merge → deploy。
- [x] 生产取证：AgentMessage NULL-seq 计数=0、唯一索引存在（`sqlite_master`）、发一条消息后 seq 连续、M1 场景真机复测（流式中刷新历史不吞气泡）。
- [x] 计划勾选 + 实录 + REST docs 提交。

## 4. 风险

| 风险 | 缓解 |
|---|---|
| 回填与 `computeSeqs` 口径漂移（SQL vs TS 双实现） | fixture 互证（Task 2）；漂移即迁移拒绝上线 |
| upsert `update:{}` 分支重放命中已有行（已有 seq） | create 分支才分配 seq；update 空操作不动 seq |
| 部署窗口写丢失（迁移前后镜像切换） | prisma migrate deploy 与新代码同容器启动；单实例无并发写 |
| web 合并去重误杀（内容相同的两条真实消息） | 60s 时间窗 + role 限定；误杀面远小于现行整体替换 |

---

## 执行实录（2026-11-05，T4 收官中）

**分支** `feat/p4-projection-seq`（基线 = 远端 master `a3d31362`，worktree 本地基线 `36667da0`）。

| Task | 落点 | 证据 |
|---|---|---|
| T1 seq 写路径 | `agent-message-seq.ts`（nextMessageSeq / runWithMessageSeq，P2002 重试 ≤3）；4 写点接线（user :904、queued upsert :1650、finalizeTurn :4145、E1 简报 canvas-tools saveAgentMessage） | helper 测试 7/7；finalizeTurn 的 P2002 外层 catch 保留「owner 记账 no-op」语义（注释钉死） |
| T2 迁移步 4 | `20261105040000_backfill_message_seq`（ROW_NUMBER 全量重编号 → NOT NULL 临时表闸门 → unique index）+ schema `@@unique([threadId, seq])` | ⭐ fixture 互证**抓到真 bug**：初版「MAX(seq) 偏移 + 仅编号 NULL 行」被 UPDATE 自引用污染（后处理的行读到前面行刚写入的 seq，t1 实测 2/3/6，正确 1/2/3）——改单遍全量重编号后 ✅ SQL 与 computeSeqs 逐行一致（含同毫秒 id 兜底 tie）；NULL 闸门实测 `NOT NULL constraint failed: _p4_seq_null_gate.n` 拦截生效 |
| T3 M1 投影重建 | `loadHistory` 合并语义（id 命中让位 / user 同 content±60s 窗让位 / streaming assistant 被更晚权威行覆盖则让位）；`localCreatedAt` 落在 addUserMessage/startAssistantMessage | 变异测试 6 例（改回整体替换 ⇒ ①②⑤ 红，spec §10.2 硬要求）；既有 `agent.test.ts`「replaces existing messages」按新契约改判；prependHistory 审查确认本就按 id 合并 |

**计划外修正**：
- 批量补桩脚本 bug：单行形态 `agentMessage: {...}` 被跳过时整段丢弃 ⇒ 3 个测试文件语法损坏（swc Expression expected）——从基线恢复 + 精确字符串重补（commit `95cb5741`）。教训：**批量文本手术必须先验证收集可过**（vitest collect）再提交。
- `model-health.sqlite.integration.test.ts` 全量并发下 hook 超时 10s（环境抖动），隔离跑 4/4 通过——非本包引入。
- ⚠️ 既有迁移序列在全新库不可重放（`20260808120000` 假设表已存在）——生产是增量迁移史，先例如此；本次用 `db push` + `db execute` 替代 fresh `migrate deploy` 做 fixture 验证，未改既有迁移。

**测试（终局）**：web 全量第二轮 **451 文件 / 3838 例全绿**（第一轮 1 例失败=环境抖动，重跑即绿）；server 全量 2387 通过；vue-tsc / server tsc 零错。

**上线（2026-11-05 13:46-14:11）**：REST push（blob 全数 sha 核对）→ **PR #729** → CI 3/3 绿（Build monorepo / Build API Docker / Verify spec figures）→ squash merge `f5cbf4d8` → Deploy to Tencent Cloud success（run 41976153251）→ entrypoint `prisma migrate deploy`（backfill + unique index，失败即容器不 serve）→ health ok + 生产 bundle 共享 chunk `CanvasNodeText.vue_...-B8sr8uhH.js` 含 `localCreatedAt` ×6（T3 代码已上线）。无 runtime-deploy（未碰 pi-runtime）。
