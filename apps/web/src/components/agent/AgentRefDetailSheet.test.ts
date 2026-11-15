import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import AgentRefDetailSheet from './AgentRefDetailSheet.vue'
import type { NodeRef } from '@/composables/useNodeRefs'

const refItem: NodeRef = {
  refId: 'r1',
  refKey: 'T1',
  mediaType: 'text',
  sourceKind: 'upload',
  label: '粘贴文本 · 6347 字',
  preview: '',
  payload: { text: '文档开头\n' + '丁'.repeat(900) },
}

afterEach(() => { document.body.innerHTML = '' })

describe('AgentRefDetailSheet：移动端全宽详情', () => {
  it('标题带 refKey + 芯片 label，内容默认展开为全文', () => {
    const w = mount(AgentRefDetailSheet, {
      props: { refItem, actionLabel: '引用 @T1' },
      attachTo: document.body,
    })
    expect(document.body.querySelector('.m-sheet-title')?.textContent).toContain('T1 · 粘贴文本 · 6347 字')
    expect(document.body.querySelector('[data-testid="ref-media-text"]')?.textContent).toContain('丁'.repeat(100))
    expect(document.body.querySelector('[data-testid="ref-media-expand"]')).toBeNull()
    w.unmount()
  })

  it('底部拇指区主动作 + X 关闭两条出口', async () => {
    const w = mount(AgentRefDetailSheet, {
      props: { refItem, actionLabel: '引用 @T1' },
      attachTo: document.body,
    })
    ;(document.body.querySelector('[data-testid="ref-sheet-action"]') as HTMLElement).click()
    await nextTick()
    expect(w.emitted('action')).toHaveLength(1)
    ;(document.body.querySelector('[data-testid="m-sheet-close"]') as HTMLElement).click()
    await nextTick()
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })
})
