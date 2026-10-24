/**
 * 路由分包预热（2026-10-24 性能修复）。
 *
 * ## 为什么需要
 *
 * 生产实测：品牌页首屏渲染完成后，用户点「锚」/「滑动进入创作」才第一次触发
 * `/workflow/:id` 路由的懒加载分包 —— CanvasPage.js 362KB(gzip) + 18 个同步依赖
 * 385KB(gzip) + CSS 50KB ≈ **798KB**，在 ~300KB/s 的出网带宽上要等 2~3 秒，
 * 期间界面只有印章动画在转，用户感知是「点了没反应」。
 *
 * 关键点：**预热不能改变懒加载语义**（画布页仍是按需加载的独立 chunk），
 * 只是把「下载时机」从「点击那一刻」提前到「用户还没点的时候」。
 *
 * ## 为什么用动态 import 而不是 router 的 preload
 *
 * vue-router 没有官方的「预取路由组件」API（`router.preloadRoute` 不存在）。
 * 直接 `import('@/pages/CanvasPage.vue')` 会让 Vite 把该模块变成 **entry chunk 的
 * 静态依赖** ⇒ 画布页被拉回首屏，**反而更慢**。
 *
 * ⇒ 必须用「运行时动态 import」让 Vite 保留成独立 chunk：
 *   - 变量路径（配合 Vite 的 ignore 注释）会让 Vite 失去分包能力，或更糟——
 *     把它变成静态依赖拉进 entry chunk；
 *   - 正确做法：把 import 写在**函数体内**（Vite 认得 `() => import('...')` 这个字面量，
 *     会生成独立 chunk 并保留懒加载）。
 *
 * 这里用后者：`preloadChunk(() => import('@/pages/CanvasPage.vue'))` 的字面量形式，
 * Vite 会生成独立 chunk（不进 entry），运行时调用即触发下载。
 *
 * ## 时机
 *
 * 1. `scheduleIdlePreload()`：浏览器空闲时（`requestIdleCallback`，退化 `setTimeout`）
 *    预热**画布页**——它是全站最重、也是「进入项目」的唯一目标页。
 * 2. 品牌页 `onMounted` 立即预热：那是「点击创作」发生的地方，等空闲反而太晚。
 *
 * 预热失败（离线/弱网）静默吞掉：预热是**优化**，不是功能依赖，
 * 失败时仍然可以走正常点击路径（那次点击会自己触发加载）。
 */

/** 空闲回调：优先 requestIdleCallback，退化 setTimeout。 */
function onIdle(cb: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
    .requestIdleCallback
  if (typeof ric === 'function') {
    ric(cb, { timeout: 3000 })
  } else {
    setTimeout(cb, 200)
  }
}

/**
 * 预热画布页分包。
 *
 * ⚠️ 这里必须是**字面量** `import('@/pages/CanvasPage.vue')`：
 * Vite 靠字面量识别懒加载边界。改成变量路径会让 Vite 失去分包能力，
 * 或者（更糟）把它变成静态依赖拉进 entry chunk —— 那样首屏会变大。
 *
 * @returns 是否成功触发预热（不保证下载成功，只代表已发起）
 */
export function preloadCanvasChunk(): boolean {
  try {
    // 字面量动态 import ⇒ 独立 chunk + 运行时按需下载
    void import('@/pages/CanvasPage.vue')
    return true
  } catch {
    // 预热失败不影响主流程
    return false
  }
}

/**
 * 空闲时预热画布页分包（应用启动后调用一次）。
 *
 * 只在**非画布页**预热：已经在画布页时该分包早已加载完毕，再预热是空操作。
 */
export function scheduleIdlePreload(): void {
  onIdle(() => {
    preloadCanvasChunk()
  })
}
