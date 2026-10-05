# 记忆晋升候选队列 + 抑制标记入口（M6b）设计

- 日期：2026-10-06
- 状态：待评审（判据全部继承 2026-10-04-prompt-engineering-design.md §13.3 的拍板，本文不做新决策，只做工程化落地）
- 前置：M6a（反哺剔除）已随 #182 落地——两侧过滤接线完毕、fail-open 判据经测试锁定、`SuppressionObserver` 结构接口解耦了指标归属。**缺的只是「谁来标记」**（`markSuppressed` 零生产调用方，两侧文件头部均已如实标注）。
- 预算影响：**零**。本设计不新增/修改任何 `prompt-registry/rules/*.md` 条目，L6 静态段余量保持 6（3194/3200）。晋升落地时才会改规则正文，且必须过 6 处同步 + `prompt:lint`。

## 1 背景与缺口

§13.3 拍板的三条落地动作，当前状态：

| 动作 | 状态 |
|---|---|
| ① 晋升候选队列（同画布重复 ≥3 聚合） | **未做**（本轮交付） |
| ② 晋升必须走 PR | 流程已文档化（AGENTS.md 6 处同步），但**候选无人可见** ⇒ 队列是①的前置 |
| ③ 反哺剔除 | 剔除已落地，**标记入口缺位**（M6b 范围，两侧文件头明言） |

缺口的风险面：记忆池只增不减（无 TTL/去重/删除），污染记忆每轮自动注入 5 条；M6a 的止血开关造好了但没有扳手。

## 2 设计

### 2.1 候选队列（动作①）

**聚合判据**：`scope='canvas'` 的行，按 `(sessionId, normalize(content))` 分组，组内行数 ≥3 进候选。

- **「同一画布」= 同一 `sessionId`**（schema 注释：sessionId = Session.id = 画布会话）。
- **「重复出现」= 字面重复**，不做语义/关键词匹配——§13.3 明确拒绝关键词判据（一次性项目名会被误提）；同理**模糊匹配也拒绝**（近义改写不算重复，宁漏勿错：误晋升的成本是全量用户 × 每轮 3194 字符）。
- **normalize**（只做无损归一，不做任何「理解」）：`trim` → 折叠连续空白为单空格 → 小写化 → 去尾部标点（`。.！!？?；;，,、` 反复剥离）。
- **排除 `source='promoted'`** 的行：晋升落库的新行（审计来源）不该再次进候选，否则队列永远显示已处理条目。
- 排除 `scope='user'`：§13.3 分级——用户偏好类不晋升；项目事实/行为纠正类按现网 save_memory 默认落 canvas，能被覆盖。

**排序**：count 降序，同级按最新 createdAt 降序（最热的候选排前）。

**响应字段**（只出事实，不做分级判断——§13.3 的三级分级需要人读内容才能判）：

```jsonc
{
  "candidates": [
    {
      "sessionId": "…",
      "normalizedContent": "…",       // 归一化后的键（人工判读用原文：sampleContents）
      "count": 4,
      "firstSeenAt": "…", "lastSeenAt": "…",
      "memoryIds": ["…"],             // 全部成员行 id —— 抑制/核对用
      "sampleContents": ["…"],        // 原文样本（≤3 条，截断到 120 字）
      "scope": "canvas"
    }
  ],
  "scannedRows": 1234,               // 本次扫描的 canvas 行数（可观测扫描窗口）
  "threshold": 3
}
```

**分页/上限**：扫描窗口 `take ≤ 5000`（SQLite 全表 canvas 行可控，超限截断并在响应标注 `truncated: true`）；候选返回 `limit ≤ 50`（query 参数可调，默认 20）。v1 不做时间窗——记忆表增速低（agent_auto 每轮至多几条），5000 行窗口 + count 排序足够；若日后行数失控再加 `since`。

**端点与鉴权**：`GET /api/agent/memory/promotion-candidates`，**AuthGuard**。
依据 `agent.controller.ts` 中 prompt-registry 端点的既有判据：「免鉴权的安全边界是响应字段本身」。记忆内容是**用户内容**，不是构建元信息 ⇒ 必须鉴权，无第二种选择。

**晋升动作不自动化**：队列只是「让人看见」。人工确认后走既有流程（改 `rules/*.md` + 6 处同步 + `prompt:lint` + PR），操作步骤写进 runbook。为什么不做「一键晋升」：晋升是全局规则变更，§13.3 依据一（撤回成本不对称）+ 「流程是模型唯一绕不过去的地方」，闸必须是人工的。

### 2.2 抑制标记入口（动作③收口）

**谁持有抑制决策**：人工（ops/开发者）。M6a 判据是「反复致错」，当前没有任何自动信号能可靠判定「模型被这条记忆带偏了」（错误检测本身是未解问题）⇒ v1 标记来源 = 人工确认，通过端点下发。

**端点**：`POST /api/agent/memory/suppressions`，AuthGuard，body `{ memoryId, reason }`。

**链路**（两个进程、两张进程内表，刻意不落 DB——M6a 已拍板「抑制是临时止血，重启即失效」）：

```
人工 curl ──▶ Nest POST /api/agent/memory/suppressions
                │
                ├─▶ markSuppressed(memoryId, reason)      // Nest 侧表 → 注入侧过滤立即生效
                └─▶ fetch(PI_RUNTIME_URL + /internal/memory-suppress)   // fail-soft
                          └─▶ pi-runtime markSuppressed(id, reason, metrics)
                                    └─▶ observer → pi_runtime_memory_suppressed_total
```

- **Nest 侧转发 fail-soft**：pi-runtime 不可达/维护态（`PI_RUNTIME_MODE=off`）时只记日志不报错——Nest 侧表已生效（注入是主污染通道），recall_memory 过滤缺失是可接受的降级。响应里如实回报 `forwarded: true/false`。
- **幂等**：两侧 `markSuppressed` 均为集合语义，重复标记不重复计数（M6a 已实现并锁定）。
- **`memoryId` 必须真实存在**：Nest 侧先 `prisma.agentMemory.findUnique` 校验，不存在返回 404——防止把「想删的 id」敲错后静默无效。

**pi-runtime 内部端点**：`POST /internal/memory-suppress`，body 同。无鉴权——pi-runtime 的既有 HTTP 面（`/healthz` `/metrics` `/skills`）均无鉴权，信任边界是 K3s 内网（NodePort 30100 外网不可达，系统地图已核实）。与既有面一致，不单独造鉴权。

**指标接通**：pi-runtime 端点调用 `markSuppressed(id, reason, metrics)`，`Metrics` 结构性满足 `SuppressionObserver` ⇒ **只需在 `metrics.ts` 加 `observeMemorySuppressed()` 方法 + 渲染行**（`memory.ts` 一行不用改，#182 已为此解耦）。⚠️ 跨界说明：`metrics.ts` 在原并行窗口划分中归指标治理线，但该窗口 worktree 已停滞在旧基点 `0e82cac1`（detached），且此处是结构接口既定的对接点、约 10 行——本 PR 内完成，PR 描述明示。

### 2.3 刻意不做（本轮边界）

- **不做自动抑制**（错误检测信号）——判据不可靠时自动「删记忆」比污染更危险（fail-open 论证见 M6a）。
- **不做跨进程表同步/落库**——M6a 已拍板；本设计用「单入口 + 显式转发」收敛，而非持久化。
- **不做晋升一键化/UI**——队列是只读视图，动作走 PR。
- **不动 L6 预算**——零规则改动。

## 3 测试策略（判据必须能真的失败）

| 层 | 判据 | 证伪点 |
|---|---|---|
| 聚合 | 同画布同内容 3 行 → 1 候选 count=3 | 少于 3 不进；跨 sessionId 不合并 |
| normalize | `「主角叫林晚。 」` 与 `「主角叫林晚」` 合并 | 尾部标点/空白/大小写差不分裂 |
| 排除 | `source='promoted'` 行不计入 | 晋升回灌不复活 |
| fail-open | id 空的行进候选池时按内容聚合（聚合层无 id 依赖） | — |
| 标记 | Nest POST 后注入侧 `isSuppressed` 命中 | 404（id 不存在）、幂等不重复计数 |
| 转发 | pi-runtime 不可达时 Nest 仍 200 + `forwarded:false` | fail-soft |
| pi-runtime 端点 | POST 后 recall_memory 结果剔除该条 | 指标 +1 仅首次 |

## 4 文件清单

| 文件 | 动作 | 归属 |
|---|---|---|
| `apps/server/src/agent/agent-memory.service.ts` | + `promotionCandidates()` | R1 |
| `apps/server/src/agent/agent-memory.service.test.ts` | + 聚合测试 | R1 |
| `apps/server/src/agent/memory-suppression.ts` | 不改（`markSuppressed` 已在） | R1 |
| `apps/server/src/agent/agent.controller.ts` | + 2 个端点（队列 / 标记） | R1 |
| `apps/server/src/agent/agent.controller.memory-ops.test.ts` | 新增（端点行为 + 转发 fail-soft） | R1 |
| `services/pi-runtime/src/app.ts` | + `POST /internal/memory-suppress` | R1 |
| `services/pi-runtime/src/metrics.ts` | + `observeMemorySuppressed()` + 渲染行（跨界，见 2.2） | R1（原 R2 边界） |
| `services/pi-runtime/src/app.test.ts` 或新增 | + 端点测试 | R1 |
| `docs/ops/memory-m6b-runbook.md` | 新增（操作手册） | R1 |
| 本文件 + `docs/superpowers/plans/2026-10-06-memory-promotion-m6b.md` | 新增 | R1 |
