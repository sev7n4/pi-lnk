# 任务管理/任务规划模块 总体设计（全景视图）

> 日期：2026-10-09 · 版本 v1 · 状态：待评审
> 定位：本模块的**骨架文档**。两份调研为输入，引出模块目标架构与分期章节；各期实现规格是本文档的章节，独立成文、从这里索引。
> 本文随章节落地与上游演进持续维护，维护约定见 §7。

---

## 1. 输入资产（两份调研）

### 输入一：WorkBuddy 蒸馏逆向 × pi-lnk 现状对标

全文：`docs/analysis/2026-10-09-workbuddy-task-planning-benchmark.md`

核心结论摘要：

- WorkBuddy 任务规划 = **七层架构**：L1 任务实体（Task 一等公民、6 态状态机、失败可续、消息队列）→ L2 模式层（Agent/Plan/Ask 放手程度光谱，Plan=先方案后执行）→ L3 步骤透明化（步骤卡片/阶段说明/耗时）→ L4 并行执行（子代理+专家团）→ L5 规模控制（500 turns、并发 20、预算 200、run 超时 30min，**硬边界不可禁用**）→ L6 能力扩展（Skills/Experts/Connectors，授权后自动续跑）→ L7 调度（Automations）。
- 四条设计原则：放手程度光谱、状态机即产品语言、失败是路径不是终点、规模必须有硬边界。
- pi-lnk 差距（对标）：任务清单仅 `⟦plan⟧` 文本协议（跨压缩必丢，W6 未做）；无任务持久化；无 Plan 模式（仅生成域 HITL gate）；无 max_turns；无子代理；无 automations。**强项**：resume 双路径、Skills 渐进披露、内核 loop 质量。

### 输入二：pi vendor 内核能力与生态调研

对象：`vendor/earendil-works/pi`（`@earendil-works/pi-agent-core@0.85.1`，vendor 日期 2026-09-23）。

**内核能力满足度**（全部有证据，详见 todo_write spec 附录）：

| 内核原生面 | 位置 | 本模块用途 |
|---|---|---|
| `AgentTool.executionMode: "sequential"` | `agent/src/types.ts:405-411` | todo_write 防并发覆写 |
| 工具结果 `details` 随 jsonl 持久化 | `harness/session/*` | 任务快照持久化单元 |
| 分支扫描重建模式 | 官方 `examples/extensions/todo.ts:114-129` | resume/fork 后状态重建 |
| system prompt 每请求重解析 | `generation.ts:56-66` + pi-runtime `composeEntryAndObserve` | 跨压缩重注入（压缩不动 system prompt） |
| Session Values KV / custom entry + entryProjectors | `harness/session/values.ts`、`types.ts:52-62` | 备选持久化位（有 fork 语义坑，见下） |
| `onUpdate` 流式更新 → SSE | `session-manager.ts:144` | 清单实时推送 |
| 未用 hooks：`before_run`/`before_run_end`/`before_navigation` 等 | `agent-harness.ts:430-500` | P2 Plan 门预留落点 |

**关键坑位（调研实锤 + 评审修正 2026-10-09）**：
1. Session Value 应用 namespace 在 **branch fork 不拷贝**（`fork-policy.ts:31`）→ 持久化选 details 快照而非 Value。
2. custom entry 在压缩点前被 `stopAtType:"compaction"` 截断（`transcript.ts:60`）→ 不走 custom entry 注入。
3. **上游 1.0.0 breaking**：harness（AgentHarness/session/compaction/skills）整体迁出到新包 `pi-durable`；vendored 0.85.1 是 harness 完整在 core 内的最后稳定形态。**所有章节设计在触发 upmerge 评审（≥3 minor，D-γ' 纪律）时必须重新映射落点。**
4. **AgentLoop 钩子 ≠ harness 钩子**：`shouldStopAfterTurn`/`prepareNextTurn` 等属于低层 AgentLoop（pi-runtime 未使用），harness 不暴露它们，且上游 0.87.0 已移除 `shouldStopAfterTurn`——本模块任何章节不得以 AgentLoop 钩子为落点，一律用 harness hooks（`before_tool`/`before_run_end`/`before_compaction` 等）。

**生态结论**：
- 上游明确拒绝内置 todo（README："No built-in to-dos. They confuse models."），0.85.1→1.1.0 无任何任务规划能力 → **内核级现成包不存在，自建是唯一路线**。
- 可抄骨架：官方 `coding-agent/examples/extensions/todo.ts`（details 快照+分支重建）、`examples/extensions/plan-mode/`（P2 章节蓝本）。
- Schema 行业共识：全量覆写 + `{content, status: pending|in_progress|completed}` + "至多一个 in_progress"，均无 id（Claude Code TodoWrite / Codex update_plan / Gemini write_todos；社区 `@pi-archimedes/todo` 同构）。
- 风险共识：pi 作者认为 todo 状态追踪增加模型负担 → 工具可关闭（kill switch）；Gemini 社区 context rot 教训 → 重注入做字节预算。

## 2. 模块目标架构（从调研引出的设计）

### 2.1 目标分层（WorkBuddy 七层 → pi-lnk 分期落地）

| WorkBuddy 层 | pi-lnk 目标形态 | 落地章节 |
|---|---|---|
| L1 任务实体 | 会话内任务清单（工具化 + details 快照持久化 + 跨压缩存活） | **§C1（已上线：2026-10-09 生产验收通过）** |
| L2 模式层 | Plan 确认门（generation-gate 泛化为通用确认门；**拦截用 `before_tool`（HITL gate 同款，已验证可用），方案确认后追加执行轮用 `before_run_end {followUp}`**） | §C3 |
| L3 步骤透明化 | 由 C1 事件流 + 现有 AgentTaskProgressCard 承载（零迁移） | §C1 |
| L4 并行执行 | 只读 Explore 型子代理（fork + 独立 session） | §C4 |
| L5 规模控制 | turnBudget 硬边界 + kill switch 族 | §C2（P3 搭车） |
| L6 能力扩展 | 已达标（Skills 渐进披露），无新章节 | — |
| L7 调度 | Automations（新子系统） | §C5（远期） |

### 2.2 设计原则（本模块所有章节共同遵守）

1. **全量快照 = SSOT**：任何任务状态操作先 fold 进全量快照再派生（A→B 单向兼容的根因）。
2. **前端零迁移优先**：新能力尽量转译为现有事件形态（`task_list`/`task_update`），协议演进不改前端。
3. **内核原生面优先**：先查 vendored 内核与官方 examples，再自研；禁止 patch vendor。
4. **硬边界可关不可破**：kill switch 只做整体开关，不做半开语义；规模类默认值宁紧勿松。
5. **可观测降级**：无 metrics 设施现状下，用 `GenerationRecord.metadata`/结构化日志承载行为统计。

## 3. 分期章节索引

| 章节 | 内容 | 文档 | 状态 |
|---|---|---|---|
| **C1** | 任务清单工具化（todo_write 全量覆写 + details 快照持久化 + 跨压缩重注入）——P0+P1 | `docs/superpowers/specs/2026-10-09-task-tool-design.md` | **已上线（2026-10-09，PR #319 → `75d3105e`；生产断言 14/14 + 用户视角端到端演示通过；遗留前端消费 activeForm/status 记入 C1 台账 deferred）** |
| **C1-B** | 二期：增量式多工具（task_create/update/list），B=「A 基座 + fold 增量入口」 | 概要见 C1 spec §8；立项时独立成文 | 未立项（触发条件未满足） |
| **C2** | turnBudget 轮次硬边界（小件，可与任一章节搭车） | `docs/superpowers/specs/2026-10-10-turn-budget-design.md` | **已立项（2026-10-10）**：per-run turn 计数（runId 匹配排除 compaction 轮）+ 软着陆 steer（预算-10 一次）+ 超限硬停（复用 stall watchdog 结算路径）+ `PI_RUNTIME_TURN_BUDGET=120/off` |
| **C3** | Plan 确认门（generation-gate 泛化 + 会话级 planMode） | `docs/superpowers/specs/2026-10-10-plan-gate-design.md` | **已实现（2026-10-10，PR #329；生产部署 + 行为断言见 prod-deploy-verify）**：propose_plan + plan-gate（before_tool 拦写 + before_run_end followUp 执行轮）+ transcript 播种 + kill switch PI_RUNTIME_PLAN_GATE |
| **C4** | 子代理（只读 Explore 型先行；并发/预算/超时三件套硬编码紧默认：全局并发 2 / turn 预算 30 复用 C2 / 超时 5min 复用 watchdog 结算） | `docs/superpowers/specs/2026-10-10-c4-subagent-design.md` | **已立项（2026-10-10）**：spawn_subagent 工具化自主派发 + 严格只读白名单 + 纯 fork 载体 + 同步阻塞返回（报告=工具结果，卡片透出，transcript 落盘无 UI）；一期不依赖 C1-B（只读语义下依赖环消解，见该 spec §4-5） |
| **C5** | Automations（cron 设施 + 无人值守护栏） | 未成文 | 未立项（新子系统） |

章节立项规则：每个章节独立走 spec → plan → implementation 循环；立项前在本文更新状态列；与 C1 有接口依赖的章节（C3 依赖 C1 的事件管道；C4 一期**不依赖 C1-B**——「依赖 id 化」在只读子代理语义下是伪依赖，已裁决消解，见 C4 spec §4-5）须回读前章 spec 的「不变面承诺」。

## 4. 当前章节：C1 任务清单工具化（P0+P1）

全文：`docs/superpowers/specs/2026-10-09-task-tool-design.md`。一句话：`todo_write` 单工具全量覆写（方案 A）+ details 快照持久化与分支重建（A1'，内核原生模式）+ diff 派生现有事件（前端零迁移）+ dynamicBlock 跨压缩注入 + ⟦plan⟧ 只读兼容退场。零 vendor patch、零新表、零新依赖。

## 5. 二期演进总览（A → B）

详细预留设计在 C1 spec §8（强制条款），本节只记模块级视角：

- **本质**：B 不是重构，是 C1 状态模块（`task-state`：reduce/reconstructState 纯函数）之上的**增量语法糖**——新工具 fold 进全量快照后走完全相同的 diff→事件→持久化管道。
- **触发条件**（满足其一才立项）：①C4 子代理落地出现并行清单需求；②产品要求跨会话任务管理/任务树/依赖。
- **升级点**：1 次工具注册 + `applyIncremental` fold 函数 + 快照 item 增稳定 id 字段（向后兼容）。
- **不变面**：事件格式、details 存储、前端、注入逻辑、⟦plan⟧ 兼容层、无新增表。
- **红线**：B→A 反向不可行——C1 及以后任何章节不得引入"绕过全量快照直接改状态"的旁路。

## 6. 与其他模块的边界

- **画布 workflow recipe**（`UserWorkflowRecipe`）：是画布模板编译，不是任务编排，不并入本模块；C5 立项时再评估是否收编。
- **GenerationRecord/GenProgress**：生成域执行进度，与任务清单互补不重叠；C1 只消费事件管道不碰生成记录。
- **Skills**：C1 的 prompt 规则不写成 skill（规则属 prompt-registry 体系；skill 是分阶段领域流程）。

## 7. 资产索引与维护约定

**资产地图**（维护顺序：上→下为依赖方向）：

```
docs/analysis/2026-10-09-workbuddy-task-planning-benchmark.md   输入一：对标分析（调研快照，不随实现更新）
docs/superpowers/specs/2026-10-09-task-management-module-design.md  ← 本文：模块全景（骨架，随章节推进维护）
docs/superpowers/specs/2026-10-09-task-tool-design.md            章节 C1：P0+P1 规格（随实现/评审更新）
docs/superpowers/specs/2026-10-10-plan-gate-design.md            章节 C3：Plan 确认门规格（2026-10-10 立项）
docs/superpowers/specs/2026-10-10-turn-budget-design.md          章节 C2：turnBudget 轮次硬边界规格（2026-10-10 立项）
docs/superpowers/specs/2026-10-10-c4-subagent-design.md          章节 C4：子代理（只读 Explore 型）规格（2026-10-10 立项）
（未来）C1-B / C5 各自 spec                                              章节：立项时创建
```

**维护规则**：
1. 章节状态变化（立项/评审通过/合入/上线验收）→ 更新本文 §3 状态列 + 本节资产地图。
2. 上游 upmerge 触发（≥3 minor）→ 重审 §1 输入二「关键坑位」是否漂移，逐章节确认落点（1.0.0 harness→pi-durable 拆分是最大风险源）。
3. 调研类文档（输入一/输入二原始结论）为**时点快照**，不回写；新结论以增量小节追加进本文 §1 并标日期。
4. 每次更新本文须同步 `.workbuddy/memory/` 日志一条（跨会话可发现性）。

---

## 附：pi vendor 调研完整证据索引

- 包结构：`vendor/earendil-works/pi/packages/`（agent/ai/coding-agent/chord/client/protocol/server/telemetry/tui/evals/session-backends，均 0.85.1）；pi-runtime 实际 import 仅 `pi-agent-core`（主入口+`/node`）与 `pi-ai`（主入口+`/api/openai-completions.lazy`）。
- 工具机制：`agent/src/types.ts:387-412`（AgentTool：prepareArguments/replay/executionMode）、`:362-376`（AgentToolResult.addedToolNames，`tool-placement.ts:202-216` 持久化到 laneConfig）、`harness/execution/tools.ts:133-157`（onUpdate 管线）。
- 会话状态：`harness/session/values.ts:22-36,98-145`（Values API，事务原子）、`types.ts:52-62`（CustomEntry/EntryProjector）、`jsonl/repo.ts:78-86`（header 即元数据）、`fork-policy.ts:10-32`（**应用 namespace branch fork 不拷贝**）。
- 压缩：`harness/compaction/compaction.ts`（shouldCompact:246/默认设置:157/prepareCompaction:634）、`agent-harness.ts:488-495`（before_compaction，pi-runtime 已用于图片标注 `session-manager.ts:964-1002`）、`session/context.ts:10-39`（压缩后重建）。
- 官方范例：`coding-agent/examples/extensions/todo.ts`（297 行）、`examples/extensions/plan-mode/`（mitsuhiko）。
- 上游：npm dist-tags latest=1.1.0（2026-10-07）；CHANGELOG 1.0.0（2026-10-01）breaking 移除 harness → `pi-durable`；0.85.1 之后无 todo/task/plan 能力。
- 生态：github.com/earendil-works/pi（原 badlogic/pi-mono，2026-05 迁移）、pi.dev/packages（marketplace）、npm `@diegopetrucci/pi-todo`、`@pi-archimedes/todo`、`@fbraza/pi-todo-store`、`pi-beads-extension`；设计哲学来源 mariozechner.at/posts/2025-11-30-pi-coding-agent/。
