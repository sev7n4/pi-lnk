import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import HtmlNodePreview, {
  HTML_NODE_CSP,
  HTML_NODE_SANDBOX_ATTRS,
} from './HtmlNodePreview.vue'

const SAMPLE = '<!DOCTYPE html><html><body><h1>hi</h1><script>1+1</script></body></html>'

describe('HtmlNodePreview 沙箱契约（规格 §4.3/§10 行为级守卫）', () => {
  it('iframe sandbox 恰为 allow-scripts、无 src、且禁四项属性', () => {
    const w = mount(HtmlNodePreview, { props: { content: SAMPLE } })
    const iframe = w.find('iframe')
    const sb = iframe.attributes('sandbox') ?? ''
    expect(sb).toBe(HTML_NODE_SANDBOX_ATTRS) // 恰为 allow-scripts（收紧，防顺手追加 flags）
    expect(iframe.attributes('src')).toBeUndefined() // 有 srcdoc、无 src
    for (const banned of ['allow-same-origin', 'allow-top-navigation', 'allow-popups', 'allow-forms']) {
      expect(sb).not.toContain(banned)
    }
  })
  it('srcdoc 首部为 meta CSP 且串与定稿一致', () => {
    expect(HTML_NODE_CSP).toBe(
      "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data: blob:; connect-src 'none'",
    )
    const w = mount(HtmlNodePreview, { props: { content: SAMPLE } })
    const doc = w.find('iframe').attributes('srcdoc') ?? ''
    const cspIdx = doc.indexOf(HTML_NODE_CSP)
    expect(cspIdx).toBeGreaterThanOrEqual(0)
    expect(doc.indexOf('<!DOCTYPE')).toBeGreaterThan(cspIdx) // CSP 置最前（§5.4）
  })
  it('默认预览态；切源码后保存 emit save 且 payload 带 format:"html"', async () => {
    const w = mount(HtmlNodePreview, { props: { content: SAMPLE } })
    const sourceTab = w.findAll('[data-testid="html-tab"]').find((b) => b.text().includes('源码'))
    expect(sourceTab, '找不到「源码」tab').toBeTruthy()
    await sourceTab!.trigger('click')
    const ta = w.find('textarea')
    await ta.setValue('<p>edited</p>')
    await w.find('[data-testid="html-save"]').trigger('click')
    expect(w.emitted('save')?.[0]).toEqual([{ content: '<p>edited</p>', format: 'html' }])
  })
  it('readonly ⇒ 无源码 tab、无保存钮', () => {
    const w = mount(HtmlNodePreview, { props: { content: SAMPLE, readonly: true } })
    expect(w.findAll('[data-testid="html-tab"]').length).toBe(0)
    expect(w.find('textarea').exists()).toBe(false)
    expect(w.find('[data-testid="html-save"]').exists()).toBe(false)
  })
  it('非 embedded ⇒ 有关闭钮并 emit close；embedded ⇒ 无', async () => {
    const w = mount(HtmlNodePreview, { props: { content: SAMPLE } })
    await w.find('[data-testid="html-close"]').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
    const w2 = mount(HtmlNodePreview, { props: { content: SAMPLE, embedded: true } })
    expect(w2.find('[data-testid="html-close"]').exists()).toBe(false)
  })
  it('空 content ⇒ 降级 pre 态不白屏（§4.8）', () => {
    const w = mount(HtmlNodePreview, { props: { content: '' } })
    expect(w.find('pre').exists()).toBe(true)
  })
})
