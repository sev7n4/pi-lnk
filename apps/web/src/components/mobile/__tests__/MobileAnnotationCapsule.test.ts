import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileAnnotationCapsule from '../MobileAnnotationCapsule.vue'

describe('MobileAnnotationCapsule（§17-③ 胶囊意见框）', () => {
  it('visible=false 不渲染（首笔前无浮条）', () => {
    const w = mount(MobileAnnotationCapsule, { props: { visible: false } })
    expect(w.find('[data-testid="mobile-annotation-capsule"]').exists()).toBe(false)
  })

  it('visible=true 渲染输入框与锚按钮', () => {
    const w = mount(MobileAnnotationCapsule, { props: { visible: true } })
    expect(w.find('[data-testid="mobile-annotation-capsule-input"]').exists()).toBe(true)
    expect(w.find('[data-testid="mobile-annotation-capsule-anchor"]').exists()).toBe(true)
  })

  it('填字后点锚 ⇒ anchor payload {text}', async () => {
    const w = mount(MobileAnnotationCapsule, { props: { visible: true } })
    await w.find('[data-testid="mobile-annotation-capsule-input"]').setValue('圈选的配色太冷了  ')
    await w.find('[data-testid="mobile-annotation-capsule-anchor"]').trigger('click')
    expect(w.emitted('anchor')).toEqual([[{ text: '圈选的配色太冷了' }]]) // trim
  })

  it('不填字直接点锚 ⇒ payload {text:""}（纯图带回）', async () => {
    const w = mount(MobileAnnotationCapsule, { props: { visible: true } })
    await w.find('[data-testid="mobile-annotation-capsule-anchor"]').trigger('click')
    expect(w.emitted('anchor')).toEqual([[{ text: '' }]])
  })

  it('uploading 时锚 disabled 且点击不 emit', async () => {
    const w = mount(MobileAnnotationCapsule, { props: { visible: true, uploading: true } })
    const btn = w.find('[data-testid="mobile-annotation-capsule-anchor"]')
    expect((btn.element as HTMLButtonElement).disabled).toBe(true)
    await btn.trigger('click')
    expect(w.emitted('anchor')).toBeUndefined()
  })

  it('重新弹出时清空上次文字（防上一次意见误带回；v1.5 Q：清空为实例级——消费方 v-if 重建实例，挂载即重置）', async () => {
    // 胶囊契约改为「实例生命周期 = 一次弹出会话」（挂载初始化 text=draftPrefix）：
    // 同实例 visible 翻转不再清空；消费方（MobileNodeViewer）用 v-if 重建实例实现重置。
    // ⭐ 禁回退成 watch(visible) 清空——Teleport stub 多实例 diff 下 watch 时序不可靠（G-23 踩坑实录）。
    const first = mount(MobileAnnotationCapsule, { props: { visible: true } })
    await first.find('[data-testid="mobile-annotation-capsule-input"]').setValue('旧意见')
    first.unmount()
    const second = mount(MobileAnnotationCapsule, { props: { visible: true } })
    expect((second.find('[data-testid="mobile-annotation-capsule-input"]').element as HTMLInputElement).value).toBe('')
    second.unmount()
  })

  it('v2 单行胶囊：输入框内回车 = 提交（⯈ 无需伸手点锚）', async () => {
    const w = mount(MobileAnnotationCapsule, { props: { visible: true } })
    await w.find('[data-testid="mobile-annotation-capsule-input"]').setValue('回车带回')
    await w.find('[data-testid="mobile-annotation-capsule-input"]').trigger('keydown', { key: 'Enter' })
    expect(w.emitted('anchor')).toEqual([[{ text: '回车带回' }]])
  })
})
