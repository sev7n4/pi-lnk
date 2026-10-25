// A3 · 回访作品带接线契约（跨端复用，2026-10-25）
//
// 钉住三件会静默坏掉的事：
// ① 落点：作品带在**滚动流内、空态块之前** —— 若放进空态块，则有历史消息时永不出现。
// ② 断点中立：去掉了 isMobileLayout 门槛，PC 左栏与移动端对话框顶部都展示（不再专属移动端）。
// ③ 数据来源收敛到 useProjectWorkspace 单一数据源（INV-10）：AgentSideRail 不再直接调
//    canvasApi.list；作品带与抽屉共用 `projects`，点击仍带 focusNode。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(join(here, p), 'utf8')

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')
}

describe('A3 回访作品带接线契约（跨端复用）', () => {
  const rail = stripComments(read('./AgentSideRail.vue'))

  it('引入了 RecentProjectsStrip 组件', () => {
    expect(rail).toContain('RecentProjectsStrip')
  })

  it('⭐ 作品带在滚动流内，且在「空态块」之前（不是塞进空态块里）', () => {
    const stripIdx = rail.indexOf('<RecentProjectsStrip')
    const firstscreenIdx = rail.indexOf('agent-composer-firstscreen')
    const scrollIdx = rail.indexOf('agent-chat-scroll')
    expect(stripIdx, '必须找到作品带渲染点').toBeGreaterThan(-1)
    expect(firstscreenIdx, '必须找到空态块').toBeGreaterThan(-1)
    expect(scrollIdx, '必须找到滚动流').toBeGreaterThan(-1)
    expect(stripIdx, '作品带必须在滚动流内').toBeGreaterThan(scrollIdx)
    expect(
      stripIdx,
      '作品带必须在空态块之前 —— 塞进空态块 ⇒ 有历史消息时永不出现',
    ).toBeLessThan(firstscreenIdx)
  })

  it('⭐ 断点中立：去掉了 isMobileLayout 门槛（PC 左栏同显，不再是移动端专属）', () => {
    const tag = rail.match(/<RecentProjectsStrip[\s\S]*?\/>/)?.[0] ?? ''
    expect(tag, '必须找到作品带渲染标签').toBeTruthy()
    expect(tag, '作品带渲染标签不得再带 isMobileLayout 门槛').not.toMatch(/isMobileLayout/)
  })

  it('数据来源收敛到 useProjectWorkspace（INV-10：AgentSideRail 不再直接调 canvasApi.list）', () => {
    expect(rail).toContain('useProjectWorkspace')
    expect(rail, 'AgentSideRail 不得再直接调用 canvasApi.list（已收敛到 workspace）').not.toContain('canvasApi.list(')
    // 作品带与抽屉共用 projects（单一数据源）
    expect(rail).toContain(':works="projects"')
  })

  it('点击作品带 focusNode 跳转（打开画布 + 定位到那张产物图）', () => {
    const handler = rail.match(/function handleRecentWorkOpen\([\s\S]*?\n\}/)?.[0] ?? ''
    expect(handler, '必须找到作品带点击处理器').toContain('focusNode')
    expect(handler).toContain('/workflow/')
    // ⚠️ 判据必须卡「URL 里真的带了 focusNode 参数」——
    // 只断言 toContain('focusNode') 会被 `payload.focusNodeId` 的子串顶替
    // （实测：把 URL 里的 focusNode 参数删掉，测试仍全绿）。
    expect(
      handler,
      '跳转 URL 必须带 focusNode 参数（只断言 focusNode 子串会被 payload.focusNodeId 顶替）',
    ).toMatch(/focusNode=\$\{encodeURIComponent\(payload\.focusNodeId\)\}/)
  })

  it('挂载时就会拉列表（断点中立：loadProjects 无条件，不再 only-mobile）', () => {
    // ⚠️ 文件里有**多个** onMounted ⇒ 不能用惰性 match 取第一个
    // （会匹配到无关的那个，判据永远失败）。收集全部后断言任一命中。
    const mountedBlocks = rail.match(/onMounted\(\(\)\s*=>\s*\{[\s\S]*?\n\}\)/g) ?? []
    expect(mountedBlocks.length, '必须能找到 onMounted 块').toBeGreaterThan(0)
    expect(
      mountedBlocks.some((b) => b.includes('loadProjects()')),
      '至少一个 onMounted 里必须调用 loadProjects()（作品带在对话页签顶部，断点中立）',
    ).toBe(true)
    expect(rail, '挂载处不得再有「仅移动端才拉」的门控').not.toContain('if (isMobileLayout.value) void loadRecentWorks()')
  })
})
