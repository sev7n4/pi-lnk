// A3 · 移动端回访作品带接线契约（2026-10-22）
//
// 钉住三件会静默坏掉的事：
// ① 落点：作品带在**滚动流内、空态块之前** —— 若放进空态块（`v-else-if="!agent.messages.length"`），
//    则有历史消息时永不出现（实测移动端几乎总是有历史：进项目即 loadHistory），
//    P0「最大价值」上线后没人看得见。
// ② 只在移动端渲染：PC 侧栏不该凭空多一条带子（AGENTS.md「移动端呈现」第 1/2 条）。
// ③ 数据从后端 list 来（canvasApi.list 带 coverUrl/coverNodeId），
//    且**点击要带 focusNode** —— 不带就退化成「打开画布」，规格的「定位到产物」落空。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(join(here, p), 'utf8')

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')
}

describe('A3 移动端回访作品带接线契约', () => {
  const rail = stripComments(read('./AgentSideRail.vue'))

  it('引入了 MobileRecentWorksStrip 组件', () => {
    expect(rail).toContain('MobileRecentWorksStrip')
  })

  it('⭐ 作品带在滚动流内，且在「空态块」之前（不是塞进空态块里）', () => {
    const stripIdx = rail.indexOf('<MobileRecentWorksStrip')
    const firstscreenIdx = rail.indexOf('agent-composer-firstscreen')
    const scrollIdx = rail.indexOf('agent-chat-scroll')
    expect(stripIdx, '必须找到作品带渲染点').toBeGreaterThan(-1)
    expect(firstscreenIdx, '必须找到空态块').toBeGreaterThan(-1)
    expect(scrollIdx, '必须找到滚动流').toBeGreaterThan(-1)
    expect(stripIdx, '作品带必须在滚动流内').toBeGreaterThan(scrollIdx)
    expect(
      stripIdx,
      '作品带必须在空态块之前 —— 塞进空态块 ⇒ 有历史消息时永不出现（移动端几乎总有历史）',
    ).toBeLessThan(firstscreenIdx)
  })

  it('只在移动端渲染（PC 侧栏零变化）', () => {
    const tag = rail.match(/<MobileRecentWorksStrip[\s\S]*?\/>/)?.[0] ?? ''
    expect(tag).toMatch(/v-if="[^"]*isMobileLayout/)
  })

  it('数据来自画布列表（canvasApi.list），消费 coverUrl / coverNodeId', () => {
    expect(rail).toContain('canvasApi.list')
    expect(rail).toContain('coverUrl')
    expect(rail).toContain('coverNodeId')
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

  it('列表加载有失败兜底（不让一条带子把对话面板搞崩）', () => {
    expect(rail).toMatch(/recentWorks[A-Za-z]*\s*=\s*ref/)
  })

  it('⭐ 挂载时就会拉列表（不是等抽屉打开 —— 带子在对话页签顶部）', () => {
    // ⚠️ 判据必须卡「挂载时有加载调用」——
    // 只断言状态存在（recentWorks = ref(...)）测不到「忘了调 load」，
    // 实测：删掉挂载里的加载调用，测试仍全绿。
    //
    // ⚠️ 文件里有**多个** onMounted ⇒ 不能用惰性 match 取第一个
    // （会匹配到无关的那个，判据永远失败）。收集全部后断言任一命中。
    const mountedBlocks = rail.match(/onMounted\(\(\)\s*=>\s*\{[\s\S]*?\n\}\)/g) ?? []
    expect(mountedBlocks.length, '必须能找到 onMounted 块').toBeGreaterThan(0)
    expect(
      mountedBlocks.some((b) => b.includes('loadRecentWorks()')),
      '至少一个 onMounted 里必须调用 loadRecentWorks()（带子在对话页签顶部，不是等抽屉打开）',
    ).toBe(true)
  })
})
