/**
 * 跨层超时预算——**单一来源**（single source of truth）。
 *
 * 三层消费（改动本文件 = 同时改三层行为）：
 * - `packages/agent`  `upstream-fetch.ts`（单次请求/轮询超时）、
 *   `upstream-retry.ts`（创建重试默认参数）、各 video provider（轮询 deadline）
 * - `apps/web`        `utils/generationPollGate.ts`（前端墙钟，必须 ≥ 服务端最坏总耗时）
 * - `apps/server`     `studio/generation-reaper.service.ts`（video 回收阈值，
 *   必须大于服务端最坏总耗时，否则会把在生成的视频判成孤儿并退款）
 *
 * ⛔ 改任何一个**输入常量**前，先重算下方派生值，并跑三处锁测试：
 * `packages/shared/src/generationTimeoutBudget.test.ts`、
 * `apps/web/src/utils/generationPollGate.settle.test.ts`、
 * `apps/server/src/studio/generation-reaper.service.test.ts`。
 *
 * 已知例外（**不被** web 墙钟覆盖，属服务端配置问题）：Agnes 视频通道
 * （`video-provider.ts`）是循环制 `maxPollAttempts=120`（约 5s 间隔 + 30s 单次
 * 超时），无固定 deadline，最坏 ≈70min。本预算只约束「有 deadline 的 provider」；
 * Agnes 的收敛是独立事项，不要试图用抬前端墙钟来覆盖它。
 *
 * 背景：2026-10-09 前，三处阈值是散落的硬编码 + 注释里的口头约定——web 墙钟
 * 锁测试断言的是过时字面量（`1_260_000`），reaper 注释引用了代码中不存在的
 * `VIDEO_POLL_TIMEOUT_MS=21min`（虚构常量），V6（PR #301）改动时两层预算
 * 差点静默失衡。本模块把「数字」收敛为一处，「关系」用不等式锁测试钉死。
 */

/** 上游单次 HTTP 请求超时（创建类调用；`upstreamFetch` 的默认 `timeoutMs`）。 */
export const UPSTREAM_FETCH_TIMEOUT_MS = 45_000

/** 轮询类请求单次超时（响应体小；必须小于 {@link UPSTREAM_FETCH_TIMEOUT_MS}）。 */
export const UPSTREAM_POLL_TIMEOUT_MS = 30_000

/** 视频创建阶段重试次数（含首次；`withUpstreamRetry` 的默认 `attempts`）。 */
export const VIDEO_CREATE_RETRY_ATTEMPTS = 3

/** 创建重试退避基数（`base * 2^i`；`withUpstreamRetry` 的默认 `baseDelayMs`）。 */
export const VIDEO_CREATE_RETRY_BASE_DELAY_MS = 1_500

/** 创建重试退避总和 = base × (2^(attempts-1) − 1)（attempts−1 次延迟，指数翻倍）。 */
export const VIDEO_CREATE_RETRY_BACKOFF_MS =
  VIDEO_CREATE_RETRY_BASE_DELAY_MS * (2 ** (VIDEO_CREATE_RETRY_ATTEMPTS - 1) - 1)

/**
 * 创建阶段最坏耗时上界 = attempts × 单次超时 + 退避总和。
 * 当前 = 3×45s + 4.5s = 139.5s（只在「隧道全死、每次创建都挂满超时」的病理
 * 场景触发；V6 真正要救的 429/503 是毫秒级响应，实际只多 ~4.5s）。
 */
export const VIDEO_CREATE_RETRY_WORST_MS =
  VIDEO_CREATE_RETRY_ATTEMPTS * UPSTREAM_FETCH_TIMEOUT_MS + VIDEO_CREATE_RETRY_BACKOFF_MS

/**
 * 各 video provider 的轮询 deadline（`maxPollMs`）。
 * - `falH3Max` 透传 `options.maxPollMs` 给 `runFalVideoQueue`，缺省继承 `fal`。
 * - Agnes 不在表内（循环制无 deadline，见文件头「已知例外」）。
 */
export const VIDEO_POLL_DEADLINE_MS = {
  apimart: 600_000,
  fal: 600_000,
  minimaxH3: 1_200_000,
} as const

/** 全 provider 最大的轮询 deadline（当前 = MiniMax H3 的 20min）。 */
export const MAX_VIDEO_POLL_DEADLINE_MS = Math.max(...Object.values(VIDEO_POLL_DEADLINE_MS))

/** 服务端单笔视频最坏总耗时（创建重试上界 + 最大轮询 deadline）。当前 ≈22.3min。 */
export const VIDEO_SERVER_WORST_MS = MAX_VIDEO_POLL_DEADLINE_MS + VIDEO_CREATE_RETRY_WORST_MS

/** web 墙钟在服务端最坏总耗时之上保留的最小缓冲（用户拿得到最终错误信息）。 */
export const WEB_SETTLE_BUFFER_MS = 60_000

/**
 * web 墙钟**下限**（锁测试断言用）。实际墙钟在其上再加防御余量取整。
 */
export const SETTLE_TIMEOUT_FLOOR_MS = VIDEO_SERVER_WORST_MS + WEB_SETTLE_BUFFER_MS

/**
 * 前端「等节点落定」的墙钟（`apps/web` `generationPollGate` 消费）。
 * 当前 = 1_460_000 = 服务端最坏（≈22.3min）+ ~120.5s 防御余量
 * （PR #301 定值；行为保持，不要无谓下调）。
 */
export const DEFAULT_SETTLE_TIMEOUT_MS = 1_460_000

/**
 * reaper 对 video 的默认回收阈值（分钟；env `LNKPI_VIDEO_REAP_MINUTES` 可覆盖）。
 * 当前 30min = 服务端最坏 ≈22.3min + ~7.7min 缓冲（PR #305 行为保持）。
 */
export const DEFAULT_VIDEO_REAP_MINUTES = 30
