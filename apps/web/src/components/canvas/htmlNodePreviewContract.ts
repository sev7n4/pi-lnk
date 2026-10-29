/** 沙箱契约常量（规格 §4.3 定稿；守卫测试逐字符钉死）。 */
export const HTML_NODE_CSP =
  "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data: blob:; connect-src 'none'"
export const HTML_NODE_SANDBOX_ATTRS = 'allow-scripts'
