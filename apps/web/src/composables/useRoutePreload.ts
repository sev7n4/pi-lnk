/**
 * 路由分包预热（2026-10-24 性能修复；同日**二次修正**）。
 *
 * ## 第一次做错了什么（生产事故取证）
 *
 * 初版在两处预热画布页分包：
 *   ① `App.vue` 的 `onMounted` → 空闲预热
 *   ② 品牌页 `WorkflowPage.vue` 的 `onMounted` → **立即**预热
 *
 * 生产实测（headless Chrome 抓 `performance.getEntriesByType('resource')`）：
 *
 *   | 资源                               | 完成时刻   |
 *   |------------------------------------|-----------|
 *   | `index-*.js`（入口 140KB）         | 2493ms    |
 *   | `index-*.css`（入口 27KB）         | 2316ms    |
 *   | **`/brand/mascot-logo.png` 535KB** | **17092ms**（本该 ~2100ms） |
 *   | `CanvasPage-*.js` 338KB            | 9447ms    |
 *   | `load` 事件                        | **17093ms** |
 *   | 总请求数                           | **59 个** |
 *
 * ⇒ 预热在 **4166ms** 拉起了画布页整棵依赖树（CanvasPage 338KB + 24 个同步 chunk），
 *   与首屏资源**抢同域 6 个 HTTP/1.1 连接**：
 *   - 535KB 的品牌 logo 被从 2.1 秒拖到 **13 秒**（首屏第二大头直接变第一大头）；
 *   - `/api/works` 8569ms 才开始（被排队）⇒ **登录等 API 同样被排队**，
 *     这就是用户报的「连登录都出问题」；
 *   - `load` 事件 17 秒 ⇒ 用户看到的是「品牌页半天出不来、点创作没反应」。
 *
 * ⚠️ **教训**：在「慢出网 + 每域 6 连接」的环境里，**首屏期间预热最重的页面是有害的**。
 *   预加载的收益（点创作命中缓存）远小于它对首屏与 API 的挤占。
 *
 * ## 现在的做法：两个都不抢首屏的时机
 *
 * **A. 首屏彻底就绪之后**（`load` 事件 → 空闲回调）
 *    此时首屏资源都下完了，带宽空出来 ⇒ 预热不再抢任何东西。
 *    ⛔ 删掉了 `App.vue` 的「挂载即空闲预热」—— `load` 之前预热 = 事故那次的元凶。
 *
 * **B. 用户意图触发**（鼠标移到锚 / 焦点进入 / 触摸开始）
 *    用户已经把指针放到「进入创作」的入口上了 ⇒ 意图明确，且此刻首屏早已就绪。
 *    标准做法（intent-based prefetch），命中率比「无脑空闲预热」更高。
 *
 * ## 为什么仍然值得保留
 *
 * 画布页仍是全站最重的跳转（CanvasPage 338KB + 依赖 ≈ 374KB），
 * 点「锚」时才开始下载依旧要等 1~2 秒。预热把这段等待挪到用户「还没点」的时候。
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

/** 已预热过：避免重复触发（多次 import 同一 chunk 会被浏览器去重，但这里省一次调用）。 */
let preloaded = false

/**
 * 预热画布页分包。
 *
 * ⚠️ 这里必须是**字面量** `import('@/pages/CanvasPage.vue')`：
 *    Vite 靠字面量识别懒加载边界。改成变量路径会让 Vite 失去分包能力，
 *    或者（更糟）把它变成静态依赖拉进 entry chunk —— 那样首屏会变大。
 *
 * ⛔ 失败静默吞掉：预热是**优化**，不是功能依赖，
 *    失败时仍然可以走正常点击路径（那次点击会自己触发加载）。
 */
export function preloadCanvasChunk(): void {
  if (preloaded) return
  preloaded = true
  try {
    // 字面量动态 import ⇒ 独立 chunk + 运行时按需下载
    void import('@/pages/CanvasPage.vue').catch(() => {
      // 预热失败不影响主流程（点击时仍会正常触发加载）
    })
  } catch {
    // 预热失败不影响主流程
  }
}

/**
 * 首屏彻底就绪后预热。
 *
 * ⛔ **必须等 `load` 事件**（或已经过了），不能在挂载时调用 ——
 *    `load` 之前首屏资源还在下载，预热会与之抢连接（见文件头的事故取证）。
 *
 * - 已经 `load` 过（用户晚进入某页）⇒ 直接在下一个空闲回调里预热；
 * - 还没 `load` ⇒ 挂 `load` 监听，等到了再预热。
 */
export function schedulePreloadAfterFirstPaint(): void {
  const run = () => onIdle(() => preloadCanvasChunk())
  if (document.readyState === 'complete') {
    run()
    return
  }
  window.addEventListener('load', run, { once: true })
}

/**
 * 用户意图触发预热（推荐入口）。
 *
 * 挂在「进入创作」入口的 `pointerenter` / `focusin` / `touchstart` 上：
 * 此刻用户已明确表达意图，且首屏早已就绪 ⇒ 不抢任何东西。
 *
 * @param el 触发意图的元素（`document.querySelector` 返回 `Element | null`）
 */
export function preloadOnIntent(el: Element | null | undefined): void {
  if (!el) return
  const once = () => preloadCanvasChunk()
  el.addEventListener('pointerenter', once, { once: true, passive: true })
  el.addEventListener('focusin', once, { once: true, passive: true })
  el.addEventListener('touchstart', once, { once: true, passive: true })
}
