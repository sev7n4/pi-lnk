# SSE 会话恢复 P0–P2 分期实施计划与测试用例

> 日期：2026-11-11　|　性质：分期实施计划 + 测试用例（P0 已实现，P1/P2 待实施）
> 母文档（诊断）：`outputs/2026-11-11-sse-session-resume-diagnosis.md`
> P0 收口详设（已执行）：`outputs/2026-11-11-sse-session-resume-p0-plan.md`
> 代码基线：真 master `1c9daad2`；P0 载体：PR #832（分支 `fix/sse-session-resume-p0`，head `3c7d165b`）
> 本文档为纯文字计划（无配图）。

## 0. 分期总览

| 期 | 主题 | 触达层 | 状态 |
|---|---|---|---|
| P0 | 前端单一数据源 + 生命周期自愈（三刀 A/B/C） | 仅 `apps/web` | ✅ 已实现，PR #832，CI 三 job 全绿，待合并窗口授权 |
| P1 | 服务端事件一等化 + 标准续传协议（SSE `id:` / 事件表 / state+events 双 API） | `apps/server` + `apps/web`（消费端） | 📋 本文档 §2，未实施 |
| P2 | 待确认门 durable（对齐 LangGraph checkpointer / Agents SDK RunState） | `apps/server` + `apps/web` | 📋 本文档 §3，未实施 |

分期原则：**先加法后换血**——P1 先 additive（新表 + 双写 + 新端点，不删旧路径），观测稳定后再把 `executionEvents` 大 JSON 降级为派生快照；P2 建立在 P1 的 state API 之上。每期独立 PR、独立 CI、独立合并窗口与生产复测，禁止一期打包上线。

## 1. P0（已实现）：三刀回顾与验收状态

### 1.1 变更清单（PR #832，commit `3c7d165b`）

| 刀 | 文件 | 内容 |
|---|---|---|
| A | `apps/web/src/components/agent/turnTimeline.ts` | `replayTimelineEvents` 入口加 `normalizePersistedTimelineEvent`：落库形态 `canvas_command{type:'ask_user'}` 收敛为时间线原生 `ask_user`，历史与实时共用同一 `applyTimelineEvent` 分支（仅转换 ask_user 子类型，其它 canvas_command 保持原样） |
| B | `apps/web/src/components/agent/AgentSideRail.vue` | 新增 reconcile 生命周期入口：`visibilitychange→visible` 与 `pageshow(persisted)` 触发 `loadHistory()`；守卫四条（单飞 single-flight / `isStreaming` 时不动 / `navigator.onLine===false` 不赌 / 无 threadId 不动），`onUnmounted` 清理监听 |
| C | `apps/web/src/components/agent/historySanitize.ts` | 「正文空」的 assistant 行仅当**同时无 `executionEvents`** 才剔除；带过程事件的空正文回合保留，不再被静默丢行 |

### 1.2 测试用例（11 个新用例 + 3 组实现级变异自检）

| # | 文件 | 用例 | 判据 |
|---|---|---|---|
| T1 | `turnTimeline.replayAskUser.test.ts` | 正向：真实 `replayTimelineEvents` 跑服务端落库形态 `canvas_command{ask_user}` | parts 含 `kind==='question' && status==='pending_answer'` 且 callId 匹配 |
| T2 | 同上 | 同构证明：同数据改喂原生 `ask_user` | 同一断言 GREEN（两路径同构，归一化只是桥接） |
| T3 | 同上 | 机制证明：删归一化（变异）→ T1 转 RED | 证明 T1 不是恒绿 |
| T4 | 同上 | 阴性对照：不含 ask_user 的样本 | 无 question part（防误建） |
| T5 | `historySanitize.keepEventfulEmpty.test.ts` | 正文空 + `executionEvents` 非空 | 不剔除（`droppedEmptyAssistant===0`） |
| T6 | 同上 | 真空行（正文空 + metadata 无 events） | 照旧剔除（`===1`） |
| T7 | 同上 | 变异：退回旧剔除逻辑 → T5 转 RED；正文非空行恒保留 | 防恒绿/防误伤 |
| T8 | `AgentSideRail.sessionResumeReconcile.test.ts` | 静态源码契约（剥注释扫描）：`visibilitychange`/`pageshow`/`reconcileSingleFlight`/`isStreaming`/`onLine` 守卫/`onUnmounted` 清理 全部接线 | 任一缺失 RED |
| T9 | 同上 | 变异：移除 visibilitychange 监听 → RED | 防恒绿 |

### 1.3 本地验证结果（已执行）

- 定向 vitest 86 用例全过（含 11 新用例）；40+ 相关回归全过；`vue-tsc -b` 零错误。
- 3 组实现级变异自检均确认「转红→还原」（T3 / T7 / T9），判据非恒真。

### 1.4 生产复测判据（合并后执行，防伪锚点）

锚点**禁用**「chunk hash 变化」与「产物内注释 0 命中」（历史恒真判据）。改用：

| # | 判据 | 方法 |
|---|---|---|
| V1 | deploy 日志出现本次合并触发的 run，`MANIFEST_OK files=N` | GitHub Actions Deploy to Tencent Cloud |
| V2 | `/api/health` 200 | curl 生产 |
| V3 | 首页与主 chunk HTTP 200，502 窗口（约 30s）恢复 | curl 生产 |
| V4 | 无头 Chrome 复现目标会话 `cmwauqze8012pt901tl5ns577` 刷新态：`agent-turn--assistant` ≥ 2 且「三步制作Codex」≥ 1 且 `pending_answer`/`question-part` > 0（A 刀生效：确认卡片重建） | 既有取证命令（`--headless=new --no-proxy-server --dump-dom`） |
| V5 | 阴性对照：不含 ask_user 的历史会话不误出卡片 | 同法抽一个无卡片会话 |

### 1.5 明确不在本期范围（不宣告验收完成的边界）

- A-6 真机走查（iOS Safari + Android Chrome + 鉴权会话）：本环境不可代跑，「切出去再回来」的 reconcile 路径（B 刀）需真机复现验证。
- 流式回合后台断连（live SSE 死、`isStreaming` 仍 true）停在冻结态：属主 SSE 健康/重连议题，由 P1 标准续传承接。
- P0 验收 = 合并 + V1–V5 通过 + 真机走查另行安排；在此之前状态为「已上线待验收」。

## 2. P1：服务端事件一等化 + 标准续传协议

### 2.1 目标与验收总纲

把「回合末单条大 JSON 快照 + 单进程内存 buffer 续传」升级为「append-only 事件表 + 标准 SSE 断点续传」，使浏览器 `EventSource`/`Last-Event-ID` 原生生效、溢出不再 409 丢事件。对齐 WHATWG SSE、Vercel AI SDK `in_progress/complete` + full replay、Codex `.jsonl` append-only 语义；**吃满上游** `Storage.scanEntries` / `entry_added`，不自创第三套 seq。

### 2.2 变更设计（P1a additive → P1b 换读 → P1c 清债，三个子刀）

**P1a（加法，先行）**

1. 主流 SSE 补标准三件套：`agent.controller.ts` 会话流每帧加写 `id: ${gSeq}`、`retry: 3000`，`UiEvent` 投影透传 `ts` / `runId`（当前在 `pi-events.ts` 被丢）。
2. 新增 Prisma 模型 `AgentEvent`：`(threadId, gSeq, runId, type, ts, data)`，唯一索引 `(threadId, gSeq)`；append-only，禁 update。
3. 结构性事件（`tool_call` / `tool_result` / `waiting_user` / `canvas_command` / `task_list` / `turn_usage` / `turn_settled`）**流中即时 append**；`text_delta` 不逐帧落表，按 AI SDK `onEnd` 语义在 turn 收束时合并写入完整 text 事件（避免半条消息）。
4. 新增两个只读 API：
   - `GET /api/agent/threads/:id/state` — 权威快照：`status: in_progress|complete`、`lastGSeq`、pending interruption 摘要（P2 接管细化）；
   - `GET /api/agent/threads/:id/events?since=<gSeq>&limit=` — 增量补发，按 `gSeq` 升序。
5. 续传兜底换语义：pi-runtime buffer 溢出（现 `409 replay window expired`）时，服务端不再让客户端丢历史，改返回「请走 state + since 收敛」的信号，前端 full replay。

**P1b（换读）**：前端历史/续传改读新端点；`executionEvents` 大 JSON 转为派生展示快照（由事件表投影生成，保留兼容读）。

**P1c（清债）**：消除 `AgentMessage.metadata` 内的大 JSON 双写（保留最小兼容字段），统一 envelope `{type, seq(=gSeq), runId, ts, data}`，废弃局部 `seq` 排序（`agentTrace.ts` 切 `gSeq`）。

### 2.3 P1 测试用例

**服务端（vitest，`apps/server`）**

| # | 用例 | 判据 | 变异自检 |
|---|---|---|---|
| S1 | SSE 帧格式：解析主流会话流原始帧 | 每帧含 `id:` 行且值等于该事件 `gSeq`；首帧前有 `retry:`；`data` JSON 含 `ts`/`runId` | 删 `id:` 写行 → RED |
| S2 | `AgentEvent` append：模拟一回合结构性事件流 | 流中（turn 未结束）逐条可查；`(threadId,gSeq)` 冲突时 upsert 幂等不炸 | 去掉流中写入（只在 turn 末写）→ RED |
| S3 | text 不半条：turn 中途查询 | 无 text 事件；收束后恰一条完整 text 事件 | 改成逐帧写 → RED |
| S4 | `GET events?since=`：预置 10 条事件 | `since=4` 恰返回 gSeq≥4 的 6 条、升序、含游标；`since` 超尾返回空数组非 404 | 改降序或漏条 → RED |
| S5 | `GET state`：流式中 / 收束两种 thread | 分别返回 `in_progress`（含 lastGSeq）/ `complete`；不存在 thread 返回 404 | 判据翻转 → RED |
| S6 | 溢出收敛：mock buffer `droppedFromSeq` 场景 | 响应为「resync 指引」而非 409 裸错；客户端按 state+since 可补全 | 保留 409 → RED |
| S7 | 双写一致性：同回合事件表投影 == `executionEvents` 落库内容（结构性事件逐条相等） | 差集为空 | 破坏任一侧 → RED |

**前端（vitest，`apps/web`）**

| # | 用例 | 判据 |
|---|---|---|
| W1 | `EventSource` 重连语义：mock 断连后带 `Last-Event-ID` 重连 | 请求 URL/头携带最后 `id`；补发事件按 gSeq 无缝拼接、无重复 part |
| W2 | full replay 收敛：state+since 场景 | 整体替换不 append（对齐 AI SDK full replay），无双气泡 |
| W3 | 回归：P0 全部用例（T1–T9）仍绿 | P1 不破坏 P0 语义 |

**验收判据**：流式中途杀进程重启，客户端刷新后经 state+events 恢复到断点前完整时间线（结构事件无缺）；`Last-Event-ID` 重连抓包可见且无重复渲染。

## 3. P2：待确认门 durable

### 3.1 目标

确认卡片从「前端内存 ref + 进程内 Map」升级为「thread state 的一部分」：刷新 / 进程重启 / 换设备后仍可点；超时裁决由持久化 `expiresAt` 驱动；消灭「卡片活着但点了执行不了」的假交互（本案 `waiting_user` 已 timeout 仍发 `canvas_command{ask_user}` 而 plan-gate fail-closed 的矛盾）。

### 3.2 变更设计

1. 新增 Prisma 模型 `PendingInterruption`：`(id, threadId, runId, callId, kind, questionsJson, status: pending|answered|expired, expiresAt, answerJson, createdAt/updatedAt)`，索引 `(threadId, status)`。
2. 门创建时（`PendingToolRegistry` / `PlanGate` 挂起处）同步落库；`/answers` 命中时 CAS 翻 `answered`（对齐 `adjudicateLateAnswer` 既有 CAS 追加终态语义）。
3. 超时裁决换血：进程内 `setTimeout` → 持久化 `expiresAt` + 定时扫描（可复用现有 `AutomationJob` 调度骨架），扫描结果幂等。
4. `GET /threads/:id/state` 返回 pending interruption（P1a 已留摘要位），前端 `AskUserCard` 由 state 驱动重建，不再依赖实时事件独占。
5. 业务一致性收口：「是否还发卡片」与「门是否可执行」由同一权威状态（`PendingInterruption.status==='pending'` 且未过 `expiresAt`）决定；门终态后不再发活卡片。
6. 逐步收回自建 `PendingToolRegistry` 职责：等待承载改用上游 `before_tool` hook 的 `block` + `AgentTool.execute(signal)` 组合；`Command(resume)` 语义对应现有 `/answers`。**不 fork vendor、不升 0.99.2。**

### 3.3 P2 测试用例

**服务端**

| # | 用例 | 判据 | 变异自检 |
|---|---|---|---|
| P1c-1 | 门创建即落库 | 创建后 `PendingInterruption` 有 `status='pending'` 且 `expiresAt` 正确 | 去掉落库 → RED |
| P1c-2 | 正常作答 | `/answers` 后 CAS 翻 `answered` + `answerJson` 落库；重复作答幂等不双翻 | 去 CAS 条件 → 重复请求炸/双翻 → RED |
| P1c-3 | 超时裁决 | mock 时钟越过 `expiresAt` → 扫描翻 `expired`；裁决幂等 | 去掉扫描 → RED |
| P1c-4 | late answer | `expired` 后作答走 `adjudicateLateAnswer` 追加终态，不复活门 | 判据翻转 → RED |
| P1c-5 | 重启存活 | 门挂起中重启服务进程 → state API 仍返回 pending（durable 核心） | 用内存 Map 模拟 → RED |
| P1c-6 | 一致性 | 门 `expired` 后不再下发活卡片（SSE/历史均无 `pending_answer` 形态） | 判据翻转 → RED |

**前端**

| # | 用例 | 判据 |
|---|---|---|
| W1c-1 | 刷新重建可点卡：state 含 pending interruption | 卡片渲染、`pending_answer`、提交走 `/answers` 成功 |
| W1c-2 | 终态卡：state 为 answered/expired | 卡片呈终态不可提交 |
| W1c-3 | 回归：P0 T1–T9 + P1 W1–W3 全绿 | 分期不互踩 |

**验收判据**：挂起确认门的会话，刷新页面 / 重启后端进程 / 换设备打开，卡片均可点且作答生效；过期门不再出现活卡片。

## 4. 交付纪律（每期通用）

- 分支纪律：master 不可直提交；本机 push 走 `gh api` REST（裸 blob sha + `base_tree` + 逐路径比对 + 建分支 ref）。
- 判据纪律：每条判据必须能失败（实现级变异自检，RED→还原）；生产取证禁用恒真锚点（chunk hash、产物内注释 0 命中）；按数据形态分支的判据先贴真实生产记录求值（阳性/阴性样本）。
- 上线纪律：`apps/web` / `apps/server` / `packages` 改动合并即触发生产发布 ⇒ **合并窗口单独授权 + 生产复测**；涉及 `skills/**` 或 pi-runtime 的部分须手工 dispatch `runtime-deploy.yml`（tag = master 短 SHA）——P1/P2 不动 pi-runtime 与 skills，预期零手工 runtime 流水线。
- 验收边界：A-6 真机走查（iOS Safari + Android Chrome + 鉴权会话）每期后另行安排，本环境不可代跑，不宣告验收完成。
- 回滚：每期单 commit squash，回滚 = revert；P1a/P2 均为 additive schema（新增表），无破坏性迁移。
