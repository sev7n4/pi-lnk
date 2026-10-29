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
  it('srcdoc 组装 DOCTYPE 感知：DOCTYPE 保持首 token（防 quirks），CSP 仍先于内容生效', () => {
    expect(HTML_NODE_CSP).toBe(
      "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data: blob:; connect-src 'none'",
    )
    const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${HTML_NODE_CSP}">`
    // (a) 有 DOCTYPE：DOCTYPE 是文档第一个 token，meta CSP 插于其声明行之后（§5.4 v4.2）
    const w = mount(HtmlNodePreview, { props: { content: SAMPLE } })
    const doc = w.find('iframe').attributes('srcdoc') ?? ''
    expect(doc.trimStart().indexOf('<!DOCTYPE')).toBe(0)
    expect(doc.indexOf(cspMeta)).toBeGreaterThan(doc.indexOf('<!DOCTYPE'))
    expect(doc.indexOf('<h1>hi</h1>')).toBeGreaterThan(doc.indexOf(cspMeta))
    // (b) 无 DOCTYPE：meta CSP 前置（既有行为保留）
    const w2 = mount(HtmlNodePreview, { props: { content: '<p>fragment</p>' } })
    const doc2 = w2.find('iframe').attributes('srcdoc') ?? ''
    expect(doc2.indexOf(cspMeta)).toBe(0)
    expect(doc2.indexOf('<p>fragment</p>')).toBeGreaterThan(0)
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
