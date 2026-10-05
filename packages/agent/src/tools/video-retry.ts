/**
 * 视频创建阶段的退避重试。
 *
 * ⚠️ 2026-10-04 新增。生产 video `failed` + `fallback_pending` 共 374 条样本里，
 * **171 条（46%）是明确可重试的**：
 *   - 99  `429 rate limit for free users`（跑在免费额度通道）
 *   - 72  `503 video_queue_full`（上游队列满，错误文案本身就写着「可重试」）
 *   - 11  `fetch failed` 等网络抖动
 * 而改前**零重试** —— 这些全部直接判失败。见
 * `docs/superpowers/specs/2026-10-04-media-generation-audit.md` §2.4
 *
 *⚠️ **只包「创建」阶段，不包轮询阶段**：轮询的 `continue` 已是「等下一轮」语义，
 * 重复它没有意义（且会叠加耗时）。
 */

/* ── U9（2026-10-05）：实现已迁至 `upstream-retry.ts`，本文件改为再导出 ──
 * 生产数据显示重试是**通用上游韧性手段**，不是视频专属：
 *   image_edit  77 条成功率 11.7%（66 条失败里 31 条 `fetch failed`）← 原实现覆盖不到
 *   image     3373 条成功率 83.0%  ← `image-provider.ts` 里 retry 零命中
 *   video        796 条成功率 52.4%
 * ⇒ 分类规则与退避逻辑提取为 `upstream-retry.ts` 的 `withUpstreamRetry` /
 *   `isRetryableUpstreamError`，image 侧接入点直接用它们。
 *
 * 下方保留的原始实现是**决策依据**（「只包创建不包轮询」「429 不能被 4xx 规则拦掉」
 * 等），但**不再被执行** —— 分类规则与退避逻辑现已单一来源。
 * 见 docs/superpowers/specs/2026-10-04-media-generation-audit.md §2.4
 */
export {
  withVideoRetry,
  isRetryableVideoError,
  withUpstreamRetry,
  isRetryableUpstreamError,
  type VideoRetryOptions,
  type UpstreamRetryOptions,
} from './upstream-retry'
