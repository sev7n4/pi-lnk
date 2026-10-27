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

  it('重新弹出时清空上次文字（防上一次意见误带回）', async () => {
    const w = mount(MobileAnnotationCapsule, { props: { visible: true } })
    await w.find('[data-testid="mobile-annotation-capsule-input"]').setValue('旧意见')
    await w.setProps({ visible: false })
    await w.setProps({ visible: true })
    expect((w.find('[data-testid="mobile-annotation-capsule-input"]').element as HTMLTextAreaElement).value).toBe('')
  })
})
