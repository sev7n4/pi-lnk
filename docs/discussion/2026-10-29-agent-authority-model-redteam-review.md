# 红队审核：等待态/提议执行权架构（对 10-29 架构审视 v1 的自我审核 + 修订定稿）

> 2026-10-29 · 审核对象：`2026-10-29-propose-execution-ownership-architecture-review.md`（v1）
> 方法：不采信 v1 结论；重读上游 pi 源码（agent harness / server / client / chord）、Codex 官方审批语义、Claude 权限模型，再回本仓逐条核验。
> **结论：v1 方向成立但有两处必须推翻、一处必须补齐、三处表述必须降级为「自建映射」而非「上游原生」。**

---

## Part A｜对 v1 的逐条审核

| v1 结论 | 审核 | 依据 |
|---|---|---|
| 根因=「确认与执行拆到两个进程」 | ✅ 成立，且证据更强 | Nest 已是生成态节点状态的权威持有者（`sessions.service` 合并 `generationRecordId`/`generating`/`completed`），浏览器只是**触发者** ⇒「状态在服务端、触发在浏览器」的裂缝客观存在 |
| L1「runtime 自起生成」 | ⚠️ **表述不精确，须升级** | 问题不是「谁调 `POST /studio/image/generate`」（runtime 有 nest-client，调同一端点即可），而是**谁持有状态机**：若 runtime 置 pending_confirm、Nest 置 generating、Nest 写 completed，仍是三写者。⇒ L1 升级为「状态机单一 owner = Nest，runtime 降为能力调用方」 |
| L1「工具立即返回已启动，终态走 notify→followUp」 | ❌ **部分推翻** | 终态走 followUp 方向对（回合外事件注入），但「立即返回」会让模型失去与产物的因果链、并多一次模型唤醒。Codex/Claude 的模型是**执行者在 agent 侧、结果回到 agent**、长任务用 pending+可打断；上游 `deferred` 亦允许挂起。⇒ 修正为「**服务端 job + 终态事件注入同一 thread**」，工具返回 job handle（模型拿到 jobId 可继续），终态事件再唤醒 |
| 「notify-generation→followUp 是上游正统用法」 | ⚠️ **表述必须降级** | `followUp` 是上游 lane 的回合编排原语；把「生成终态通报」映射到它，是**我们的自建映射**，上游无 generation 概念。不可当「上游原生」引用 |
| 根因=四个补偿机制 | ⚠️ **漏了一个** | 第五个症状：**客户端有权整份覆盖服务端状态**（`PUT /sessions` 整份替换，曾把服务端 pending_confirm 盖回 draft）——权限边界反了 |
| — | ❌ **完全遗漏：审批挂起态只在进程内存** | `services/pi-runtime/src/pending-registry.ts` 是纯 `Map`；上游对应物是 **durable Session 的 operation state + `pendingToolOutput`（持久化）+ `ProcedureResult {kind:"waiting"}` 一等语义**。⇒ 多实例/重启/worker 退役 ⇒ 审批丢失、/answers 404、孤儿等待。**与「执行权拆分」同级** |
| 「禁 lane.resume()」是否与「持久化挂起态」冲突 | ✅ 不冲突（已核实） | 该纪律源于 `cmv3zzid` 事故：resume 会**真实续跑上游 LLM**（阻塞 612s）。持久化挂起态 ≠ resume LLM：恢复手段是「读持久化态重建待确认卡片 + 迟到答案走新一轮输入（followUp 语义）」，**不走 lane.resume** |
| L2「服务端即时广播」 | ⚠️ 用词需升级 | 上游 chord 的纪律不是「广播」而是**复制状态（replicated state）**：权威持有者发布不可变快照，消费者订阅；facets/services 定义能力边界；attachment 幂等；worker 可退役。⇒ 我们不需要引入 chord，但要采纳其纪律并**先定权威**（Nest） |
| 行业不变量「审批后同一工具执行」 | ✅ 成立，有官方背书 | Codex 官方：审批是 gate，**执行者始终是 agent 运行时**；工具可自带 side-effect 标注触发审批；`auto_review` 用**子 agent 自动批准低风险动作**；safety monitoring 可 **pause 任务**；findings + **resume** 入口 |
| ask_user 链路无架构问题 | ✅ 成立 | 上游 extension `ctx.ui.confirm/select` = 工具内 await 宿主 UI Promise；我们的 registry+HTTP 桥是忠实移植 |

## Part B｜修订后的目标架构：「三权归一 + 挂起持久化 + 事件注入」

> 一句话：**服务端持有状态与执行，客户端只持有呈现与意图；长任务用 job + 事件；挂起态可恢复。**

1. **状态权 = Nest（单一 owner）**
   节点状态机 `draft → pending_confirm → generating → completed/error` 唯一由 Nest 持有与转移；对外只暴露两类接口：**状态复制**（订阅/SSE 投影）与**状态转移**（幂等 API）。runtime 不再直写节点状态（现状：internal `propose-generation` 写 pending_confirm 是必要例外，需并入同一转移 API）。
2. **执行权 = 服务端（单一执行者）**
   提议确认后由 runtime（或 Nest 自身在收到确认转移时）调用同一生成服务；用户手动生成走同一服务与同一幂等键 `（sessionId, nodeId, proposalEpoch）` ⇒ 杜绝双跑。
3. **呈现权 = 客户端（只读复制 + 发意图）**
   客户端渲染服务端复制的状态、发起确认/取消/编辑；**不得整份覆盖服务端状态**（saveCanvas 改 patch/merge 语义或服务端拒绝降级写）。
4. **挂起态持久化（durability）**
   审批挂起记录进已有 durable turnState（DB）：`callId / toolName / nodeId / epoch / deadline / status`；进程内 promise 兑现答案；进程重启后可重建待确认卡片；迟到答案按幂等 + 过期判定转移状态（不再 404 悬挂）。
5. **长任务 = job + 事件注入**
   生成即服务端 job（GenerationRecord 已是）；工具在「已受理」时返回 job handle；终态经事件注入**同一 thread** 的新一轮（steer/followUp 语义），模型据此汇报产物。⇒ 删 13 分钟持轮、轮询启发式（draft×2 / stale_status）与「生成仍在进行」假文案。
6. **审批策略化（产品减负，Codex auto-review 类比）**
   提议带 side-effect/风险标注；低风险自动确认（可配置、可审计），高风险才打断用户；审批决策本身可由规则或子 agent 承担。

## Part C｜落地顺序（含不变量与验收判据）

**P0 止血（当天可上）**
| # | 改动 | 验收判据（行为级） |
|---|---|---|
| P0-1 | 服务端在收到 propose 确认转移时启动生成（幂等） | 内联卡确认 → 30s 内 GenerationRecord 出现、节点转 generating（不再依赖任何前端路径） |
| P0-2 | pending_confirm 即时复制到客户端；overlay 锚点=服务端状态∥part | 移动/PC 切画布均见确认/取消面（不再依赖节点 status 单点） |
| P0-3 | 磁贴渲染服务端状态 | 提议内容（prompt 已在 data）可见 |
| P0-4 | 禁止整份覆盖降级写（pending_confirm 不被写回 draft） | 画布页 3s 自动 PUT 不再翻转服务端状态 |
| P0-5 | turn 失败判定改读服务端 turn 终态事件 | waiting 期断流不再显示「生成失败」 |

**P1 治本**
P1-1 状态机单一 owner 收敛；P1-2 生成 job 化（job handle + 终态事件注入，删持轮与启发式）；P1-3 挂起态持久化 + 迟到答案幂等 + 重启重建；P1-4 saveCanvas patch 化；P1-5 审批风险分级（auto-approve 低风险）。

**P2 平台化**
P2-1 引入 chord 式纪律（幂等 attach + 状态复制 + worker 可退役），为多端一致性打底（与 J5 孤儿线程治理合流）。

**贯穿性不变量（守卫测试建议）**
- 节点状态的写者集合 == {Nest}（代码级 grep 守卫：runtime/前端不得直写 status）
- 生成执行入口集合 == {1 个服务端服务}
- 客户端写画布 = patch 语义，禁止整份替换
- turn 终态判定来源 = 服务端事件（非连接状态）
- 每个挂起 call 在 DB 有 durable 记录

## Part D｜度量：区分「治本指标」与「观测指标」

- **治本指标（架构收敛度）**：状态写者数量（→1）、生成执行入口数量（→1）、客户端整份覆盖写次数（→0）、挂起态可恢复率（→100%）、turn 终态判定来源（→服务端事件）。
- **观测指标（不治本，仅监控）**：等待时长分布、卡顿率、生成成功率、404 率。

## Part E｜自审：风险与未覆盖面

- 风险① Nest 成为状态热点 → 转移 API 幂等 + 服务端守卫；Nest 本就是生成态权威，风险可控。
- 风险② 事件注入唤醒模型 ⇒ 注入消息必须带 jobId/nodeId/状态，避免模型误判用户仍在等待。
- 风险③ 多端并发确认同一节点 ⇒ 服务端 CAS/幂等，冲突返回「已确认」而非重复执行。
- 风险④ run_* 与 propose 双路径并存期的幂等冲突 ⇒ P1-2 需明确 proposalEpoch 抢占规则。
- 未覆盖：`propose_plan`、视频长任务、批量生成等同类 propose/长任务工具必须一并纳入 P1-2 job 化，否则只修 image 一处 = 又一次「指标不治本」。
- 未覆盖：多端并发编辑画布的冲突合并（超出本次范围，需独立议题）。
