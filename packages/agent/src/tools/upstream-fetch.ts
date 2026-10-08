/**
 * 上游（模型/图像/视频 API）调用的**统一超时**。
 *
 * ⚠️ 2026-10-08 生产事故引入本模块。根因链条：
 *   1. 容器出站**全部**经宿主一条 SSH 反向隧道（`socat :17891` →
 *      宿主 `127.0.0.1:17890` → 个人机）。隧道楔死时 **TCP 层看起来是健康的**
 *      —— 宿主监听在、连接能建立 —— 但数据永不返回。
 *   2. 此前上游 `fetch` **一处 `AbortSignal` 都没有** ⇒ `await` 永不 settle。
 *   3. 于是 `completeImage()` 永不返回：生成记录永久停在 `generating`，
 *      **既不落 `failed` 也不落 `fallback_pending`**，BYOK 不退款，
 *      前端只能等 22 分钟的兜底超时。故障表现为「任务不返回」而不是「任务失败」，
 *      所以监控看不到、用户只能干等。
 *
 * ⇒ 纪律：**上游调用一律走 `upstreamFetch`**，把「无限等待」变成「有界失败」。
 * 超时可被 `withUpstreamRetry` 判为可重试（见下方文案约束）。
 */

/**
 * 默认单次尝试上限。
 *
 * ⚠️ 这个值是**算出来的，不是拍的**：创建类调用外面裹着
 * `withUpstreamRetry`（3 次尝试，退避 1.5s + 3s），所以最坏耗时
 * `3 * 45s + 4.5s = 139.5s`，必须**小于**编排层的
 * `LNKPI_IMAGE_GEN_TIMEOUT_SEC=180`。否则编排层先超时掐断，
 * 记录又会停在 `generating` —— 正是本次事故要消灭的形态。
 * 改大它之前先重算这条不等式，`upstream-fetch.test.ts` 里有断言锁住。
 */
export const UPSTREAM_FETCH_TIMEOUT_MS = 45_000

/** 轮询类请求（响应体很小）用更短的上限，保证轮询周期不被单次卡死吃掉。 */
export const UPSTREAM_POLL_TIMEOUT_MS = 30_000

export class UpstreamTimeoutError extends Error {
  readonly code = 'UPSTREAM_TIMEOUT'

  constructor(
    readonly url: string,
    readonly timeoutMs: number,
  ) {
    // ⚠️ 文案必须含 ASCII 的 `timeout`：`upstream-retry.ts` 的
    // `RETRYABLE` 用 `/timed? ?out/i` 判定可重试，中文「超时」匹配不到。
    // 改这句文案会让超时从「可重试」静默降级为「不可重试」。
    super(`upstream timeout after ${timeoutMs}ms: ${url}`)
    this.name = 'UpstreamTimeoutError'
  }
}

export interface UpstreamFetchInit extends RequestInit {
  /** 单次尝试的超时（ms）。默认 {@link UPSTREAM_FETCH_TIMEOUT_MS}。 */
  timeoutMs?: number
}

/**
 * `fetch` + 必然的有界超时。
 *
 * - 超时 → 抛 {@link UpstreamTimeoutError}（`isRetryableUpstreamError` 判为可重试）。
 * - 调用方自带 `signal` 时二者取**先触发者**；调用方主动中止时原样抛出，
 *   不伪装成超时（否则「用户取消」会被重试逻辑反复重放）。
 * - 不使用 `AbortSignal.timeout/any`：手写 `AbortController` 以兼容低版本
 *   Node，并且能精确区分「我方超时」与「调用方中止」。
 */
export async function upstreamFetch(url: string, init: UpstreamFetchInit = {}): Promise<Response> {
  const { timeoutMs = UPSTREAM_FETCH_TIMEOUT_MS, signal, ...rest } = init
  const controller = new AbortController()
  let timedOut = false

  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          controller.abort(new UpstreamTimeoutError(url, timeoutMs))
        }, timeoutMs)
      : undefined

  const forwardAbort = () => controller.abort((signal as AbortSignal).reason)
  if (signal) {
    if (signal.aborted) forwardAbort()
    else signal.addEventListener('abort', forwardAbort, { once: true })
  }

  try {
    return await fetch(url, { ...rest, signal: controller.signal })
  } catch (err) {
    if (timedOut) throw new UpstreamTimeoutError(url, timeoutMs)
    throw err
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener('abort', forwardAbort)
  }
}
