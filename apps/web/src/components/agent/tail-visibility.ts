/**
 * 常驻订阅（followUpTail）的**可见性策略**。
 *
 * 抽出来的理由（与 `follow-up-tail.ts` 同款）：`AgentSideRail.vue` 是 3000 行 SFC，
 * 挂载它需要整套 store / fetch / auth 桩；但「后台是否释放连接」恰恰是本次修复的
 * 全部内容 —— 依赖可注入 ⇒ 这个策略可以被**单测**，而不是只靠静态契约兜着。
 *
 * ⭐ 为什么后台必须释放（2026-10-25 生产取证）：
 *   常驻订阅是会话级 SSE，断线 5s 封顶重连、永不放弃。原实现只在「切回前台」时
 *   `resume()`，**从不释放后台订阅** ⇒ 每个后台标签页永久占着一条连接。Chrome 对
 *   单个 host 只有 6 条 HTTP/1.1 连接，后台页一多、再叠加偶发的传输卡死，前台请求
 *   就全部排队饿死（项目抽屉「项目加载中」转不完的成因之一）。
 *
 *   切回来不丢内容：`resume()` 带 `lastSeq` 游标续传，只补增量不重放。
 */

export interface TailVisibilityDeps {
  isVisible: () => boolean
  hasAuthToken: () => boolean
  /** 本端主流是否在跑（那份文本已由 POST 响应体送达，旁听再收就是双倍文本）。 */
  isMainStreamRunning: () => boolean
  resume: () => void
  abort: () => void
}

export type TailVisibilityAction = 'resumed' | 'aborted' | 'skipped'

/**
 * 按可见性裁定常驻订阅：前台挂上、后台掐断、其余不动。
 * 返回值是**可观测出口**（单测据此断言，而不是断言「某个函数被提到过」）。
 */
export function applyTailVisibility(deps: TailVisibilityDeps): TailVisibilityAction {
  // 未登录不订阅：请求只会拿到 401，并连带一轮无意义的退避重连。
  if (!deps.hasAuthToken()) return 'skipped'
  if (!deps.isVisible()) {
    // 后台：立刻掐断（含在途 fetch 与退避等待），把连接让给前台。
    deps.abort()
    return 'aborted'
  }
  // 前台：本端主流在跑时不挂（那份内容主流自己会给）。
  if (deps.isMainStreamRunning()) return 'skipped'
  deps.resume()
  return 'resumed'
}
