# Agent Harness 缺口审视（2026-09-29）

状态：审视结论已确认（2026-09-29），P0-②③ 优先推进；① 需立项走 brainstorming + writing-plans
前置：pi-runtime 0.0.12（生产 tag）；vendored pi v0.85.1；老 LangGraph runtime 已退役（2026-09-27）
分支约定：实现走 feature 分支 + PR + squash merge。

## 0. 配图索引（结构与视觉两类，均随本文档演进）

本文档为架构审视记录，**无 Mermaid 结构图、无视觉稿**——全部结论以代码文件路径 + 行号引用承载，读者按引用直达源码即可复核。

| 编号 | 形式 | 内容 | 位置 | 用途 |
|---|---|---|---|---|
| — | 无 | 本文档无配图 | — | — |

## 1. 审视范围与方法

以 Claude Code / Codex / WorkBuddy 等 agent 产品的 harness 设计标准，对照 pi-lnk 全链路源码逐层核查：

- pi-runtime 侧：`services/pi-runtime/src/**`（39 文件：SessionManager、tools/registry、skills、gate、metrics）
- Nest 编排侧：`apps/server/src/agent/**`（agent.service、pi-runtime.client、pi-events、prompt-assembler、compress-recent-turns）
- vendored pi 能力面：`vendor/earendil-works/pi/packages/agent/src/harness/**`（hooks.ts 11 种 hook、compaction/、runtime/lane.ts、telemetry.ts）

## 2. 总体判断

**工具层、安全层、HITL gate 扎实**（toolContext fail-closed、BYOK 错账防护、gate 拦截归因观测均为同类产品良好实践），但存在一个**架构级根本缺口**（§3.1 会话记忆）和三类**能力闲置缺口**——vendor pi 提供的重型能力大部分未接上（利用率约 20%：11 种 hook 仅用 before_tool/after_tool，compaction 0 调用，telemetry 未接）。

## 3. P0：架构级缺口

### 3.1 每轮重建会话，记忆架构是「文本截断」而非「会话持久化」

**实证**：
- `apps/server/src/agent/agent.service.ts:750`（streamFromPiRuntime finally）：每轮结束 `client.deleteSession(sessionId)`；
- `services/pi-runtime/src/session-manager.ts:323`（remove）：`rm -rf` 整个会话目录——`JsonlSessionRepo` 落盘的历史**每轮都被物理删除**；
- `session-manager.ts:749` 注释「历史已由 JsonlSessionRepo 落盘」与实际行为矛盾（落了盘随即被删）。

**真实记忆形态**：仅 `compress-recent-turns.ts`（近 4 轮、assistant 截 160 字、工具结果截 120 字）注入 system prompt（`pi-prompt-assembler.service.ts:163`）。工具调用细节、生成产物 url、多步推理链全部丢失；画布 SSOT 只能部分补偿（节点详情须工具再查）。

**能力闲置**：vendored pi 的 compaction / branch-summarization（`harness/compaction/`）、`lane.compact()`（`runtime/lane.ts:1200`）**全链路 0 调用**。

**补齐方案**：以 threadId 为键持久 harness 会话——每轮复用、历史进原生 context，超限走 vendored compaction。随之可退役三套为「每轮重建」而生的补丁机制：`createSessionReplacingStale`（pi-runtime.client.ts:132）、`acquirePiSessionLock`（agent.service.ts:611）、409 竞态处理。**另加退役两处同源补丁**：`compressRecentTurns`（历史进 context 后，「近 4 轮文本摘要」既是重复注入也是信息损失）与 Nest 侧 `AgentMessage` 历史查询链（每轮白查一次 DB）。

> 实施状态：已落地（见上）。实际退役 5 处：`createSessionReplacingStale` / `acquirePiSessionLock`(+`piSessionChains`) / 409 竞态容错 / `compress-recent-turns.ts` / `AgentMessage` 历史查询；新增 pi-runtime 侧会话 TTL + 磁盘 LRU（活跃会话双豁免）、同键并发 409 守卫、4 项会话指标、7 项 env。

**代价与对策**：pi-runtime 滚动更新丢内存会话 → vendor `runtime/restore.ts` 已接（启动即 `restoreSession`），磁盘 `JsonlSessionRepo` 存活即自动恢复。thinkingLevel 换档：实测 `lane.setThinkingLevel(level, ctx)` 对存活会话可用，**不需要**保留按需重建路径。会话重建只在 **LLM 身份变更**时发生（BYOK 渠道/模型切换 → `status: "rebuilt"`，历史重置），Nest 侧对该状态打 warn 保持可观测。

### 3.2 run_* 长任务不可级联取消

**实证**：`services/pi-runtime/src/tools/nest-client.ts` 全文无 signal/abort——用户点「停止」仅取消 LLM 流，视频生成（最长 690s，`tools/config.ts:17`）在服务端继续跑完烧钱。

**补齐**：NestClient.post 透传 vendored Context 的 abortSignal（withCancel 产出的 run context 已在 session-manager.ts:259 持有），abort 级联到在途 run_*。

### 3.3 Nest↔pi-runtime SSE 无断线恢复

**实证**：`pi-runtime.client.ts:236` streamEvents onError 只置 closed 不重连；`agent.service.ts:794` iteratePiEvents 断线后本轮事件全丢。pi-runtime 事件 buffer（session-manager.ts:88，上限 500）无单调序号，重连无法增量补发。

**补齐**：事件加单调 seq（NormalizedEvent 扩字段）+ 客户端 Last-Event-ID 语义重连补发 + 指数退避重连。

### 3.4 run_* 同步阻塞，进度通道闲置

**实证**：run_image 同步等 ~3min、run_video ~11min，agent loop 被占死；`tool_execution_update` 事件通道无人发射；start/wait_* 变体迁移时被裁（generation.ts:7 头注释声明偏离，理由「pi 无 graph」）。

**补齐**：run_* 改「提交即返回 record_id」+ 轮询 `get_generation_status` 或完成事件注入；期间经 update 通道向前端汇报进度。老决策应重新评估。

## 4. P1：能力闲置

| # | 缺口 | 实证 | 补齐方向 |
|---|---|---|---|
| 4.1 | hook 体系利用率低 | vendor 11 种 hook（hooks.ts:91-125）仅用 before_tool/after_tool（index.ts:36-51 gate） | transform_context（画布状态实时注入替代每轮重拼 system prompt）、before_run（结构化注入替代 forceSkills 文本前缀）、before_run_end（自动 follow-up） |
| 4.2 | Steering 缺失 | run 进行中用户无法插话，只能停止或干等 | `before_run_end.followUp`（hooks.ts:97-107）为现成挂点 |
| 4.3 | 可观测性半成品 | metrics 无 LLM token/cost 汇总（usage 仅到前端 turn_usage，pi-events.ts:252）、无 run 时长/abort 率/SSE 重连数；vendor telemetry.ts OTel spans 未接 | 接 OTel + 补 metric |
| 4.4 | 无 eval 回归 | `promptHash`/`PromptManifest`（pi-prompt-assembler.service.ts:37-57）已具备 prompt diff 基础未接 CI；vendor packages/evals 未用 | golden 对话集 10-20 条 + promptHash 变更触发人工 diff 门禁 |

## 5. P2：防御纵深与治理

| # | 缺口 | 实证 | 建议 |
|---|---|---|---|
| 5.1 | pi-runtime 不防并发 prompt | `prompting` flag 置位但从不检查（session-manager.ts:263），全靠 Nest 进程内锁（agent.service.ts:611） | runtime 侧补防护（防未来多 Nest 实例） |
| 5.2 | pi-runtime HTTP 端点无鉴权 | Fastify 无 auth hook，内网信任模型 | 加 `x-lnkpi-service-token` 校验，与 nest-client 反向鉴权对称 |
| 5.3 | skill 治理 | 启动扫描一次无热加载（registry.ts:19）；version 纯文档性；无禁用/灰度 | skill 增多前立项；项目未商业化可暂缓 |
| 5.4 | 死代码面 | journeyTrace pi 路径永不产出、thread-state 恒 null（agent.service.ts:415）、`pi_` 前缀透传事件前端丢弃（pi-events.ts:102）；executionEvents 已持久化无恢复端点消费 | 按「有意不支持 + 回归测试锁住」项目规范逐个拍板 |

## 6. 推进顺序

1. **P0-②③（abort 级联 + SSE seq/重连）**：✅ 已实现（2026-09-29，实现计划 `docs/superpowers/plans/2026-09-29-p0-abort-cascade-sse-resume.md`，分支 `feat/p0-abort-cascade-sse-resume`），待 PR 部署验证
2. **P0-①（持久会话 + compaction）**：✅ 已实现（2026-09-29，spec `docs/superpowers/specs/2026-09-29-persistent-harness-session-design.md`，计划 `docs/superpowers/plans/2026-09-29-persistent-harness-session.md`），待 PR 与部署验证
3. **P0-④ / P1**：在 ① 落地后顺势接（④ 的异步化与持久会话的上下文预算联动）

## 变更记录

- 2026-09-29：初版。基于同日全链路源码审视（pi-runtime / Nest agent / vendored pi 能力面），结论经用户确认。
- 2026-09-29：P0-②③ 实现完成，§6 第 1 条回填状态。实现要点：事件单调 seq + `?lastEventId=` 增量重放；SSE 退避重连（250ms→5s 封顶、120s 预算、404/clean-end 终止、onEvent 异常终止不重试）；run_*/cancel_generation 经 `context?.abortSignal` 级联取消（`AbortSignal.any` 与既有超时叠加）。
- 2026-09-29：P0-① 实现完成，§3.1 补齐方案/代价与对策与 §6 第 2 条回填实际结论。实现要点：会话键 = threadId（对话），pi-runtime 侧 `toSessionKey` 归一；`systemPrompt`/`toolContext` 改函数形态（每次 LLM 调用前求值，动态块不进对话历史）；身份比对下沉 pi-runtime（BYOK provider id 哈希仅 runtime 可算）；退役 5 处「每轮重建」补丁（见 §3.1）。
