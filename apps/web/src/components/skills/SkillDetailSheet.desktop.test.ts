// 二轮 R6（2026-11-18）：SkillDetailSheet 双形态守卫——
// PC（≥768px）居中窄卡 ≤480px（原 MobileSheet 全宽底部横条 1280×214 桌面错位）；移动端保持 MobileSheet。
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mount } from '@vue/test-utils'
import SkillDetailSheet from './SkillDetailSheet.vue'

const sfc = readFileSync(join(__dirname, 'SkillDetailSheet.vue'), 'utf8')

vi.mock('@/composables/useAgentMobileLayout', () => ({
  useAgentMobileLayout: () => ({ isMobileLayout: { value: false } }),
}))

describe('SkillDetailSheet 双形态（R6）', () => {
  it('移动端：MobileSheet 底部弹层；PC：Teleport 居中窄卡', () => {
    expect(sfc).toMatch(/<MobileSheet v-if="isMobile"/)
    expect(sfc).toContain('<Teleport v-else to="body">')
    expect(sfc).toContain('width: min(92vw, 480px)')
    expect(sfc).toContain("import { useAgentMobileLayout } from '@/composables/useAgentMobileLayout'")
  })

  it('PC 端挂载渲染居中卡，内容与移动端同源（detail-sheet 结构复用）', async () => {
    const w = mount(SkillDetailSheet, {
      props: { name: '内置技能甲', desc: '平台提供', kind: 'builtin' },
      attachTo: document.body,
    })
    await w.vm.$nextTick()
    // Teleport to body：wrapper.find 穿不过去，从 document.body 取证
    const el = document.body.querySelector('[data-testid="skill-detail-sheet-desktop"]')
    expect(el).not.toBeNull()
    expect(document.body.textContent).toContain('内置技能甲')
    expect(document.body.textContent).toContain('平台提供 · 常开 · 不可停用')
    w.unmount()
  })
})
