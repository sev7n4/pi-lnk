/** 沙箱契约常量（规格 §4.3 定稿；守卫测试逐字符钉死）。 */
export const HTML_NODE_CSP =
  "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data: blob:; connect-src 'none'"
export const HTML_NODE_SANDBOX_ATTRS = 'allow-scripts'

/**
 * 受信级 CSP 生成（spec 2026-11-05-canvas-digest-design §5.2）：
 * 仅 `data.source === 'system-digest'` 的系统管道产物可用（fail-closed——无标记不走受信级）。
 * Ruling（Task 3）：静态常量无法携带本站媒体 origin——srcdoc（sandbox 无 allow-same-origin）
 * 是 opaque origin，'self' 不可用，而硬编码 origin 在域变更时静默裂图
 * ⇒ 以 buildTrustedNodeCsp(origin) 函数形态落地（规格 §5.2「常量」表述同步小修）。
 * 基线 = 既有 HTML_NODE_CSP 逐字符保留，仅扩展 img-src 段并新增 media-src
 * （video tile 首帧 `<video>` 需要 media-src；img-src 放行本站媒体域）。
 */
export function buildTrustedNodeCsp(mediaOrigin: string): string {
  return HTML_NODE_CSP.replace(
    'img-src data: blob:;',
    `img-src data: blob: ${mediaOrigin}; media-src data: blob: ${mediaOrigin};`,
  )
}
