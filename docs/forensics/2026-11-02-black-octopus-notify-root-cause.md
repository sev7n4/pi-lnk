# 「生成一只黑色的小章鱼」回合外完成通知系统性失效 · 根因诊断与根治

> 调查对象：会话 `cmvz1zujx0099lt013qrdogv3`（线程同 id，用户消息 `1793611558219`）
> 调查日期：2026-11-02
> 方法：生产 SQLite 只读回放（`lnkpi.db` 快照）+ Nest reaper 日志重放 + 本仓库 `late-generation-notify.ts` / `schema.prisma` 源码核对
> 结论置信度：高（关键断言均经生产数据或源码行号交叉验证）

---

## 0. 结论速览（先给答案）

| # | 现象 | 真正根因（一句话） | 性质 |
|---|------|------------------|------|
| ① | 助手说「完成后会通知您」，但图片已生成完、聊天里**永远没有完成消息** | `late-generation-notify.ts` 查 `AgentThread` 时 `select` 误用不存在的 `threadId` 列 → Prisma 校验错被 `.catch(()=>null)` 静默吞掉 → 每条记录被**永久标 `no-thread`**（durable 去重键，永不重试） | **系统性通知失效（P0）** |
| ② | 本轮 SSE 跑到 `turn_settled`、仅 1 条记录、**未断流未双图** | red-car 治理方向见效；但 P4 意图级幂等尚未部署，重发同句仍会双图 | 已改善·根未除（P3） |
| ③ | `set_node_generation_params(guide_scene_id="default-image")` → HTTP 400 | agent 未先 `list_generation_scenes` 就硬编码不存在的场景 id；写类工具 400 被静默 proceed | 行为/提示词缺陷（P1） |
| ④ | `linkedOutputs.status:"done"` 但节点当时仍 `generating` | 落库时点错误（快照早于终态） | 数据不一致（P2） |
| ⑤ | `canvas_action` 同 `gSeq` 双发 | 事件 fan-out 未去重 | 可观测/健壮性（P2） |

**核心结论**：本回合**最大的问题不是 red-car 那类断线/双图**，而是一条**系统性的"回合外完成通知永远不送达"链路 bug**——本轮只是它的一个样本。该 bug 自上一修复（`updatedAt` 列名）后**仍残留**在 `agentThread.findFirst` 上，导致生产近 15 小时、跨多个会话的所有 completed 生成记录一律 `no-thread`。

---

## 1. 一手证据复核（生产数据）

会话 `cmvz1zujx0099lt013qrdogv3` 完整时间线（均为 +08，2026-11-02；T0 = 用户消息）：

| 时刻 | 事件 | 证据 |
|------|------|------|
| T0+0s | 用户发「生成一只黑色的小章鱼」 | AgentMessage `1793611558219` |
| T0+3.8s | `upsert_media_node` 建节点 `image-1793611562008-8` | — |
| **T0+5.6s** | `set_node_generation_params(guide_scene_id="default-image")` → **HTTP 400：unknown guideSceneId** | 见 ③ |
| T0+5.6s | agent 忽略 400，直接 `propose_generation` | 见 ③ |
| T0+94s | `waiting_user` resolved（确认耗时 88.6s）；建 `GenerationRecord`、扣 33 分、节点→generating | GenRecord `cmvz22gep009klt01zjo8stun` |
| T0+98s | 助手文案「已创建节点并启动生成，**完成后会通知您**」→ `turn_settled` | assistant `cmvz22jlz009qlt01dyxmkwms` |
| T0+107s | 生成真正完成（节点 completed、URL 有效、1024×1024 PNG） | 节点终态 |
| **T0+356s（09:31:52）** | reaper 扫描把该记录 metadata 标 `agentTurnNotified="no-thread"` | 见 ① 根因 |

**关键物证（系统性，非个例）**：

```sql
-- 生产快照直查：近 15h 所有 completed 生成一律 no-thread
SELECT id, sessionId, status,
       json_extract(metadata,'$.agentTurnNotified') AS notified,
       json_extract(metadata,'$.agentTurnNotifiedAt') AS notifiedAt
FROM GenerationRecord
WHERE status='completed' AND sessionId IS NOT NULL
ORDER BY createdAt DESC LIMIT 25;
-- 结果：跨 cmvwads7g…/cmvxefz4g…/cmvyzadq9…/cmvz1zujx… 等所有行 notified 均为 "no-thread"
```

```sql
-- 证实字段名错误（而非真的无线程）：SQL 直查 AgentThread 主键列是 id
SELECT threadId FROM AgentThread WHERE sessionId='cmvz1zujx0099lt013qrdogv3' LIMIT 1;
-- 报错：no such column: threadId  ⇒ 列确为 id（schema:377 注释 `id String @id // threadId`）
```

reaper 日志在 `09:31:52` 确有 `回合外生成终态通报已处理 1 条`（正是本记录），证明扫描确实跑了、且走到了「标 no-thread」分支——而不是没跑。

---

## 2. 根因（① 系统性通知失效）

代码链路 `apps/server/src/agent/pi-runtime/late-generation-notify.ts`：

1. **接口声明用错字段名**（修复前）：
   ```ts
   agentThread: {
     findFirst(
       args: ... & { select: { threadId: boolean } },  // ❌ AgentThread 没有 threadId 列
     ): Promise<{ threadId: string } | null>
   }
   ```
   `AgentThread` 模型主键是 `id`（schema.prisma:377 `id String @id // threadId`）。`threadId` 只是**注释里的别名**，不是列名。

2. **调用点同样写错**（修复前）：
   ```ts
   const thread = await prisma.agentThread
     .findFirst({ where: { sessionId }, select: { threadId: true } })  // ❌ 非法 select
     .catch(() => null)                                               // ❌ 静默吞错
   ```
   Prisma 对 `select: { threadId: true }` 抛**字段名校验错**（确定性）。

3. **错误被 `.catch(() => null)` 吞掉** → `thread` 恒为 `null` → 走入 `if (!thread)` 分支 → `markNotified(prisma, rec.id, meta, 'no-thread')`。

4. **`agentTurnNotified` 是 durable 去重键**（`markNotified` 把它写回 metadata）：一旦标 `no-thread`，下一轮 reaper 扫描在 `:175` 的 `if (meta.agentTurnNotified) continue` 直接跳过 → **永不重试、通知永远不送达**。

> 这是 2026-10-21 那次 `updatedAt` 列名修复的**同族残留**：上一次只把 `findMany` 的查询参数接回了真源类型，**`findFirst` 的 select 仍是手写字面量 `{ threadId: boolean }`**，既没接回 `Prisma.AgentThreadSelect` 做 tsc 防线，运行期又被 `.catch(()=>null)` 兜成了静默误判。

**用户后果**：看到"完成后会通知您"，但通知永远不来——图片其实早已生成完（节点 completed、URL 有效），聊天里却没有完成消息。本轮因未重发而没暴露双图，但**任何依赖"完成通知"的画布会话都中招**。

---

## 3. 其余暴露问题（待办，不在本 PR 范围）

- **③【P1】agent 编造 `guideSceneId="default-image"` 撞 400**：规则 15 要求"建节点后、propose 前先 `list_generation_scenes`"，agent 未先查清单就硬编码不存在的场景 id。服务端校验正确拒绝（测试 `guideSceneId 不存在即拒`）。属 agent 提示词/行为缺陷，需单独修 prompt 或加场景清单预取。
- **③续【P1】写类工具 400 被静默吞**：`set_node_generation_params` 返回 `isError:true / invalid_params / retryable:false`，agent 未按错误提示去查场景修正，直接 proceed，guide 场景参数悄悄丢失。建议写类工具 4xx 进入「先纠正再继续」分支而非 proceed。
- **④【P2】`linkedOutputs.status:"done"` 与节点实际 `generating` 不符**：落库时节点仍是 generating，快照却标 done，疑似落库时点早于终态。建议落库动作统一在终态回调内触发。
- **⑤【P2】canvas_action 重复下发**：`seq15/16`（generating + generationRecordId）与 `seq17/18` 同 `gSeq 198/199` 双发，是事件 fan-out 未去重的信号，建议去重或合并。
- **②【P3·已改善但根未除】断线误报/双图未复现，但 P4 未上线**：本轮 SSE 跑到 `turn_settled`、仅 1 条 GenerationRecord——red-car 治理方向见效。但**幂等键仍是 `ik_{threadId}_{Date.now()}_{随机4位}`（请求级）**，意图级幂等（P4）尚未部署；本轮没双图只是因为用户没重发，重发同句仍会双图。
- **【P3·遗留】`GenProgress` 仍为空**：与 red-car §6 同缺口，可观测性未补，事故只能靠 assistant 消息 metadata 反推。

---

## 4. 根治（本次已落地）

仅修 ① 这一条系统性链路（其余见 §3 待办）。改动文件 `apps/server/src/agent/pi-runtime/late-generation-notify.ts`：

1. **接回真源字段**：`agentThread.findFirst` 的 `select` 类型由手写的 `{ threadId: boolean }` 改为 `Prisma.AgentThreadSelect`（第三层防线，写错字段名 tsc 直接报错）；调用点 `select: { id: true }`；返回值 `{ id: string }`。
2. **去掉静默吞错**：把 `.catch(() => null)` 改为 try/catch，区分两种结果：
   - 真·无线程（`findFirst` 返回 `null`）→ 标 `no-thread`（合法去重，画布从未开过对话）；
   - 查询报错（字段名写错等确定性/瞬时错误）→ `warn` + `continue`，**不落标记**，下轮巡检重试，避免错误被永久固化成 `no-thread`。
3. 日志记录改用 `thread.id`（即对外 threadId）。

配套测试（`late-generation-notify.test.ts`）新增/修正：
- 修正 mock 返回 `{ id: ... }`（与字段名一致，CI tsc 编译 `*.test.ts` 通过）；
- 新增「`agentThread.findFirst` 抛错 → **不落 no-thread 标记、下轮重试**」回归用例（锁定本次根因）；
- 新增「`findFirst` 用真实字段 `id` 解析线程」用例。

验证：`vitest run src/agent/pi-runtime/late-generation-notify.test.ts --maxWorkers=1 --no-file-parallelism` → **12 tests passed**（含 2 新增）。

> ⚠️ **已中毒记录的清理**：生产 DB 中近 15h 所有 completed 记录已被误标 `no-thread`（durable）。本修复只阻止**新**记录中毒；已标记的记录不会被重扫，其完成通知**已永久丢失**。上线后建议对"真实存在 AgentThread 且仍误标 no-thread"的记录做一次 `agentTurnNotified` 清零（注意：仅对**近期**、用户尚未感知完成的做补通知，避免给早已看完图的用户重发"生成完成"造成困惑——该清理需产品侧确认范围）。

---

## 5. 一句话给决策层

> 本轮暴露的不是 red-car 那类断线/双图，而是一条**系统性的"完成通知永远不送达"链路 bug**：`late-generation-notify` 查 `AgentThread` 时误用了不存在的 `threadId` 列，校验错被 `.catch(()=>null)` 吞掉，导致生产近 15 小时、跨多会话的所有生成完成通知一律被永久标 `no-thread`、永不重试。这是 10-21 `updatedAt` 修复的**同族残留**——上次只接回了 `findMany`，漏了 `findFirst`。一行字段名修正 + 拆掉静默吞错即可根治，并已补回归测试。其余 guideSceneId 400 吞错、linkedOutputs 时点错、canvas_action 双发、P4 意图幂等未上线等，属独立待办，不阻塞本修复。
