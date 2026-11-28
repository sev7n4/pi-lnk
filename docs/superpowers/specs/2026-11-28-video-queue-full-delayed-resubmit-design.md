# 视频创建队列满延迟重提（video_queue_full delayed resubmit）设计

- 日期：2026-11-28
- 状态：已立项，待实施
- 来源：2026-11-28 生产取证（10 轮真实生成 9 次 503 `video_queue_full`；近 30 天该形态 15/17，errorCode 曾 100% 落 unknown，后半已由 PR #1021 修复为 rate_limited）
- 授权：用户明确授权推进「低成本工程刀」；诉求=满足日常开发测试（单发为主、生产无实际流量），非高可靠 SLA

## 1. 问题

agnes 免费池队列满是**分钟级间歇容量信号**（官方文案 `please retry later`、无 `Retry-After`）。现状两层退避都不匹配：

- provider 内层 `withUpstreamRetry`：3 次 × 1.5s 基数（1.5/3s）——秒级，撞队列满必然再败；
- `completeVideo` 失败路径：直接退款 + `failed` 终态——用户需手动隔几分钟重发。

生产实证（2026-11-28）：连续 9 次被拒后第 10 次挤进队列，6.6 分钟出片 ⇒ 空位间歇出现，分钟级自动重提可显著提高单发成功率。

## 2. 等价物检索结论（不重复造轮子）

| 检索项 | 结论 |
|---|---|
| 仓库内既有重试 | `withUpstreamRetry`（秒级退避，provider 内层）——本刀是其**分钟级外层扩展**，不替换不重复 |
| 仓库内异步任务基建 | audio P1-B job 化（start-*-generation detached）、`AutomationSchedulerService`——均为持久化调度形态；本刀场景是单条 detached completion 内的循环 sleep，引入 job 队列属过度设计 |
| 崩溃恢复 | detached 语义 + `GenerationReaperService`（video 30min 按 createdAt 回收退款，interrupted 文案）已兜底，重提循环进程重启后由 reaper 收尾，零新增恢复设施 |
| 行业实践 | 队列满延迟重试 = 异步任务系统标准做法；关键差异是我们**同步等待**（记录保持 generating），不做持久化队列 |

## 3. 方案

`completeVideo`（studio.service.ts，detached）失败路径插入**有界重提循环**：

1. catch 到错误后走既有守卫（记录 generating、未取消、未退款）；
2. 判定**可重提**（四个条件全满足）：
   - 平台渠道（`resolved.source !== 'user'`）——BYOK 已有 `fallback_pending` 语义，不动；
   - agnes 网关（`isAgnesBaseUrl(resolved.credentials.baseUrl)`，复用 agent 既有私有函数→加导出）——队列满实证仅见 agnes；同时避免与有 deadline 的 provider（apimart/fal/minimax 最长 20min 轮询）叠加出「重提 15min + 轮询 20min = 35min > reaper 30min」回收冲突；
   - 错误形态命中 `isVideoQueueFullError`（新 shared 谓词，生产原文两种字面形态）——429 RPM、轮询超时不进本刀；
   - `resubmitCount < maxAttempts`（默认 10）；
3. 可重提 ⇒ 写 metadata（`queuedRetryAttempt` / `queuedRetryNextAt` / `queuedRetryLastError`，**status 保持 generating、积分不退**）→ sleep 间隔（默认 90s）→ 醒后复核（记录仍 generating、未取消，否则静默退出）→ continue 重调 provider；
4. 窗口耗尽 ⇒ 走既有失败路径原样（退款 + failed + rate_limited 文案），failedMeta 附 `queueRetryExhausted: true` 与实际重提次数。

## 4. 跨层预算安全论证（核心约束）

| 约束 | 数值 | 结论 |
|---|---|---|
| 重提窗口 | 10 × 90s = **15min** | `VIDEO_QUEUE_RETRY_WINDOW_MS` 进 generationTimeoutBudget 单一来源 |
| reaper video 阈值 | 30min（按 createdAt，env 可覆盖） | 窗口 15min < 30min ✓；锁测试钉死不等式 |
| agnes 轮询典型耗时 | ~7min（2026-11-28 实测 6.6min） | 典型最坏 15+7=22min < 30min ✓ |
| agnes 病理轮询 | ≈70min（循环制 120×(5s+30s)） | **既有已知例外**（generationTimeoutBudget 文件头明载，reaper 提前回收 + exactly-once 守卫），本刀不改该语义 |
| web 墙钟 | agnes 本就在例外清单（不被覆盖） | 无 web 改动 |

环境变量：`LNKPI_VIDEO_QUEUE_RETRY_INTERVAL_MS` / `LNKPI_VIDEO_QUEUE_RETRY_MAX_ATTEMPTS`（测试注入 1ms / 小值；0=禁用重提）。

## 5. 改动面（3 包，无 DB schema 变更）

1. **packages/shared**
   - `generationDiagnostics.ts`：导出 `VIDEO_QUEUE_FULL_MESSAGE_RE` / `isVideoQueueFullMessage(text)` / `isVideoQueueFullError(err)`；`mapMessageToErrorCode` 的 rate_limited 规则改用同一正则（PR #1021 行为逐字节不变）。
   - `generationTimeoutBudget.ts`：`VIDEO_QUEUE_RETRY_INTERVAL_MS = 90_000`、`VIDEO_QUEUE_RETRY_MAX_ATTEMPTS = 10`、派生 `VIDEO_QUEUE_RETRY_WINDOW_MS`。
   - 测试：谓词（生产原文两形态 + timeout 混合文本不受影响）；预算锁 `WINDOW < DEFAULT_VIDEO_REAP_MINUTES × 60_000`。
2. **packages/agent**
   - `video-provider.ts`：`isAgnesBaseUrl` 加 `export`（复用既有判定，不复制 host 逻辑）。
   - `index.ts`：导出 `isAgnesBaseUrl`。
3. **apps/server** `studio.service.ts` `completeVideo`：重提循环如 §3；`studio.test-utils.ts` prisma mock 补 `generationRecord.updateMany`。

## 6. 测试计划（TDD：先 RED 后 GREEN）

- shared 谓词与预算锁测试（见 §5）。
- server integration（mock `videoGenerate` + env 注入 1ms 间隔）：
  - 抛 queue_full 2 次后成功 ⇒ 记录 `completed`、provider 被调 3 次、metadata 含 `queuedRetryAttempt`、无退款终态；
  - 一直抛 ⇒ `failed` + `errorCode=rate_limited` + `queueRetryExhausted` + provider 调用 1+maxAttempts 次；
  - BYOK 渠道抛 queue_full ⇒ **不重提**，直接 `fallback_pending`（现行为保持）；
  - 非 agnes baseUrl 抛 queue_full ⇒ 不重提，直接 failed（现行为保持）。
- 全量回归：shared / agent / server 相关套件 + `vue-tsc -b`。

## 7. 明确不做（诚实边界）

- UI「排队中」文案展示：记录保持 generating，前端现有轮询/spinner 语义不变，P2 可选刀。
- 429 RPM 分钟级重提、cogvideox「上游生成服务限流」形态重提：后续独立刀。
- 不改 provider 内层快速退避参数（三层预算 SSOT，牵动 web 墙钟与 reaper 锁测试）。
- 免费池无 SLA：高峰期整窗重提仍可能失败，此时落 `rate_limited` + 「上游限流，请稍后重试」，属诚实终态。
