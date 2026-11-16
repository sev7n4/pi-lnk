# 阶段 C③ · pi-durable 迁移评估 + 概念 backport 候选（立项规格）

> 日期：2026-11-16 · 状态：立项落档（评估框架，非实施授权）· 触发：路标 §5.2 阶段 C③ 欠账 + §17.2 升级裁决（「1.0.0 upmerge 预研」→「pi-durable 迁移评估」）
> 按 v1.3 规格生命周期冻结：细化只进本文，路标只回填状态行。
> 上游版本基线：vendored **pi 0.99.2**（`vendor/earendil-works/pi`），冻结期间「吃满上游」= **概念 backport，非版本升级**（§17.2 裁决）。

## 1. 问题背景与定位

路标阶段 C③ 原文两项欠账：

1. **HookMap 依赖面收敛** —— 大部由后续刀覆盖（`scripts/verify-tool-contract.ts` 存续 + 各刀行为级 wiring 测试与源码文本锁，#868/#906/#912 演进）；「收敛到可机检范围」的全量机检仍有余量，但不构成阻塞项，本文不重复立项；
2. **1.0.0/`pi-durable` 迁移映射预研** —— §17.2 已将「upmerge 预研」升级为「harness→durable 的**架构迁移决策评估**」，性质完全不同：upmerge 暗示版本推进，实际是换运行时底座。本文就是这项评估的立项落档。

**本文定位**：评估框架 + 上游取证 + 三个 backport 候选登记（数据触发后各自独立立项）。**不实施、不迁移、不改 vendor**（路标红线）。

## 2. pi-durable 现状取证（0.99.2 vendor 树，逐条锚点）

| # | 事实 | 锚点 |
|---|---|---|
| 1 | `packages/durable` 已在 0.99.2 vendor 树内；README 首行声明 **Experimental，API 跨版本无预警变更** | `packages/durable/README.md:1-4` |
| 2 | 形态：`Harness.open(storage)` → `Conversation`（不可变 entry 账本）→ `commit(tx)` 原子写入（entry+document+task 同事务）；内置 document：`pi.conversation.config` / `pi.live` / `pi.inbox` / `pi.usage` | `durable/README.md` Concepts 节 |
| 3 | Compaction：摘要落 `pi.compaction` entry（旧 entry 留存储）；自动 compaction 三参数（`reserveTokens`/`keepRecentTokens`/`backgroundTokens`）；**后台 compaction 不阻塞会话**，idle 即放置否则下一 turn 边界；上下文超长被 provider 拒时 compaction 重试一次；多摘要并发以 `stale` 收敛（最远切点生效）；`beforeCompact` hook 可拒绝或自供摘要 | `durable/README.md` Compaction 节 |
| 4 | 事件面：`compaction_start`/`compaction_end` agent events + snapshot `compactions` 字段（与我们 B-1/B-2 的事件打点同构） | 同上 |
| 5 | coding-agent 层 compaction 演进：split-turn summary 措辞修复（#9908）、retain-none compaction（`appendCompaction(summary, null, tokensBefore)`，压缩自身 entry 即保留边界）、per-model `reserveTokens`/`keepRecentTokens` 覆写 | `packages/coding-agent/CHANGELOG.md:159,184,232,247` |
| 6 | 工具输出截断：durable 层 `truncate.ts` 双限（2000 行 / 50KB），**摘要（compaction summary）无长度上限**——关键状态不被预算截断是上游设计取向 | `durable/src/truncate.ts:1-27` |

## 3. 迁移评估框架（决策矩阵 + 触发条款）

### 3.1 收益面（durable 相对现行 harness = pi-agent-core 0.99.2 + 自建 session-manager）

| 收益 | 现行已覆盖度 | 真实增量 |
|---|---|---|
| 原子 commit（entry/document/task 同事务） | 部分：session-manager 有 JSON 往返归一 + 事务纪律（生产 DB 写守卫），但非账本级原子 | 中 |
| 崩溃恢复（进程死于 turn 中，重开续跑） | 弱：现依赖 run 语义 + PVC session 文件重放 | 高（K3s pod 重启场景真实存在） |
| compaction 后台化 + stale 收敛 | 无：现 compaction 同步阻塞 run | 高（今日生产 10 次/单会话/单日的 threshold compaction 是实证压力） |
| usage/document 一等化 | 部分：B-2 #912 已建 stats.usage 投影（vendor SessionStats 白拿） | 低-中 |
| fork 分支账本语义 | 部分：toolResult 分支拷贝已有 | 中 |

### 3.2 成本面（决定论：迁移 = 全量重写面）

现行 pi-runtime 在 harness 上已建全套自研层：plan-gate + toolset-overlay（B-1）、task-entry 账本 + pickLatest 单源化（B-2）、C-2a/b acceptance oracles、eval runner/driver、SSE 桥、K3s 部署面。durable 的 entry/document/task 抽象与上述每一层都有接口错位——**迁移不是适配而是重写**，且 durable 自标 Experimental。

### 3.3 裁决框架（何时重审）

- **默认不迁移**（维持 0.99.2 冻结 + 概念 backport 策略，路标 §17.2 既有裁决）。
- 触发重审条款（满足任一，走独立立项）：
  1. durable 脱离 Experimental（上游声明 API 稳定）且发布迁移指南；
  2. 生产 compaction 压力实证阻塞（如 compaction 期间 run 延迟或失败率可观测恶化，`pi_runtime_task_entry_*` / eval run 数据触发）；
  3. 部署形态演进到形态 B（客户端 APP，路标 §16.8/§16.3 触发条件）且崩溃恢复成为产品需求。

## 4. 三个概念 backport 候选（登记，各自数据触发后独立立项）

### ① compaction 摘要不设长度上限（关键状态不被预算截断）

- **上游证据**：durable compaction summary 无上限（§2 事实 3/6）；retain-none 语义保证压缩自身 entry 成为保留边界（§2 事实 5）。
- **本项目对应欠账**：B-2 `lnkpi.task` custom entry 32KB 逐级截断（snapshot 尾条目→diff→全量→放弃）。截断是防账本膨胀的保守选择，但「长任务清单被截断」与上游「关键状态完整保留」取向相反。
- **候选小刀形态**：观察 `pi_runtime_task_entry_truncated_total` 计数器——**零样本则不动**（极简纪律）；出现真实截断样本时立项评估「任务快照免截断」或「截断阈值上抬」，携带样本数据立项。

### ② codemode 排队思想（spawn_subagent parallel 模式队列语义参照）

- **上游证据**：codemode worker = QuickJS 单线程 microtask 队列，host 回执 `settle` 后 `executePendingJobs()` drain；`stalled()` 检测「无悬空 promise 的脚本」并 fail（`codemode/src/runtime/worker.ts:118-137`）。
- **本项目对应**：spawn_subagent parallel 模式（路标 §16.9/§17.2 已登记编排模式为阶段 B 增补项）实现时的队列语义参照：作业排队 → 逐个回执 → drain → 悬空检测 fail，而非自建 DAG 调度器（§5.3 No-Go 维持）。
- **触发**：spawn_subagent 持续用量实证（7 天/200 run 复核通过）+ parallel 编排真实需求出现时立项。

### ③ cache warming / prompt cache 主动预热（成本优化面）

- **上游证据**：ai 包 provider 层有 cache 面板（`ai/src/api/openai-responses.ts` 等）；durable README Usage and Cost 节内建 `pi.usage` document。
- **本项目对应**：B-2 #912 已建 `totalCacheReadTokens` 聚合通道（eval 报告 + LaneSnapshotProjection stats.usage）——**观测面已就绪**，这是三候选中欠账最少的一个。
- **触发**：多 run 累积的 cache_read 对照数据（agnes 解锁后 35/run）显示 cacheRead 占比异常低时，立项评估 eval 跑批的 cache warming（如固定前缀预热）。与 G2 累积计划共用数据面，不单独跑批。

## 5. No-Go 与诚实边界

- **不迁移 durable**：默认裁决维持，本文不构成任何代码授权。
- **不做版本 upmerge**：0.99.2 冻结策略不变（路标 §17.2）。
- **不提前实施三个 backport**：全部「登记 + 数据触发」，零样本不动（极简哲学 §19.1）。
- **取证版本局限**：全部基于 vendor 树 0.99.2 静态取证 + README/CHANGELOG，未跑上游 durable 任何运行时验证（Experimental 形态下也不值得跑）；上游 master 可能已演进，触发重审时重新取证。
- HookMap 收敛项不在本文范围（§1 已说明实质覆盖路径）。

## 6. 状态

| 项 | 状态 |
|---|---|
| durable 迁移评估框架 | ✅ 本文落档（默认不迁移，触发条款 §3.3） |
| backport ①（compaction 摘要上限） | 登记，等 `pi_runtime_task_entry_truncated_total` 样本 |
| backport ②（codemode 排队） | 登记，等 spawn_subagent parallel 真实需求 |
| backport ③（cache warming） | 登记，等多 run cacheRead 对照数据（观测面已就绪） |
| 阶段 C③ 收口 | ✅ 本 PR 合并即收口（HookMap 项见 §1 说明） |
