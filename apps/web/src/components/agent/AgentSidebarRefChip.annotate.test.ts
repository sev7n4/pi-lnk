import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentSidebarRefChip from './AgentSidebarRefChip.vue'

/**
 * 标注图引用芯片的缩略图预览（规格 §5.3 / Task 8）。
 *
 * ⭐ 标注回传的合成图是 `mediaType: 'image'` + **上传后的持久 url** ⇒ 与既有
 *   节点引用走**同一条** `<img>` 缩略图分支 ⇒ ⛔ 不需要新的预览通道（只加不破）。
 */
describe('AgentSidebarRefChip 标注图缩略图（只加不破）', () => {
  it('标注图（mediaType=image + 持久 url）⇒ 渲染缩略图 img', () => {
    const w = mount(AgentSidebarRefChip, {
      props: {
        refItem: {
          refKey: 'I1',
          refId: 'r1',
          mediaType: 'image',
          sourceKind: 'canvasNode',
          label: '标注',
          url: 'https://x/annotate.png',
          text: '这栋楼太亮',
          sourceNodeId: 'n1#annotate-1',
          preview: '',
          payload: { url: 'https://x/annotate.png' },
        },
      } as any,
    })
    const img = w.find('img.dock-ref-chip__media')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toContain('annotate.png')
    w.unmount()
  })

  it('文字型引用（无图）⇒ 不渲染 img（不误加占位）', () => {
    const w = mount(AgentSidebarRefChip, {
      props: {
        refItem: {
          refKey: 'T1',
          refId: 'r2',
          mediaType: 'text',
          sourceKind: 'canvasNode',
          label: '意见',
          text: '只带文字',
          sourceNodeId: 'n1#annotate-2',
          preview: '',
          payload: {},
        },
      } as any,
    })
    expect(w.find('img.dock-ref-chip__media').exists()).toBe(false)
    w.unmount()
  })
})
