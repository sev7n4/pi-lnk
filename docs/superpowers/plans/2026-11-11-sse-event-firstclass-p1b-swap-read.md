# SSE 事件一等化 P1b 换读刀实施计划（前端换读 + executionEvents 降级派生快照）

> 日期：2026-11-11　|　母计划：`docs/superpowers/plans/2026-11-11-sse-session-resume-p0-p2.md` §2.2（P1b 换读定义）
> 上游已上线：P0 三刀（#832）、P1a PR-A 帧契约（#837）、PR-B 事件账本（#840，生产已实证同帧多派生落账）。
> 本刀性质：**只换读，不动写**。`apps/web` 为主，`apps/server` 至多 additive 信号字段。

## 0. 实施前真值核对表（回代码核实，禁止按本文行号盲动）

| # | 断言 | 核对点 | 状态 |
|---|------|--------|------|
| R1 | 前端历史读路径 = `loadHistory → parseMessageMetadata → replayExecutionTraceEvents` | `apps/web/src/stores/agent.ts` ~L1003-1006、`agentMessageRender.ts` | 待实施核对 |
| R2 | `executionEvents` 唯一写者 = server `persistTraceEvents`（metadata JSON 内） | `apps/server/src/agent/agent.service.ts` ~L152-170 | 已核对 ✓ |
| R3 | 服务端 `waiting_user` 未决事件查找读自家 `metadata.executionEvents`（同进程便宜）**不在本刀换读范围** | `agent.service.ts` ~L2141-2270 | 已核对 ✓ |
| R4 | events API 分页语义：since 整组进退、`nextCursor` 权威、limit 钳 [1,500]、超尾空数组非 404 | `agent.service.ts getThreadEvents`（#840 已上线） | 已核对 ✓ |
| R5 | state API：`status`/`lastGSeq`/`pendingInterruption`（P1 恒 null） | `agent.service.ts getThreadResumeState`（#840 已上线） | 已核对 ✓ |
| R6 | 旧会话兼容：`AgentEvent` 账本零行（#840 上线前历史）⇒ 必须回落 `metadata.executionEvents` 重放 | 生产 DB 取证：账本行只覆盖新对话 | 已核对 ✓ |
| R7 | SSE buffer 溢出（409 replay window expired）当前前端行为与处置点 | `event-stream-cursor.ts`、`stores/agent.ts`、server 409 响应体形态 | 待实施核对 |
| R8 | 实时与历史同源：`AgentSideRail.handleEvent` 统一分发（live 与重放同 reducer） | `agent.ts` L818 注释、`executionTraceReducer.ts` | 已核对 ✓ |

## 1. 变更设计（additive 换读，三块）

### 1.1 前端历史加载换读 events API（apps/web）

- `loadHistory` 现状：解析每条消息 `metadata.executionEvents` → 重放投影。**本刀改为双源优先级**：
  1. `GET /api/agent/threads/:id/state` 取 `lastGSeq`；
  2. `lastGSeq != null` ⇒ `GET /api/agent/threads/:id/events?since=0&limit=500` 分页循环（`nextCursor` 推进，空数组/不推进即止）→ 事件序列喂**与 SSE 实时同一个 reducer**（R8 统一分发）投影 executionTrace；
  3. 回落条件（任一）：账本零行（`lastGSeq == null`）/ events API 失败 / 投影异常 ⇒ 现状 `metadata.executionEvents` 重放路径原样保留。
- 缓存纪律：GET 走 `cache: 'no-store'`（ETag 304 空体白屏教训）。
- 兼容判据：**新会话双源一致**（账本投影 == metadata 重放，同一 reducer 下逐事件等价）；**旧会话零行回落**不回归。

### 1.2 SSE 续传兜底换语义（依赖 R7 核对结果）

- 现状：buffer 溢出 409 ⇒ 前端丢实时流（P0 已做 reconcile 自愈，但历史依赖 metadata 重放）。
- 本刀：409 / SSE 不可恢复时，前端走 1.1 的 state + events 收敛路径完成 full replay，**不再有「溢出后历史永久丢失」**。
- 若 server 409 响应体缺机器可读信号（R7 核对出缺口），仅 additive 补一个字段（如 `resumeHint`），不改状态码。

### 1.3 executionEvents 降级派生快照（本刀只立flag，不收缩写）

- 母计划「先加法后换血」：本刀 metadata 双写**原样保留**（兼容读 + 回落真源）；读端已换账本。
- P1c 清债刀再消除大 JSON 双写（保留最小兼容字段）+ 统一 envelope + `agentTrace.ts` 切 gSeq。
- 生产观测指标（本刀上线后）：账本投影与 metadata 重放一致性抽样比对；大 JSON 行体量趋势（当前 max 530KB / 9767 行）。

## 2. 测试用例（判据必须能失败；实现级变异自检 RED→还原）

| # | 场景 | 判据 | 变异 |
|---|------|------|------|
| T1 | 新会话读账本投影 | mock state(lastGSeq=N) + events 分页 → executionTrace 与 SSE 实时同 reducer 输出等价 | 删 events 读取 → RED |
| T2 | 旧会话回落 | events 空数组 + metadata 有 executionEvents → 走旧重放路径 | 删回落分支 → RED |
| T3 | 分页循环 | 3 页 nextCursor 递进 → 全量事件投影、无重复无丢页 | 只取一页 → RED |
| T4 | 409 收敛 | SSE 409 → state+events 收敛重放完成 | 维持丢历史 → RED |
| T5 | API 失败降级 | events 网络错误 → 回落 metadata 重放，不白屏 | 删 catch → RED |
| T6 | 403 属主 | 非本人 thread → 不投影、不崩（service 403 语义透传） | 吞 403 当空 → RED |
| T7 | no-store | events/state GET 请求带 `cache: 'no-store'` | 改默认缓存 → RED |

## 3. 上线纪律与回滚

- 改动面预期 `apps/web/**`（+ 至多 server additive 一字段）；合并即触发生产发布 ⇒ **合并窗口单独授权 + 生产复测**。
- 预期零手工 runtime 流水线（不动 pi-runtime / skills / vendor / prompt-registry）。
- 回滚 = revert 单 squash commit；无 schema 变更。
- 生产复测清单：① 新对话产生后刷新 → 历史由账本投影完整（含卡片/画布/usage）；② 409 收敛路径真机验证（A-6 遗留一并覆盖 iOS Safari/Android Chrome reconcile）；③ 旧会话（账本零行）历史展示不回归；④ web dist 取证（events API 调用形态 + no-store）。

## 4. No-Go（本刀不做）

- 不删/收缩 metadata.executionEvents 写（P1c 范围）。
- 不改 `AgentEvent` 表结构（#840 刚上线，观测期）。
- 不动服务端 waiting_user metadata 读取（R3，同进程便宜且与账本无关）。
- 不做 P2 PendingInterruption durable（独立分期）。
