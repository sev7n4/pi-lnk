# 任务清单工具化（todo_write）设计规格 — P0+P1【模块章节 C1】

> 日期：2026-10-09
> 状态：待评审
> 上级文档：`docs/superpowers/specs/2026-10-09-task-management-module-design.md`（任务管理模块总体设计/全景视图）——本文是其中的章节 C1，模块分层、设计原则、章节索引与资产维护约定见上级文档。
> 输入：`docs/analysis/2026-10-09-workbuddy-task-planning-benchmark.md`（WorkBuddy 对标报告）+ pi vendor 内核与生态调研（结论沉淀于上级文档 §1）
> 范围：P0（⟦plan⟧ 文本协议升级为内核任务工具）+ P1（任务状态持久化/跨压缩存活）。P2 Plan 确认门、P3 turnBudget、P4 子代理/automations 不在本章节内（见上级文档 §3 章节索引）。

---

## 1. 背景与目标

现状：pi-lnk 的任务规划仅有 `⟦plan⟧`/`⟦task-done⟧` 文本标记协议（`apps/server/src/agent/agent.service.ts:1051` 硬编码），存在三个已确认缺陷：prompt 旁路字符串（不在 prompt-registry 体系）、Nest 侧剥文本、**跨上下文压缩必丢**（prompt 审计文档 W6 遗留项）。

目标：
1. 任务清单升级为 pi-runtime 工具调用，走消息流——天然跨 compaction、天然可持久化、天然进 executionEvents。
2. 事件转译保持现有 `task_list`/`task_update` 形态，**前端零迁移**。
3. 二期（B 期）演进到增量式多工具的扩展缝在一期预留到位。

方案决策（已确认）：
- **方案 A**：单一 `todo_write` 全量覆写工具，服务端 SSOT + diff 派生事件。
- **A1'（调研后细化）**：持久化采用内核原生「tool result details 全量快照 + 分支扫描重建」模式（官方 `examples/extensions/todo.ts` 同构），替代原"session meta"提法——原因见 §7 生态复用：Session Value 在 branch fork 不拷贝应用 namespace（`fork-policy.ts:31`），details 快照则随 entry 天然跟随。
- **旧协议退场**：prompt 停教 ⟦plan⟧（新规则只教新工具）；`planMarkers.ts` 保留为只读重放兼容层（标注 deprecated）；靠 `session-retention` TTL 自然淘汰，验收 = 部署后新产生 `⟦plan⟧` 标记数恒 0。

## 2. 架构总览

```
模型层      todo_write 工具（全量覆写，executionMode="sequential"）
              ↓ details 全量快照（随 session jsonl 持久化，branch fork 天然正确）
状态层      task-state 模块：reduce（diff）+ reconstructState（分支扫描重建）
              ↓ diff 派生增量事件                    ↓ 内存快照
转译层      Nest: task_list / task_update 事件      composeEntryAndObserve 动态 todo 块
              ↓                                      ↓
前端        AgentTaskProgressCard（零迁移）          每请求重注入（跨压缩存活）
```

约束承诺：零 vendor patch、零新 Prisma 表、零新 npm 依赖、pi-runtime 不新增 vendor 子路径 import。

## 3. 组件设计（5 个新增/改动点）

### 3.1 `todo_write` 工具（新，`services/pi-runtime/src/tools/todo.ts`）

- Schema（对齐行业共识签名，参照 Claude Code TodoWrite / Codex update_plan / `@pi-archimedes/todo`）：
  ```ts
  { todos: Array<{ content: string; activeForm?: string;
                   status: "pending" | "in_progress" | "completed" }> }
  ```
- description 明确三条约定：全量覆写（每次必须包含全部任务，漏发即删）、至多一个 in_progress、全部完成时提交空数组清空。
- `executionMode: "sequential"`（内核 `AgentTool.executionMode`，`vendor/.../types.ts:405-411`）防并发覆写竞态。
- execute 流程：校验 → 更新内存快照 → `onUpdate` 推流（管线已通至 SSE `tool_execution_update`，`session-manager.ts:144`）→ 返回 `details` 全量快照（持久化单元）。
- **Kill switch**：env `PI_RUNTIME_TODO_TOOL=off` 时不注册工具；Nest 侧共读同一配置决定是否拼入 prompt 规则（同一 env 双侧同源）。

### 3.2 `task-state` 模块（新，`services/pi-runtime/src/tools/task-state.ts`）

纯函数模块，与工具实现分离——**此模块即 B 期扩展缝**：
- `reduce(prev, next)`：全量 → 全量 diff，产出 `{ list?, updates[] }`（新增项、状态变化项、消失项）。
- `reconstructState(branch)`：扫描 branch 上最后一个 `todo_write` 的 toolResult details 重建快照（抄官方 todo.ts `reconstructState` 骨架，`coding-agent/examples/extensions/todo.ts:114-129`）。
- 预留 B 期入口签名：`applyIncremental(snapshot, op)`（一期不实现，类型与文档占位在模块注释中说明）。

### 3.3 事件转译（改 Nest，`apps/server/src/agent/agent.service.ts`）

职责切分：**diff 在 pi-runtime 侧产出**——工具 execute 内调 `reduce` 算出增量，`details` 载荷固定为 `{ snapshot, diff }`（快照供持久化/重建，diff 供转译）；**Nest 只做映射**：工具结果流经现有 tool-result 通路时，把 details.diff 映射为现有 `task_list`（items id=`plan-<n>`，status=running）与 `task_update`（status=done/running）事件，并收集进 executionEvents 持久化（刷新重放沿用现有机制，`agent.service.ts:1330-1354` 改造点）。

### 3.4 跨压缩注入（改 `services/pi-runtime/src/session-manager.ts`）

`composeEntryAndObserve` 的 dynamicBlocks 追加 todo 块：读内存快照（reconstructState 结果），渲染为紧凑清单文本，走现有动态预算截断机制（byte-stable）。system prompt 每请求重解析（内核 `generation.ts:56-66`），压缩不动 system prompt → 内容天然跨压缩存活。零快照时不注入（零成本）。

### 3.5 prompt 规则迁移（prompt-registry + Nest）

- `prompt-registry/rules/` 新增 task-tool 规则：「何时建清单」定性判据（多步任务、≥3 步）+ 工具用法，注册进 MANIFEST 定序。
- 删除 `agent.service.ts:1051-1059` 的 `⟦plan⟧` 硬编码指令段。
- `planMarkers.ts` 保留只读解析（JSDoc 标注 deprecated + 退场条件：session-retention TTL 覆盖历史会话后删除）。

## 4. 数据流

- **写**：模型调 `todo_write` → 校验 → reduce diff → ① SSE 事件实时推 ② 事件进 executionEvents（重放）③ 全量快照落 tool result details（持久化）。
- **恢复**：resume/进程重启 → reconstructState 扫 branch → 内存快照 → dynamicBlock 注入。历史会话（只有 ⟦plan⟧ 标记）走 planMarkers 只读解析；两源互斥：有任一 todo_write 快照后新清单即 SSOT（模型接手，旧卡片被同名 id 的 task_list 事件自然覆盖）。
- **fork**：branch fork 拷贝 toolResult entries → 快照自动正确，无需额外 fork 策略（对比：Session Value 需要显式地址策略，已规避）。

## 5. 错误处理与边界

| 场景 | 处理 |
|---|---|
| schema 畸形（非数组/缺 content） | JSON schema 校验拒绝，isError 返回 |
| 语义违规（>1 个 in_progress） | **不硬校验不矫正**：状态照实传输（全量即真相），工具结果文本一次性提醒；避免硬失败浪费轮次 |
| 空 todos 数组 | 合法 = 清空清单（对齐 TodoWrite 清空约定） |
| 模型漏发历史项（增量习惯） | description 明示"必须包含全部任务"；diff 侧对 n 序列断裂打 warn 日志（`GenerationRecord.metadata` 同款可观测降级，无 metrics 设施现状下的约定） |
| resume 后无任何 todo_write | 快照为空，dynamicBlock 不注入 |
| kill switch off | 工具不注册 + prompt 规则不拼入（双侧同 env） |
| prompt 预算超限 | 新增 ≈150–250 token，余量 124/3200；实现计划阶段实测，超则从低频规则（canvas_daily_ops 族）压缩腾挪 |

## 6. 测试策略

1. `task-state` 单测：reduce（新增/状态变/删除/清空/乱序/重复提交幂等）、reconstructState（多快照取末、无快照、分支截断）。锁行为不锁数字。
2. 工具真 harness 测试：`AgentHarness.create` + faux 模型（沿用 `session-manager.toolmetrics-realharness.test.ts` 模式）——注册、执行、details 快照、onUpdate、sequential 串行。
3. 事件转译集成：mock 模型调用 → SSE `task_list`/`task_update` 断言 + executionEvents 收集断言。
4. resume 测试：磁盘 resume 后快照恢复 + dynamicBlock 注入内容断言。
5. kill switch：off 时无工具 + prompt 无规则段。
6. 兼容回归：含 `⟦plan⟧` 的历史 executionEvents 重放仍渲染卡片。
7. 上线验收（生产）：真实多步任务手工观察；部署后 SQL/日志验证新 `⟦plan⟧` 产生 = 0（对齐"占位图=0"验证手法）。
8. CI 无外部二进制依赖，无环境型假阴性风险。

## 7. 生态复用对照表（吃满 pi-agent，不重复造轮子）

| 能力 | 来源 | 采用方式 |
|---|---|---|
| details 快照 + 分支扫描重建 | 官方 `coding-agent/examples/extensions/todo.ts` | 抄状态管理骨架（ExtensionAPI 不可 import，仅模式同构） |
| 工具 schema/状态机 | Claude Code TodoWrite + Codex update_plan + Gemini write_todos + `@pi-archimedes/todo` | 行业共识签名（全量覆写 + 3 态 + 至多一个 in_progress） |
| diff 事件派生 | 无生态先例（三家均 UI 层自行 diff） | 自研（本设计超出生态的增值点） |
| kill switch/按需注册 | pi 作者"todo 增加模型负担"批评 + `setActiveTools` 哲学 | env 开关 |
| context rot 防护 | Gemini 社区 write_todos 文件持久化 PR 的教训 | dynamicBlock 字节预算控制 |
| 内核原生面 | `AgentTool.executionMode` / `onUpdate` / 每请求重解析 systemPrompt | 直接使用，无 patch |

上游不可复用项（明确记录）：pi 作者明确拒绝内置 todo（README: "No built-in to-dos. They confuse models."），0.85.1→1.1.0 上游无任何任务规划能力——**内核级现成包不存在，自建是唯一路线**。

## 8. 二期演进规划（A → B，本规格的强制预留）

**触发条件**（满足其一才启动，YAGNI 纪律）：
1. P4 子代理落地，出现"并行子代理各自维护清单"需求（全量覆写将互相覆盖，id 化成为刚需）；
2. 产品要求跨会话任务管理 / 任务树 / 依赖图。

**预留的升级点**（一期已锁定，二期不动）：
1. `task-state` 纯函数模块：二期只需实现 `applyIncremental(snapshot, op)` 并新增 `task_update` 等增量工具注册（入口 fold 进全量快照后走同一管道）；`todo_write` 保留不删，可混用。
2. 稳定 id：一期事件 id 沿用位置序 `plan-<n>`；二期由服务端在快照 item 上增加 `id` 字段（schema 增字段，向后兼容，前端 reconcile 不受影响）。
3. 不变面承诺：事件格式（`task_list`/`task_update` 本就是增量形态）、存储（details 快照）、前端、`composeEntryAndObserve` 注入逻辑、planMarkers 兼容层、无新增表——二期全部不碰。
4. 二期成本预估：1 次工具注册 + 1 个 fold 函数 + fold 单测，不触前端/存储/迁移。

**反向不可行说明**：B → A 无升级路径（增量序列无法重建 SSOT），故一期必须守住「全量快照 = SSOT」纪律，这是 A 是 B 严格基座的根因。

## 9. 风险与开放问题

1. **上游 1.0.0 breaking**：上游已将 harness（AgentHarness/session/compaction/skills）整体迁出至新包 `pi-durable`；vendored 0.85.1 是 harness 完整在 pi-agent-core 内的最后一个稳定形态。本设计所有落点（details、sequential、composeEntryAndObserve、EVENT_MAP）在触发 upmerge 评审（≥3 minor，D-γ' 纪律）时必须重新映射，规格随 upmerge 重审。
2. **模型遵循度**：全量覆写依赖模型每次带全量清单；漏发即误删。靠 description 强约定 + n 序列断裂告警兜底，上线后观察误删率，必要时加"删除需显式 status"启发。
3. **prompt 预算**：见 §5 表；实测责任在实现计划阶段。
4. **开放问题**：`⟦plan⟧` 老会话与新工具并存窗口（§4 fork 路径）的 UX 细节——卡片覆盖时机由前端 reconcile 决定，建议实现期用一次真实老会话 resume 验证。

---

## 附：证据索引

- 内核：`vendor/earendil-works/pi/packages/agent/src/types.ts:387-412`（AgentTool）、`harness/runtime/drive/tool-placement.ts:202-216`（addedToolNames 持久化）、`harness/session/fork-policy.ts:10-32`（应用 namespace branch fork 不拷贝）、`harness/runtime/drive/generation.ts:56-66`（systemPrompt 每请求重解析）、`harness/session/context.ts:35-39`（compaction 投影）、`agent-harness.ts:430-500`（HookMap 使用现状）。
- 官方范例：`packages/coding-agent/examples/extensions/todo.ts`（297 行）、`examples/extensions/plan-mode/`。
- pi-runtime：`src/tools/config.ts:58-72`（工具装配）、`src/session-manager.ts:144`（SSE 映射）/`:460-487`（composeSystemPrompt）/`:919-952`（harness options）、`src/session-manager.toolmetrics-realharness.test.ts`（真 harness 测试模式）。
- Nest：`apps/server/src/agent/agent.service.ts:1051-1059/1330-1354`、`apps/server/src/agent/planMarkers.ts`、`prompt-registry/rules/` + MANIFEST。
- 生态：github.com/earendil-works/pi（README "No built-in to-dos"）、npm `@pi-archimedes/todo`、Claude Code TodoWrite / Codex update_plan / Gemini write_todos 官方签名文档、pi 上游 CHANGELOG 1.0.0（harness → pi-durable）。
