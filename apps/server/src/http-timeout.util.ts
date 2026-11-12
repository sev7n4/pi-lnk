/**
 * 给任意 promise 套硬超时护栏（与下游是否支持 AbortSignal 解耦）。
 *
 * 本仓所有下行 I/O（upstreamFetch 等）调用点只传 url、不传 signal。一旦对端连接被
 * 黑洞（SYN 无响应 / 防火墙静默丢包），fetch 会**永久挂起**——既无超时也无重试上限，
 * 导致整轮对话卡死、SSE 永不回包（agent.service.pi-runtime 识图用例曾在 CI 无网络环境
 * 触发 vitest 5s 超时；生产中则是用户上传参考图后整轮无响应）。
 *
 * 用 Promise.race 在调用方这一层强制截断：超时即 reject，调用方按自身重试/兜底策略
 * 处理（fail-soft 回落到识图兜底或跳过该图）。底层已发起的请求不会被取消，但不再阻塞
 * 主流程——这是在不改造第三方 fetch 实现前提下的兜底方案。
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}
