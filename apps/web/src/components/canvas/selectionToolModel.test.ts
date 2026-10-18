import { describe, expect, it } from 'vitest'
import { buildSelectionTools } from './selectionToolModel'

describe('buildSelectionTools', () => {
  it('orders ai tools before file tools with 精修 enabled', () => {
    const tools = buildSelectionTools({ hasUrl: true })
    expect(tools.map((t) => t.id)).toEqual([
      'refine', 'matting', 'outpaint', 'crop', 'inpaint', 'element-edit', 'annotate', 'rotate', 'download', 'save-asset',
    ])
    expect(tools.map((t) => t.group)).toEqual([
      'ai', 'ai', 'ai', 'ai', 'ai', 'ai', 'ai', 'ai', 'file', 'file',
    ])
    expect(tools.find((t) => t.id === 'refine')).toMatchObject({ title: '精修', disabled: false })
  })

  it('crop/outpaint/inpaint 已点亮；rotate 仍为禁用占位', () => {
    const tools = buildSelectionTools({ hasUrl: true })
    expect(tools.find((t) => t.id === 'crop')?.disabled).toBe(false)
    expect(tools.find((t) => t.id === 'outpaint')?.disabled).toBe(false)
    expect(tools.find((t) => t.id === 'inpaint')?.disabled).toBe(false)
    expect(tools.find((t) => t.id === 'element-edit')?.disabled).toBe(false)
    expect(tools.find((t) => t.id === 'annotate')?.disabled).toBe(false)
    const rotate = tools.find((t) => t.id === 'rotate')!
    expect(rotate.disabled).toBe(true)
    expect(rotate.disabledReason).toContain('后续能力包点亮')
  })

  it('matting 工具已点亮（非 disabled）', () => {
    const tools = buildSelectionTools({ hasUrl: true })
    expect(tools.find((t) => t.id === 'matting')?.disabled).toBe(false)
  })

  it('disables file tools without url and enables them with url', () => {
    const withoutUrl = buildSelectionTools({ hasUrl: false })
    expect(withoutUrl.filter((t) => t.group === 'file').every((t) => t.disabled)).toBe(true)
    const withUrl = buildSelectionTools({ hasUrl: true })
    expect(withUrl.filter((t) => t.group === 'file').every((t) => !t.disabled)).toBe(true)
  })
})
