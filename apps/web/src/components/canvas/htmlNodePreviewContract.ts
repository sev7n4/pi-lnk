/** 沙箱契约常量（规格 §4.3 定稿；守卫测试逐字符钉死）。 */
export const HTML_NODE_CSP =
  "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data: blob:; connect-src 'none'"
export const HTML_NODE_SANDBOX_ATTRS = 'allow-scripts'

/**
 * 受信级 HTML 的媒体 origin 白名单提取（2026-11-07 真机事故）。
 *
 * 生产媒体 `data.url` 是生成服务返回的**第三方绝对地址**
 * （如 `https://platform-outputs.agnes-ai.space/...png`），不是本站相对路径。
 * 旧受信 CSP 只放行 `window.location.origin` ⇒ 所有缩略图被 CSP 拦下、
 * `onerror` 降级成 icon-fallback ⇒ 规格 P0「真缩略图」从未生效（会话流里
 * 同样的图却正常，因为宿主页面不受 srcdoc CSP 约束）。
 *
 * 纪律：仍然 fail-closed——只放行**本文档实际引用**的 http/https 媒体 URL 的
 * origin，绝不放行通配符；取 `new URL().origin`（scheme + host + port），
 * 天然不含路径 / 引号 / 分号，无法借此注入 CSP 指令。相对 URL / data: /
 * blob: / javascript: 一律忽略（相对 URL 在 srcdoc opaque origin 下必裂，D8）。
 */
export function collectTrustedMediaOrigins(content: string): string[] {
  // 只认媒体标签的 src/poster，不扫任意属性（防把 data-* 里的 URL 抬进白名单）。
  const attrRe = /(?:<img\b|<video\b|<audio\b|<source\b)[^>]*?\s(?:src|poster)\s*=\s*["']([^"']+)["']/gi
  const origins = new Set<string>()
  for (const m of content.matchAll(attrRe)) {
    const raw = m[1].trim()
    if (!/^https?:\/\//i.test(raw)) continue
    try {
      const u = new URL(raw)
      if (u.protocol === 'http:' || u.protocol === 'https:') origins.add(u.origin)
    } catch {
      // 畸形 URL：忽略，不扩面
    }
  }
  return [...origins].sort()
}

/**
 * 受信级 CSP 生成（spec 2026-11-05-canvas-digest-design §5.2）：
 * 仅 `data.source === 'system-digest'` 的系统管道产物可用（fail-closed——无标记不走受信级）。
 * Ruling（Task 3）：静态常量无法携带本站媒体 origin——srcdoc（sandbox 无 allow-same-origin）
 * 是 opaque origin，'self' 不可用，而硬编码 origin 在域变更时静默裂图
 * ⇒ 以 buildTrustedNodeCsp(origin) 函数形态落地（规格 §5.2「常量」表述同步小修）。
 * 基线 = 既有 HTML_NODE_CSP 逐字符保留，仅扩展 img-src 段并新增 media-src
 * （video tile 首帧 `<video>` 需要 media-src；img-src 放行本站媒体域）。
 *
 * `extraOrigins`（2026-11-07）：由 `collectTrustedMediaOrigins(content)` 派生的
 * 第三方媒体域。二次过滤只接受纯 http/https origin，且不放行通配符；
 * 无参调用的输出与旧实现逐字符一致（既有守卫不动）。
 */
export function buildTrustedNodeCsp(mediaOrigin: string, extraOrigins: readonly string[] = []): string {
  const extras = [...new Set(extraOrigins)]
    .filter((o) => /^https?:\/\/[^;\s"'<>]+$/.test(o))
    .filter((o) => o !== mediaOrigin)
    .filter((o) => !o.includes('*'))
  const allow = ['data:', 'blob:', mediaOrigin, ...extras].join(' ')
  return HTML_NODE_CSP.replace('img-src data: blob:;', `img-src ${allow}; media-src ${allow};`)
}

/**
 * 受信级 HTML 在移动端 viewer 的顶部安全区（2026-11-07 真机截图）。
 * `MobileViewerChrome` 的右上 X 是 `position:absolute; right; z-index:4`，
 * 直接盖住 srcdoc Header 右端的「更新 HH:mm」。仅对 system-digest 注入，
 * 让 Header 整行右边界内缩避开宿主 chrome；非受信 HTML 版式逐字节不变。
 */
export const TRUSTED_HEADER_SAFE_AREA_CSS = '.header { padding-right: 60px; }'
