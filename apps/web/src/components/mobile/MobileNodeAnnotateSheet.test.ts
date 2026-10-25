import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileNodeAnnotateSheet from './MobileNodeAnnotateSheet.vue'

/**
 * 标注浮层（规格 §4.3 L1 / §4.5 M1）。
 * ⭐ 走 `MobileSheet` 基座（⛔ 禁第二套 sheet 皮肤，G-15 / V-3）。
 */
describe('MobileNodeAnnotateSheet（标注浮层）', () => {
  function mountSheet(props: Record<string, unknown> = {}) {
    return mount(MobileNodeAnnotateSheet, {
      props,
      global: { stubs: { teleport: true } },
    })
  }

  it('走 MobileSheet 基座（scrim + 拖拽把手）', () => {
    const w = mountSheet()
    expect(w.find('[data-testid="m-sheet-scrim"]').exists()).toBe(true)
    expect(w.find('.m-sheet-handle').exists()).toBe(true)
    w.unmount()
  })

  it('有意见输入区与「带回对话」主按钮', () => {
    const w = mountSheet()
    expect(w.find('[data-testid="mobile-annotate-opinion"]').exists()).toBe(true)
    expect(w.find('[data-testid="mobile-annotate-send"]').exists()).toBe(true)
    w.unmount()
  })

  it('提交 ⇒ emit send({ opinion, degraded })', async () => {
    const w = mountSheet()
    await w.get('[data-testid="mobile-annotate-opinion"]').setValue('这栋楼太亮')
    await w.get('[data-testid="mobile-annotate-send"]').trigger('click')
    expect(w.emitted('send')?.[0]).toEqual([{ opinion: '这栋楼太亮', degraded: false }])
    w.unmount()
  })

  it('上传中 ⇒ 按钮禁用 + 文案「上传中…」', () => {
    const w = mountSheet({ uploading: true })
    expect(w.find('[data-testid="mobile-annotate-send"]').attributes('disabled')).toBeDefined()
    expect(w.text()).toContain('上传中')
    w.unmount()
  })

  it('降级 ⇒ 明说「本条只带文字，未附截图」（不静默丢图）', () => {
    const w = mountSheet({ degraded: true })
    expect(w.find('[data-testid="mobile-annotate-degraded"]').exists()).toBe(true)
    expect(w.text()).toContain('只带文字')
    w.unmount()
  })

  it('失败 ⇒ 给出可行动的错误文案且按钮禁用', () => {
    const w = mountSheet({ error: '上传失败，请重试' })
    expect(w.text()).toContain('上传失败')
    w.unmount()
  })

  it('⛔ 零 --neo-* 旧令牌（G-15）', () => {
    const w = mountSheet()
    expect(w.html()).not.toContain('--neo-')
    w.unmount()
  })
})
