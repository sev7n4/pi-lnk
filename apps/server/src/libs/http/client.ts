/**
 * 统一出网 HTTP client 端口（主线 B / 治本 R-IO-1）。
 *
 * 所有下行网络调用必须走这里，禁止在业务代码里直接 `upstreamFetch(url)` 或手写
 * `withTimeout(upstreamFetch(url), ...)`：超时护栏集中在端口内，单点连接被黑洞时
 * 最坏 timeoutMs 内 fail-soft，不再整轮挂死（agent.service.pi-runtime 识图用例曾在
 * CI 无网络环境触发 vitest 5s 超时；生产中是用户上传参考图后整轮无响应）。
 *
 * 上游 `upstreamFetch`（@lnkpi/agent）只传 url、不认 AbortSignal；本端口用
 * `withTimeout` 在调用方层强制截断（与下游是否认 signal 解耦）。默认 5000ms，
 * 调用方可按场景覆盖（如视频预检拒绝路径预算更紧，见 upstream-ref-downscale.ts 注释）。
 */
import { upstreamFetch } from '@lnkpi/agent'
import { withTimeout } from '../../http-timeout.util'

export interface HttpGetOptions {
  /** 硬超时（ms）。默认 5000。黑洞连接下最坏该时长内 reject。 */
  timeoutMs?: number
}

export const DEFAULT_HTTP_TIMEOUT_MS = 5000

/** 统一出网 GET 端口：封装 upstreamFetch + 硬超时护栏。 */
export async function httpGet(url: string, opts: HttpGetOptions = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS
  return withTimeout(upstreamFetch(url), timeoutMs, `参考图下载 ${url}`)
}

/** 实例形态，便于注入/替换（测试可整体 mock 这一层）。 */
export const httpClient = { get: httpGet }
