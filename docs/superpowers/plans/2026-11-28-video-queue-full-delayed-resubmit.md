# 计划：视频创建队列满延迟重提

- 日期：2026-11-28
- 规格：`docs/superpowers/specs/2026-11-28-video-queue-full-delayed-resubmit-design.md`
- 授权：用户已授权「低成本工程刀」执行；交付链（提交→PR→CI→合并→部署→生产取证→复测）按 PR #1021 同款流程，**合并-部署前单独汇报**

## 步骤

1. **shared 谓词（RED→GREEN）**
   - 测试：`generationDiagnostics.test.ts` 新增 `isVideoQueueFullError` 用例（生产原文 JSON 形态、裸 `video queue is full`、timeout 混合文本不命中、普通 503 不命中）。
   - 实现：`generationDiagnostics.ts` 导出谓词；`mapMessageToErrorCode` rate_limited 规则复用同一正则。
2. **shared 预算常量（RED→GREEN）**
   - 测试：`generationTimeoutBudget.test.ts` 新增锁：`VIDEO_QUEUE_RETRY_WINDOW_MS < DEFAULT_VIDEO_REAP_MINUTES × 60_000`；窗口 = 间隔×次数。
   - 实现：`generationTimeoutBudget.ts` 加 `VIDEO_QUEUE_RETRY_INTERVAL_MS = 90_000` / `VIDEO_QUEUE_RETRY_MAX_ATTEMPTS = 10` / `VIDEO_QUEUE_RETRY_WINDOW_MS`。
3. **agent 导出**
   - `video-provider.ts` `isAgnesBaseUrl` 加 export；`agent/src/index.ts` 导出。
4. **server completeVideo 重提循环（RED→GREEN）**
   - 测试（新文件 `studio.video-queue-resubmit.test.ts`，复用 `createStudioService` + mock `createVideoProvider`）：
     - 重提后成功 → completed + metadata queuedRetryAttempt；
     - 窗口耗尽 → failed + rate_limited + queueRetryExhausted；
     - BYOK / 非 agnes baseUrl → 不重提（现行为）；
   - `studio.test-utils.ts` prisma mock 补 `generationRecord.updateMany`。
   - 实现：`completeVideo` catch 内按规格 §3 插入有界循环 + env 配置读取。
5. **静态门禁**：`npx vue-tsc -b`（根目录）。
6. **全量回归**：shared / agent / server 受影响套件（本地 vitest，`--maxWorkers=1 --no-file-parallelism`）。
7. **汇报产物** → 等用户授权合并-部署-生产取证-复测。

## 风险与回滚

- 改动集中在 `completeVideo` 单函数 catch 路径 + 常量/谓词新增；最坏回滚 = revert 单 PR。
- 重提期间记录保持 generating：取消接口可用（复用 cancelGeneration 退款语义）；reaper 30min 兜底不变。
